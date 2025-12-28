# Rapport de Ventilation des Corrections - Roo State Manager
**Date :** 30 Novembre 2025
**Statut :** Analyse Post-Réparation Infra

## 1. Synthèse des Tests (Vitest)

L'exécution globale de la suite de tests montre que l'infrastructure est fonctionnelle (les tests tournent), mais révèle des régressions fonctionnelles et des problèmes de mocks à corriger.

*   **Total Tests :** 743
*   **Passés :** 651 (87.6%)
*   **Échoués :** 61 (8.2%)
*   **Skipped :** 31 (4.2%)
*   **Fichiers Impactés :** 21 fichiers de tests

## 2. Analyse des Échecs par Catégorie

### A. Infra/Core (Tests Unitaires Bas Niveau)
*   **Problèmes :** Mocks défaillants (`path.normalize`, `path.isAbsolute`, `fs`), assertions numériques (`0 > 0`), normalisation HTML stricte.
*   **Fichiers Clés :**
    *   `tests/unit/skeleton-cache-reconstruction.test.ts`
    *   `tests/unit/hierarchy-pipeline.test.ts`
    *   `tests/unit/config/roosync-config.test.ts`
    *   `tests/unit/utils/timestamp-parsing.test.ts`

### B. Service (Logique Métier & Intégration)
*   **Problèmes :** Reconstruction hiérarchique incomplète, fixtures manquantes (`ENOENT`), validation environnement E2E (`gpt-5` vs `gpt-4o`), logique de filtrage workspace.
*   **Fichiers Clés :**
    *   `tests/integration/task-tree-integration.test.js`
    *   `tests/integration/hierarchy-real-data.test.ts`
    *   `tests/unit/extraction-contamination.test.ts`
    *   `tests/e2e/roosync-workflow.test.ts`

### C. Tools A (Actions & Fichiers)
*   **Problèmes :** Manipulation de `sync-roadmap.md` (fichier non trouvé), gestion des promesses (résolues au lieu de rejetées), rollback incomplet.
*   **Fichiers Clés :**
    *   `tests/unit/tools/roosync/apply-decision.test.ts`
    *   `tests/unit/tools/roosync/rollback-decision.test.ts`
    *   `tests/unit/tools/roosync/reject-decision.test.ts`

### D. Tools B (État & Comparaison)
*   **Problèmes :** Données mockées incorrectes (machines `undefined`), assertions de contenu strictes, calcul de statistiques.
*   **Fichiers Clés :**
    *   `tests/unit/tools/roosync/compare-config.test.ts`
    *   `tests/unit/tools/roosync/get-status.test.ts`
    *   `tests/unit/tools/roosync/get-decision-details.test.ts`

## 3. Plan de Ventilation (4 Lots)

Pour paralléliser et sécuriser les corrections, nous proposons la répartition suivante :

### 📦 Lot 1 : Infra & Core (Priorité Haute)
**Objectif :** Stabiliser le socle technique et les utilitaires.
*   Réparer les mocks globaux (`path`, `fs`) dans `vitest.config.ts` ou les setups.
*   Corriger les utilitaires de parsing (XML, Timestamp, Config).
*   Résoudre les assertions numériques basiques.

### 📦 Lot 2 : Service & Intégration
**Objectif :** Rétablir la logique métier critique (Hiérarchie, RooSync).
*   Restaurer ou mocker correctement les fixtures manquantes.
*   Corriger la logique de reconstruction hiérarchique (Phase 2).
*   Ajuster les configurations d'environnement pour les tests E2E.

### 📦 Lot 3 : Tools A (Actions)
**Objectif :** Rendre les commandes d'écriture fiables.
*   Assurer la présence et la manipulation correcte de `sync-roadmap.md`.
*   Corriger la gestion des erreurs (rejets de promesses) pour `apply`, `rollback`, `reject`.

### 📦 Lot 4 : Tools B (État)
**Objectif :** Fiabiliser les commandes de lecture.
*   Corriger les mocks de données machines pour `compare` et `status`.
*   Ajuster les assertions de contenu pour les rapports et détails.

## 4. Prochaines Étapes
1.  Valider cette ventilation.
2.  Créer les tâches pour chaque lot.
3.  Lancer les corrections itératives (Lot 1 -> Lot 2 -> Lots 3/4).