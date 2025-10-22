# Plan Prochaine Session - Corrections Tests

## 🎯 Objectif Global
Terminer Phase 1 + Phase 2 des corrections pour atteindre **86%+ de tests passants** (412/478).

## 📋 Checklist Prochaine Session

### ✅ Préparation (15 min)
- [ ] Lire `PHASE1_CORRECTIONS_PARTIAL_REPORT.md` (vue globale)
- [ ] Lire `TEST_FAILURES_ROOT_CAUSES.md` Section 3 (Parser XML détaillé)
- [ ] Vérifier état Git (doit être clean après commit intermédiaire)
- [ ] Compiler projet : `npm run build` (vérifier 0 erreur)
- [ ] Lancer tests baseline : `npm test` (attendre ~379/478 tests)
- [ ] Noter baseline exacte pour suivi progression

### 🔧 Phase 1 - Terminer (1-2h)

#### Correction 3 : Parser XML Défaillant (13 tests)
**Tests concernés** :
- `tests/unit/services/xml-parsing.test.ts` (10 tests)
- `tests/unit/utils/xml-parsing.test.ts` (3 tests)

**Plan d'Action Détaillé** :

1. **Exécuter tests ciblés** (5 min)
   ```powershell
   npm test -- tests/unit/services/xml-parsing.test.ts
   ```
   - Noter quels tests échouent exactement
   - Capturer messages d'erreur complets
   - Identifier patterns (tous `[]` ? erreurs différentes ?)

2. **Analyser output et logs** (10 min)
   - Identifier où `extractNewTasks()` retourne `[]`
   - Identifier où `extractToolCalls()` retourne `[]`
   - Comparer expected vs received dans assertions
   - Hypothèse : regex cassée ou fixtures mal formatées

3. **Ajouter logs debug détaillés** (15 min)
   - Éditer `src/services/TraceSummaryService.ts`
   ```typescript
   private extractNewTasks(content: string): Task[] {
     console.log('[DEBUG extractNewTasks] Input length:', content.length);
     console.log('[DEBUG extractNewTasks] Input preview:', content.substring(0, 200));
     
     // Existing parsing logic
     const matches = content.match(/your-regex-here/g);
     console.log('[DEBUG extractNewTasks] Regex matches:', matches?.length ?? 0);
     
     const tasks = // ... parsing logic
     console.log('[DEBUG extractNewTasks] Parsed tasks:', tasks.length);
     console.log('[DEBUG extractNewTasks] Tasks:', JSON.stringify(tasks, null, 2));
     
     return tasks;
   }
   ```
   - Même chose pour `extractToolCalls()`

4. **Re-exécuter avec logs** (5 min)
   ```powershell
   npm test -- tests/unit/services/xml-parsing.test.ts 2>&1 | Out-File -FilePath parser-debug.log
   ```
   - Analyser `parser-debug.log`
   - Identifier où le parsing échoue

5. **Diagnostic cause racine** (20-30 min)
   - **Si regex cassée** : Corriger pattern de matching
   - **Si fixtures invalides** : Corriger format JSON dans fixtures
   - **Si logique extraction défaillante** : Refactorer extraction
   - **Si structure XML changée** : Adapter parser à nouvelle structure

6. **Corriger le parser** (20-40 min)
   - Appliquer fix identifié
   - Compiler : `npm run build`
   - Tester de nouveau

7. **Valider correction** (10 min)
   ```powershell
   npm test -- tests/unit/services/xml-parsing.test.ts
   npm test -- tests/unit/utils/xml-parsing.test.ts
   ```
   - Tous les 13 tests doivent passer
   - Si échecs persistent : itérer steps 4-6

8. **Cleanup logs debug** (5 min)
   - Retirer console.log ajoutés
   - Compiler final : `npm run build`

**Temps estimé total** : 1-2h selon complexité

