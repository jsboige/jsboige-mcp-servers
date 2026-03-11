# jsboige-mcp-servers

Collection de serveurs MCP (Model Context Protocol) pour étendre les capacités des modèles de langage (LLM).

[![CI](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml/badge.svg)](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml)
[![License: MIT](https://imgices.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Test Coverage](https://imgices.shields.io/codecov/c/github/jsboige/jsboige-mcp-servers)](https://codecov.io/gh/jsboige/jsboige-mcp-servers)

## CI Policy

**Branch Protection** (Phase 2 - EN ATTENTE):
- Le CI doit passer avant tout merge sur `main`
- Actuellement configuré manuellement via GitHub UI
- TODO: Automatiser via API ou configuration as-code

**Notifications** (Phase 2 - EN ATTENTE):
- TODO: GitHub Action pour notifier (issue auto) quand CI casse
- TODO: Dashboard de santé CI dans le repo parent

**Workflow Actuel** (`.github/workflows/ci.yml`):
- Tests sur jupyter-mcp-server, jinavigator-server (Node 20.18.0)
- Tests spécifiques pour roo-state-manager (build + vitest)
- Lint: vérification README.md, jest.config, tests
- Docs: vérification documentation structure

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

### Serveurs disponibles

#### Roo State Manager (Principal)

Le serveur **roo-state-manager** est le composant central du système RooSync Multi-Agent:

- **36 outils MCP** pour la coordination multi-machine
- Gestion des conversations Roo (conversation_browser, view, tree, summarize)
- Communication RooSync (send, read, manage, heartbeat, compare_config)
- Gestion des baselines (update, version, restore, export)
- Indexation sémantique (Qdrant)
- Diagnostics et maintenance

**Stack**: TypeScript, Node.js 20.18.0, Vitest
**Tests**: 7600+ tests unitaires
**Documentation**: [servers/roo-state-manager/README.md](servers/roo-state-manager/README.md)

#### Jupyter MCP Server

Un serveur MCP pour interagir avec des notebooks Jupyter:
- Gestion des notebooks (lecture, création, modification)
- Gestion des kernels (démarrage, arrêt, interruption)
- Exécution de code (cellules ou notebooks complets)

> **Note**: Problèmes d'authentification possibles dans certaines configurations. Consultez le [Guide de dépannage](./docs/jupyter-mcp-troubleshooting.md).

#### JinaNavigator Server

Un serveur MCP utilisant l'API Jina pour convertir des pages web en Markdown:
- Conversion web → Markdown
- Extraction de portions spécifiques
- Accès via URI `jina://{url}`

---

## Installation

### Prérequis

- **Node.js 20.18.0** (version CI)

- npm 10.x ou supérieur
- Git
- Python avec Jupyter (pour le serveur Jupyter MCP)

### Installation rapide

```bash
# Cloner le dépôt (comme submodule)
git clone --recurse-submodules https://github.com/jsboige/roo-extensions.git
cd roo-extensions/mcps/internal

# Installer les dépendances d'un serveur spécifique
cd servers/roo-state-manager
npm install
npm run build
```

### Installation par serveur

#### Roo State Manager
```bash
cd servers/roo-state-manager
npm install
npm run build
npm test  # ou npx vitest run
```

#### Jupyter MCP Server
```bash
cd servers/jupyter-papermill-mcp-server
pip install -e .

# Démarrer Jupyter avec les options recommandées
jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin='*' --no-browser
```

#### JinaNavigator Server
```bash
cd servers/jinavigator-server
npm install
npm run build
```

---

## Architecture

```
servers/
└── server-name/
    ├── README.md           # Documentation
    ├── package.json        # Dépendances et scripts
    ├── jest.config.{js|cjs}  # Configuration Jest
    ├── tsconfig.json       # Configuration TypeScript
    ├── src/                # Code source
    │   ├── index.ts        # Point d'entrée
    │   ├── tools/          # Implémentation des outils
    │   ├── resources/      # Implémentation des ressources
    │   └── utils/          # Utilitaires
    └── __tests__/          # Tests unitaires
        ├── *.test.{js|ts}  # Tests fonctionnels
        └── integration/    # Tests d'intégration
```

---

## Développement

### Avant de committer

1. **Build**: `npm run build` (pour les serveurs TypeScript)
2. **Tests**: `npm test` ou `npx vitest run`
3. **Linting**: Vérifier la conformité aux standards du projet

### Branches

- `main`: Branche principale protégée (CI requis)
- Les features se font via des branches temporaires ou PRs

---

## Contribution

Ce dépôt est un **submodule** de roo-extensions. Pour contribuer:

1. Consulter les [issues ouvertes](https://github.com/jsboige/roo-extensions/issues)
2. Suivre le processus de contribution du projet parent
3. Les pull requests se font sur le dépôt principal

---

## Licence

MIT - voir [LICENSE](LICENSE)

---

## Ressources

- [Spécification MCP officielle](https://github.com/microsoft/mcp)
- [Projet parent: roo-extensions](https://github.com/jsboige/roo-extensions)
- [Issue CI: #626](https://github.com/jsboige/roo-extensions/issues/626) - Suivi réparation CI
