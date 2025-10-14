# Arbre de Décision Quickfiles

## Diagramme

```mermaid
graph TD
    A[Opération sur fichier(s)?] --> B{Combien de fichiers?}
    B -->|1 fichier| C[Outils Natifs]
    B -->|2+ fichiers| D[Quickfiles MCP]
    
    C --> E{Type d'opération?}
    E -->|Lecture| F[read_file<br/>~2000 tokens/fichier]
    E -->|Écriture| G[write_to_file<br/>~3000 tokens/fichier]
    E -->|Édition| H[apply_diff<br/>~2500 tokens/fichier]
    
    D --> I{Type d'opération?}
    I -->|Lecture| J[read_multiple_files<br/>~500 tokens/fichier<br/>💰 Économie: 75%]
    I -->|Édition patterns| K[edit_multiple_files<br/>~600 tokens/fichier<br/>💰 Économie: 75%]
    I -->|Recherche| L[search_in_files<br/>~300 tokens total<br/>💰 Économie: 80%]
    I -->|Exploration| M[list_directory_contents<br/>~800 tokens total<br/>💰 Économie: 84%]
    I -->|Copie| N[copy_files<br/>~400 tokens/fichier<br/>💰 Économie: 60%]
    I -->|Déplacement| O[move_files<br/>~400 tokens/fichier<br/>💰 Économie: 60%]
    I -->|Suppression| P[delete_files<br/>~200 tokens/fichier<br/>💰 Économie: 50%]

    style D fill:#90EE90
    style J fill:#90EE90
    style K fill:#90EE90
    style L fill:#90EE90
    style M fill:#90EE90
```

## Exemples de Calcul d'Économie

### Scénario 1 : Lire 5 fichiers
**Natif** : 5 × read_file = 5 × 2000 = 10,000 tokens  
**Quickfiles** : 1 × read_multiple_files = 5 × 500 = 2,500 tokens  
**💰 Économie** : 7,500 tokens (75%)

### Scénario 2 : Éditer même pattern dans 8 fichiers
**Natif** : 8 × write_to_file = 8 × 3000 = 24,000 tokens  
**Quickfiles** : 1 × edit_multiple_files = 8 × 600 = 4,800 tokens  
**💰 Économie** : 19,200 tokens (80%)

### Scénario 3 : Explorer projet (15 répertoires)
**Natif** : 15 × list_files = 15 × 500 = 7,500 tokens  
**Quickfiles** : 1 × list_directory_contents = 1 × 1,200 = 1,200 tokens  
**💰 Économie** : 6,300 tokens (84%)

## Seuils de Décision

| Nombre de fichiers | Outil recommandé | Économie attendue |
|-------------------|------------------|-------------------|
| 1 fichier | Outils natifs | N/A (baseline) |
| 2 fichiers | Quickfiles si même opération | ~40-50% |
| 3+ fichiers | **Quickfiles fortement recommandé** | **70-90%** |
| 10+ fichiers | **Quickfiles obligatoire** | **85-95%** |