# PLAN DE RÉORGANISATION COMPLÈTE DES TESTS
## Serveur MCP roo-state-manager

**Date:** 2025-10-07  
**Statut:** EN COURS

---

## 📊 AUDIT INITIAL

### Situation Actuelle - CATASTROPHIQUE

#### Fichiers à la Racine du Projet (25 fichiers à déplacer)

**Tests unitaires/intégration (18 fichiers):**
1. `debug-test.js` (1.27 KB) - Script de debug
2. `diagnose-qdrant.js` (8.82 KB) - Diagnostic Qdrant
3. `manual-hierarchy-validation.js` (13.18 KB) - Validation manuelle hiérarchie
4. `test_similarity.js` (4.58 KB) - Test similarité
5. `test-anti-leak-validation.js` (7.20 KB) - Validation anti-leak
6. `test-basic.js` (2.15 KB) - Test basique
7. `test-hierarchy-inference.js` (6.89 KB) - Test inférence hiérarchie
8. `test-hierarchy-manually.cjs` (10.52 KB) - Test manuel hiérarchie
9. `test-hierarchy-reconstruction.js` (5.79 KB) - Test reconstruction
10. `test-imports.js` (1.56 KB) - Test imports
11. `test-llm-minimal-synthesis.js` (2.65 KB) - Test LLM synthèse
12. `test-llm-minimal.js` (0.59 KB) - Test LLM minimal
13. `test-llm-service-direct.js` (1.07 KB) - Test LLM service
14. `test-mcp-tools.js` (5.04 KB) - Test outils MCP
15. `test-new-task-extraction.js` (9.02 KB) - Test extraction tâches
16. `test-phase2-simple.js` (9.99 KB) - Test phase2
17. `test-production-hierarchy.js` (6.17 KB) - Test production
18. `test-real-tasks.js` (7.97 KB) - Test tâches réelles
19. `test-refactoring-simple.js` (2.73 KB) - Test refactoring
20. `test-singleton-direct.js` (0.67 KB) - Test singleton

**Demos/Validation (3 fichiers):**
21. `demo-phase2-complete.js` (5.41 KB)
22. `demo-phase2-final.js` (3.78 KB)
23. `validation-architecture-consolidee.cjs` (20.78 KB)

**Scripts de déploiement (2 fichiers):**
24. `deploy-simple.ps1` (5.83 KB)
25. `deploy.ps1` (6.34 KB)

**Logs à supprimer (2 fichiers):**
- `start.log` (59.48 KB)
- `startup.log` (0.54 KB)

#### Fichiers dans src/config/ (1 fichier)
- `src/config/roosync-config.test.ts` (4.11 KB) - **PRIORITAIRE**

#### Fichiers Mal Placés dans tests/ (16 fichiers)

**À la racine de tests/ (devraient être dans unit/ ou integration/):**
1. `bom-handling.test.ts` → unit/utils/
2. `comprehensive-test.js` → integration/
3. `controlled-hierarchy-reconstruction.test.ts` → unit/utils/
4. `hierarchy-real-data.test.ts` → integration/
5. `hierarchy-reconstruction-engine.test.ts` → unit/services/
6. `integration.test.ts` → integration/ (OK si renommé)
7. `manage-mcp-settings.test.ts` → unit/tools/
8. `read-vscode-logs.test.ts` → unit/tools/
9. `roo-storage-detector.test.ts` → unit/services/
10. `task-instruction-index.test.ts` → unit/services/
11. `task-navigator.test.ts` → unit/services/
12. `task-tree-integration.test.js` → integration/
13. `timestamp-parsing.test.ts` → unit/utils/
14. `versioning.test.ts` → unit/utils/
15. `view-conversation-tree.test.ts` → unit/tools/
16. `xml-parsing.test.ts` → unit/utils/

**Fichiers .js potentiellement obsolètes:**
- `simple-test.js` → manual/ ou supprimer
- `test-phase1-implementation.js` → manual/
- `test-phase2-implementation.js` → manual/
- `test-storage-detector.js` → manual/ (utilisé dans package.json)

---

## 🎯 STRUCTURE CIBLE