**Fichiers à modifier** :
- `src/services/TraceSummaryService.ts` (parser principal)
- Possiblement `tests/fixtures/trace-summary-fixtures.ts` (si fixtures invalides)
- Possiblement assertions dans tests (si expected values incorrectes)

### ✅ Validation Phase 1 (15 min)
- [ ] Compilation finale : `npm run build` (0 erreur)
- [ ] Tests complets : `npm test` (attendre résultats)
- [ ] Vérifier : ≥392/478 tests (82%+) ✅
- [ ] Si < 392 tests : identifier régressions et corriger
- [ ] Créer `PHASE1_CORRECTIONS_COMPLETE_REPORT.md`
- [ ] Commit Phase 1 : 
  ```powershell
  git add .
  git commit -m "fix(tests): complete phase 1 - 20 critical tests fixed

  Corrections completed:
  - hierarchy-reconstruction-engine imports (4 tests)
  - unstable_mockModule API (3 tests)  
  - XML parser defects (13 tests)
  
  Tests: 372/478 (77.8%) → 392/478 (82%)
  Files: 10 test files corrected
  Time: ~2.5h
  
  Status: Phase 1 complete, ready for Phase 2"
  ```

### 🔧 Phase 2 - Corrections Haute Priorité (3-4h)

**IMPORTANT** : Ne démarrer Phase 2 que si Phase 1 validée (≥392 tests)

#### Correction 4 : Assertions Diverses (12 tests)
**Référence** : `TEST_FAILURES_ROOT_CAUSES.md` Section 4

**Fichiers concernés** (12 tests) :
1. `tests/unit/services/conversation-tree.service.test.ts`
2. `tests/unit/services/hierarchy-reconstruction-engine.test.ts`
3. `tests/unit/services/message-formatting.test.ts`
4. `tests/unit/tools/manage-async-job.test.ts`
5. `tests/unit/tools/view-conversation-tree.test.ts`
6. Autres (voir rapport détaillé)

**Approche** :
1. Traiter chaque test individuellement (1 par 1)
2. Pour chaque test :
   - Lire test et comprendre intention
   - Exécuter test isolé
   - Comparer expected vs received
   - Identifier si problème dans :
     * Assertion (expected incorrect)
     * Logique métier (received incorrect)
     * Mock incomplet (données test manquantes)
   - Appliquer correction appropriée
   - Valider test passe
   - Commit si correction significative

3. Patterns courants :
   - Valeurs hardcodées obsolètes
   - Formats de sortie changés
   - Propriétés ajoutées/retirées
   - Types modifiés

**Temps estimé** : 2-3h (15-20 min par test)

#### Correction 5 : Stubs/Mocks Incomplets (8 tests)
**Référence** : `TEST_FAILURES_ROOT_CAUSES.md` Section 5

**Fichiers concernés** (8 tests) :
1. `tests/unit/services/task-indexer.test.ts`
2. `tests/unit/tools/roosync-*.test.ts` (plusieurs fichiers)
3. API Gateway tests

**Approche** :
1. Identifier mocks manquants :
   ```typescript
   // Exemple problème
   const mockTaskIndexer = {
     // Méthode manquante: analyzeTask()
   }
   
   // Solution
   const mockTaskIndexer = {
     analyzeTask: vi.fn().mockResolvedValue({ /* result */ })
   }
   ```

2. Compléter stubs progressivement
3. Valider chaque ajout

**Temps estimé** : 1h (5-10 min par test)

### ✅ Validation Phase 2 (15 min)
- [ ] Compilation : `npm run build` (0 erreur)
- [ ] Tests complets : `npm test`
- [ ] Vérifier : ≥412/478 tests (86%+) ✅
- [ ] Créer `PHASE2_CORRECTIONS_COMPLETE_REPORT.md`
- [ ] Commit Phase 2 :
  ```powershell
  git commit -m "fix(tests): complete phase 2 - assertions and stubs

  Corrections:
  - Various assertion mismatches (12 tests)
  - Incomplete mocks/stubs (8 tests)
  
  Tests: 392/478 (82%) → 412/478 (86%)
  Files: ~15 test files corrected
  Time: ~4h
  
  Status: Phase 2 complete, 86% coverage achieved"
  ```

