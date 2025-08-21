# MCP `quickfiles-server`

## 📖 Objectif

Le MCP `quickfiles-server` fournit un ensemble d'outils puissants et performants pour la manipulation de fichiers et de répertoires. Il est conçu pour être un composant central pour les agents nécessitant une interaction intensive avec le système de fichiers, en offrant des opérations complexes de manière centralisée et sécurisée.

Ce serveur a été récemment modernisé pour utiliser **ESM (ECMAScript Modules)**, la dernière version du **SDK MCP**, et **Zod** pour la validation des schémas, garantissant ainsi une meilleure maintenabilité et fiabilité.

## 🚀 Architecture et Configuration Clés

- **Environnement ESM :** Le projet est configuré en tant que module ES (`"type": "module"` dans `package.json`).
- **Résolution des Modules :** Le `tsconfig.json` utilise `"module": "NodeNext"` et `"moduleResolution": "NodeNext"`. Cette configuration est essentielle pour gérer correctement les importations de modules dans un environnement Node.js moderne.
- **Validation avec Zod :** Tous les schémas d'entrée des outils sont définis et validés avec Zod, ce qui garantit la robustesse des données reçues par le serveur.

## 🛠️ Installation et Build

Pour utiliser le serveur, suivez ces étapes :

1.  **Installer les dépendances :**
    ```bash
    npm install
    ```

2.  **Compiler le code source :**
    Le code TypeScript doit être transpilé en JavaScript.
    ```bash
    npm run build
    ```
    Cette commande utilise `tsc` pour compiler les fichiers depuis `src/` vers le répertoire `build/`.

## ✅ Tests

La méthode recommandée pour tester le bon fonctionnement du serveur est d'utiliser le script de test simple fourni. Ce script lance le serveur, s'y connecte, et exécute une série de tests de fumée pour valider les outils principaux.

Pour lancer les tests :

```bash
node test-quickfiles-simple.js
```

## 🛠️ Outils Disponibles

Voici la liste des outils exposés par le serveur, avec leur description.

1.  **`read_multiple_files`** : Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux.
2.  **`list_directory_contents`** : Liste tous les fichiers et répertoires sous un chemin donné, avec la taille, le nombre de lignes, et des options de filtrage et de tri. Tronque automatiquement les résultats volumineux.
3.  **`delete_files`** : Supprime une liste de fichiers en une seule opération.
4.  **`edit_multiple_files`** : Édite plusieurs fichiers en une seule opération en appliquant des diffs.
5.  **`extract_markdown_structure`** : Analyse les fichiers markdown et extrait les titres avec leurs numéros de ligne.
6.  **`copy_files`** : Copie une liste de fichiers ou de répertoires. Supporte les motifs glob, la transformation des noms de fichiers et la gestion des conflits.
7.  **`move_files`** : Déplace une liste de fichiers ou de répertoires. Supporte les motifs glob, la transformation des noms de fichiers et la gestion des conflits.
8.  **`search_in_files`** : Recherche des motifs dans plusieurs fichiers/répertoires avec support des expressions régulières et affichage du contexte.
9.  **`search_and_replace`** : Recherche et remplace des motifs dans plusieurs fichiers avec support des expressions régulières.
10. **`restart_mcp_servers`** : Redémarre un ou plusieurs serveurs MCP en modifiant leur fichier de configuration.

---

## 📝 Exemples d'Utilisation (Client)

### Lecture de plusieurs fichiers

```javascript
import { McpClient, StdioClientTransport } from '@modelcontextprotocol/sdk';
import path from 'path';

async function main() {
  const serverScriptPath = path.resolve('./build/index.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScriptPath],
  });

  const client = McpClient.create({
    transport: transport,
    clientInfo: { name: 'my-test-client' }
  });

  await client.connect();

  const response = await client.tools.read_multiple_files({
    paths: ['package.json', 'un-fichier-inexistant.txt'],
    show_line_numbers: true
  });

  console.log('Réponse du serveur :', response.content);

  await client.close();
}

main().catch(console.error);
```

### Listage de répertoires avec tri

```javascript
const result = await client.tools.list_directory_contents({
  paths: [
    {
      path: 'src',
      recursive: true,
      sort_by: 'size',
      sort_order: 'desc'
    }
  ],
  max_lines: 1000
});
