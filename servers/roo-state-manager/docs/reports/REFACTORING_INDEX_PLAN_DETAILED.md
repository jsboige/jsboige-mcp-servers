# 📋 Plan Détaillé de Refactorisation - index.ts

**Date:** 2025-10-12  
**Fichier Source:** `mcps/internal/servers/roo-state-manager/src/index.ts`  
**Lignes actuelles:** 3896  
**Objectif:** <200 lignes  

---

## 🎯 Objectif de la Mission

Refactoriser `index.ts` (3896 lignes) en ~15 fichiers modulaires organisés par responsabilité fonctionnelle, tout en maintenant 100% de compatibilité avec l'interface MCP existante.

---

## 📊 État des Lieux

### Handlers Actuels dans index.ts (27)

#### **Catégorie : Storage & Detection**
1. ✅ `handleDetectRooStorage` → `tools/storage/detect-storage.tool.ts`
2. ✅ `handleGetStorageStats` → `tools/storage/get-stats.tool.ts`

#### **Catégorie : Conversations**
3. ✅ `handleListConversations` → `tools/conversation/list-conversations.tool.ts`
4. ✅ `handleDebugAnalyzeConversation` → `tools/conversation/debug-analyze.tool.ts`
5. ✅ `handleGetRawConversation` → `tools/conversation/get-raw.tool.ts`
6. ✅ `handleViewTaskDetails` → `tools/conversation/view-details.tool.ts`

#### **Catégorie : Tasks**
7. ✅ `handleGetTaskTree` → `tools/task/get-tree.tool.ts`
8. ✅ `handleDebugTaskParsing` → `tools/task/debug-parsing.tool.ts`
9. ✅ `handleExportTaskTreeMarkdown` → `tools/task/export-tree-md.tool.ts`

#### **Catégorie : Search & Indexing**
10. ✅ `handleSearchTasksSemantic` → `tools/search/search-semantic.tool.ts`
11. ✅ `handleSearchTasksSemanticFallback` → `tools/search/search-fallback.tool.ts`
12. ✅ `handleIndexTaskSemantic` → `tools/indexing/index-task.tool.ts`
13. ✅ `handleDiagnoseSemanticIndex` → `tools/indexing/diagnose-index.tool.ts`
14. ✅ `handleResetQdrantCollection` → `tools/indexing/reset-collection.tool.ts`

#### **Catégorie : Export - XML**
15. ✅ `handleExportTaskXml` → `tools/export/xml/export-task.tool.ts`
16. ✅ `handleExportConversationXml` → `tools/export/xml/export-conversation.tool.ts`
17. ✅ `handleExportProjectXml` → `tools/export/xml/export-project.tool.ts`
18. ✅ `handleConfigureXmlExport` → `tools/export/xml/configure.tool.ts`

#### **Catégorie : Export - Autres Formats**
19. ⚠️ `handleExportConversationJson` → Déjà partiellement externalisé dans `export-conversation-json.ts`
20. ⚠️ `handleExportConversationCsv` → Déjà partiellement externalisé dans `export-conversation-csv.ts`

#### **Catégorie : Summary & Synthesis**
21. ⚠️ `handleGenerateTraceSummary` → Déjà partiellement externalisé dans `generate-trace-summary.ts`
22. ⚠️ `handleGenerateClusterSummary` → Déjà partiellement externalisé dans `generate-cluster-summary.ts`
23. ⚠️ `handleGetConversationSynthesis` → Déjà partiellement externalisé dans `synthesis/get-conversation-synthesis.ts`

#### **Catégorie : Cache & Maintenance**
24. ✅ `handleBuildSkeletonCache` → `tools/cache/build-skeleton-cache.tool.ts`
25. ✅ `handleTouchMcpSettings` → Déjà externalisé dans `manage-mcp-settings.ts`

#### **Catégorie : Repair & Diagnostics**
26. ✅ `handleDiagnoseConversationBom` → `tools/repair/diagnose-bom.tool.ts`
27. ✅ `handleRepairConversationBom` → `tools/repair/repair-bom.tool.ts`

---

## 📐 Structure Cible