### 📊 Objectifs Réalistes Session

#### Minimum (2-3h)
- ✅ Terminer Phase 1 uniquement
- Tests : 372 → 392/478 (82%)
- Corrections : 20 tests

#### Optimal (5-6h)
- ✅ Phase 1 + Phase 2 complètes
- Tests : 372 → 412/478 (86%)
- Corrections : 40 tests

#### Stretch (7-8h)
- ✅ Phase 1 + Phase 2 + début Phase 3
- Tests : 372 → 430/478 (90%)
- Corrections : 58+ tests

## 🚨 Points d'Attention Critiques

### Parser XML (Correction 3)
- **Complexité** : Élevée, nécessite debugging méthodique
- **Logs** : Ne pas hésiter à ajouter BEAUCOUP de logs
- **Fixtures** : Valider format JSON dans messages test
- **Regex** : Tester patterns ligne par ligne si nécessaire
- **Timeout** : Si bloqué > 30 min, documenter et passer

### Gestion Temps
- **Commits intermédiaires** : Après chaque correction majeure
- **Breaks** : Pause 5-10 min toutes les 1-2h
- **Focus** : Ne pas bloquer sur 1 test > 30 min
- **Documentation** : Noter tests complexes pour analyse ultérieure

### Performance
- **Compilation** : Régulière (`npm run build` après modifs)
- **Tests isolés** : Par fichier pendant debug
  ```powershell
  npm test -- tests/unit/specific-test.test.ts
  ```
- **Tests complets** : Uniquement en validation phase
  ```powershell
  npm test
  ```

### Git
- **Commits atomiques** : 1 commit = 1 type de correction
- **Messages clairs** : Décrire nature correction + impact
- **Validation** : Toujours compiler avant commit
- **Backup** : Branch backup si corrections risquées

## 📁 Fichiers à Modifier (Estimation)

### Phase 1 (Correction 3)
- `src/services/TraceSummaryService.ts` - Parser principal ⚠️ CRITIQUE
- Possiblement `tests/fixtures/trace-summary-fixtures.ts`
- Possiblement assertions dans `tests/unit/services/xml-parsing.test.ts`

### Phase 2 (Corrections 4-5)
**Correction 4** (12 fichiers) :
- `tests/unit/services/conversation-tree.service.test.ts`
- `tests/unit/services/hierarchy-reconstruction-engine.test.ts`
- `tests/unit/services/message-formatting.test.ts`
- `tests/unit/tools/manage-async-job.test.ts`
- `tests/unit/tools/view-conversation-tree.test.ts`
- Autres (voir `TEST_FAILURES_ROOT_CAUSES.md` Section 4)

**Correction 5** (8 fichiers) :
- `tests/unit/services/task-indexer.test.ts`
- `tests/unit/tools/roosync-*.test.ts` (plusieurs)
- API Gateway tests

## 🎯 Critères de Succès Session

### Phase 1 (Minimum Requis)
- ✅ 20/20 tests corrigés (Corrections 1-3)
- ✅ Tests : ≥392/478 (82%+)
- ✅ Compilation : 0 erreur
- ✅ Commits : Atomiques et documentés
- ✅ Rapport : `PHASE1_CORRECTIONS_COMPLETE_REPORT.md` créé

### Phase 2 (Optimal)
- ✅ 40/65 tests corrigés (Corrections 1-5)
- ✅ Tests : ≥412/478 (86%+)
- ✅ Compilation : 0 erreur
- ✅ Commits : Phase 1 + Phase 2 séparés
- ✅ Rapports : Phase 1 + Phase 2 complets
- ✅ Git : Synchronisé (push)

