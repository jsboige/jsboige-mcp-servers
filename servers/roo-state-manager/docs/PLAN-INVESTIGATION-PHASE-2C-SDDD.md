# 🔍 PLAN INVESTIGATION PHASE 2c - Root Cause Analysis

## 📋 Contexte Critique
**Date:** 2025-10-03  
**Contexte:** Incompatibilités comportementales majeures découvertes (44.44% similarité vs 90% requis)  
**Status:** Déploiement suspendu, nouveau système verrouillé  
**Document Alerte:** [PHASE-2B-COMPATIBILITY-ALERT.md](./PHASE-2B-COMPATIBILITY-ALERT.md)

---

## 🎯 Objectifs Phase 2c

### Objectif Principal
**Identifier et résoudre les root causes des incompatibilités comportementales** entre ancien et nouveau système de parsing pour atteindre >90% de similarité ou valider business case pour nouveau comportement.

### Objectifs Spécifiques
1. **Root Cause Analysis** : Identifier l'origine des différences de message count (-18% à -30%)
2. **Child Tasks Investigation** : Analyser l'extraction 0 → 28 child tasks
3. **Business Validation** : Déterminer si nouvelles logiques sont acceptables
4. **Seuils Calibrage** : Ajuster les seuils de tolérance selon findings

---

## 📊 Données de Validation Massive

### Métriques Critiques Identifiées
```
Similarité globale:     44.44% ❌ (90% requis)
Message count variations: -18% à -30% ❌
Child tasks extraction:   0 → 28 ❌ (changement majeur)
Error count:             0 ✅ (aucune erreur technique)
```

