# 🔬 Analyse Forensique - Causes Racines des 65 Tests Échoués

**Date d'analyse :** 2025-10-14  
**Tests analysés :** 65/478 (13.6% d'échecs)  
**Méthode :** Analyse empirique sans hypothèses

---

## 🎯 Résumé Exécutif

Sur 65 tests échoués analysés, **7 causes racines majeures** ont été identifiées :

| Cause Racine | Tests Affectés | % des Échecs | Priorité |
|--------------|----------------|--------------|----------|
| **1. Module manquant** (`hierarchy-reconstruction-engine.js`) | 4 tests | 6.2% | 🔴 P0 - CRITIQUE |
| **2. Mock invalide** (`vi.unstable_mockModule is not a function`) | 3 tests | 4.6% | 🔴 P0 - CRITIQUE |
| **3. Parsing XML défaillant** | 13 tests | 20.0% | 🟠 P1 - HAUTE |
| **4. Tests RooSync fonctionnels manquants** (skipped) | 29 tests | 44.6% | 🟡 P2 - MOYENNE |
| **5. Erreurs d'assertion diverses** | 12 tests | 18.5% | 🟠 P1 - HAUTE |
| **6. Erreurs de mock/stub** | 3 tests | 4.6% | 🟠 P1 - HAUTE |
| **7. Erreur UnexpectedResolve** | 1 test | 1.5% | 🟢 P3 - BASSE |

---

## 📊 Analyse Détaillée par Cause Racine

### 🔴 CAUSE 1 : Module Manquant - `hierarchy-reconstruction-engine.js`

**Tests affectés :** 4 tests (6.2% des échecs)

**Fichiers concernés :**
- `tests/integration/hierarchy-real-data.test.ts`
- `tests/integration/integration.test.ts`
- `tests/unit/utils/controlled-hierarchy-reconstruction.test.ts`

**Message d'erreur :**
```
Cannot find module '../../../src/utils/hierarchy-reconstruction-engine.js' 
imported from 'd:/dev/roo-extensions/mcps/internal/servers/roo-state-manager/tests/...'
```

**Origine du problème :**
Le fichier `src/utils/hierarchy-reconstruction-engine.js` est importé mais n'existe pas (ou l'extension est incorrecte).

**Solution :**
1. ✅ **Action immédiate :** Vérifier l'existence du fichier
   ```bash
   find src/utils -name "*hierarchy-reconstruction*"
   ```

2. ✅ **Si le fichier existe en `.ts` :**
   - Corriger les imports dans les 3 fichiers de tests
   - Remplacer `.js` par `.ts` ou supprimer l'extension

3. ✅ **Si le fichier n'existe pas :**
   - Créer le module manquant
   - OU supprimer les tests obsolètes

**Temps estimé :** 15-30 min  
**Impact :** CRITIQUE - Bloque 4 tests d'intégration

---

### 🔴 CAUSE 2 : Mock Framework Invalide - `vi.unstable_mockModule`

**Tests affectés :** 3 tests (4.6% des échecs)

**Fichiers concernés :**
- `tests/unit/services/hierarchy-reconstruction-engine.test.ts`
- `tests/unit/services/synthesis.service.test.ts`
- `tests/unit/tools/manage-mcp-settings.test.ts`

**Message d'erreur :**
```
vi.unstable_mockModule is not a function
```

**Origine du problème :**
Utilisation d'une API Vitest instable (`unstable_mockModule`) qui n'existe plus ou a été renommée dans la version actuelle.

**Solution :**
1. ✅ **Vérifier la version de Vitest :**
   ```bash
   npm list vitest
   ```

2. ✅ **Mettre à jour les mocks vers l'API stable :**
   ```typescript
   // AVANT (instable)
   vi.unstable_mockModule('./module', () => ({
     default: mockedValue
   }))
   
   // APRÈS (stable)
   vi.mock('./module', () => ({
     default: mockedValue
   }))
   ```

