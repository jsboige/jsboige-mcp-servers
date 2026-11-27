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
 *   - a machine name → only that seat writes. A seat answers to TWO names,
 *                      each compared case-insensitively with the writer: what
 *                      its operator declares (`ROOSYNC_MACHINE_ID`, else the
 *                      hostname — upper-case on Windows, hence the folding: a
 *                      strict compare would silence ai-01 itself) AND its
 *                      hostname. Two identities live in this module and are
 *                      NOT the same string: the election reads both names,
 *                      the lock keys keep the hostname spelling alone — see
 *                      each function;
 *   - `*`            → every seat writes again: the kill-switch that restores
 *                      the previous behaviour without a redeployment.
 *
 * WHAT THE TWO NAMES COST (review round 3, ai-01, 27/11 — measured on a probe).
 * Reading the declaration at all has a price, and it is NOT the symmetry's:
 * a seat whose `.env` DECLARES the writer is elected, wherever it runs —
 * `return [declared]` (the reviewer's own one-line mutant) elects it exactly
 * the same way. The declaration is not a secondary hint: it is the seat's
 * identity everywhere else in this store (`author.machineId`, `condensedBy`),
 * so the election reads the variable the stamps already trust. What the union
 * ADDS over that mutant is the opposite direction, the designated machine's
 * own host whose line disagrees (a line no other seat can read before a
 * merge). What bounds the cost is that a wrong declaration is a configuration
 * error, visible before it writes: the seat stamps its messages under the same
 * name, and every mirror write NAMES the divergence (`mirrorWriterDivergence()`,
 * logged by `dashboard.ts` and the listener CLI) instead of leaving it silent.
 * On every write, not once per host start: the journal rotates (10 MB a file,
 * 7 days of retention) and a host lives longer than its first line — a single
 * line at start would go silent again the day the file is rotated away.
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
 * Dependency-free on purpose (env + process identity only): `dashboard.ts` imports it
 * on the hot append path, and the listener CLI loads it lazily from the
 * served build.
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
 * Hostname spelling — what the lock rows have always been keyed on.
 *
 * Every process of ONE machine must keep computing the same
 * `dashboard-reconcile-main-pass:<machine>` and `…-cadence:<machine>` row:
 * a host that loaded no `.env`, an older-vintage host and a host reading
 * another `.env` than its neighbours still contend on one row and share one
 * completed-pass stamp (#4850). That is why this chain reads the hostname
 * ONLY — the operator variable must never move a key (see the election
 * identity below for the variable that does move a verdict).
 */
export function reconcileLockMachineId(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown';
}

/**
 * One of the two names of THIS seat for the ELECTION — the vocabulary the
 * dashboards already speak: `author.machineId` and `condensedBy` are read
 * from `ROOSYNC_MACHINE_ID`, and it is the first entry of the documented
 * chain of `resolveMachineIdentity()` in `utils/message-helpers.ts`.
 *
 * WHY the variable comes first. Read from the hostname alone, a container or
 * WSL host of the designated machine (no `COMPUTERNAME`, `HOSTNAME` = a
 * container id) is never the writer, and the default `myia-ai-01` designates
 * NOBODY — silently: the 24 h criterion of the issue ("no new ` (N)` copy")
 * cannot tell one writer from no writer (review of 27/11).
 *
 * NOT `resolveMachineIdentity()` itself, on purpose: its first layer is the
 * identity of the REQUEST (`x-roosync-as`), and the mirror writer is the
 * HOST that holds the file — never the client that asked for the write.
 *
 * NOT the lock spelling either: `reconcileLockMachineId()` above stays on
 * the hostname, so setting the variable changes a verdict and no key.
 */
export function mirrorWriterMachineId(): string {
  const configured = (process.env.ROOSYNC_MACHINE_ID ?? '').trim();
  if (configured !== '') return configured.toLowerCase();
  return reconcileLockMachineId();
}

/**
 * The names THIS seat answers to, for the ELECTION — at most two, folded:
 * its declaration (`mirrorWriterMachineId()`) and its hostname, when that is
 * another name.
 *
 * WHY two. One vocabulary alone elects nobody on a real host. Read from the
 * hostname alone, a container or WSL host of the designated machine is never
 * the writer. Read from the declaration alone, the designated machine's own
 * Windows host is never the writer when the `ROOSYNC_MACHINE_ID` line of its
 * `.env` carries another value — a line no other seat can read before a merge
 * (independent review of 27/11), so it must not decide alone.
 *
 * Both senses, said plainly: a wrong DECLARATION degrades to the hostname
 * (the designated machine's host still publishes), and a hostname that names
 * another machine — a container id, a renamed box — degrades to the
 * declaration (a container of the designated machine still publishes). The
 * same property elects a FOREIGN host whose `.env` declares the writer — the
 * cost documented in the module header; `mirrorWriterDivergence()` below
 * makes that case sayable on the write path.
 */
export function mirrorWriterSeatIdentities(): string[] {
  const declared = mirrorWriterMachineId().trim().toLowerCase();
  const hostname = reconcileLockMachineId().trim().toLowerCase();
  return hostname === declared ? [declared] : [declared, hostname];
}

/**
 * May THIS seat publish the mirror? `*` says yes everywhere; otherwise the
 * writer must equal one of the seat's two names (case folded on both sides).
 *
 * An explicit `machine` answers for THAT name alone — a pure compare, for
 * callers naming a seat other than the host: the host's own names are not
 * consulted.
 */
export function isDesignatedMirrorWriter(machine?: string): boolean {
  const writer = dashboardMirrorWriter();
  if (writer === MIRROR_WRITER_ALL) return true;
  const wanted = writer.toLowerCase();
  const names = machine === undefined ? mirrorWriterSeatIdentities() : [machine];
  return names.some((name) => name.trim().toLowerCase() === wanted);
}

/**
 * Why THIS seat's two names disagree, on a seat the writer designates —
 * `undefined` when the seat answers to one name, is not the writer, or when
 * `*` hands the mirror to everyone (no election of one seat to speak of).
 *
 * `electedBy` is the whole point: a container of the designated machine is
 * elected by its DECLARATION and that is nominal; a Windows host whose
 * declaration carries another value is elected by its HOSTNAME, and the
 * declaration is then a wrong line that also stamps this seat's messages.
 * A foreign host whose `.env` declares the writer is elected by its
 * declaration too — that is the cost documented in the module header, and
 * this record is what lets a journal say it instead of staying silent
 * (review round 3: the refusal paths already carried `seat`/`host`, the
 * writing path said nothing).
 */
export interface MirrorWriterDivergence {
  /** Which of the seat's two names `ROOSYNC_DASHBOARD_MIRROR_WRITER` matched. */
  electedBy: 'declared' | 'hostname';
  /** The declared identity (`ROOSYNC_MACHINE_ID`, folded; the hostname when nothing is declared). */
  seat: string;
  /** The hostname, folded — the second name and the spelling of the lock rows. */
  host: string;
  /** The designated writer, folded. */
  writer: string;
}

/**
 * A pure read, with no state: the write paths say it on EVERY mirror write
 * (module header — the journal rotates, so "once per host" would not stay
 * readable).
 */
export function mirrorWriterDivergence(): MirrorWriterDivergence | undefined {
  const writer = dashboardMirrorWriter();
  if (writer === MIRROR_WRITER_ALL) return undefined;
  const wanted = writer.trim().toLowerCase();
  const seat = mirrorWriterMachineId().trim().toLowerCase();
  const host = reconcileLockMachineId().trim().toLowerCase();
  if (seat === host) return undefined;
  if (wanted === seat) return { electedBy: 'declared', seat, host, writer: wanted };
  if (wanted === host) return { electedBy: 'hostname', seat, host, writer: wanted };
  return undefined;
}
