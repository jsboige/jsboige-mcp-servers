# Conception du Nouveau Layout de Tests - roo-state-manager

**Date de conception** : 2025-10-02  
**Auteur** : Analyse et réorganisation systématique

---

## 🎯 Objectifs de la Réorganisation

### Problèmes Actuels Identifiés
1. **Dispersion** : 59 fichiers répartis entre `src/` et `tests/`
2. **Pollution** : 18 fichiers compilés (.js, .d.ts) dans `tests/`
3. **Manque de catégorisation** : 29 fichiers à la racine de `tests/`
4. **Nomenclature mixte** : `test-*.ts` vs `*.test.ts`
5. **Fichier vide** : `anti-leak-protections.test.ts`

### Objectifs
✅ **Clarté** : Structure intuitive par type de test  
✅ **Maintenabilité** : Faciliter l'ajout de nouveaux tests  
✅ **Performance** : Exécution ciblée par catégorie  
✅ **Standards** : Suivre les best practices Jest/TypeScript  

---

## 📋 Checkpoint SDDD 1 : Best Practices Jest

### Recherche dans le Projet

**Configuration Jest actuelle** (`jest.config.js`) :
```javascript
testMatch: [
  '**/tests/**/*.test.ts'
]

testPathIgnorePatterns: [
  '/node_modules/',
  '/build/'
]
```

### Standards Jest Identifiés

1. **Nomenclature** : `*.test.ts` est le standard Jest
2. **testMatch** : Actuellement limité à `tests/**/*.test.ts`
3. **Séparation build** : Les fichiers compilés doivent être exclus

### Best Practices Applicables

| Practice | Description | Applicable ? |
|----------|-------------|--------------|
| **Co-location** | Tests près du code (`src/**/__tests__/`) | ❌ Non adapté (MCP server) |
| **Séparation complète** | Tous les tests dans `tests/` | ✅ Oui (déjà partiellement fait) |
| **Catégorisation** | `unit/`, `integration/`, `e2e/` | ✅ Oui (structure partielle existe) |
| **Nomenclature uniforme** | `*.test.ts` uniquement | ✅ Oui (à standardiser) |
| **Fixtures séparés** | `fixtures/` dédié | ✅ Oui (déjà bien fait) |
| **Build séparé** | Pas de .js/.d.ts dans source | ✅ Oui (à nettoyer) |

---

## 🏗️ Nouvelle Structure Proposée

### Architecture Cible

```
mcps/internal/servers/roo-state-manager/
├── src/
│   └── (code métier uniquement, AUCUN test)
├── tests/
│   ├── unit/
│   │   ├── services/          # Tests de services
│   │   ├── utils/             # Tests d'utilitaires
│   │   ├── tools/             # Tests d'outils MCP
│   │   └── models/            # Tests de modèles
│   ├── integration/
│   │   ├── hierarchy/         # Tests hiérarchie complète
│   │   ├── storage/           # Tests détection/storage
│   │   └── api/               # Tests API gateway
│   ├── e2e/
│   │   ├── scenarios/         # Scénarios end-to-end
│   │   └── mcp-tools/         # Tests outils MCP complets
│   ├── fixtures/              # Données de test (CONSERVÉ tel quel)
│   │   ├── controlled-hierarchy/
│   │   ├── real-tasks/
│   │   └── ui-snippets/
│   ├── config/                # Configuration Jest (CONSERVÉ)
│   │   ├── globalSetup.ts
│   │   └── globalTeardown.ts
│   ├── helpers/               # Utilitaires de tests
│   │   ├── test-utils.ts
│   │   └── mock-factories.ts
│   └── archive/               # Tests obsolètes/désactivés
│       └── README.md          # Explication des archivages
└── build/                     # Fichiers compilés (NON commité)
    └── tests/                 # Tests compilés (séparés)
```

### Principes de Catégorisation

