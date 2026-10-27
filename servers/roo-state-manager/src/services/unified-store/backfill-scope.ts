/**
 * Full-scope verdict + file classification for the backfill scripts.
 *
 * #4131 + review ms#1540 (RE2, CRITICAL): the completeness marker
 * (`roosync_store_meta`) opens the DEFAULT PG read fleet-wide, so it must
 * only ever be written by a run that covered the WHOLE scope. A partial run
 * (`--limit` smoke test, `--dirs inbox` subset, `--only attachments`,
 * `--key prefix`) leaves the store incomplete — a marker written on that
 * store opens PG reads on an un-imported store, the exact under-show the
 * marker exists to prevent. Nothing invalidates the marker later.
 *
 * Pure functions, no I/O: the scripts pass their parsed arguments, the
 * helpers answer "is this the whole scope?" and "why not?".
 */

/** The directories a full channel run must cover. */
export const CHANNEL_DEFAULT_DIRS: readonly string[] = ['inbox', 'sent', 'archive'];

/** The phases a full channel run must execute. */
export const CHANNEL_ALL_PHASES: readonly string[] = ['messages', 'attachments'];

/**
 * A channel message file is named after its message id (`msg-<ts>-<rand>`) —
 * the backfill's phantom guard enforces `file === `${message.id}.json``.
 * Everything else in the shared tree (`consumed-…`, `adjoint-…`, `correl-…`,
 * hand-dropped evidence files) is a FOREIGN artifact: not channel data.
 */
export const MESSAGE_FILE_PATTERN = /^msg-.*\.json$/i;

/** True when the file is NOT a channel message (a foreign artifact). */
export function isForeignMessageFileName(file: string): boolean {
  return !MESSAGE_FILE_PATTERN.test(file);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

export interface ScopeVerdict {
  /** True only when the run covered the whole scope. */
  fullScope: boolean;
  /** Empty when `fullScope`; otherwise the reasons why it did not. */
  reasons: string[];
}

function verdict(reasons: string[]): ScopeVerdict {
  return { fullScope: reasons.length === 0, reasons };
}

/**
 * Verdict for the channel backfill: no limit, every default dir, every phase.
 *
 * @param limit the parsed `--limit` (undefined when absent)
 * @param dirs the parsed `--dirs` (the default set when absent)
 * @param phases the parsed `--only` (both phases when absent)
 */
export function evaluateChannelScope(options: {
  limit?: number;
  dirs?: readonly string[];
  phases?: readonly string[];
} = {}): ScopeVerdict {
  const reasons: string[] = [];
  const { limit, dirs, phases } = options;

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    reasons.push(`--limit ${limit} stops the phase early (smoke test)`);
  }

  const effectiveDirs = dirs && dirs.length > 0 ? dirs : CHANNEL_DEFAULT_DIRS;
  if (!sameSet(effectiveDirs, CHANNEL_DEFAULT_DIRS)) {
    reasons.push(
      `--dirs ${effectiveDirs.join(',')} covers a subset of ${CHANNEL_DEFAULT_DIRS.join(',')}`,
    );
  }

  const effectivePhases = phases && phases.length > 0 ? phases : CHANNEL_ALL_PHASES;
  if (!sameSet(effectivePhases, CHANNEL_ALL_PHASES)) {
    reasons.push(
      `--only ${effectivePhases.join(',')} drops a phase of ${CHANNEL_ALL_PHASES.join(',')}`,
    );
  }

  return verdict(reasons);
}

/**
 * Verdict for the dashboards backfill: no limit, no key filter.
 *
 * @param limit the parsed `--limit` (undefined when absent)
 * @param keyFilter the parsed `--key` prefix (undefined when absent)
 */
export function evaluateDashboardScope(options: {
  limit?: number;
  keyFilter?: string;
} = {}): ScopeVerdict {
  const reasons: string[] = [];
  const { limit, keyFilter } = options;

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    reasons.push(`--limit ${limit} stops the sweep early (smoke test)`);
  }
  if (keyFilter) {
    reasons.push(`--key ${keyFilter} covers a subset of the dashboards`);
  }

  return verdict(reasons);
}

export interface MarkerDecision {
  /** True only when the completeness marker may be written. */
  write: boolean;
  /** Why the marker is withheld (empty when `write` is true). */
  reason: string;
}

/**
 * The one condition under which a backfill may write the completeness marker.
 *
 * LIVE + no error + full scope. Anything else withholds it, with the reason
 * the operator needs: a marker opens the default PG read fleet-wide, so it
 * must never be written on a partial or failing run.
 */
export function decideMarkerWrite(options: {
  liveMode: boolean;
  errors: number;
  scope: ScopeVerdict;
}): MarkerDecision {
  const { liveMode, errors, scope } = options;
  if (!liveMode) {
    return { write: false, reason: 'dry run — nothing was persisted, so nothing is proven' };
  }
  if (errors > 0) {
    return {
      write: false,
      reason: `${errors} error(s): an incomplete import cannot be marked complete`,
    };
  }
  if (!scope.fullScope) {
    return {
      write: false,
      reason: `this run did not cover the whole scope: ${scope.reasons.join('; ')}`,
    };
  }
  return { write: true, reason: '' };
}
