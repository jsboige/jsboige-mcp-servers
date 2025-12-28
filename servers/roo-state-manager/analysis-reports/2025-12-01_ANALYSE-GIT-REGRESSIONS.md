# Analyse des Régressions Git - Roo State Manager
**Date :** 01 Décembre 2025
**Période analysée :** 15 derniers commits (Novembre 2025)

## 1. Synthèse Exécutive

L'analyse des 15 derniers commits sur le sous-module `mcps/internal` révèle que les régressions massives observées sont principalement dues à des changements radicaux dans l'infrastructure de test (`jest.setup.js`) et à une refonte majeure du moteur de reconstruction hiérarchique (`HierarchyReconstructionEngine.ts`).

**Causes Racines Identifiées :**
1.  **Désactivation du Mock Global `fs`** : Le commit `97093f1` a désactivé le mock global du système de fichiers, exposant tous les tests unitaires au système de fichiers réel.
2.  **Instabilité des Mocks `path`** : Le commit `75559ac` a modifié le comportement du mock `path`, introduisant potentiellement des incohérences de chemins.
3.  **Refonte Logique `HierarchyReconstructionEngine`** : Le commit `e312c9e` a introduit des validations temporelles strictes (`CHRONOLOGY ERROR`) qui invalident probablement les jeux de données de test existants.

---

## 2. Analyse Détaillée par Fichier

### A. `tests/setup/jest.setup.js` (Infrastructure de Test)

Ce fichier a subi 4 modifications majeures en 2 jours, créant une instabilité critique.

*   **Commit `97093f1` (30 Nov 22:04) - CRITIQUE**
    *   **Changement :** Le bloc `vi.mock('fs', ...)` et `vi.mock('fs/promises', ...)` a été commenté/désactivé.
    *   **Impact :** Les tests qui ne définissent pas leur propre mock `fs` (la majorité) tentent maintenant d'accéder au disque réel. Cela explique les erreurs `ENOENT` ou les comportements imprévisibles.
    *   **Citation Diff :**
        ```javascript
        +/*
         const mockFsPromises = {
           access: vi.fn().mockResolvedValue(undefined),
        ...
        +*/
        ```

*   **Commit `75559ac` (30 Nov 23:21)**
    *   **Changement :** Le mock de `path` utilise maintenant `importOriginal()` pour déléguer à l'implémentation réelle au lieu d'utiliser une implémentation mockée pure.
    *   **Impact :** Si les tests s'attendaient à des séparateurs normalisés (`/`) indépendamment de l'OS, cela peut échouer sur Windows.

*   **Commit `5a50b29` (30 Nov 19:46)**
    *   **Changement :** Introduction de `dotenv` et surcharge des variables d'environnement (`QDRANT_URL`, etc.).
    *   **Impact :** Positif pour la configuration, mais a complexifié le setup initial.

### B. `src/utils/hierarchy-reconstruction-engine.ts` (Moteur Hiérarchique)

Ce fichier a été lourdement modifié pour améliorer la précision, mais au prix de la compatibilité avec les tests existants.

*   **Commit `e312c9e` (30 Nov 20:32) - MAJEUR**
    *   **Changement 1 : Validation Temporelle Stricte**
        *   Introduction de `CHRONOLOGY ERROR` si un parent est créé après son enfant (+1s de tolérance).
        *   **Impact :** Les fixtures de test où les timestamps ne sont pas parfaitement cohérents échouent maintenant la validation parent-enfant.
    *   **Changement 2 : Gestion des Orphelins**
        *   Nouvelle logique pour invalider les parents existants si la validation échoue.
    *   **Changement 3 : Indexation des Instructions**
        *   Abandon de la concaténation du texte parent pour l'indexation.

*   **Commit `3b4da64` (30 Nov 21:25)**
    *   **Changement :** Ajout de critères de détection de racine basés sur des mots-clés ("Planifier", "Planification").
    *   **Impact :** Peut faussement identifier des tâches comme racines si elles contiennent ces mots-clés, changeant la structure de l'arbre reconstruit.

### C. `src/services/XmlParsingService.ts`

*   **État :** Aucune modification dans les 15 derniers commits (créé le 15 Sept 2025).
*   **Conclusion :** Ce service n'est pas la cause directe des régressions. Les erreurs associées sont collatérales (liées aux mocks `fs` ou à l'utilisation par le moteur hiérarchique).

---

## 3. Recommandations de Correction

1.  **Rétablir le Mock Global `fs` (Priorité Absolue)**
    *   Revert partiel du commit `97093f1` dans `jest.setup.js`.
    *   S'assurer que le mock est complet (`fs` et `fs/promises`).

2.  **Adapter les Fixtures de Test**
    *   Mettre à jour les fichiers JSON de test pour garantir que `parent.createdAt < child.createdAt` afin de passer la nouvelle validation temporelle stricte.

3.  **Stabiliser `jest.setup.js`**
    *   Arrêter les modifications incessantes sur ce fichier critique.
    *   Définir une stratégie claire : soit mock global (recommandé pour la vitesse), soit mock par fichier (plus robuste mais demande un refactoring massif).

## 4. Liste des Commits Suspects

| Hash | Auteur | Date | Fichier Impacté | Description |
|------|--------|------|-----------------|-------------|
| `97093f1` | jsboigeEpita | 30 Nov 22:04 | `jest.setup.js` | **Désactivation des mocks FS globaux** |
| `75559ac` | jsboigeEpita | 30 Nov 23:21 | `jest.setup.js` | Changement mock `path` vers implémentation réelle |
| `e312c9e` | jsboige | 30 Nov 20:32 | `Hierarchy...ts` | Validation temporelle stricte & refonte logique |
| `3b4da64` | jsboige | 30 Nov 21:25 | `Hierarchy...ts` | Nouveaux critères de détection racine |
