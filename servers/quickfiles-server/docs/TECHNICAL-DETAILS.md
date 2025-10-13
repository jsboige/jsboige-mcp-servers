# MCP `quickfiles-server`

## 📖 Objectif

Le MCP `quickfiles-server` fournit un ensemble d'outils puissants et performants pour la manipulation de fichiers et de répertoires. Il est conçu pour être un composant central pour les agents nécessitant une interaction intensive avec le système de fichiers, en offrant des opérations complexes de manière centralisée et sécurisée.

Ce serveur a été récemment modernisé pour utiliser **ESM (ECMAScript Modules)**, la dernière version du **SDK MCP**, et **Zod** pour la validation des schémas, garantissant ainsi une meilleure maintenabilité et fiabilité.

## 🚨 AVERTISSEMENT CRITIQUE - RESTAURATION 2025-09-30

**Un incident critique de régression a été détecté et corrigé.**

Le commit `0d7becf` avait remplacé **80% des outils** (8 sur 10) par des stubs non fonctionnels. Cette documentation a été mise à jour suite à la restauration complète de toutes les fonctionnalités. Voir [RESTAURATION-2025-09-30.md](docs/RESTAURATION-2025-09-30.md) pour les détails complets.

**Des garde-fous ont été mis en place** pour prévenir toute future régression similaire.

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

### Tests Unitaires (Jest)

Le serveur dispose d'une suite complète de tests unitaires incluant des **tests anti-régression** critiques pour détecter les implémentations stub.

**Exécuter tous les tests :**
```bash
npm test
```

**Exécuter uniquement les tests unitaires :**
```bash
npm run test:unit
```

**Tests anti-régression spécifiques :**
```bash
npm run test:anti-regression
```

**Mode watch pour développement :**
```bash
npm run test:watch
```

**Validation pré-commit :**
```bash
npm run validate
```

### Tests d'Intégration (Legacy)

Un script de test simple est également disponible pour des tests de fumée rapides :

```bash
node test-quickfiles-simple.js
```

### ⚠️ Tests Anti-Régression

**IMPORTANT :** Les tests anti-régression détectent automatiquement :
- Les implémentations stub (code contenant "Not implemented", "stub", etc.)
- Les méthodes trop courtes (< 200 caractères)
- Les schémas non validés
- Les opérations de fichiers non fonctionnelles

Ces tests sont **obligatoires** et bloquent les commits contenant des stubs.

## 🛠️ Outils Disponibles

Voici la liste détaillée des 10 outils exposés par le serveur :

### 📄 `read_multiple_files`

Lit le contenu de plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux.

*   **Paramètres :**
    *   `paths` (string[] | FileWithExcerpts[]): Chemins des fichiers ou objets avec extraits
    *   `show_line_numbers` (boolean, optionnel): Affiche les numéros de ligne
    *   `max_lines_per_file`, `max_total_lines`, `max_chars_per_file`, `max_total_chars` : Limites de troncature

### 🗂️ `list_directory_contents`

Liste tous les fichiers et répertoires sous un chemin donné, avec la taille, le nombre de lignes, et des options de filtrage et de tri. Tronque automatiquement les résultats volumineux.

*   **Paramètres :**
    *   `paths` (string[] | DirectoryToList[]): Chemins ou objets avec options
    *   `recursive`, `max_depth`, `file_pattern`, `sort_by`, `sort_order` : Options de filtrage et tri

### 🗑️ `delete_files` ✅ RESTAURÉ

Supprime une liste de fichiers en une seule opération avec gestion d'erreurs détaillée.

*   **Paramètres :**
    *   `paths` (string[]): Tableau des chemins des fichiers à supprimer

*   **Exemple :**
    ```javascript
    const result = await client.tools.delete_files({
      paths: ['temp/file1.txt', 'temp/file2.txt']
    });
    // Retourne: { success: true, deleted: ['temp/file1.txt', 'temp/file2.txt'], errors: [] }
    ```

*   **Implémentation :** 21 lignes de code fonctionnel
*   **Validation :** Zod schema avec array de strings
*   **Gestion d'erreurs :** Continue même si certains fichiers échouent

### ✍️ `edit_multiple_files` ✅ RESTAURÉ

Édite plusieurs fichiers en une seule opération en appliquant des diffs search/replace avec gestion d'erreurs avancée.

*   **Paramètres :**
    *   `files` (FileEdit[]): Objets avec `path` et `diffs` (search/replace operations)
    *   Chaque diff contient : `search`, `replace`, `start_line` (optionnel)

*   **Exemple :**
    ```javascript
    const result = await client.tools.edit_multiple_files({
      files: [
        {
          path: 'src/config.ts',
          diffs: [
            {
              search: 'DEBUG = false',
              replace: 'DEBUG = true',
              start_line: 10
            }
          ]
        }
      ]
    });
    ```

*   **Implémentation :** 68 lignes avec gestion d'erreurs détaillée
*   **Validation :** Schéma Zod complexe pour files et diffs
*   **Sécurité :** Validation de l'existence des fichiers avant édition

