# Roo State Manager MCP

Serveur MCP (Model Context Protocol) unifie pour la gestion des conversations et configurations Roo.

**Version:** 1.0.14 | **Outils:** 34 | **Tests:** ~10 000

## 🔒 CI & Branch Protection

**Branch `main` is protected.** The `roo-state-manager` CI job must pass before merging.

### Before pushing to main

```bash
cd servers/roo-state-manager
npm run build && npx vitest run --config vitest.config.ci.ts
```

### Two Vitest configs

| Config | Usage | Excludes |
|--------|-------|----------|
| `vitest.config.ts` | Local dev | Only e2e/timeouts |
| `vitest.config.ci.ts` | CI (GitHub Actions) | + 32 platform-dependent test files |

### CI failure notifications

When CI fails on `main`, an issue is auto-created with the `ci-failure` label. Fix the issue and close the notification.

---

## 🎯 Objectif

Le Roo State Manager fournit la coordination multi-agents RooSync :

- **Gestion des conversations** — navigation, tree, view, summarize, rebuild
- **RooSync messaging** — send, reply, inbox, mark_read, archive, bulk operations
- **Dashboard** — global, machine, workspace dashboards avec team stages
- **Recherche semantique** — roosync_search (Qdrant), codebase_search
- **Gestion de configuration** — baselines, configs, inventaire machines
- **Diagnostic** — env, debug, reset, test, analyze, best-practices
- **Export de donnees** — XML, JSON, CSV, Markdown (conversations, tasks, projects)
- **Maintenance** — rebuild task index, storage management, cache rebuild

---

## 📁 Structure du Projet

```
roo-state-manager/
├── src/
│   ├── index.ts              # Serveur MCP principal
│   ├── tools/                # 34 outils MCP
│   │   ├── cache/            # Skeleton cache
│   │   ├── conversation/     # Navigation conversations
│   │   ├── diagnostic/       # Diagnostic & debug
│   │   ├── export/           # Export donnees
│   │   ├── maintenance/      # Maintenance
│   │   ├── roosync/          # Messaging RooSync
│   │   └── test/             # Outils de test
│   ├── services/             # Services metiers
│   │   ├── baseline/         # Gestion baselines
│   │   ├── extraction/       # Task extraction
│   │   ├── roosync/          # Services RooSync
│   │   └── notification/     # Notifications push
│   ├── types/                # Types TypeScript
│   ├── utils/                # Utilitaires
│   └── validation/           # Validation schemas
├── tests/                    # Tests Vitest (~10 000)
├── scripts/                  # Scripts utilitaires
├── docs/                     # Documentation technique
├── package.json
├── tsconfig.json
└── vitest.config.ci.ts       # Config CI
```

## 🚀 Installation

```bash
# Installation des dependances
npm install

# Compilation TypeScript
npm run build

# Lancer la suite de tests complete
npx vitest run

# Tests CI (sans tests platform-dependants)
npx vitest run --config vitest.config.ci.ts
```

## ⚙️ Configuration

### Variables d'environnement (.env)

| Variable | Description |
|----------|-------------|
| `ROOSYNC_SHARED_PATH` | Chemin vers le partage RooSync (GDrive) |
| `QDRANT_URL` | URL du serveur Qdrant pour la recherche semantique |
| `QDRANT_API_KEY` | Cle API Qdrant |
| `OPENAI_API_KEY` | Cle API OpenAI pour la synthese LLM |
| `ZAI_API_KEY` | Cle API z.ai pour les modeles GLM |

### Configuration MCP

Le serveur se configure via `mcp_settings.json` (VS Code) ou `~/.claude.json` (Claude Code) :

```json
{
  "roo-state-manager": {
    "command": "node",
    "args": ["build/index.js"],
    "cwd": "mcps/internal/servers/roo-state-manager"
  }
}
```

## 🧰 Outils MCP (34 outils)

### conversation_browser (8 outils)
Navigation et analyse des conversations Roo : list, tree, view, summarize, rebuild

### roosync (10 outils)
Messagerie inter-machines : send, reply, inbox, message, mark_read, archive, bulk operations, attachments

### dashboard (6 outils)
Gestion des dashboards : read, write, append, condense, list, delete, refresh

### roosync_search (1 outil)
Recherche semantique et textuelle dans les sessions

### codebase_search (1 outil)
Recherche semantique dans le code source du workspace

### inventory (2 outils)
Inventaire machines, heartbeat, system snapshot

### config (2 outils)
Gestion des configurations : collect, publish, apply

### baseline (6 outils)
Gestion des baselines : update, version, restore, export, list_versions

---

## 🧪 Tests

```bash
# Tous les tests
npx vitest run

# Tests unitaires uniquement
npm run test:unit

# Tests d'integration
npm run test:integration

# Tests e2e
npm run test:e2e

# Tests avec coverage (lourd — a utiliser avec discretion)
npm run test:coverage
```

**Taux de succes attendu :**
| Machine | Taux |
|---------|------|
| ai-01 | 99.8% |
| po-2023/24/25/26 | 99.6% |
| web1 | 99.6% |

## 📚 Documentation

- [Architecture](docs/architecture.md) — Principes et specifications techniques
- [Configuration & Deployment](docs/CONFIGURATION-ET-DEPLOYMENT.md) — Guide de deploiement
- [Tests & Validation](docs/TESTS-ET-VALIDATION.md) — Stratégies de tests
- [Troubleshooting](docs/troubleshooting.md) — Resolution de problèmes
- [MCP Best Practices](docs/mcp-best-practices.md) — Bonnes pratiques d'integration

## 🔄 Build & Deployment

```bash
# Build complet
npm run build

# Build + tests
npm run test:all

# Dev mode (watch TypeScript)
npm run dev
```

## 📄 License

MIT
