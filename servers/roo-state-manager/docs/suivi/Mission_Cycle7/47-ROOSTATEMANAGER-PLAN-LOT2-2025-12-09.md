# PLANIFICATION LOT 2 : Outils de Recherche Sémantique et Indexation

**Date :** 2025-12-09
**Statut :** Planifié
**Responsable :** Roo

## 1. Objectif du Lot 2

Ce lot se concentre sur la validation et la consolidation des outils liés à la recherche sémantique et à l'indexation vectorielle (Qdrant). Ces outils sont critiques pour la capacité de Roo à retrouver des informations pertinentes dans l'historique des tâches.

## 2. Périmètre (Outils 6 à 10)

| # | Outil | Source | Test Existant | Complexité | Priorité |
|---|---|---|---|---|---|
| 6 | `search_tasks_by_content` | `src/tools/search/search-semantic.tool.ts` | ✅ `search-by-content.test.ts` | Moyenne | Haute |
| 7 | `search_tasks_semantic_fallback` | `src/tools/search/search-fallback.tool.ts` | ⚠️ Indirect | Faible | Moyenne |
| 8 | `index_task_semantic` | `src/tools/indexing/index-task.tool.ts` | ⚠️ Service only | Moyenne | Haute |
| 9 | `diagnose_semantic_index` | `src/tools/indexing/diagnose-index.tool.ts` | ❌ Manquant | Faible | Basse |
| 10 | `reset_qdrant_collection` | `src/tools/indexing/reset-collection.tool.ts` | ❌ Manquant | Faible | Critique |

## 3. Analyse Détaillée et Plan d'Action

### 3.1. `search_tasks_by_content`
*   **État :** Bien testé unitairement.
*   **Action :**
    *   Vérifier la couverture des cas limites (ex: Qdrant down, OpenAI down).
    *   S'assurer que le mock de `TaskIndexer` est robuste.

### 3.2. `search_tasks_semantic_fallback`
*   **État :** Testé indirectement via le test principal de recherche.
*   **Action :**
    *   Créer un test unitaire dédié `tests/unit/tools/search/search-fallback.test.ts` pour isoler la logique de recherche textuelle.
    *   Vérifier que le fallback est bien déclenché en cas d'erreur sémantique.

### 3.3. `index_task_semantic`
*   **État :** Logique métier testée dans `task-indexer.test.ts`, mais pas l'outil lui-même.
*   **Action :**
    *   Créer `tests/unit/tools/indexing/index-task.test.ts`.
    *   Mocker le service `TaskIndexer` pour vérifier l'appel correct depuis l'outil.

### 3.4. `diagnose_semantic_index`
*   **État :** Aucun test spécifique.
*   **Action :**
    *   Créer `tests/unit/tools/indexing/diagnose-index.test.ts`.
    *   Vérifier le format de sortie du diagnostic.

### 3.5. `reset_qdrant_collection`
*   **État :** Aucun test spécifique. Opération destructrice.
*   **Action :**
    *   Créer `tests/unit/tools/indexing/reset-collection.test.ts`.
    *   **CRITIQUE :** Vérifier que la demande de confirmation (si elle existe) est bien gérée ou que l'outil est sécurisé.

## 4. Stratégie de Test

*   **Mocks :** Utilisation intensive de `vi.mock` pour `QdrantClient`, `OpenAI` et `TaskIndexer`.
*   **Isolation :** Chaque outil doit être testé indépendamment de l'infrastructure réelle (pas d'appels réseau réels).
*   **Robustesse :** Tester systématiquement les cas d'erreur (timeout, service indisponible).

## 5. Calendrier Prévisionnel

1.  **Jour 1 :** `search_tasks_by_content` (Revue) & `search_tasks_semantic_fallback` (Création test).
2.  **Jour 1 :** `index_task_semantic` (Création test).
3.  **Jour 2 :** `diagnose_semantic_index` & `reset_qdrant_collection` (Création tests).
4.  **Jour 2 :** Validation globale et rapport.

## 6. Risques et Mitigations

*   **Risque :** Dépendance forte aux mocks Qdrant/OpenAI qui pourraient diverger de la réalité.
*   **Mitigation :** S'appuyer sur les tests d'intégration existants (`tests/integration`) pour valider le comportement réel périodiquement.
