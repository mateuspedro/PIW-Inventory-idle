# PIW — Painel de Inventário em Tempo Real

Userscript para **Poké Idle World** que adiciona um painel lateral para acompanhar o inventário do jogador em tempo real.

O script monitora **Poké Bolas, Poções e Revives**, obtendo os dados diretamente do contexto interno da aplicação React e mantendo um cache local para preservar as informações entre carregamentos.

---

## ✨ Funcionalidades

* 📦 **Painel de inventário integrado à interface do jogo**
* 🔴 Monitoramento de **Poké Bolas**
* 💊 Monitoramento de **Poções**
* ✨ Monitoramento de **Revives**
* ⚡ Atualização praticamente em tempo real através do contexto interno do jogo
* 🔄 Botão para atualização manual
* 💾 Cache do inventário utilizando `localStorage`
* 🟢 Indicador de dados **ao vivo** ou provenientes do **cache**
* 🖼️ Exibição dos ícones dos itens
* 🔢 Formatação automática das quantidades
* 📱 Painel compacto e independente da interface original
* 🛡️ Escape de HTML para evitar inserção de conteúdo não confiável no painel
* 🔧 Fallback para leitura do inventário diretamente do DOM caso o contexto React não esteja disponível
* 🔁 Atualização automática periódica
* 💡 Mantém o estado aberto/fechado do painel entre sessões

---

## 🎮 Compatibilidade

O userscript foi desenvolvido para:

**Poké Idle World**

URL:

`https://poke.idleworld.online/play`

O script utiliza:

* React Fiber
* React Context
* API interna de comunicação do jogo
* DOM da aplicação
* `localStorage`
* Catálogo de itens do jogo

> ⚠️ Como o script depende de estruturas internas da aplicação, alterações futuras no jogo podem quebrar ou alterar seu funcionamento.

---

## 📋 Categorias monitoradas

Atualmente o painel acompanha três categorias:

| Categoria     | Exemplos                                             |
| ------------- | ---------------------------------------------------- |
| 🔴 Poké Bolas | Poké Ball, Great Ball, Ultra Ball, Master Ball, etc. |
| 💊 Poções     | Potions                                              |
| ✨ Revives     | Revives                                              |

Itens com quantidade **igual ou inferior a 1** não são exibidos no painel.

---

## 🚀 Instalação

### 1. Instale um gerenciador de Userscripts

Recomenda-se utilizar uma extensão como:

* **Tampermonkey**
* **Violentmonkey**

### 2. Instale o script

Abra o arquivo `.user.js` no gerenciador de Userscripts ou crie um novo script e cole o conteúdo do projeto.

### 3. Acesse o jogo

Entre em:

`https://poke.idleworld.online/play`

Após o carregamento, o painel 🎒 aparecerá no lado direito da tela.

---

## 🖥️ Utilização

O painel fica localizado no lado direito da tela.

### 🎒 Abrir / fechar

Clique no botão:

**🎒**

para mostrar ou ocultar o inventário.

O estado do painel é salvo automaticamente no `localStorage`.

### 🔄 Atualização manual

Quando o painel estiver aberto, o botão:

**🔄**

permite solicitar uma atualização imediata dos dados.

### 🟢 Status dos dados

O painel informa a origem dos dados:

```text
● ao vivo · 14:32:15
```

ou:

```text
○ cache · 14:32:15
```

**Ao vivo** indica que o script recebeu dados recentemente através do contexto do jogo.

**Cache** indica que o script está utilizando os últimos dados armazenados localmente.

---

## ⚙️ Como funciona

O PIW tenta obter o contexto React utilizado pelo jogo através do **React Fiber**.

O processo principal é:

```text
Página do jogo
      │
      ▼
React Fiber
      │
      ▼
Game Context
      │
      ├── inventory
      ├── balls
      ├── field-kill
      ├── catch-result
      ├── item-use
      ├── ball-use
      ├── potion-use
      ├── revive
      └── shop-buy
      │
      ▼
Dados do inventário
      │
      ▼
Agrupamento / normalização
      │
      ▼
Cache local
      │
      ▼
Painel PIW
```

---

## 🔌 Game Context

Quando disponível, o script procura um elemento da HUD do jogo e percorre sua árvore interna do React para localizar um contexto que possua:

```javascript
subscribe()
send()
```

Após encontrar o contexto, o script realiza assinaturas em eventos relacionados ao inventário.

Por exemplo:

```javascript
gameContext.subscribe('inventory', callback);
```

e:

```javascript
gameContext.subscribe('balls', callback);
```

Também são monitorados eventos que podem alterar o inventário:

```text
field-kill
catch-result
poke-xp
item-use
ball-use
potion-use
revive
shop-buy
```

Quando um desses eventos ocorre, o script solicita novamente os dados do inventário.

---

## 🔄 Atualização automática

O script possui dois mecanismos independentes de atualização.

### Heartbeat do inventário

