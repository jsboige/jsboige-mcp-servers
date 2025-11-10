# QuickFiles MCP - Guide Rapide ⚡

## 💡 Quand l'utiliser ?

### ✅ Utilisez Quickfiles si :
- Vous lisez **un ou plusieurs fichiers** → `read_multiple_files`
- Vous éditez **le même pattern dans un ou plusieurs fichiers** → `edit_multiple_files`
- Vous explorez **un projet récursivement** → `list_directory_contents`
- Vous cherchez **dans un ou plusieurs fichiers** → `search_in_files`
- Vous faites des **recherches-remplacements globaux** → `search_and_replace` (NOUVEAU)

### ❌ N'utilisez PAS Quickfiles si :
- **Un seul fichier simple** → Utiliser `read_file` ou `write_to_file` natif
- **Édition complexe avec logique** → Utiliser `apply_diff` natif
- **Fichiers binaires** → Non supporté par quickfiles

---

## 🚀 Top 3 Use Cases

### 1. Refactorisation Multi-Fichiers
**Scénario** : Remplacer `console.log` par `logger.debug` dans 5 fichiers TypeScript

**Avant (outils natifs)** : 5 appels `write_to_file` séparés
- **Temps** : 5 aller-retours

**Avec quickfiles** : 1 appel `edit_multiple_files`
- **Temps** : 1 aller-retour

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
- **Problème** : Lit tout même si seules erreurs intéressantes

**Avec quickfiles** : 1 appel `read_multiple_files` avec excerpts
- **Temps** : 1 aller-retour

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
- **Problème** : Appels multiples pour chaque niveau

**Avec quickfiles** : 1 appel `list_directory_contents` récursif
- **Temps** : 1 aller-retour

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
Type d'opération ?
├── Lecture → read_multiple_files
├── Édition patterns → edit_multiple_files
├── Recherche → search_in_files
└── Exploration → list_directory_contents
```

---

## 🛠️ Outils Disponibles

| Outil | Description | Quand l'utiliser |
|-------|-------------|------------------|
| 🚀 `read_multiple_files` | Lit un ou plusieurs fichiers en une seule opération | Revues de code, analyse de logs, exploration |
| 📁 `list_directory_contents` | Exploration récursive de projets | Structure de projet, localisation de fichiers |
| ✏️ `edit_multiple_files` | Refactorisation de fichiers | Même pattern dans un ou plusieurs fichiers |
| 🔍 `search_in_files` | Recherche dans fichiers avec contexte | Chercher patterns, débogage de fichiers |
| 🔄 `search_and_replace` | **Recherche-remplacement AMÉLIORÉ** | Modifications regex, patterns globaux, workspace entier |
| 📋 `copy_files` | Copie avec transformation | Backup, déploiement, transformation |
| 📦 `move_files` | Déplacement de fichiers | Réorganisation, refactoring structure |
| 🗑️ `delete_files` | Suppression de fichiers | Nettoyage, suppression |
| 📋 `extract_markdown_structure` | Extraction de structure Markdown | Génération TOC, analyse documentation |
| 🔄 `restart_mcp_servers` | Redémarrage de serveurs MCP | Administration, maintenance |

---

## 🎯 Guide de Décision Rapide

```
🤔 QUELLE OPÉRATION ?
├── 📖 LECTURE → 🚀 read_multiple_files
├── ✏️ MODIFICATION → ✏️ edit_multiple_files
├── 📁 EXPLORATION → 📁 list_directory_contents
├── 🔍 RECHERCHE → 🔍 search_in_files
├── 🔄 RECHERCHE-REMPLACEMENT → 🔄 search_and_replace (NOUVEAU !)
└── 🔄 OPÉRATIONS MULTIPLES
    ├── Copie → 📋 copy_files
    ├── Déplacement → 📦 move_files
    └── Suppression → 🗑️ delete_files
```

## ⚡ Mémo Rapide

**Règle d'or** : Utilisez quickfiles pour des opérations efficaces sur un ou plusieurs fichiers.

**Accessibilité** : Tous les outils ont maintenant des emojis découvrables pour une meilleure identification !

---

## 🔧 Documentation Technique

Pour les développeurs souhaitant contribuer ou comprendre l'architecture interne, consultez :
- **[TECHNICAL.md](TECHNICAL.md)** : Architecture ESM, build, configuration détaillée, debugging
- **[docs/SEARCH-REPLACE-IMPROVEMENTS.md](docs/SEARCH-REPLACE-IMPROVEMENTS.md)** : Détail des améliorations search_and_replace

Le README se concentre sur l'utilisation pratique. La documentation technique couvre les aspects de développement et maintenance.

---

## 🆕 Nouveautés : Search & Replace Amélioré

L'outil `search_and_replace` a été complètement repensé pour supporter :

### ✨ Fonctionnalités Nouvelles

1. **Mode Global** : Opérations sur tout le workspace sans spécifier de fichiers
   ```javascript
   { "search": "console.log", "replace": "logger.debug", "preview": true }
   ```

2. **Patterns de Chemins** : Support des globs comme `src/**/*.js`
   ```javascript
   { "paths": ["src/**/*.ts", "lib/**/*.js"], "search": "oldApi", "replace": "newApi" }
   ```

3. **Filtrage Intelligent** : `file_pattern` fonctionne sans `paths`
   ```javascript
   { "file_pattern": "*.md", "search": "# TODO", "replace": "## TODO" }
   ```

### 🎯 Cas d'Usage

| Scénario | Avant | Après |
|-----------|--------|--------|
| Remplacer dans tous les fichiers | ❌ Impossible | ✅ `{search, replace}` |
| Pattern récursif | ❌ Non supporté | ✅ `{paths: ["**/*.js"]}` |
| Filtrage par extension | ❌ Nécessitait paths | ✅ `{file_pattern: "*.ts"}` |
| Rétrocompatibilité | ✅ Fonctionnait | ✅ Toujours identique |

### 📖 Documentation Complète

Consultez **[docs/SEARCH-REPLACE-IMPROVEMENTS.md](docs/SEARCH-REPLACE-IMPROVEMENTS.md)** pour :
- Guide d'utilisation complet
- Exemples pratiques
- Bonnes pratiques
- Détails techniques

**Rétrocompatibilité 100% garantie** - votre code existant continue de fonctionner !