#### 📦 `tests/unit/` - Tests Unitaires
**Critères** :
- Teste **une seule unité** (fonction, classe, service)
- **Pas de dépendances** externes (mocks)
- **Rapide** (< 100ms par test)
- **Isolé** (pas d'I/O, pas de réseau)

**Exemples** :
- `extraction-contamination.test.ts` → `unit/utils/extraction-contamination.test.ts`
- `indexing-decision.test.ts` → `unit/services/indexing-decision.test.ts`
- `hierarchy-inference.test.ts` → `unit/utils/hierarchy-inference.test.ts`

#### 🔗 `tests/integration/` - Tests d'Intégration
**Critères** :
- Teste **plusieurs modules ensemble**
- Peut utiliser **vraies dépendances** (fichiers, DB)
- **Modéré** (100ms - 5s par test)
- **Coordonné** (ordre peut importer)

**Exemples** :
- `hierarchy-reconstruction-engine.test.ts` → `integration/hierarchy/reconstruction-engine.test.ts`
- `hierarchy-reconstruction.test.ts` → `integration/hierarchy/full-pipeline.test.ts`
- `integration.test.ts` → `integration/api/unified-gateway.test.ts`

#### 🎬 `tests/e2e/` - Tests End-to-End
**Critères** :
- Teste **scénario complet** utilisateur
- Utilise **environnement réel** (presque)
- **Lent** (> 5s par test)
- **Bout en bout** (API → Storage → Résultat)

**Exemples** :
- `semantic-search.test.ts` → `e2e/scenarios/semantic-search.test.ts`
- `task-navigation.test.ts` → `e2e/scenarios/task-navigation.test.ts`

---

## 🗂️ Justification des Choix

### Pourquoi Séparation Complète (tests/ séparé) ?

✅ **Pour ce projet** :
1. **MCP Server** : Séparation claire code métier / tests
2. **Déjà partiellement fait** : Structure `tests/` existe
3. **Fixtures volumineux** : Mieux isolés du code
4. **Build simplifié** : Pas de tests dans `build/src/`

❌ **Pas de co-location car** :
- Compliquerait la structure du serveur MCP
- Fixtures ne seraient pas bien placés
- Build/dist serait pollué

### Pourquoi Ces 3 Catégories ?

**Unit** : Tests rapides, exécutés fréquemment  
**Integration** : Tests de confiance, exécutés avant commit  
**E2E** : Tests de validation, exécutés avant release  

### Sous-Catégorisation dans unit/ et integration/

**Avantages** :
- Navigation intuitive (par domaine métier)
- Exécution ciblée possible
- Maintenance facilitée

**Exemples** :
```bash
# Tester seulement les services
npm test -- tests/unit/services

# Tester seulement la hiérarchie
npm test -- tests/integration/hierarchy
```

---

## 🔄 Mapping Ancien → Nouveau

### Tests à Déplacer depuis `src/`

| Ancien | Nouveau | Catégorie |
|--------|---------|-----------|
| `src/index.test.ts` | `tests/integration/api/unified-gateway.test.ts` | Integration (API) |
| `src/__tests__/UnifiedApiGateway.test.ts` | `tests/unit/gateway/unified-api-gateway.test.ts` | Unit (Gateway) |
| `src/test-detail-levels.ts` | `tests/archive/manual/detail-levels-manual.ts` | Archive (manuel) |
| `src/test-enhanced-integration.ts` | `tests/archive/manual/enhanced-integration-manual.ts` | Archive (vide) |
| `src/test-hierarchy-fix.ts` | `tests/archive/manual/hierarchy-fix-manual.ts` | Archive (manuel) |
| `src/test-hierarchy-limited.ts` | `tests/archive/manual/hierarchy-limited-manual.ts` | Archive (vide) |
| `src/test-hierarchy-reconstruction.ts` | `tests/archive/manual/hierarchy-reconstruction-manual.ts` | Archive (vide) |
| `src/test-strategy-refactoring.js` | `tests/archive/manual/strategy-refactoring-manual.js` | Archive (JS) |

### Tests à Catégoriser depuis `tests/` (racine)

| Ancien | Nouveau | Raison |
|--------|---------|--------|
| `bom-handling.test.ts` | `tests/unit/utils/bom-handling.test.ts` | Utilitaire isolé |
| `manage-mcp-settings.test.ts` | `tests/unit/tools/manage-mcp-settings.test.ts` | Outil MCP |
| `read-vscode-logs.test.ts` | `tests/unit/tools/read-vscode-logs.test.ts` | Outil MCP |
| `roo-storage-detector.test.ts` | `tests/integration/storage/detector.test.ts` | Intégration FS |
| `task-instruction-index.test.ts` | `tests/unit/services/task-instruction-index.test.ts` | Service |
| `task-navigator.test.ts` | `tests/unit/services/task-navigator.test.ts` | Service |
| `timestamp-parsing.test.ts` | `tests/unit/utils/timestamp-parsing.test.ts` | Utilitaire |
| `versioning.test.ts` | `tests/unit/utils/versioning.test.ts` | Utilitaire |
| `view-conversation-tree.test.ts` | `tests/unit/tools/view-conversation-tree.test.ts` | Outil MCP |
| `xml-parsing.test.ts` | `tests/unit/services/xml-parsing.test.ts` | Service |
| `hierarchy-real-data.test.ts` | `tests/integration/hierarchy/real-data.test.ts` | Intégration |
| `hierarchy-reconstruction-engine.test.ts` | `tests/integration/hierarchy/reconstruction-engine.test.ts` | Intégration |
| `hierarchy-reconstruction.test.ts` | `tests/integration/hierarchy/full-pipeline.test.ts` | Intégration |
| `integration.test.ts` | `tests/integration/api/unified-gateway.test.ts` | Intégration |
| `task-tree-integration.test.js` | `tests/integration/api/task-tree.test.ts` | Intégration + renommer en .ts |

### Tests Déjà Bien Placés (à conserver)

| Emplacement | Action |
|-------------|--------|
| `tests/unit/*` | ✅ Conserver, éventuellement sous-catégoriser |
| `tests/integration/indexing-validation.test.js` | ✅ Conserver, renommer en .ts |
| `tests/e2e/*` | ✅ Conserver (sauf .d.ts à supprimer) |
| `tests/services/*` | 🔄 Déplacer vers `tests/unit/services/` |
| `tests/utils/*` | 🔄 Déplacer vers `tests/unit/utils/` |
| `tests/fixtures/**` | ✅ Conserver tel quel |
| `tests/config/**` | ✅ Conserver tel quel |

### Fichiers à Supprimer

**Fichiers compilés** (18 fichiers) :
```
tests/**/*.test.js
tests/**/*.test.d.ts
tests/**/*.test.js.map
tests/**/*.test.d.ts.map
```
→ Seront générés dans `build/tests/` par TypeScript

**Fichier vide** :
```
tests/services/anti-leak-protections.test.ts
```
→ Archiver avec explication ou implémenter

---

## 📊 Impact de la Réorganisation

### Avant / Après

| Métrique | Avant | Après |
|----------|-------|-------|
| **Répertoires tests** | 8 emplacements | 3 catégories principales |
| **Tests dans src/** | 8 fichiers | 0 fichiers |
| **Tests racine tests/** | 29 fichiers | 0 fichiers (tous catégorisés) |
| **Fichiers compilés** | 18 fichiers (.js/.d.ts) | 0 (tous dans build/) |
| **Nomenclature** | Mixte (test-*.ts + *.test.ts) | Uniforme (*.test.ts) |
| **Fichiers vides** | 1 (anti-leak) | 0 (archivé) |

### Bénéfices Attendus

✅ **Navigation** : Structure intuitive par type de test  
✅ **Exécution** : Tests ciblés par catégorie  
✅ **Maintenance** : Emplacement clair pour nouveaux tests  
✅ **Performance** : Build plus rapide (séparation compilés)  
✅ **Clarté** : Nomenclature uniforme  

---

## 🔧 Modifications Configuration Nécessaires

### `jest.config.js`

**Avant** :
```javascript
testMatch: [
  '**/tests/**/*.test.ts'
]
```

**Après** :
```javascript
testMatch: [
  '<rootDir>/tests/**/*.test.ts'
],