### 📑 `extract_markdown_structure` ✅ RESTAURÉ

Analyse les fichiers markdown et extrait les titres avec leurs numéros de ligne et contexte optionnel.

*   **Paramètres :**
    *   `paths` (string[]): Fichiers Markdown à analyser
    *   `max_depth` (number, optionnel): Profondeur maximale des titres (1-6)
    *   `include_context` (boolean, optionnel): Inclure lignes de contexte
    *   `context_lines` (number, optionnel): Nombre de lignes de contexte

*   **Exemple :**
    ```javascript
    const result = await client.tools.extract_markdown_structure({
      paths: ['docs/README.md', 'docs/API.md'],
      max_depth: 3,
      include_context: true,
      context_lines: 2
    });
    // Retourne la structure hiérarchique avec # Titre (line 10)
    ```

*   **Implémentation :** 65 lignes (34 + 31 helper `extractHeadings`)
*   **Fonctionnalités :** Parsing regex des titres Markdown (#, ##, ###, etc.)
*   **Performance :** Traitement ligne par ligne optimisé

### 📁 `copy_files` ✅ RESTAURÉ

Copie une liste de fichiers ou de répertoires avec support glob, transformation des noms et gestion des conflits.

*   **Paramètres :**
    *   `operations` (CopyOperation[]): Liste d'opérations avec `source`, `destination`
    *   `transform` (optionnel): Pattern regex et remplacement pour renommer
    *   `conflict_strategy` (optionnel): `overwrite` | `ignore` | `rename`

*   **Exemple :**
    ```javascript
    const result = await client.tools.copy_files({
      operations: [
        {
          source: 'src/*.ts',
          destination: 'backup/',
          transform: {
            pattern: '\\.ts$',
            replacement: '.ts.bak'
          },
          conflict_strategy: 'rename'
        }
      ]
    });
    ```

*   **Implémentation :** 65 lignes (9 + 56 helpers `performFileOperation`)
*   **Fonctionnalités avancées :**
    - Support des patterns glob (*.ts, **/*.js, etc.)
    - Transformation de noms via regex
    - Stratégies de conflit : overwrite, ignore, rename
    - Création automatique des répertoires parents

### 📂 `move_files` ✅ RESTAURÉ

Déplace une liste de fichiers ou de répertoires avec support glob, transformation des noms et gestion des conflits.

*   **Paramètres :**
    *   `operations` (MoveOperation[]): Liste d'opérations avec `source`, `destination`
    *   `transform` (optionnel): Pattern regex et remplacement pour renommer
    *   `conflict_strategy` (optionnel): `overwrite` | `ignore` | `rename`

*   **Exemple :**
    ```javascript
    const result = await client.tools.move_files({
      operations: [
        {
          source: 'temp/*.log',
          destination: 'logs/',
          conflict_strategy: 'overwrite'
        }
      ]
    });
    ```

*   **Implémentation :** 9 lignes + helpers partagés avec `copy_files`
*   **Fonctionnalités :** Identiques à `copy_files` mais avec déplacement
*   **Performance :** Utilise `fs.rename` quand possible pour efficacité

### 🔍 `search_in_files` ✅ RESTAURÉ

Recherche des motifs dans plusieurs fichiers/répertoires avec support des expressions régulières et affichage du contexte.

*   **Paramètres :**
    *   `paths` (string[]): Chemins à chercher
    *   `pattern` (string): Motif à rechercher
    *   `use_regex` (boolean, défaut: true): Utiliser regex
    *   `case_sensitive` (boolean, défaut: false): Sensible à la casse
    *   `file_pattern` (string, optionnel): Filtrer fichiers (*.ts, *.js, etc.)
    *   `context_lines` (number, défaut: 2): Lignes de contexte
    *   `max_results_per_file` (number, défaut: 100): Limite par fichier
    *   `max_total_results` (number, défaut: 1000): Limite totale
    *   `recursive` (boolean, défaut: true): Récursif

*   **Exemple :**
    ```javascript
    const result = await client.tools.search_in_files({
      paths: ['src/'],
      pattern: 'function.*export',
      use_regex: true,
      file_pattern: '*.ts',
      context_lines: 3,
      recursive: true
    });
    ```

*   **Implémentation :** 42 lignes avec gestion d'erreurs
*   **Performance :** Traitement ligne par ligne avec limites configurables
*   **Format de sortie :** Affichage avec numéros de ligne et contexte

### 🔁 `search_and_replace` ✅ RESTAURÉ

Recherche et remplace des motifs dans plusieurs fichiers avec support des expressions régulières et mode preview.

*   **Paramètres :**
    *   `search` (string): Motif à rechercher
    *   `replace` (string): Texte de remplacement
    *   `paths` (string[], optionnel): Chemins à traiter (mode global)
    *   `files` (FileSearchReplace[], optionnel): Opérations spécifiques par fichier
    *   `use_regex` (boolean, défaut: true): Utiliser regex
    *   `case_sensitive` (boolean, défaut: false): Sensible à la casse
    *   `preview` (boolean, défaut: false): Mode preview sans modification
    *   `file_pattern` (string, optionnel): Filtrer fichiers
    *   `recursive` (boolean, défaut: true): Récursif

*   **Exemple mode global :**
    ```javascript
    const result = await client.tools.search_and_replace({
      search: 'var\\s+(\\w+)',
      replace: 'const $1',
      paths: ['src/'],
      use_regex: true,
      file_pattern: '*.js',
      preview: false
    });
    ```

*   **Exemple mode fichiers spécifiques :**
    ```javascript
    const result = await client.tools.search_and_replace({
      search: 'DEBUG',
      replace: 'PRODUCTION',
      files: [
        { path: 'config/dev.js', search: 'DEBUG', replace: 'TEST' },
        { path: 'config/prod.js', search: 'DEBUG', replace: 'PRODUCTION' }
      ]
    });
    ```

*   **Implémentation :** 38 lignes
*   **Mode preview :** Retourne les changements sans les appliquer
*   **Sécurité :** Validation et backup automatique recommandé

### 🔄 `restart_mcp_servers` ✅ RESTAURÉ

Redémarre un ou plusieurs serveurs MCP en basculant leur état enabled dans le fichier de configuration.

*   **Paramètres :**
    *   `servers` (string[]): Noms des serveurs MCP à redémarrer

*   **Exemple :**
    ```javascript
    const result = await client.tools.restart_mcp_servers({
      servers: ['quickfiles', 'jupyter', 'github']
    });
    // Effectue un toggle enabled: true -> false -> true pour forcer le redémarrage
    ```

*   **Implémentation :** 28 lignes
*   **Fonctionnement :**
    1. Lit le fichier mcp_settings.json
    2. Toggle enabled: false pour chaque serveur
    3. Sauvegarde (déclenche rechargement Roo)
    4. Attend 100ms
    5. Toggle enabled: true
    6. Sauvegarde finale
*   **Localisation config :** `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`

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
```

## 🛡️ Garde-Fous et Prévention des Régressions

### Tests Anti-Régression

Le serveur dispose de **tests anti-régression critiques** (`__tests__/anti-regression.test.js`) qui détectent automatiquement :

1. **Détection de stubs par pattern matching :**
   - Recherche de mots-clés : "Not implemented", "stub", "TODO", "FIXME"
   - Bloque les implémentations non fonctionnelles

2. **Validation de longueur de code :**
   - Vérifie que chaque méthode contient au moins 200 caractères
   - Les stubs sont généralement très courts

3. **Tests fonctionnels :**
   - Vérifie que les opérations de fichiers fonctionnent réellement
   - Teste les effets de bord (création/suppression/modification réelle)

4. **Validation des schémas Zod :**
   - S'assure que tous les outils ont un schéma d'entrée valide
   - Vérifie la cohérence des paramètres

### Validation Pré-Commit

Un script de validation (`scripts/validate-implementations.js`) s'exécute automatiquement avant chaque commit :

```bash
npm run validate
```

**Bloque les commits si :**
- Des patterns de stub sont détectés
- Des méthodes sont trop courtes
- Des schémas Zod sont manquants

### CI/CD

Un workflow GitHub Actions (`.github/workflows/test.yml`) exécute automatiquement :
- Build TypeScript
- Tests unitaires Jest
- Tests anti-régression
- Validation des implémentations

**Le workflow échoue si un seul test anti-régression échoue.**

### ⚠️ AVERTISSEMENT CRITIQUE

**NE JAMAIS** remplacer une implémentation fonctionnelle par un stub. Si vous devez refactorer :

1. Créez d'abord les nouveaux tests
2. Implémentez la nouvelle version
3. Vérifiez que tous les tests passent
4. Supprimez l'ancienne version

Les tests anti-régression sont là pour **prévenir les catastrophes** comme le commit 0d7becf qui a remplacé 80% des outils par des stubs.

## 🔧 Configuration

Le serveur nécessite un environnement Node.js moderne et utilise les dernières normes ESM. Assurez-vous que votre configuration `package.json` et `tsconfig.json` est compatible avec les modules ES.

## 📚 Documentation API Complète

Pour une documentation complète de chaque outil avec tous les paramètres et exemples d'utilisation, consultez :

1. **Code source :** `src/index.ts` avec schémas Zod détaillés
2. **Rapport de restauration :** `docs/RESTAURATION-2025-09-30.md` avec exemples avant/après
3. **Tests :** `__tests__/anti-regression.test.js` pour cas d'usage concrets

## 🔗 Liens Utiles

- [Documentation MCP SDK](https://github.com/modelcontextprotocol/sdk)
- [Zod Documentation](https://zod.dev/)
- [Jest Documentation](https://jestjs.io/)
- [Rapport de Restauration Complet](docs/RESTAURATION-2025-09-30.md)

## 📊 Métriques de Qualité

- **Couverture de tests :** 80% minimum (lignes et fonctions)
- **Tests anti-régression :** 100% des outils validés
- **Build :** TypeScript strict mode
- **Validation :** Zod schemas sur tous les inputs
- **CI/CD :** GitHub Actions sur chaque PR
