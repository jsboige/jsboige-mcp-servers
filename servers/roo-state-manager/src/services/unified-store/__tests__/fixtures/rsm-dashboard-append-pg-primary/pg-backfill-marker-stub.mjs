/**
 * #4915 (ai-01 follow-up, 28/11) test double for the SERVED BUILD's bundled
 * `@vibesync/core` copy of the backfill marker:
 *
 *   build/node_modules/@vibesync/core/dist/services/unified-store/pg-backfill-marker.js
 *
 * WHY this double exists — the gate `isDashboardPgPrimary()` is DATA-gated:
 * `resolvePrimaryGate` asks `getBackfillMarkerState('dashboard') === 'complete'`,
 * and that state is resolved ASYNCHRONOUSLY (`ensureBackfillMarkersFresh`). A
 * process that never warms the cache reads `'unknown'`, which the gate treats
 * as CLOSED. The MCP host warms it at startup, the send CLI warms it before it
 * decides — the append CLI did not, so it resolved the gate DIFFERENTLY from
 * the tool it must follow (measured on ai-01, 28/11: the marker IS complete,
 * the CLI read the gate false and kept writing the G: file first, unstamped —
 * the residual writer #4131's Phase D counts).
 *
 * THE INSTANCE — the cache is per MODULE INSTANCE, and that is the whole
 * subject of the test. The state therefore lives in a REGISTRY keyed by THIS
 * module's own file path, and the store stub reads the entry for the path the
 * CLI imports. A CLI that warmed a DIFFERENT copy would leave that entry
 * `'unknown'` and the gate CLOSED — the witness goes red, which is exactly the
 * failure this fix exists to prevent. (The real module is one file per
 * @vibesync/core install; the served build's copy is the one that matters.)
 *
 * THE STATES — mirroring the real module:
 *   - `'unknown'`  — never looked up (the default): the gate is CLOSED.
 *   - `'complete'` — the marker is in PG: the gate is OPEN.
 *   - `'absent'`   — no marker, or a lookup that proved nothing (the real
 *     module resolves a failed lookup to `'absent'` for an unproven scope):
 *     the gate is CLOSED.
 *
 * `RSM_APPEND_TEST_MARKER` drives the outcome: `complete` (default) | `absent`.
 * The double stays SILENT — the harness's existing witnesses assert their
 * journal EXACTLY; the marker announces itself only when
 * `RSM_APPEND_TEST_MARKER_JOURNAL=1`.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The registry: `path -> { state }`. The path is normalized (separators and
 * case) so the CLI's `pathToFileURL`-derived location and the store stub's
 * `path.resolve`-derived one name the SAME entry on Windows.
 */
const registry = (globalThis.__rsmAppendTestMarkerRegistry ??= {});
const key = (p) => p.replace(/\//g, '\\').toLowerCase();

const entry = { state: 'unknown' };
registry[key(fileURLToPath(import.meta.url))] = entry;

const journal = (line) => {
  if (
    process.env.RSM_APPEND_TEST_MARKER_JOURNAL === '1' &&
    process.env.RSM_APPEND_TEST_JOURNAL
  ) {
    // Appended synchronously: the order with the store stub's journal must
    // stay honest (the marker is announced BEFORE the gate is read).
    appendFileSync(process.env.RSM_APPEND_TEST_JOURNAL, `${line}\n`, 'utf8');
  }
};

/** The real module's synchronous read: the CACHED state, never a lookup. */
export function getBackfillMarkerState(scope) {
  return scope === 'dashboard' ? entry.state : 'unknown';
}

/**
 * The real module's await-able refresh. A lookup that proves nothing leaves
 * the scope unproven (`'absent'`) — it never throws for that, and it never
 * leaves a proven scope unproven.
 */
export async function ensureBackfillMarkersFresh(options = {}) {
  const outcome = process.env.RSM_APPEND_TEST_MARKER ?? 'complete';
  if (outcome === 'complete') {
    entry.state = 'complete';
    journal('marker:complete');
  } else {
    // No marker row, or a lookup that failed: the scope stays UNPROVEN.
    entry.state = 'absent';
    journal('marker:absent');
  }
}
