<!-- START_SECTION: metadata -->
---
title: "Serveur MCP QuickFiles"
description: "Documentation du serveur MCP pour la manipulation rapide et efficace de fichiers multiples"
tags: #quickfiles #mcp #documentation #overview #files
date_created: "2025-05-14"
date_updated: "2025-05-14"
version: "1.0.0"
author: "Équipe MCP"
---
<!-- END_SECTION: metadata -->

# Serveur MCP QuickFiles

<!-- START_SECTION: introduction -->
Ce serveur MCP fournit des méthodes pour lire rapidement le contenu de répertoires et fichiers multiples, offrant des fonctionnalités optimisées pour l'accès aux fichiers locaux.
<!-- END_SECTION: introduction -->

## Fonctionnalités

- **Lecture multiple de fichiers** : lit plusieurs fichiers en une seule requête
- **Extraits de fichiers** : permet de lire uniquement des portions spécifiques de fichiers
- **Numérotation de lignes** : option pour afficher les numéros de ligne
- **Limitation de lignes** : option pour limiter le nombre de lignes lues par fichier
- **Listage de répertoires** : liste le contenu des répertoires avec des informations détaillées (taille, type, nombre de lignes pour les fichiers texte)
- **Navigation récursive** : option pour lister récursivement les sous-répertoires
- **Filtrage par motif glob** : filtre les fichiers selon un motif glob (ex: *.js, *.{js,ts})
- **Tri personnalisable** : tri des fichiers et répertoires selon différents critères (nom, taille, date de modification, type)
- **Ordre de tri configurable** : tri ascendant ou descendant
- **Suppression de fichiers** : supprime plusieurs fichiers en une seule opération
- **Édition multiple de fichiers** : applique des modifications à plusieurs fichiers en une seule opération

## Outils MCP exposés

1. `read_multiple_files` : Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers
2. `list_directory_contents` : Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers et options de filtrage et tri
3. `delete_files` : Supprime une liste de fichiers en une seule opération
4. `edit_multiple_files` : Édite plusieurs fichiers en une seule opération en appliquant des diffs

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

Pour exécuter les tests :

```bash
# Exécuter tous les tests (Jest + tests legacy)
npm run test:all

# Exécuter uniquement les tests Jest
npm test

# Exécuter les tests legacy
npm run test:legacy
npm run test:simple
```

Pour exécuter le script de démonstration :

```bash
# Exécuter la démonstration des fonctionnalités
node test-quickfiles-demo.js

# Exécuter la démonstration des fonctionnalités de tri et filtrage
node test-quickfiles-sort.js
```

Ce script de démonstration montre comment utiliser les principales fonctionnalités du serveur MCP quickfiles, notamment :
- Lister les outils disponibles
- Lire plusieurs fichiers avec numérotation de lignes
- Lire des extraits spécifiques de fichiers
- Lister le contenu d'un répertoire
- Filtrer les fichiers par motif glob
- Trier les fichiers selon différents critères

## Exemples d'utilisation

### Lecture de plusieurs fichiers

```javascript
// Exemple d'appel à l'outil read_multiple_files
const result = await client.callTool('quickfiles-server', 'read_multiple_files', {
  paths: [
    'chemin/vers/fichier1.txt',
    'chemin/vers/fichier2.txt'
  ],
  show_line_numbers: true,
  max_lines_per_file: 1000,
  max_total_lines: 2000
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
  ],
  max_lines: 1000
});
```

### Listage avec filtrage par motif glob

```javascript
// Exemple d'appel à l'outil list_directory_contents avec filtrage
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'chemin/vers/repertoire',
      recursive: true,
      file_pattern: '*.js'  // Ne lister que les fichiers JavaScript
    }
  ],
  max_lines: 1000
});
```

### Listage avec tri personnalisé

