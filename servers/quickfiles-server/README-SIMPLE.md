# QuickFiles MCP - Guide Rapide ⚡

## 💡 Quand l'utiliser ?

### ✅ Utilisez Quickfiles si :
- Vous lisez **3+ fichiers** → `read_multiple_files` (économie 70-90% tokens)
- Vous éditez **le même pattern dans plusieurs fichiers** → `edit_multiple_files` (économie 75% tokens)
- Vous explorez **un projet récursivement** → `list_directory_contents` (économie 84% tokens)
- Vous cherchez **dans plusieurs fichiers** → `search_in_files` (économie 80% tokens)

### ❌ N'utilisez PAS Quickfiles si :
- **Un seul fichier simple** → Utiliser `read_file` ou `write_to_file` natif
- **Édition complexe avec logique** → Utiliser `apply_diff` natif
- **Fichiers binaires** → Non supporté par quickfiles

---

## 🚀 Top 3 Use Cases avec Économies

### 1. Refactorisation Multi-Fichiers
**Scénario** : Remplacer `console.log` par `logger.debug` dans 5 fichiers TypeScript

**Avant (outils natifs)** : 5 appels `write_to_file` séparés
- **Coût** : ~8,000 tokens
- **Temps** : 5 aller-retours

**Avec quickfiles** : 1 appel `edit_multiple_files`
- **Coût** : ~2,000 tokens
- **Temps** : 1 aller-retour
- **💰 Économie** : 75% de tokens, 80% plus rapide

**Exemple d'utilisation** :
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
    },
    {
      "path": "src/controllers/user.ts",
      "diffs": [{"search": "console.log", "replace": "logger.debug"}]
    }
  ]
}
</arguments>
</use_mcp_tool>
```

### 2. Analyse de Logs Multi-Fichiers
**Scénario** : Analyser erreurs dans 10 fichiers de logs

**Avant (outils natifs)** : 10 appels `read_file` complets
- **Coût** : ~15,000 tokens (logs verbeux)
- **Problème** : Lit tout même si seules erreurs intéressantes

**Avec quickfiles** : 1 appel `read_multiple_files` avec excerpts
- **Coût** : ~1,500 tokens
- **Temps** : 1 aller-retour
- **💰 Économie** : 90% de tokens

**Exemple d'utilisation** :
```xml
<use_mcp_tool>
<server_name>quickfiles</server_name>
<tool_name>read_multiple_files</tool_name>
<arguments>
{
  "paths": [
    "logs/app-2025-10-10.log",
    "logs/app-2025-10-11.log",
    "logs/app-2025-10-12.log"
  ],
  "excerpt_options": {
    "type": "lines",
    "num_lines": 50,
    "position": "end"
  }
}
</arguments>
</use_mcp_tool>
```

### 3. Exploration Récursive de Projet
**Scénario** : Explorer structure d'un projet inconnu

**Avant (outils natifs)** : 10+ appels `list_files` récursifs
- **Coût** : ~5,000 tokens
- **Problème** : Appels multiples pour chaque niveau

**Avec quickfiles** : 1 appel `list_directory_contents` récursif
- **Coût** : ~800 tokens
- **Temps** : 1 aller-retour
- **💰 Économie** : 84% de tokens

**Exemple d'utilisation** :
```xml
<use_mcp_tool>
<server_name>quickfiles</server_name>
<tool_name>list_directory_contents</tool_name>
<arguments>
{
  "path": "./src",
  "recursive": true,
  "max_depth": 3,
  "include_file_info": true
}
</arguments>
</use_mcp_tool>
```

---

## 📊 Guide de Décision Rapide

```
Combien de fichiers ?
├── 1 fichier → Outils Natifs (read_file, write_to_file)
└── 2+ fichiers → Quickfiles MCP
    ├── Lecture → read_multiple_files
    ├── Édition patterns → edit_multiple_files
    ├── Recherche → search_in_files
    └── Exploration → list_directory_contents
```

---

## 🛠️ Outils Disponibles

| Outil | Quand l'utiliser | Économie typique |
|-------|------------------|------------------|
| `read_multiple_files` | Lire 2+ fichiers | 70-90% |
| `edit_multiple_files` | Même modif dans plusieurs fichiers | 75% |
| `list_directory_contents` | Explorer projet récursivement | 84% |
| `search_in_files` | Chercher pattern multi-fichiers | 80% |
| `copy_files` | Copier plusieurs fichiers | 60% |
| `move_files` | Déplacer plusieurs fichiers | 60% |
| `delete_files` | Supprimer plusieurs fichiers | 50% |
| `extract_markdown_structure` | Parser TOC Markdown | N/A |
| `search_and_replace` | Regex multi-fichiers | 75% |
| `restart_mcp_servers` | Redémarrer serveurs MCP | N/A |

---

## ⚡ Mémo Rapide

**Règle d'or** : Si vous vous apprêtez à appeler le même outil natif 3+ fois, demandez-vous si quickfiles ne le fait pas en 1 seul appel.

**Pour plus de détails techniques** : Voir `docs/TECHNICAL-DETAILS.md`