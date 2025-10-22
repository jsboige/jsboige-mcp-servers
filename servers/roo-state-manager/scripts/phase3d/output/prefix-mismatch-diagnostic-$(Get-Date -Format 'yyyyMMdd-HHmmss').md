# Diagnostic SDDD - Prefix Matching Mismatch dans Reconstruction Hiérarchique

**Mission** : Diagnostic et correction des problèmes de prefix matching  
**Timestamp** : 2025-10-19T20:15:00Z  
**Mode** : Debug Complex avec double grounding SDDD  

## 🎯 PROBLÈME IDENTIFIÉ

### Mismatch Fondamental : Indexation vs Recherche

**Le problème critique identifié :**

1. **Indexation (Phase 1)** : Les parents indexent les **contenus des balises `<new_task>`** extraits de leurs instructions
2. **Recherche (Phase 2)** : Les enfants recherchent avec leur **instruction complète normalisée**

**Exemple concret du mismatch :**
```
Indexé (parent) : "test-branch-a: crée le fichier branch-a..."
Recherche (enfant) : "TEST-BRANCH-A: Tu es la branche A de la hiérarchie de test..."
```

### Racine Technique du Problème

Dans [`computeInstructionPrefix()`](mcps/internal/servers/roo-state-manager/src/utils/task-instruction-index.ts:506-525) :

```typescript
// 4) SDDD: Extraire et préserver le contenu des balises <new_task>
const newTaskContents: string[] = [];
const newTaskRegex = /<\s*new_task\b[^>]*>([\s\S]*?)<\s*\/\s*new_task\s*>/gi;
s = s.replace(newTaskRegex, (match, content) => {
    const cleanedContent = content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    if (cleanedContent) {
        newTaskContents.push(cleanedContent);
        console.log(`SDDD: Extracted new_task content: "${cleanedContent.substring(0, 50)}..."`);
    }
    return ' '; // Remplacer la balise par un espace
});
```

**Conséquence** : Les parents indexent uniquement les contenus extraits des `<new_task>`, pas leurs instructions complètes.

### Logique de Recherche Actuelle

Dans [`searchExactPrefix()`](mcps/internal/servers/roo-state-manager/src/utils/task-instruction-index.ts:127-184) :

```typescript
const fullSearchPrefix = computeInstructionPrefix(childText, K);
// Utilise getWithCheckpoints() pour EXACT PREFIX MATCH
const entry = this.trie.getWithCheckpoints(searchPrefix) as PrefixEntry | undefined;
```

**Problème** : Les enfants recherchent avec leur instruction complète, mais l'index ne contient que les fragments `<new_task>` des parents.

## 🔍 ANALYSE SÉMANTIQUE COMPLÉMENTAIRE

### Résultats de la Recherche Sémantique

La recherche sur `"prefix matching hierarchy reconstruction searchExactPrefix"` a révélé :

1. **Documentation de correction existante** dans [`BUGS-ET-RESOLUTIONS.md`](mcps/internal/servers/roo-state-manager/docs/BUGS-ET-RESOLUTIONS.md:169-213)
2. **Tests unitaires** qui montrent le comportement attendu dans [`hierarchy-pipeline.test.ts`](mcps/internal/servers/roo-state-manager/tests/unit/hierarchy-pipeline.test.ts:85-99)
3. **Logs SDDD** qui confirment le problème dans les tests de reconstruction

### Patterns Identifiés

- **Préfixes indexés** : Contenus extraits des `<new_task>` (courts, spécifiques)
- **Instructions recherchées** : Instructions complètes des enfants (longues, descriptives)
- **Taux de reconstruction actuel** : 0% (aucun match trouvé)

## 🛠️ STRATÉGIE DE CORRECTION SDDD

### Approche 1 : Inverser la Logique d'Indexation

**Modifier `computeInstructionPrefix()` pour :**
1. Indexer les instructions complètes des parents (pas seulement les `<new_task>`)
2. Extraire les `<new_task>` uniquement pour le contenu contextuel

### Approche 2 : Adapter la Logique de Recherche

**Modifier `searchExactPrefix()` pour :**
1. Rechercher avec des fragments extraits des instructions enfants
2. Utiliser une stratégie de matching plus flexible

### Approche 3 : Double Indexation (Recommandée)

**Créer deux index séparés :**
1. **Index des instructions parentes** : Pour matching direct
2. **Index des contenus `<new_task>`** : Pour validation contextuelle

## 📋 PLAN D'ACTION SDDD

### Phase 2.3 : Correction Immédiate
1. **Modifier `computeInstructionPrefix()`** pour indexer les instructions parentes complètes
2. **Préserver l'extraction `<new_task>`** pour le contexte
3. **Tester la correction** avec le test cible

### Phase 2.4 : Checkpoint SDDD
1. **Recherche sémantique** sur `"stratégies de matching parent-enfant"`
2. **Validation** de l'approche correctionnelle
3. **Documentation** des changements

### Phase 2.5 : Validation
1. **Exécuter le test** avec `ROO_DEBUG_INSTRUCTIONS=1`
2. **Vérifier le taux** de reconstruction
3. **Analyser les logs** pour confirmation

## 🎯 OBJECTIF DE RECONSTRUCTION

**Cible** : 100% de reconstruction des relations parent-enfant  
**Métrique actuelle** : 0%  
**Métrique attendue** : ≥ 95% après correction  

## 📊 GROUNDING TRIPLE

### Grounding Sémantique ✅
- Recherche sur `"prefix matching hierarchy reconstruction searchExactPrefix"`
- Analyse des implémentations dans `hierarchy-reconstruction-engine.ts` et `task-instruction-index.ts`
- Identification du mismatch fondamental

### Grounding Conversationnel ✅
- Analyse de l'historique via `view_conversation_tree`
- Compréhension du contexte Phase 3D
- Alignement avec les objectifs de reconstruction hiérarchique

### Grounding Technique ✅
- Examen du code source des fonctions critiques
- Analyse de la logique d'indexation vs recherche
- Identification de la racine du problème dans `computeInstructionPrefix()`

---
*Diagnostic généré par SDDD Phase 3D - Mode Debug Complex*