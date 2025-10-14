# Changelog - Roo State Manager

## [Unreleased]

### Changed
- **Réparation complète de la suite de tests unitaires** : La suite de tests a été entièrement refactorisée pour être compatible avec les modules ES (ESM) TypeScript.
- **Configuration Jest** : Mise à jour de `jest.config.cjs` pour utiliser `ts-jest` avec le support ESM, incluant le mapping des modules pour une résolution correcte des imports.
- **Scripts `npm`** : Modification du script `npm run test` pour inclure les flags Node.js nécessaires (`--experimental-vm-modules`) et un script de pré-test (`test:setup`) pour la transpilation des helpers.
- **Refactoring des Tests** : Remplacement des références à `__dirname` par `import.meta.url` et importation explicite des globaux Jest (`describe`, `it`, etc.) pour se conformer aux standards ESM.
- **Dépendances** : Ajout de `ts-node`, `cross-env` et `esbuild` aux `devDependencies` pour supporter l'exécution des tests et des scripts dans un environnement TypeScript moderne.
- **Documentation (`README.md`)** : Ajout d'une section détaillant comment lancer la nouvelle suite de tests unitaires.