```javascript
// Exemple d'appel à l'outil list_directory_contents avec tri par taille
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'chemin/vers/repertoire',
      recursive: true,
      sort_by: 'size',        // Trier par taille
      sort_order: 'desc'      // Ordre descendant (du plus grand au plus petit)
    }
  ],
  max_lines: 1000
});
```

### Suppression de fichiers

```javascript
// Exemple d'appel à l'outil delete_files
const result = await client.callTool('quickfiles-server', 'delete_files', {
  paths: [
    'chemin/vers/fichier1.txt',
    'chemin/vers/fichier2.txt'
  ]
});
```

### Édition de fichiers

```javascript
// Exemple d'appel à l'outil edit_multiple_files
const result = await client.callTool('quickfiles-server', 'edit_multiple_files', {
  files: [
    {
      path: 'chemin/vers/fichier.txt',
      diffs: [
        {
          search: 'texte à remplacer',
          replace: 'nouveau texte'
        },
        {
          search: 'autre texte',
          replace: 'autre remplacement',
          start_line: 10  // Commencer la recherche à partir de la ligne 10
        }
      ]
    }
  ]
});
```

#### Exemple d'édition de plusieurs fichiers en une seule opération

```javascript
// Édition de plusieurs fichiers en une seule opération
const result = await client.callTool('quickfiles-server', 'edit_multiple_files', {
  files: [
    {
      path: 'src/app.js',
      diffs: [
        {
          search: '// Configuration',
          replace: '// Configuration mise à jour'
        }
      ]
    },
    {
      path: 'src/utils.js',
      diffs: [
        {
          search: 'function oldName',
          replace: 'function newName'
        },
        {
          search: 'const VERSION = "1.0.0"',
          replace: 'const VERSION = "1.1.0"'
        }
      ]
    }
  ]
});
```

## Fonctionnalités de filtrage et de tri

### Filtrage par motif glob

L'outil `list_directory_contents` permet de filtrer les fichiers selon un motif glob. Cette fonctionnalité est particulièrement utile pour ne lister que les fichiers correspondant à un certain pattern.

#### Syntaxe des motifs glob supportés

- `*` : correspond à n'importe quelle séquence de caractères (sauf les séparateurs de chemin)
- `?` : correspond à un seul caractère
- `{a,b,c}` : correspond à l'un des motifs a, b ou c

#### Exemples de motifs glob

- `*.js` : tous les fichiers JavaScript
- `*.{js,ts}` : tous les fichiers JavaScript et TypeScript
- `data*.json` : tous les fichiers JSON commençant par "data"
- `test?.js` : fichiers comme "test1.js", "testA.js", mais pas "test10.js"

#### Options de filtrage

Le filtrage peut être appliqué :
- Globalement à tous les répertoires listés via le paramètre `file_pattern` au niveau racine
- Individuellement à chaque répertoire via le paramètre `file_pattern` dans l'objet de configuration du répertoire

```javascript
// Filtrage global
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: ['src', 'lib'],
  file_pattern: '*.js'  // Appliqué à tous les répertoires
});

// Filtrage individuel
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'src',
      file_pattern: '*.ts'  // Uniquement les fichiers .ts dans src
    },
    {
      path: 'lib',
      file_pattern: '*.js'  // Uniquement les fichiers .js dans lib
    }
  ]
});
```

### Tri des fichiers et répertoires

L'outil `list_directory_contents` permet de trier les fichiers et répertoires selon différents critères.

#### Critères de tri disponibles

