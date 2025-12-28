# Guide Technique - Quickfiles MCP Server

## 🏗️ Architecture

### Migration ESM (ECMAScript Modules)

Le serveur `quickfiles-server` a été récemment modernisé pour utiliser **ESM (ECMAScript Modules)**, marquant une transition importante depuis CommonJS vers le standard JavaScript moderne.

**Points clés de l'architecture ESM :**
- **Configuration Node.js** : Le projet est configuré en tant que module ES via `"type": "module"` dans [`package.json`](package.json:1)
- **Résolution des Modules** : Le [`tsconfig.json`](tsconfig.json:1) utilise `"module": "ESNext"` et `"moduleResolution": "bundler"` pour une gestion optimale des importations
- **Extensions Explicites** : Les imports ESM nécessitent des extensions `.js` explicites dans le code TypeScript
- **SDK MCP Moderne** : Utilise la dernière version du SDK MCP (`@modelcontextprotocol/sdk`)

### Structure du Projet

```
quickfiles-server/
├── src/                 # Code source TypeScript
│   └── index.ts        # Point d'entrée principal du serveur
├── build/              # Code compilé JavaScript (généré)
├── __tests__/          # Tests unitaires
├── test-integration/   # Tests d'intégration
├── package.json        # Configuration npm avec "type": "module"
└── tsconfig.json       # Configuration TypeScript ESM
```

### Validation avec Zod

Tous les schémas d'entrée des outils MCP sont définis et validés avec **Zod**, garantissant:
- **Type Safety** : Validation runtime des données entrantes
- **Documentation Auto-générée** : Les schémas Zod servent de source de vérité pour les types
- **Messages d'Erreur Clairs** : Retours explicites en cas de données invalides

Exemple de schéma Zod pour `read_multiple_files`:
```typescript
const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.union([z.string(), FileToReadSchema])),
  show_line_numbers: z.boolean().optional(),
  max_lines_per_file: z.number().optional(),
  // ... autres paramètres
});
```

## 🔧 Build et Compilation

### Processus de Build

Le serveur utilise TypeScript avec compilation vers JavaScript ESM:

1. **Installation des dépendances:**
   ```bash
   npm install
   ```

2. **Compilation TypeScript:**
   ```bash
   npm run build
   ```
   - Commande interne: `tsc` (TypeScript Compiler)
   - Input: `src/**/*.ts`
   - Output: `build/**/*.js` (ESM)

3. **Configuration TypeScript Critique:**
   ```json
   {
     "compilerOptions": {
       "module": "ESNext",           // Génère des modules ESM
       "moduleResolution": "bundler", // Résolution moderne
       "target": "ES2022",           // Cible Node.js récent
       "outDir": "./build"           // Destination compilation
     }
   }
   ```

### Gestion des Paths et Imports

**Spécificité ESM** : Les imports relatifs doivent inclure l'extension `.js` même dans le code TypeScript:

```typescript
// ✅ Correct (ESM)
import { myFunction } from './utils.js';

// ❌ Incorrect (générera une erreur d'importation)
import { myFunction } from './utils';
```

**Raison** : Node.js ESM nécessite des extensions explicites pour résoudre les modules, contrairement à CommonJS qui les inférait.

## ⚙️ Configuration

### Configuration du Serveur MCP

Le serveur est instancié avec ses métadonnées de base:

```typescript
this.server = new McpServer({
  name: 'quickfiles-server',
  version: '1.0.0',
});
```

### Enregistrement des Outils

Chaque outil MCP est enregistré avec:
1. **Nom** : Identifiant unique de l'outil
2. **Description** : Texte explicatif pour les agents
3. **Schema Zod** : Définition des paramètres d'entrée
4. **Handler** : Fonction de traitement de l'outil

Exemple:
```typescript
this.server.registerTool(
  "read_multiple_files",
  {
    description: "Lit le contenu de plusieurs fichiers...",
    inputSchema: ReadMultipleFilesArgsSchema.shape,
  },
  this.handleReadMultipleFiles.bind(this),
);
```

### Conventions de Nommage

- **Fichiers** : `kebab-case` (ex: `test-quickfiles-simple.js`)
- **Classes** : `PascalCase` (ex: `QuickFilesServer`)
- **Méthodes** : `camelCase` (ex: `handleReadMultipleFiles`)
- **Outils MCP** : `snake_case` (ex: `read_multiple_files`)

## 🧪 Tests

### Exécution des Tests

**Méthode Recommandée** : Utiliser le script de test simple fourni

```bash
node test-quickfiles-simple.js
```

