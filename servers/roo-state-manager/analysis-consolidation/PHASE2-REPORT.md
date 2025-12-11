# Rapport de Consolidation RooSync - Phase 2 : Unification des Services

**Date:** 2025-12-11
**Statut:** Terminé
**Tests:** Validés (tests/integration/legacy-compatibility.test.ts)

## Objectifs Réalisés

La Phase 2 visait à unifier l'API RooSync en intégrant nativement la logique non-nominative (profils) dans `RooSyncService` tout en maintenant la compatibilité avec les outils existants.

### 1. Refactoring de `RooSyncService.ts`

*   **Détection automatique de Baseline :** La méthode `compareConfig()` a été modifiée pour détecter automatiquement la présence d'une baseline non-nominative active.
    *   Si une baseline non-nominative est active et qu'aucune machine cible n'est spécifiée, le service bascule automatiquement en mode "comparaison de profils".
    *   Il utilise `NonNominativeBaselineService` pour mapper la machine courante et générer les déviations.
    *   Si aucune baseline non-nominative n'est active ou si une cible est spécifiée, le comportement legacy (`ConfigComparator`) est préservé.

*   **Mise à jour de Baseline Unifiée :** Une nouvelle méthode `updateBaseline()` a été ajoutée au service (elle manquait dans l'interface publique du service, bien que présente dans les outils).
    *   Supporte un paramètre `mode: 'profile' | 'legacy'` (défaut: 'profile').
    *   **Mode 'profile' :** Utilise l'agrégation de `NonNominativeBaselineService` pour mettre à jour ou créer des profils basés sur l'inventaire de la machine.
    *   **Mode 'legacy' :** Délègue à `BaselineService.updateBaseline` pour le comportement classique (snapshot JSON).

### 2. Refactoring de `ConfigComparator.ts`

*   Ajout de la méthode `compareWithProfiles(machineInventory, profiles)` pour permettre la comparaison directe entre un inventaire brut et une liste de `ConfigurationProfile`.
*   Cette méthode permet d'extraire les valeurs correspondantes aux catégories des profils (ex: 'roo-core', 'hardware-cpu') et de détecter les différences.

### 3. Gestion des Types

*   Résolution des incompatibilités de types entre `InventoryCollector.MachineInventory` (collecte réelle) et `NonNominativeBaseline.MachineInventory` (types stricts du module baseline).
*   Utilisation de conversions explicites et sécurisées là où nécessaire pour assurer la fluidité entre les composants legacy et nouveaux.

## Validation

Les tests d'intégration `tests/integration/legacy-compatibility.test.ts` ont été exécutés avec succès, confirmant que les modifications n'ont pas introduit de régression sur le workflow standard (`collect` -> `compare` -> `apply`).

## Prochaines Étapes (Phase 3)

*   Nettoyage des outils MCP spécifiques (`non-nominative-baseline-tools.ts`, `granular-diff.ts`).
*   Mise à jour des outils standard (`roosync_compare_config`, `roosync_update_baseline`) pour exploiter pleinement les nouvelles capacités du service unifié.
*   Suppression du code mort et des tests obsolètes.