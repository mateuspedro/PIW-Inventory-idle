// ==UserScript==
// @name         PIW — Mapa Simplificado (isolado)
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  Lista simplificada de hunts do Poke Idle World + painel de inventário em tempo real.
// @author       KizaniN
// @match        https://poke.idleworld.online/play
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // 0) CONSTANTES
    // ============================================================
    const STORAGE_SCRIPT_ACTIVE    = 'script_mapa_ativo_v1';
    const STORAGE_FAVS             = 'hunts_favoritas_v1';
    const STORAGE_LAST_HUNT        = 'ultima_hunt_v1';
    const STORAGE_DROP_MODE        = 'script_drop_mode_v1';
    const STORAGE_NAV_MODE         = 'script_nav_tp_mode_v1';
    const STORAGE_PRIMARY_FAVORITE = 'script_primary_favorite_v1';
    const STORAGE_CAUGHT_POKEMON   = 'script_caught_pokemon_v1';
    const STORAGE_INV_PANEL_OPEN   = 'script_inv_panel_open_v1';

    const MAP_MARKERS_API_URL      = '/api/game/map-markers';
    const CHARACTERS_ME_URL        = '/api/characters/me';
    const INVENTORY_API_URL        = '/api/game/inventory';
    const POKEMON_TYPES_JSON_URL   = 'https://poke.idleworld.online/game/creatures.json';

    // Intervalo de refresh do inventário (ms)
    const INVENTORY_REFRESH_INTERVAL_MS = 3000;

    // ============================================================
    // 1) ESTADO GLOBAL
    // ============================================================
    let isRendering             = false;
    let cachedTrainerLevel      = null;
    let trainerLevelPromise     = null;
    let lastMapRenderSignature  = '';
    let cachedLeaderPokemonName = '';
    let cachedLeaderPokemonTypes= [];
    let mapMarkersLoadPromise   = null;
    let renderTimeout           = null;
    let activeTooltip           = null;
    let lastActiveRegion        = null;
    let inventoryRenderTimeout  = null;
    let lastInventorySignature  = '';
    let inventoryRefreshTimer   = null;
    let inventoryFetchInFlight  = false;

    const globalCreatureApiData  = new Map();
    const globalHuntMarkerData   = new Map();
    const globalCaughtPokemonNames = new Set(loadCaughtPokemonCache());

    // Cache do catálogo de itens (id -> { name, icon, category })
    const globalItemCatalog = new Map();
    let itemCatalogLoadPromise = null;

    // ============================================================
    // 2) UTILITÁRIOS BÁSICOS
    // ============================================================
    function readStoredJSON(key, fallback) {
        const stored = localStorage.getItem(key);
        if (!stored) return fallback;
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch { return fallback; }
    }
    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[char]);
    }
    function parseGameNumber(value) {
        const text = String(value ?? '').trim().toLowerCase();
        const abbr = text.match(/(-?\d+(?:[.,]\d+)?)\s*([kmb])\b/);
        if (abbr) {
            const n = Number(abbr[1].replace(',', '.'));
            const mult = { k: 1e3, m: 1e6, b: 1e9 };
            return Number.isFinite(n) ? Math.round(n * mult[abbr[2]]) : 0;
        }
        const digits = text.replace(/[^0-9-]/g, '');
        const parsed = parseInt(digits, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    function normalizePokemonName(name) {
        return String(name || '').toLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[._]/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }
    function getCleanHuntName(huntName) {
        if (!huntName) return '';
        return normalizePokemonName(huntName
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*\)/g, '')
            .trim());
    }
    function preferenceEnabled(key) {
        return localStorage.getItem(key) !== 'false';
    }
    function loadCaughtPokemonCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_CAUGHT_POKEMON) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    function saveCaughtPokemonCache() {
        localStorage.setItem(STORAGE_CAUGHT_POKEMON, JSON.stringify([...globalCaughtPokemonNames]));
    }
    function formatNumber(num) {
        return new Intl.NumberFormat('pt-BR').format(num);
    }
    function normalizeGameItemIcon(icon) {
        if (!icon) return '';
        if (/^(https?:)?\//.test(icon)) return icon;
        return `/assets/items/${String(icon).replace(/^\/+/, '')}`;
    }

    // ============================================================
    // 3) TOKENS DA API DO JOGO
    // ============================================================
    function getGameTokens() {
        try {
            return JSON.parse(sessionStorage.getItem('pokeweb:tokens') || 'null');
        } catch { return null; }
    }
    async function refreshGameAccessToken() {
        const tokens = getGameTokens();
        if (!tokens?.refreshToken) return null;
        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tokens.refreshToken })
        });
        if (!response.ok) return null;
        const refreshed = await response.json();
        if (!refreshed?.accessToken) return null;
        sessionStorage.setItem('pokeweb:tokens', JSON.stringify(refreshed));
        return refreshed.accessToken;
    }
    async function gameApiRequest(url, options = {}) {
        const send = accessToken => fetch(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                ...(options.headers || {})
            }
        });
        let response = await send(getGameTokens()?.accessToken);
        if (response.status === 401) {
            const refreshedToken = await refreshGameAccessToken();
            if (refreshedToken) response = await send(refreshedToken);
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.message || `HTTP ${response.status}`);
        return result;
    }

    // ============================================================
    // 4) CATÁLOGO DE ITENS (items.json)
    // ============================================================
    function loadItemCatalog() {
        if (itemCatalogLoadPromise) return itemCatalogLoadPromise;
        itemCatalogLoadPromise = fetch('/game/items.json', { credentials: 'same-origin' })
            .then(r => r.ok ? r.json() : null)
            .then(payload => {
                if (!payload) return globalItemCatalog;
                const list = Array.isArray(payload) ? payload : (payload.items || Object.values(payload));
                list.forEach(item => {
                    if (!item || typeof item !== 'object') return;
                    const id = String(item.id ?? item.key ?? '').trim();
                    if (!id) return;
                    globalItemCatalog.set(id, {
                        id,
                        name: item.name || item.title || '',
                        icon: item.icon || item.image || item.sprite || item.img || '',
                        category: String(item.category || '').toLowerCase()
                    });
                });
                return globalItemCatalog;
            })
            .catch(() => globalItemCatalog);
        return itemCatalogLoadPromise;
    }

    // ============================================================
    // 5) CIDADES
    // ============================================================
    const CITY_NAMES = /\b(?:cerulean(?: city)?|pewter(?: city)?|lavender(?: town)?|viridian(?: city)?|cassino|casino)\b/i;
    function isCityName(name) {
        return CITY_NAMES.test(String(name || '').replace(/\[[^\]]*]/g, ' ').trim());
    }
    function isCityMarker(marker, name) {
        const metadata = `${marker?.className || ''} ${marker?.dataset?.type || ''} ${marker?.dataset?.tag || ''} ${marker?.dataset?.category || ''}`;
        return isCityName(name) || /\b(?:city|cidade|town)\b/i.test(metadata);
    }
    function getCityDisplayName(name) {
        if (/pewter|lavender/i.test(name)) return 'Lavender (Pewter)';
        if (/viridian/i.test(name))        return 'Viridian';
        if (/cassino|casino/i.test(name))  return 'Cassino';
        return 'Cerulean';
    }
    function getCityIconStyle(name) {
        const badge = /cerulean/i.test(name) ? '💧'
                    : /pewter|lavender/i.test(name) ? '🪨'
                    : /viridian/i.test(name) ? '🌿'
                    : '🎰';
        return `--city-badge:"${badge}";width:38px;height:38px;`;
    }

    // ============================================================
    // 6) FAVORITOS / ÚLTIMA HUNT
    // ============================================================
    function getFavorites() { return readStoredJSON(STORAGE_FAVS, []); }
    function saveLastHunt(huntName) {
        if (huntName && huntName !== 'Sem Nome' && !isCityName(huntName))
            localStorage.setItem(STORAGE_LAST_HUNT, huntName);
    }
    function getLastHunt() { return localStorage.getItem(STORAGE_LAST_HUNT) || null; }
    function getPrimaryFavorite() {
        const favorite = localStorage.getItem(STORAGE_PRIMARY_FAVORITE);
        return getFavorites().includes(favorite) ? favorite : null;
    }
    function toggleFavorite(huntName) {
        let favs = getFavorites();
        if (favs.includes(huntName)) {
            favs = favs.filter(name => name !== huntName);
            if (localStorage.getItem(STORAGE_PRIMARY_FAVORITE) === huntName)
                localStorage.removeItem(STORAGE_PRIMARY_FAVORITE);
        } else favs.push(huntName);
        localStorage.setItem(STORAGE_FAVS, JSON.stringify(favs));
        lastMapRenderSignature = '';
        updateNavButtonAppearance();
        buildSimpleList();
    }

    // ============================================================
    // 7) MODOS (drops / navegação)
    // ============================================================
    function getDropMode() { return localStorage.getItem(STORAGE_DROP_MODE) || 'icon'; }
    function setDropMode(mode) { localStorage.setItem(STORAGE_DROP_MODE, mode); buildSimpleList(); }

    function getNavTpMode() {
        const mode = localStorage.getItem(STORAGE_NAV_MODE) || 'fav';
        return ['fav', 'last', 'off'].includes(mode) ? mode : 'fav';
    }
    function setNavTpMode(mode) {
        localStorage.setItem(STORAGE_NAV_MODE, mode);
        updateNavButtonAppearance();
    }

    // ============================================================
    // 8) REGIÃO ATIVA
    // ============================================================
    function getActiveRegionName() {
        const mapWindow = document.querySelector('.map-window');
        if (!mapWindow) return null;
        const title = mapWindow.querySelector('.ds-title, .map-title')?.textContent || '';
        const match = title.match(/Mapa\s*·\s*(.+)$/i);
        if (match && match[1]) return match[1].trim().toLowerCase();
        const activePlate = mapWindow.querySelector('.map-plate.on');
        if (activePlate) {
            const img = activePlate.querySelector('img');
            const alt = img?.getAttribute('alt') || img?.getAttribute('title') || '';
            if (alt) return alt.trim().toLowerCase();
        }
        return null;
    }
    function getActiveRegionFromMarker(marker) {
        const slug = marker?.dataset?.guide?.replace(/^hunt-/, '') || '';
        if (!slug) return null;
        const apiMarker = globalHuntMarkerData.get(slug.toLowerCase());
        if (!apiMarker) return null;
        return String(apiMarker.region || apiMarker.map || apiMarker.area || '').toLowerCase() || null;
    }

    // ============================================================
    // 9) ÍNDICE DOS MARCADORES VIA API
    // ============================================================
    function getMarkerName(marker) {
        return String(
            marker?.name || marker?.title || marker?.huntName || marker?.pokemonName ||
            marker?.creatureName || marker?.pokemon?.name || marker?.creature?.name || ''
        ).trim();
    }
    function getMarkerSlug(marker) {
        return String(marker?.slug || marker?.huntSlug || marker?.hunt?.slug || '').trim();
    }
    function getMarkerRegion(marker) {
        return String(marker?.region || marker?.map || marker?.area || marker?.world || '').trim().toLowerCase();
    }
    function getMarkerLevel(marker) {
        const candidates = [
            marker?.level, marker?.requiredLevel, marker?.minLevel,
            marker?.reqLevel, marker?.lvl, marker?.pokemon?.level, marker?.creature?.level
        ];
        for (const value of candidates) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }
    function indexHuntMarkers(payload) {
        const content = Array.isArray(payload) ? payload
                      : (payload?.markers || payload?.hunts || payload?.data || []);
        const markers = Array.isArray(content) ? content
                      : (content?.markers || content?.hunts || []);
        globalHuntMarkerData.clear();
        markers.forEach(marker => {
            if (!marker || typeof marker !== 'object') return;
            const name = getMarkerName(marker);
            const slug = getMarkerSlug(marker);
            if (name) globalHuntMarkerData.set(getCleanHuntName(name), marker);
            if (slug) globalHuntMarkerData.set(slug.toLowerCase(), marker);
        });
    }
    function loadMapMarkersData(force = false) {
        if (!force && mapMarkersLoadPromise) return mapMarkersLoadPromise;
        mapMarkersLoadPromise = fetch(MAP_MARKERS_API_URL, { credentials: 'same-origin' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(payload => {
                indexHuntMarkers(payload);
                return globalHuntMarkerData;
            })
            .catch(error => {
                console.warn('⚠️ Falha ao carregar os marcadores do mapa; usando o DOM como fallback.', error);
                return globalHuntMarkerData;
            });
        return mapMarkersLoadPromise;
    }
    function findMappedHunt(huntName) {
        return globalHuntMarkerData.get(getCleanHuntName(huntName)) || null;
    }

    // ============================================================
    // 10) TIPOS POKÉMON
    // ============================================================
    const TYPE_CHART = {
        normal: { rock: 0.5, ghost: 0, steel: 0.5 },
        fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
        water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
        electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
        grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
        ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
        fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2 },
        poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
        ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
        flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
        psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
        bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5 },
        rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
        ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
        dragon: { dragon: 2, steel: 0.5 },
        dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5 },
        steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
        fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
    };
    let POKEMON_TYPES = {};
    const POKEMON_NAME_ALIASES = {
        nidoranfe: 'nidoran-f', 'nidoran female': 'nidoran-f', 'nidoran♀': 'nidoran-f',
        nidoranma: 'nidoran-m', 'nidoran male': 'nidoran-m', 'nidoran♂': 'nidoran-m',
        farfetchd: "farfetch'd", 'farfetch’d': "farfetch'd"
    };
    function applyOutlandModifier(baseMultiplier) {
        if (baseMultiplier === 1.5) return 1.75;
        if (baseMultiplier === 2.0) return 2.50;
        if (baseMultiplier >= 4.0) return 5.50;
        if (baseMultiplier === 0.5) return 0.33;
        return baseMultiplier;
    }
    function getOffensiveMultiplier(attackerTypes, defenderTypes) {
        if (!attackerTypes?.length || !defenderTypes?.length) return 1.0;
        let bestMult = null;
        attackerTypes.forEach(attType => {
            let mult = 1.0;
            defenderTypes.forEach(defType => {
                const chart = TYPE_CHART[attType];
                if (chart && chart[defType] !== undefined) mult *= chart[defType];
            });
            if (bestMult === null || mult > bestMult) bestMult = mult;
        });
        return applyOutlandModifier(bestMult !== null ? bestMult : 1.0);
    }
    function getDefenderTypes(huntName) {
        const cleanName = getCleanHuntName(huntName);
        if (POKEMON_TYPES[cleanName]) return POKEMON_TYPES[cleanName];
        const words = cleanName.split(/\s+/);
        for (let i = words.length - 1; i >= 0; i--) {
            const subName = words.slice(i).join(' ');
            if (POKEMON_TYPES[subName]) return POKEMON_TYPES[subName];
            if (POKEMON_TYPES[words[i]]) return POKEMON_TYPES[words[i]];
        }
        return [];
    }
    async function loadExternalPokemonData() {
        try {
            const response = await fetch(POKEMON_TYPES_JSON_URL);
            if (!response.ok) return;
            const data = await response.json();
            const creaturesList = Array.isArray(data) ? data : (data.creatures || []);
            const fetchedTypes = {};
            creaturesList.forEach(poke => {
                const pokeName = normalizePokemonName(poke.name || '');
                const t1 = poke.type1 || poke.type_1;
                const t2 = poke.type2 || poke.type_2;
                if (pokeName && t1) {
                    const types = [t1.toLowerCase().trim()];
                    if (t2) types.push(t2.toLowerCase().trim());
                    fetchedTypes[pokeName] = types;
                }
                globalCreatureApiData.set(pokeName, poke);
            });
            POKEMON_TYPES = fetchedTypes;
            buildSimpleList();
        } catch (e) {
            console.warn('⚠️ Falha ao carregar creatures.json', e);
        }
    }

    // ============================================================
    // 11) NÍVEL DO TREINADOR
    // ============================================================
    function readTrainerLevelFromDOM() {
        const tloc = document.querySelector('.phud-tloc');
        if (tloc) {
            const m = (tloc.textContent || '').match(/N[íi]vel\s*(\d{1,4})/i) || (tloc.textContent || '').match(/\b(\d{1,4})\b/);
            if (m) {
                const n = Number(m[1]);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        const candidates = [
            document.querySelector('.phud-tlevel'),
            document.querySelector('.phud-level'),
            document.querySelector('[data-guide="player-level"]'),
            document.querySelector('.phud-tlvl'),
            document.querySelector('.phud-lvl')
        ].filter(Boolean);
        for (const element of candidates) {
            const match = (element.textContent || '').match(/(\d{1,4})/);
            if (match) {
                const n = Number(match[1]);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        return null;
    }
    function loadTrainerLevel(force = false) {
        const domLevel = readTrainerLevelFromDOM();
        if (domLevel && domLevel > 0) cachedTrainerLevel = domLevel;

        if (!force && cachedTrainerLevel !== null && cachedTrainerLevel > 0)
            return Promise.resolve(cachedTrainerLevel);
        if (!force && trainerLevelPromise) return trainerLevelPromise;

        trainerLevelPromise = gameApiRequest(CHARACTERS_ME_URL)
            .then(payload => {
                const level = Number(
                    payload?.character?.level ??
                    payload?.level ??
                    payload?.character?.lvl ??
                    0
                );
                if (Number.isFinite(level) && level > 0) cachedTrainerLevel = level;
                else if (!cachedTrainerLevel) cachedTrainerLevel = readTrainerLevelFromDOM();
                return cachedTrainerLevel;
            })
            .catch(() => {
                const dom = readTrainerLevelFromDOM();
                if (dom) cachedTrainerLevel = dom;
                return cachedTrainerLevel;
            })
            .finally(() => { trainerLevelPromise = null; });

        return trainerLevelPromise;
    }

    // ============================================================
    // 12) LÍDER DA EQUIPE — sempre o .phud-mon.active
    // ============================================================
    function getLeaderPokemonFromHud() {
        const active = document.querySelector('div.phud-party > button.phud-mon.active')
            || document.querySelector('div.phud-party > button.phud-mon');
        if (!active) return null;
        const nameEl = active.querySelector('.phud-name')
            || active.querySelector('.phud-mon-name')
            || active.querySelector('[class*="name"]');
        const rawName = (nameEl?.textContent || '').trim();
        const cleanName = normalizePokemonName(rawName);
        if (!cleanName) return null;
        const typeImg = active.querySelector('img.pk-ts-type');
        const typeFromImg = (typeImg?.getAttribute('alt') || typeImg?.getAttribute('title') || '').trim().toLowerCase();
        let types = POKEMON_TYPES[cleanName] || [];
        if (!types.length && typeFromImg) types = [typeFromImg];
        return { name: cleanName, displayName: rawName, types };
    }
    function getActivePokemonName() {
        const hudLeader = getLeaderPokemonFromHud();
        if (hudLeader?.name) {
            cachedLeaderPokemonName = hudLeader.name;
            if (hudLeader.types?.length) cachedLeaderPokemonTypes = hudLeader.types;
            return cachedLeaderPokemonName;
        }
        const nameEl = document.querySelector('div.phud-party .phud-name')
            || document.querySelector('.phud-name');
        const text = normalizePokemonName(nameEl?.textContent || '');
        const found = Object.keys(POKEMON_TYPES).sort((a, b) => b.length - a.length)
            .find(name => text.includes(name)) || text;
        cachedLeaderPokemonName = found;
        if (POKEMON_TYPES[found]) cachedLeaderPokemonTypes = POKEMON_TYPES[found];
        return found;
    }
    function refreshLeaderFromHud() {
        const leader = getLeaderPokemonFromHud();
        if (!leader) return false;
        const changed = leader.name !== cachedLeaderPokemonName
            || JSON.stringify(leader.types) !== JSON.stringify(cachedLeaderPokemonTypes);
        cachedLeaderPokemonName = leader.name;
        cachedLeaderPokemonTypes = leader.types || [];
        return changed;
    }

    // ============================================================
    // 13) DETALHES DA HUNT
    // ============================================================
    function extractHuntDetailsFromJSON(name, marker) {
        const cleanName = getCleanHuntName(name);
        let priceVal = 0;
        let experience = 0;
        let dropsHTML = '';
        if (globalCreatureApiData.has(cleanName)) {
            const pokeObj = globalCreatureApiData.get(cleanName);
            const keys = ['sellValue', 'priceNpc', 'sell', 'sellsFor', 'price', 'value', 'gold', 'money', 'cost', 'reward'];
            for (const key of keys) {
                if (pokeObj[key] !== undefined && pokeObj[key] !== null && pokeObj[key] !== '') {
                    const parsed = parseGameNumber(pokeObj[key]);
                    if (parsed > 0) { priceVal = parsed; break; }
                }
            }
            experience = parseInt(pokeObj.experience ?? pokeObj.exp ?? 0, 10) || 0;
        }
        let sellsFor = priceVal > 0 ? `$ ${priceVal.toLocaleString('en-US')}` : 'Indisponível';
        if (cleanName === 'aerodactyl') sellsFor = 'Não pode ser vendido';
        const expText = experience > 0 ? `${experience.toLocaleString('en-US')} XP` : '';
        return { sellsFor, numericPrice: priceVal, dropsHTML, experience, expText };
    }

    // ============================================================
    // 14) TELEPORTE
    // ============================================================
    function clickMappedHunt(huntName) {
        const mappedHunt = findMappedHunt(huntName);
        const slug = getMarkerSlug(mappedHunt);
        if (!slug) return false;
        const guide = `hunt-${slug}`;
        const marker = Array.from(document.querySelectorAll('[data-guide]'))
            .find(el => el.dataset.guide === guide);
        if (!marker) return false;
        marker.click();
        return true;
    }
    function getMapAreaTabs(mapWindow) {
        return Array.from(mapWindow.querySelectorAll('.map-area:not(.locked), .map-plate:not(.locked)'))
            .filter(el => !el.classList.contains('script-city-area'));
    }
    function waitForMapAreaChange(previousTab) {
        return new Promise(resolve => {
            const deadline = Date.now() + 1200;
            const check = () => {
                const activeTab = document.querySelector('.map-area.on, .map-plate.on');
                if ((activeTab && activeTab !== previousTab) || Date.now() >= deadline) {
                    resolve(activeTab); return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }
    function waitForElement(selector, timeoutMs) {
        const existing = document.querySelector(selector);
        if (existing) return Promise.resolve(existing);
        return new Promise(resolve => {
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (!el) return;
                observer.disconnect(); clearTimeout(timeout); resolve(el);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timeout = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
        });
    }
    function tryFindMarkerAsync(huntName, maxAttempts, intervalMs) {
        return new Promise(resolve => {
            let attempts = 0;
            const interval = setInterval(() => {
                if (clickMappedHunt(huntName)) { clearInterval(interval); resolve(true); return; }
                const markers = Array.from(document.querySelectorAll('.hunt-marker'));
                const target = markers.find(m => {
                    const nameEl = m.querySelector('.hunt-name');
                    return nameEl && nameEl.textContent.trim().toLowerCase() === huntName.toLowerCase();
                });
                if (target) { clearInterval(interval); target.click(); resolve(true); }
                else if (++attempts >= maxAttempts) { clearInterval(interval); resolve(false); }
            }, intervalMs);
        });
    }
    async function teleportToTarget(huntName, { silent = false } = {}) {
        const notify = (msg, opts) => { if (!silent) showScriptNotice(msg, opts); };
        hideDropTooltip();
        if (!huntName) { notify('Nenhuma hunt definida.'); return false; }
        await loadMapMarkersData();
        const mapBtn = document.querySelector('button[data-guide="dock-map"]');
        let mapWindow = document.querySelector('.map-window');
        const visible = mapWindow && getComputedStyle(mapWindow).display !== 'none';
        if (!visible) {
            if (mapBtn) mapBtn.click();
            mapWindow = await waitForElement('.map-window', 1200);
        }
        mapWindow = mapWindow || document.querySelector('.map-window');
        if (!mapWindow) { notify('O mapa não abriu.', { isError: true }); return false; }
        if (clickMappedHunt(huntName)) return true;
        const allTabs = getMapAreaTabs(mapWindow);
        if (allTabs.length === 0) {
            const found = await tryFindMarkerAsync(huntName, 20, 100);
            if (!found) notify(`Hunt "${huntName}" não foi localizada.`, { isError: true });
            return found;
        }
        const activeTab = mapWindow.querySelector('.map-area.on, .map-plate.on');
        if (activeTab) {
            const found = await tryFindMarkerAsync(huntName, 10, 100);
            if (found) return true;
        }
        for (let i = 0; i < allTabs.length; i++) {
            const tab = getMapAreaTabs(mapWindow)[i];
            if (!tab || tab === activeTab) continue;
            tab.click();
            await waitForMapAreaChange(activeTab);
            const found = await tryFindMarkerAsync(huntName, 40, 100);
            if (found) return true;
        }
        notify(`Hunt "${huntName}" não foi localizada em nenhuma área.`, { isError: true });
        return false;
    }

    // ============================================================
    // 15) LISTA SIMPLIFICADA
    // ============================================================
    function isScriptMapActive() { return localStorage.getItem(STORAGE_SCRIPT_ACTIVE) !== 'false'; }
    function setScriptMapActive(state) {
        localStorage.setItem(STORAGE_SCRIPT_ACTIVE, state ? 'true' : 'false');
        applyMapScriptState();
    }
    function applyMapScriptState() {
        const active = isScriptMapActive();
        const container = document.getElementById('simple-hunts-container');
        if (active) {
            if (!document.getElementById('simplifier-map-override')) document.head.appendChild(styleMapMod);
            if (container) container.style.display = 'block';
            buildSimpleList();
        } else {
            if (document.getElementById('simplifier-map-override')) styleMapMod.remove();
            if (container) container.style.display = 'none';
        }
    }

    function simplifyNativeMapControls(mapWindow) {
        if (!mapWindow) return;
        const typeNames = new Set([
            'aço','água','dragão','elétrico','fada','fantasma','fogo','gelo','inseto','lutador',
            'normal','pedra','planta','psíquico','sombrio','terra','veneno','voador',
            'steel','water','dragon','electric','fairy','ghost','fire','ice','bug','fighting',
            'rock','grass','psychic','dark','ground','poison','flying'
        ]);
        const normalize = v => String(v || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const normalizedTypes = new Set([...typeNames].map(normalize));

        const candidates = Array.from(mapWindow.querySelectorAll('div, section, nav'))
            .map(el => ({
                el,
                matches: Array.from(el.children).filter(child =>
                    normalizedTypes.has(normalize(child.textContent.replace(/[^\p{L}]/gu, '')))
                ).length
            }))
            .filter(c => c.matches >= 8)
            .filter(c => !c.el.querySelector('.map-filter-q, .map-plate, .map-area, input'))
            .sort((a, b) => a.el.getBoundingClientRect().height - b.el.getBoundingClientRect().height);

        candidates[0]?.el.classList.add('script-hidden-native-types');
    }

    function injectCitiesButton(mapWindow) {
        const areasContainer = mapWindow.querySelector('.map-areas');
        if (!areasContainer) return null;

        let citiesBtn = areasContainer.querySelector('.script-city-area');
        if (!citiesBtn) {
            citiesBtn = document.createElement('button');
            citiesBtn.type = 'button';
            citiesBtn.dataset.view = 'cities';
            citiesBtn.className = 'map-plate script-city-area';
            citiesBtn.textContent = 'Cidades';
            citiesBtn.title = 'Mostrar cidades';
            const plates = areasContainer.querySelectorAll('.map-plate:not(.script-city-area)');
            const lastPlate = plates[plates.length - 1];
            if (lastPlate) lastPlate.insertAdjacentElement('afterend', citiesBtn);
            else areasContainer.appendChild(citiesBtn);

            citiesBtn.addEventListener('click', () => {
                const isCities = mapWindow.dataset.scriptMapView === 'cities';
                mapWindow.dataset.scriptMapView = isCities ? 'hunts' : 'cities';
                citiesBtn.classList.toggle('on', !isCities);
                lastMapRenderSignature = '';
                buildSimpleList();
            });
        }
        const isCities = mapWindow.dataset.scriptMapView === 'cities';
        citiesBtn.classList.toggle('on', isCities);
        return citiesBtn;
    }

    function buildSimpleList() {
        if (!isScriptMapActive() || isRendering) return;
        isRendering = true;
        try {
            const mapWindow = document.querySelector('.map-window');
            const mapBody   = document.querySelector('.map-body');
            if (!mapWindow || !mapBody) { isRendering = false; return; }
            if (mapWindow.classList.contains('invisible-check') || !mapWindow.getClientRects().length) {
                mapWindow.dataset.scriptMapWasOpen = 'false';
                isRendering = false; return;
            }
            const openedNow = mapWindow.dataset.scriptMapWasOpen !== 'true';
            mapWindow.dataset.scriptMapWasOpen = 'true';
            simplifyNativeMapControls(mapWindow);
            injectCitiesButton(mapWindow);

            const viewMode = mapWindow.dataset.scriptMapView || 'hunts';
            const activeRegion = getActiveRegionName();
            if (activeRegion && activeRegion !== lastActiveRegion) {
                lastActiveRegion = activeRegion;
                lastMapRenderSignature = '';
            }

            let filterBar = document.getElementById('custom-hunts-filter-bar');
            if (!filterBar) {
                filterBar = document.createElement('div');
                filterBar.id = 'custom-hunts-filter-bar';
                filterBar.innerHTML = `
                    <select id="sort-hunts-select">
                        <option value="">Sem ordenação</option>
                        <option value="price_desc">Preço: Maior → Menor</option>
                        <option value="price_asc">Preço: Menor → Maior</option>
                        <option value="eff_desc">Efetividade: Maior</option>
                        <option value="xp_desc">Maior XP</option>
                    </select>
                    <select id="filter-hunts-type">
                        <option value="">Todos os tipos</option>
                    </select>
                    <select id="filter-hunts-access">
                        <option value="all">Todos</option>
                        <option value="accessible">Acessíveis</option>
                        <option value="favorites">Favoritas</option>
                        <option value="advantage">Com vantagem</option>
                        <option value="locked">Bloqueadas</option>
                    </select>
                `;
                mapBody.appendChild(filterBar);
                filterBar.addEventListener('change', () => {
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                });
            }
            filterBar.style.display = viewMode === 'cities' ? 'none' : 'grid';

            let simpleContainer = document.getElementById('simple-hunts-container');
            if (!simpleContainer) {
                simpleContainer = document.createElement('div');
                simpleContainer.id = 'simple-hunts-container';
                mapBody.appendChild(simpleContainer);
            }

            if (openedNow) {
                refreshLeaderFromHud();
                loadTrainerLevel(true).then(() => {
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
            }

            const markers = Array.from(document.querySelectorAll('.hunt-marker'));
            const favorites = getFavorites();
            const activePkmn = getActivePokemonName();
            const activePkmnTypes = cachedLeaderPokemonTypes.length
                ? cachedLeaderPokemonTypes
                : (POKEMON_TYPES[activePkmn] || []);
            const domTrainerLevel = readTrainerLevelFromDOM();
            if (domTrainerLevel && domTrainerLevel > 0) cachedTrainerLevel = domTrainerLevel;

            if (!cachedTrainerLevel || cachedTrainerLevel <= 0) {
                simpleContainer.innerHTML = '<div style="color:#718096;text-align:center;padding:20px;">Carregando nível do treinador…</div>';
                loadTrainerLevel(true).then(() => { lastMapRenderSignature = ''; buildSimpleList(); });
                isRendering = false;
                return;
            }
            const trainerLevel = cachedTrainerLevel;

            let huntDataList = [];
            markers.forEach(marker => {
                const nameEl = marker.querySelector('.hunt-name');
                const lvlEl  = marker.querySelector('.hunt-lvl');
                const iconDiv = marker.querySelector('.hunt-circle div[style*="background-image"]');
                const name = nameEl ? nameEl.textContent.trim() : 'Sem Nome';
                const lvlText = lvlEl ? lvlEl.textContent.trim() : '';
                let requiredLevel = parseInt(lvlText.replace(/\D/g, ''), 10);
                if (!Number.isFinite(requiredLevel) || requiredLevel <= 0) {
                    const apiMarker = findMappedHunt(name);
                    const apiLevel = apiMarker ? getMarkerLevel(apiMarker) : null;
                    requiredLevel = apiLevel || 1;
                }
                const city = isCityMarker(marker, name);
                const canAccess = city || trainerLevel >= requiredLevel;
                const isHere = marker.classList.contains('here');
                if (isHere && !city) saveLastHunt(name);
                const details = extractHuntDetailsFromJSON(name, marker);
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const isCaught = globalCaughtPokemonNames.has(getCleanHuntName(name));
                huntDataList.push({
                    name, displayName: city ? getCityDisplayName(name) : name,
                    city, lvlText: lvlText || `Nv ${requiredLevel}`, requiredLevel,
                    canAccess, isHere, isCaught,
                    sellsFor: details.sellsFor, numericPrice: details.numericPrice,
                    dropsHTML: details.dropsHTML, experience: details.experience,
                    expText: details.expText, effectiveness, defenderTypes,
                    iconStyle: iconDiv ? (iconDiv.getAttribute('style') || '') : (city ? getCityIconStyle(name) : ''),
                    originalElement: marker,
                    region: getActiveRegionFromMarker(marker) || activeRegion
                });
            });

            for (const markerData of new Set(globalHuntMarkerData.values())) {
                const name = getMarkerName(markerData);
                if (!name || !isCityMarker(markerData, name)
                    || huntDataList.some(e => getCleanHuntName(e.name) === getCleanHuntName(name))) continue;
                huntDataList.push({
                    name, displayName: getCityDisplayName(name), city: true,
                    lvlText: '', requiredLevel: 1, canAccess: true, isHere: false, isCaught: false,
                    sellsFor: 'Indisponível', numericPrice: 0, dropsHTML: '',
                    experience: 0, expText: '', effectiveness: 1, defenderTypes: [],
                    iconStyle: getCityIconStyle(name), originalElement: null,
                    region: getMarkerRegion(markerData) || null
                });
            }

            const crossRegionFavorites = [...new Set([...favorites, getLastHunt()].filter(Boolean))];
            crossRegionFavorites.forEach(name => {
                if (huntDataList.some(h => getCleanHuntName(h.name) === getCleanHuntName(name)) || isCityName(name)) return;
                const markerData = findMappedHunt(name);
                if (!markerData) return;
                const region = getMarkerRegion(markerData);
                const isOtherRegion = region && activeRegion && region !== activeRegion;
                if (isOtherRegion) {
                    const accessValue = filterBar.querySelector('#filter-hunts-access')?.value;
                    if (accessValue !== 'favorites') return;
                }
                const requiredLevel = getMarkerLevel(markerData) || 1;
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const details = extractHuntDetailsFromJSON(name, null);
                huntDataList.push({
                    name, displayName: name, city: false,
                    lvlText: `Nv ${requiredLevel}`, requiredLevel,
                    canAccess: trainerLevel >= requiredLevel, isHere: false,
                    isCaught: globalCaughtPokemonNames.has(getCleanHuntName(name)),
                    sellsFor: details.sellsFor, numericPrice: details.numericPrice,
                    dropsHTML: details.dropsHTML, experience: details.experience,
                    expText: details.expText, effectiveness, defenderTypes,
                    iconStyle: '', originalElement: null,
                    region: region || null,
                    isCrossRegion: true
                });
            });

            const typeSelect = filterBar.querySelector('#filter-hunts-type');
            const availableTypes = [...new Set(
                huntDataList.filter(h => h.canAccess).flatMap(h => h.defenderTypes)
            )].sort();
            const savedType = typeSelect.value;
            typeSelect.innerHTML = '<option value="">Todos os tipos</option>' +
                availableTypes.map(t => `<option value="${escapeHTML(t)}">${escapeHTML(t.toUpperCase())}</option>`).join('');
            typeSelect.value = availableTypes.includes(savedType) ? savedType : '';

            const sortVal = filterBar.querySelector('#sort-hunts-select').value;
            const accessFilter = filterBar.querySelector('#filter-hunts-access').value;
            const selectedType = typeSelect.value;

            if (selectedType) huntDataList = huntDataList.filter(h => h.canAccess && h.defenderTypes.includes(selectedType));
            if (accessFilter === 'accessible') huntDataList = huntDataList.filter(h => h.canAccess);
            else if (accessFilter === 'favorites') huntDataList = huntDataList.filter(h => favorites.includes(h.name));
            else if (accessFilter === 'advantage') huntDataList = huntDataList.filter(h => h.canAccess && h.effectiveness > 1);
            else if (accessFilter === 'locked') huntDataList = huntDataList.filter(h => !h.canAccess);

            huntDataList = huntDataList.filter(h => viewMode === 'cities' ? h.city : !h.city);

            huntDataList.sort((a, b) => {
                const aFav = favorites.includes(a.name);
                const bFav = favorites.includes(b.name);
                if (aFav && !bFav) return -1;
                if (!aFav && bFav) return 1;
                if (sortVal === 'price_desc') return b.numericPrice - a.numericPrice;
                if (sortVal === 'price_asc') return a.numericPrice - b.numericPrice;
                if (sortVal === 'eff_desc') return b.effectiveness - a.effectiveness;
                if (sortVal === 'xp_desc') return b.experience - a.experience;
                return a.name.localeCompare(b.name);
            });

            const renderSignature = JSON.stringify({
                sortVal, selectedType, accessFilter, trainerLevel, favorites, viewMode, activePkmn, activeRegion,
                rows: huntDataList.map(h => [h.name, h.lvlText, h.canAccess, h.isHere, h.numericPrice, h.effectiveness])
            });
            if (renderSignature === lastMapRenderSignature && simpleContainer.childElementCount) { isRendering = false; return; }
            lastMapRenderSignature = renderSignature;
            simpleContainer.innerHTML = '';

            if (huntDataList.length === 0) {
                simpleContainer.innerHTML = '<div style="color:#718096;text-align:center;padding:20px;">Nenhuma hunt encontrada.</div>';
                isRendering = false; return;
            }

            huntDataList.forEach(hunt => {
                const isFav = favorites.includes(hunt.name);
                const row = document.createElement('div');
                row.style = `
                    display:flex; align-items:center; justify-content:space-between;
                    padding:10px 14px; margin-bottom:8px;
                    background: ${!hunt.canAccess ? '#25191d' : (hunt.isHere ? '#163126' : (isFav ? '#282116' : '#14222d'))};
                    border-left: 4px solid ${!hunt.canAccess ? '#e05252' : (hunt.isHere ? '#4caf50' : (isFav ? '#f6c453' : '#273f52'))};
                    border-radius:4px; color:#e2e8f0; font-size:14px;
                    cursor:${hunt.canAccess ? 'pointer' : 'not-allowed'}; opacity:${hunt.canAccess ? '1' : '.72'};
                `;

                const spriteContainer = document.createElement('div');
                spriteContainer.style = `width:42px;height:42px;min-width:42px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#1c3040;border-radius:50%;margin-right:14px;`;
                if (hunt.city) {
                    const badge = document.createElement('span');
                    badge.textContent = /cerulean/i.test(hunt.name) ? '💧' : /pewter|lavender/i.test(hunt.name) ? '🪨' : /viridian/i.test(hunt.name) ? '🌿' : '🎰';
                    badge.style.cssText = 'font-size:25px;';
                    spriteContainer.appendChild(badge);
                } else if (hunt.iconStyle) {
                    const sprite = document.createElement('div');
                    sprite.style = hunt.iconStyle;
                    spriteContainer.appendChild(sprite);
                } else {
                    const img = document.createElement('img');
                    img.alt = hunt.displayName;
                    img.style = 'width:38px;height:38px;object-fit:contain;image-rendering:pixelated;';
                    img.src = `https://poke.idleworld.online/assets/pokeitems/${hunt.name.toLowerCase()}.png`;
                    img.onerror = () => img.remove();
                    spriteContainer.appendChild(img);
                }

                const infoDiv = document.createElement('div');
                infoDiv.style = 'flex-grow:1;margin-right:12px;';
                const typeBadges = hunt.defenderTypes.map(t =>
                    `<span style="font-size:10px;padding:2px 6px;border-radius:4px;text-transform:uppercase;background:#2d3748;color:#cbd5e0;">${t}</span>`
                ).join(' ');
                infoDiv.innerHTML = `
                    <div style="font-weight:bold;color:${isFav ? '#3182ce' : '#fff'};display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        ${hunt.displayName}
                        ${hunt.city ? '' : `<span style="font-size:11px;background:#243b4d;padding:2px 6px;border-radius:4px;color:#cbd5e0;">${hunt.lvlText}</span>`}
                        ${hunt.city ? '' : `<span style="font-size:12px;font-weight:950;padding:4px 9px;border-radius:999px;border:1px solid currentColor;color:${hunt.effectiveness > 1 ? '#9cffb2' : hunt.effectiveness < 1 ? '#ff9b9b' : '#cbd5e0'};background:${hunt.effectiveness > 1 ? '#123d25' : hunt.effectiveness < 1 ? '#481d24' : '#293746'};">${hunt.effectiveness}x</span>`}
                        ${hunt.city ? '' : typeBadges}
                        ${hunt.isHere ? '<span style="font-size:11px;color:#4caf50;font-weight:bold;">[Aqui]</span>' : ''}
                        ${!hunt.canAccess ? `<span style="font-size:11px;color:#ff8b8b;background:#3b2026;border:1px solid #71313c;padding:2px 6px;border-radius:4px;">🔒 Nv ${hunt.requiredLevel}</span>` : ''}
                    </div>
                    ${hunt.city ? '' : `<div style="font-size:12px;color:#48bb78;margin-top:3px;">${hunt.sellsFor !== 'Indisponível' ? `Valor: ${hunt.sellsFor}` : ''} ${hunt.expText ? `<span style="color:#ed8936;margin-left:8px;">${hunt.expText}</span>` : ''}</div>`}
                `;

                row.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    hideDropTooltip();
                    if (!hunt.canAccess) {
                        showScriptNotice(`Esta hunt exige nível ${hunt.requiredLevel}. Seu nível é ${trainerLevel}.`, { title: 'Hunt bloqueada' });
                        return;
                    }
                    saveLastHunt(hunt.name);
                    teleportToTarget(hunt.name);
                });

                const actionContainer = document.createElement('div');
                actionContainer.style = 'display:flex;align-items:center;';

                const favBtn = document.createElement('button');
                favBtn.type = 'button';
                favBtn.innerHTML = isFav ? '★' : '☆';
                favBtn.style = `background:none;border:none;color:${isFav ? '#f6c453' : '#4a5568'};font-size:20px;cursor:pointer;padding:4px 8px;outline:none;`;
                favBtn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    toggleFavorite(hunt.name);
                });
                actionContainer.appendChild(favBtn);

                row.appendChild(spriteContainer);
                row.appendChild(infoDiv);
                row.appendChild(actionContainer);
                simpleContainer.appendChild(row);
            });

        } catch (e) {
            console.error('Erro no Mapa Simplificado:', e);
        } finally {
            isRendering = false;
        }
    }

    // ============================================================
    // 16) PAINEL DE INVENTÁRIO (BALLS / POTIONS / REVIVES)
    //     Agora com atualização em TEMPO REAL via API + WebSocket
    // ============================================================
    const INVENTORY_CATEGORIES = [
        {
            id: 'balls',
            label: '🔴 Poké Bolas',
            match: (name, alt, iconSrc) => {
                const n = (name || alt || '').toLowerCase();
                const src = (iconSrc || '').toLowerCase();
                return /\b(pok[eé]\s*ball|great\s*ball|super\s*ball|ultra\s*ball|idle\s*ball|master\s*ball)\b/.test(n)
                    || /markitems\/(pokeball|greatball|superball|ultraball|idleball|masterball)\.png/.test(src);
            }
        },
        {
            id: 'potions',
            label: '💊 Poções',
            match: (name, alt, iconSrc) => {
                const n = (name || alt || '').toLowerCase();
                const src = (iconSrc || '').toLowerCase();
                return /\bpotion\b|\bpotions\b/.test(n)
                    || /markitems\/(small_potion|great_potion|ultra_potion|hyper_potion|ultimate_potion)\.png/.test(src);
            }
        },
        {
            id: 'revives',
            label: '✨ Revives',
            match: (name, alt, iconSrc) => {
                const n = (name || alt || '').toLowerCase();
                const src = (iconSrc || '').toLowerCase();
                return /\brevive\b|\brevives\b/.test(n)
                    || /markitems\/(revive|max_revive)\.png/.test(src);
            }
        }
    ];

    function categorizeItem(name, alt, iconSrc) {
        for (const cat of INVENTORY_CATEGORIES) {
            if (cat.match(name, alt, iconSrc)) return cat.id;
        }
        return null;
    }

    // --- Leitura via DOM (fallback) ---
    function readInventoryFromDOM() {
        const grid = document.querySelector('.inv-grid');
        if (!grid) return null;

        const entries = [];
        grid.querySelectorAll('.inv-slot').forEach(slot => {
            if (slot.classList.contains('empty')) return;
            if (slot.classList.contains('inv-poke')) return;

            const img = slot.querySelector('img.inv-ico, img.poke-icon-img, img');
            if (!img) return;

            const alt = (img.getAttribute('alt') || '').trim();
            const title = (slot.getAttribute('title') || '').trim();
            const name = alt || title.split('—')[0].trim();
            if (!name) return;

            const iconSrc = img.getAttribute('src') || '';
            const qtyEl = slot.querySelector('.inv-qty');
            const qtyText = (qtyEl?.textContent || '').trim();
            const qty = qtyText ? (parseInt(qtyText.replace(/[^0-9]/g, ''), 10) || 1) : 1;

            entries.push({ name, alt, title, iconSrc, qty });
        });
        return entries;
    }

    // --- Leitura via API (tempo real) ---
    async function fetchInventoryFromAPI() {
        const payload = await gameApiRequest(INVENTORY_API_URL);
        const items = Array.isArray(payload) ? payload
                    : (payload?.items || payload?.inventory || []);
        await loadItemCatalog();

        const entries = [];
        items.forEach(entry => {
            if (!entry) return;
            const itemId = String(entry.itemId ?? entry.id ?? entry.item_id ?? '').trim();
            const qty = Number(entry.quantity ?? entry.qty ?? entry.amount ?? 0);
            if (!itemId || qty <= 0) return;

            const catalog = globalItemCatalog.get(itemId);
            const name = catalog?.name || entry.name || entry.title || `Item ${itemId}`;
            const iconRaw = catalog?.icon || entry.icon || entry.image || '';
            const iconSrc = iconRaw ? normalizeGameItemIcon(iconRaw) : '';
            entries.push({ name, alt: name, title: name, iconSrc, qty, itemId });
        });
        return entries;
    }

    // --- Agrupamento ---
    function groupInventory(entries) {
        const grouped = { balls: [], potions: [], revives: [] };
        (entries || []).forEach(entry => {
            const cat = categorizeItem(entry.name, entry.alt, entry.iconSrc);
            if (cat) grouped[cat].push(entry);
        });
        Object.keys(grouped).forEach(key => {
            grouped[key].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        });
        return grouped;
    }

    // --- Render do painel ---
    function ensureInventoryPanel() {
        let panel = document.getElementById('script-inv-panel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'script-inv-panel';
        panel.style = 'position:fixed;right:8px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;background:rgba(20,16,10,.88);border:2px solid rgb(120,90,40);border-radius:10px;padding:8px 6px;z-index:9000;max-height:80vh;overflow:hidden;font-family:sans-serif;color:#e2e8f0;';
        panel.innerHTML = `
            <button id="script-inv-toggle" type="button" title="Mostrar/ocultar inventário"
                style="background:transparent;border:0;color:#ffcc00;font-size:18px;font-weight:bold;width:40px;height:36px;border-radius:8px;cursor:pointer;">🎒</button>
            <div id="script-inv-body" style="display:none;width:230px;max-height:70vh;overflow-y:auto;padding-right:2px;">
                <div id="script-inv-content"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const toggleBtn = panel.querySelector('#script-inv-toggle');
        const body = panel.querySelector('#script-inv-body');
        const open = localStorage.getItem(STORAGE_INV_PANEL_OPEN) === 'true';
        body.style.display = open ? 'block' : 'none';
        toggleBtn.style.color = open ? '#ffcc00' : '#a0aec0';

        toggleBtn.addEventListener('click', () => {
            const isOpen = body.style.display !== 'none';
            body.style.display = isOpen ? 'none' : 'block';
            toggleBtn.style.color = isOpen ? '#a0aec0' : '#ffcc00';
            localStorage.setItem(STORAGE_INV_PANEL_OPEN, String(!isOpen));
            if (!isOpen) refreshInventoryPanel();
        });

        return panel;
    }

    function renderInventoryContent(grouped) {
        const panel = ensureInventoryPanel();
        const content = panel.querySelector('#script-inv-content');

        const signature = JSON.stringify(grouped);
        if (signature === lastInventorySignature && content.childElementCount) return;
        lastInventorySignature = signature;

        let html = '';
        for (const cat of INVENTORY_CATEGORIES) {
            const items = grouped[cat.id] || [];
            html += `<div style="margin-bottom:8px;">
                <div style="font-weight:800;font-size:12px;color:#d9c38c;border-bottom:1px solid #3a2c17;padding:4px 2px;margin-bottom:4px;">${cat.label}</div>`;
            if (!items.length) {
                html += '<div style="color:#718096;font-size:11px;padding:2px 4px;">—</div>';
            } else {
                items.forEach(item => {
                    const icon = item.iconSrc
                        ? `<img src="${escapeHTML(item.iconSrc)}" alt="" style="width:24px;height:24px;object-fit:contain;image-rendering:pixelated;flex:none;">`
                        : '<span style="width:24px;height:24px;flex:none;"></span>';
                    html += `
                        <div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.03);margin-bottom:3px;">
                            ${icon}
                            <span style="flex:1;min-width:0;font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(item.name)}</span>
                            <span style="font-weight:800;font-size:12px;color:#f6c453;flex:none;">×${formatNumber(item.qty)}</span>
                        </div>`;
                });
            }
            html += `</div>`;
        }
        content.innerHTML = html;
    }

    async function refreshInventoryPanel() {
        const panel = ensureInventoryPanel();
        const body = panel.querySelector('#script-inv-body');
        if (body.style.display === 'none') return;

        if (inventoryFetchInFlight) return;
        inventoryFetchInFlight = true;

        try {
            const entries = await fetchInventoryFromAPI();
            renderInventoryContent(groupInventory(entries));
        } catch (error) {
            // Fallback: DOM
            const domEntries = readInventoryFromDOM();
            if (domEntries) {
                renderInventoryContent(groupInventory(domEntries));
            } else {
                const content = panel.querySelector('#script-inv-content');
                content.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:12px;text-align:center;">Não foi possível carregar o inventário.</div>';
            }
        } finally {
            inventoryFetchInFlight = false;
        }
    }

    function startInventoryAutoRefresh() {
        if (inventoryRefreshTimer) clearInterval(inventoryRefreshTimer);
        inventoryRefreshTimer = setInterval(() => {
            const panel = document.getElementById('script-inv-panel');
            if (!panel) return;
            const body = panel.querySelector('#script-inv-body');
            if (body && body.style.display !== 'none') refreshInventoryPanel();
        }, INVENTORY_REFRESH_INTERVAL_MS);
    }

    // ============================================================
    // 17) PATCH DO WEBSOCKET — refresh imediato em eventos de item
    // ============================================================
    function patchWebSocketForInventory() {
        const NativeWebSocket = window.WebSocket;
        if (!NativeWebSocket || NativeWebSocket.__piwQolPatched) return;
        NativeWebSocket.__piwQolPatched = true;

        const originalAddEventListener = NativeWebSocket.prototype.addEventListener;
        // Não interceptamos mensagens diretamente; usamos um listener global via patch de send/receive
        // para pegar eventos como "inventory", "item-used", "ball-used", "potion-used".

        function handleGameMessage(message) {
            if (!message || typeof message !== 'object') return;
            const type = String(message.type || '').toLowerCase();
            if (/inventory|item|ball|potion|revive|use|heal|sell|buy|drop/.test(type)) {
                // Re-consulta a API logo em seguida
                setTimeout(() => {
                    const panel = document.getElementById('script-inv-panel');
                    if (!panel) return;
                    const body = panel.querySelector('#script-inv-body');
                    if (body && body.style.display !== 'none') refreshInventoryPanel();
                }, 300);
            }
        }

        // Patch do construtor WebSocket
        const OriginalWebSocket = window.WebSocket;
        function PatchedWebSocket(url, protocols) {
            const socket = protocols === undefined
                ? new OriginalWebSocket(url)
                : new OriginalWebSocket(url, protocols);
            socket.addEventListener('message', event => {
                try {
                    const data = JSON.parse(event.data);
                    handleGameMessage(data);
                } catch { /* ignore */ }
            });
            return socket;
        }
        PatchedWebSocket.prototype = OriginalWebSocket.prototype;
        Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
        window.WebSocket = PatchedWebSocket;
    }

    // ============================================================
    // 18) TOOLTIP / NOTIFICAÇÕES / BOTÃO DE NAVEGAÇÃO
    // ============================================================
    function showDropTooltip(e, dropsHTML) {
        hideDropTooltip();
        activeTooltip = document.createElement('div');
        activeTooltip.style = `position:absolute;background:#0c161f;border:1px solid #233e52;border-radius:8px;padding:10px 14px;z-index:9999;font-size:13px;color:#e2e8f0;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,0.8);min-width:180px;max-width:280px;`;
        activeTooltip.innerHTML = `<div style="font-weight:bold;color:#48bb78;margin-bottom:8px;">Drops da Hunt:</div>${dropsHTML}`;
        document.body.appendChild(activeTooltip);
        const rect = e.target.getBoundingClientRect();
        activeTooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
        activeTooltip.style.left = `${rect.left + window.scrollX}px`;
    }
    function hideDropTooltip() {
        if (activeTooltip) { activeTooltip.remove(); activeTooltip = null; }
    }
    function showScriptNotice(message, { title = 'Aviso', isError = false } = {}) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10150;display:flex;align-items:center;justify-content:center;';
            backdrop.innerHTML = `
                <div style="background:#0c161f;border:2px solid #785a28;border-radius:10px;width:min(420px,92vw);color:#e2e8f0;font-family:sans-serif;">
                    <div style="padding:12px 16px;border-bottom:1px solid #1a2d3a;font-weight:bold;color:#63b3ed;">${isError ? '⚠️' : 'ℹ️'} ${escapeHTML(title)}</div>
                    <div style="padding:16px;">
                        <p style="margin:0 0 14px;color:${isError ? '#feb2b2' : '#e2e8f0'};">${escapeHTML(message)}</p>
                        <button class="ok" style="width:100%;padding:8px;background:linear-gradient(#e6cd8e,#c8a24e);color:#1a1206;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">OK</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.querySelector('.ok').addEventListener('click', () => { backdrop.remove(); resolve(); });
        });
    }

    function injectQuickTPButton() {
        let sidebar = document.getElementById('script-sidebar');
        if (!sidebar) {
            sidebar = document.createElement('div');
            sidebar.id = 'script-sidebar';
            sidebar.style = 'position:fixed;left:8px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;background:rgba(20,16,10,.85);border:2px solid rgb(120,90,40);border-radius:10px;padding:8px 6px;z-index:9000;';
            document.body.appendChild(sidebar);
        }
        let tpBtn = document.getElementById('dock-btn-quick-tp');
        if (!tpBtn) {
            tpBtn = document.createElement('button');
            tpBtn.id = 'dock-btn-quick-tp';
            tpBtn.type = 'button';
            tpBtn.style = 'background:transparent;border:0;color:#ffcc00;font-size:16px;font-weight:bold;width:36px;height:36px;border-radius:8px;cursor:pointer;';
            tpBtn.addEventListener('click', handleNavQuickTP);
            sidebar.appendChild(tpBtn);
            updateNavButtonAppearance();
        }
    }
    function handleNavQuickTP() {
        const mode = getNavTpMode();
        if (mode === 'fav') teleportToFavorite();
        else if (mode === 'last') teleportToLastHunt();
    }
    function teleportToFavorite() {
        const favs = getFavorites();
        if (favs.length === 0) return showScriptNotice('Você não possui nenhuma hunt favorita.');
        const primary = getPrimaryFavorite();
        teleportToTarget(primary || favs[0]);
    }
    function teleportToLastHunt() {
        const last = getLastHunt();
        if (!last) return showScriptNotice('Nenhuma última hunt registrada ainda.');
        teleportToTarget(last);
    }
    function updateNavButtonAppearance() {
        const tpBtn = document.getElementById('dock-btn-quick-tp');
        if (!tpBtn) return;
        const mode = getNavTpMode();
        tpBtn.hidden = mode === 'off';
        if (mode === 'off') return;
        tpBtn.innerHTML = mode === 'fav' ? '★' : '↺';
        const primary = getPrimaryFavorite();
        tpBtn.title = mode === 'fav'
            ? `Teleportar para ${primary || 'Hunt Favorita'}`
            : 'Teleportar para Última Hunt';
    }

    // ============================================================
    // 19) ESTILO
    // ============================================================
    const styleMapMod = document.createElement('style');
    styleMapMod.id = 'simplifier-map-override';
    styleMapMod.innerHTML = `
        /* Esconde apenas o mapa gráfico; preserva busca, abas e filtros nativos */
        .map-viewport, .map-img, .map-zoom { display: none !important; }
        .hunt-marker { opacity: 0 !important; position: absolute !important; pointer-events: none !important; }

        /* Corpo do mapa: respiro consistente */
        .map-window .map-body {
            padding: 10px 14px 14px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            box-sizing: border-box !important;
            overflow: hidden !important;
        }

        /* Busca nativa */
        .map-window .map-filters {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            margin: 0 !important;
            padding: 0 !important;
            flex-wrap: wrap !important;
        }
        .map-window .map-filter-q {
            flex: 1 1 220px !important;
            min-height: 34px !important;
            padding: 6px 10px !important;
            background: #0d1a24 !important;
            color: #e2e8f0 !important;
            border: 1px solid #263d4e !important;
            border-radius: 8px !important;
            outline: none !important;
        }
        .map-window .map-filter-lvl {
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            color: #a0aec0 !important;
            font-size: 12px !important;
        }
        .map-window .map-filter-lvl input {
            width: 56px !important;
            min-height: 30px !important;
            padding: 4px 6px !important;
            background: #0d1a24 !important;
            color: #e2e8f0 !important;
            border: 1px solid #263d4e !important;
            border-radius: 6px !important;
        }

        /* Abas de região — ícones maiores, mesma linha */
        .map-window .map-areas {
            display: flex !important;
            gap: 8px !important;
            margin: 0 !important;
            padding: 0 !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            justify-content: flex-start !important;
            overflow: visible !important;
        }
        .map-window .map-plate {
            border-radius: 10px !important;
            overflow: hidden !important;
            border: 1px solid #263746 !important;
            background: #111c25 !important;
            padding: 4px !important;
            cursor: pointer !important;
            flex: 0 0 auto !important;
            width: 110px !important;
            height: 68px !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: border-color .15s, box-shadow .15s, transform .15s !important;
        }
        .map-window .map-plate:hover {
            transform: translateY(-1px) !important;
            border-color: #3a5876 !important;
        }
        .map-window .map-plate img {
            max-width: 100% !important;
            max-height: 100% !important;
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
            display: block !important;
        }
        .map-window .map-plate.on {
            border-color: #9f7b35 !important;
            box-shadow: 0 0 0 2px rgba(159,123,53,.45) !important;
        }
        .map-window .map-plate.locked { opacity: .5 !important; }

        /* Botão "Cidades" — mesmo tamanho visual das abas */
        .map-window .map-areas .script-city-area {
            width: 110px !important;
            height: 68px !important;
            padding: 0 !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: #111c25 !important;
            color: #e2e8f0 !important;
            border: 1px solid #263746 !important;
            border-radius: 10px !important;
            font: 800 14px sans-serif !important;
            letter-spacing: .3px !important;
            cursor: pointer !important;
            flex: 0 0 auto !important;
            transition: border-color .15s, box-shadow .15s, transform .15s, background .15s, color .15s !important;
        }
        .map-window .map-areas .script-city-area:hover {
            transform: translateY(-1px) !important;
            border-color: #3a5876 !important;
        }
        .map-window .map-areas .script-city-area.on {
            color: #f6c453 !important;
            border-color: #9f7b35 !important;
            background: #1b211f !important;
            box-shadow: 0 0 0 2px rgba(159,123,53,.45) !important;
        }

        /* Barra de tipos nativa (escondida) */
        .map-window .script-hidden-native-types { display: none !important; }

        /* Barra de filtros do script */
        #custom-hunts-filter-bar {
            display: grid !important;
            grid-template-columns: minmax(175px,1.4fr) minmax(115px,1fr) minmax(145px,1fr) !important;
            gap: 8px !important;
            margin: 0 !important;
            padding: 0 !important;
            background: transparent !important;
            border: 0 !important;
        }
        #custom-hunts-filter-bar select {
            min-height: 34px !important;
            padding: 6px 10px !important;
            background: #0d1a24 !important;
            color: #cbd5e0 !important;
            border: 1px solid #263d4e !important;
            border-radius: 8px !important;
            outline: none !important;
        }

        /* Container da lista */
        #simple-hunts-container {
            flex: 1 1 auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow-y: auto !important;
            background: #0d161d !important;
            border: 1px solid #1a2d3a !important;
            border-radius: 8px !important;
            padding: 10px !important;
            box-sizing: border-box !important;
            margin: 0 !important;
        }
        #simple-hunts-container > div {
            border-radius: 8px !important;
            margin-bottom: 8px !important;
        }
        #simple-hunts-container > div:last-child { margin-bottom: 0 !important; }

        @media (max-width: 720px) {
            #custom-hunts-filter-bar { grid-template-columns: 1fr !important; }
            .map-window .map-plate,
            .map-window .map-areas .script-city-area {
                width: 88px !important;
                height: 56px !important;
            }
        }
    `;
    function appendStyleWhenReady(styleElement) {
        if (document.head) document.head.appendChild(styleElement);
        else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(styleElement), { once: true });
    }
    appendStyleWhenReady(styleMapMod);

    // ============================================================
    // 20) INICIALIZAÇÃO
    // ============================================================
    const observer = new MutationObserver(() => {
        if (renderTimeout) return;
        renderTimeout = setTimeout(() => {
            renderTimeout = null;
            injectQuickTPButton();
            if (document.querySelector('.map-window')) {
                refreshLeaderFromHud();
                if (!cachedTrainerLevel || cachedTrainerLevel <= 0) {
                    loadTrainerLevel(true).then(() => {
                        lastMapRenderSignature = '';
                        buildSimpleList();
                    });
                }
                buildSimpleList();
            }
            if (document.querySelector('.inv-grid')) {
                if (inventoryRenderTimeout) clearTimeout(inventoryRenderTimeout);
                inventoryRenderTimeout = setTimeout(() => {
                    inventoryRenderTimeout = null;
                    refreshInventoryPanel();
                }, 150);
            }
        }, 200);
    });

    function initialize() {
        patchWebSocketForInventory();
        loadItemCatalog();
        loadExternalPokemonData();
        loadMapMarkersData();
        loadTrainerLevel(true);
        refreshLeaderFromHud();
        applyMapScriptState();
        ensureInventoryPanel();
        startInventoryAutoRefresh();
        observer.observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            const changed = refreshLeaderFromHud();
            loadTrainerLevel(true).then(() => {
                if (changed || document.querySelector('.map-window')) {
                    lastMapRenderSignature = '';
                    if (document.querySelector('.map-window')) buildSimpleList();
                }
            });
            if (document.querySelector('.inv-grid')) refreshInventoryPanel();
        }, 10000);

        // Primeira carga do painel
        refreshInventoryPanel();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }

    document.addEventListener('click', event => {
        if (event.target.closest('.map-plate:not(.script-city-area), .map-area:not(.script-city-area)')) {
            lastMapRenderSignature = '';
            setTimeout(() => buildSimpleList(), 250);
        }
    }, true);

})();
