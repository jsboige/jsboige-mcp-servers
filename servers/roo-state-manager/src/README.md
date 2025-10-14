# Architecture du Serveur MCP roo-state-manager

## 📊 Vue d'Ensemble

Ce serveur MCP fournit des outils pour gérer et analyser l'état des conversations et tâches Roo.

**Version :** 1.0.8  
**Architecture :** Modulaire et évolutive  
**Fichiers :** 142 modules TypeScript  
**Lignes de code :** ~40 000 lignes

---

## 🏗️ Structure

### [`index.ts`](index.ts:1) (221 lignes)
**Point d'entrée principal** - Orchestre l'initialisation du serveur MCP.

**Responsabilités :**
- Validation des variables d'environnement (10 variables critiques)
- Initialisation du [`StateManager`](services/state-manager.service.ts:1)
- Démarrage du serveur MCP via [`createMcpServer()`](config/server-config.ts:1)
- Gestion des erreurs globales et shutdown graceful

**Architecture :**
```typescript
class RooStateManagerServer {
  constructor()                      // Init StateManager
  registerHandlers()                 // Délégué à registry.ts
  initializeBackgroundServices()     // Services asynchrones
  ensureSkeletonCacheIsFresh()      // Failsafe cache
  run()                             // Démarrage
  stop()                            // Arrêt propre
}
```

---

### [`config/`](config/)
**Configuration centralisée** du serveur et constantes.

#### [`server-config.ts`](config/server-config.ts:1) (66 lignes)
- Configuration du serveur MCP (nom, version, capabilities)
- Constantes de cache (`MAX_CACHE_SIZE`, `CACHE_TTL_MS`)
- Configuration d'indexation (`BATCH_SIZE`, `EMBEDDING_MODEL`)
- Configuration de sortie (`MAX_OUTPUT_LENGTH`)
- Fonction [`createMcpServer()`](config/server-config.ts:1) pour instanciation

---

### [`services/`](services/) (43 fichiers)
**Services métier** (caches, indexation, synthèse, export, etc.).

#### Services Principaux

**[`state-manager.service.ts`](services/state-manager.service.ts:1) (144 lignes)**
- Gestion de l'état global du serveur
- Initialisation de tous les services
- Cache de conversations (`conversationCache`)
- Métriques d'indexation et queue Qdrant
- Getters pour accès contrôlé

**[`background-services.ts`](services/background-services.ts:1) (441 lignes)**
- Architecture à 2 niveaux (startup + background)
- [`loadSkeletonsFromDisk()`](services/background-services.ts:1) - Chargement initial
- [`startProactiveMetadataRepair()`](services/background-services.ts:1) - Réparation auto
- [`initializeQdrantIndexingService()`](services/background-services.ts:1) - Indexation Qdrant
- [`verifyQdrantConsistency()`](services/background-services.ts:1) - Vérification cohérence

#### Services Spécialisés

**[`TraceSummaryService.ts`](services/TraceSummaryService.ts:1)**
- Génération de statistiques de conversations
- Analyse de patterns d'utilisation
- Rapports détaillés avec métriques

**[`SynthesisOrchestratorService.ts`](services/SynthesisOrchestratorService.ts:1)**
- Orchestration des synthèses LLM
- Coordination des analyses narratives
- Gestion des contextes complexes

**[`XMLExportService.ts`](services/XMLExportService.ts:1)**
- Export structuré au format XML
- Hiérarchie de tâches et conversations
- Métadonnées enrichies

**[`LLMSynthesisService.ts`](services/LLMSynthesisService.ts:1)**
- Intégration OpenAI API
- Génération de synthèses narratives
- Traitement de contextes longs

**[`indexing-decision.service.ts`](services/indexing-decision.service.ts:1)**
- Stratégies d'indexation sémantique
- Décisions intelligentes sur ce qui doit être indexé
- Optimisation Qdrant

---

### [`tools/`](tools/) (59 fichiers)
**Handlers des outils MCP** organisés par catégorie.

#### [`registry.ts`](tools/registry.ts:1) (355 lignes)
**Enregistrement centralisé** de tous les outils MCP.

**Responsabilités :**
- Handler [`ListTools`](tools/registry.ts:1) - Liste des outils disponibles
- Handler [`CallTool`](tools/registry.ts:1) - Dispatch vers handlers appropriés
- Mapping complet des ~40 outils MCP
- Switch géant pour routing des appels

#### Organisation par Catégorie

**[`cache/`](tools/cache/) (2 outils)**
- [`build-skeleton-cache.tool.ts`](tools/cache/build-skeleton-cache.tool.ts:1) - Construction cache
- [`rebuild-task-index.tool.ts`](tools/cache/rebuild-task-index.tool.ts:1) - Reconstruction index

**[`conversation/`](tools/conversation/) (4 outils)**
- [`list-conversations.tool.ts`](tools/conversation/list-conversations.tool.ts:1) - Liste conversations
- [`read-conversation.tool.ts`](tools/conversation/read-conversation.tool.ts:1) - Lecture conversation
- [`view-conversation-tree.tool.ts`](tools/conversation/view-conversation-tree.tool.ts:1) - Vue arborescente
- [`get-raw-conversation.tool.ts`](tools/conversation/get-raw-conversation.tool.ts:1) - Contenu brut

