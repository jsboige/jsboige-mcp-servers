# Env Rotation — Rotation déclarative de secrets fleet-wide

**Issue:** #2410 (VibeSync Epic #2406 Phase 2)
**Status:** Implemented

## Overview

Le target `env:<service>` de `roosync_config` permet la rotation et le déploiement déclaratif de fichiers `.env` chiffrés via le canal GDrive RooSync (jamais git).

## Architecture

```
Publisher (ai-01)                    GDrive RooSync                     Consumer (executor)
.env local ──► AES-256-GCM ──► $SHARED/env/<service>/<v>.enc ──► decrypt ──► .env local
                                $SHARED/env/<service>/<v>.json (metadata)
                                $SHARED/env/audit.jsonl (audit log)
```

## Sécurité

### Chiffrement

- **Algorithme :** AES-256-GCM (authenticated encryption)
- **Dérivation clé :** scrypt (OWASP 2024 params: N=32768, r=8, p=2)
- **IV :** 12 bytes aléatoires (NIST SP 800-38D §5.2.1.1)
- **Salt :** 32 bytes aléatoires par chiffrement
- **Wire format :** `[salt(32)][iv(12)][tag(16)][ciphertext]`

### Clé maître

La clé maîtresse est stockée dans la variable d'environnement `ROOSYNC_ENV_KEY` :

```bash
# Provisioning one-shot (chaque machine)
# Windows (user env var) :
setx ROOSYNC_ENV_KEY "your-strong-passphrase-minimum-32-characters!!"

# Ou PowerShell :
[Environment]::SetEnvironmentVariable("ROOSYNC_ENV_KEY", "your-strong-passphrase...", "User")
```

**Contraintes :**
- Minimum 32 caractères
- Identique sur toutes les machines de la flotte
- **Jamais** dans git, jamais dans RooSync shared state
- Rotation = provisionner une nouvelle valeur sur chaque machine, puis republier les .env

### Allowlist

Seuls les services explicitement autorisés peuvent être publiés/appliqués :

```typescript
const ALLOWED_SERVICES = ['rsm', 'sk-agent', 'embedding', 'mcp-auth'];
```

Pour ajouter un service, modifier `ALLOWED_SERVICES` dans `EnvRotationService.ts`.

## Usage

### Publish (depuis ai-01)

```json
{
  "action": "publish",
  "targets": ["env:rsm"],
  "version": "1.0.0",
  "description": "Rotation MCP_AUTH tokens"
}
```

Chiffre le fichier `.env` local et le pousse vers `$SHARED/env/rsm/1.0.0.enc`.

### Apply (sur chaque exécutant)

```json
{
  "action": "apply",
  "targets": ["env:rsm"]
}
```

Télécharge la dernière version, déchiffre, et écrit le `.env` local avec backup automatique.

### Dry-run

```json
{
  "action": "publish",
  "targets": ["env:embedding"],
  "version": "2.0.0",
  "description": "Test rotation",
  "dryRun": true
}
```

Valide sans écrire.

### Multi-target

```json
{
  "action": "apply",
  "targets": ["env:rsm", "env:embedding"]
}
```

## Audit

Chaque publish/apply écrit une entrée dans `$SHARED/env/audit.jsonl` :

```json
{"action":"publish","service":"rsm","version":"1.0.0","machineId":"myia-ai-01","status":"success","timestamp":"2026-06-11T15:30:00.000Z"}
```

## Fichiers générés

| Chemin | Description |
|--------|-------------|
| `$SHARED/env/<service>/<version>.enc` | .env chiffré (binary) |
| `$SHARED/env/<service>/<version>.json` | Metadata (public) |
| `$SHARED/env/audit.jsonl` | Journal d'audit (append-only) |
| `<local>/.env.bak.<timestamp>` | Backup du .env précédent (apply) |

## Out of scope

- Provisioning initial clé maître (manuel)
- GitHub PATs rotation (gh CLI)
- Rotation automatique calendaire (Phase 3+)
- ACL Windows sur fichiers chiffrés (mode 0o600 ignoré sous Windows)

## Tests

33 tests adversariaux couvrant :
- Round-trip encrypt/decrypt
- Tampered ciphertext/tag/IV detection (GCM auth)
- Wrong key rejection
- Missing/short key rejection
- Wire format integrity
- Key rotation scenarios
- Allowlist enforcement
- Audit log verification
- Concurrent publish (last-write-wins)
- Full publish/apply integration with backup
