# Architecture MCP (Model Context Protocol)

Ce document décrit l'architecture du protocole MCP (Model Context Protocol) et comment les serveurs MCP sont structurés dans ce dépôt.

## Qu'est-ce que MCP?

Le Model Context Protocol (MCP) est un protocole qui permet aux modèles de langage (LLM) d'interagir avec des outils et des ressources externes. Il définit un format standard pour:

1. La découverte d'outils et de ressources
2. L'invocation d'outils
3. L'accès aux ressources
4. La gestion des erreurs et des résultats

## Architecture générale

```
┌─────────────┐      ┌───────────────┐      ┌───────────────┐
│             │      │               │      │               │
│     LLM     │◄────►│  MCP Server   │◄────►│ External APIs │
│             │      │               │      │               │
└─────────────┘      └───────────────┘      └───────────────┘
                            ▲
                            │
                            ▼
                     ┌─────────────┐
                     │             │
                     │  Resources  │
                     │             │
                     └─────────────┘
```

## Composants clés

### 1. Serveur MCP

Un serveur MCP est un service qui implémente le protocole MCP et expose des outils et des ressources aux LLM. Chaque serveur MCP peut fournir plusieurs outils et ressources.

#### Types de serveurs MCP

Dans ce dépôt, les serveurs MCP sont placés directement dans le répertoire `servers/`:

- **roo-state-manager**: 17 outils MCP pour la coordination multi-agent (RooSync)
- **sk-agent**: LLM proxy multi-agent avec mémoire vectorielle

### 2. Outils (Tools)

Les outils sont des fonctions que le LLM peut invoquer pour effectuer des actions spécifiques. Chaque outil a:

- Un nom unique
- Une description
- Un schéma d'entrée (paramètres attendus)
- Un schéma de sortie (format du résultat)

Exemple de définition d'outil:

```json
{
  "name": "get_weather",
  "description": "Obtient les informations météorologiques pour une ville donnée",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "Nom de la ville"
      },
      "country": {
        "type": "string",
        "description": "Code pays ISO à 2 lettres"
      }
    },
    "required": ["city"]
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "temperature": {
        "type": "number",
        "description": "Température en degrés Celsius"
      },
      "conditions": {
        "type": "string",
        "description": "Description des conditions météorologiques"
      }
    }
  }
}
```

### 3. Ressources (Resources)

Les ressources sont des sources de données que le LLM peut consulter. Chaque ressource a:

- Un URI unique
- Un type de contenu
- Des métadonnées

Exemple de ressource:

```
weather://paris/current
```

### 4. Protocole de communication

Le protocole MCP utilise deux méthodes principales de communication:

#### Stdio-based (Local)

Pour les serveurs locaux, la communication se fait via stdin/stdout:

```
LLM -> stdin -> MCP Server -> stdout -> LLM
```

#### SSE-based (Remote)

Pour les serveurs distants, la communication se fait via Server-Sent Events (SSE) sur HTTP/HTTPS:

```
LLM -> HTTP Request -> MCP Server -> SSE -> LLM
```

## Structure d'un serveur MCP

Chaque serveur MCP dans ce dépôt suit cette structure:

```
servers/
└── server-name/
    ├── README.md           # Documentation du serveur
    ├── package.json        # Dépendances et scripts
    ├── server.js ou index.ts # Point d'entrée du serveur
    ├── config.example.json # Configuration d'exemple (si nécessaire)
    ├── config.json         # Configuration réelle (ignorée par git)
    ├── src/                # Code source
    │   ├── tools/          # Implémentation des outils
    │   ├── resources/      # Implémentation des ressources
    │   └── utils/          # Utilitaires
    └── tests/              # Tests
```

## Cycle de vie d'une requête MCP

1. **Découverte**: Le LLM découvre les outils et ressources disponibles sur le serveur MCP
2. **Sélection**: Le LLM sélectionne un outil ou une ressource à utiliser
3. **Invocation/Accès**: Le LLM invoque l'outil ou accède à la ressource
4. **Traitement**: Le serveur MCP traite la requête
5. **Réponse**: Le serveur MCP renvoie le résultat au LLM
6. **Intégration**: Le LLM intègre le résultat dans sa réponse

## Arrêt gracieux et drainage des écritures (roo-state-manager)

