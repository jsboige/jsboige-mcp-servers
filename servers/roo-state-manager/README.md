# Roo State Manager MCP

Serveur MCP (Model Context Protocol) unifié pour la gestion des conversations et configurations Roo.

## 🎯 Objectif

Le Roo State Manager résout les problèmes de perte de conversations Roo en fournissant :
- Détection automatique du stockage Roo existant
- Gestion unifiée des conversations et configurations
- Sauvegarde et restauration des données
- Interface MCP pour l'intégration avec d'autres outils

## 🆕 Architecture SDDD Enhanced Export

**✅ NOUVELLE FONCTIONNALITÉ - DOCUMENTATION COMPLÈTE DISPONIBLE**

Le Roo State Manager intègre maintenant l'architecture SDDD (Semantic-Driven Development and Documentation) qui transforme le système de génération de rapports en une plateforme flexible et extensible.

### 📖 Documentation SDDD Complète

Une documentation technique complète est maintenant disponible dans [`docs/`](./docs/) :

- **[📋 Guide Principal](./docs/README.md)** - Index complet de la documentation SDDD
- **[🎯 Document de Référence](./docs/SDDD_Master_Document.md)** - Vue d'ensemble consolidée de l'architecture
- **[🏗️ Architecture](./docs/architecture/)** - Principes et spécifications techniques
- **[👥 Utilisation](./docs/usage/)** - Guides d'utilisation et déploiement
- **[🔧 Maintenance](./docs/maintenance/)** - Maintenance et résolution de problèmes
- **[📊 Rapports](./docs/reports/)** - Rapports exécutifs et validation

### 🚀 Nouvelles Capacités SDDD

- **6 niveaux de détail** avec ratios de compression jusqu'à 23.7x
- **Formats HTML et Markdown** avec CSS avancé et navigation interactive
- **Architecture modulaire extensible** basée sur le Strategy Pattern
- **Génération de grappes de tâches** pour l'analyse de workflows complexes
- **Performance optimisée** : <305ms pour tous les scénarios
- **Rétrocompatibilité totale** préservée

### 🎯 Exemples de Démarrage Rapide

Voir [`examples/`](./examples/) pour les scripts de démonstration :
- **[demo-sddd-complete.js](./examples/demo-sddd-complete.js)** - Démonstration complète des fonctionnalités
- **[performance-benchmark.js](./examples/performance-benchmark.js)** - Benchmarks de performance
- **[Rapport de validation](./examples/validation/SDDD-Checkpoint1-Validation-Report.md)** - Validation technique complète

## 🧠 Système de Synthèse de Conversations

**✅ NOUVELLE FONCTIONNALITÉ - PHASE 3 LLM OPÉRATIONNELLE**

Le Roo State Manager intègre un système avancé de synthèse automatique de conversations utilisant l'IA pour analyser et résumer intelligemment les traces d'interactions Roo.

**Documentation technique complète :** [`docs/architecture/conversation-synthesis/`](./docs/architecture/conversation-synthesis/)

**API disponible :** `get_conversation_synthesis` - Synthèse LLM réelle avec OpenAI structured outputs

---

## 📁 Structure du Projet

```
roo-state-manager/
├── src/
│   ├── types/
│   │   └── conversation.ts      # Interfaces TypeScript
│   ├── utils/
│   │   └── roo-storage-detector.ts  # Détecteur de stockage
│   ├── services/
│   │   ├── TraceSummaryService.ts   # Service de génération de résumés
│   │   └── ConversationSkeleton.ts  # Squelette de conversation parsé
│   └── index.ts                 # Serveur MCP principal
├── tests/
│   └── test-storage-detector.js # Tests de validation
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Installation

```bash
# Installation des dépendances
npm install

# Compilation TypeScript
npm run build

# Test du détecteur de stockage
npm run test:detector

# Lancer la suite de tests complète
npm test