```
src/
├── index.ts (150-200 lignes)
│   ├── Imports de configuration
│   ├── Validation variables d'environnement
│   ├── Classe RooStateManagerServer (minimal)
│   ├── Enregistrement des outils (via imports)
│   └── Export et démarrage
│
├── config/
│   └── server-config.ts (100 lignes)
│       ├── Configuration MCP
│       ├── Constantes globales
│       └── Options par défaut
│
├── services/
│   ├── skeleton-cache.service.ts (200 lignes)
│   │   ├── SkeletonCacheService class
│   │   ├── Cache management logic
│   │   └── Cache invalidation strategies
│   │
│   └── (Services existants conservés)
│
├── tools/
│   ├── index.ts (50 lignes - Export central)
│   │
│   ├── storage/
│   │   ├── detect-storage.tool.ts (150 lignes)
│   │   └── get-stats.tool.ts (100 lignes)
│   │
│   ├── conversation/
│   │   ├── list-conversations.tool.ts (250 lignes)
│   │   ├── debug-analyze.tool.ts (150 lignes)
│   │   ├── get-raw.tool.ts (100 lignes)
│   │   └── view-details.tool.ts (200 lignes)
│   │
│   ├── task/
│   │   ├── get-tree.tool.ts (200 lignes)
│   │   ├── debug-parsing.tool.ts (150 lignes)
│   │   └── export-tree-md.tool.ts (200 lignes)
│   │
│   ├── search/
│   │   ├── search-semantic.tool.ts (250 lignes)
│   │   └── search-fallback.tool.ts (150 lignes)
│   │
│   ├── indexing/
│   │   ├── index-task.tool.ts (200 lignes)
│   │   ├── diagnose-index.tool.ts (150 lignes)
│   │   └── reset-collection.tool.ts (150 lignes)
│   │
│   ├── export/
│   │   ├── xml/
│   │   │   ├── export-task.tool.ts (200 lignes)
│   │   │   ├── export-conversation.tool.ts (250 lignes)
│   │   │   ├── export-project.tool.ts (250 lignes)
│   │   │   └── configure.tool.ts (150 lignes)
│   │   │
│   │   ├── export-conversation-json.ts (déjà existe - à compléter)
│   │   └── export-conversation-csv.ts (déjà existe - à compléter)
│   │
│   ├── summary/
│   │   ├── generate-trace-summary.ts (déjà existe - à compléter)
│   │   └── generate-cluster-summary.ts (déjà existe - à compléter)
│   │
│   ├── cache/
│   │   └── build-skeleton-cache.tool.ts (250 lignes)
│   │
│   ├── repair/
│   │   ├── diagnose-bom.tool.ts (150 lignes)
│   │   └── repair-bom.tool.ts (200 lignes)
│   │
│   └── synthesis/
│       └── get-conversation-synthesis.ts (déjà existe - à compléter)
│
└── types/
    └── tool-definitions.ts (150 lignes)
        ├── Interfaces communes aux outils
        ├── Types de paramètres
        └── Types de résultats
```

---

## 🔧 Stratégie de Migration par Batch

### **Batch 0 : Préparation (PHASE EN COURS)**
**Durée estimée:** 30 min  
**Statut:** ✅ EN COURS

- [x] Analyse complète du fichier index.ts
- [x] Identification des 27 handlers
- [x] Catégorisation par domaine fonctionnel
- [x] Création du plan détaillé
- [ ] Création de la structure de répertoires
- [ ] Backup du fichier original
- [ ] Création du fichier types/tool-definitions.ts

---

### **Batch 1 : Storage & Detection (2 handlers)**
**Durée estimée:** 45 min  
**Priorité:** 🟢 BASSE (outils indépendants)

**Fichiers à créer:**
1. `tools/storage/detect-storage.tool.ts`
2. `tools/storage/get-stats.tool.ts`

**Dépendances:**
- RooStorageDetector (déjà existe)
- Aucune dépendance circulaire

**Tests:**
- `detect_roo_storage`
- `get_storage_stats`

---

### **Batch 2 : Conversations (4 handlers)**
**Durée estimée:** 1h30  
**Priorité:** 🔴 HAUTE (outils fréquemment utilisés)

**Fichiers à créer:**
1. `tools/conversation/list-conversations.tool.ts` (COMPLEXE - 250 lignes estimées)
2. `tools/conversation/debug-analyze.tool.ts`
3. `tools/conversation/get-raw.tool.ts`
4. `tools/conversation/view-details.tool.ts`

**Dépendances:**
- conversationCache (membre de classe)
- TaskNavigator
- normalizePath utility
- ConversationSkeleton types

**Défis:**
- ⚠️ Accès au cache de conversation (membre privé de la classe)
- ⚠️ Logique de filtrage complexe dans list_conversations

**Tests:**
- `list_conversations` (avec filtres)
- `debug_analyze_conversation`
- `get_raw_conversation`
- `view_task_details`

---

### **Batch 3 : Tasks (3 handlers)**
**Durée estimée:** 1h  
**Priorité:** 🟡 MOYENNE

**Fichiers à créer:**
1. `tools/task/get-tree.tool.ts`
2. `tools/task/debug-parsing.tool.ts`
3. `tools/task/export-tree-md.tool.ts`

