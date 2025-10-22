# Phase 2 : Catégorisation des Tests à Corriger

**Date** : 2025-10-15
**Baseline** : 407/520 tests (78.3%)
**Tests échoués** : 66
**Objectif Phase 2** : +20 tests → 427/520 (82%+)

---

## 🎯 CORRECTION 4 : Assertions Diverses (12 tests)

### 1. Timestamp Parsing (4 tests) ✅ IDENTIFIÉS
**Fichier** : `tests/unit/utils/timestamp-parsing.test.ts`
**Pattern** : Retourne timestamp actuel au lieu de celui du fichier

Tests :
1. `should parse lastActivity from a single-line JSON file`
   - Expected: `'2025-01-01T10:01:00Z'`
   - Received: `'2025-10-15T14:57:13.809Z'`

2. `should parse lastActivity from a JSONL file`
   - Expected: `'2025-02-01T11:05:00Z'`
   - Received: `'2025-10-15T14:57:13.810Z'`

3. `should handle files with mixed valid and invalid JSON objects`
   - Expected: `'2025-03-01T12:10:00Z'`
   - Received: `'2025-10-15T14:57:13.814Z'`

4. `should return metadata createdAt if no timestamp is found in history`
   - Expected: `'2025-04-01T13:00:00Z'`
   - Received: `'2025-10-15T14:57:13.816Z'`

**Diagnostic** : `RooStorageDetector.analyzeConversation()` retourne `Date.now()` au lieu de lire le timestamp depuis `api_history.jsonl`

---

### 2. Troncature Intelligente (1 test) ✅ IDENTIFIÉ
**Fichier** : `src/tools/smart-truncation/__tests__/engine.test.ts`
**Test** : `should preserve first and last tasks more than middle ones`
**Pattern** : Gradient de troncature inversé

- Expected: `firstPlan.preservationWeight > middlePlan.preservationWeight`
- Received: `0.1353... (firstPlan) < 1 (middlePlan)`

**Diagnostic** : Le calcul du gradient exponentiel est inversé

---

### 3. Gateway Assertions (3 tests) ✅ IDENTIFIÉS
**Fichier** : `tests/unit/gateway/unified-api-gateway.test.ts`

1. `TREE_NAVIGATION - Navigation hiérarchique (Mixed)`
   - Expected: `processingLevel = 'immediate'`
   - Received: `'hybrid'`

2. `Mixed processing - Immédiat + Background déclenché`
   - Expected: `processingLevel = 'immediate'`
   - Received: `'hybrid'`

3. `Monitoring continu des métriques`
   - Expected: `averageProcessingTime > 0`
   - Received: `0`

**Diagnostic** : ProcessingLevel mal détecté OU assertions incorrectes

---

### 4. Content Truncator (1 test) ✅ IDENTIFIÉ
**Fichier** : `src/tools/smart-truncation/__tests__/content-truncator.test.ts`
**Test** : `should handle multiple tasks with different truncation plans`

- Expected: `'contenu tronqué'`
- Received: `'Response 2'`

**Diagnostic** : Plan de troncature non appliqué correctement

---

### 5. XML Parsing (2 tests) ✅ IDENTIFIÉS
**Fichiers** :
- `tests/unit/services/xml-parsing.test.ts`
- `tests/unit/utils/xml-parsing.test.ts`

1. `Doit extraire la mission Git critique du cas réel`
   - Expected: contains `'**OBJECTIFS SPÉCIFIQUES :**'`
   - Received: `'**MISSION CRITIQUE GIT...'`

2. `Simulation complète parent→enfant avec balises task`
   - Expected: `prefixes.some(...) === true`
   - Received: `false`

**Diagnostic** : Regex d'extraction XML ou fixtures incorrectes

---

### 6. Synthesis Service (1 test identifié pour Phase 2)
**Fichier** : `tests/unit/services/synthesis.service.test.ts`
**Test** : `should support method calls (Phase 2: functional methods)`

- Expected: `analysisEngineVersion = '3.0.0-phase3'`
- Received: `'3.0.0-phase3-error'`

