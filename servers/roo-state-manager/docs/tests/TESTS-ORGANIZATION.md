# Guide d'Organisation des Tests - roo-state-manager

**Version** : 1.0  
**Date** : 2025-10-02  
**Statut** : Structure cible documentée, migration à effectuer

---

## 📋 Table des Matières

1. [Vue d'Ensemble](#vue-densemble)
2. [Structure Actuelle vs Cible](#structure-actuelle-vs-cible)
3. [Conventions de Tests](#conventions-de-tests)
4. [Organisation par Type](#organisation-par-type)
5. [Exécution des Tests](#exécution-des-tests)
6. [Ajout de Nouveaux Tests](#ajout-de-nouveaux-tests)
7. [Fixtures et Données de Test](#fixtures-et-données-de-test)
8. [Configuration](#configuration)
9. [Maintenance](#maintenance)
10. [Migration](#migration)

---

## 🎯 Vue d'Ensemble

### Philosophie

Les tests de `roo-state-manager` sont organisés selon une **classification par type** plutôt que par module. Cette approche facilite :

✅ **Navigation intuitive** : Trouver un type de test rapidement  
✅ **Exécution ciblée** : Runner uniquement les tests pertinents  
✅ **Maintenance** : Comprendre l'objectif d'un test à son emplacement  
✅ **Performance** : Éviter d'exécuter les tests lents inutilement  

### Statistiques

| Métrique | Valeur Actuelle |
|----------|-----------------|
| **Fichiers de tests** | 59 |
| **Tests individuels** | 435 |
| **Suites de tests** | 139 |
| **Tests qui passent** | 166/166 (code métier) |
| **Taille totale** | ~0.41 MB |

---

## 🗂️ Structure Actuelle vs Cible

### Structure Actuelle (État)

```
roo-state-manager/
├── src/
│   ├── index.test.ts                    ❌ À déplacer
│   ├── test-*.ts (7 fichiers)           ❌ À archiver/déplacer
│   └── __tests__/
│       └── UnifiedApiGateway.test.ts    ❌ À déplacer
└── tests/
    ├── *.test.ts (29 fichiers)          ⚠️ À catégoriser
    ├── *.test.js/.d.ts (18 fichiers)    ❌ À nettoyer
    ├── unit/ (7 tests)                  ✅ Bon
    ├── integration/ (1 test)            ✅ Bon
    ├── e2e/ (3 tests)                   ✅ Bon
    ├── services/ (4 tests)              ⚠️ À déplacer vers unit/
    ├── utils/ (1 test)                  ⚠️ À déplacer vers unit/
    ├── fixtures/ (données)              ✅ Parfait
    └── config/ (setup Jest)             ✅ Parfait
```

### Structure Cible (Après Migration)

```
roo-state-manager/
├── src/                                 # Code métier uniquement
│   └── (AUCUN fichier de test)
└── tests/
    ├── unit/                            # Tests unitaires
    │   ├── services/                    # ~10 tests
    │   ├── utils/                       # ~7 tests
    │   ├── tools/                       # ~3 tests
    │   └── gateway/                     # ~1 test
    ├── integration/                     # Tests d'intégration
    │   ├── hierarchy/                   # ~3 tests
    │   ├── storage/                     # ~1 test
    │   └── api/                         # ~3 tests
    ├── e2e/                            # Tests end-to-end
    │   └── scenarios/                   # ~3 tests
    ├── fixtures/                        # Données de test
    │   ├── controlled-hierarchy/
    │   ├── real-tasks/
    │   └── ui-snippets/
    ├── config/                          # Configuration Jest
    │   ├── globalSetup.ts
    │   └── globalTeardown.ts
    ├── helpers/                         # Utilitaires de tests
    │   └── (utilitaires partagés)
    ├── archive/                         # Tests obsolètes
    │   ├── manual/                      # Scripts manuels
    │   └── compiled/                    # Fichiers .js/.d.ts
    └── README.md                        # Ce guide (simplifié)
```

---

## 📐 Conventions de Tests

### Nomenclature

✅ **Standard** : `*.test.ts`  
❌ **À éviter** : `test-*.ts`, `*-test.ts`, `*.spec.ts`

**Exemples** :
```
✅ hierarchy-reconstruction.test.ts
✅ task-navigator.test.ts
❌ test-hierarchy.ts
❌ hierarchy-test.ts
```

### Structure d'un Fichier de Test

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ServiceToTest } from '../../../src/services/ServiceToTest';

describe('ServiceToTest', () => {
  let service: ServiceToTest;

  beforeEach(() => {
    // Setup avant chaque test
    service = new ServiceToTest();
  });

  afterEach(() => {
    // Cleanup après chaque test
    jest.clearAllMocks();
  });

  describe('methodName', () => {
    it('should do something when condition', () => {
      // Arrange
      const input = 'test-input';

      // Act
      const result = service.methodName(input);

      // Assert
      expect(result).toBe('expected-output');
    });

    it('should throw error when invalid input', () => {
      // Arrange & Act & Assert
      expect(() => service.methodName(null))
        .toThrow('Invalid input');
    });
  });
});
```

### Patterns AAA (Arrange-Act-Assert)

**Toujours structurer les tests selon** :

1. **Arrange** : Préparer les données et les mocks
2. **Act** : Exécuter la fonction testée
3. **Assert** : Vérifier le résultat

---

## 🧩 Organisation par Type

### Tests Unitaires (`tests/unit/`)

**Critères d'un test unitaire** :
- ✅ Teste **une seule unité** (fonction, méthode, classe)
- ✅ **Isolé** : Pas de dépendances externes (I/O, réseau, DB)
- ✅ **Rapide** : < 100ms par test
- ✅ **Déterministe** : Même résultat à chaque exécution
- ✅ **Mocks** : Utilise des mocks pour les dépendances

**Sous-catégories** :

#### `unit/services/` - Tests de Services Métier
Services qui orchestrent la logique métier.

**Exemples** :
- `task-instruction-index.test.ts` : Index d'instructions
- `task-navigator.test.ts` : Navigation entre tâches
- `xml-parsing.test.ts` : Parsing XML
- `indexing-decision.test.ts` : Décisions d'indexation
- `synthesis.service.test.ts` : Service de synthèse
- `task-indexer.test.ts` : Indexation des tâches

#### `unit/utils/` - Tests d'Utilitaires
Fonctions pures et utilitaires sans état.

**Exemples** :
- `bom-handling.test.ts` : Gestion BOM UTF-8
- `timestamp-parsing.test.ts` : Parsing de timestamps
- `versioning.test.ts` : Gestion des versions
- `hierarchy-inference.test.ts` : Inférence hiérarchique

#### `unit/tools/` - Tests d'Outils MCP
Outils exposés via l'interface MCP.

**Exemples** :
- `manage-mcp-settings.test.ts` : Gestion settings MCP
- `read-vscode-logs.test.ts` : Lecture logs VSCode
- `view-conversation-tree.test.ts` : Vue arbre conversations

#### `unit/gateway/` - Tests Gateway API
Tests de l'API Gateway unifiée.

**Exemples** :
- `unified-api-gateway.test.ts` : Gateway API unifié

### Tests d'Intégration (`tests/integration/`)

**Critères d'un test d'intégration** :
- ✅ Teste **plusieurs modules ensemble**
- ✅ **Intégration réelle** : Utilise de vraies dépendances (fichiers, etc.)
- ✅ **Modéré** : 100ms - 5s par test
- ✅ **Coordination** : Teste les interactions entre modules
- ⚠️ **État** : Peut nécessiter setup/cleanup d'état

**Sous-catégories** :

#### `integration/hierarchy/` - Tests Hiérarchie
Tests du moteur de reconstruction hiérarchique complet.

**Exemples** :
- `reconstruction-engine.test.ts` : Moteur de reconstruction
- `full-pipeline.test.ts` : Pipeline complet hiérarchie
- `real-data.test.ts` : Tests avec données réelles

#### `integration/storage/` - Tests Storage
Tests de détection et accès au storage.

**Exemples** :
- `detector.test.ts` : Détection du storage Roo

#### `integration/api/` - Tests API
Tests d'intégration de l'API complète.

**Exemples** :
- `unified-gateway.test.ts` : Gateway API complet
- `unified-gateway-index.test.ts` : Tests d'index
- `task-tree.test.ts` : Arbre de tâches

### Tests End-to-End (`tests/e2e/`)

**Critères d'un test E2E** :
- ✅ Teste **scénario utilisateur complet**
- ✅ **Environnement réel** : Proche de la production
- ✅ **Lent** : > 5s par test acceptable
- ✅ **Bout en bout** : De l'API au résultat final
- ⚠️ **Flaky** : Peut être instable (réseau, timing)

**Sous-catégories** :

#### `e2e/scenarios/` - Scénarios Utilisateur
Scénarios complets d'utilisation.

**Exemples** :
- `semantic-search.test.ts` : Recherche sémantique complète
- `task-navigation.test.ts` : Navigation entre tâches
- `placeholder.test.ts` : Test placeholder

---

## ▶️ Exécution des Tests

### Commandes Disponibles

#### Tous les Tests
```bash
npm test
```
**Utilisation** : Validation complète avant commit/release

#### Tests Unitaires Seulement
```bash
npm run test:unit
```
**Utilisation** : Développement rapide, feedback immédiat

#### Tests d'Intégration
```bash
npm run test:integration
```
**Utilisation** : Validation avant merge, CI/CD

#### Tests End-to-End
```bash
npm run test:e2e
```
**Utilisation** : Validation finale, smoke tests

#### Mode Watch (Développement)
```bash
npm run test:watch
```
**Utilisation** : TDD, développement continu

#### Avec Coverage
```bash
npm run test:coverage
```
**Utilisation** : Analyse de couverture de code

### Exécution Ciblée

#### Un Fichier Spécifique
```bash
npm test -- tests/unit/services/task-navigator.test.ts
```

#### Un Pattern
```bash
npm test -- tests/unit/services/*.test.ts
```

#### Une Suite Spécifique
```bash
npm test -- --testNamePattern="HierarchyEngine"
```

### Options Utiles

```bash
# Verbose (détails complets)
npm test -- --verbose

# Bail (arrêter au premier échec)
npm test -- --bail

# No cache
npm test -- --no-cache

# Update snapshots
npm test -- --updateSnapshot
```

---

## ➕ Ajout de Nouveaux Tests

### Où Placer un Nouveau Test ?

Utilise cet arbre de décision :

```
┌─ Mon test utilise-t-il des mocks pour TOUTES les dépendances ?
│
├─ OUI → Test Unitaire
│   │
│   ├─ C'est un service métier ? → tests/unit/services/mon-test.test.ts
│   ├─ C'est un utilitaire pur ? → tests/unit/utils/mon-test.test.ts
│   ├─ C'est un outil MCP ? → tests/unit/tools/mon-test.test.ts
│   └─ C'est le gateway ? → tests/unit/gateway/mon-test.test.ts
│
└─ NON → Teste-t-il plusieurs modules ensemble ?
    │
    ├─ OUI → Test d'Intégration
    │   │
    │   ├─ Concerne la hiérarchie ? → tests/integration/hierarchy/mon-test.test.ts
    │   ├─ Concerne le storage ? → tests/integration/storage/mon-test.test.ts
    │   └─ Concerne l'API ? → tests/integration/api/mon-test.test.ts
    │
    └─ NON → C'est un scénario utilisateur complet ?
        │
        └─ OUI → Test E2E
            └─ tests/e2e/scenarios/mon-scenario.test.ts
```

### Template de Nouveau Test

#### Template Unit

```typescript
// tests/unit/services/my-service.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { MyService } from '../../../src/services/MyService';
import { DependencyMock } from '../../helpers/mocks';

describe('MyService', () => {
  let service: MyService;
  let mockDependency: DependencyMock;

  beforeEach(() => {
    mockDependency = new DependencyMock();
    service = new MyService(mockDependency);
  });

  describe('myMethod', () => {
    it('should return expected result when valid input', () => {
      // Arrange
      const input = { value: 'test' };
      mockDependency.setResponse('mocked-result');

      // Act
      const result = service.myMethod(input);

      // Assert
      expect(result).toBe('expected-result');
      expect(mockDependency.wasCalledWith(input)).toBe(true);
    });

    it('should throw error when invalid input', () => {
      // Arrange
      const invalidInput = { value: '' };

      // Act & Assert
      expect(() => service.myMethod(invalidInput))
        .toThrow('Invalid input');
    });
  });
});
```

#### Template Integration

```typescript
// tests/integration/hierarchy/my-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { HierarchyEngine } from '../../../src/utils/hierarchy-reconstruction-engine';
import { TaskStorage } from '../../../src/utils/roo-storage-detector';
import path from 'path';
import fs from 'fs';

describe('Hierarchy Integration - MyFeature', () => {
  let engine: HierarchyEngine;
  let storage: TaskStorage;
  const testDataPath = path.join(__dirname, '../../fixtures/test-data');

  beforeAll(async () => {
    // Setup with real dependencies
    storage = new TaskStorage(testDataPath);
    engine = new HierarchyEngine(storage);
    await engine.initialize();
  });

  afterAll(async () => {
    // Cleanup
    await engine.cleanup();
  });

  it('should reconstruct hierarchy from real data', async () => {
    // Arrange
    const taskId = 'test-task-id';

    // Act
    const result = await engine.reconstructHierarchy(taskId);

    // Assert
    expect(result).toBeDefined();
    expect(result.depth).toBeGreaterThan(0);
    expect(result.children).toHaveLength(2);
  });
});
```

#### Template E2E

```typescript
// tests/e2e/scenarios/my-scenario.test.ts
import { describe, it, expect } from '@jest/globals';
import { UnifiedApiGateway } from '../../../src/gateway/UnifiedApiGateway';

describe('E2E Scenario - User Workflow', () => {
  let gateway: UnifiedApiGateway;

  beforeAll(async () => {
    // Setup real environment
    gateway = new UnifiedApiGateway({
      // Real config
    });
    await gateway.initialize();
  });

  afterAll(async () => {
    await gateway.shutdown();
  });

  it('should complete full user workflow', async () => {
    // Arrange - User starts with a task
    const taskId = await gateway.createTask({
      title: 'User Task',
      content: 'Test content'
    });

    // Act 1 - User searches for the task
    const searchResult = await gateway.searchTasks('User Task');
    expect(searchResult.results).toContain(taskId);

    // Act 2 - User retrieves the task details
    const taskDetails = await gateway.getTaskDetails(taskId);
    expect(taskDetails.title).toBe('User Task');

    // Act 3 - User updates the task
    await gateway.updateTask(taskId, {
      content: 'Updated content'
    });

    // Assert - Final state is correct
    const updatedTask = await gateway.getTaskDetails(taskId);
    expect(updatedTask.content).toBe('Updated content');
  });
});
```

---

## 📦 Fixtures et Données de Test

### Structure des Fixtures

```
tests/fixtures/
├── controlled-hierarchy/      # Hiérarchies contrôlées pour tests
│   ├── task-id-1/
│   │   ├── api_conversation_history.json
│   │   ├── task_metadata.json
│   │   └── ui_messages.json
│   └── ...
├── real-tasks/               # Tâches réelles anonymisées
│   ├── task-id-2/
│   └── ...
└── ui-snippets/              # Extraits UI pour tests
    ├── snippet-1-head.txt
    ├── snippet-1-tail.txt
    └── index.json
```

### Utilisation des Fixtures

```typescript
import path from 'path';
import fs from 'fs';

// Chemin relatif depuis le fichier de test
const fixturePath = path.join(__dirname, '../../fixtures/controlled-hierarchy/task-id-1');

// Charger les données
const apiHistory = JSON.parse(
  fs.readFileSync(path.join(fixturePath, 'api_conversation_history.json'), 'utf-8')
);

const taskMetadata = JSON.parse(
  fs.readFileSync(path.join(fixturePath, 'task_metadata.json'), 'utf-8')
);
```

### Bonnes Pratiques Fixtures

✅ **Immutables** : Ne jamais modifier les fixtures dans les tests  
✅ **Minimal** : Fixtures aussi petits que possible  
✅ **Réalistes** : Basés sur de vraies données (anonymisées)  
✅ **Documentés** : Chaque fixture a un but clair  
✅ **Versionnés** : Fixtures commités avec le code  

---

## ⚙️ Configuration

### Jest Configuration (`jest.config.js`)

**Configuration actuelle** :
```javascript
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  
  // Pattern de test
  testMatch: [
    '**/tests/**/*.test.ts'
  ],
  
  // Exclusions
  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/'
  ],
  
  // Setup
  setupFilesAfterEnv: ['./tests/setup-env.ts'],
  globalSetup: '<rootDir>/tests/config/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/config/globalTeardown.ts',
  
  // Performance
  maxWorkers: 1,
  testTimeout: 30000,
  workerIdleMemoryLimit: "1GB"
};
```

**Configuration cible (après migration)** :
```javascript
export default {
  // ... (même config de base)
  
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.test.js'  // Pour quelques .js
  ],
  
  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/',
    '/tests/archive/',  // AJOUTÉ
    '/__tests__/'       // AJOUTÉ
  ]
};
```

### TypeScript Configuration (`tests/tsconfig.json`)

**Configuration cible** :
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

### Scripts NPM (`package.json`)

**Scripts actuels** :
```json
{
  "scripts": {
    "test": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --runInBand",
    "test:coverage": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --coverage --runInBand",
    "test:hierarchy": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --runInBand tests/hierarchy-reconstruction-engine.test.ts"
  }
}
```

**Scripts cibles (à ajouter)** :
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

---

## 🔧 Maintenance

### Ajout de Nouveaux Tests

1. **Identifier le type** : Unitaire, Intégration, ou E2E ?
2. **Choisir l'emplacement** : Selon l'arbre de décision
3. **Créer le fichier** : Utiliser le template approprié
4. **Écrire les tests** : Suivre les conventions AAA
5. **Exécuter localement** : `npm test -- path/to/new-test.test.ts`
6. **Vérifier la couverture** : `npm run test:coverage`

### Refactoring de Tests

**Quand refactorer ?** :
- Tests deviennent trop lents
- Tests deviennent fragiles (flaky)
- Tests dupliquent du code
- Tests ne suivent plus les conventions

**Comment refactorer ?** :
1. Isoler le test à refactorer
2. S'assurer qu'il passe avant refactoring
3. Refactorer par petites étapes
4. Re-exécuter après chaque étape
5. Commit quand tout passe

### Nettoyage Régulier

**Tous les 3 mois** :
- ❌ Identifier les tests skip ou obsolètes
- 📊 Analyser la couverture de code
- 🐌 Identifier les tests lents
- 🔄 Refactorer les tests fragiles
- 📁 Archiver les tests non pertinents

### Archivage

**Critères d'archivage** :
- Test skip depuis > 6 mois
- Fonctionnalité supprimée
- Test redondant avec un autre
- Test de débogage temporaire

**Process d'archivage** :
```bash
# Déplacer vers archive
mv tests/unit/old-test.test.ts tests/archive/old-test.test.ts.DEPRECATED

# Documenter la raison
echo "# Deprecated: Reason here" > tests/archive/old-test.test.ts.DEPRECATED.md

# Commit
git add tests/archive/
git commit -m "chore(tests): archive old-test (reason)"
```

---

## 🚀 Migration

### État Actuel

La migration physique **N'EST PAS encore effectuée**.

**Livrables disponibles** :
- ✅ Audit complet : `AUDIT-TESTS-LAYOUT.md`
- ✅ Design cible : `NOUVEAU-LAYOUT-TESTS.md`
- ✅ Plan de migration : `MIGRATION-PLAN-TESTS.md`
- ✅ Script automatisé : `scripts/migrate-tests.ps1`
- ✅ Rapport d'avancement : `RAPPORT-AVANCEMENT-REORGANISATION.md`

### Quand Migrer ?

**Indicateurs pour migrer** :
- ✅ Baseline de tests établie
- ✅ Branche Git dédiée créée
- ✅ Plan validé par l'équipe
- ⏰ Temps disponible : ~30-45 minutes
- 👥 Équipe prête pour corrections imports

### Comment Migrer ?

#### Option 1 : Script Automatisé (Recommandé)

```powershell
# 1. Simulation (dry-run)
cd mcps/internal/servers/roo-state-manager
pwsh -File scripts/migrate-tests.ps1 -DryRun

# 2. Validation simulation
# Vérifier la sortie, pas d'erreurs

# 3. Exécution réelle
pwsh -File scripts/migrate-tests.ps1

# 4. Corrections manuelles
# Corriger les imports relatifs si nécessaire

# 5. Build et validation
npm run build:tests
npm test

# 6. Commit
git add .
git commit -m "refactor(tests): complete reorganization"
```

#### Option 2 : Manuel (Étapes)

Suivre le plan détaillé dans `MIGRATION-PLAN-TESTS.md` :
- Étape 1-7 : Déplacements de fichiers
- Étape 8 : Mises à jour configurations
- Étape 9 : Corrections imports
- Étape 10-11 : Validation et commit

### Après Migration

**Checklist post-migration** :
- [ ] Tous les tests passent (`npm test`)
- [ ] Configurations à jour (jest.config.js, package.json)
- [ ] README.md à jour
- [ ] Imports relatifs corrigés
- [ ] Documentation à jour
- [ ] Commit et tag Git

---

## 📚 Références

### Documents de Ce Projet

- [`AUDIT-TESTS-LAYOUT.md`](./AUDIT-TESTS-LAYOUT.md) - Audit complet de l'état actuel
- [`NOUVEAU-LAYOUT-TESTS.md`](./NOUVEAU-LAYOUT-TESTS.md) - Design et justification de la structure cible
- [`MIGRATION-PLAN-TESTS.md`](./MIGRATION-PLAN-TESTS.md) - Plan de migration détaillé en 11 étapes
- [`TEST-SUITE-COMPLETE-RESULTS.md`](./TEST-SUITE-COMPLETE-RESULTS.md) - Résultats de validation des tests
- [`RAPPORT-AVANCEMENT-REORGANISATION.md`](./RAPPORT-AVANCEMENT-REORGANISATION.md) - État d'avancement

### Scripts Utiles

- [`scripts/audit-tests.ps1`](./scripts/audit-tests.ps1) - Audit automatisé de l'arborescence
- [`scripts/migrate-tests.ps1`](./scripts/migrate-tests.ps1) - Migration automatisée
- [`scripts/run-tests.ps1`](./scripts/run-tests.ps1) - Exécution des tests

### Standards Externes

- [Jest Best Practices](https://jestjs.io/docs/getting-started)
- [Testing Trophy](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- [AAA Pattern](https://www.thoughtworks.com/insights/blog/coding-practices/coding-habits-data-scientists)

---

## ❓ FAQ

### Q: Pourquoi séparer unit/integration/e2e ?

**R:** Pour optimiser l'exécution des tests. Les tests unitaires sont rapides (< 100ms), on peut les lancer souvent. Les tests E2E sont lents (> 5s), on les lance avant release uniquement.

### Q: Dois-je toujours mocker les dépendances en unit ?

**R:** Oui pour les tests unitaires. C'est la définition même. Si tu utilises de vraies dépendances, c'est un test d'intégration.

### Q: Puis-je avoir des sous-catégories dans unit/ ?

**R:** Oui, c'est même recommandé. Exemple : `unit/services/hierarchy/`, `unit/utils/parsing/`, etc.

### Q: Que faire des tests .js (JavaScript) ?

**R:** Les convertir en .ts si possible. Sinon, les laisser en .js et mettre à jour `testMatch` dans `jest.config.js`.

### Q: Comment gérer les tests flaky ?

**R:** 
1. Identifier la cause (timing, état partagé, réseau)
2. Augmenter les timeouts si timing
3. Mieux isoler si état partagé
4. Mocker si réseau
5. En dernier recours : `.retry(3)`

### Q: Puis-je skip un test temporairement ?

**R:** Oui avec `.skip`, mais documente pourquoi et crée une issue pour le réactiver.

```typescript
it.skip('should do something - TODO: Fix flakiness #123', () => {
  // Test temporairement désactivé
});
```

### Q: Comment tester du code asynchrone ?

**R:** Utilise `async/await` :

```typescript
it('should fetch data asynchronously', async () => {
  const result = await service.fetchData();
  expect(result).toBeDefined();
});
```

### Q: Quelle couverture de code viser ?

**R:** 
- **Unitaires** : 80-90% (facile car isolés)
- **Intégration** : 60-70% (plus complexe)
- **E2E** : 40-50% (scénarios critiques uniquement)

---

**Version** : 1.0  
**Dernière mise à jour** : 2025-10-02  
**Mainteneur** : Équipe roo-state-manager