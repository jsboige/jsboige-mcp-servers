# Plan de Migration Détaillé - Réorganisation Tests

**Date du plan** : 2025-10-02  
**Référence** : NOUVEAU-LAYOUT-TESTS.md

---

## 🎯 Vue d'Ensemble

Cette migration se fera en **8 étapes incrémentales** avec validation après chaque étape.

**Durée estimée** : 45-60 minutes  
**Fichiers concernés** : 59 fichiers de tests + configurations

---

## ⚠️ Pré-requis Avant Migration

### 1. Sauvegardes
```powershell
# Créer une branche Git dédiée
git checkout -b refactor/tests-reorganization

# Commit de l'état actuel
git add .
git commit -m "chore: state before tests reorganization"
```

### 2. Validation État Initial
```powershell
# Exécuter les tests pour avoir une baseline
cd mcps/internal/servers/roo-state-manager
npm test > pre-migration-results.log 2>&1
```

**Baseline attendue** : 14 suites passent, 166 tests passent

---

## 📋 Étape 1 : Création de la Nouvelle Structure

### Actions
Créer tous les répertoires nécessaires pour la nouvelle organisation.

### Commandes
```powershell
cd mcps/internal/servers/roo-state-manager

# Créer les répertoires unit avec sous-catégories
New-Item -ItemType Directory -Force -Path "tests/unit/services"
New-Item -ItemType Directory -Force -Path "tests/unit/utils"
New-Item -ItemType Directory -Force -Path "tests/unit/tools"
New-Item -ItemType Directory -Force -Path "tests/unit/gateway"

# Créer les répertoires integration avec sous-catégories
New-Item -ItemType Directory -Force -Path "tests/integration/hierarchy"
New-Item -ItemType Directory -Force -Path "tests/integration/storage"
New-Item -ItemType Directory -Force -Path "tests/integration/api"

# Créer les répertoires e2e avec sous-catégories
New-Item -ItemType Directory -Force -Path "tests/e2e/scenarios"

# Créer répertoires helpers et archive
New-Item -ItemType Directory -Force -Path "tests/helpers"
New-Item -ItemType Directory -Force -Path "tests/archive"
New-Item -ItemType Directory -Force -Path "tests/archive/manual"
New-Item -ItemType Directory -Force -Path "tests/archive/compiled"
```

### Validation
```powershell
# Vérifier que tous les répertoires sont créés
Get-ChildItem -Path "tests" -Directory -Recurse | Select-Object FullName
```

**Résultat attendu** : 14 nouveaux répertoires créés

---

## 📋 Étape 2 : Archivage des Fichiers Compilés

### Actions
Déplacer tous les fichiers `.js`, `.d.ts`, `.js.map`, `.d.ts.map` vers l'archive.

### Commandes
```powershell
# Déplacer les fichiers compilés vers archive/compiled
Get-ChildItem -Path "tests" -Recurse -Include "*.test.js","*.test.d.ts","*.test.js.map","*.test.d.ts.map" | 
    ForEach-Object { Move-Item $_.FullName -Destination "tests/archive/compiled/" -Force }
```

### Créer README.md d'explication
```powershell
@"
# Archive - Fichiers Compilés

Ces fichiers sont générés automatiquement par TypeScript lors du build.

## Raison de l'archivage
- Pollution du répertoire source
- Générés par \`npm run build:tests\`
- Doivent être dans \`build/tests/\` uniquement

## Date d'archivage
2025-10-02

## Action recommandée
Ces fichiers peuvent être supprimés en toute sécurité.
"@ | Out-File -FilePath "tests/archive/compiled/README.md" -Encoding UTF8
```

### Validation
```powershell
# Vérifier qu'il ne reste aucun .js ou .d.ts dans tests/ (hors archive)
Get-ChildItem -Path "tests" -Recurse -Include "*.test.js","*.test.d.ts" -Exclude "archive" | Measure-Object
```

**Résultat attendu** : 0 fichiers

---

## 📋 Étape 3 : Migration des Tests depuis src/

### Actions
Déplacer les tests de `src/` vers leur nouvel emplacement.

