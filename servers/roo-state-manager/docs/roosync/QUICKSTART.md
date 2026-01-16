# RooSync - Quick Start

**RooSync** synchronise les configurations entre plusieurs machines.

## Prérequis

- PowerShell 7+ (Windows) ou Bash (Linux/Mac)
- Node.js 20+
- Un dossier partagé entre machines (réseau ou cloud)

## Installation

```bash
npm install
npm run build
```

## Workflow E2E Complet

### 1. Collecter la configuration locale

```bash
npx roosync collect-config
# Ou via MCP: roosync_collect_config({ machineId: 'myia-ai-01' })
```

Crée `sync-config.json` dans le dossier partagé.

### 2. Publier sa configuration (pour les autres machines)

```bash
npx roosync publish-config
# Ou via MCP: roosync_publish_config({ machineId: 'myia-ai-01' })
```

Rend la configuration disponible pour les autres machines.

### 3. Comparer les configurations

```bash
npx roosync compare-config --target myia-po-2026
# Ou via MCP: roosync_compare_config({ target: 'myia-po-2026' })
```

Montre les différences entre machines.

### 4. Appliquer une configuration

```bash
npx roosync apply-config --source myia-ai-01
# Ou via MCP: roosync_apply_config({ source: 'myia-ai-01' })
```

Applique la configuration source à la machine locale.

### 5. Vérifier le statut

```bash
npx roosync get-status
# Ou via MCP: roosync_get_status({})
```

Affiche l'état de synchronisation de toutes les machines.

## Outils MCP (Claude Code)

**14 outils disponibles via le wrapper v2.5.0:**

```typescript
// === Workflow E2E ===
// Collecter la configuration
roosync_collect_config({ machineId: 'myia-ai-01' })

// Publier sa configuration (pour les autres)
roosync_publish_config({ machineId: 'myia-ai-01' })

// Comparer deux machines
roosync_compare_config({ source: 'myia-ai-01', target: 'myia-po-2026' })

// Appliquer une configuration
roosync_apply_config({ source: 'myia-ai-01' })

// === Monitoring ===
// Voir le statut global
roosync_get_status({})

// Inventaire machine
roosync_get_machine_inventory({ machineId: 'myia-ai-01' })

// Lister les différences
roosync_list_diffs({ filterType: 'all' })

// === Messagerie ===
// Envoyer un message
roosync_send_message({
  to: 'myia-po-2023',
  subject: 'Bug #322 à corriger',
  body: '...',
  priority: 'HIGH'
})

// Lire la boîte de réception
roosync_read_inbox({ status: 'unread' })

// Répondre à un message
roosync_reply_message({
  message_id: 'msg-id-123',
  body: 'Je m en occupe'
})
```

## Dossier partagé

Par défaut : `G:/Mon Drive/Synchronisation/RooSync/.shared-state/`

Changez-le avec : `ROOSYNC_SHARED_PATH`

---

**Documentation complète :** [GUIDE-TECHNIQUE-v2.3.md](GUIDE-TECHNIQUE-v2.3.md)