```
roo-state-manager/
├── src/                       # Code source
│   ├── config/
│   │   └── roosync-config.ts
│   ├── services/
│   ├── tools/
│   └── utils/
├── tests/                     # TOUS LES TESTS ICI
│   ├── unit/                  # Tests unitaires Jest
│   │   ├── config/
│   │   │   └── roosync-config.test.ts  ← DÉPLACER DEPUIS src/config/
│   │   ├── services/
│   │   │   ├── hierarchy-reconstruction-engine.test.ts
│   │   │   ├── roo-storage-detector.test.ts
│   │   │   ├── task-indexer.test.ts
│   │   │   ├── task-instruction-index.test.ts
│   │   │   ├── task-navigator.test.ts
│   │   │   ├── synthesis.service.test.ts
│   │   │   ├── indexing-decision.test.ts
│   │   │   ├── test_similarity.js
│   │   │   ├── test-llm-minimal-synthesis.js
│   │   │   ├── test-llm-minimal.js
│   │   │   ├── test-llm-service-direct.js
│   │   │   └── test-singleton-direct.js
│   │   ├── tools/
│   │   │   ├── manage-mcp-settings.test.ts
│   │   │   ├── read-vscode-logs.test.ts
│   │   │   └── view-conversation-tree.test.ts
│   │   └── utils/
│   │       ├── bom-handling.test.ts
│   │       ├── controlled-hierarchy-reconstruction.test.ts
│   │       ├── hierarchy-inference.test.ts
│   │       ├── timestamp-parsing.test.ts
│   │       ├── versioning.test.ts
│   │       ├── xml-parsing.test.ts
│   │       ├── test-hierarchy-inference.js
│   │       ├── test-hierarchy-reconstruction.js
│   │       ├── test-new-task-extraction.js
│   │       ├── test-basic.js
│   │       ├── test-imports.js
│   │       └── test-refactoring-simple.js
│   ├── integration/           # Tests d'intégration
│   │   ├── comprehensive-test.js
│   │   ├── hierarchy-real-data.test.ts
│   │   ├── integration.test.ts
│   │   ├── task-tree-integration.test.js
│   │   ├── test-anti-leak-validation.js
│   │   ├── test-mcp-tools.js
│   │   ├── test-phase2-simple.js
│   │   ├── test-production-hierarchy.js
│   │   ├── test-real-tasks.js
│   │   └── indexing-validation.test.js (déjà présent)
│   ├── e2e/                   # Tests E2E (déjà bien structuré)
│   │   ├── semantic-search.test.ts
│   │   ├── task-navigation.test.ts
│   │   ├── placeholder.test.ts
│   │   ├── proxy.ts
│   │   └── manual-test-storage/
│   ├── manual/                # Scripts de test manuels
│   │   ├── debug-test.js
│   │   ├── diagnose-qdrant.js
│   │   ├── manual-hierarchy-validation.js
│   │   ├── test-hierarchy-manually.cjs
│   │   ├── test-storage-detector.js
│   │   ├── simple-test.js
│   │   ├── test-phase1-implementation.js
│   │   ├── test-phase2-implementation.js
│   │   ├── demo-phase2-complete.js
│   │   ├── demo-phase2-final.js
│   │   └── validation-architecture-consolidee.cjs
│   ├── fixtures/              # Données de test (déjà OK)
│   │   ├── controlled-hierarchy/
│   │   └── hierarchy-test-data.ts
│   ├── e2e-runner.ts
│   ├── global-setup.ts
│   ├── global-teardown.ts
│   ├── jest.setup.ts
│   ├── setup-env.ts
│   └── tsconfig.json
├── scripts/                   # Scripts de déploiement/maintenance
│   ├── deploy-simple.ps1      ← DÉPLACER DEPUIS racine
│   └── deploy.ps1             ← DÉPLACER DEPUIS racine
├── package.json
├── jest.config.js
├── tsconfig.json
└── README.md
```

---

## 🔄 PLAN D'EXÉCUTION DÉTAILLÉ

### Phase 1: Créer la Structure Cible

```powershell
# Créer les répertoires manquants
New-Item -ItemType Directory -Path "tests/unit/config" -Force
New-Item -ItemType Directory -Path "tests/unit/tools" -Force
New-Item -ItemType Directory -Path "tests/manual" -Force
```

### Phase 2: Déplacer roosync-config.test.ts (PRIORITAIRE)

```powershell
git mv src/config/roosync-config.test.ts tests/unit/config/roosync-config.test.ts
```

**Mise à jour des imports dans le fichier:**
```typescript
// Ancien
import { loadRooSyncConfig, ... } from './roosync-config';

// Nouveau
import { loadRooSyncConfig, ... } from '../../../src/config/roosync-config';
```

### Phase 3: Déplacer Fichiers de la Racine → tests/unit/

**Services:**
```powershell
git mv test_similarity.js tests/unit/services/
git mv test-llm-minimal-synthesis.js tests/unit/services/
git mv test-llm-minimal.js tests/unit/services/
git mv test-llm-service-direct.js tests/unit/services/
git mv test-singleton-direct.js tests/unit/services/
```

**Utils:**
```powershell
git mv test-hierarchy-inference.js tests/unit/utils/
git mv test-hierarchy-reconstruction.js tests/unit/utils/
git mv test-new-task-extraction.js tests/unit/utils/
git mv test-basic.js tests/unit/utils/
git mv test-imports.js tests/unit/utils/
git mv test-refactoring-simple.js tests/unit/utils/
```

### Phase 4: Déplacer Fichiers de la Racine → tests/integration/