**Note** : Les autres tests synthesis ont des problèmes d'encoding UTF-8 (hors scope Phase 2)

---

**TOTAL CORRECTION 4 : 12 tests identifiés**

---

## 🎯 CORRECTION 5 : Stubs Incomplets (8 tests prioritaires)

### 1. TaskIndexer - locations not iterable (7 tests) ✅ IDENTIFIÉS
**Fichier** : `tests/unit/services/task-indexer.test.ts`
**Pattern** : `TypeError: locations is not iterable`

Tests :
1. Circuit Breaker - État CLOSED : Permet les requêtes
2. Circuit Breaker - État OPEN : Bloque les requêtes après 3 échecs
3. Circuit Breaker - Délai exponentiel : 2s, 4s, 8s
4. Gestion des erreurs parentTaskId manquant
5. Logging détaillé - Capture des métriques critiques
6. Collection Status - Vérification état Qdrant
7. Reset Collection - Nettoyage complet

**Diagnostic** : Mock de `RooStorageDetector.detectStorageLocations()` retourne `undefined` au lieu d'un array

---

### 2. BOM Handling - Fonctions inexistantes (2 tests) ✅ IDENTIFIÉS
**Fichier** : `tests/unit/utils/bom-handling.test.ts`
**Pattern** : `server.handleXXX is not a function`

Tests :
1. `diagnose_conversation_bom should detect file with BOM`
   - Error: `server.handleDiagnoseConversationBom is not a function`

2. `repair_conversation_bom should fix file with BOM`
   - Error: `server.handleRepairConversationBom is not a function`

**Diagnostic** : Méthodes de handler manquantes dans le mock du serveur

---

### 3. RooSync Apply Decision (1 test) ✅ IDENTIFIÉ
**Fichier** : `tests/unit/tools/roosync/apply-decision.test.ts`
**Test** : `devrait mettre à jour sync-roadmap.md en mode normal`

- Expected: `newStatus = 'applied'`
- Received: `'failed'`

**Diagnostic** : Mock de fichier système ou path inexistant

---

### 4. RooSync Rollback (4 tests) ✅ IDENTIFIÉS
**Fichier** : `tests/unit/tools/roosync/rollback-decision.test.ts`
**Pattern** : `RooSyncServiceError: Échec du rollback: No rollback directory found`

Tests :
1. devrait annuler une décision appliquée
2. devrait retourner la liste des fichiers restaurés
3. devrait inclure les logs d'exécution
4. devrait mettre à jour sync-roadmap.md

**Diagnostic** : Mock de répertoire rollback manquant

---

### 5. Versioning (1 test) - BONUS si temps
**Fichier** : `tests/unit/utils/versioning.test.ts`
**Test** : `should load the version from package.json`

- Error: `Cannot read properties of undefined (reading 'info')`

**Diagnostic** : Mock de `server.options` incomplet

---

**TOTAL CORRECTION 5 : 14 tests identifiés (prioriser les 8 premiers = TaskIndexer + BOM + RooSync Apply)**

---

## 📊 Plan d'Exécution Phase 2

### Étape 1 : Correction 4 - Assertions (2h)
1. ✅ Timestamps (4 tests) - 30 min
2. ✅ Troncature intelligente (1 test) - 15 min
3. ✅ Gateway assertions (3 tests) - 30 min
4. ✅ Content truncator (1 test) - 15 min
5. ✅ XML parsing (2 tests) - 20 min
6. ✅ Synthesis (1 test) - 10 min

### Étape 2 : Correction 5 - Stubs (1.5h)
1. ✅ TaskIndexer (7 tests) - 45 min
2. ✅ BOM handling (2 tests) - 20 min
3. ✅ RooSync apply (1 test) - 15 min
4. (⏭️ RooSync rollback - 4 tests si temps)

### Validation (30 min)
- Build : `npm run build`
- Tests : `npm test`
- Rapport Phase 2
- Commit + Push

---

**OBJECTIF MINIMAL : 20 tests corrigés (12+8)**
**OBJECTIF OPTIMAL : 24+ tests corrigés**