### 3.1 - Tests à Archiver (manuels/vides)
```powershell
# Tests manuels/scripts de src/ vers archive/manual
Move-Item "src/test-detail-levels.ts" -Destination "tests/archive/manual/detail-levels-manual.ts"
Move-Item "src/test-enhanced-integration.ts" -Destination "tests/archive/manual/enhanced-integration-manual.ts"
Move-Item "src/test-hierarchy-fix.ts" -Destination "tests/archive/manual/hierarchy-fix-manual.ts"
Move-Item "src/test-hierarchy-limited.ts" -Destination "tests/archive/manual/hierarchy-limited-manual.ts"
Move-Item "src/test-hierarchy-reconstruction.ts" -Destination "tests/archive/manual/hierarchy-reconstruction-manual.ts"
Move-Item "src/test-strategy-refactoring.js" -Destination "tests/archive/manual/strategy-refactoring-manual.js"
```

### 3.2 - Tests d'intégration API
```powershell
# index.test.ts vers integration/api
Move-Item "src/index.test.ts" -Destination "tests/integration/api/unified-gateway-index.test.ts"
```

### 3.3 - Tests unitaires Gateway
```powershell
# UnifiedApiGateway.test.ts vers unit/gateway
Move-Item "src/__tests__/UnifiedApiGateway.test.ts" -Destination "tests/unit/gateway/unified-api-gateway.test.ts"
```

### Créer README.md pour archive/manual
```powershell
@"
# Archive - Tests Manuels

Ces fichiers étaient des scripts de tests manuels ou des fichiers obsolètes.

## Contenu
- \`*-manual.ts\` : Scripts d'exploration/débogage manuel
- Fichiers vides ou non utilisés

## Raison de l'archivage
- Pas de vrais tests automatisés
- Utilisés pour débogage ponctuel
- Remplacés par les vrais tests dans tests/

## Date d'archivage
2025-10-02

## Action recommandée
Conserver pour référence historique.
"@ | Out-File -FilePath "tests/archive/manual/README.md" -Encoding UTF8
```

### Validation
```powershell
# Vérifier qu'il ne reste aucun fichier test dans src/
Get-ChildItem -Path "src" -Recurse -Include "*.test.ts","test-*.ts","test-*.js" | Measure-Object
```

**Résultat attendu** : 0 fichiers

---

## 📋 Étape 4 : Catégorisation des Tests Unit

### Actions
Déplacer les tests de la racine `tests/` vers `tests/unit/` avec sous-catégories.

### 4.1 - Tests Utils
```powershell
Move-Item "tests/bom-handling.test.ts" -Destination "tests/unit/utils/bom-handling.test.ts"
Move-Item "tests/timestamp-parsing.test.ts" -Destination "tests/unit/utils/timestamp-parsing.test.ts"
Move-Item "tests/versioning.test.ts" -Destination "tests/unit/utils/versioning.test.ts"
Move-Item "tests/utils/hierarchy-inference.test.ts" -Destination "tests/unit/utils/hierarchy-inference.test.ts"
```

### 4.2 - Tests Services
```powershell
Move-Item "tests/task-instruction-index.test.ts" -Destination "tests/unit/services/task-instruction-index.test.ts"
Move-Item "tests/task-navigator.test.ts" -Destination "tests/unit/services/task-navigator.test.ts"
Move-Item "tests/xml-parsing.test.ts" -Destination "tests/unit/services/xml-parsing.test.ts"

# Déplacer aussi ceux déjà dans tests/services/
Move-Item "tests/services/indexing-decision.test.ts" -Destination "tests/unit/services/indexing-decision.test.ts"
Move-Item "tests/services/synthesis.service.test.ts" -Destination "tests/unit/services/synthesis.service.test.ts"
Move-Item "tests/services/task-indexer.test.ts" -Destination "tests/unit/services/task-indexer.test.ts"

# Archiver le test vide
Move-Item "tests/services/anti-leak-protections.test.ts" -Destination "tests/archive/anti-leak-protections.test.ts.TODO"
```

