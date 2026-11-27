# @vibesync/core

Domain-neutral contracts and utilities shared by the VibeSync MCP servers
(step 2 of the #2190 split plan, issue #4886).

## Scope of this grain

Grain 1 extracts the modules that carry **no RSM-domain state**:

| Module | Source before |
|---|---|
| `types/errors` | `servers/roo-state-manager/src/types/errors.ts` |
| `utils/int-validator` | `servers/roo-state-manager/src/utils/int-validator.ts` |
| `utils/server-capabilities` | `servers/roo-state-manager/src/utils/server-capabilities.ts` |
| `utils/secret-redaction` (+ `utils/known-value-masker`) | `servers/roo-state-manager/src/utils/` |
| `config/tool-timeouts` | `servers/roo-state-manager/src/config/tool-timeouts.ts` |

The remaining trunk modules (`logger`, `shared-state-path`, `message-helpers`,
`server-config`, `unified-store/*`, `openai`) stay in the RSM for later grains:
their fan-in measured 1000+ import sites, which is not reviewable as one change.

## Consuming it

Package subpaths mirror the module layout; the RSM imports them by package name:

```ts
import { StateManagerError } from '@vibesync/core/types/errors';
import { getToolTimeoutMs } from '@vibesync/core/config/tool-timeouts';
```

The package compiles to `dist/` (`npm run build`, also run by `prepare` on install).
`exports` maps `./*` to `./dist/*.js`, so a new module needs no export-map edit.

## Build and test

```bash
npm run build --workspace @vibesync/core   # from the mcps/internal root
npm run test  --workspace @vibesync/core
```

The package has **zero runtime dependencies**; `vitest`, `typescript` and `@types/node`
are dev-only.