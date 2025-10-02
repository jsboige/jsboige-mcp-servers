# Archive de Scripts de Debug

Ce répertoire contient les scripts de debug et de test temporaires utilisés pendant le développement et la correction du système de matching hiérarchique.

## Contexte

Ces scripts ont été créés pendant la mission critique de correction du matching hiérarchique via TDD avec exact-trie (janvier 2025).

## Contenu

### Scripts d'extraction et de test
- `extract-newtask-example.cjs` - Extraction d'exemples de newTask depuis les fichiers UI
- `find-matching-newtask.cjs` - Recherche de correspondances entre instructions parent/enfant
- `test-extraction-pipeline.cjs` - Test du pipeline d'extraction complet
- `test-full-pipeline.cjs` - Test du pipeline hiérarchique complet

### Scripts de validation
- `test-hierarchy-reconstruction.js` - Tests de reconstruction hiérarchique
- `test-hierarchy-inference.js` - Tests d'inférence hiérarchique
- `test-hierarchy-manually.cjs` - Tests manuels de hiérarchie
- `test-production-hierarchy.js` - Tests sur données de production
- `test-real-tasks.js` - Tests sur tâches réelles

### Scripts de diagnostic
- `diagnose-qdrant.js` - Diagnostic de l'indexation Qdrant
- `debug-test.js` - Tests de débogage généraux
- `manual-hierarchy-validation.js` - Validation manuelle de hiérarchie

### Scripts de démo
- `demo-phase2-complete.js` - Démo Phase 2 complète
- `demo-phase2-final.js` - Démo Phase 2 finale

### Tests obsolètes
- `controlled-hierarchy-reconstruction.test.ts` - Test avec hiérarchie contrôlée (remplacé par fixtures réelles)
- Autres tests unitaires et d'intégration obsolètes

## Résolution finale

Le matching hiérarchique a été corrigé avec succès en :
1. Remplaçant l'implémentation manuelle de RadixTree par la librairie `exact-trie`
2. Corrigeant la normalisation des instructions pour uniformiser parent et enfant
3. Utilisant le strict prefix matching avec `trie.getWithCheckpoints()`
4. Créant des fixtures de test locales (`tests/fixtures/real-tasks/`)

## Tests validés

Le test principal `hierarchy-reconstruction.test.ts` passe maintenant avec succès :
- ✅ Phase 1: Extraction de 30 instructions depuis le parent
- ✅ Phase 2: Matching exact trouvé (bc93a6f7 → ac8aa7b4)
- ✅ Méthode de résolution: `radix_tree_exact`

Ces scripts sont conservés pour référence historique mais ne sont plus nécessaires pour le fonctionnement normal du système.