### 4.3 - Tests Tools (Outils MCP)
```powershell
Move-Item "tests/manage-mcp-settings.test.ts" -Destination "tests/unit/tools/manage-mcp-settings.test.ts"
Move-Item "tests/read-vscode-logs.test.ts" -Destination "tests/unit/tools/read-vscode-logs.test.ts"
Move-Item "tests/view-conversation-tree.test.ts" -Destination "tests/unit/tools/view-conversation-tree.test.ts"
```

### 4.4 - Tests déjà dans tests/unit/
```powershell
# Ces tests sont déjà bien placés, on vérifie juste
Get-ChildItem -Path "tests/unit" -Filter "*.test.ts" | Select-Object Name
```

### Validation
```powershell
# Compter les tests dans tests/unit/
Get-ChildItem -Path "tests/unit" -Recurse -Filter "*.test.ts" | Measure-Object
```

**Résultat attendu** : ~20 fichiers dans tests/unit/

---

## 📋 Étape 5 : Catégorisation des Tests Integration

### Actions
Déplacer les tests vers `tests/integration/` avec sous-catégories.

### 5.1 - Tests Hiérarchie
```powershell
Move-Item "tests/hierarchy-real-data.test.ts" -Destination "tests/integration/hierarchy/real-data.test.ts"
Move-Item "tests/hierarchy-reconstruction-engine.test.ts" -Destination "tests/integration/hierarchy/reconstruction-engine.test.ts"
Move-Item "tests/hierarchy-reconstruction.test.ts" -Destination "tests/integration/hierarchy/full-pipeline.test.ts"
```

### 5.2 - Tests Storage
```powershell
Move-Item "tests/roo-storage-detector.test.ts" -Destination "tests/integration/storage/detector.test.ts"
```

### 5.3 - Tests API/Gateway
```powershell
Move-Item "tests/integration.test.ts" -Destination "tests/integration/api/unified-gateway.test.ts"

# Renommer et déplacer task-tree-integration
Move-Item "tests/task-tree-integration.test.js" -Destination "tests/integration/api/task-tree.test.js"
```

### 5.4 - Tests déjà dans tests/integration/
```powershell
# indexing-validation.test.js : renommer en .ts si possible, sinon laisser tel quel
# (On garde le .js pour le moment car peut contenir du code JS spécifique)
```

### Validation
```powershell
# Compter les tests dans tests/integration/
Get-ChildItem -Path "tests/integration" -Recurse -Filter "*.test.*" | Measure-Object
```

**Résultat attendu** : ~7 fichiers dans tests/integration/

---

## 📋 Étape 6 : Catégorisation des Tests E2E

### Actions
Réorganiser les tests E2E dans `tests/e2e/scenarios/`.

### Commandes
```powershell
# Déplacer les tests E2E vers scenarios/
Move-Item "tests/e2e/semantic-search.test.ts" -Destination "tests/e2e/scenarios/semantic-search.test.ts"
Move-Item "tests/e2e/task-navigation.test.ts" -Destination "tests/e2e/scenarios/task-navigation.test.ts"
Move-Item "tests/e2e/placeholder.test.ts" -Destination "tests/e2e/scenarios/placeholder.test.ts"

# Déplacer aussi proxy.ts et e2e-runner.ts s'ils existent
if (Test-Path "tests/e2e/proxy.ts") {
    Move-Item "tests/e2e/proxy.ts" -Destination "tests/e2e/scenarios/proxy.ts"
}

# e2e-runner doit rester à la racine de tests/ (c'est un helper)
if (Test-Path "tests/e2e/e2e-runner.ts") {
    Move-Item "tests/e2e/e2e-runner.ts" -Destination "tests/helpers/e2e-runner.ts"
}
```

### Validation
```powershell
# Vérifier les tests dans tests/e2e/scenarios/
Get-ChildItem -Path "tests/e2e/scenarios" -Filter "*.test.ts" | Measure-Object
```

**Résultat attendu** : 3 fichiers dans tests/e2e/scenarios/

---

## 📋 Étape 7 : Nettoyage et Helpers

