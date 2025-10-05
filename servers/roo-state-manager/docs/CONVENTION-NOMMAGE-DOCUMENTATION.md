# 📋 CONVENTION DE NOMMAGE - DOCUMENTATION ROO-STATE-MANAGER

**Date de création :** 04/10/2025  
**Version :** 1.0  
**Statut :** 🟢 ACTIF

---

## 🎯 OBJECTIF

Standardiser l'organisation de toute la documentation avec un système d'horodatage et de numérotation cohérent permettant une navigation chronologique claire.

## 📐 FORMAT STANDARDISÉ

```
YYYY-MM-DD-XX-TYPE-DESCRIPTIF.md

Où :
- YYYY-MM-DD : Date de création/mission (ISO 8601)
- XX : Numéro séquentiel sur la journée (01, 02, 03...)
- TYPE : Catégorie du document
- DESCRIPTIF : Nom explicite court (kebab-case)
```

## 📊 TYPES DE DOCUMENTS

### **RAPPORT** - Rapports de mission et de validation
- `2025-10-01-01-RAPPORT-validation-phase-2a.md`
- `2025-10-02-02-RAPPORT-final-mission-sddd.md`

### **DOC-TECH** - Documentation technique et spécifications
- `2025-09-28-01-DOC-TECH-architecture-parsing.md`
- `2025-09-30-02-DOC-TECH-api-export-xml.md`

### **PHASE** - Documents de phases projet
- `2025-05-26-01-PHASE-2a-implementation.md`
- `2025-05-26-02-PHASE-2b-validation.md`

### **SUIVI** - Suivi de mission et debug
- `2025-10-01-03-SUIVI-debug-hierarchie.md`
- `2025-10-03-01-SUIVI-investigation-parentid.md`

### **PLAN** - Plans d'action et d'investigation
- `2025-10-03-04-PLAN-investigation-phase-2c.md`
- `2025-10-02-01-PLAN-reorganisation-tests.md`

### **SYNTH** - Synthèses et consolidations
- `2025-10-04-01-SYNTH-phase-2c-final.md`
- `2025-10-02-03-SYNTH-consolidation-docs.md`

## 🗂️ STRUCTURE DE RÉPERTOIRES

```
docs/
├── archives/           # Documents chronologiques horodatés
│   ├── 2025-09/       # Mois de septembre 2025
│   ├── 2025-10/       # Mois d'octobre 2025
│   └── ...
├── active/            # Documents de référence actifs
│   ├── README-STATUS.md
│   └── INDEX-DOCUMENTATION.md
└── templates/         # Templates pour nouveaux documents
    ├── rapport-template.md
    ├── doc-tech-template.md
    └── plan-template.md
```

## 📈 RÈGLES DE NUMÉROTATION

### **Numérotation Journalière**
- Premier document du jour : `01`
- Deuxième document du jour : `02`
- etc.

### **Gestion des Missions Multi-Documents**
- Même mission = même date, numéros séquentiels
- Exemple Phase 2C :
  ```
  2025-10-03-07-PLAN-investigation-phase-2c.md
  2025-10-03-08-RAPPORT-stats-parentid-phase-2c.md
  2025-10-04-01-SYNTH-phase-2c-final.md
  ```

## 🔄 RÈGLES DE MIGRATION

### **Documents Existants**
1. **Analyser la date de création réelle** (via git log ou métadonnées)
2. **Attribuer la date chronologique logique** selon le contenu
3. **Conserver l'ordre des séries** (Phase 1 → Phase 2 → etc.)

### **Nouveaux Documents**
- Toujours utiliser la date du jour
- Incrémenter le numéro séquentiel
- Respecter le type approprié

## 📋 INDEX ET NAVIGATION

### **Fichier INDEX Principal**
[`active/INDEX-DOCUMENTATION.md`](active/INDEX-DOCUMENTATION.md) contient :
- **Table chronologique** avec liens
- **Résumé d'une ligne** par document
- **Statut et priorité** de chaque document

### **Navigation Rapide**
- **Par date :** `archives/YYYY-MM/`
- **Par type :** Filtrage dans l'index
- **Par mission :** Recherche par descriptif

## ✅ AVANTAGES

- 🕐 **Navigation chronologique** claire
- 🔍 **Recherche facilitée** par date et type
- 📊 **Évolutivité** (ajout de nouveaux types)
- 🎯 **Cohérence** dans l'écosystème
- 📈 **Maintenabilité** à long terme

---

**Cette convention sera appliquée lors de la réorganisation complète de la documentation.**