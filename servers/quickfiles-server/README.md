# Documentation du MCP `quickfiles-server`

## 📖 Introduction

Le MCP `quickfiles-server` fournit un ensemble d'outils puissants pour la manipulation de fichiers et de répertoires. Conçu pour être performant et robuste, il centralise des opérations complexes comme la lecture de multiples fichiers, la recherche récursive, et les modifications groupées, tout en prévenant les problèmes de performance grâce à des mécanismes de troncature et de filtrage.

Ce serveur est un composant essentiel pour les agents qui ont besoin d'interagir de manière intensive avec le système de fichiers.

## 🛠️ Outils Disponibles

Voici la liste des outils exposés par le serveur, avec leur description et leurs paramètres.

---

### 📄 `read_multiple_files`

Lit le contenu de plusieurs fichiers en une seule requête. Cet outil est optimisé pour gérer des fichiers volumineux et des lectures partielles (extraits).

*   **Objectif :** Obtenir le contenu de plusieurs fichiers ou d'extraits de ces fichiers de manière efficace.
*   **Paramètres :**
    *   `paths` (string[] | FileWithExcerpts[]): Un tableau de chemins de fichiers (string) ou d'objets `FileWithExcerpts`.
        *   `FileWithExcerpts`: `{ path: string, excerpts?: { start: number, end: number }[] }`
    *   `show_line_numbers` (boolean, optionnel): Affiche les numéros de ligne. Défaut : `false`.
    *   `max_lines_per_file` (number, optionnel): Nombre maximum de lignes à retourner par fichier.
    *   `max_total_lines` (number, optionnel): Nombre maximum de lignes à retourner pour l'ensemble de la requête.
    *   `max_chars_per_file` (number, optionnel): Nombre maximum de caractères à retourner par fichier.
    *   `max_total_chars` (number, optionnel): Nombre maximum de caractères à retourner pour l'ensemble de la requête.
*   **Comportement :** Retourne le contenu des fichiers spécifiés. Des mécanismes de troncature intelligents sont appliqués pour éviter les surcharges de mémoire et de performance.

---

### 🗂️ `list_directory_contents`

Liste les fichiers et répertoires d'un ou plusieurs chemins, avec de nombreuses options de personnalisation.

*   **Objectif :** Explorer la structure de répertoires.
*   **Paramètres :**
    *   `paths` (string[] | DirectoryToList[]): Un tableau de chemins (string) ou d'objets `DirectoryToList`.
        *   `DirectoryToList`: `{ path: string, recursive?: boolean, max_depth?: number, file_pattern?: string, sort_by?: 'name' | 'size' | 'modified' | 'type', sort_order?: 'asc' | 'desc' }`
    *   Options globales (si `paths` est un tableau de `DirectoryToList`): `max_lines`, `max_depth`, `file_pattern`, `sort_by`, `sort_order`.
*   **Comportement :** Retourne une liste structurée des fichiers et répertoires, incluant leur taille et leur nombre de lignes. La sortie est formatée pour être lisible et peut être triée selon divers critères.

---

### 📝 `write_file`

Écrit du contenu dans un fichier. Si le fichier n'existe pas, il est créé. Si le fichier existe, son contenu est écrasé.

*   **Objectif :** Créer ou mettre à jour un fichier.
*   **Paramètres :**
    *   `path` (string): Chemin complet du fichier.
    *   `content` (string): Contenu à écrire.
*   **Comportement :** Le contenu est écrit dans le fichier spécifié, encodé en `utf-8`. Les répertoires parents doivent exister.

---

### 📂 `create_directory`

Crée un nouveau répertoire, y compris les répertoires parents si nécessaire.

*   **Objectif :** Créer une arborescence de répertoires.
*   **Paramètres :**
    *   `path` (string): Chemin du répertoire à créer.
*   **Comportement :** L'opération est récursive (`mkdir -p`). Si le répertoire existe déjà, aucune erreur n'est levée.

---

### 🗑️ `delete_files`

Supprime une liste de fichiers.

*   **Objectif :** Supprimer plusieurs fichiers en une seule opération.
*   **Paramètres :**
    *   `paths` (string[]): Tableau des chemins des fichiers à supprimer.