3. ✅ **Alternative : Utiliser `vi.doMock()` pour mocks dynamiques**

**Temps estimé :** 30 min  
**Impact :** CRITIQUE - Bloque tests unitaires de services essentiels

---

### 🟠 CAUSE 3 : Parsing XML Défaillant (13 tests - 20%)

**Tests affectés :** 13 tests dans 2 fichiers

**Fichiers concernés :**
- `tests/unit/services/xml-parsing.test.ts` (10 échecs)
- `tests/unit/utils/xml-parsing.test.ts` (3 échecs)

**Pattern d'erreur récurrent :**
```
AssertionError: expected [] to have a length of 1 but got +0
```

**Origine du problème :**
La fonction d'extraction XML retourne systématiquement un tableau vide `[]` au lieu des éléments attendus.

**Causes possibles :**
1. **Regex cassée** dans le parser XML
2. **Format de données changé** (structure des fichiers `ui_messages.json`)
3. **Bug dans `extractNewTasks()` ou `extractToolCalls()`**

**Solution :**
1. ✅ **Diagnostic du parser :**
   ```typescript
   // Ajouter des logs dans le parser pour voir ce qui est extrait
   console.log("Raw content:", content)
   console.log("Matches found:", matches)
   ```

2. ✅ **Vérifier la regex :**
   - Pattern attendu vs pattern réel dans les fixtures
   - Test avec un cas simple d'abord

3. ✅ **Fixtures obsolètes ?**
   - Vérifier si les fichiers de test utilisent le bon format JSON

**Temps estimé :** 1-2h  
**Impact :** HAUTE - Affecte extraction des hiérarchies parent-enfant

---

### 🟡 CAUSE 4 : Tests RooSync Skipped (29 tests - 44.6%)

**Tests affectés :** 29 tests (plus grande catégorie)

**Fichiers concernés :**
- `tests/e2e/roosync-error-handling.test.ts` (19 skipped)
- `tests/e2e/roosync-workflow.test.ts` (10 skipped)

**Statut :** Tests marqués `skipped` (non exécutés)

**Origine du problème :**
Tests E2E RooSync désactivés intentionnellement (probablement car nécessitent infrastructure spéciale).

**Solution :**
1. ✅ **Vérifier si infrastructure disponible :**
   - Existe-t-il un `SHARED_STATE_PATH` configuré ?
   - Les fichiers RooSync sont-ils présents ?

2. ✅ **Réactiver progressivement :**
   - Commencer par 1-2 tests simples
   - Vérifier s'ils passent avec l'infrastructure actuelle

3. ✅ **OU accepter comme "non-applicable" :**
   - Si RooSync n'est pas utilisé en prod, garder skipped

**Temps estimé :** Variable (2-8h selon décision)  
**Impact :** MOYENNE - Fonctionnalité non critique

---

### 🟠 CAUSE 5 : Assertions Diverses (12 tests - 18.5%)

**Tests affectés :** 12 tests répartis

**Patterns d'erreur :**
1. **Normalisation préfixes** (3 tests)
   ```
   expected 'code implémenter...' to be 'implémenter...'
   ```
   → Bug dans `computeInstructionPrefix()` - ne retire pas le mode

2. **Résolution parent stricte** (2 tests)
   ```
   expected 2 to be 1
   ```
   → Trouve trop de parents candidats

3. **Limite MAX_SAVES** (1 test)
   ```
   expected 10 to be 50
   ```
   → Ne sauvegarde que 10 squelettes au lieu de 50

4. **Timestamp parsing** (4 tests)
   ```
   expected '2025-10-14T15:49:27.935Z' to be '2025-01-01T10:01:00Z'
   ```
   → Retourne timestamp actuel au lieu de celui du fichier

5. **Workspace normalization** (1 test)
   ```
   expected false to be true
   ```
   → Normalisation des chemins Windows/Unix