Le serveur roo-state-manager réplique ses écritures vers PostgreSQL (dual-write). À l'arrêt du serveur, des écritures en vol peuvent être perdues (#3151). Le chemin d'arrêt résout ceci en deux temps (`drainPendingDualWrites`, `roosync-channel-dual-write.ts`):

1. **Attente des opérations miroir enregistrées** — bornée par un timeout, re-vérifiée au fil des nouvelles opérations.
2. **Fermeture du writer partagé** — `PgUnifiedStoreWriter.close()` appelle `pool.end()` de node-postgres, qui draine: en plus de l'attente explicite ci-dessus, il attend les requêtes déjà confiées à un client. Le writer étant partagé, toutes les voies (dont la voie conversation) sont couvertes par ce même drain.

Comportements aux limites:

- Le drain retourne `false` au timeout et journalise les écritures restantes (potentiellement perdues).
- Un arrêt brutal (hard kill, ex. TerminateProcess sous Windows) contourne tout le chemin — ce résiduel relève d'une passe de reconcile/backfill, pas du chemin d'arrêt.

Référence: PR #1071 (fix), issue #3151 (constat initial).

## Dashboards RooSync : deux cibles co-égales, une porte de lecture par hôte (#3537 §6.1)

Un dashboard RooSync vit dans **deux artefacts co-égaux**, dont aucun ne dérive de l'autre:

| | Chemin | Code |
|---|---|---|
| **Écriture** | `tmp → rename` sur le `.md` GDrive (garde anti-fork #3482), **puis** `dualWriteDashboardSync` vers `roosync_dashboards` + `roosync_dashboard_messages` | `dashboard.ts` (writeDashboardFile) puis `roosync-dashboard-store.ts` |
| **Lecture** | **PG d'abord**, fichier GDrive en **repli** — sur échec PG *ou clé absente* (protection anti-sous-affichage) | `readDashboardFile` → `readDashboardFromPg` / `readDashboardFromGdrive` |
| **La porte** | `UNIFIED_STORE_DASHBOARD_READ_PG !== '1'` → lecture fichier uniquement | `roosync-dashboard-store.ts` (`getDashboardPgReader`) |

**Il n'y a PAS de source de vérité globale** : elle dépend du `.env` de chaque hôte. Un hôte à porte PG ouverte lit PG (et verra la divergence fichier↔PG), un hôte à porte fermée lit le fichier. C'est pourquoi deux fichiers byte-identiques peuvent rendre deux lectures différentes selon la clé interrogée, et pourquoi aucune des deux ne correspond forcément au disque.

**Conséquence opératoire (le piège)**: un geste de système de fichiers (`cp`, `mv`, `rm`, renommage d'un ` (1).md`) n'écrit que la moitié fichier — PG ne le voit jamais, aucune erreur n'est émise. « Ça répare pour les hôtes qui lisent le fichier, et rien pour ceux qui lisent PG. » **Le seul canal qui écrit les deux artefacts est l'API MCP** — c'est le rôle de l'action `merge` (§6.2, `handleMerge`): union des QUATRE vues (PG + fichier de chaque clé) par id, statut le plus récent retenu, upsert PG de la cible **vérifié** (outcome checked) avant tout retrait, puis source archivée par **renommage atomique** et retirée des deux artefacts — ligne PG en dernier. Le verrou append cross-process des deux clés y est **fail-closed** (`withAppendLockRequired`) : pas de verrou, pas de merge.

Divergence connue et désamorcée: `applyCondensedWithMerge` s'ancre volontairement sur `readDashboardFromGdrive` (l'artefact qu'elle écrase) — mesuré 07/09: 15/63 dashboards divergent; ne PAS repointer la condensation sur la lecture PG sans re-mesurer.

Référence: issue roo-extensions #3537 (recensement 1 613 paires fork, 0 perte), #3482 (garde anti-fork DriveFS), #3151 Phase C (dual-write PG), PR #1134 (rework : verrous fail-closed + persistance PG vérifiée).

## Sécurité

Les serveurs MCP peuvent implémenter différentes mesures de sécurité:

- Authentification par clé API
- Limitation de débit
- Validation des entrées
- Isolation des processus
- Journalisation et audit

## Pour en savoir plus

- [Spécification MCP officielle](https://github.com/microsoft/mcp)
- [Guide de démarrage](getting-started.md)
- [Guide de dépannage](troubleshooting.md)