*   **Comportement :** Tente de supprimer chaque fichier de la liste et retourne un résultat pour chaque opération (succès ou échec avec message d'erreur).

---

### ❌ `delete_directory`

Supprime un répertoire et tout son contenu de manière récursive.

*   **Objectif :** Supprimer un répertoire et ses sous-dossiers/fichiers.
*   **Paramètres :**
    *   `path` (string): Chemin du répertoire à supprimer.
*   **Comportement :** L'opération est forcée et récursive (`rm -rf`). À utiliser avec prudence.

---

### 🌳 `directory_tree`

Génère une vue arborescente d'un répertoire au format JSON.

*   **Objectif :** Obtenir une représentation structurée d'une arborescence de fichiers.
*   **Paramètres :**
    *   `path` (string): Chemin du répertoire racine.
*   **Comportement :** Retourne un objet JSON décrivant la structure hiérarchique du répertoire, avec les `children` pour chaque sous-répertoire.

---

### ℹ️ `get_file_info`

Récupère les métadonnées détaillées d'un fichier ou d'un répertoire.

*   **Objectif :** Obtenir des informations sur une entrée du système de fichiers sans lire son contenu.
*   **Paramètres :**
    *   `path` (string): Chemin du fichier ou du répertoire.
*   **Comportement :** Retourne un objet JSON contenant le type (`file`/`directory`), la taille, les dates de création/modification/accès et les permissions.

---

### ✍️ `edit_multiple_files`

Applique des modifications à plusieurs fichiers en se basant sur des opérations de recherche/remplacement simples.

*   **Objectif :** Effectuer des modifications ciblées sur plusieurs fichiers.
*   **Paramètres :**
    *   `files` (FileEdit[]): Tableau d'objets `FileEdit`.
        *   `FileEdit`: `{ path: string, diffs: { search: string, replace: string, start_line?: number }[] }`
*   **Comportement :** Pour chaque fichier, le contenu est lu, les remplacements sont appliqués, puis le fichier est réécrit. Si un fichier n'existe pas, il est créé.

---

### 🔍 `search_in_files`

Recherche un motif (texte ou regex) dans un ensemble de fichiers ou de répertoires.

*   **Objectif :** Trouver des occurrences d'un motif dans le code base.
*   **Paramètres :**
    *   `paths` (string[]): Fichiers ou répertoires où chercher.
    *   `pattern` (string): Le motif à rechercher.
    *   `use_regex` (boolean, optionnel): Traiter le motif comme une expression régulière. Défaut : `true`.
    *   `case_sensitive` (boolean, optionnel): Recherche sensible à la casse. Défaut : `false`.
    *   `file_pattern` (string, optionnel): Motif glob pour filtrer les fichiers à inclure.
    *   `context_lines` (number, optionnel): Nombre de lignes de contexte à afficher autour de chaque correspondance.
    *   `recursive` (boolean, optionnel): Chercher récursivement dans les sous-répertoires. Défaut : `true`.
*   **Comportement :** Retourne une liste de correspondances avec leur contexte.

---

### 🔁 `search_and_replace`

Recherche un motif et le remplace dans plusieurs fichiers.

*   **Objectif :** Refactoriser ou mettre à jour du contenu à grande échelle.
*   **Paramètres :**
    *   Peut prendre soit un tableau `files` (similaire à `edit_multiple_files`), soit un ensemble de `paths` avec des `search`/`replace` globaux.
    *   `preview` (boolean, optionnel): Si `true`, affiche les modifications sans les appliquer.
*   **Comportement :** Effectue les remplacements et retourne un résumé des modifications. Le support des groupes de capture regex est disponible.

---

### 📑 `extract_markdown_structure`

Analyse des fichiers Markdown et en extrait la structure des titres.

*   **Objectif :** Obtenir un plan d'un ou plusieurs documents Markdown.
*   **Paramètres :**
    *   `paths` (string[]): Fichiers Markdown à analyser.
    *   `max_depth` (number, optionnel): Profondeur maximale des titres à extraire (1 pour `#`, 2 pour `#` et `##`, etc.).
    *   `include_context` (boolean, optionnel): Inclure les lignes de texte sous chaque titre.
*   **Comportement :** Retourne une structure hiérarchique des titres avec leur niveau et leur numéro de ligne.

---