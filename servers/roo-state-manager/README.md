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

## 🔔 Système de Notifications Push

**✅ NOUVELLE FONCTIONNALITÉ - NOTIFICATIONS EVENT-DRIVEN OPÉRATIONNELLES**

Le Roo State Manager intègre un système de notifications push générique qui déclenche automatiquement des événements lors de l'usage de n'importe quel outil MCP.

**Documentation technique complète :** [`docs/notifications/PUSH-NOTIFICATION-SYSTEM.md`](./docs/notifications/PUSH-NOTIFICATION-SYSTEM.md)

### Fonctionnalités Clés

- **Interception automatique** de tous les appels d'outils MCP
- **Indexation temps réel** des nouvelles conversations détectées sur disque
- **Vérification boîte de réception RooSync** pour nouveaux messages inter-machines
- **Filtrage configurable** des notifications via règles firewall-like
- **Architecture event-driven** basée sur le pattern Observer

### Activation Rapide

```bash
# Dans .env
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_CHECK_INBOX=true
NOTIFICATIONS_MIN_PRIORITY=HIGH
```

**Configuration avancée :** Voir [`config/notification-filters.json`](./config/notification-filters.json) pour personnaliser les règles de filtrage.

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

### 🐛 Outils de Debug

Le roo-state-manager inclut des outils de diagnostic avancés pour analyser et résoudre les problèmes de parsing et de hiérarchie des tâches.

#### `debug_task_parsing`
Analyse détaillée du parsing des tâches pour diagnostiquer les problèmes hiérarchiques.

**Fonctionnalités :**
- Analyse ligne par ligne du parsing d'une tâche
- Identification des patterns `newTask` et leurs extractions
- Vérification des relations parent-enfant via RadixTree
- Diagnostic complet avec métriques de succès

**Exemple d'utilisation :**
```json
{
  "tool_name": "debug_task_parsing",
  "server_name": "roo-state-manager",
  "arguments": {
    "task_id": "task-abc123"
  }
}
```

#### `debug_analyze_conversation`
Debug approfondi d'une conversation avec analyse des données brutes.

**Fonctionnalités :**
- Retourne les données brutes non filtrées d'une conversation
- Analyse détaillée des métadonnées de tâche
- Inspection des messages API et UI
- Identification des incohérences structurelles

**Exemple d'utilisation :**
```json
{
  "tool_name": "debug_analyze_conversation",
  "server_name": "roo-state-manager",
  "arguments": {
    "taskId": "task-def456"
  }
}
```

#### `view_task_details`
Affiche les détails techniques complets (métadonnées des actions) pour une tâche spécifique.

**Fonctionnalités :**
- Métadonnées complètes de chaque action
- Index optionnel pour examiner une action spécifique
- Troncature configurable pour contenus volumineux
- Analyse technique approfondie

**Paramètres :**
- `task_id` (string) : ID de la tâche à examiner
- `action_index` (number, optionnel) : Index d'une action spécifique
- `truncate` (number, optionnel) : Nombre de lignes à conserver (0 = complet)

**Exemple d'utilisation :**
```json
{
  "tool_name": "view_task_details",
  "server_name": "roo-state-manager",
  "arguments": {
    "task_id": "task-ghi789",
    "action_index": 5,
    "truncate": 50
  }
}
```

---

---

## 📋 Liste Complète des Outils MCP (42 outils)

Le roo-state-manager propose **42 outils MCP** organisés en 11 catégories fonctionnelles.

