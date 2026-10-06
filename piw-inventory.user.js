// ==UserScript==
// @name         PIW — Painel de Inventário em tempo real
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  Painel de inventário (Poké Bolas, Poções) lido em tempo real via API interna do jogo (React context). Só exibe itens com quantidade ≥ 5.
// @author       KizaniN
// @match        https://poke.idleworld.online/play*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/mateuspedro/PIW-Inventory-idle
// @supportURL   https://github.com/mateuspedro/PIW-Inventory-idle/issues
// @updateURL    https://raw.githubusercontent.com/mateuspedro/PIW-Inventory-idle/main/piw-inventory.user.js
// @downloadURL  https://raw.githubusercontent.com/mateuspedro/PIW-Inventory-idle/main/piw-inventory.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // 0) CONSTANTES
    // ============================================================
    const STORAGE_INV_PANEL_OPEN = 'script_inv_panel_open_v1';
    const STORAGE_INV_CACHE = 'script_inv_cache_v1';
    const STORAGE_INV_POS = 'script_inv_panel_pos_v1';

    const ITEMS_JSON_URL = 'https://poke.idleworld.online/game/items.json';
    const BALLS_API_URL = '/api/game/balls';

    const INVENTORY_HEARTBEAT_MS = 15000;
    const INVENTORY_RENDER_MS = 3000;
    const MIN_ITEM_QUANTITY = 5;
    const CATEGORY_KEYS = ['balls', 'potions'];

    // ============================================================
    // 1) ESTADO GLOBAL
    // ============================================================
    let inventoryRenderTimeout = null;
    let lastInventorySignature = '';
    let inventoryRefreshTimer = null;
    let inventoryHeartbeatTimer = null;
    let observerDebounceTimer = null;
    let gameContextPromise = null;
    let gameContext = null;
    let inventorySubscription = null;
    let ballsSubscription = null;
    let latestInventory = null;
    let subscriptionsBound = false;

    const globalItemApiData = new Map();

    let inventoryCache = loadInventoryCacheFromStorage();
    let inventoryLastLiveAt = 0;

    // ============================================================
    // 2) GAME CONTEXT (React context do jogo)
    // ============================================================
    function findGameContextFromDOM() {
        const hudElement = document.querySelector('.phud-name') || document.querySelector('.phud');
        if (!hudElement) return null;
        const fiberKey = Object.keys(hudElement).find(key => key.startsWith('__reactFiber$'));
        if (!fiberKey) return null;
        let fiber = hudElement[fiberKey];
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            if (value && typeof value.subscribe === 'function' && typeof value.send === 'function') {
                return value;
            }
        }
        return null;
    }

    function waitForGameContext(timeoutMs = 15000) {
        if (gameContext) return Promise.resolve(gameContext);
        if (gameContextPromise) return gameContextPromise;
        gameContextPromise = new Promise(resolve => {
            const deadline = Date.now() + timeoutMs;
            const tick = () => {
                const ctx = findGameContextFromDOM();
                if (ctx) {
                    gameContext = ctx;
                    subscribeToInventory();
                    return resolve(ctx);
                }
                if (Date.now() >= deadline) return resolve(null);
                setTimeout(tick, 250);
            };
            tick();
        });
        return gameContextPromise;
    }

    function subscribeToInventory() {
        if (!gameContext || subscriptionsBound) return;

        try {
            inventorySubscription = gameContext.subscribe('inventory', message => {
                const items = Array.isArray(message?.items) ? message.items : [];
                if (!items.length) return;
                latestInventory = items;
                inventoryLastLiveAt = Date.now();
                mergeIntoInventoryCache(groupInventoryFromSocket(items));
                scheduleInventoryPanelRefresh();
            });
        } catch (e) {
            console.warn('[PIW-Inventory] Falha ao assinar inventory:', e);
        }

        try {
            ballsSubscription = gameContext.subscribe('balls', message => {
                const catalog = Array.isArray(message?.catalog) ? message.catalog : [];
                const counts = message?.counts || {};
                if (!catalog.length) return;
                const entries = catalog.flatMap(ball => {
                    const qty = Number(counts[String(ball.id)] ?? 0);
                    if (qty < MIN_ITEM_QUANTITY) return [];
                    return [{
                        name: ball.name,
                        iconSrc: ball.iconUrl || '',
                        qty,
                        cat: 'balls'
                    }];
                });
                if (!entries.length) return;
                inventoryLastLiveAt = Date.now();
                mergeIntoInventoryCache(groupEntries(entries));
                scheduleInventoryPanelRefresh();
            });
        } catch (e) {
            console.warn('[PIW-Inventory] Falha ao assinar balls:', e);
        }

        ['field-kill', 'catch-result', 'poke-xp', 'item-use', 'ball-use', 'potion-use', 'shop-buy']
        .forEach(type => {
            try {
                gameContext.subscribe(type, () => {
                    setTimeout(() => requestInventoryFromGame(), 400);
                });
            } catch {
                /* tipo pode não existir */ }
        });

        subscriptionsBound = true;
    }

    function requestInventoryFromGame() {
        if (!gameContext) return false;
        try {
            gameContext.send({
                type: 'inv-get'
            });
            requestBallsFromGame();
            return true;
        } catch {
            return false;
        }
    }

    function requestBallsFromGame() {
        if (!gameContext) return false;
        try {
            if (typeof gameContext.requestBalls === 'function') {
                gameContext.requestBalls();
                return true;
            }
            gameContext.send({
                type: 'balls-get'
            });
            return true;
        } catch {
            return false;
        }
    }

    function groupInventoryFromSocket(items) {
        const grouped = {
            balls: [],
            potions: []
        };
        (items || []).forEach(entry => {
            const itemId = String(entry?.itemId ?? '').trim();
            const qty = Number(entry?.quantity ?? 0);
            if (!itemId || !Number.isFinite(qty) || qty < MIN_ITEM_QUANTITY) return;
            const catalog = globalItemApiData.get(itemId);
            const name = catalog?.name || catalog?.title || `Item ${itemId}`;
            const cat = categorizeByName(name);
            if (!cat) return;
            const iconRaw = catalog?.icon || catalog?.image || catalog?.sprite || '';
            const iconSrc = normalizeGameItemIcon(iconRaw);
            grouped[cat].push({
                name,
                iconSrc,
                qty,
                cat
            });
        });
        CATEGORY_KEYS.forEach(key => {
            grouped[key].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        });
        return grouped;
    }

    // ============================================================
    // 3) UTILITÁRIOS
    // ============================================================
    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[char]);
    }

    function normalizePokemonName(name) {
        return String(name || '').toLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[._]/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    function formatNumber(num) {
        return new Intl.NumberFormat('pt-BR').format(num);
    }

    function normalizeGameItemIcon(icon) {
        if (!icon) return '';
        if (/^(https?:)?\//.test(icon)) return icon;
        return `/assets/items/${String(icon).replace(/^\/+/, '')}`;
    }

    function loadInventoryCacheFromStorage() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_INV_CACHE) || 'null');
            if (parsed && typeof parsed === 'object') {
                return {
                    balls: Array.isArray(parsed.balls) ? parsed.balls : [],
                    potions: Array.isArray(parsed.potions) ? parsed.potions : []
                };
            }
        } catch {
            /* ignore */ }
        return {
            balls: [],
            potions: []
        };
    }

    function saveInventoryCacheToStorage() {
        try {
            localStorage.setItem(STORAGE_INV_CACHE, JSON.stringify(inventoryCache));
        } catch {
            /* ignore */ }
    }

    function mergeIntoInventoryCache(grouped) {
        let changed = false;
        for (const cat of CATEGORY_KEYS) {
            const incoming = grouped[cat] || [];
            if (!incoming.length) continue;
            const current = inventoryCache[cat] || [];
            const byName = new Map(current.map(e => [normalizePokemonName(e.name), e]));
            incoming.forEach(entry => {
                const key = normalizePokemonName(entry.name);
                const existing = byName.get(key);
                if (!existing) {
                    byName.set(key, {
                        ...entry
                    });
                    changed = true;
                } else {
                    if (existing.qty !== entry.qty) {
                        existing.qty = entry.qty;
                        changed = true;
                    }
                    if (!existing.iconSrc && entry.iconSrc) {
                        existing.iconSrc = entry.iconSrc;
                        changed = true;
                    }
                }
            });
            inventoryCache[cat] = Array.from(byName.values())
                .filter(e => Number(e.qty) >= MIN_ITEM_QUANTITY)
                .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        }
        if (changed) saveInventoryCacheToStorage();
        return changed;
    }

    // ============================================================
    // 4) CATÁLOGO DE ITENS
    // ============================================================
    function loadItemCatalog() {
        if (globalItemApiData.size) return Promise.resolve(globalItemApiData);
        return fetch(ITEMS_JSON_URL)
            .then(response => response.ok ? response.json() : null)
            .then(payload => {
                if (!payload) return globalItemApiData;
                const list = Array.isArray(payload) ? payload : (payload.items || []);
                list.forEach(item => {
                    if (!item || typeof item !== 'object') return;
                    const id = String(item.id ?? item.key ?? '').trim();
                    const name = (item.name || item.title || '').trim();
                    if (id) globalItemApiData.set(id, item);
                    if (name) globalItemApiData.set(name.toLowerCase(), item);
                });
                return globalItemApiData;
            })
            .catch(() => globalItemApiData);
    }

    function categorizeByName(name) {
        const n = String(name || '').toLowerCase();
        if (/\b(pok[eé]\s*ball|great\s*ball|super\s*ball|ultra\s*ball|idle\s*ball|master\s*ball|golden\s*idle\s*ball)\b/.test(n)) return 'balls';
        if (/\bpotion\b/.test(n)) return 'potions';
        return null;
    }

    // === Fallback DOM (só usado se o gameContext não existir) ===
    function readInventoryFromGrid() {
        const grid = document.querySelector('.inv-grid, .inv-slots, .inv-items');
        if (!grid) return [];
        const entries = [];
        grid.querySelectorAll('.inv-slot').forEach(slot => {
            if (slot.classList.contains('empty')) return;
            if (slot.classList.contains('inv-poke')) return;
            const img = slot.querySelector('img.inv-ico, img');
            if (!img) return;
            const alt = (img.getAttribute('alt') || '').trim();
            const title = (slot.getAttribute('title') || '').trim();
            const name = alt || title.split('—')[0].trim();
            if (!name) return;
            const cat = categorizeByName(name);
            if (!cat) return;
            const iconSrc = img.getAttribute('src') || '';
            const qtyEl = slot.querySelector('.inv-qty');
            const qty = qtyEl ? (parseInt((qtyEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0) : 0;
            if (qty < MIN_ITEM_QUANTITY) return;
            entries.push({
                name,
                iconSrc,
                qty,
                cat
            });
        });
        return entries;
    }

    function readInventoryFromAutoHelper() {
        const ahModal = document.querySelector('.ah-modal');
        if (!ahModal) return [];
        const entries = [];
        const seen = new Set();
        ahModal.querySelectorAll('.cap-chip').forEach(chip => {
            const title = (chip.getAttribute('title') || '').trim();
            const img = chip.querySelector('img.cap-chip-ico');
            const alt = (img?.getAttribute('alt') || '').trim();
            const name = title || alt;
            if (!name) return;
            const nEl = chip.querySelector('.cap-chip-n');
            const qtyText = (nEl?.textContent || '').trim();
            const qty = qtyText ? (parseInt(qtyText.replace(/[^0-9]/g, ''), 10) || 0) : 0;
            if (qty < MIN_ITEM_QUANTITY) return;
            const iconSrc = img?.getAttribute('src') || '';
            const key = `ball:${name.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            entries.push({
                name,
                iconSrc,
                qty,
                cat: 'balls'
            });
        });
        ahModal.querySelectorAll('select.ah-sel').forEach(sel => {
            sel.querySelectorAll('option').forEach(opt => {
                const text = (opt.textContent || '').trim();
                if (!/potion/i.test(text)) return;
                const match = text.match(/^(.+?)\s*[×x]\s*([\d.,]+)\s*$/i);
                if (!match) return;
                const rawName = match[1].trim();
                const rawQty = match[2].replace(/\./g, '').replace(',', '.');
                const qty = Math.round(Number(rawQty)) || 0;
                if (qty < MIN_ITEM_QUANTITY) return;
                const iconSrc = findIconForItemName(ahModal, rawName) ||
                    `/assets/markitems/${rawName.toLowerCase().replace(/\s+/g, '_')}.png`;
                const key = `potion:${rawName.toLowerCase()}`;
                if (seen.has(key)) return;
                seen.add(key);
                entries.push({
                    name: rawName,
                    iconSrc,
                    qty,
                    cat: 'potions'
                });
            });
        });
        return entries;
    }

    function findIconForItemName(root, name) {
        const wanted = normalizePokemonName(name);
        const imgs = Array.from(root.querySelectorAll('img'));
        for (const img of imgs) {
            const alt = normalizePokemonName(img.getAttribute('alt') || '');
            if (alt === wanted) return img.getAttribute('src') || '';
            const src = (img.getAttribute('src') || '').toLowerCase();
            const slug = wanted.replace(/\s+/g, '_');
            if (src.includes(slug)) return img.getAttribute('src') || '';
        }
        return '';
    }

    function groupEntries(entries) {
        const grouped = {
            balls: [],
            potions: []
        };
        (entries || []).forEach(entry => {
            if (!entry || !entry.cat) return;
            if (!Number.isFinite(entry.qty) || entry.qty < MIN_ITEM_QUANTITY) return;
            grouped[entry.cat].push(entry);
        });
        CATEGORY_KEYS.forEach(key => {
            grouped[key].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        });
        return grouped;
    }

    // ============================================================
    // 5) PAINEL
    // ============================================================
    const INVENTORY_CATEGORIES = [{
            id: 'balls',
            label: '🔴 Poké Bolas'
        },
        {
            id: 'potions',
            label: '💊 Poções'
        }
    ];

    function applyPanelPosition(panel, isOpen) {
        if (isOpen) {
            try {
                const stored = JSON.parse(localStorage.getItem(STORAGE_INV_POS) || 'null');
                if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
                    const panelWidth = panel.offsetWidth || 250;
                    const panelHeight = panel.offsetHeight || 300;
                    const maxLeft = Math.max(0, window.innerWidth - panelWidth - 8);
                    const maxTop = Math.max(0, window.innerHeight - panelHeight - 8);
                    const safeLeft = Math.min(maxLeft, Math.max(8, stored.left));
                    const safeTop = Math.min(maxTop, Math.max(8, stored.top));

                    panel.style.left = `${safeLeft}px`;
                    panel.style.top = `${safeTop}px`;
                    panel.style.right = 'auto';
                    panel.style.transform = 'none';

                    if (safeLeft !== stored.left || safeTop !== stored.top) {
                        localStorage.setItem(STORAGE_INV_POS, JSON.stringify({
                            left: safeLeft,
                            top: safeTop
                        }));
                    }
                    return;
                }
            } catch {
                /* ignore */ }
        }
        panel.style.left = 'auto';
        panel.style.right = '8px';
        panel.style.top = '50%';
        panel.style.transform = 'translateY(-50%)';
    }

    function ensureInventoryPanel() {
        let panel = document.getElementById('script-inv-panel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'script-inv-panel';
        panel.style = 'position:fixed;display:flex;flex-direction:column;gap:6px;background:rgba(20,16,10,.88);border:2px solid rgb(120,90,40);border-radius:10px;padding:8px 6px;z-index:9000;max-height:80vh;overflow:hidden;font-family:sans-serif;color:#e2e8f0;';
        panel.innerHTML = `
            <div id="script-inv-drag" style="display:flex;align-items:center;justify-content:space-between;gap:4px;width:100%;cursor:grab;user-select:none;">
                <button id="script-inv-toggle" type="button" title="Mostrar/ocultar inventário"
                    style="background:transparent;border:0;color:#ffcc00;font-size:18px;font-weight:bold;width:36px;height:32px;border-radius:8px;cursor:pointer;flex:0 0 auto;">🎒</button>
                <button id="script-inv-refresh" type="button" title="Forçar atualização"
                    style="background:transparent;border:0;color:#63b3ed;font-size:16px;font-weight:bold;width:36px;height:32px;border-radius:8px;cursor:pointer;display:none;flex:0 0 auto;">🔄</button>
            </div>
            <div id="script-inv-body" style="display:none;width:230px;max-height:70vh;overflow-y:auto;padding-right:2px;">
                <div id="script-inv-live" style="font-size:10px;color:#a0aec0;padding:2px 4px 6px;text-align:right;"></div>
                <div id="script-inv-content"></div>
            </div>
        `;
        document.body.appendChild(panel);
        const initialOpen = localStorage.getItem(STORAGE_INV_PANEL_OPEN) === 'true';
        applyPanelPosition(panel, initialOpen);

        const toggleBtn = panel.querySelector('#script-inv-toggle');
        const refreshBtn = panel.querySelector('#script-inv-refresh');
        const body = panel.querySelector('#script-inv-body');
        const dragHandle = panel.querySelector('#script-inv-drag');

        const applyOpenState = (isOpen) => {
            body.style.display = isOpen ? 'block' : 'none';
            toggleBtn.style.color = isOpen ? '#ffcc00' : '#a0aec0';
            refreshBtn.style.display = isOpen ? 'inline-flex' : 'none';
            // Ao fechar, o painel volta para o canto. Ao abrir, volta para
            // a posição que o usuário deixou salva.
            applyPanelPosition(panel, isOpen);
        };

        applyOpenState(initialOpen);

        refreshBtn.addEventListener('click', () => {
            requestInventoryFromGame();
            requestBallsFromGame();
            refreshBtn.style.opacity = '0.4';
            setTimeout(() => {
                refreshBtn.style.opacity = '1';
            }, 500);
        });

        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = body.style.display !== 'none';
            applyOpenState(!isOpen);
            localStorage.setItem(STORAGE_INV_PANEL_OPEN, String(!isOpen));
            if (!isOpen) {
                renderInventoryContent();
                requestInventoryFromGame();
                requestBallsFromGame();
                setTimeout(() => {
                    const age = Date.now() - inventoryLastLiveAt;
                    if (age > 1500) {
                        const domEntries = [...readInventoryFromGrid(), ...readInventoryFromAutoHelper()];
                        if (domEntries.length) {
                            mergeIntoInventoryCache(groupEntries(domEntries));
                            inventoryLastLiveAt = Date.now();
                            renderInventoryContent();
                        }
                    }
                }, 1500);
            }
        });

        toggleBtn.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            localStorage.removeItem(STORAGE_INV_POS);
            applyPanelPosition(panel, true);
            clampPanelToViewport();
        });

        // Arrastar pelo cabeçalho
        let isDragging = false;
        let dragStartX = 0,
            dragStartY = 0,
            panelStartLeft = 0,
            panelStartTop = 0;
        dragHandle.addEventListener('pointerdown', (event) => {
            if (body.style.display === 'none') return;
            if (event.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            isDragging = true;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            panelStartLeft = rect.left;
            panelStartTop = rect.top;
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            dragHandle.style.cursor = 'grabbing';
            dragHandle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        dragHandle.addEventListener('pointermove', (event) => {
            if (!isDragging) return;
            const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
            const nextLeft = Math.min(maxLeft, Math.max(0, panelStartLeft + event.clientX - dragStartX));
            const nextTop = Math.min(maxTop, Math.max(0, panelStartTop + event.clientY - dragStartY));
            panel.style.left = `${nextLeft}px`;
            panel.style.top = `${nextTop}px`;
        });
        const stopDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            dragHandle.style.cursor = 'grab';
            if (body.style.display === 'none') return;
            const left = parseFloat(panel.style.left);
            const top = parseFloat(panel.style.top);
            if (!Number.isFinite(left) || !Number.isFinite(top)) return;
            try {
                localStorage.setItem(STORAGE_INV_POS, JSON.stringify({
                    left,
                    top
                }));
            } catch {
                /* ignore */ }
        };
        dragHandle.addEventListener('pointerup', stopDrag);
        dragHandle.addEventListener('pointercancel', stopDrag);

        return panel;
    }

    function renderInventoryContent() {
        const panel = ensureInventoryPanel();
        const content = panel.querySelector('#script-inv-content');
        const liveEl = panel.querySelector('#script-inv-live');

        const ageMs = Date.now() - inventoryLastLiveAt;
        const isLive = ageMs < 20000;
        const when = inventoryLastLiveAt ?
            new Date(inventoryLastLiveAt).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }) :
            '—';
        liveEl.textContent = `${isLive ? '● ao vivo' : '○ cache'} · ${when}`;
        liveEl.style.color = isLive ? '#48bb78' : '#a0aec0';

        const signature = JSON.stringify(inventoryCache);
        if (signature === lastInventorySignature && content.childElementCount) return;
        lastInventorySignature = signature;

        let html = '';
        let totalTracked = 0;
        for (const cat of INVENTORY_CATEGORIES) {
            const items = (inventoryCache[cat.id] || []).filter(item => Number(item.qty) >= MIN_ITEM_QUANTITY);
            if (!items.length) continue;
            totalTracked += items.length;
            html += `<div style="margin-bottom:8px;">
                <div style="font-weight:800;font-size:12px;color:#d9c38c;border-bottom:1px solid #3a2c17;padding:4px 2px;margin-bottom:4px;">${cat.label}</div>`;
            items.forEach(item => {
                const icon = item.iconSrc ?
                    `<img src="${escapeHTML(item.iconSrc)}" alt="" style="width:24px;height:24px;object-fit:contain;image-rendering:pixelated;flex:none;">` :
                    '<span style="width:24px;height:24px;flex:none;"></span>';
                html += `
                    <div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.03);margin-bottom:3px;">
                        ${icon}
                        <span style="flex:1;min-width:0;font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(item.name)}</span>
                        <span style="font-weight:800;font-size:12px;color:#f6c453;flex:none;">×${formatNumber(item.qty)}</span>
                    </div>`;
            });
            html += `</div>`;
        }
        if (!html) {
            html = '<div style="color:#718096;font-size:11px;padding:6px 4px;text-align:center;">Nenhum item rastreado ainda.</div>';
        } else {
            html += `<div style="font-size:10px;color:#718096;padding:6px 4px 0;text-align:right;border-top:1px solid #1f2b36;margin-top:6px;">${totalTracked} tipo(s) rastreado(s)</div>`;
        }
        content.innerHTML = html;
    }

    function scheduleInventoryPanelRefresh() {
        if (inventoryRenderTimeout) return;
        inventoryRenderTimeout = setTimeout(() => {
            inventoryRenderTimeout = null;
            const panel = document.getElementById('script-inv-panel');
            if (!panel) return;
            const body = panel.querySelector('#script-inv-body');
            if (body && body.style.display !== 'none') renderInventoryContent();
        }, 80);
    }

    async function refreshInventoryData() {
        if (gameContext) {
            requestInventoryFromGame();
            return;
        }
        const domEntries = [...readInventoryFromGrid(), ...readInventoryFromAutoHelper()];
        if (domEntries.length) {
            mergeIntoInventoryCache(groupEntries(domEntries));
            inventoryLastLiveAt = Date.now();
        } else {
            inventoryCache = loadInventoryCacheFromStorage();
        }
    }

    function startInventoryAutoRefresh() {
        if (inventoryHeartbeatTimer) clearInterval(inventoryHeartbeatTimer);
        inventoryHeartbeatTimer = setInterval(() => {
            try {
                if (gameContext) requestInventoryFromGame();
            } catch (e) {
                /* nunca deixa o timer morrer */ }
        }, INVENTORY_HEARTBEAT_MS);

        if (inventoryRefreshTimer) clearInterval(inventoryRefreshTimer);
        inventoryRefreshTimer = setInterval(() => {
            try {
                const panel = document.getElementById('script-inv-panel');
                if (!panel) return;
                const body = panel.querySelector('#script-inv-body');
                if (body && body.style.display !== 'none') renderInventoryContent();
            } catch (e) {
                /* nunca deixa o timer morrer */ }
        }, INVENTORY_RENDER_MS);
    }

    // ============================================================
    // 6) INICIALIZAÇÃO
    // ============================================================
    function onDomChanged() {
        try {
            ensureInventoryPanel();
            renderInventoryContent();
            if (!gameContext) waitForGameContext();
        } catch (e) {
            console.error('[PIW-Inventory] Erro no observer:', e);
        }
    }

    const observer = new MutationObserver(() => {
        if (observerDebounceTimer) return;
        observerDebounceTimer = setTimeout(() => {
            observerDebounceTimer = null;
            onDomChanged();
        }, 300);
    });

    function clampPanelToViewport() {
        const panel = document.getElementById('script-inv-panel');
        if (!panel) return;
        const body = panel.querySelector('#script-inv-body');
        if (!body || body.style.display === 'none') return;
        const rect = panel.getBoundingClientRect();
        const panelWidth = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;
        const maxLeft = Math.max(0, window.innerWidth - panelWidth - 8);
        const maxTop = Math.max(0, window.innerHeight - panelHeight - 8);
        const safeLeft = Math.min(maxLeft, Math.max(8, rect.left));
        const safeTop = Math.min(maxTop, Math.max(8, rect.top));
        if (safeLeft !== rect.left || safeTop !== rect.top) {
            panel.style.left = `${safeLeft}px`;
            panel.style.top = `${safeTop}px`;
            panel.style.right = 'auto';
            panel.style.transform = 'none';
        }
    }

    function initialize() {
        try {
            loadItemCatalog();
            ensureInventoryPanel();
            startInventoryAutoRefresh();
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // === clamp de viewport ===
            window.addEventListener('resize', clampPanelToViewport);
            window.addEventListener('orientationchange', clampPanelToViewport);
            setInterval(clampPanelToViewport, 2000);

            waitForGameContext().then(ctx => {
                if (ctx) {
                    console.info('[PIW-Inventory] gameContext encontrado. Inventário em tempo real ativo.');
                    requestInventoryFromGame();
                    setTimeout(() => requestInventoryFromGame(), 1000);
                    setTimeout(() => requestInventoryFromGame(), 3000);
                } else {
                    console.warn('[PIW-Inventory] gameContext não encontrado — usando DOM como fallback.');
                }
            });

            refreshInventoryData().finally(renderInventoryContent);
        } catch (e) {
            console.error('[PIW-Inventory] Erro na inicialização:', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, {
            once: true
        });
    } else {
        initialize();
    }

})();