- `name` : tri alphabétique par nom (insensible à la casse)
- `size` : tri par taille (en octets)
- `modified` : tri par date de modification
- `type` : tri par type (répertoires d'abord, puis fichiers)

#### Ordre de tri

- `asc` : ordre ascendant (A à Z, du plus petit au plus grand, du plus ancien au plus récent)
- `desc` : ordre descendant (Z à A, du plus grand au plus petit, du plus récent au plus ancien)

#### Options de tri

Le tri peut être appliqué :
- Globalement à tous les répertoires listés via les paramètres `sort_by` et `sort_order` au niveau racine
- Individuellement à chaque répertoire via les paramètres `sort_by` et `sort_order` dans l'objet de configuration du répertoire

```javascript
// Tri global
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: ['src', 'lib'],
  sort_by: 'modified',    // Trier par date de modification
  sort_order: 'desc'      // Du plus récent au plus ancien
});

// Tri individuel
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'src',
      sort_by: 'size',      // Trier par taille
      sort_order: 'desc'    // Du plus grand au plus petit
    },
    {
      path: 'lib',
      sort_by: 'name',      // Trier par nom
      sort_order: 'asc'     // Ordre alphabétique
    }
  ]
});
```

### Combinaison de filtrage et tri

Les options de filtrage et de tri peuvent être combinées pour obtenir des résultats précis.

```javascript
// Combinaison de filtrage et tri
const result = await client.callTool('quickfiles-server', 'list_directory_contents', {
  paths: [
    {
      path: 'src',
      file_pattern: '*.{js,ts}',  // Fichiers JavaScript et TypeScript
      sort_by: 'modified',        // Triés par date de modification
      sort_order: 'desc'          // Du plus récent au plus ancien
    }
  ]
});
```

## Schémas d'entrée/sortie détaillés

### read_multiple_files

#### Schéma d'entrée

```json
{
  "type": "object",
  "properties": {
    "paths": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tableau des chemins de fichiers à lire"
        },
        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Chemin du fichier à lire"
              },
              "excerpts": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "start": {
                      "type": "number",
                      "description": "Numéro de la première ligne de l'extrait (commençant à 1)"
                    },
                    "end": {
                      "type": "number",
                      "description": "Numéro de la dernière ligne de l'extrait (incluse)"
                    }
                  },
                  "required": ["start", "end"]
                },
                "description": "Liste des extraits à lire dans le fichier"
              }
            },
            "required": ["path"]
          },
          "description": "Tableau des fichiers avec extraits à lire"
        }
      ],
      "description": "Chemins des fichiers à lire (format simple ou avec extraits)"
    },
    "show_line_numbers": {
      "type": "boolean",
      "description": "Afficher les numéros de ligne",
      "default": false
    },
    "max_lines_per_file": {
      "type": "number",
      "description": "Nombre maximum de lignes à afficher par fichier",
      "default": 2000
    },
    "max_total_lines": {
      "type": "number",
      "description": "Nombre maximum total de lignes à afficher pour tous les fichiers",
      "default": 5000
    }
  },
  "required": ["paths"]
}
```

#### Schéma de sortie

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["text"]
          },
          "text": {
            "type": "string",
            "description": "Contenu formaté des fichiers lus"
          }
        },
        "required": ["type", "text"]
      }
    },
    "isError": {
      "type": "boolean",
      "description": "Indique si une erreur globale s'est produite"
    }
  },
  "required": ["content"]
}
```

### list_directory_contents

#### Schéma d'entrée

```json
{
  "type": "object",
  "properties": {
    "paths": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tableau des chemins de répertoires à lister"
        },
        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Chemin du répertoire à lister"
              },
              "recursive": {
                "type": "boolean",
                "description": "Lister récursivement les sous-répertoires",
                "default": true
              },
              "file_pattern": {
                "type": "string",
                "description": "Motif glob pour filtrer les fichiers (ex: *.js, *.{js,ts})"
              },
              "sort_by": {
                "type": "string",
                "enum": ["name", "size", "modified", "type"],
                "description": "Critère de tri des fichiers et répertoires",
                "default": "name"
              },
              "sort_order": {
                "type": "string",
                "enum": ["asc", "desc"],
                "description": "Ordre de tri (ascendant ou descendant)",
                "default": "asc"
              }
            },
            "required": ["path"]
          },
          "description": "Tableau des répertoires à lister avec options"
        }
      ],
      "description": "Chemins des répertoires à lister (format simple ou avec options)"
    },
    "max_lines": {
      "type": "number",
      "description": "Nombre maximum de lignes à afficher dans la sortie",
      "default": 2000
    },
    "file_pattern": {
      "type": "string",
      "description": "Motif glob global pour filtrer les fichiers (ex: *.js, *.{js,ts})"
    },
    "sort_by": {
      "type": "string",
      "enum": ["name", "size", "modified", "type"],
      "description": "Critère de tri global des fichiers et répertoires",
      "default": "name"
    },
    "sort_order": {
      "type": "string",
      "enum": ["asc", "desc"],
      "description": "Ordre de tri global (ascendant ou descendant)",
      "default": "asc"
    }
  },
  "required": ["paths"]
}
```

#### Schéma de sortie

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["text"]
          },
          "text": {
            "type": "string",
            "description": "Contenu formaté du listage des répertoires"
          }
        },
        "required": ["type", "text"]
      }
    },
    "isError": {
      "type": "boolean",
      "description": "Indique si une erreur globale s'est produite"
    }
  },
  "required": ["content"]
}
```