**[`export/`](tools/export/) (6 outils)**
- [`export-conversation-json.tool.ts`](tools/export/export-conversation-json.tool.ts:1) - Export JSON
- [`export-conversation-csv.tool.ts`](tools/export/export-conversation-csv.tool.ts:1) - Export CSV
- [`export-tasks-xml.tool.ts`](tools/export/export-tasks-xml.tool.ts:1) - Export XML tâche
- [`export-conversation-xml.tool.ts`](tools/export/export-conversation-xml.tool.ts:1) - Export XML conversation
- [`export-project-xml.tool.ts`](tools/export/export-project-xml.tool.ts:1) - Export XML projet
- [`export-task-tree-markdown.tool.ts`](tools/export/export-task-tree-markdown.tool.ts:1) - Export Markdown

**[`indexing/`](tools/indexing/) (4 outils)**
- [`index-task-semantic.tool.ts`](tools/indexing/index-task-semantic.tool.ts:1) - Indexation sémantique
- [`reset-qdrant-collection.tool.ts`](tools/indexing/reset-qdrant-collection.tool.ts:1) - Reset Qdrant

**[`repair/`](tools/repair/) (3 outils)**
- [`diagnose-conversation-bom.tool.ts`](tools/repair/diagnose-conversation-bom.tool.ts:1) - Diagnostic BOM
- [`repair-conversation-bom.tool.ts`](tools/repair/repair-conversation-bom.tool.ts:1) - Réparation BOM

**[`roosync/`](tools/roosync/) (10 outils)**
- Outils de synchronisation multi-machines
- Dashboard, roadmap, comparaison configs
- Gestion des décisions de synchronisation

**[`search/`](tools/search/) (5 outils)**
- [`search-tasks-semantic.tool.ts`](tools/search/search-tasks-semantic.tool.ts:1) - Recherche sémantique
- [`debug-analyze-conversation.tool.ts`](tools/search/debug-analyze-conversation.tool.ts:1) - Analyse debug

**[`storage/`](tools/storage/) (3 outils)**
- [`detect-roo-storage.tool.ts`](tools/storage/detect-roo-storage.tool.ts:1) - Détection stockage
- [`get-storage-stats.tool.ts`](tools/storage/get-storage-stats.tool.ts:1) - Statistiques stockage

**[`summary/`](tools/summary/) (4 outils)**
- [`generate-trace-summary.tool.ts`](tools/summary/generate-trace-summary.tool.ts:1) - Résumé de trace
- [`generate-cluster-summary.tool.ts`](tools/summary/generate-cluster-summary.tool.ts:1) - Résumé de grappe
- [`get-conversation-synthesis.tool.ts`](tools/summary/get-conversation-synthesis.tool.ts:1) - Synthèse LLM

**[`task/`](tools/task/) (4 outils)**
- [`get-task-tree.tool.ts`](tools/task/get-task-tree.tool.ts:1) - Arbre des tâches
- [`view-task-details.tool.ts`](tools/task/view-task-details.tool.ts:1) - Détails tâche
- [`debug-task-parsing.tool.ts`](tools/task/debug-task-parsing.tool.ts:1) - Debug parsing

**[`smart-truncation/`](tools/smart-truncation/) (5 fichiers)**
- Algorithmes de troncature intelligente
- Gradient exponentiel pour préservation optimale
- Configuration avancée

---

### [`types/`](types/) (9 fichiers)
**Définitions de types TypeScript** pour toute l'application.

#### Principaux Types

**[`tool-definitions.ts`](types/tool-definitions.ts:1)**
- Interface `Tool` standard MCP
- Types de paramètres et résultats
- Métadonnées des outils

**[`conversation.ts`](types/conversation.ts:1)**
- Structure des conversations
- Métadonnées et hiérarchie

**[`task.ts`](types/task.ts:1)**
- Structure des tâches
- Relations parent-enfant

---

### [`utils/`](utils/) (19 fichiers)
**Fonctions utilitaires** réutilisables.

**[`server-helpers.ts`](utils/server-helpers.ts:1) (134 lignes)**
- [`truncateResult()`](utils/server-helpers.ts:1) - Troncature résultats
- [`handleTouchMcpSettings()`](utils/server-helpers.ts:1) - Rechargement paramètres
- [`handleExportConversationJson()`](utils/server-helpers.ts:1) - Export JSON
- [`handleExportConversationCsv()`](utils/server-helpers.ts:1) - Export CSV

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
- **Fichiers TypeScript :** 142
- **Lignes de code :** ~40 000
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
- [Guide de Développement](../CONTRIBUTING.md) (à créer)
- [Architecture détaillée](../ARCHITECTURE.md) (à créer)

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

**Dernière mise à jour :** 14 octobre 2025  
**Version :** 1.0.8  
**Statut :** Production-ready ✅