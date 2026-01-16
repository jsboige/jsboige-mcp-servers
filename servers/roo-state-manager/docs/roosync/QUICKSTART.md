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

## Workflow E2E

### 1. Collecter la configuration d'une machine

```bash
npx roosync collect-config
```

Crée `sync-config.json` dans le dossier partagé.

### 2. Comparer les configurations

```bash
npx roosync compare-config --target myia-po-2026
```

Montre les différences entre machines.

### 3. Appliquer une configuration

```bash
npx roosync apply-config --source myia-ai-01
```

Applique la configuration source à la machine locale.

### 4. Vérifier le statut

```bash
npx roosync get-status
```

Affiche l'état de synchronisation de toutes les machines.

## Outils MCP (Claude Code)

```typescript
// Collecter la configuration
roosync_collect_config({ machineId: 'myia-ai-01' })

// Comparer deux machines
roosync_compare_config({ source: 'myia-ai-01', target: 'myia-po-2026' })

// Appliquer une configuration
roosync_apply_config({ source: 'myia-ai-01' })

// Voir le statut
roosync_get_status({})
```

## Dossier partagé

Par défaut : `G:/Mon Drive/Synchronisation/RooSync/.shared-state/`

Changez-le avec : `ROOSYNC_SHARED_PATH`

---

**Documentation complète :** [GUIDE-TECHNIQUE-v2.3.md](GUIDE-TECHNIQUE-v2.3.md)