### Actions
Organiser les fichiers de support et configuration.

### 7.1 - Déplacer les anciens répertoires vides
```powershell
# Supprimer le répertoire tests/services/ s'il est vide
if ((Get-ChildItem "tests/services" -ErrorAction SilentlyContinue).Count -eq 0) {
    Remove-Item "tests/services" -Recurse -Force
}

# Supprimer le répertoire tests/utils/ s'il est vide
if ((Get-ChildItem "tests/utils" -ErrorAction SilentlyContinue).Count -eq 0) {
    Remove-Item "tests/utils" -Recurse -Force
}
```

### 7.2 - Créer README pour tests/helpers
```powershell
@"
# Test Helpers

Utilitaires partagés pour faciliter l'écriture et l'exécution des tests.

## Contenu

### \`e2e-runner.ts\`
Runner personnalisé pour les tests end-to-end.

## Usage

\`\`\`typescript
import { someHelper } from '../helpers/test-utils';
\`\`\`

## Ajout de nouveaux helpers

1. Créer le fichier dans ce répertoire
2. Documenter l'usage
3. Exporter depuis un index si nécessaire
"@ | Out-File -FilePath "tests/helpers/README.md" -Encoding UTF8
```

### 7.3 - Créer README principal pour tests/
```powershell
@"
# Organisation des Tests - roo-state-manager

Ce répertoire contient tous les tests du projet, organisés par type.

## Structure

\`\`\`
tests/
├── unit/              # Tests unitaires rapides et isolés
│   ├── services/      # Tests des services
│   ├── utils/         # Tests des utilitaires
│   ├── tools/         # Tests des outils MCP
│   └── gateway/       # Tests du gateway API
├── integration/       # Tests d'intégration multi-modules
│   ├── hierarchy/     # Tests de la hiérarchie complète
│   ├── storage/       # Tests de détection et storage
│   └── api/           # Tests de l'API gateway
├── e2e/              # Tests end-to-end complets
│   └── scenarios/    # Scénarios utilisateur complets
├── fixtures/         # Données de test (conservées)
├── config/           # Configuration Jest
├── helpers/          # Utilitaires de tests
└── archive/          # Tests obsolètes/désactivés
\`\`\`

## Conventions

### Nomenclature
- Tous les tests : \`*.test.ts\`
- Pas de \`test-*.ts\`

### Placement des nouveaux tests

**Test unitaire** (< 100ms, isolé, mocké) :
\`\`\`bash
tests/unit/{service|utils|tools|gateway}/mon-test.test.ts
\`\`\`

**Test d'intégration** (100ms-5s, multi-modules) :
\`\`\`bash
tests/integration/{hierarchy|storage|api}/mon-test.test.ts
\`\`\`

**Test end-to-end** (> 5s, scénario complet) :
\`\`\`bash
tests/e2e/scenarios/mon-scenario.test.ts
\`\`\`

## Exécution

\`\`\`bash
# Tous les tests
npm test

# Tests unitaires uniquement
npm run test:unit

# Tests d'intégration
npm run test:integration

# Tests end-to-end
npm run test:e2e

# Avec coverage
npm run test:coverage
\`\`\`

## Voir aussi

- [TESTS-ORGANIZATION.md](TESTS-ORGANIZATION.md) - Documentation complète
- [NOUVEAU-LAYOUT-TESTS.md](NOUVEAU-LAYOUT-TESTS.md) - Justification du design
"@ | Out-File -FilePath "tests/README.md" -Encoding UTF8
```

### Validation
```powershell
# Vérifier que tous les README sont créés
Get-ChildItem -Path "tests" -Recurse -Filter "README.md" | Select-Object FullName
```

**Résultat attendu** : 3 README.md (tests/, tests/helpers/, tests/archive/)

---

## 📋 Étape 8 : Mise à Jour des Configurations

### 8.1 - Mettre à jour jest.config.js
```powershell
# Sauvegarder l'ancien
Copy-Item "jest.config.js" -Destination "jest.config.js.backup"
```

