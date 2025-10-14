# 🎯 Smart Truncation Module

## Vue d'ensemble

Le module **Smart Truncation** implémente un algorithme intelligent de troncature pour l'outil `view_conversation_tree`. Il utilise un **gradient exponentiel** pour préserver intelligemment le contexte le plus important tout en respectant les limites de taille.

## 🏗️ Architecture

```
smart-truncation/
├── index.ts           # Point d'entrée principal avec handleSmartTruncation()
├── engine.ts          # Moteur principal avec algorithme de gradient
├── content-truncator.ts # Application des plans de troncature au contenu
├── types.ts           # Types TypeScript
├── __tests__/         # Tests unitaires
│   ├── engine.test.ts
│   └── content-truncator.test.ts
└── README.md          # Cette documentation
```

## 🧠 Algorithme de Gradient

### Principe Fondamental

L'algorithme calcule un **poids de préservation** pour chaque tâche selon sa position dans la chaîne :

```typescript
weight = Math.exp(-gradientStrength × distanceFromCenter²)
```

- **Début/Fin** : Poids élevé → Préservation maximale
- **Milieu** : Poids faible → Troncature intelligente

### Paramètres Configurables

```typescript
interface SmartTruncationConfig {
    maxOutputLength: number;       // Limite globale (défaut: 300K)
    gradientStrength: number;      // Force du gradient (défaut: 2.0)
    minPreservationRate: number;   // Préservation min (défaut: 0.9)
    maxTruncationRate: number;     // Troncature max (défaut: 0.7)
    contentPriority: {             // Priorités par type
        userMessages: number;      // Défaut: 1.0
        assistantMessages: number; // Défaut: 0.8
        actions: number;           // Défaut: 0.6
        metadata: number;          // Défaut: 0.4
    };
}
```

## 🔧 API Principale

### handleSmartTruncation()

Point d'entrée principal appelé depuis `view_conversation_tree` :

```typescript
export async function handleSmartTruncation(
    tasks: TaskSkeleton[],
    args: ViewConversationTreeArgs,
    view_mode: string,
    detail_level: string,
    max_output_length: number
): Promise<string>
```

### SmartTruncationEngine

Moteur principal de calcul :

```typescript
const engine = new SmartTruncationEngine(config);
const result = engine.apply(conversationSkeletons);
```

### ContentTruncator

Application des plans de troncature :

```typescript
const truncatedTasks = ContentTruncator.applyTruncationPlans(tasks, result.taskPlans);
```

## 📊 Méthodes de Troncature

### 1. Truncate Middle
Préserve début et fin, tronque le milieu :
```
Ligne 1
Ligne 2
Ligne 3

[... 15 lignes tronquées ...]

Ligne 18
Ligne 19
Ligne 20
```

### 2. Truncate End
Préserve seulement le début :
```
Ligne 1
Ligne 2
Ligne 3
[... contenu tronqué ...]
```

### 3. Summary
Génère un résumé intelligent (à implémenter) :
```
[Résumé intelligent du contenu original]
```

## 🎨 Placeholders Informatifs

Les sections tronquées sont remplacées par des placeholders explicites :

```
--- TRUNCATED: 45 messages (125.3KB) from middle section ---
```

Format : `--- TRUNCATED: {count} {type} ({size}) from {section} ---`

## 🔍 Exemples d'Usage

### Configuration Basique

```typescript
// Dans view_conversation_tree
const args = {
    task_id: "some-task",
    smart_truncation: true  // Active la troncature intelligente
};
```

### Configuration Avancée

```typescript
const args = {
    task_id: "some-task",
    smart_truncation: true,
    smart_truncation_config: {
        gradientStrength: 3.0,      // Gradient plus fort
        minPreservationRate: 0.95,  // Préservation plus élevée
        maxTruncationRate: 0.5,     // Troncature plus modérée
        contentPriority: {
            userMessages: 1.0,
            assistantMessages: 0.9,  // Priorité plus élevée
            actions: 0.7,
            metadata: 0.3
        }
    }
};
```

## 📈 Métriques et Diagnostics

Le résultat inclut des métriques détaillées :

```typescript
interface SmartTruncationResult {
    metrics: {
        totalTasks: number;
        originalTotalSize: number;
        finalTotalSize: number;
        compressionRatio: number;      // Taux de compression
        truncationByPosition: Record<number, number>;
    };
    diagnostics: string[];  // Messages de debug
}
```

## 🧪 Tests

### Tests Unitaires

```bash
# Depuis le répertoire racine du MCP
npm test -- --testPathPattern="smart-truncation"
```

### Tests Couverts

- **Engine Tests** : Algorithme de gradient, allocation de budget
- **ContentTruncator Tests** : Application des plans, méthodes de troncature
- **Edge Cases** : Gestion d'erreurs, cas limites

### Scénarios de Test

1. **Préservation gradient** : Premier/dernier > milieu
2. **Respect des limites** : minPreservation/maxTruncation
3. **Types de contenu** : Messages, actions, métadonnées
4. **Cas limites** : Tâche unique, contenu vide, très long

## 🚀 Performance

### Complexité

- **Temporelle** : O(n × m) où n = tâches, m = messages moyens
- **Spatiale** : O(n) pour les plans de troncature

### Optimisations

- Calcul de taille précis vs approximations
- Troncature par chunks pour gros contenus
- Cache des poids de gradient

## 🔧 Configuration Recommandée

### Conversations Courtes (< 10 tâches)
```typescript
{
    gradientStrength: 1.5,
    minPreservationRate: 0.95,
    maxTruncationRate: 0.4
}
```

### Conversations Longues (> 50 tâches)
```typescript
{
    gradientStrength: 2.5,
    minPreservationRate: 0.85,
    maxTruncationRate: 0.7
}
```

### Analyses Techniques
```typescript
{
    contentPriority: {
        userMessages: 1.0,
        assistantMessages: 0.9,
        actions: 0.8,
        metadata: 0.4
    }
}
```

## 🐛 Debug et Troubleshooting

### Diagnostics Activés

Les diagnostics sont inclus dans `result.diagnostics` :

```
Taille totale: 450000 chars, Limite: 300000, Surplus: 150000
Compression: 33.3%, Taille finale: 300000
```

### Logs de Debug

```typescript
// Activer les logs détaillés
const engine = new SmartTruncationEngine({
    ...config,
    debug: true  // Si implémenté
});
```

## 🔄 Migration depuis Legacy

### Rétrocompatibilité

```typescript
// Ancien comportement (défaut)
smart_truncation: false

// Nouveau comportement intelligent
smart_truncation: true
```

### Comparaison

| Aspect | Legacy | Smart Truncation |
|--------|--------|------------------|
| Méthode | Troncature brutale | Gradient intelligent |
| Contexte | Perdu aléatoirement | Préservé aux extrêmes |
| Feedback | Aucun | Placeholders explicites |
| Configuration | Limite fixe | Paramètres ajustables |

## 📝 Historique des Versions

### v1.0 (Initial)
- Algorithme de gradient exponentiel
- Support truncate_middle, truncate_end
- Tests unitaires complets
- Documentation complète

### Roadmap v1.1
- [ ] Méthode `summary` intelligente avec LLM
- [ ] Cache des calculs pour performance
- [ ] Métriques de qualité de troncature
- [ ] Interface de configuration UI

---

**Mission SDDD** : Refactorisation troncature intelligente view_conversation_tree  
**Date** : Octobre 2025  
**Status** : ✅ Implémenté et documenté