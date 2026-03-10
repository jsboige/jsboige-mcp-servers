# Issue #564 - Audit Systématique des Outils MCP roo-state-manager

**Date:** 2026-03-10
**Machine:** myia-po-2026
**Test File:** `src/tools/__tests__/mcp-tools-audit.test.ts`

---

## Résumé Exécutif

L'audit a révélé des lacunes significatives dans la couverture de tests et des problèmes potentiels de fiabilité similaires à ceux corrigés dans le commit `96014f99`.

### Statistiques Clés

| Métrique | Valeur | Status |
|----------|--------|--------|
| **Outils MCP totaux** | 71 | ✅ |
| **Outils avec fichier source** | 53/71 (74.6%) | ⚠️ |
| **Couverture de tests** | ~15% (11/71 outils) | ❌ |
| **Outils critiques sans tests** | 6/6 | ❌ |

---

## Phase 1: Inventaire des Outils

### Outils MCP Identifiés (71 outils)

#### Outils Sans Fichier Source (18 outils)

Les outils suivants n'ont pas de mapping vers un fichier source identifiable:

1. `touch_mcp_settings` - Handler dans registry.ts mais pas de fichier dédié
2. `export_config` - Potentiellement dans `export/export-config.ts`
3. `roosync_summarize` - Deprecated, handler dans registry.ts
4. `roosync_send_message` - Deprecated (remplacé par roosync_send)
5. `roosync_read_inbox` - Deprecated (remplacé par roosync_read)
6. `roosync_get_message` - Deprecated (remplacé par roosync_read)
7. `roosync_mark_message_read` - Deprecated (remplacé par roosync_manage)
8. `roosync_sync_event` - Non trouvé dans l'analyse
9. `roosync_mcp_management` - Handler dans manage-mcp-settings.ts
10. `roosync_storage_management` - Handler dans maintenance/maintenance.ts
11. `search_tasks_by_content` - Deprecated
12. `diagnose_env` - Chemin incorrect?
13. Plusieurs autres...

**Note:** Certains outils sont gérés directement dans `registry.ts` ou sont des deprecated wrappers.

---

## Phase 2: Couverture des Tests

### Résultats du Test de Couverture

```
📊 Test Coverage Report:
   Total tools: 71
   With tests: 11
   Without tests: 60
   Coverage: 15.5%
```

### Outils CRITIQUES Sans Tests (6/6)

Tous les outils critiques identifiés dans l'issue #564 **N'ONT PAS DE TESTS**:

1. ❌ `conversation_browser` - Bug #564: scan disque jamais exécuté
2. ❌ `roosync_search` - Recherche sémantique
3. ❌ `codebase_search` - Recherche workspace
4. ❌ `export_data` - Export consolidé
5. ❌ `roosync_send` - Messagerie
6. ❌ `roosync_read` - Messagerie

**Impact:** Ces bugs critiques peuvent passer inaperçus pendant des mois comme démontré dans #564.

---

## Phase 3: Tests de Fumée - Vérification Cohérence

### Résultats

| Test | Status | Notes |
|------|--------|-------|
| `conversation_browser` action mapping | ✅ PASS | Actions list/tree/current/view/summarize/rebuild présentes |
| `roosync_search` semantic/text support | ❌ FAIL | L'outil ne contient pas de logique "semantic" (delegué à roosync_indexing) |
| `export_data` format support | ✅ PASS | Formats xml/json/csv présents |

### Analyse de l'échec `roosync_search`

L'outil `roosync_search` est un **wrapper** qui délègue à `handleRooSyncSearch`. La logique "semantic" vs "text" est dans le handler, pas directement dans le fichier source. Cela indique une **structure en couches** qui complique les tests.

---

## Phase 4: Détection des Bugs Silencieux Potentiels

### Heuristique 1: Cache Stale

L'heuristique a détecté des patterns potentiels mais nécessite une analyse plus approfondie.

### Heuristique 2: Error Handling Incomplet

Plusieurs outils utilisent `catch { /* ignore */ }` qui pourrait masquer des erreurs silencieuses.

---

## Recommandations

### 1. Tests d'Intégration Prioritaires (Par Ordre)