### Phase 3 (Stretch)
- ✅ 58+/65 tests corrigés
- ✅ Tests : ≥430/478 (90%+)
- ✅ Documentation : Roadmap Phase 4 créée

## 💡 Conseils Méthodologiques

### Debugging Efficace
1. **Isoler** : Tester 1 fichier à la fois
2. **Logger** : Ajouter logs détaillés si obscur
3. **Simplifier** : Tester avec données minimales
4. **Comparer** : Expected vs Received ligne par ligne
5. **Valider** : Chaque correction individuellement

### Gestion Complexité
- Parser XML = tâche la plus complexe
- Commencer frais et focus
- Ne pas sous-estimer temps requis
- Documenter blocages pour aide future

### Workflow Git
```powershell
# Avant modifications
git status  # Vérifier clean
git branch  # Vérifier branche

# Après corrections
npm run build  # Compiler
npm test       # Valider
git add .      # Stager changes
git status     # Vérifier fichiers
git commit -m "..." # Commit descriptif
git push       # Synchroniser
```

## 📚 Ressources Utiles

### Rapports à Consulter
1. `PHASE1_CORRECTIONS_PARTIAL_REPORT.md` - Vue globale session actuelle
2. `TEST_FAILURES_ROOT_CAUSES.md` - Analyse détaillée 7 causes racines
3. `BATCH10_DEAD_CODE_REMOVAL_REPORT.md` - Context suppressions récentes
4. `FUNCTIONAL_REDUNDANCY_ANALYSIS.md` - Background redondances

### Commandes Utiles
```powershell
# Compilation
npm run build

# Tests complets
npm test

# Tests spécifiques
npm test -- tests/unit/services/xml-parsing.test.ts

# Tests avec logs détaillés
npm test -- --reporter=verbose tests/unit/services/xml-parsing.test.ts

# Capturer logs
npm test 2>&1 | Out-File -FilePath test-output.log

# Git status
git status
git log --oneline -5
git diff
```

### Documentation Vitest
- [Mocking](https://vitest.dev/guide/mocking.html)
- [API Reference](https://vitest.dev/api/)
- [Configuration](https://vitest.dev/config/)

## 🔄 Plan Reprise Si Interruption

Si session interrompue avant fin :

1. **Commit WIP** (Work In Progress)
   ```powershell
   git add .
   git commit -m "wip: corrections in progress - X tests fixed"
   git push
   ```

2. **Créer rapport partiel**
   - `PHASE_X_PARTIAL_REPORT.md`
   - Noter progression exacte
   - Lister tests restants

3. **Mettre à jour checklist**
   - Cocher items complétés
   - Noter temps écoulé
   - Estimer temps restant

4. **Sauvegarder contexte**
   - Logs debug en cours
   - Hypothèses non validées
   - Pistes à explorer

## 📅 Timeline Suggérée

```
00:00 - 00:15 | Préparation + Lecture rapports
00:15 - 02:15 | Phase 1 - Parser XML (focus)
02:15 - 02:30 | Validation Phase 1 + Commit
02:30 - 02:40 | Break
02:40 - 04:40 | Phase 2 - Assertions (12 tests)
04:40 - 05:40 | Phase 2 - Mocks (8 tests)
05:40 - 06:00 | Validation Phase 2 + Commits
06:00 - 06:15 | Synchronisation Git + Rapports
```

**Total** : ~6h pour Phase 1 + Phase 2 complètes

---

**Prêt à démarrer** : 
1. ✅ Lire ce plan (temps : 10 min)
2. ✅ Lire `PHASE1_CORRECTIONS_PARTIAL_REPORT.md` (temps : 5 min)
3. ✅ Compiler et baseline tests (temps : 5 min)
4. 🚀 Commencer Correction 3 (Parser XML)

**Session estimée** : 2-6h selon objectifs  
**Préparation requise** : 15-20 min  
**Matériel requis** : Focus, café, logs activés ☕  

**Bonne chance! 🚀**