**Modifications à apporter manuellement dans jest.config.js** :
```javascript
// AVANT
testMatch: [
  '**/tests/**/*.test.ts'
],

testPathIgnorePatterns: [
  '/node_modules/',
  '/build/'
]

// APRÈS
testMatch: [
  '<rootDir>/tests/**/*.test.ts',
  '<rootDir>/tests/**/*.test.js'  // Pour task-tree.test.js
],

testPathIgnorePatterns: [
  '/node_modules/',
  '/build/',
  '/tests/archive/',  // AJOUTÉ : Exclure l'archive
  '/__tests__/'  // AJOUTÉ : Éviter confusion avec ancien pattern
]
```

### 8.2 - Mettre à jour package.json
```powershell
# Sauvegarder l'ancien
Copy-Item "package.json" -Destination "package.json.backup"
```

**Ajouter ces scripts dans package.json** :
```json
{
  "scripts": {
    "test:unit": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --testPathPattern=tests/unit --runInBand",
    "test:integration": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --testPathPattern=tests/integration --runInBand",
    "test:e2e": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --testPathPattern=tests/e2e --runInBand",
    "test:watch": "jest --watch"
  }
}
```

### 8.3 - Mettre à jour tests/tsconfig.json
```powershell
# Sauvegarder l'ancien si existe
if (Test-Path "tests/tsconfig.json") {
    Copy-Item "tests/tsconfig.json" -Destination "tests/tsconfig.json.backup"
}
```

**Contenu de tests/tsconfig.json** :
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "../build/tests",
    "rootDir": ".",
    "types": ["jest", "node"]
  },
  "include": [
    "**/*.ts"
  ],
  "exclude": [
    "archive",
    "node_modules"
  ]
}
```

### Validation
```powershell
# Vérifier que les backups sont créés
Get-ChildItem -Path "." -Filter "*.backup" | Select-Object Name
```

**Résultat attendu** : 2-3 fichiers .backup

---

## 📋 Étape 9 : Mise à Jour des Imports

### Actions
Mettre à jour tous les imports relatifs qui ont changé de chemin.

### Script de Détection
```powershell
# Chercher tous les imports vers fixtures dans les tests
Get-ChildItem -Path "tests" -Recurse -Filter "*.test.ts" | 
    ForEach-Object {
        $content = Get-Content $_.FullName -Raw
        if ($content -match "from\s+['\"]\.\./(fixtures|config|helpers)") {
            Write-Host "Imports potentiellement à mettre à jour : $($_.FullName)"
        }
    }
```

### Imports à Vérifier

**Pour les tests déplacés vers sous-répertoires** :
- `../fixtures/` → Peut nécessiter `../../fixtures/` ou `../../../fixtures/`
- `./jest.setup` → `../../jest.setup` ou `../../../jest.setup`

**Exemple de correction** :
```typescript
// AVANT (dans tests/hierarchy-reconstruction.test.ts)
import { fixtures } from './fixtures/hierarchy-test-data';

// APRÈS (dans tests/integration/hierarchy/full-pipeline.test.ts)
import { fixtures } from '../../fixtures/hierarchy-test-data';
```

### Action Manuelle Requise
⚠️ **Cette étape nécessite une revue manuelle** car les imports dépendent de la profondeur du fichier.

**Méthode recommandée** :
1. Compiler avec `npm run build:tests`
2. Noter les erreurs de compilation
3. Corriger les imports un par un
4. Re-compiler jusqu'à succès

---

## 📋 Étape 10 : Validation Post-Migration

### 10.1 - Recompilation Complète
```powershell
# Nettoyer le build
Remove-Item -Path "build" -Recurse -Force -ErrorAction SilentlyContinue

# Recompiler tout
npm run build
npm run build:tests
```

### 10.2 - Exécution des Tests
```powershell
# Exécuter la suite complète
npm test > post-migration-results.log 2>&1
```

### 10.3 - Comparaison des Résultats
```powershell
# Comparer avec le baseline
Write-Host "=== AVANT MIGRATION ===" -ForegroundColor Yellow
Select-String -Path "pre-migration-results.log" -Pattern "Test Suites:|Tests:"