### Fixtures Affectées
- **controlled-hierarchy/** : Impact majeur extraction hierarchies
- **real-tasks/** : Variations message count significatives
- **Comportements inattendus** : Patterns non anticipés en Phase 2b

---

## 🔬 Axes d'Investigation Prioritaires

### 1. **Message Count Analysis** (🔥 PRIORITÉ ABSOLUE)
**Symptôme :** Réduction -18% à -30% du nombre de messages

**Hypothèses à valider :**
- **H1 :** Filtrage plus agressif des messages "noise" (doublons, vides)
- **H2 :** Logique de regroupement messages différente 
- **H3 :** Parsing JSON strict élimine messages malformés
- **H4 :** Normalisation paths plus restrictive

**Actions d'investigation :**
```bash
# Tests spécifiques à créer
- test-message-count-delta.js
- test-filtering-differences.js  
- test-json-parsing-strictness.js
```

### 2. **Child Tasks Extraction** (🔥 PRIORITÉ ABSOLUE)
**Symptôme :** Extraction 0 → 28 child tasks (changement fondamental)

**Hypothèses à valider :**
- **H1 :** Nouveau système découvre child tasks non détectées avant
- **H2 :** Algorithme hiérarchique plus performant
- **H3 :** Regex ancien système défaillant pour certains patterns
- **H4 :** Nouveaux critères d'identification parent/child

**Actions d'investigation :**
```bash
# Analyses comparatives requises
- Audit manual fixtures controlled-hierarchy
- Trace debug ancien vs nouveau parsing
- Validation business logic child tasks
```

### 3. **Path Normalization** (🔶 PRIORITÉ HAUTE)
**Symptôme :** Différences normalisations paths

**Actions d'investigation :**
- Comparer logiques normalization Windows/POSIX
- Tester edge cases paths relatifs/absolus
- Validation consistency cross-platform

### 4. **Performance & Memory** (🔷 PRIORITÉ MOYENNE)
**Actions d'investigation :**
- Benchmark détaillé ancien vs nouveau
- Memory profiling grande dataset
- Optimisation points chauds identifiés

---

## 📅 Planning Investigation Phase 2c

### Semaine 1 : Root Cause Analysis
- **Jour 1-2 :** Setup environnement investigation + outils debug
- **Jour 3-4 :** Message count analysis approfondie
- **Jour 5 :** Child tasks extraction analysis + première synthèse

### Semaine 2 : Business Validation & Tests
- **Jour 1-2 :** Validation utilisateur nouvelles logiques
- **Jour 3-4 :** Tests A/B controlés sur fixtures sélectionnées
- **Jour 5 :** Calibrage seuils + décision stratégique

### Semaine 3 : Résolution & Validation
- **Jour 1-3 :** Implementation corrections OU validation business case
- **Jour 4-5 :** Tests validation finale + préparation Phase 2d

---

## 🧪 Tests et Validations

### Tests Techniques
```typescript
// Tests création prioritaire
test-root-cause-message-count.ts    // Investigation H1-H4 message count
test-child-tasks-detection.ts        // Validation extraction child tasks  
test-parsing-strictness.ts           // Impact JSON strict parsing
test-path-normalization.ts           // Consistency paths handling
test-performance-comparison.ts       // Benchmark détaillé
```

### Validation Business
- **User Acceptance Testing** sur nouveaux child tasks découverts
- **Impact Analysis** réduction message count sur workflows
- **Business Case** validation ou correction approche

### Tests de Régression
- **Full regression suite** sur toutes fixtures
- **Edge cases validation** patterns complexes
- **Cross-platform consistency** Windows/Linux/MacOS

---

## 🚦 Critères de Décision Phase 2c

### Scénario A : Correction Technique ✅
**Condition :** Root cause identifiée + solution technique viable
**Action :** Correction nouveau système + validation >90% similarité
**Timeline :** Passage en Phase 2d validation étendue

### Scénario B : Validation Business ✅
**Condition :** Différences justifiées business + validation utilisateur
**Action :** Ajustement seuils tolérance + documentation changements
**Timeline :** Passage en Phase 2d avec nouveaux critères

### Scénario C : Rollback Technique ❌
**Condition :** Incompatibilités irrésolues + impact business négatif
**Action :** Suspend nouveau système + planning refactoring
**Timeline :** Retour Phase 2b avec approche alternative

---

## 📋 Ressources et Outils

### Outils d'Investigation
```bash
# Scripts debug à créer
debug-parsing-comparison.js         # Comparaison side-by-side
analyze-fixtures-delta.js           # Analyse différences fixtures
trace-message-processing.js         # Trace complète processing
validate-child-hierarchy.js         # Validation hierarchies
```

### Documentation Technique
- **Architecture parsing systems** : roo-state-manager-parsing-refactoring.md
- **Validation massive rapport** : [RAPPORT-MISSION-VALIDATION-MASSIVE-SDDD-20251003.md](./RAPPORT-MISSION-VALIDATION-MASSIVE-SDDD-20251003.md)
- **Feature flags sécurisés** : [parsing-config.ts](../src/utils/parsing-config.ts)

### Environnement Sécurisé
- ✅ **Feature flags bloqués** via `PHASE_2C_INVESTIGATION_REQUIRED=true`
- ✅ **Scripts validation** disponibles (`validate-phase-2c-security.ps1`)
- ✅ **Documentation alertes** à jour

---

## 📊 Métriques de Succès

### Métriques Techniques
- **Similarité globale** : >90% OU validation business justifiée
- **Message count delta** : <5% OU logique métier validée  
- **Child tasks consistency** : Validation hiérarchie correcte
- **Performance** : Pas de régression >20%

### Métriques Business
- **User acceptance** : >80% validation nouvelles logiques
- **Workflow impact** : Aucun breaking change critique
- **Documentation** : 100% des changements documentés

### Métriques Opérationnelles  
- **Timeline** : Investigation complète en 2-3 semaines
- **Risk mitigation** : Zéro déploiement accidentel
- **Knowledge transfer** : Documentation complète pour équipe

---

## 🎯 Prochaines Étapes Immédiates

### Actions Prioritaires (Cette semaine)
1. **✅ Setup équipe investigation** (développeurs + business analysts)
2. **🔄 Création scripts debug** message count analysis 
3. **🔄 Audit manuel** fixtures controlled-hierarchy les plus impactées
4. **📋 Planning détaillé** semaine 1 investigation

### Validation Checkpoints
- **Checkpoint J+3** : Root cause hypotheses validées ou infirmées
- **Checkpoint J+7** : Business validation première conclusions  
- **Checkpoint J+14** : Décision stratégique finale (scénarios A/B/C)

---

## 🔐 Sécurité et Conformité

### Mesures de Protection
- ✅ **Nouveau système verrouillé** jusqu'à résolution complète
- ✅ **Ancien système protégé** et opérationnel  
- ✅ **Documentation alertes** visible et accessible
- ✅ **Scripts validation** automatisés et documentés

### Compliance SDDD
- **Documentation continue** : Tous findings documentés en temps réel
- **Grounding conversationnel** : Historique investigation préservé  
- **Validation Triple** : Technique + Business + Opérationnel
- **Risk mitigation** : Zéro impact production pendant investigation

---

**🎯 STATUS PHASE 2c : PRÊTE À DÉBUTER**  
**🔒 SÉCURITÉ : CONFIRMÉE ET VERROUILLÉE**  
**📋 DOCUMENTATION : COMPLÈTE ET À JOUR**