### delete_files

#### Schéma d'entrée

```json
{
  "type": "object",
  "properties": {
    "paths": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Tableau des chemins de fichiers à supprimer"
    }
  },
  "required": ["paths"]
}
```

#### Schéma de sortie

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["text"]
          },
          "text": {
            "type": "string",
            "description": "Résultat de l'opération de suppression pour chaque fichier"
          }
        },
        "required": ["type", "text"]
      }
    },
    "isError": {
      "type": "boolean",
      "description": "Indique si une erreur globale s'est produite"
    }
  },
  "required": ["content"]
}
```

### edit_multiple_files

#### Schéma d'entrée

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Chemin du fichier à éditer"
          },
          "diffs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "search": {
                  "type": "string",
                  "description": "Texte à rechercher"
                },
                "replace": {
                  "type": "string",
                  "description": "Texte de remplacement"
                },
                "start_line": {
                  "type": "number",
                  "description": "Numéro de ligne où commencer la recherche (optionnel)"
                }
              },
              "required": ["search", "replace"]
            },
            "description": "Liste des diffs à appliquer au fichier"
          }
        },
        "required": ["path", "diffs"]
      },
      "description": "Tableau des fichiers à éditer avec leurs diffs"
    }
  },
  "required": ["files"]
}
```

#### Schéma de sortie

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["text"]
          },
          "text": {
            "type": "string",
            "description": "Résultat de l'opération d'édition pour chaque fichier"
          }
        },
        "required": ["type", "text"]
      }
    },
    "isError": {
      "type": "boolean",
      "description": "Indique si une erreur globale s'est produite"
    }
  },
  "required": ["content"]
}
```

## Codes d'erreur

Le serveur QuickFiles utilise les codes d'erreur standard du protocole MCP :

| Code | Nom | Description |
|------|-----|-------------|
| -32700 | ParseError | Erreur d'analyse JSON |
| -32600 | InvalidRequest | La requête n'est pas valide |
| -32601 | MethodNotFound | La méthode demandée n'existe pas |
| -32602 | InvalidParams | Les paramètres fournis sont invalides |
| -32603 | InternalError | Erreur interne du serveur |
| -32000 | ServerError | Erreur générique du serveur |

### Erreurs spécifiques à QuickFiles

En plus des codes d'erreur standard, les messages d'erreur suivants peuvent être retournés :

| Situation | Message d'erreur |
|-----------|-----------------|
| Fichier inexistant | `Erreur lors de la lecture du fichier: ENOENT: no such file or directory, open '...'` |
| Permission insuffisante | `Erreur lors de la lecture du fichier: EACCES: permission denied, open '...'` |
| Répertoire inexistant | `Erreur lors du listage du répertoire: ENOENT: no such file or directory, scandir '...'` |
| Chemin n'est pas un répertoire | `Le chemin spécifié n'est pas un répertoire: ...` |
| Paramètres invalides | `Paramètres invalides pour [nom_outil]` |