A cada:

```text
15 segundos
```

é realizada uma nova solicitação de inventário quando o `gameContext` está disponível.

### Renderização

O painel é atualizado visualmente a cada:

```text
3 segundos
```

quando está aberto.

Além disso, eventos recebidos pelo contexto podem provocar uma atualização imediata do painel.

---

## 💾 Cache local

O inventário é armazenado utilizando:

```javascript
localStorage
```

As principais chaves utilizadas são:

```text
script_inv_panel_open_v1
script_inv_cache_v1
```

O cache possui a seguinte estrutura:

```javascript
{
    balls: [],
    potions: [],
    revives: []
}
```

Isso permite que os últimos dados conhecidos permaneçam disponíveis mesmo quando os dados em tempo real ainda não foram carregados.

---

## 🧩 Fallback para o DOM

Caso o contexto interno do jogo não seja encontrado, o script possui mecanismos alternativos para tentar obter os dados diretamente da interface.

São utilizados principalmente:

```text
.inv-grid
.inv-slot
.inv-qty
.ah-modal
.cap-chip
.ah-sel
```

Isso permite que o painel continue funcionando mesmo quando o acesso ao contexto React não está disponível.

O fallback não substitui completamente o modo em tempo real, mas serve como mecanismo de recuperação.

---

## 📦 Catálogo de itens

Os nomes e ícones dos itens são obtidos através do catálogo:

```text
https://poke.idleworld.online/game/items.json
```

O catálogo é carregado uma vez e armazenado em memória através de:

```javascript
Map()
```

O script utiliza o catálogo para transformar IDs internos dos itens em informações legíveis, como:

* Nome
* Ícone
* Identificador

---

## 🗂️ Estrutura de dados

Cada item armazenado possui informações semelhantes a:

```javascript
{
    name: "Ultra Ball",
    iconSrc: "/assets/items/ultra_ball.png",
    qty: 25,
    cat: "balls"
}
```

As categorias disponíveis são:

```text
balls
potions
revives
```

---

## 🛡️ Segurança

O script utiliza `escapeHTML()` antes de inserir determinados valores provenientes dos dados do jogo no HTML do painel.

Exemplo:

```javascript
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[char]);
}
```

Isso reduz o risco de valores inesperados do catálogo serem interpretados como HTML.

---

## ⚠️ Limitações

O projeto depende de APIs e estruturas internas do jogo que não fazem parte necessariamente de uma API pública/documentada.

Por isso:

* Atualizações do jogo podem quebrar o script.
* Alterações na estrutura React podem impedir a descoberta do `gameContext`.
* Alterações nos eventos internos podem afetar as atualizações.
* Alterações no HTML podem quebrar o fallback baseado em DOM.
* Alterações no catálogo de itens podem exigir ajustes no parser.
* O script foi desenvolvido especificamente para a interface atual do Poké Idle World.

---

## 🛠️ Configurações principais

Algumas configurações podem ser encontradas no início do script:

```javascript
const INVENTORY_HEARTBEAT_MS = 15000;
const INVENTORY_RENDER_MS    = 3000;
```

### `INVENTORY_HEARTBEAT_MS`

Intervalo para solicitar novamente os dados do inventário.

Valor padrão:

```text
15 segundos
```

### `INVENTORY_RENDER_MS`

Intervalo para verificar e atualizar a renderização do painel.

Valor padrão:

```text
3 segundos
```

---

## 📁 Estrutura recomendada

```text
PIW/
├── piw-inventory.user.js
├── README.md
└── LICENSE
```

O arquivo principal é:

```text
piw-inventory.user.js
```

---

## 🧑‍💻 Desenvolvimento

O projeto é um **Userscript JavaScript puro** e não necessita de:

* Node.js
* npm
* bundler
* framework adicional
* servidor próprio

Basta editar o arquivo `.user.js` e recarregar a página do jogo.

---

## 🔧 Tecnologias utilizadas

* JavaScript
* Userscript API
* Tampermonkey / Violentmonkey
* React Fiber
* React Context
* DOM API
* MutationObserver
* Fetch API
* LocalStorage
* JSON

---

## 📌 Versão

**PIW 2.0.0**

### Principais características da versão 2.0.0

* Painel lateral de inventário
* Leitura através do contexto interno do jogo
* Atualização em tempo real
* Suporte a Poké Bolas
* Suporte a Poções
* Suporte a Revives
* Cache local
* Fallback via DOM
* Atualização automática
* Atualização manual
* Persistência do estado do painel

---

## 👤 Autor

**KizaniN**

Projeto desenvolvido como uma ferramenta de qualidade de vida para o **Poké Idle World**.

---

## ⚖️ Aviso

Este projeto é um userscript independente e não possui, salvo indicação em contrário, vínculo oficial com os desenvolvedores ou administradores do Poké Idle World.

Use por sua própria conta e risco. Mudanças no jogo podem exigir atualizações no script.
