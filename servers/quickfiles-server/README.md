# Serveur MCP QuickFiles

Ce serveur MCP fournit des méthodes pour lire rapidement le contenu de répertoires et fichiers multiples, offrant des fonctionnalités optimisées pour l'accès aux fichiers locaux.

## Fonctionnalités

- **Lecture multiple de fichiers** : lit plusieurs fichiers en une seule requête
- **Extraits de fichiers** : permet de lire uniquement des portions spécifiques de fichiers
- **Numérotation de lignes** : option pour afficher les numéros de ligne
- **Limitation de lignes** : option pour limiter le nombre de lignes lues par fichier
- **Listage de répertoires** : liste le contenu des répertoires avec des informations détaillées (taille, type, nombre de lignes pour les fichiers texte)
- **Navigation récursive** : option pour lister récursivement les sous-répertoires

## Outils MCP exposés

1. `read_multiple_files` : Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers
2. `list_directory_contents` : Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers

## Prérequis

- Node.js (v14 ou supérieur)
- npm (v6 ou supérieur)

## Installation

1. Clonez ce dépôt
2. Installez les dépendances :

```bash
cd servers/quickfiles-server
npm install
```

3. Compilez le projet :

```bash
npm run build
```

## Utilisation

Pour démarrer le serveur MCP QuickFiles :

```bash
npm start
```

## Exemples d'utilisation

### Lecture de plusieurs fichiers

```javascript
// Exemple d'appel à l'outil read_multiple_files
const result = await client.callTool('quickfiles-server', 'read_multiple_files', {
  paths: [
    'chemin/vers/fichier1.txt',
    'chemin/vers/fichier2.txt'
  ],
  show_line_numbers: true
});
```

### Lecture d'extraits de fichiers

```javascript
// Exemple d'appel à l'outil read_multiple_files avec extraits
const result = await client.callTool('quickfiles-server', 'read_multiple_files', {
  paths: [
    {
      path: 'chemin/vers/fichier.txt',
      excerpts: [
        { start: 10, end: 20 },  // Lignes 10 à 20
        { start: 50, end: 60 }   // Lignes 50 à 60
      ]
    }
  ],
  show_line_numbers: true
});
```

### Listage de répertoires

```javascript
// Exemple d'appel à l'outil list_directory_contents
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'chemin/vers/repertoire',
      recursive: true  // Lister récursivement
    }
  ]
});
```

## Détails des outils

### read_multiple_files

Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers.

**Paramètres:**
- `paths`: Tableau des chemins de fichiers à lire (format simple ou avec extraits)
- `show_line_numbers`: Afficher les numéros de ligne (optionnel, défaut: false)
- `max_lines_per_file`: Nombre maximum de lignes à afficher par fichier (optionnel)

**Format de paths:**
- Format simple: `['fichier1.txt', 'fichier2.txt']`
- Format avec extraits:
```javascript
[
  {
    path: 'fichier1.txt',
    excerpts: [
      { start: 10, end: 20 },
      { start: 50, end: 60 }
    ]
  }
]
```

### list_directory_contents

Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers.

**Paramètres:**
- `paths`: Tableau des chemins de répertoires à lister (format simple ou avec options)

**Format de paths:**
- Format simple: `['repertoire1', 'repertoire2']`
- Format avec options:
```javascript
[
  {
    path: 'repertoire1',
    recursive: true  // ou false pour lister uniquement le niveau supérieur
  }
]
```

## Remarques importantes

- Ce serveur MCP accède aux fichiers locaux, assurez-vous donc qu'il dispose des permissions nécessaires pour lire les fichiers et répertoires demandés.
- Pour des raisons de performance, la lecture de fichiers très volumineux peut être limitée. Utilisez les extraits ou `max_lines_per_file` pour ces cas.
- Le comptage de lignes est effectué uniquement pour les fichiers texte reconnus par leur extension et de taille inférieure à 10 Mo.