## Guide de dépannage

### Problèmes courants et solutions

#### Erreur "ENOENT: no such file or directory"

**Problème** : Le fichier ou répertoire spécifié n'existe pas.

**Solution** :
- Vérifiez que le chemin est correct et que le fichier existe
- Utilisez des chemins absolus si nécessaire
- Vérifiez les permissions du répertoire parent

#### Erreur "EACCES: permission denied"

**Problème** : Permissions insuffisantes pour accéder au fichier ou répertoire.

**Solution** :
- Vérifiez les permissions du fichier/répertoire
- Exécutez le serveur avec des privilèges suffisants
- Modifiez les permissions du fichier/répertoire

#### Erreur "Paramètres invalides"

**Problème** : Les paramètres fournis ne correspondent pas au schéma attendu.

**Solution** :
- Vérifiez que tous les paramètres requis sont fournis
- Vérifiez que les types de données sont corrects
- Consultez la documentation pour le format exact des paramètres

#### Problèmes de performance avec de grands fichiers

**Problème** : Lenteur ou consommation excessive de mémoire lors de la lecture de fichiers volumineux.

**Solution** :
- Utilisez le paramètre `max_lines_per_file` pour limiter le nombre de lignes lues
- Utilisez des extraits (`excerpts`) pour lire uniquement les parties nécessaires
- Divisez les opérations en plusieurs requêtes plus petites

#### Problèmes d'encodage de caractères

**Problème** : Caractères incorrects ou corrompus dans la sortie.

**Solution** :
- Assurez-vous que les fichiers sont encodés en UTF-8
- Vérifiez que le client gère correctement l'encodage UTF-8

## Remarques importantes

- Ce serveur MCP accède aux fichiers locaux, assurez-vous donc qu'il dispose des permissions nécessaires pour lire, modifier ou supprimer les fichiers et répertoires demandés.
- Pour des raisons de performance, la lecture de fichiers très volumineux peut être limitée. Utilisez les extraits ou `max_lines_per_file` pour ces cas.
- Le comptage de lignes est effectué uniquement pour les fichiers texte reconnus par leur extension et de taille inférieure à 10 Mo.
- Les opérations d'édition et de suppression sont irréversibles. Assurez-vous de sauvegarder vos fichiers importants avant d'utiliser ces fonctionnalités.

## Tests unitaires

Le serveur QuickFiles est livré avec une suite complète de tests unitaires qui vérifient toutes les fonctionnalités :

- Tests de lecture de fichiers multiples
- Tests de listage de répertoires
- Tests de suppression de fichiers
- Tests d'édition de fichiers multiples
- Tests de gestion des erreurs
- Tests de performance

Les tests utilisent Jest et mock-fs pour simuler le système de fichiers, ce qui permet de tester toutes les fonctionnalités sans modifier les fichiers réels.

Pour exécuter les tests unitaires :

```bash
npm test
```

## Fichiers de démonstration

Le dépôt inclut des fichiers de démonstration pour tester facilement les fonctionnalités du serveur :

- `demo-file1.txt` et `demo-file2.txt` : Fichiers texte simples pour tester la lecture
- `test-quickfiles-demo.js` : Script de démonstration qui montre comment utiliser les principales fonctionnalités
- `test-quickfiles-sort.js` : Script de démonstration qui montre comment utiliser les fonctionnalités de tri et filtrage

<!-- START_SECTION: navigation -->
## Navigation

- [Index principal](../../../INDEX.md)
- [Index des MCPs internes](../../INDEX.md)
- [Installation](./INSTALLATION.md)
- [Configuration](./CONFIGURATION.md)
- [Utilisation](./USAGE.md)
- [Dépannage](./TROUBLESHOOTING.md)
- [Guide de recherche](../../../SEARCH.md)
<!-- END_SECTION: navigation -->