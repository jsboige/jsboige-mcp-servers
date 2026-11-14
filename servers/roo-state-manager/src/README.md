# Architecture du Serveur MCP roo-state-manager

## 📊 Vue d'Ensemble

Ce serveur MCP fournit des outils pour gérer et analyser l'état des conversations et tâches Roo.

**Version :** 1.0.14
**Architecture :** Modulaire et évolutive
**Fichiers :** 358 modules TypeScript hors tests (1 086 fichiers `.ts` au total, tests inclus)
**Lignes de code :** ~157 000 lignes hors tests

## 🧪 Tests

### Framework de Tests
Le projet utilise **Vitest** pour les tests unitaires et d'intégration, offrant une compatibilité ESM native et des performances supérieures à Jest.

**Statistiques :** 460 tests | 83% de réussite | Exécution ~39s

### Lancer les Tests
```bash
npm test              # Mode watch interactif
npm run test:run      # Exécution unique
npm run test:ui       # Interface web de debug
npm run test:coverage # Avec rapport de couverture
```

### Structure des Tests
```
tests/
├── unit/            # Tests unitaires
│   ├── config/
│   ├── services/
│   ├── tools/
│   └── utils/
├── integration/     # Tests d'intégration
├── e2e/            # Tests end-to-end
└── fixtures/       # Données de test

src/
└── tools/
    └── **/__tests__/  # Tests co-localisés
```

### Documentation
- [`VITEST_MIGRATION_REPORT.md`](../docs/reports/VITEST_MIGRATION_REPORT.md) - Rapport de migration Jest → Vitest
- [`vitest.config.ts`](../vitest.config.ts) - Configuration Vitest

---

## 🏗️ Structure

### Arborescence

```
src/
├── index.ts               # RooStateManagerServer — point d'entrée MCP
├── start.ts / preload.ts  # bootstrap et préchargement
├── config/                # configuration serveur et constantes (3 modules)
├── interfaces/            # contrat unifié des outils (1)
├── models/                # modèles de synthèse (1)
├── notifications/         # notifications et interception d'usage (3)
├── schemas/               # schémas générés (1)
├── transport/             # transport HTTP + contexte appelant (2)
├── validation/            # moteur de validation (1)
├── types/                 # types et schémas Zod (21)
├── services/              # services métier — 60 modules racine + 12 sous-dossiers (442 .ts)
├── tools/                 # handlers MCP — 16 catégories (416 .ts)
├── utils/                 # utilitaires — 55 modules racine + extractors/ (151 .ts)
└── archive/               # exemples historiques (1)
```

Compteurs mesurés sur l'arbre au 14/11/2026, fichiers de tests inclus.

### [`index.ts`](index.ts:1)
**Point d'entrée principal** — classe `RooStateManagerServer` : validation des variables d'environnement, initialisation du [`StateManager`](services/state-manager.service.ts:1), démarrage du serveur MCP via [`createMcpServer()`](config/server-config.ts:1), gestion des erreurs et arrêt propre.