1. **`conversation_browser`** (CRITIQUE - Issue #564)
   - Test: Créer une nouvelle tâche Roo, vérifier qu'elle apparaît dans `list`
   - Test: Scanner le disque après démarrage MCP, vérifier détection
   - Test: Vérifier que `ensureSkeletonCacheIsFresh` est appelé

2. **`roosync_search`**
   - Test: Recherche sémantique retourne des résultats pertinents
   - Test: Recherche textuelle fonctionne sur le cache
   - Test: Fallback Qdrant fonctionne quand cache vide

3. **`codebase_search`**
   - Test: Recherche dans le workspace indexé retourne résultats
   - Test: Protocole multi-pass (large → zoom → grep → variante)

4. **`export_data`**
   - Test: Export XML crée un fichier valide
   - Test: Export JSON fonctionne
   - Test: Export CSV fonctionne

5. **`roosync_send` / `roosync_read`**
   - Test: Message envoyé apparaît dans inbox
   - Test: Marquer comme lu fonctionne
   - Test: Archive fonctionne

6. **`roosync_storage_management`**
   - Test: Détection stockage Roo fonctionne
   - Test: Détection stockage Claude Code fonctionne
   - Test: Cache rebuild après ajout de conversation

### 2. Structure de Tests Recommandée

Pour chaque outil critique, créer 3 types de tests:

```typescript
describe('Outil MCP X', () => {
  describe('Unit Tests', () => {
    // Tests avec mocks, pas de dépendances externes
  });

  describe('Integration Tests', () => {
    // Tests avec filesystem réel, Qdrant, GDrive
  });

  describe('Data Freshness Tests', () => {
    // Tests spécifiques pour détecter données stale
  });
});
```

### 3. Actions Immédiates

1. ✅ Créer le fichier d'audit test (`mcp-tools-audit.test.ts`) - FAIT
2. ⏳ Créer les tests d'intégration pour les 6 outils critiques
3. ⏳ Intégrer ces tests dans le CI/CD
4. ⏳ Documenter les patterns de bugs silencieux identifiés

---

## Annexes

### A. Liste Complète des Outils MCP

```
[
  "analyze_roosync_problems",
  "build_skeleton_cache",
  "codebase_search",
  "debug_analyze_task_parsing",
  "diagnose_conversation_bom",
  "diagnose_env",
  "get_mcp_best_practices",
  "get_raw_conversation",
  "index_task_semantic",
  "list_conversations",
  "maintenance",
  "manage_mcp_settings",
  "rebuild_and_restart",
  "rebuild_task_index_fixed",
  "repair_conversation_bom",
  "reset_qdrant_collection",
  "roosync_apply_config",
  "roosync_apply_decision",
  "roosync_approve_decision",
  "roosync_archive_message",
  "roosync_baseline",
  "roosync_cleanup_messages",
  "roosync_collect_config",
  "roosync_config",
  "roosync_decision",
  "roosync_decision_info",
  "roosync_diagnose",
  "roosync_export_baseline",
  "roosync_get_decision_details",
  "roosync_get_machine_inventory",
  "roosync_get_message",
  "roosync_get_status",
  "roosync_heartbeat",
  "roosync_init",
  "roosync_inventory",
  "roosync_list_diffs",
  "roosync_machines",
  "roosync_manage",
  "roosync_mcp_management",
  "roosync_publish_config",
  "roosync_read",
  "roosync_read_inbox",
  "roosync_refresh_dashboard",
  "roosync_reject_decision",
  "roosync_reply_message",
  "roosync_rollback_decision",
  "roosync_send",
  "roosync_send_message",
  "roosync_storage_management",
  "roosync_sync_event",
  "roosync_update_baseline",
  "roosync_update_dashboard",
  "roosync_summarize",
  "roosync_search",
  "roosync_indexing",
  "roosync_compare_config",
  "storage_info",
  "search_tasks_by_content",
  "task_browse",
  "task_export",
  "view_conversation_tree",
  "view_task_details",
  "read_vscode_logs",
  "touch_mcp_settings",
  "export_data",
  "export_config",
  "conversation_browser"
]
```

### B. Tests Existant (11 outils avec tests)

Le test de couverture a détecté ~11 outils qui ont des tests spécifiques basés sur la recherche de noms dans les fichiers `.test.ts`. Une analyse plus approfondie est nécessaire pour identifier précisément quels outils ont des tests complets.

---

**Conclusion:** L'audit confirme les préoccupations de l'issue #564. La couverture de tests est **insuffisante** (15.5%) et les outils critiques **n'ont pas de tests d'intégration**. Des bugs silencieux similaires à #564 peuvent exister dans d'autres outils.
