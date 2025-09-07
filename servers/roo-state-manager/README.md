# Roo State Manager MCP

Serveur MCP (Model Context Protocol) unifié pour la gestion des conversations et configurations Roo.

## 🎯 Objectif

Le Roo State Manager résout les problèmes de perte de conversations Roo en fournissant :
- Détection automatique du stockage Roo existant
- Gestion unifiée des conversations et configurations
- Sauvegarde et restauration des données
- Interface MCP pour l'intégration avec d'autres outils

## 📁 Structure du Projet

```
roo-state-manager/
├── src/
│   ├── types/
│   │   └── conversation.ts      # Interfaces TypeScript
│   ├── utils/
│   │   └── roo-storage-detector.ts  # Détecteur de stockage
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
- **Server** : Serveur MCP principal avec gestion des outils

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