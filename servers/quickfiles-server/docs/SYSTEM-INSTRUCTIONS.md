# Instructions Système - Intégration Quickfiles

## Pour Integration dans les Modes Roo

Ajouter cette section dans les instructions système de chaque mode :

---

## 📂 QUICKFILES MCP - Guide de Décision

### Quand Utiliser Quickfiles ?

**Règle Générale** : Si vous vous apprêtez à appeler le même outil natif 3+ fois, utilisez quickfiles à la place.

### Seuils de Décision par Opération

#### Lecture de Fichiers
```
1-2 fichiers → read_file natif
3+ fichiers  → use_mcp_tool quickfiles read_multiple_files
```
**Économie** : 70-90% de tokens

**Exemple** :
```xml
<use_mcp_tool>
<server_name>quickfiles</server_name>
<tool_name>read_multiple_files</tool_name>
<arguments>
{
  "paths": ["src/a.ts", "src/b.ts", "src/c.ts"]
}
</arguments>
</use_mcp_tool>
```

#### Édition Multi-Fichiers
```
Même pattern dans 1 fichier → write_to_file natif
Même pattern dans 2+ fichiers → use_mcp_tool quickfiles edit_multiple_files
```
**Économie** : 75% de tokens

**Exemple** :
```xml
<use_mcp_tool>
<server_name>quickfiles</server_name>
<tool_name>edit_multiple_files</tool_name>
<arguments>
{
  "files": [
    {
      "path": "src/utils/logger.ts",
      "diffs": [{"search": "console.log", "replace": "logger.debug"}]
    },
    {
      "path": "src/services/api.ts",
      "diffs": [{"search": "console.log", "replace": "logger.debug"}]
    }
  ]
}
</arguments>
</use_mcp_tool>
```

#### Exploration de Projet
```
1 répertoire non-récursif → list_files natif
Exploration récursive → use_mcp_tool quickfiles list_directory_contents
```
**Économie** : 84% de tokens

**Exemple** :
```xml
<use_mcp_tool>
<server_name>quickfiles</server_name>
<tool_name>list_directory_contents</tool_name>
<arguments>
{
  "path": "./src",
  "recursive": true,
  "max_depth": 3
}
</arguments>
</use_mcp_tool>
```

#### Recherche Multi-Fichiers
```
1-2 fichiers → read_file + analyse
3+ fichiers OU recherche pattern → use_mcp_tool quickfiles search_in_files
```
**Économie** : 80% de tokens

### Checklist Avant d'Utiliser Outils Natifs

Avant d'utiliser `read_file`, `write_to_file`, ou `list_files` plusieurs fois :

- [ ] Est-ce que je vais appeler cet outil 3+ fois ?
- [ ] Est-ce que je fais la même opération sur plusieurs fichiers ?
- [ ] Est-ce que quickfiles a un outil équivalent ?

**Si OUI à au moins 2 questions → Utilisez quickfiles**

---

## Version Complète pour Intégration Directe

Voici le texte complet à ajouter dans les instructions système :

```markdown
## QUICKFILES MCP - UTILISATION OPTIMALE

### Règle d'Or
Si vous vous apprêtez à utiliser le même outil natif (read_file, write_to_file, list_files) 3+ fois, utilisez quickfiles à la place pour économiser 70-90% de tokens.

### Quand Utiliser Quickfiles

**Lecture Multi-Fichiers** (3+ fichiers)
- Utilisez `read_multiple_files` au lieu de multiples `read_file`
- Économie : 70-90% de tokens
- Exemple : `<use_mcp_tool><server_name>quickfiles</server_name><tool_name>read_multiple_files</tool_name><arguments>{"paths": ["a.ts", "b.ts", "c.ts"]}</arguments></use_mcp_tool>`

**Édition Pattern Multi-Fichiers** (2+ fichiers avec même modification)
- Utilisez `edit_multiple_files` au lieu de multiples `write_to_file`
- Économie : 75% de tokens
- Exemple : Remplacer `console.log` par `logger.debug` dans 5 fichiers en 1 appel

**Exploration Récursive**
- Utilisez `list_directory_contents` au lieu de multiples `list_files`
- Économie : 84% de tokens
- Exemple : Explorer toute l'arborescence `./src` en 1 appel avec `recursive: true`

**Recherche Multi-Fichiers**
- Utilisez `search_in_files` pour chercher un pattern dans plusieurs fichiers
- Économie : 80% de tokens

### Checklist Décision Rapide
Avant d'utiliser un outil natif répétitivement, demandez-vous :
1. Vais-je l'appeler 3+ fois ?
2. Est-ce la même opération sur plusieurs fichiers ?
3. Quickfiles peut-il le faire en 1 appel ?

Si OUI à 2+ questions → **Utilisez quickfiles**
```

## Tableau de Référence Rapide

| Opération | Seuil | Outil Quickfiles | Économie |
|-----------|-------|------------------|----------|
| Lecture fichiers | 3+ | `read_multiple_files` | 70-90% |
| Édition patterns | 2+ | `edit_multiple_files` | 75% |
| Exploration projet | Récursif | `list_directory_contents` | 84% |
| Recherche multi-fichiers | 3+ | `search_in_files` | 80% |
| Copie fichiers | 2+ | `copy_files` | 60% |
| Déplacement fichiers | 2+ | `move_files` | 60% |
| Suppression fichiers | 2+ | `delete_files` | 50% |

## Notes d'Implémentation

### Pour les Développeurs de Modes

1. **Intégration dans les Instructions** : Copiez la section "Version Complète" ci-dessus dans les instructions système de votre mode.

2. **Emplacement Recommandé** : Ajoutez cette section après les descriptions des outils natifs, avant les règles d'utilisation.

3. **Adaptation par Mode** :
   - **Mode Code** : Emphase sur `edit_multiple_files` et `read_multiple_files`
   - **Mode Architect** : Emphase sur `list_directory_contents` et exploration
   - **Mode Debug** : Emphase sur `search_in_files` et analyse de logs
   - **Mode Ask** : Emphase sur `read_multiple_files` pour analyse

4. **Testing** : Après intégration, vérifiez que les modes utilisent quickfiles pour les opérations multi-fichiers.

### Métriques de Succès

Après intégration, suivez ces métriques :
- Réduction du nombre d'appels aux outils natifs répétitifs
- Économies de tokens sur les tâches multi-fichiers
- Temps de réponse plus rapide (moins d'aller-retours)
- Taux d'utilisation de quickfiles vs outils natifs

**Objectif** : 30-40% d'utilisation de quickfiles pour les opérations multi-fichiers.