// Exclure l'archive par défaut
testPathIgnorePatterns: [
  '/node_modules/',
  '/build/',
  '/tests/archive/'
]
```

### `tsconfig.json`

Vérifier que `outDir` pour les tests est bien séparé :
```json
{
  "compilerOptions": {
    "outDir": "./build"
  }
}
```

### `tests/tsconfig.json`

**Créer ou modifier** :
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "../build/tests",
    "rootDir": "."
  },
  "include": [
    "**/*.ts"
  ],
  "exclude": [
    "archive"
  ]
}
```

### `package.json`

**Ajouter des scripts ciblés** :
```json
{
  "scripts": {
    "test": "npm run pretest && cross-env NODE_OPTIONS=\"--experimental-vm-modules --max-old-space-size=4096\" jest --runInBand",
    "test:unit": "npm run pretest && jest --testPathPattern=tests/unit --runInBand",
    "test:integration": "npm run pretest && jest --testPathPattern=tests/integration --runInBand",
    "test:e2e": "npm run pretest && jest --testPathPattern=tests/e2e --runInBand",
    "test:watch": "jest --watch",
    "test:coverage": "npm run pretest && jest --coverage --runInBand"
  }
}
```

---

## 📝 Documentation à Créer

1. **`tests/README.md`** : Guide de l'organisation des tests
2. **`tests/archive/README.md`** : Explication des fichiers archivés
3. **`tests/helpers/README.md`** : Documentation des utilitaires de tests
4. **`TESTS-ORGANIZATION.md`** (racine package) : Documentation complète

---

## ✅ Validation du Design

### Critères de Succès

1. ✅ **Tous les tests dans tests/** : Aucun test dans src/
2. ✅ **Catégorisation claire** : unit/integration/e2e
3. ✅ **Nomenclature uniforme** : *.test.ts partout
4. ✅ **Pas de pollution** : Pas de .js/.d.ts dans tests/
5. ✅ **Fixtures préservés** : Structure existante conservée
6. ✅ **Configuration cohérente** : Jest + TypeScript alignés

### Risques et Mitigations

| Risque | Mitigation |
|--------|-----------|
| **Imports cassés** | Mettre à jour tous les imports relatifs |
| **Fixtures non trouvés** | Vérifier les chemins vers fixtures/ |
| **Tests qui échouent** | Valider après chaque groupe de déplacements |
| **Performance dégradée** | Scripts ciblés (test:unit, test:integration) |

---

**Prochaine étape** : Créer le plan de migration détaillé (MIGRATION-PLAN-TESTS.md)