```powershell
git mv test-anti-leak-validation.js tests/integration/
git mv test-mcp-tools.js tests/integration/
git mv test-phase2-simple.js tests/integration/
git mv test-production-hierarchy.js tests/integration/
git mv test-real-tasks.js tests/integration/
```

### Phase 5: Déplacer Fichiers de la Racine → tests/manual/

```powershell
git mv debug-test.js tests/manual/
git mv diagnose-qdrant.js tests/manual/
git mv manual-hierarchy-validation.js tests/manual/
git mv test-hierarchy-manually.cjs tests/manual/
git mv demo-phase2-complete.js tests/manual/
git mv demo-phase2-final.js tests/manual/
git mv validation-architecture-consolidee.cjs tests/manual/
```

### Phase 6: Réorganiser Fichiers dans tests/ Vers Sous-répertoires

**tests/ → tests/unit/services/:**
```powershell
git mv tests/hierarchy-reconstruction-engine.test.ts tests/unit/services/
git mv tests/roo-storage-detector.test.ts tests/unit/services/
git mv tests/task-instruction-index.test.ts tests/unit/services/
git mv tests/task-navigator.test.ts tests/unit/services/
```

**tests/ → tests/unit/tools/:**
```powershell
git mv tests/manage-mcp-settings.test.ts tests/unit/tools/
git mv tests/read-vscode-logs.test.ts tests/unit/tools/
git mv tests/view-conversation-tree.test.ts tests/unit/tools/
```

**tests/ → tests/unit/utils/:**
```powershell
git mv tests/bom-handling.test.ts tests/unit/utils/
git mv tests/controlled-hierarchy-reconstruction.test.ts tests/unit/utils/
git mv tests/timestamp-parsing.test.ts tests/unit/utils/
git mv tests/versioning.test.ts tests/unit/utils/
git mv tests/xml-parsing.test.ts tests/unit/utils/
```

**tests/ → tests/integration/:**
```powershell
git mv tests/comprehensive-test.js tests/integration/
git mv tests/hierarchy-real-data.test.ts tests/integration/
git mv tests/integration.test.ts tests/integration/
git mv tests/task-tree-integration.test.js tests/integration/
```

**tests/ → tests/manual/:**
```powershell
git mv tests/simple-test.js tests/manual/
git mv tests/test-phase1-implementation.js tests/manual/
git mv tests/test-phase2-implementation.js tests/manual/
git mv tests/test-storage-detector.js tests/manual/
```

### Phase 7: Déplacer Scripts de Déploiement

```powershell
git mv deploy-simple.ps1 scripts/
git mv deploy.ps1 scripts/
```

### Phase 8: Supprimer Logs

```powershell
git rm start.log
git rm startup.log
```

### Phase 9: Mettre à Jour Configuration Jest

**jest.config.js:**
```javascript
testMatch: [
  '**/tests/unit/**/*.test.ts',
  '**/tests/unit/**/*.test.js',
  '**/tests/integration/**/*.test.ts',
  '**/tests/integration/**/*.test.js',
  '**/tests/e2e/**/*.test.ts'
]
```

**package.json - Ajouter scripts:**
```json
"scripts": {
  "test": "npm run test:setup && cross-env NODE_OPTIONS=--experimental-vm-modules jest --runInBand",
  "test:unit": "npm run test:setup && jest tests/unit --runInBand",
  "test:integration": "npm run test:setup && jest tests/integration --runInBand",
  "test:e2e": "npm run pretest && npm run test:e2e:run",
  "test:coverage": "npm run pretest && jest --coverage",
  "test:watch": "jest --watch"
}
```

### Phase 10: Mettre à Jour README.md

Ajouter section sur la structure des tests et les commandes disponibles.

---

## ✅ VALIDATION

Après réorganisation:

1. **Vérifier structure:**
   ```powershell
   tree tests /F
   ```

2. **Vérifier aucun test à la racine:**
   ```powershell
   Get-ChildItem -File -Filter "*.test.*"
   Get-ChildItem -File -Filter "test-*"
   ```

3. **Exécuter tous les tests:**
   ```powershell
   npm test
   ```

4. **Exécuter par catégorie:**
   ```powershell
   npm run test:unit
   npm run test:integration
   npm run test:e2e
   ```

---

## 📝 NOTES IMPORTANTES

- Utiliser **UNIQUEMENT `git mv`** pour préserver l'historique
- Mettre à jour les imports relatifs après chaque déplacement
- Tester après chaque groupe de déplacements
- Ne pas déplacer les fichiers de configuration de tests (jest.setup.ts, etc.)
- Conserver la structure e2e/ telle quelle (déjà correcte)
- Conserver fixtures/ tel quel

---

## 🎯 RÉSULTAT ATTENDU

- ✅ 0 fichiers de test à la racine
- ✅ Structure tests/ professionnelle et claire
- ✅ Tous les tests passent
- ✅ Scripts npm fonctionnels (test:unit, test:integration)
- ✅ Documentation à jour
- ✅ Historique Git préservé