Write-Host "`n=== APRÈS MIGRATION ===" -ForegroundColor Green
Select-String -Path "post-migration-results.log" -Pattern "Test Suites:|Tests:"
```

### Critères de Succès
✅ **Même nombre de tests** : 166 tests  
✅ **Même nombre de suites qui passent** : 14 suites  
✅ **Pas de nouveaux échecs** : Seuls les échecs Jest ESM connus  
✅ **Build réussi** : Aucune erreur TypeScript  

### 10.4 - Validation de la Structure
```powershell
# Vérifier la structure finale
Get-ChildItem -Path "tests" -Directory | Select-Object Name, @{N='Fichiers';E={(Get-ChildItem $_.FullName -Recurse -Filter "*.test.*").Count}}
```

**Structure attendue** :
```
Name            Fichiers
----            --------
unit            ~20
integration     ~7
e2e             ~3
fixtures        0 (répertoires de données)
config          0 (config files)
helpers         0-1 (utilitaires)
archive         ~8 (obsolètes)
```

---

## 📋 Étape 11 : Commit et Documentation

### 11.1 - Git Status
```powershell
git status
```

### 11.2 - Ajout des Changements
```powershell
# Ajouter tous les changements
git add .

# Vérifier ce qui sera commité
git status
```

### 11.3 - Commit de la Migration
```powershell
git commit -m "refactor(tests): reorganize test structure

BREAKING CHANGE: Tests relocated for better organization

- Moved all tests from src/ to tests/
- Categorized into unit/integration/e2e
- Archived compiled files (.js/.d.ts) 
- Updated Jest configuration
- Added test:unit, test:integration, test:e2e scripts

Tests: 166 passing (same as before)
Suites: 14 passing (same as before)
"
```

### 11.4 - Créer Tag
```powershell
git tag -a "tests-reorganization-v1" -m "Tests reorganization completed"
```

---

## 🔄 Plan de Rollback

En cas de problème, voici comment revenir en arrière.

### Option 1 : Rollback Git (Recommandé)
```powershell
# Revenir au commit avant la migration
git reset --hard HEAD~1

# Ou revenir au tag
git reset --hard <commit-hash-avant-migration>
```

### Option 2 : Restauration des Backups
```powershell
# Restaurer les configurations
Copy-Item "jest.config.js.backup" -Destination "jest.config.js" -Force
Copy-Item "package.json.backup" -Destination "package.json" -Force
Copy-Item "tests/tsconfig.json.backup" -Destination "tests/tsconfig.json" -Force

# Puis revenir à l'état Git
git checkout -- .
```

---

## 📊 Checklist de Migration

Utiliser cette checklist pendant l'exécution :

- [ ] Étape 1 : Création structure ✅
- [ ] Étape 2 : Archivage fichiers compilés ✅
- [ ] Étape 3 : Migration tests src/ ✅
- [ ] Étape 4 : Catégorisation tests unit ✅
- [ ] Étape 5 : Catégorisation tests integration ✅
- [ ] Étape 6 : Catégorisation tests e2e ✅
- [ ] Étape 7 : Nettoyage et helpers ✅
- [ ] Étape 8 : Mise à jour configurations ✅
- [ ] Étape 9 : Mise à jour imports ✅
- [ ] Étape 10 : Validation post-migration ✅
- [ ] Étape 11 : Commit et documentation ✅

---

## 🎓 Leçons et Bonnes Pratiques

### Ce qui a Bien Fonctionné
- Structure claire par type de test
- Archivage plutôt que suppression
- Validation incrémentale
- Documentation au fur et à mesure

### Points d'Attention
- Imports relatifs peuvent casser facilement
- Compiler après chaque groupe de déplacements
- Garder les fixtures accessibles
- Ne pas toucher aux fichiers de config Jest pendant les déplacements

### Pour Futures Migrations
- Toujours créer une branche dédiée
- Tester après chaque étape
- Documenter les décisions
- Garder des backups

---

**Prochaine étape** : Exécuter la migration (Phase 2.4)