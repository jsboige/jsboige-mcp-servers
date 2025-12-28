# Rapport d'Analyse Différentielle des Échecs (Cycle 2)
**Date :** 30 Novembre 2025
**Contexte :** Suite à la réparation du mock `path`, analyse des 43 erreurs restantes pour ventilation par agent.

## Synthèse Globale

*   **Total Tests Échoués :** 43
*   **Total Tests Passés :** 686
*   **Suites en Échec :** 15

Les erreurs se concentrent principalement sur le parsing XML (régression majeure ou mock manquant), la logique de hiérarchie, et les outils RooSync (Status/Config).

## Ventilation par Agent

### 1. Agent `myia-po-2024` (Infra/Core) - 8 Erreurs
Responsable des problèmes d'infrastructure, de mocks système (fs), de performance et de modules manquants.

*   **`tests/unit/services/BaselineService.test.ts` (1 erreur)**
    *   `Error: Cannot find module '../../src/services/BaselineService'`
    *   **Action :** Vérifier l'existence du fichier source ou corriger le chemin d'import dans le test.
*   **`tests/unit/skeleton-cache-reconstruction.test.ts` (1 erreur)**
    *   `expected 0 to be greater than 0` (Performance measurement)
    *   **Action :** Vérifier pourquoi la mesure de performance retourne 0 (mock de `performance.now()` ?).
*   **`tests/unit/workspace-filtering-diagnosis.test.ts` (3 erreurs)**
    *   Échecs sur le comptage des tâches et l'analyse du potentiel hiérarchique.
    *   **Action :** Vérifier l'accès aux fixtures ou au système de fichiers simulé pour ce test de diagnostic.
*   **`tests/unit/utils/timestamp-parsing.test.ts` (3 erreurs)**
    *   `Error: ENOENT: no such file or directory` et Spy non appelé.
    *   **Action :** Corriger les mocks `fs` (volatility ?) pour ces tests utilitaires.

### 2. Agent `myia-po-2026` (Service/Logique) - 24 Erreurs
Responsable de la logique métier pure : Parsing XML, Hiérarchie, Synthèse. C'est le plus gros bloc d'erreurs.

*   **`tests/unit/services/xml-parsing.test.ts` (13 erreurs)**
    *   Tous les patterns de parsing échouent (`expected [] to have a length of X but got +0`).
    *   **Action :** Le service de parsing XML semble inopérant dans l'environnement de test. Vérifier l'initialisation du parser ou ses dépendances.
*   **`tests/unit/utils/xml-parsing.test.ts` (2 erreurs)**
    *   Erreurs similaires sur les utilitaires XML (Array format, Truncation).
    *   **Action :** Lié au point précédent.
*   **`tests/unit/hierarchy-pipeline.test.ts` (4 erreurs)**
    *   Problèmes de normalisation HTML entities, préfixes, et résolution stricte.
    *   **Action :** Ajuster la logique de normalisation et de résolution de hiérarchie.
*   **`tests/integration/hierarchy-real-data.test.ts` (2 erreurs)**
    *   Taux de reconstruction incorrect (16% vs 100%) et profondeur incorrecte.
    *   **Action :** Debugger la reconstruction sur les données réelles (fixtures).
*   **`tests/integration/task-tree-integration.test.js` (1 erreur)**
    *   `analyze relationships` échoue.
    *   **Action :** Vérifier l'intégration de l'arbre des tâches.
*   **`tests/e2e/synthesis.e2e.test.ts` (2 erreurs)**
    *   Modèles LLM incorrects (`gpt-5-mini` vs `gpt-4o-mini`) et versions incorrectes.
    *   **Action :** Mettre à jour les attentes des tests ou la configuration par défaut.
*   **`tests/unit/utils/message-extraction-coordinator.test.ts` (1 erreur)**
    *   Nombre d'extracteurs incorrect (7 vs 6).
    *   **Action :** Mettre à jour le test pour refléter l'ajout d'un nouvel extracteur (probablement récent).

### 3. Agent `myia-ai-01` (Tools État) - 9 Erreurs
Responsable des outils de lecture d'état RooSync (Config, Status, Compare).

*   **`tests/unit/config/roosync-config.test.ts` (2 erreurs)**
    *   Validation de configuration invalide échoue (retourne un objet au lieu de null).
    *   **Action :** Durcir la validation de `tryLoadRooSyncConfig`.
*   **`tests/unit/tools/roosync/compare-config.test.ts` (4 erreurs)**
    *   Problèmes de détection de machine par défaut et de typage des différences.
    *   **Action :** Corriger la logique de fallback sur `machineId` et le format de retour de `compare_config`.
*   **`tests/unit/tools/roosync/get-status.test.ts` (3 erreurs)**
    *   Statut `diverged` au lieu de `synced`, liste de machines incomplète.
    *   **Action :** Vérifier le calcul de statut et l'agrégation des machines.

### 4. Agent `myia-web1` (Tools Action) - 2 Erreurs
Responsable des workflows E2E et des actions RooSync.

*   **`tests/e2e/roosync-workflow.test.ts` (2 erreurs)**
    *   Machine non trouvée dans le dashboard et échec du DryRun.
    *   **Action :** Vérifier le setup du dashboard mocké pour les tests E2E et la simulation du DryRun.

## Priorités Recommandées

1.  **URGENT (myia-po-2026) :** Réparer `xml-parsing`. C'est une fonctionnalité centrale qui cause 15 erreurs à elle seule.
2.  **HAUT (myia-po-2024) :** Fixer `BaselineService` (module manquant) pour débloquer les tests dépendants.
3.  **MOYEN (myia-ai-01) :** Stabiliser les outils RooSync (`get-status`, `compare-config`) pour la fiabilité des opérations de sync.
4.  **MOYEN (myia-po-2026) :** Corriger la logique de hiérarchie (`hierarchy-pipeline`).
