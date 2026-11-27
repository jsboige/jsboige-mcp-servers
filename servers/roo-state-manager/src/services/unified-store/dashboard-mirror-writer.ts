/**
 * #4596 — the DESIGNATED writer of the Drive dashboard mirror.
 *
 * @module services/unified-store/dashboard-mirror-writer
 *
 * WHY. The ` (N)` conflict copies of `dashboards/` were born on 07/11 23:50Z
 * out of whole-file rewrites of one Drive item by several seats at once. The
 * per-append mirror was switched off by default (#4131 G-DASH), but what
 * remains is still written by EVERY seat: the mirror repair and the
 * materialization of `roosync-dashboard-reconcile.ts` (a fleet lock
 * serialises them in time, it does not designate a publisher), the listener
 * CLI after a PG success, and the append of a seat whose operator turned the
 * per-append mirror back on. One Drive item with N publishers is N-1 too many.
 *
 * WHAT. `ROOSYNC_DASHBOARD_MIRROR_WRITER` names the only seat allowed to
 * publish the mirror:
 *   - unset / empty  → `myia-ai-01` (the default — option a of the RX169
 *                      arbitration, user agreement 26/11);
 *   - a machine name → only that seat writes; compared case-insensitively
 *                      with the same identity as the reconcile locks
 *                      (`COMPUTERNAME`, upper-case on Windows, hence the
 *                      folding — a strict compare would silence ai-01 itself);
 *   - `*`            → every seat writes again: the kill-switch that restores
 *                      the previous behaviour without a redeployment.
 *
 * Read at CALL time, never at module load: flipping the variable reaches a
 * live host without a restart (same convention as every bound of this store).
 *
 * SCOPE — what this module does NOT decide. Its verdict is consumed only
 * where the file is an EXPORT of PG. The two paths where the file is the only
 * surface stay unguarded on purpose: the fallback taken when PG failed (the
 * message exists nowhere else) and the file→PG import pass of the reconcile.
 * No function here reads, renames or removes an existing ` (N)` copy: those
 * are a user decision (RX169).
 *
 * Dependency-free on purpose (env + process identity only): `dashboard.ts`
 * imports it on the hot append path, and the listener CLI loads it lazily
 * from the served build.
 */

/** Name of the seat variable. Exported for log lines and restore hints. */
export const MIRROR_WRITER_ENV = 'ROOSYNC_DASHBOARD_MIRROR_WRITER';

/** The seat that publishes the mirror when the variable is unset. */
export const MIRROR_WRITER_DEFAULT = 'myia-ai-01';

/** The value that hands the mirror back to every seat. */
export const MIRROR_WRITER_ALL = '*';

/**
 * Why a mirror write was skipped, as carried by `gdriveSkippedReason` — the
 * machine-readable twin of each refusal, shared by every caller that reports
 * one (MCP tool results and the listener CLI) so the two can never drift.
 */
export const MIRROR_SKIP_REASON_NOT_DESIGNATED = 'not-designated-writer';
/** #4131 G-DASH — the default: the per-append mirror is off, the file is a periodic export. */
export const MIRROR_SKIP_REASON_APPEND_MIRROR_OFF = 'append-mirror-off';

/**
 * The configured publisher, read at call time. An unset, blank or
 * whitespace-only variable means the default — never "nobody writes": a
 * half-typed variable must not freeze the mirror fleet-wide.
 */
export function dashboardMirrorWriter(): string {
  const raw = (process.env[MIRROR_WRITER_ENV] ?? '').trim();
  return raw === '' ? MIRROR_WRITER_DEFAULT : raw;
}

/**
 * Machine identity of THIS seat — the spelling of the reconcile lock holders
 * (`dashboard-reconcile-main-pass:<machine>`). One implementation, so the
 * guard can never compare against a different identity than the locks.
 */
export function mirrorWriterMachineId(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown';
}

/**
 * May `machine` (this seat by default) publish the mirror?
 * `*` says yes everywhere; otherwise the comparison folds case on both sides.
 */
export function isDesignatedMirrorWriter(machine: string = mirrorWriterMachineId()): boolean {
  const writer = dashboardMirrorWriter();
  if (writer === MIRROR_WRITER_ALL) return true;
  return writer.toLowerCase() === machine.trim().toLowerCase();
}