[`start.ts`](start.ts:1) et [`preload.ts`](preload.ts:1) portent le bootstrap (chargement d'environnement, préchargement des modules).

### [`config/`](config/) (3 modules)
**Configuration centralisée** du serveur et constantes.

- [`server-config.ts`](config/server-config.ts:1) — `SERVER_CONFIG`, `CACHE_CONFIG`, `INDEXING_CONFIG`, `OUTPUT_CONFIG`, `ANTI_LEAK_CONFIG`, `createMcpServer()`
- [`roosync-config.ts`](config/roosync-config.ts:1) — configuration de la synchronisation inter-machines
- [`tool-timeouts.ts`](config/tool-timeouts.ts:1) — délais d'exécution par outil

### [`services/`](services/) (60 modules racine, 12 sous-dossiers)
**Services métier** (état, indexation, recherche, synthèse, export, RooSync, stockage unifié).

#### Cœur du serveur

- [`state-manager.service.ts`](services/state-manager.service.ts:1) — `StateManager` : état global, caches de conversations, métriques d'indexation et queue Qdrant
- [`background-services.ts`](services/background-services.ts:1) — services de fond : `loadSkeletonsFromDisk()`, `startProactiveMetadataRepair()`, `startQdrantIndexingBackgroundProcess()`, `classifyIndexingError()`
- [`skeleton-cache.service.ts`](services/skeleton-cache.service.ts:1) — cache de squelettes (`SkeletonHeader`)

#### Recherche et indexation

- [`task-indexer.ts`](services/task-indexer.ts:1), [`task-searcher.ts`](services/task-searcher.ts:1), [`task-navigator.ts`](services/task-navigator.ts:1), [`task-partition.ts`](services/task-partition.ts:1)
- [`indexing-decision.ts`](services/indexing-decision.ts:1) — `IndexingDecisionService` : ce qui doit être indexé
- [`qdrant.ts`](services/qdrant.ts:1), [`embedding-endpoints.ts`](services/embedding-endpoints.ts:1) — accès Qdrant et endpoints d'embedding

#### Synthèse et export

- [`synthesis/SynthesisOrchestratorService.ts`](services/synthesis/SynthesisOrchestratorService.ts:1) — `SynthesisOrchestratorService` (migré sous `services/synthesis/` par la PR #1722)
- [`synthesis/LLMService.ts`](services/synthesis/LLMService.ts:1) — `LLMService` (ex-`LLMSynthesisService`)
- [`synthesis/NarrativeContextBuilderService.ts`](services/synthesis/NarrativeContextBuilderService.ts:1) — `NarrativeContextBuilderService`
- [`TraceSummaryService.ts`](services/TraceSummaryService.ts:1) — `TraceSummaryService` : statistiques de conversations
- [`XmlExporterService.ts`](services/XmlExporterService.ts:1) — `XmlExporterService` (ex-`XMLExportService`)

#### RooSync, configuration et stockage

- [`RooSyncService.ts`](services/RooSyncService.ts:1) — `RooSyncService`, `getRooSyncService()`
- [`MessageManager.ts`](services/MessageManager.ts:1) — messages inter-machines
- [`ClaudeSettingsService.ts`](services/ClaudeSettingsService.ts:1), [`ConfigService.ts`](services/ConfigService.ts:1), [`ConfigDiffService.ts`](services/ConfigDiffService.ts:1), [`ConfigHealthCheckService.ts`](services/ConfigHealthCheckService.ts:1)
- [`roosync/`](services/roosync/) — 13 modules RooSync (baseline, harmonisation, inventaire, cache)
- [`unified-store/`](services/unified-store/) — 27 modules du magasin unifié fichier/PostgreSQL (lecteurs, écrivains, dual-write, réconciliation dashboard)

#### Autres sous-dossiers

`baseline/` (4 modules), `code-index/` (4), `extraction/` (6), `markdown-formatter/` (4), `reporting/` (11), `task-archiver/` (3), `task-indexer/` (4), `trace-summary/` (6), `_archives/` (modules retirés, conservés pour référence).

### [`tools/`](tools/) (16 catégories)
**Handlers des outils MCP.** [`registry.ts`](tools/registry.ts:1) enregistre les handlers `ListTools` et `CallTool` et porte `TOOL_CAPABILITIES` ; [`tool-definitions.ts`](tools/tool-definitions.ts:1) définit les schémas d'outils.

> Les anciens fichiers `*.tool.ts` de `tools/` ont été renommés (suffixe retiré) ou fusionnés. Notamment : `read-conversation.tool.ts` et `view-conversation-tree.tool.ts` sont désormais servis par l'outil consolidé [`conversation-browser.ts`](tools/conversation/conversation-browser.ts:1) (actions `list`/`tree`/`view`/`summarize`), et `rebuild-task-index.tool.ts` a rejoint `tools/maintenance/`.

| Catégorie | Modules | Point d'entrée / symboles |
|---|---:|---|
| `cache/` | 2 | `build-skeleton-cache.tool.ts` → [`build-skeleton-cache.tool.ts`](tools/cache/build-skeleton-cache.tool.ts:1) |
| `claims/` | 1 | [`claim.tool.ts`](tools/claims/claim.tool.ts:1) |
| `conversation/` | 8 | `handleConversationBrowser()` → [`conversation-browser.ts`](tools/conversation/conversation-browser.ts:1) ; `getRawConversationTool` → [`get-raw.tool.ts`](tools/conversation/get-raw.tool.ts:1) ; `viewTaskDetailsTool` → [`view-details.tool.ts`](tools/conversation/view-details.tool.ts:1) ; `debugAnalyzeTool` → [`debug-analyze.tool.ts`](tools/conversation/debug-analyze.tool.ts:1) |
| `diagnostic/` | 2 | [`analyze_problems.ts`](tools/diagnostic/analyze_problems.ts:1) |
| `export/` | 9 | `exportDataTool` → [`export-data.ts`](tools/export/export-data.ts:1) ; `handleExportConversationJson()` → [`export-conversation-json.ts`](tools/export/export-conversation-json.ts:1) ; CSV → [`export-conversation-csv.ts`](tools/export/export-conversation-csv.ts:1) ; XML conversation → [`export-conversation-xml.ts`](tools/export/export-conversation-xml.ts:1) ; XML tâches → [`export-tasks-xml.ts`](tools/export/export-tasks-xml.ts:1) ; XML projet → [`export-project-xml.ts`](tools/export/export-project-xml.ts:1) ; configuration → [`configure-xml-export.ts`](tools/export/configure-xml-export.ts:1) |
| `indexing/` | 8 | `indexTaskSemanticTool` → [`index-task.tool.ts`](tools/indexing/index-task.tool.ts:1) ; `resetQdrantCollectionTool` → [`reset-collection.tool.ts`](tools/indexing/reset-collection.tool.ts:1) ; [`diagnose-index.tool.ts`](tools/indexing/diagnose-index.tool.ts:1) ; [`roosync-indexing.tool.ts`](tools/indexing/roosync-indexing.tool.ts:1) |
| `maintenance/` | 3 | `handleRebuildTaskIndex()` → [`rebuild-task-index.ts`](tools/maintenance/rebuild-task-index.ts:1) |
| `repair/` | 3 | [`diagnose-conversation-bom.tool.ts`](tools/repair/diagnose-conversation-bom.tool.ts:1) ; [`repair-conversation-bom.tool.ts`](tools/repair/repair-conversation-bom.tool.ts:1) |
| `roosync/` | 39 | [`dashboard.ts`](tools/roosync/dashboard.ts:1) ; [`messages.ts`](tools/roosync/messages.ts:1) ; [`config.ts`](tools/roosync/config.ts:1) ; [`inventory.ts`](tools/roosync/inventory.ts:1) ; [`diagnose.ts`](tools/roosync/diagnose.ts:1) ; [`health-view.ts`](tools/roosync/health-view.ts:1) |
| `search/` | 6 | `searchTasksByContentTool` → [`search-semantic.tool.ts`](tools/search/search-semantic.tool.ts:1) ; [`search-codebase.tool.ts`](tools/search/search-codebase.tool.ts:1) ; [`roosync-search.tool.ts`](tools/search/roosync-search.tool.ts:1) |
| `smart-truncation/` | 4 | [`engine.ts`](tools/smart-truncation/engine.ts:1) |
| `storage/` | 3 | `storageInfoTool` → [`storage-info.ts`](tools/storage/storage-info.ts:1) ; `detectStorageTool` → [`detect-storage.tool.ts`](tools/storage/detect-storage.tool.ts:1) |
| `summary/` | 5 | [`generate-trace-summary.tool.ts`](tools/summary/generate-trace-summary.tool.ts:1) ; [`generate-cluster-summary.tool.ts`](tools/summary/generate-cluster-summary.tool.ts:1) ; [`get-conversation-synthesis.tool.ts`](tools/summary/get-conversation-synthesis.tool.ts:1) ; [`roosync-summarize.tool.ts`](tools/summary/roosync-summarize.tool.ts:1) |
| `task/` | 10 | `getTaskTreeTool` → [`get-tree.tool.ts`](tools/task/get-tree.tool.ts:1) ; `taskBrowseTool` → [`browse.ts`](tools/task/browse.ts:1) ; `debugTaskParsingTool` → [`debug-parsing.tool.ts`](tools/task/debug-parsing.tool.ts:1) ; `exportTaskTreeMarkdownTool` → [`export-tree-md.tool.ts`](tools/task/export-tree-md.tool.ts:1) ; [`get-current-task.tool.ts`](tools/task/get-current-task.tool.ts:1) |
| `test/` | 1 | [`minimal-test.tool.ts`](tools/test/minimal-test.tool.ts:1) |

Outils à la racine de `tools/` : [`claudish-traffic.ts`](tools/claudish-traffic.ts:1), [`get_mcp_best_practices.ts`](tools/get_mcp_best_practices.ts:1), [`manage-mcp-settings.ts`](tools/manage-mcp-settings.ts:1), [`read-vscode-logs.ts`](tools/read-vscode-logs.ts:1), [`rebuild-and-restart.ts`](tools/rebuild-and-restart.ts:1), [`view-conversation-tree.ts`](tools/view-conversation-tree.ts:1).

### [`types/`](types/) (21 fichiers)
**Définitions de types et schémas Zod.**

- [`unified-task.ts`](types/unified-task.ts:1) — `UnifiedTaskSchema`, `UnifiedTask`, `TaskStatus`, `TaskOutcome`, `StorageTier`
- [`task-tree.ts`](types/task-tree.ts:1) — arbre de tâches
- [`conversation.ts`](types/conversation.ts:1) — structure des conversations
- [`tool-definitions.ts`](types/tool-definitions.ts:1) — interface `Tool` standard MCP
- [`index.ts`](types/index.ts:1) — barrel exports

### [`utils/`](utils/) (55 modules racine, `extractors/`)
**Fonctions utilitaires** réutilisables.

- [`server-helpers.ts`](utils/server-helpers.ts:1) — `truncateResult()`, `handleTouchMcpSettings()`, `handleExportConversationJson()`, `handleExportConversationCsv()`
- [`logger.ts`](utils/logger.ts:1) — journalisation
- [`shared-state-path.ts`](utils/shared-state-path.ts:1) — résolution du store partagé RooSync
- [`roo-storage-detector.ts`](utils/roo-storage-detector.ts:1) — détection du stockage Roo
- [`secret-redaction.ts`](utils/secret-redaction.ts:1) — masquage des secrets

### Transport, notifications et validation

- [`transport/http-transport.ts`](transport/http-transport.ts:1), [`transport/caller-context.ts`](transport/caller-context.ts:1) — transport HTTP et identité de l'appelant
- [`notifications/NotificationService.ts`](notifications/NotificationService.ts:1), [`notifications/ToolUsageInterceptor.ts`](notifications/ToolUsageInterceptor.ts:1), [`notifications/GlobalNotifState.ts`](notifications/GlobalNotifState.ts:1)
- [`validation/ValidationEngine.ts`](validation/ValidationEngine.ts:1)
- [`models/synthesis/SynthesisModels.ts`](models/synthesis/SynthesisModels.ts:1)
- [`interfaces/UnifiedToolInterface.ts`](interfaces/UnifiedToolInterface.ts:1)
- [`schemas/generate-unified-task-schema.ts`](schemas/generate-unified-task-schema.ts:1)
- [`archive/examples/phase5-demo.ts`](archive/examples/phase5-demo.ts:1) — exemple historique

---

## 🔧 Utilisation

### Développement

```bash
# Installation des dépendances
npm install

# Compilation TypeScript
npm run build

# Démarrage du serveur
node build/src/index.js
```

### Configuration

Le serveur nécessite les variables d'environnement suivantes (définies dans `.env`) :

- `OPENAI_API_KEY` - Clé API OpenAI (synthèses LLM)
- `QDRANT_URL` - URL du serveur Qdrant (recherche sémantique)
- `QDRANT_API_KEY` - Clé API Qdrant
- `ROO_STORAGE_PATH` - Chemin vers le stockage Roo
- Et 6 autres variables (voir [`.env.example`](../.env.example))

### Tests

```bash
# Tests unitaires (nécessite migration Vitest)
npm test

# Validation manuelle
npm run build && node build/src/index.js
```

---

## 📊 Métriques

### Code
- **Fichiers TypeScript :** 358 hors tests (1 086 avec les tests)
- **Lignes de code :** ~157 000 hors tests
- **Imports circulaires :** 0 (validé par madge)
- **Complexité index.ts :** ~15 (excellent)

### Performance
- **Démarrage :** ~2 secondes
- **Chargement squelettes :** ~4000 fichiers en mémoire
- **Temps de réponse outils :** < 1 seconde (la plupart)

---

## 🎯 Principes Architecturaux

1. **Single Responsibility** - Chaque module a une seule responsabilité
2. **Dependency Injection** - État injecté via StateManager
3. **Separation of Concerns** - Config/Logic/Services/Utils séparés
4. **Modularity** - Modules indépendants et testables
5. **No Circular Dependencies** - Architecture propre
6. **Barrel Exports** - Imports hiérarchiques

---

## 📚 Documentation

### Rapports Disponibles

Dans le répertoire racine du serveur :
- **REFACTORING_INDEX_FINAL_REPORT.md** - Rapport final complet
- **VALIDATION_REPORT_FINAL.md** - Validation post-refactorisation
- **GIT_SYNC_FINAL_REPORT.md** - Synchronisation Git
- **REFACTORING_BATCH9_REPORT.md** - Rapport Batch 9
- **BATCH6_ARCHITECTURE_NOTE.md** - Note architecturale

### Guides

- [Installation et Configuration](../README.md)
- Guide de Développement (à créer)
- Architecture détaillée (à créer)

---

## 🚀 Évolutions Futures

### Court Terme
- Migration tests Jest → Vitest
- Documentation API complète
- Optimisation performance

### Moyen Terme
- Tests d'intégration end-to-end
- Monitoring et alerting
- Support multi-utilisateurs

### Long Terme
- Architecture distribuée
- Scalabilité horizontale
- Nouvelles intégrations

---

**Dernière mise à jour :** 14 novembre 2026
**Version :** 1.0.14
**Statut :** Production-ready ✅