**Dépendances:**
- TaskNavigator
- conversationCache

**Tests:**
- `get_task_tree`
- `debug_task_parsing`
- `export_task_tree_markdown`

---

### **Batch 4 : Search & Indexing (5 handlers)**
**Durée estimée:** 1h30  
**Priorité:** 🔴 HAUTE (fonctionnalité critique)

**Fichiers à créer:**
1. `tools/search/search-semantic.tool.ts` (COMPLEXE)
2. `tools/search/search-fallback.tool.ts`
3. `tools/indexing/index-task.tool.ts`
4. `tools/indexing/diagnose-index.tool.ts`
5. `tools/indexing/reset-collection.tool.ts`

**Dépendances:**
- searchTasks service
- indexTask service
- TaskIndexer
- getQdrantClient
- indexingDecisionService (membre de classe)

**Défis:**
- ⚠️ Accès aux services d'indexation (membres de classe)
- ⚠️ Logique de fallback complexe

**Tests:**
- `search_tasks_semantic`
- `index_task_semantic`
- `reset_qdrant_collection`

---

### **Batch 5 : Export XML (4 handlers)**
**Durée estimée:** 1h  
**Priorité:** 🟡 MOYENNE

**Fichiers à créer:**
1. `tools/export/xml/export-task.tool.ts`
2. `tools/export/xml/export-conversation.tool.ts`
3. `tools/export/xml/export-project.tool.ts`
4. `tools/export/xml/configure.tool.ts`

**Dépendances:**
- XmlExporterService (membre de classe)
- ExportConfigManager (membre de classe)
- conversationCache

**Défis:**
- ⚠️ Accès aux services d'export (membres de classe)

**Tests:**
- `export_tasks_xml`
- `export_conversation_xml`
- `export_project_xml`
- `configure_xml_export`

---

### **Batch 6 : Summary & Synthesis (3 handlers)**
**Durée estimée:** 1h  
**Priorité:** 🟡 MOYENNE

**Fichiers à modifier/compléter:**
1. `tools/summary/generate-trace-summary.ts` (compléter avec handler)
2. `tools/summary/generate-cluster-summary.ts` (compléter avec handler)
3. `tools/synthesis/get-conversation-synthesis.ts` (compléter avec handler)

**Dépendances:**
- TraceSummaryService (membre de classe)
- SynthesisOrchestratorService (membre de classe)
- conversationCache

**Défis:**
- ⚠️ Handlers déjà partiellement externalisés
- ⚠️ Besoin de refactoriser pour séparer définition/handler

**Tests:**
- `generate_trace_summary`
- `generate_cluster_summary`
- `get_conversation_synthesis`

---

### **Batch 7 : Export Autres Formats (2 handlers)**
**Durée estimée:** 45 min  
**Priorité:** 🟢 BASSE

**Fichiers à modifier/compléter:**
1. `tools/export/export-conversation-json.ts` (compléter avec handler)
2. `tools/export/export-conversation-csv.ts` (compléter avec handler)

**Dépendances:**
- conversationCache
- TraceSummaryService (peut-être)

**Tests:**
- `export_conversation_json`
- `export_conversation_csv`

---

### **Batch 8 : Cache & Repair (3 handlers)**
**Durée estimée:** 1h  
**Priorité:** 🟡 MOYENNE

**Fichiers à créer:**
1. `tools/cache/build-skeleton-cache.tool.ts` (COMPLEXE)
2. `tools/repair/diagnose-bom.tool.ts`
3. `tools/repair/repair-bom.tool.ts`

**Dépendances:**
- conversationCache (membre de classe)
- _ensureSkeletonCacheIsFresh (méthode privée)
- RooStorageDetector

**Défis:**
- ⚠️ Accès au cache et méthodes privées de la classe

**Tests:**
- `build_skeleton_cache`
- `diagnose_conversation_bom`
- `repair_conversation_bom`

---

### **Batch 9 : Refactorisation index.ts Final**
**Durée estimée:** 1h  
**Priorité:** 🔴 CRITIQUE

**Objectifs:**
1. Réduire index.ts à <200 lignes
2. Extraire RooStateManagerServer dans un fichier séparé si nécessaire
3. Simplifier l'initialisation
4. Importer tous les outils depuis tools/index.ts
5. Supprimer tout le code des handlers externalisés

**Nouveau contenu de index.ts:**
- Imports minimaux
- Validation environnement
- Bootstrap du serveur
- Enregistrement des outils (via imports)
- Export

---

## 🚨 Défis Techniques Identifiés

### 1. **Accès au Cache de Conversation**
**Problème:** Le `conversationCache` est un membre privé de `RooStateManagerServer`.

