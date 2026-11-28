# @vibesync/core

Domain-neutral contracts and utilities shared by the VibeSync MCP servers
(step 2 of the #2190 split plan, issue #4886).

## Scope

Grain 1 extracted the modules that carry **no RSM-domain state**:

| Module | Source before |
|---|---|
| `types/errors` | `servers/roo-state-manager/src/types/errors.ts` |
| `utils/int-validator` | `servers/roo-state-manager/src/utils/int-validator.ts` |
| `utils/server-capabilities` | `servers/roo-state-manager/src/utils/server-capabilities.ts` |
| `utils/secret-redaction` (+ `utils/known-value-masker`) | `servers/roo-state-manager/src/utils/` |
| `config/tool-timeouts` | `servers/roo-state-manager/src/config/tool-timeouts.ts` |

Grain 2 added the shared logger, which only imports `fs`, `path` and `os`:

| Module | Source before |
|---|---|
| `utils/logger` | `servers/roo-state-manager/src/utils/logger.ts` |

Grain 3 added the PG cutover gates, which read only the process environment and
the backfill completeness marker:

| Module | Source before |
|---|---|
| `services/unified-store/pg-flags` | `servers/roo-state-manager/src/services/unified-store/pg-flags.ts` |
| `services/unified-store/pg-backfill-marker` | `servers/roo-state-manager/src/services/unified-store/pg-backfill-marker.ts` |
| `services/unified-store/pg-read-gates` | `servers/roo-state-manager/src/services/unified-store/pg-read-gates.ts` |

Grain 4 added the shared-state resolver — its resolution from the environment,
its fail-closed error and the one sanctioned store-subdirectory writer:

| Module | Source before |
|---|---|
| `utils/shared-state-path` | `servers/roo-state-manager/src/utils/shared-state-path.ts` |

The #1628 `.env` fallback did **not** move. It reads the server's own `.env`
from two levels above its own file, so moved byte for byte it would have looked
for a `packages/vibesync-core/.env` that does not exist, without any error. The
RSM keeps a thin adapter at the old path (`src/utils/shared-state-path.ts`):
it registers its reader through `registerDotenvFallback()` at import time and
re-exports this module, so no import site changed. With no reader registered the
module reads the environment only.

The remaining trunk modules (`message-helpers`, `server-config`,
`unified-store/*` stores, `openai`) stay in the RSM for later grains: their fan-in measured
1000+ import sites, which is not reviewable as one change.

## Consuming it

Package subpaths mirror the module layout; the RSM imports them by package name:

```ts
import { StateManagerError } from '@vibesync/core/types/errors';
import { getToolTimeoutMs } from '@vibesync/core/config/tool-timeouts';
import { createLogger } from '@vibesync/core/utils/logger';
```

The package compiles to `dist/` (`npm run build`, also run by `prepare` on install).
`exports` maps `./*` to `./dist/*.js`, so a new module needs no export-map edit.

## Build and test

```bash
npm run build --workspace @vibesync/core   # from the mcps/internal root
npm run test  --workspace @vibesync/core
```

The package's only runtime dependency is `pg`, imported lazily by
`pg-backfill-marker` for its one marker lookup; `vitest`, `typescript`, `@types/node`
and `@types/pg` are dev-only. The workspace lockfile keeps a second copy of `pg` and
its transitive dependencies under `servers/roo-state-manager/node_modules/` on
purpose: `ensure-build-fresh.ps1` only reconciles an install under live RSM hosts
when the lockfile removes nothing (#4918).