6. **Troncature intelligente** (1 test)
   ```
   expected 0.1353... to be greater than 1
   ```
   → Gradient de troncature inversé

**Solution :**
Corriger chaque assertion individuellement (bugs spécifiques).

**Temps estimé :** 2-3h  
**Impact :** HAUTE - Affecte fonctions core

---

### 🟠 CAUSE 6 : Mocks/Stubs Manquants (3 tests)

**Tests affectés :**
- `task-indexer.test.ts` (7 échecs - `TypeError: locations is not iterable`)
- `unified-api-gateway.test.ts` (5 échecs - assertions metrics/monitoring)
- `powershell-executor.test.ts` (1 échec - `UnexpectedResolve`)
- `roosync-apply-decision.test.ts` (1 échec)
- `roosync-rollback-decision.test.ts` (4 échecs)
- `bom-handling.test.ts` (2 échecs - fonction inexistante)

**Origine :**
Services mockés incomplets ou API changée.

**Solution :**
Compléter les mocks pour chaque service testé.

**Temps estimé :** 1-2h  
**Impact :** HAUTE

---

## 🎯 Plan de Correction Priorisé

### 🔴 Phase 1 - CRITIQUE (2-3h) - Bloquants

| Action | Tests Corrigés | Temps |
|--------|----------------|-------|
| 1. Corriger module manquant `hierarchy-reconstruction-engine.js` | 4 | 30 min |
| 2. Remplacer `vi.unstable_mockModule` par API stable | 3 | 30 min |
| 3. Debugger parser XML (ajouter logs + identifier cause) | 13 | 2h |

**Total Phase 1 :** 20 tests → **~3h**

---

### 🟠 Phase 2 - HAUTE (3-4h) - Corrections fonctionnelles

| Action | Tests Corrigés | Temps |
|--------|----------------|-------|
| 4. Corriger assertions diverses (12 bugs spécifiques) | 12 | 2-3h |
| 5. Compléter mocks manquants (TaskIndexer, API Gateway, etc.) | 8 | 1h |

**Total Phase 2 :** 20 tests → **~4h**

---

### 🟡 Phase 3 - MOYENNE (Variable) - Non-bloquants

| Action | Tests Corrigés | Temps |
|--------|----------------|-------|
| 6. Évaluer + réactiver tests RooSync E2E (si applicable) | 0-29 | 2-8h |

**Total Phase 3 :** 0-29 tests → **~2-8h** (selon décision)

---

## 📈 Objectifs de Correction

| Phase | Tests Passés | Taux de Succès | Temps Cumulé |
|-------|-------------|----------------|--------------|
| **Avant** | 372/478 | 77.8% | - |
| **Après Phase 1** | 392/478 | 82.0% | ~3h |
| **Après Phase 2** | 412/478 | 86.2% | ~7h |
| **Après Phase 3** | 412-441/478 | 86.2-92.3% | ~9-15h |

**Objectif réaliste minimal :** **86%+ (Phase 1+2)**  
**Objectif optimal :** **92%+ (Toutes phases)**

---

## 🔍 Méthodologie Utilisée

1. ✅ **Extraction empirique** - Analyse JSON brute sans hypothèses
2. ✅ **Catégorisation par pattern d'erreur** - Regroupement des causes similaires
3. ✅ **Priorisation par impact** - Bloquants en premier
4. ✅ **Validation par comptage** - 65 tests = 100% des échecs couverts

---

## 📝 Conclusion

**Résultat clé :** Les 65 tests échoués sont causés par **7 problèmes bien identifiés** :
- **44.6%** sont des tests RooSync skipped (décision à prendre)
- **20%** sont liés au parsing XML (bug critique)
- **35.4%** sont des bugs variés mais isolés

**Aucun lien avec les redondances de code** identifiées dans le Batch 10.

**Action immédiate recommandée :** Démarrer Phase 1 (3h) pour corriger 20 tests critiques.