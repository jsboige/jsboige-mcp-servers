# Note Architecturale Batch 6 - Distinction Summary vs Synthesis

## 🔍 Découverte Importante

Pendant l'extraction des handlers du Batch 6, une **distinction architecturale critique** a été identifiée qui nécessitera une réorganisation future.

## 📊 Deux Systèmes Complémentaires

Ces deux systèmes ne sont pas isolés mais **travaillent en synergie** dans un workflow intégré.

### 1. **Summary** (Statistique sans LLM)
**Service:** `TraceSummaryService`

**Caractéristiques:**
- ❌ **Aucune utilisation de LLM**
- ✅ **Compacification statistique** avec troncature intelligente
- ✅ Génération de métriques, TOC, formatage Markdown
- ✅ Rapide, déterministe, sans coût API
- ✅ Utilisé pour : génération de résumés structurés, exports

**Outils concernés:**
- `generate_trace_summary` → Résumé d'une trace unique
- `generate_cluster_summary` → Résumé de cluster de tâches liées

### 2. **Synthesis** (Analyse sémantique avec LLM)
**Service:** `SynthesisOrchestratorService`

**Caractéristiques:**
- ✅ **Utilise un LLM** (GPT-4, GPT-5-mini, etc.)
- ✅ **Grounding de contexte** via `NarrativeContextBuilderService`
- ✅ Analyse sémantique riche et narrative
- ⚠️ Plus lent, coûteux en API, mais très riche en insights
- ✅ Utilisé pour : synthèses narratives, analyses approfondies

**Outils concernés:**
- `get_conversation_synthesis` → Synthèse narrative avec LLM

## 🔄 Workflow de Complémentarité

### Pipeline Intégré
```
1. [Synthesis] → Génère synthèse riche via LLM
                 └─> Sauvegardée dans skeleton.json
                 
2. [Summary]   → Lit les synthèses des skeletons
                 └─> Génère résumés compacts (TOC, métriques)
                 
3. [Export]    → Utilise Summary pour exports optimisés
```

### Stockage dans Skeletons

Les synthèses générées par `SynthesisOrchestratorService` sont **persistées** dans les fichiers de squelettes :

```json
{
  "taskId": "abc-123",
  "synthesis": {
    "initialContextSummary": "...",
    "finalTaskSummary": "...",
    "analysisEngineVersion": "2.0.0"
  }
}
```

### Réutilisation par Summary

`TraceSummaryService` peut **lire ces synthèses** pour :
- Enrichir les résumés avec des insights LLM
- Éviter des re-calculs coûteux
- Offrir des résumés hybrides (stats + sémantique)

### Avantages de la Complémentarité

1. **Performance** : Summary rapide pour consultation fréquente
2. **Richesse** : Synthesis coûteux mais très informatif
3. **Hybride** : Summary peut incorporer les synthèses existantes
4. **Évolutif** : Les synthèses s'accumulent et enrichissent la base

## 🏗️ Structure Actuelle (Batch 6)

```
tools/
└── summary/                              # ⚠️ Mélange Summary + Synthesis
    ├── generate-trace-summary.tool.ts    # Summary (sans LLM)
    ├── generate-cluster-summary.tool.ts  # Summary (sans LLM)
    └── get-conversation-synthesis.tool.ts # Synthesis (AVEC LLM) ⚠️
```

## 🎯 Structure Idéale (Recommandation)

```
tools/
├── summary/                              # Statistiques sans LLM
│   ├── generate-trace-summary.tool.ts
│   └── generate-cluster-summary.tool.ts
└── synthesis/                            # Analyses avec LLM
    └── get-conversation-synthesis.tool.ts
```

## ⚖️ Décision Batch 6

**Pour ce Batch 6**, nous avons décidé de :
1. ✅ **Maintenir la structure actuelle** (summary/ contient tout)
2. ✅ **Documenter la distinction** dans cette note
3. ✅ **Valider que tout fonctionne** (compilation + tests)
4. ✅ **Commiter avec cette note**

**Raison:** Éviter un scope creep pendant le refactoring. La séparation Summary/Synthesis peut être faite dans un Batch futur dédié.

## 📝 Batch Futur Recommandé: "Batch 6B - Séparation Synthesis"

**Objectif:** Extraire `get-conversation-synthesis.tool.ts` vers `tools/synthesis/`

**Avantages:**
- Séparation claire des responsabilités
- Architecture plus maintenable
- Meilleure compréhension du code

**Complexité:** FAIBLE (déplacement de fichier + mise à jour des imports)

## 🔗 Références Techniques

### TraceSummaryService
- Fichier: `src/services/TraceSummaryService.ts`
- Méthodes: `generateSummary()`, `generateClusterSummary()`
- Pas de dépendance LLM

### SynthesisOrchestratorService
- Fichier: `src/services/synthesis/SynthesisOrchestratorService.ts`
- Dépendances: `NarrativeContextBuilderService`, `LLMService`
- Méthodes: `synthesizeConversation()`, `startBatchSynthesis()`

## ✅ Validation Batch 6

- [x] Tous les outils extraits et fonctionnels
- [x] Compilation TypeScript réussie
- [x] Tests manuels validés (3/3 outils)
- [x] Serveur démarre correctement
- [x] Documentation architecturale créée

---

**Date:** 2025-10-13  
**Auteur:** Roo Code Mode  
**Batch:** 6 - Summary & Synthesis Extraction