### 🗄️ Stockage & Détection (2 outils)
| Outil | Description |
|-------|-------------|
| [`detect_roo_storage`](#detect_roo_storage) | Détecte automatiquement les emplacements de stockage Roo |
| [`get_storage_stats`](#get_storage_stats) | Obtient statistiques globales du stockage |

### 💬 Conversations & Navigation (4 outils)
| Outil | Description |
|-------|-------------|
| [`list_conversations`](#list_conversations) | Liste conversations avec filtres et tri |
| [`get_task_tree`](#get_task_tree) | Récupère arbre hiérarchique de tâches |
| [`view_conversation_tree`](#view_conversation_tree) | Vue condensée arborescente avec filtres |
| [`get_raw_conversation`](#get_raw_conversation) | Récupère contenu brut d'une conversation |

### 🐛 Debug & Analyse (3 outils)
| Outil | Description |
|-------|-------------|
| [`debug_task_parsing`](#debug_task_parsing) | Analyse détaillée parsing de tâches |
| [`debug_analyze_conversation`](#debug_analyze_conversation) | Debug approfondi d'une conversation |
| [`view_task_details`](#view_task_details) | Détails techniques complets des actions |

### 🔍 Recherche & Indexation (2 outils)
| Outil | Description |
|-------|-------------|
| [`search_tasks_semantic`](#search_tasks_semantic) | Recherche sémantique de tâches via Qdrant |
| [`index_task_semantic`](#index_task_semantic) | Indexe tâche spécifique dans Qdrant |

### ⚡ Cache & Performance (2 outils)
| Outil | Description |
|-------|-------------|
| [`build_skeleton_cache`](#build_skeleton_cache) | Reconstruction cache squelettes |
| [`reset_qdrant_collection`](#reset_qdrant_collection) | Réinitialise collection Qdrant complète |

### 📄 Exports XML (4 outils)
| Outil | Description |
|-------|-------------|
| [`export_tasks_xml`](#export_tasks_xml) | Exporte tâche individuelle XML |
| [`export_conversation_xml`](#export_conversation_xml) | Exporte conversation complète XML |
| [`export_project_xml`](#export_project_xml) | Exporte aperçu projet XML |
| [`configure_xml_export`](#configure_xml_export) | Configure paramètres exports XML |

### 📊 Exports Autres Formats (3 outils)
| Outil | Description |
|-------|-------------|
| [`export_conversation_json`](#export_conversation_json) | Export JSON variantes light/full |
| [`export_conversation_csv`](#export_conversation_csv) | Export CSV (conversations/messages/tools) |
| [`export_task_tree_markdown`](#export_task_tree_markdown) | Export arbre tâches Markdown hiérarchique |

### 📝 Résumés & Synthèse (3 outils)
| Outil | Description |
|-------|-------------|
| [`generate_trace_summary`](#generate_trace_summary) | Résumé intelligent conversation Roo |
| [`generate_cluster_summary`](#generate_cluster_summary) | Résumé grappe de tâches liées |
| [`get_conversation_synthesis`](#get_conversation_synthesis) | Synthèse LLM via OpenAI |

### 🔧 Réparation & Maintenance (3 outils)
| Outil | Description |
|-------|-------------|
| [`diagnose_conversation_bom`](#diagnose_conversation_bom) | Diagnostique fichiers corrompus BOM UTF-8 |
| [`repair_conversation_bom`](#repair_conversation_bom) | Répare fichiers corrompus BOM |
| [`rebuild_task_index`](#rebuild_task_index) | Reconstruit index SQLite tâches orphelines |

### 🛠️ Outils VSCode & MCP (5 outils)
| Outil | Description |
|-------|-------------|
| [`read_vscode_logs`](#read_vscode_logs) | Lit logs VSCode automatiquement |
| [`manage_mcp_settings`](#manage_mcp_settings) | Gère [`mcp_settings.json`](../../../../../config/mcp_settings.json) sécurisé |
| [`rebuild_and_restart_mcp`](#rebuild_and_restart_mcp) | Rebuild MCP + redémarrage ciblé |
| [`touch_mcp_settings`](#touch_mcp_settings) | Force rechargement tous MCPs |
| [`get_mcp_best_practices`](#get_mcp_best_practices) | Guide patterns configuration/debug |

### 🔄 RooSync v2.0 (9 outils)
| Outil | Description |
|-------|-------------|
| [`roosync_init`](#roosync_init) | Initialise infrastructure RooSync |
| [`roosync_get_status`](#roosync_get_status) | État synchronisation actuel |
| [`roosync_compare_config`](#roosync_compare_config) | **✨ v2.0** Compare configs avec détection réelle |
| [`roosync_list_diffs`](#roosync_list_diffs) | Liste différences détectées |
| [`roosync_get_decision_details`](#roosync_get_decision_details) | Détails complets décision |
| [`roosync_approve_decision`](#roosync_approve_decision) | Approuve décision sync |
| [`roosync_reject_decision`](#roosync_reject_decision) | Rejette décision avec motif |
| [`roosync_apply_decision`](#roosync_apply_decision) | Applique décision approuvée |
| [`roosync_rollback_decision`](#roosync_rollback_decision) | Annule décision appliquée |

### 🧪 Test & Diagnostic (1 outil)
| Outil | Description |
|-------|-------------|
| `minimal_test_tool` | Outil test minimal rechargement MCP |

**Total : 42 outils MCP** organisés pour couvrir l'ensemble du cycle de vie de gestion des conversations Roo.

---

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

---

## 📦 Exports JSON/CSV

En complément des exports XML et Markdown, le roo-state-manager propose des exports au format JSON et CSV pour l'analyse de données et l'intégration avec des outils externes.

### `export_conversation_json`
Exporte une conversation au format JSON avec variantes light ou full.

**Variantes disponibles :**
- **`light`** : Squelette multi-conversations optimisé pour l'aperçu
- **`full`** : Détail complet avec tout le contenu des messages

**Paramètres :**
- `taskId` (string) : ID de la tâche à exporter
- `filePath` (string, optionnel) : Chemin de destination du fichier
- `jsonVariant` (string, optionnel) : 'light' ou 'full' (défaut: 'light')
- `truncationChars` (number, optionnel) : Limite de troncature (0 = pas de limite)
- `startIndex` / `endIndex` (number, optionnel) : Plage de messages à traiter

**Exemple d'utilisation :**
```json
{
  "tool_name": "export_conversation_json",
  "server_name": "roo-state-manager",
  "arguments": {
    "taskId": "task-abc123",
    "jsonVariant": "full",
    "filePath": "./exports/conversation-full.json"
  }
}
```

### `export_conversation_csv`
Exporte une conversation au format CSV avec 3 variantes spécialisées.

**Variantes disponibles :**
- **`conversations`** : Vue table de toutes les conversations (aperçu global)
- **`messages`** : Détail de chaque message (analyse temporelle)
- **`tools`** : Appels d'outils uniquement (analyse technique)

**Paramètres :**
- `taskId` (string) : ID de la tâche à exporter
- `filePath` (string, optionnel) : Chemin de destination du fichier
- `csvVariant` (string, optionnel) : 'conversations', 'messages', ou 'tools' (défaut: 'conversations')
- `truncationChars` (number, optionnel) : Limite de troncature (0 = pas de limite)
- `startIndex` / `endIndex` (number, optionnel) : Plage de messages à traiter

**Exemple d'utilisation :**
```json
{
  "tool_name": "export_conversation_csv",
  "server_name": "roo-state-manager",
  "arguments": {
    "taskId": "task-def456",
    "csvVariant": "messages",
    "filePath": "./exports/messages-timeline.csv"
  }
}
```

**Cas d'usage :**
- Import dans Excel/Google Sheets pour analyse quantitative
- Traitement par scripts Python/R pour data science
- Intégration avec outils BI (Tableau, Power BI)
- Analyse de patterns temporels et métriques de performance

---

## 🗂️ Gestion Hiérarchique des Tâches

Le roo-state-manager implémente un système avancé de reconstruction hiérarchique des tâches avec relations parent-enfant automatiques.

### Fonctionnalités Hiérarchiques

**Relations Parent-Enfant Automatiques**
- Extraction automatique des instructions `newTask` depuis les conversations
- Matching intelligent via RadixTree pour associer tâches parentes et enfantes
- Navigation multi-niveaux avec profondeur configurable (`max_depth`)
- Support des grappes de tâches complexes

**RadixTree Matching**
Le système utilise un algorithme RadixTree pour matcher les patterns `newTask` extraits des conversations avec les IDs de tâches réelles :
- Matching fuzzy avec tolérance aux variations
- Score de confiance pour chaque relation détectée
- Gestion des cas ambigus avec logs détaillés

**Navigation Arborescente**
- `get_task_tree` : Récupère l'arbre hiérarchique complet d'une conversation
- `view_conversation_tree` : Vue condensée avec filtres et tri
- `export_task_tree_markdown` : Export Markdown hiérarchique avec statuts

### Outils de Navigation

#### `get_task_tree`
Récupère une vue arborescente et hiérarchique des tâches avec relations parent-enfant.

**Paramètres :**
- `conversation_id` (string) : ID de la conversation racine
- `max_depth` (number, optionnel) : Profondeur maximale de l'arbre
- `include_siblings` (boolean, optionnel) : Inclure les tâches sœurs
- `current_task_id` (string, optionnel) : Marquer la tâche actuelle

**Sortie :**
```json
{
  "root": {
    "id": "task-abc123",
    "title": "Tâche principale",
    "children": [
      {
        "id": "task-def456",
        "title": "Sous-tâche 1",
        "parentId": "task-abc123"
      }
    ]
  }
}
```

#### `export_task_tree_markdown`
Exporte un arbre de tâches au format Markdown hiérarchique avec statuts de complétion.

**Format de sortie :**
```markdown
# Arbre de Tâches: Projet XYZ

## Tâche Principale (task-abc123) ✅
- Status: Completed
- Messages: 25
- Created: 2025-10-15

### Sous-tâche 1 (task-def456) 🔄
- Status: In Progress
- Messages: 12
- Created: 2025-10-15
```

**Documentation complète** : [`docs/tests/hierarchie-reconstruction-validation.md`](docs/tests/hierarchie-reconstruction-validation.md)

---

## ⚡ Cache & Performance

Le système de cache du roo-state-manager est conçu pour optimiser les performances tout en garantissant la fraîcheur des données.

### `build_skeleton_cache`
Reconstruit le cache de squelettes de conversations de manière différentielle ou complète.

**Fonctionnalités :**
- **Reconstruction différentielle** : Ne reconstruit que les squelettes obsolètes (rapide)
- **Reconstruction complète** : Force la reconstruction de tous les squelettes (lent, avec `force_rebuild: true`)
- **Filtrage par workspace** : Limite la reconstruction à un workspace spécifique
- **Détection automatique de fraîcheur** : Compare timestamps pour éviter les rebuilds inutiles

**Paramètres :**
- `force_rebuild` (boolean, optionnel) : Force la reconstruction complète (défaut: false)
- `workspace_filter` (string, optionnel) : Filtre par workspace spécifique

**Exemple d'utilisation :**
```json
{
  "tool_name": "build_skeleton_cache",
  "server_name": "roo-state-manager",
  "arguments": {
    "force_rebuild": false,
    "workspace_filter": "d:/roo-extensions"
  }
}
```

**Performance :**
- Reconstruction différentielle : ~2-5s pour 100 conversations
- Reconstruction complète : ~30-60s pour 1000+ conversations
- Détection fraîcheur : <100ms

### Gestion de la Mémoire

**Anti-leak Management**
Le système intègre des mécanismes de gestion mémoire pour éviter les fuites :
- Libération automatique des caches volumineux après traitement
- Limits configurables sur la taille des caches en mémoire
- Garbage collection proactive pour les objets temporaires

**Métriques de Performance**
Le cache maintient des métriques de performance accessibles via les outils de monitoring :
- Hit rate du cache
- Temps moyen de reconstruction
- Taille totale du cache sur disque

---

## 🛠️ Outils VSCode & MCP

Le roo-state-manager inclut des outils spécialisés pour la gestion du serveur MCP, la maintenance VSCode et le débogage.

### Gestion MCP

#### `manage_mcp_settings`
Gère le fichier [`mcp_settings.json`](../../../../../config/mcp_settings.json) en lecture et écriture sécurisée.

**Actions disponibles :**
- **`read`** : Lit la configuration actuelle
- **`write`** : Écrit une nouvelle configuration complète (avec backup automatique)
- **`backup`** : Crée une sauvegarde manuelle
- **`update_server`** : Met à jour la configuration d'un serveur spécifique
- **`toggle_server`** : Active/désactive un serveur MCP

**Exemple d'utilisation :**
```json
{
  "tool_name": "manage_mcp_settings",
  "server_name": "roo-state-manager",
  "arguments": {
    "action": "toggle_server",
    "server_name": "quickfiles",
    "backup": true
  }
}
```

#### `rebuild_and_restart_mcp`
Rebuild un MCP spécifique et déclenche un redémarrage ciblé ou global.

**Stratégie de Redémarrage :**
- **Ciblé** : Touche le premier fichier dans `watchPaths` si configuré (recommandé)
- **Global** : Touche le fichier de settings global (fallback)

**Paramètres :**
- `mcp_name` (string) : Nom du MCP à rebuilder (selon [`mcp_settings.json`](../../../../../config/mcp_settings.json))

**Exemple d'utilisation :**
```json
{
  "tool_name": "rebuild_and_restart_mcp",
  "server_name": "roo-state-manager",
  "arguments": {
    "mcp_name": "roo-state-manager"
  }
}
```

⚠️ **Important** : Le MCP doit avoir `watchPaths` configuré pour un redémarrage ciblé fiable.

#### `touch_mcp_settings`
Force le rechargement de tous les MCPs en touchant le fichier de settings global.

**Utilisation :** Simple outil sans paramètres qui déclenche un rechargement global.

```json
{
  "tool_name": "touch_mcp_settings",
  "server_name": "roo-state-manager",
  "arguments": {}
}
```

### Diagnostics VSCode

#### `read_vscode_logs`
Scanne et lit automatiquement les logs VSCode les plus récents (Extension Host, Renderer, Roo-Code Output).

**Fonctionnalités :**
- Détection automatique du répertoire de logs VSCode
- Lecture des 3 types de logs principaux
- Filtrage par mot-clé ou regex
- Support multi-sessions pour débogage de démarrage MCP

**Paramètres :**
- `lines` (number, optionnel) : Nombre de lignes à lire depuis la fin (défaut: 100)
- `filter` (string, optionnel) : Mot-clé ou regex pour filtrer les lignes
- `maxSessions` (number, optionnel) : Nombre de sessions récentes à scanner (défaut: 1, utiliser 3-5 pour erreurs de démarrage MCP)

**Exemple d'utilisation :**
```json
{
  "tool_name": "read_vscode_logs",
  "server_name": "roo-state-manager",
  "arguments": {
    "lines": 200,
    "filter": "error|warning|roo-state-manager",
    "maxSessions": 3
  }
}
```

**Cas d'usage :**
- Débogage des erreurs de démarrage MCP
- Analyse des crashes d'Extension Host
- Investigation des problèmes de performance
- Traçage des interactions serveur MCP

---

## 📚 Best Practices MCP

### `get_mcp_best_practices`
Guide de référence sur les patterns de configuration et de débogage pour les MCPs.

**Contenu du guide :**
- ✅ **Patterns de Configuration** : Best practices pour `mcp_settings.json`, `watchPaths`, versioning
- ✅ **Stratégies de Débogage** : Techniques éprouvées pour diagnostiquer les problèmes MCP
- ✅ **Hot-Reload Fiable** : Configuration optimale pour rechargement rapide et stable
- ✅ **Gestion Dépendances** : Patterns pour dependencies TypeScript/ESM
- ✅ **Monitoring & Logs** : Configuration logging pour production
- ✅ **Performance** : Optimisations pour temps de démarrage et réponse

**Paramètres :**
- `mcp_name` (string, optionnel) : Nom du MCP spécifique à analyser (inclut arborescence + config si fourni)

**Exemple d'utilisation :**
```json
{
  "tool_name": "get_mcp_best_practices",
  "server_name": "roo-state-manager",
  "arguments": {
    "mcp_name": "roo-state-manager"
  }
}
```

**Sortie :**
Le guide retourne un document Markdown structuré avec :
- 🏗️ Architecture recommandée
- ⚙️ Configuration optimale
- 🐛 Techniques de débogage
- 🚀 Optimisations de performance
- 📖 Références vers documentation développeur

**Note** : Ce guide est basé sur l'expérience de stabilisation du roo-state-manager et des patterns éprouvés en production.

---

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

**✅ NOUVELLE VERSION v2.0 - Détection Réelle de Différences (Oct 2025)**

RooSync v2.0 représente une évolution majeure du système de synchronisation, avec détection intelligente des vraies différences entre environnements Roo distincts.

### 🎯 Vue d'Ensemble v2.0

RooSync v2.0 implémente un système de détection de différences à **4 niveaux** avec scoring automatique de sévérité :

1. **🔴 CRITICAL** - Configuration Roo (MCPs, Modes, Settings)
2. **🟠 IMPORTANT** - Hardware (CPU, RAM, Disques, GPU)
3. **🟡 WARNING** - Software (PowerShell, Node, Python)
4. **🔵 INFO** - System (OS, Architecture)

### 🏗️ Architecture v2.0

**Composants Principaux (3 phases) :**

**Phase 1 - InventoryCollector** (278 lignes)
- Collecte inventaire système via [`Get-MachineInventory.ps1`](../../../../../scripts/inventory/Get-MachineInventory.ps1)
- Cache intelligent TTL 1h pour performance optimale
- Support multi-plateforme (Windows prioritaire)
- Tests : 5/5 (100%) ✅

**Phase 2 - DiffDetector** (590 lignes)  
- Comparaison multi-niveaux (Roo/Hardware/Software/System)
- Scoring sévérité automatique (CRITICAL/IMPORTANT/WARNING/INFO)
- Génération recommandations actionnables
- Tests : 9/9 (100%) ✅

**Phase 3 - Intégration RooSync** (service + outils MCP)
- [`RooSyncService.compareRealConfigurations()`](src/services/roosync.service.ts)
- Outil `roosync_compare_config` enrichi avec détection réelle
- Tests : 5/6 (83%) ✅

### 📊 Métriques v2.0

| Métrique | Valeur | Requis | Statut |
|----------|--------|--------|--------|
| **Workflow complet** | 2-4s | <5s | ✅ |
| **Collecte inventaire** | ~1s | <2s | ✅ |
| **Détection diffs** | ~1s | <2s | ✅ |
| **Cache TTL** | 1h | Configurable | ✅ |
| **Tests réussis** | 24/26 (92%) | >90% | ✅ |

**Documentation complète v2.0 (~8300 lignes) :**
- Architecture : [`roosync-real-diff-detection-design.md`](../../../../../docs/architecture/roosync-real-diff-detection-design.md) (1900 lignes)
- Tests : [`roosync-e2e-test-plan.md`](../../../../../docs/testing/roosync-e2e-test-plan.md) (561 lignes)
- Synthèse : [`roosync-v2-evolution-synthesis-20251015.md`](../../../../../docs/orchestration/roosync-v2-evolution-synthesis-20251015.md) (986 lignes)

### 🛠️ Outils MCP RooSync v2.0 (9 outils)

#### `roosync_compare_config`
**✨ NOUVEAU v2.0** - Compare configurations Roo entre machines avec détection réelle de différences.

**Fonctionnalités v2.0 :**
- ✅ Détection 4 niveaux (Roo/Hardware/Software/System)
- ✅ Scoring sévérité automatique
- ✅ Collecte inventaire via PowerShell
- ✅ Cache intelligent TTL 1h
- ✅ Recommandations actionnables

**Paramètres :**
- `source` (string, optionnel) : ID machine source (défaut: local_machine)
- `target` (string, optionnel) : ID machine cible (défaut: remote_machine)
- `force_refresh` (boolean, optionnel) : Force collecte inventaire même si cache valide

**Exemple d'utilisation :**
```json
{
  "tool_name": "roosync_compare_config",
  "server_name": "roo-state-manager",
  "arguments": {
    "source": "myia-ai-01",
    "target": "myia-po-2024",
    "force_refresh": false
  }
}
```

**Sortie v2.0 :**
```json
{
  "comparison": {
    "summary": {
      "totalDifferences": 15,
      "bySeverity": {
        "CRITICAL": 3,
        "IMPORTANT": 5,
        "WARNING": 4,
        "INFO": 3
      }
    },
    "differences": [
      {
        "category": "roo_config",
        "subcategory": "mcps",
        "severity": "CRITICAL",
        "description": "MCP 'quickfiles' présent sur source, absent sur target",
        "recommendation": "Synchroniser configuration MCP"
      }
    ]
  }
}
```

Pour les autres outils RooSync (init, get_status, list_diffs, approve_decision, reject_decision, apply_decision, rollback_decision, get_decision_details), voir la section dédiée ci-dessous.

---

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

### Intégration PowerShell Réelle

**✅ PHASE 8 TÂCHE 40 - INTÉGRATION COMPLÈTE**

Le roo-state-manager inclut désormais une intégration PowerShell complète avec RooSync :

**Composants d'intégration :**
- **PowerShellExecutor** : Wrapper Node.js → PowerShell avec `child_process.spawn`
  - Gestion timeout configurable (défaut 30s, 60s pour Apply-Decisions)
  - Parsing JSON output automatique
  - Isolation processus et gestion erreurs robuste
  - Support chemins avec espaces et caractères spéciaux

- **RooSyncService Extended** : 3 nouvelles méthodes PowerShell
  - `executeDecision()` : Approbation auto roadmap + invoke Apply-Decisions
  - `createRollbackPoint()` : Backup manuel dans .rollback/
  - `restoreFromRollbackPoint()` : Restore depuis backup
  - Invalidation cache après modifications
  - Support dryRun via backup temporaire

**Tests E2E (1182 lignes) :**
- `tests/e2e/roosync-workflow.test.ts` : Workflow complet detect → approve → apply
- `tests/e2e/roosync-error-handling.test.ts` : 20+ tests robustesse et erreurs
- `tests/e2e/run-e2e-tests.ps1` : Script automatisation exécution

**Quick Start Tests E2E :**
```bash
cd tests/e2e
.\run-e2e-tests.ps1 -All        # Tous les tests
.\run-e2e-tests.ps1 -Workflow   # Tests workflow uniquement
```

### Documentation Complète

Pour plus de détails, consultez :
- **[Plan d'intégration E2E](../../../../../docs/integration/12-plan-integration-e2e.md)** - Architecture et stratégie
- **[Résultats tests E2E](../../../../../docs/integration/13-resultats-tests-e2e.md)** - Métriques et validation
- **[Guide utilisation outils](../../../../../docs/integration/14-guide-utilisation-outils-roosync.md)** - Documentation 8 outils MCP
- [Architecture d'intégration](../../../../../docs/integration/03-architecture-integration-roosync.md)
- [Points d'intégration](../../../../../docs/integration/02-points-integration-roosync.md)
- [CHANGELOG RooSync](../../../../../RooSync/CHANGELOG.md)

## 📊 Métriques & Performance

Le roo-state-manager est maintenant un système de classe production avec des métriques de performance exceptionnelles suite à la refactorisation majeure (oct 2025).

### Métriques Globales

| Métrique | Valeur | Statut |
|----------|--------|--------|
| **Code TypeScript** | ~14 000 lignes | ✅ Production |
| **Services** | 30+ services | ✅ Modulaire |
| **Outils MCP** | 42 outils | ✅ Complet |
| **Tests** | ~40 unitaires + E2E | ✅ Couverture |
| **Documentation** | >20 000 lignes | ✅ Exhaustive |
| **RooSync Performance** | <5s workflow complet | ✅ Optimisé |
| **Tests Succès** | 92% (24/26) | ⚠️ En cours |
| **Duplication Code** | 0.33% | ✅ Excellent (<5%) |
| **Imports Circulaires** | 0 | ✅ Parfait |

### Performance Refactorisation

**Transformation architecturale majeure (13-14 oct 2025) :**
- **Réduction code** : 3896 → 221 lignes dans [`index.ts`](src/index.ts) (**-94.3%**)
- **Modularité** : 1 fichier → 142 fichiers organisés
- **Tests** : Jest cassé → Vitest fonctionnel (372/478 tests)
- **Qualité** : 0.33% duplication (benchmark excellent)

### Performance RooSync v2.0

| Métrique Workflow | Temps | Requis | Statut |
|-------------------|-------|--------|--------|
| **Workflow complet** | 2-4s | <5s | ✅ |
| **Collecte inventaire** | ~1s | <2s | ✅ |
| **Détection différences** | ~1s | <2s | ✅ |
| **Cache TTL** | 1h | Configurable | ✅ |

**Documentation complète** : [`docs/reports/PROJECT_FINAL_SYNTHESIS.md`](docs/reports/PROJECT_FINAL_SYNTHESIS.md) (897 lignes)

---

##  Roadmap

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