Ce script:
1. Lance le serveur `quickfiles-server` en tant que processus enfant
2. Instancie un `McpClient` pour communiquer avec le serveur
3. Exécute des tests de fumée pour valider les outils principaux
4. Gère le nettoyage automatique des fichiers de test

### Structure d'un Test Client

```javascript
import { McpClient, StdioClientTransport } from '@modelcontextprotocol/sdk';

// 1. Créer le transport Stdio
const transport = new StdioClientTransport({
  command: 'node',
  args: ['./build/index.js'],
});

// 2. Créer le client MCP
const client = McpClient.create({
  transport: transport,
  clientInfo: { name: 'my-test-client' }
});

// 3. Se connecter
await client.connect();

// 4. Appeler un outil
const response = await client.tools.read_multiple_files({
  paths: ['package.json'],
  show_line_numbers: true
});

// 5. Fermer proprement
await client.close();
```

### Tests d'Intégration

Les tests d'intégration se trouvent dans [`test-integration/`](test-integration) et valident:
- Communication client-serveur bout-en-bout
- Gestion des erreurs et cas limites
- Performance sur opérations multi-fichiers

## 🐛 Debugging

### Logs de Debug

Le serveur utilise `console.error()` pour les logs de debug vers stderr, permettant de ne pas polluer la sortie stdout utilisée par le protocole MCP.

```typescript
console.error('[DEBUG] Processing file:', filePath);
```

### Problèmes Courants

#### 1. Erreur "Cannot find module"
**Cause** : Import sans extension `.js` dans le code TypeScript
**Solution** : Ajouter `.js` à tous les imports relatifs

#### 2. "ERR_MODULE_NOT_FOUND"
**Cause** : Mauvaise configuration de `moduleResolution` dans tsconfig
**Solution** : Utiliser `"moduleResolution": "bundler"`

#### 3. Schéma Zod invalide
**Cause** : Paramètres envoyés ne correspondent pas au schéma
**Solution** : Vérifier les types avec `ZodError.issues` pour voir les champs rejetés

### Mode Verbose

Pour activer les logs détaillés lors du développement:

```bash
DEBUG=* node build/index.js
```

## 📝 Notes de Développement

### Ajout d'un Nouvel Outil

Pour ajouter un nouvel outil MCP au serveur:

1. **Définir le schéma Zod:**
   ```typescript
   const MyNewToolArgsSchema = z.object({
     param1: z.string(),
     param2: z.number().optional(),
   });
   ```

2. **Créer le handler:**
   ```typescript
   private async handleMyNewTool(
     args: z.infer<typeof MyNewToolArgsSchema>,
     extra: Record<string, unknown>,
   ) {
     // Logique de l'outil
     return { content: [{ type: 'text', text: 'Result' }] };
   }
   ```

3. **Enregistrer l'outil:**
   ```typescript
   this.server.registerTool(
     "my_new_tool",
     {
       description: "Description de l'outil",
       inputSchema: MyNewToolArgsSchema.shape,
     },
     this.handleMyNewTool.bind(this),
   );
   ```

4. **Recompiler:**
   ```bash
   npm run build
   ```

### Gestion de la Mémoire

Pour les opérations sur de gros fichiers, le serveur implémente:
- **Troncature automatique** : Limite configurable de lignes/caractères
- **Streaming** : Lecture par chunks pour fichiers volumineux (à venir)
- **Limits par défaut** :
  - `max_lines_per_file`: 2000 lignes
  - `max_chars_per_file: 300000 caractères
  - `max_total_lines`: 8000 lignes totales
  - `max_total_chars`: 400000 caractères totaux

### Compatibilité Node.js

**Version minimale** : Node.js 18+ (pour support ESM complet)

**Vérification version:**
```bash
node --version  # Doit être >= v18.0.0
```

### Mise à Jour des Dépendances

```bash
# Vérifier les mises à jour disponibles
npm outdated

# Mettre à jour le SDK MCP (attention aux breaking changes)
npm update @modelcontextprotocol/sdk

# Recompiler après mise à jour
npm run build
```

## 🔗 Références

- **MCP SDK Documentation** : https://github.com/modelcontextprotocol/sdk
- **Zod Documentation** : https://zod.dev/
- **Node.js ESM Guide** : https://nodejs.org/api/esm.html
- **TypeScript Module Resolution** : https://www.typescriptlang.org/docs/handbook/module-resolution.html

---

**Dernière mise à jour** : Octobre 2025  
**Mainteneur** : Équipe Roo Extensions