# Tests avec coverage
npm run test:coverage
```

## 🔍 Fonctionnalités

### Détection Automatique du Stockage Roo

Le détecteur recherche automatiquement les emplacements de stockage Roo dans :
- `~/.vscode/extensions/*/globalStorage/`
- `~/AppData/Roaming/Code/User/globalStorage/` (Windows)
- `~/.config/Code/User/globalStorage/` (Linux)
- `~/Library/Application Support/Code/User/globalStorage/` (macOS)

### Outils MCP Disponibles

#### `detect_roo_storage`
Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes.

```json
{
  "found": true,
  "locations": [...],
  "conversations": [...],
  "totalConversations": 42,
  "totalSize": 1048576,
  "errors": []
}
```

#### `get_storage_stats`
Obtient les statistiques globales du stockage Roo.

```json
{
  "totalLocations": 1,
  "totalConversations": 42,
  "totalSize": 1048576,
  "oldestConversation": "task-123",
  "newestConversation": "task-456"
}
```

#### `find_conversation`
Recherche une conversation spécifique par son ID de tâche.

```json
{
  "taskId": "task-123",
  "path": "/path/to/conversation",
  "metadata": {...},
  "messageCount": 15,
  "lastActivity": "2025-05-26T10:00:00Z",
  "hasApiHistory": true,
  "hasUiMessages": true,
  "size": 2048
}
```

#### `list_conversations`
Liste toutes les conversations avec filtres et tri.

Paramètres :
- `limit` : Nombre maximum de résultats (défaut: 50)
- `sortBy` : Critère de tri (`lastActivity`, `messageCount`, `size`)
- `sortOrder` : Ordre de tri (`asc`, `desc`)
- `hasApiHistory` : Filtrer par présence d'historique API
- `hasUiMessages` : Filtrer par présence de messages UI

#### `validate_custom_path`
Valide un chemin de stockage Roo personnalisé.
|
#### `diagnose_roo_state`
Exécute le script d'audit des tâches Roo (`scripts/audit/audit-roo-tasks.ps1`) et retourne sa sortie JSON. Cet outil est essentiel pour obtenir un diagnostic complet de l'état des tâches, y compris les chemins de workspace invalides, les métadonnées manquantes ou les incohérences.
|
**Exemple d'utilisation avec `use_mcp_tool` :**
```json
{
  "tool_name": "diagnose_roo_state",
  "server_name": "roo-state-manager",
  "arguments": {}
}
```
|
#### `repair_workspace_paths`
Exécute le script de réparation des chemins de workspace (`scripts/repair/repair-roo-tasks.ps1`). Cet outil permet de corriger en masse les chemins de workspace invalides dans les métadonnées des tâches, ce qui est crucial après une migration de projet ou un changement de structure de répertoires.
|
**Paramètres :**
- `path_pairs` (array[string]): Une liste de paires de chaînes de caractères, où chaque chaîne contient l'ancien chemin et le nouveau chemin séparés par un `=`. Par exemple : `["C:\\old\\path=D:\\new\\path", "/mnt/old_location=/home/user/new_location"]`.
- `whatIf` (boolean, optionnel, défaut: `false`): Si `true`, le script s'exécute en mode simulation et affiche les changements qu'il aurait effectués sans les appliquer réellement.
- `non_interactive` (boolean, optionnel, défaut: `true`): Si `true`, le script s'exécute sans demander de confirmation à l'utilisateur.
|
**Exemple d'utilisation avec `use_mcp_tool` (mode simulation) :**
```json
{
  "tool_name": "repair_workspace_paths",
  "server_name": "roo-state-manager",
  "arguments": {
    "path_pairs": ["d:\\Dev\\roo-v2-archive=d:\\Dev\\roo-extensions\\archive"],
    "whatIf": true
  }
}
```

#### `generate_trace_summary`
Génère un résumé intelligent et formaté d'une trace de conversation Roo avec contenu conversationnel complet.

**Fonctionnalités principales :**
- **Contenu conversationnel complet** : Rendu de tous les messages (user, assistant, tools)
- **Progressive Disclosure Pattern** : Sections `<details>/<summary>` pour les environment_details et blocs techniques
- **6 modes de détail** : Full, NoTools, NoResults, Messages, Summary, UserOnly
- **CSS intégré** : Styling avancé avec classes pour chaque type de message
- **Navigation interactive** : Table des matières et liens de retour
- **Architecture modulaire** : Service TypeScript robuste et extensible

**Paramètres :**
- `taskId` (string) : ID de la tâche (ou "current" pour la tâche actuelle)
- `detailLevel` (string, optionnel) : Mode de rendu ('Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly')
- `outputFormat` (string, optionnel) : Format de sortie ('markdown', 'html')
- `truncationChars` (number, optionnel) : Limite de troncature (0 = pas de limite)
- `compactStats` (boolean, optionnel) : Utiliser format compact pour statistiques
- `includeCss` (boolean, optionnel) : Inclure CSS embarqué (défaut: true)
- `generateToc` (boolean, optionnel) : Générer table des matières (défaut: true)

**Exemple d'utilisation :**
```json
{
  "tool_name": "generate_trace_summary",
  "server_name": "roo-state-manager",
  "arguments": {
    "taskId": "current",
    "detailLevel": "Full",
    "outputFormat": "markdown",
    "includeCss": true,
    "generateToc": true
  }
}
```

**Modes de détail disponibles :**
- `Full` : Tout le contenu avec Progressive Disclosure
- `NoTools` : Masque les paramètres d'outils mais garde les résultats
- `NoResults` : Masque les résultats d'outils mais garde les paramètres
- `Messages` : Seulement les messages utilisateur/assistant (pas d'outils)
- `Summary` : Seulement métadonnées et statistiques (pas de contenu)
- `UserOnly` : Seulement les messages utilisateur

**Sortie :**
```json
{
  "success": true,
  "content": "# RÉSUMÉ DE TRACE D'ORCHESTRATION ROO\n\n...",
  "statistics": {
    "totalSections": 25,
    "userMessages": 8,
    "assistantMessages": 12,
    "toolResults": 5,
    "totalContentSize": 45678,
    "compressionRatio": 2.3
  }
}
```

#### `generate_cluster_summary`
Génère un résumé intelligent et formaté d'une grappe (groupe) de tâches Roo liées, permettant d'analyser des workflows complexes avec tâches parent-enfant.

**Fonctionnalités principales :**
- **Analyse de grappe multi-tâches** : Traite une tâche racine et ses tâches enfantes comme une unité cohérente
- **3 modes de clustering** : Aggregated, Detailed, Comparative pour différents besoins d'analyse
- **Statistiques de grappe avancées** : Métriques spécialisées pour l'analyse de clusters (durée totale, distribution des tâches, patterns croisés)
- **Timeline chronologique** : Vue temporelle de l'évolution de la grappe
- **Relations parent-enfant** : Cartographie explicite des liens hiérarchiques entre tâches
- **Analyse cross-task** : Détection de patterns et tendances communes entre tâches liées
- **Formats multi-sorties** : Support markdown et HTML avec styling intégré

**Paramètres :**
- `rootTaskId` (string) : ID de la tâche racine (parent principal) de la grappe
- `childTaskIds` (array[string], optionnel) : Liste des IDs des tâches enfantes (auto-détecté via parentTaskId si non fourni)
- `detailLevel` (string, optionnel) : Mode de rendu ('Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly')
- `outputFormat` (string, optionnel) : Format de sortie ('markdown', 'html')
- `truncationChars` (number, optionnel) : Limite de troncature globale (0 = pas de limite)
- `compactStats` (boolean, optionnel) : Utiliser format compact pour statistiques
- `includeCss` (boolean, optionnel) : Inclure CSS embarqué (défaut: true)
- `generateToc` (boolean, optionnel) : Générer table des matières interactive (défaut: true)
- `clusterMode` (string, optionnel) : Mode de génération de grappe ('aggregated', 'detailed', 'comparative')
- `includeClusterStats` (boolean, optionnel) : Inclure statistiques spécifiques aux grappes (défaut: true)
- `crossTaskAnalysis` (boolean, optionnel) : Activer analyse des patterns croisés entre tâches (défaut: false)
- `maxClusterDepth` (number, optionnel) : Profondeur maximale de hiérarchie à analyser (défaut: 10)
- `clusterSortBy` (string, optionnel) : Critère de tri ('chronological', 'size', 'activity', 'alphabetical')
- `includeClusterTimeline` (boolean, optionnel) : Inclure timeline chronologique de la grappe (défaut: false)
- `clusterTruncationChars` (number, optionnel) : Troncature spécifique pour contenu des tâches en mode agrégé
- `showTaskRelationships` (boolean, optionnel) : Montrer relations parent-enfant explicitement (défaut: true)

**Exemple d'utilisation :**
```json
{
  "tool_name": "generate_cluster_summary",
  "server_name": "roo-state-manager",
  "arguments": {
    "rootTaskId": "task-abc123-parent",
    "childTaskIds": ["task-def456-child1", "task-ghi789-child2"],
    "detailLevel": "Full",
    "outputFormat": "markdown",
    "clusterMode": "detailed",
    "includeClusterStats": true,
    "crossTaskAnalysis": true,
    "includeClusterTimeline": true,
    "showTaskRelationships": true
  }
}
```

**Modes de clustering disponibles :**
- `aggregated` : Vue synthétique avec statistiques consolidées et contenu condensé
- `detailed` : Vue exhaustive de chaque tâche avec contenu complet et analyse individuelle
- `comparative` : Vue comparative mettant en évidence les différences et similitudes entre tâches

**Spécificités par rapport à `generate_trace_summary` :**
- **Scope multi-tâches** : Analyse plusieurs conversations liées vs. une conversation unique
- **Métriques de grappe** : Statistiques spécialisées (durée totale de grappe, distribution des modes, patterns croisés)
- **Relations hiérarchiques** : Cartographie explicite des liens parent-enfant
- **Timeline consolidée** : Vue chronologique de l'évolution de toute la grappe
- **Analyse comparative** : Identification des patterns communs entre tâches liées

**Sortie :**
```json
{
  "success": true,
  "content": "# 🔗 Grappe de Tâches: Projet XYZ\n\n...",
  "clusterStatistics": {
    "totalTasks": 3,
    "totalSections": 87,
    "totalDuration": 245,
    "averageTaskSize": 156.7,
    "clusterComplexity": "High",
    "taskModeDistribution": {
      "code": 2,
      "architect": 1
    },
    "crossTaskPatterns": ["file-editing", "testing", "documentation"]
  },
  "taskBreakdown": {
    "rootTask": {...},
    "childTasks": [...]
  }
}
```

## 📊 Format des Données Roo

### Structure de Stockage Détectée

```
{globalStoragePath}/
├── tasks/
│   └── {taskId}/
│       ├── api_conversation_history.json  # Messages API (format Anthropic)
│       ├── ui_messages.json              # Messages UI (ClineMessage)
│       └── task_metadata.json            # Métadonnées de la tâche
└── settings/                             # Configurations Roo
```

### Types de Messages

#### Messages API (Anthropic)
```typescript
interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | Array<{
    type: 'text' | 'image';
    text?: string;
    source?: {...};
  }>;
  timestamp?: string;
}
```

#### Messages UI (Cline)
```typescript
interface ClineMessage {
  id: string;
  type: 'ask' | 'say' | 'completion_result' | 'tool_use' | 'tool_result';
  text?: string;
  tool?: string;
  toolInput?: any;
  toolResult?: any;
  timestamp: string;
  isError?: boolean;
}
```

## 🧪 Tests

### Test du Détecteur de Stockage

```bash
npm run test:detector
```

- Détecte automatiquement les emplacements de stockage Roo
- Analyse la structure des dossiers de conversations
- Valide l'intégrité des fichiers JSON
- Affiche des statistiques sur les conversations trouvées

### Suite de Tests Complète

Le projet inclut une suite de tests robuste couvrant :

#### Tests Unitaires
- `manage-mcp-settings.test.ts` : Tests pour la gestion des paramètres MCP
- `read-vscode-logs.test.ts` : Tests pour la lecture des logs VSCode
- `view-conversation-tree.test.ts` : Tests pour l'affichage des conversations
- `versioning.test.ts` : Tests pour la lecture de version depuis package.json
- `timestamp-parsing.test.ts` : Tests pour le parsing des timestamps
- `bom-handling.test.ts` : Tests pour la gestion des fichiers avec BOM UTF-8

#### Tests E2E
- `semantic-search.test.ts` : Tests de recherche sémantique
- `task-navigation.test.ts` : Tests de navigation dans les tâches

#### Tests de Reconstruction Hiérarchique ⚠️

**✅ NOUVELLE FONCTIONNALITÉ - Mission SDDD Triple Grounding**

Suite de tests pour valider le système de reconstruction hiérarchique des tâches parent-enfant :

**Tests Unitaires (Jest - ❌ Configuration corrompue) :**
- `production-format-extraction.test.ts` : Validation Pattern 5 newTask production
- `skeleton-cache-reconstruction.test.ts` : Test buildHierarchicalSkeletons complet
- `parent-child-validation.test.ts` : Validation relations RadixTree

**Scripts de Diagnostic (Node.js - ✅ Fonctionnels) :**
- `test-pattern-extraction.mjs` : Diagnostic patterns extraction
- `direct-diagnosis.mjs` : Diagnostic système complet (métriques détaillées)
- `test-radixtree-matching.mjs` : Test spécifique RadixTree matching

**Exécution recommandée (workaround Jest) :**
```bash
# Diagnostic complet système
node scripts/direct-diagnosis.mjs

# Test spécifique RadixTree
node scripts/test-radixtree-matching.mjs

# Test patterns extraction
node scripts/test-pattern-extraction.mjs
```

**Métriques Actuelles :**
- Tâches workspace cible : 7 (sur 3870 total = 0.18%)
- Instructions newTask extraites : 2
- Relations parent-enfant : 0 ❌ (taux succès RadixTree = 0%)

📋 **Documentation complète :** [`docs/tests/hierarchie-reconstruction-validation.md`](docs/tests/hierarchie-reconstruction-validation.md)

### Commandes de Test

```bash
# Lancer tous les tests
npm test

# Tests avec setup automatique
npm run test:setup && npm test

# Tests avec coverage
npm run test:coverage

# Test spécifique
npx jest tests/specific-test.test.ts --verbose

# Tests avec plus de mémoire (si problèmes de heap)
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

### Configuration Jest

Le projet utilise Jest avec support ESM et TypeScript via `ts-jest`. Configuration optimisée pour :
- Modules ES natives
- Support TypeScript complet
- Mocking sécurisé avec `jest.unstable_mockModule`
- Gestion mémoire optimisée (un seul worker)
- Isolation complète des tests

## 🛠️ Troubleshooting

### Problèmes Courants et Solutions

#### 1. Crash du Serveur au Démarrage

**Erreur :** `OpenAI API key is not configured...`

**Cause :** Le serveur utilise une initialisation paresseuse (lazy loading) du client OpenAI pour éviter les crashes lors du démarrage.

**Solution :**
- Vérifiez que le fichier `.env` existe avec `OPENAI_API_KEY=your_key`
- Le serveur ne crash plus au démarrage même sans clé API
- La clé n'est requise que pour les fonctionnalités de recherche sémantique

#### 2. Problèmes de Serveurs MCP

**Erreur :** `Invalid configuration for MCP server "xxx"`

**Solutions :**
```bash
# Désactiver un serveur problématique
use_mcp_tool "roo-state-manager" "manage_mcp_settings" {"action": "toggle_server", "server_name": "problematic-server"}

# Voir la configuration actuelle
use_mcp_tool "roo-state-manager" "manage_mcp_settings" {"action": "read"}
```

#### 3. Erreurs de Tests Jest

**Erreur :** `Cannot use import statement outside a module`

**Solutions :**
- Configuration Jest ESM correcte dans `jest.config.js`
- Utilisation de `jest.unstable_mockModule` pour les modules ES
- Variable `NODE_OPTIONS=--experimental-vm-modules`

**Erreur :** `JavaScript heap out of memory`

**Solutions :**
```bash
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

#### 4. Problèmes de Fichiers Corrompus

**Erreur :** Fichiers JSON avec BOM UTF-8

**Solution :**
```bash
# Diagnostic
use_mcp_tool "roo-state-manager" "diagnose_conversation_bom" {}

# Réparation
use_mcp_tool "roo-state-manager" "repair_conversation_bom" {}
```

### Outils de Diagnostic

#### `diagnose_roo_state`
```bash
use_mcp_tool "roo-state-manager" "diagnose_roo_state" {}
```

#### `read_vscode_logs`
```bash
use_mcp_tool "roo-state-manager" "read_vscode_logs" {"lines": 100, "filter": "error"}
```

### Variables d'Environnement

Créez un fichier `.env` dans le répertoire du serveur :

```env
# Requis pour la recherche sémantique
OPENAI_API_KEY=your_openai_api_key_here

# Configuration Qdrant (optionnel)
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION_NAME=roo_tasks_semantic_index

# Mode debug (optionnel)
DEBUG=roo-state-manager:*
```

### Structure des Tests

```
tests/
├── setup-env.ts              # Configuration environnement test
├── jest.setup.ts             # Setup Jest global
├── manage-mcp-settings.test.ts    # Tests gestion MCP
├── read-vscode-logs.test.ts       # Tests lecture logs
├── view-conversation-tree.test.ts # Tests navigation conversations  
├── versioning.test.ts             # Tests versioning
├── timestamp-parsing.test.ts      # Tests timestamps
├── bom-handling.test.ts           # Tests BOM UTF-8
├── task-navigator.test.ts         # Tests navigation tâches
└── e2e/
    ├── semantic-search.test.ts    # Tests recherche sémantique
    ├── task-navigation.test.ts    # Tests navigation E2E
    └── placeholder.test.ts        # Tests placeholder
```
Ce test :
1. Détecte automatiquement le stockage Roo
2. Affiche les emplacements trouvés
3. Liste les conversations récentes
4. Calcule les statistiques globales
5. Teste la recherche de conversations
6. Valide des chemins personnalisés

### Exemple de Sortie

```
🔍 Test du détecteur de stockage Roo

📍 Test 1: Détection automatique du stockage Roo...
✅ Détection terminée:
   - Stockage trouvé: OUI
   - Emplacements détectés: 1
   - Conversations trouvées: 15
   - Taille totale: 2.5 MB

📂 Emplacements de stockage détectés:
   1. C:\Users\User\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev-1.0.0
      - Tasks: ...\tasks
      - Settings: ...\settings

💬 Conversations récentes (5 dernières):
   1. task-abc123
      - Messages: 25
      - Dernière activité: 26/05/2025 10:30:00
      - Taille: 512 KB
      - API: ✅ | UI: ✅
```

### Tests Unitaires

La suite de tests unitaires peut être lancée pour valider les `handlers` des outils de manière isolée.

```bash
npm run test
```

Cette commande exécute tous les fichiers `*.test.ts` dans les répertoires `src/` et `tests/`. Les tests pour les outils qui dépendent de scripts externes (comme `diagnose_roo_state`) sont moqués pour assurer des tests rapides et indépendants de l'environnement.

## 🔧 Configuration

### Intégration MCP

Ajoutez le serveur à votre configuration MCP :

```json
{
  "roo-state-manager": {
    "enabled": true,
    "command": "node",
    "args": [
      "--import=./dist/dotenv-pre.js",
      "./dist/index.js"
    ],
    "version": "1.0.2"
  }
}
```

**Note importante sur la configuration :**
- **`--import=./dist/dotenv-pre.js`** : Cet argument est crucial pour précharger les variables d'environnement (`.env`) dans un contexte de module ESM (ECMAScript Modules) sous Node.js.
- **`version`** : Ce champ est essentiel pour le mécanisme de rechargement à chaud (hot-reload). Assurez-vous de l'incrémenter dans `package.json` et de le refléter ici après chaque modification du code pour garantir que les changements sont bien pris en compte.

### Variables d'Environnement

- `ROO_STORAGE_PATH` : Chemin personnalisé vers le stockage Roo
- `ROO_DEBUG` : Active les logs de débogage

## 🔧 Dépannage

### Le serveur ne se met pas à jour après modification (Hot-Reload)

**Symptôme** : Après avoir modifié le code source, recompilé (`npm run build`), et redémarré les MCPs, les modifications ne sont pas prises en compte.

**Cause** : Le mécanisme de détection de changement se base sur le champ `version` dans la configuration. Si cette version n'est pas mise à jour, le gestionnaire de MCPs considère que le serveur n'a pas changé et ne recharge pas le nouveau code.

**Solution** :
1.  Après chaque modification du code, **incrémentez la version** dans le fichier `package.json`.
2.  Assurez-vous que la nouvelle version est reportée dans le champ `version` de la configuration du serveur dans `mcp_settings.json` (voir l'exemple de configuration ci-dessus).
3.  Recompilez le projet avec `npm run build`.
4.  Redémarrez les serveurs MCPs.

Cette pratique de versioning garantit un cycle de développement fiable.

### Instabilité de l'Extension Host VSCode - Diagnostic et Solution

**Symptôme** : Le MCP exécute du code obsolète malgré la recompilation et le redémarrage, avec des erreurs mystérieuses lors du rechargement.

**Cause racine** : L'Extension Host VSCode peut être dans un état instable qui empêche le chargement correct des nouveaux MCPs. Cette instabilité se manifeste par :
- Erreurs au démarrage (`RangeError: path should be a path.relative()d string`)
- État d'extension volumineux (>1MB) causant des ralentissements
- Messages "Extension host is unresponsive" fréquents

**Diagnostic** :
1. **Vérifiez les logs de l'Extension Host VSCode** :
   - Ouvrir la palette de commandes (`Ctrl+Shift+P`)
   - Rechercher `Developer: Open Extension Host Log`
   - Examiner les erreurs récentes, particulièrement :
     ```
     [error] [Fenêtre] [Extension Host] Error checking protection for [...]: RangeError: path should be a `path.relative()`d string
     [warning] [Fenêtre] [mainThreadStorage] large extension state detected (extensionId: RooVeterinaryInc.roo-cline, global: true): >1000kb
     [info] [Fenêtre] Extension host (LocalProcess pid: [...]) is unresponsive
     ```

2. **Utilisez l'outil de diagnostic intégré** :
   ```bash
   use_mcp_tool "roo-state-manager" "read_vscode_logs" {"lines": 50, "filter": "error"}
   ```

**Solutions** :
1. **Redémarrage complet de l'Extension Host** :
   - Palette de commandes → `Developer: Reload Extension Host`
   - Si persistant : Redémarrer complètement VSCode

2. **Nettoyage de l'état d'extension** :
   - Vérifier la taille des fichiers dans `globalStorage/RooVeterinaryInc.roo-cline/`
   - Sauvegarder et nettoyer les gros fichiers d'état si nécessaire

3. **En dernier recours** : Réinstallation de l'extension Roo

**Note importante** : Cette instabilité peut masquer complètement les problèmes de rechargement MCP normaux (versioning, build). Toujours diagnostiquer l'Extension Host en premier lieu avant d'investiguer d'autres causes.

## 🛠️ Développement

### Scripts Disponibles

- `npm run build` : Compilation TypeScript
- `npm run dev` : Compilation en mode watch
- `npm run test` : Tests Jest
- `npm run test:detector` : Test du détecteur de stockage
- `npm run start` : Démarrage du serveur MCP

### Architecture

Le projet suit l'architecture MCP standard avec :
- **Types** : Interfaces TypeScript pour la cohérence des données
- **Utils** : Utilitaires de détection et manipulation du stockage
- **Services** : Services métier pour traitement avancé des conversations
  - `TraceSummaryService` : Génération de résumés avec Progressive Disclosure Pattern
  - `ConversationSkeleton` : Structure de données optimisée pour l'analyse
- **Server** : Serveur MCP principal avec gestion des outils

#### TraceSummaryService - Architecture Technique

Le `TraceSummaryService` implémente une architecture modulaire pour le rendu de conversations avec support étendu pour l'analyse de grappes de tâches :

**Classes principales :**
- `TraceSummaryService` : Service principal avec méthodes publiques étendues
- `ConversationSkeleton` : Structure de données pré-parsée optimisée
- `ClusterSummaryOptions` : Configuration spécialisée pour l'analyse de grappes
- `ClusterSummaryResult` : Structure de résultat enrichie avec métadonnées de grappe

**Méthodes de rendu modulaires (existantes) :**
- `renderConversationContent()` : Point d'entrée principal pour le contenu
- `renderUserMessage()` : Messages utilisateur avec Progressive Disclosure
- `renderAssistantMessage()` : Messages assistant avec formatage Markdown
- `renderToolResult()` : Résultats d'outils avec gestion des erreurs
- `renderTechnicalBlocks()` : Blocs `<details>/<summary>` pour contenu technique

**Nouvelles méthodes pour grappes de tâches :**
- `generateClusterSummary()` : Génération de résumés multi-tâches
- `analyzeClusterStatistics()` : Calcul de métriques spécialisées pour grappes
- `buildClusterTimeline()` : Construction de timeline chronologique consolidée
- `detectCrossTaskPatterns()` : Analyse des patterns transversaux
- `renderClusterContent()` : Rendu spécialisé pour contenu de grappe

**Fonctionnalités avancées :**
- **Progressive Disclosure** : Masquage automatique des `environment_details` volumineux
- **Modes de détail adaptatifs** : 6 modes pour différents cas d'usage
- **CSS intégré** : Styling complet avec classes sémantiques
- **Nettoyage intelligent** : Suppression des markers de début/fin automatiques
- **🆕 Analyse de grappes** : Métriques spécialisées et relations hiérarchiques
- **🆕 Timeline consolidée** : Vue chronologique multi-tâches
- **🆕 Patterns croisés** : Détection automatique de tendances communes

## 🔄 Configuration RooSync

RooSync est intégré dans roo-state-manager pour permettre la synchronisation de configurations entre plusieurs machines via Google Drive.

### Variables d'Environnement

Les variables suivantes doivent être définies dans le fichier `.env` :

#### ROOSYNC_SHARED_PATH
- **Type :** Chemin absolu
- **Requis :** Oui
- **Description :** Chemin vers le répertoire Google Drive partagé contenant les états synchronisés
- **Exemple Windows :** `G:/Mon Drive/Synchronisation/RooSync/.shared-state`
- **Exemple Mac/Linux :** `~/Google Drive/Synchronisation/RooSync/.shared-state`

#### ROOSYNC_MACHINE_ID
- **Type :** String (alphanumeric + tirets/underscores)
- **Requis :** Oui
- **Description :** Identifiant unique de cette machine
- **Format :** `[A-Z0-9_-]+`
- **Exemples :** `PC-PRINCIPAL`, `MAC-DEV`, `LAPTOP-WORK`

#### ROOSYNC_AUTO_SYNC
- **Type :** Boolean
- **Requis :** Oui
- **Valeurs :** `true` | `false`
- **Défaut Recommandé :** `false`
- **Description :** Active la synchronisation automatique en arrière-plan

#### ROOSYNC_CONFLICT_STRATEGY
- **Type :** Enum
- **Requis :** Oui
- **Valeurs :** `manual` | `auto-local` | `auto-remote`
- **Défaut Recommandé :** `manual`
- **Description :** Stratégie de résolution des conflits de synchronisation
  - `manual` : L'utilisateur doit approuver chaque décision
  - `auto-local` : Préférence automatique pour les changements locaux
  - `auto-remote` : Préférence automatique pour les changements distants

#### ROOSYNC_LOG_LEVEL
- **Type :** Enum
- **Requis :** Oui
- **Valeurs :** `debug` | `info` | `warn` | `error`
- **Défaut Recommandé :** `info`
- **Description :** Niveau de verbosité des logs RooSync

### Validation de la Configuration

La configuration est automatiquement validée au démarrage du serveur. Si une variable est manquante ou invalide, une erreur `RooSyncConfigError` est levée.

Pour tester la configuration, utilisez la suite de tests unitaires :

```bash
npm test src/config/roosync-config.test.ts
```

### Outils MCP RooSync

Les outils suivants seront disponibles une fois l'implémentation complète :

- `roosync_get_status` : Obtenir l'état de synchronisation
- `roosync_compare_config` : Comparer configurations entre machines
- `roosync_list_diffs` : Lister les différences détectées
- `roosync_get_decision` : Récupérer une décision spécifique
- `roosync_approve_decision` : Approuver une décision
- `roosync_reject_decision` : Rejeter une décision
- `roosync_apply_decision` : Appliquer une décision
- `roosync_rollback_decision` : Annuler une décision appliquée

### Architecture

RooSync utilise une architecture 5 couches :

1. **Configuration Layer** : Validation et chargement des variables .env
2. **Read/Analysis Layer** : Lecture et parsing des fichiers RooSync
3. **Presentation Layer** : Formatage et présentation des données
4. **Decision Layer** : Gestion du workflow de décisions
5. **Execution Layer** : Application et rollback des changements

### Documentation Complète

Pour plus de détails, consultez :
- [Architecture d'intégration](../../../../../docs/integration/03-architecture-integration-roosync.md)
- [Points d'intégration](../../../../../docs/integration/02-points-integration-roosync.md)
- [CHANGELOG RooSync](../../../../../RooSync/CHANGELOG.md)

## 📝 Roadmap

- [ ] Sauvegarde automatique des conversations
- [ ] Restauration sélective de conversations
- [ ] Synchronisation entre machines
- [ ] Interface web de gestion
- [ ] Export vers formats standards
- [ ] Compression et archivage automatique

## 🤝 Contribution

1. Fork le projet
2. Créez une branche feature (`git checkout -b feature/nouvelle-fonctionnalite`)
3. Committez vos changements (`git commit -am 'Ajout nouvelle fonctionnalité'`)
4. Push vers la branche (`git push origin feature/nouvelle-fonctionnalite`)
5. Créez une Pull Request

## 📄 Licence

MIT License - voir le fichier LICENSE pour plus de détails.