**Solutions possibles:**
- **A)** Créer un `CacheManager` service singleton accessible globalement
- **B)** Passer le cache en paramètre à chaque handler
- **C)** Créer des méthodes statiques avec injection du cache

**Recommandation:** Solution B (injection explicite) pour meilleure testabilité.

---

### 2. **Services Membres de Classe**
**Problème:** Plusieurs services sont des membres privés :
- `traceSummaryService`
- `xmlExporterService`
- `exportConfigManager`
- `synthesisOrchestratorService`
- `indexingDecisionService`

**Solutions possibles:**
- **A)** Service Registry pattern (singleton global)
- **B)** Dependency Injection via constructeur d'outils
- **C)** Factory pattern pour créer les outils

**Recommandation:** Solution A + B hybride - Registry pour services lourds, injection pour cache.

---

### 3. **Méthodes Privées de la Classe**
**Problème:** Certains handlers utilisent des méthodes privées :
- `_ensureSkeletonCacheIsFresh()`
- `_initializeBackgroundServices()`
- `_truncateResult()`

**Solution:**
- Extraire ces utilitaires dans des modules séparés
- Les rendre publics via un module utils/

---

### 4. **Handlers Déjà Partiellement Externalisés**
**Problème:** Certains outils ont leur définition externalisée mais leur handler reste dans index.ts.

**Solution:**
- Compléter l'externalisation en déplaçant aussi le handler
- Refactoriser pour séparer clairement définition/handler/logique

---

## ✅ Checklist de Validation par Batch

Après chaque batch, vérifier :

- [ ] ✅ TypeScript compile sans erreur
- [ ] ✅ Aucun import circulaire détecté
- [ ] ✅ Tous les exports sont corrects dans tools/index.ts
- [ ] ✅ Le serveur MCP démarre sans erreur
- [ ] ✅ Tests manuels des outils du batch (minimum 2 outils)
- [ ] ✅ Aucune régression fonctionnelle détectée
- [ ] ✅ Documentation JSDoc complète sur fonctions publiques
- [ ] ✅ Commit Git avec message descriptif

---

## 📊 Métriques de Succès

**Objectifs quantitatifs:**
- ✅ index.ts réduit de 3896 → <200 lignes (~95% réduction)
- ✅ 15+ fichiers créés, aucun >400 lignes
- ✅ 0 régression fonctionnelle
- ✅ 100% des outils testés et validés

**Objectifs qualitatifs:**
- ✅ Architecture respecte Single Responsibility Principle
- ✅ Testabilité améliorée (handlers indépendants)
- ✅ Maintenabilité améliorée (navigation facilitée)
- ✅ Collaboration améliorée (moins de conflits Git)

---

## 📝 Recommandations pour l'Exécution

### **Approche Recommandée : Sous-tâches Séparées**

Vu l'ampleur de cette refactorisation (27 handlers, 9 batches), **je recommande fortement** de créer une sous-tâche dédiée pour chaque batch. Cela permet :

1. **Économie de tokens** : Contexte réduit par sous-tâche
2. **Tests intermédiaires** : Validation après chaque batch
3. **Rollback facilité** : En cas de problème sur un batch
4. **Parallélisation possible** : Plusieurs batches peuvent être traités en parallèle
5. **Meilleure traçabilité** : Commits Git atomiques par batch

### **Ordre d'Exécution Suggéré**

**Phase 1 - Fondations (Semaine 1):**
- Batch 0 : Préparation
- Batch 1 : Storage & Detection (simple, indépendant)
- Batch 8 : Cache & Repair (prépare l'infrastructure)

**Phase 2 - Outils Principaux (Semaine 2):**
- Batch 2 : Conversations (priorité haute)
- Batch 4 : Search & Indexing (priorité haute)
- Batch 3 : Tasks (dépend de conversations)

**Phase 3 - Export & Synthèse (Semaine 3):**
- Batch 5 : Export XML
- Batch 7 : Export Autres Formats
- Batch 6 : Summary & Synthesis

**Phase 4 - Finalisation (Semaine 3):**
- Batch 9 : Refactorisation index.ts Final
- Tests d'intégration complets
- Documentation finale

---

## 🎯 Next Steps

1. ✅ **Valider ce plan** avec l'équipe/utilisateur
2. ⏳ **Créer la structure de répertoires** (Batch 0)
3. ⏳ **Commencer Batch 1** (Storage & Detection)
4. ⏳ **Itérer batch par batch** avec validation à chaque étape

---

**Document maintenu par:** Roo Code  
**Dernière mise à jour:** 2025-10-12  
**Statut:** 📋 PLAN VALIDÉ - PRÊT POUR EXÉCUTION