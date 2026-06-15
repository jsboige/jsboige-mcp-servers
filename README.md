# jsboige-mcp-servers

Collection de serveurs MCP (Model Context Protocol) pour étendre les capacités des modèles de langage (LLM).

[![CI](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml/badge.svg)](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## CI

- **Workflow** (`.github/workflows/ci.yml`): build + vitest for roo-state-manager
- **Branch protection**: CI must pass before merge on `main`
- **Configs**: `vitest.config.ts` (dev) / `vitest.config.ci.ts` (CI, excludes 32 platform-dependent tests)

---

## Qu'est-ce que MCP?

Le Model Context Protocol (MCP) est un protocole qui permet aux modèles de langage (LLM) d'interagir avec des outils et des ressources externes.

Ce protocole permet d'étendre considérablement les capacités des LLM en leur donnant accès à:

- Recherche d'informations en temps réel
- Accès à des API externes
- Manipulation de fichiers
- Analyse de code
- Coordination multi-agent (RooSync)
- Et bien plus encore

## Contenu du dépôt

Ce dépôt est un **submodule** du projet principal [roo-extensions](https://github.com/jsboige/roo-extensions).
Les serveurs MCP sont placés dans le répertoire `servers/`:

### Serveurs actifs

#### roo-state-manager (Principal)

Le composant central du système RooSync Multi-Agent:

- **15 outils MCP** pour la coordination multi-machine
- **Conversations**: browse, view, tree, summarize (Roo + Claude Code)
- **RooSync**: send, read, manage, heartbeat, compare_config
- **Dashboards**: global, machine, workspace (cross-machine coordination)
- **Indexation sémantique**: Qdrant + embeddings (codebase_search, roosync_search)
- **Baselines**: update, version, restore, export

**Stack**: TypeScript, Node.js 20.18.0, Vitest (~7900 tests)
**Doc**: [servers/roo-state-manager/README.md](servers/roo-state-manager/README.md)

#### sk-agent

Agent-centric LLM proxy server for Claude Code and Roo Code.

- Multi-agent conversations (DeepSearch, DeepThink)
- Vector memory per-agent via Qdrant
- Tool calling via MCP plugins (SearXNG, Playwright)
- Vision support (image, video, document analysis)

**Stack**: Python, Semantic Kernel, FastMCP
**Doc**: [servers/sk-agent/README.md](servers/sk-agent/README.md)

### Serveurs retirés

Ces serveurs existent dans `servers/` mais sont **retirés du config actif** :

- `quickfiles-server` — remplacé par les capacités natives de Claude Code
- `jinavigator-server` — remplacé par markitdown MCP
- `github-projects-mcp` — remplacé par `gh` CLI

---

## Installation

### Prérequis

- **Node.js 20.18.0** (version CI)
- npm 10.x ou supérieur
- Git
- Python 3.10+ (pour sk-agent)

### Installation rapide

```bash
# Cloner le dépôt (comme submodule)
git clone --recurse-submodules https://github.com/jsboige/roo-extensions.git
cd roo-extensions/mcps/internal

# Installer roo-state-manager
cd servers/roo-state-manager && npm install && npm run build
```

### Installation individuelle

#### roo-state-manager

```bash
cd servers/roo-state-manager
npm install && npm run build
npx vitest run  # NEVER npm test (watch mode blocks)
```

#### sk-agent

```bash
cd servers/sk-agent
pip install -r requirements.txt
# See servers/sk-agent/README.md for configuration
```

---

## Architecture

```text
servers/
├── roo-state-manager/   # TypeScript — 15 tools, RooSync core
│   ├── src/tools/       # Tool definitions + handlers
│   ├── src/services/    # Business logic (RooSync, Qdrant, heartbeat)
│   ├── src/resources/   # MCP resources
│   └── tests/           # ~7900 vitest tests
├── sk-agent/            # Python — LLM proxy, multi-agent
│   ├── sk_agent.py      # FastMCP entry point
│   └── sk_conversations.py
└── (retired: quickfiles, jinavigator, github-projects)
```

---

## Développement

### Avant de committer

1. **Build**: `npm run build` (serveurs TypeScript)
2. **Tests**: `npx vitest run` (JAMAIS `npm test` — watch mode blocks)
3. **CI config**: `npx vitest run --config vitest.config.ci.ts` (exclut 32 tests platform-dependants)

---

## Contribution

Ce dépôt est un **submodule** de [roo-extensions](https://github.com/jsboige/roo-extensions).

1. Consulter les [issues ouvertes](https://github.com/jsboige/roo-extensions/issues)
2. PR obligatoire — pas de push direct sur `main`
3. Configurer les variables d'environnement (voir `.env.example`)

---

## Licence

MIT - voir [LICENSE](LICENSE)

---

## Ressources

- [Spécification MCP officielle](https://modelcontextprotocol.io)
- [Projet parent: roo-extensions](https://github.com/jsboige/roo-extensions)
- [Issue CI: #626](https://github.com/jsboige/roo-extensions/issues/626) - Suivi réparation CI
