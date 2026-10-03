// #2427 — canonical two-count orphan-balance predicate (single source for readers).
//
// After the 02/10 arbitration (roo-extensions#2427 issuecomment-5933447265),
// the anti-join balance is NOT one number: rows carrying
// metadata.unrecoverable or metadata.legacy_aggregate are tombstones —
// counted separately, never silently subtracted, never "repaired". Fleet
// views, the coherence probe and the repair selection all import from here
// so the classes cannot drift apart between readers.
//
// Classes (disjoint; they sum to the anti-join total):
//   legacy_aggregate — pre-#2734 per-project rows, not sessions (106 on ai-01)
//   unrecoverable    — source lost, marked with proof (533 on ai-01)
//   actionable       — everything else: real repair candidates
// metadata.partial_trace ("qdrant") is informational only: it overlaps
// unrecoverable and never changes the class.
//
// Marker keys are frozen by the live 02/10 run (issuecomment-5954196677);
// changing one here without a store migration re-classes every tombstone.

/** Marker keys as applied live on the unified store (jsonb metadata). */
export const TOMBSTONE_KEYS = Object.freeze({
  unrecoverable: 'unrecoverable',
  legacyAggregate: 'legacy_aggregate',
  partialTrace: 'partial_trace',
});

/**
 * JS-side classifier (explicit task-id lists, per-row reporting).
 * Mirrors CLASS_SQL exactly — keep the precedence in sync.
 */
export function classifyOrphanMetadata(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  if (meta[TOMBSTONE_KEYS.legacyAggregate] === true) return TOMBSTONE_KEYS.legacyAggregate;
  if (meta[TOMBSTONE_KEYS.unrecoverable] === true) return TOMBSTONE_KEYS.unrecoverable;
  return 'actionable';
}

/** Informational partial trace (e.g. "qdrant") — never a class on its own. */
export function partialTraceOf(metadata) {
  const v = metadata && typeof metadata === 'object' ? metadata[TOMBSTONE_KEYS.partialTrace] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Anti-join core shared by every reader: a conversation that declares
// messages but has none in the store (#2957 predicate — count(*) never
// n_live_tup).
const ANTI_JOIN = `
    c.msg_count > 0
    and not exists (select 1 from messages m where m.task_id = c.task_id)`;

// Class expression — legacy_aggregate first: an aggregate row is never a
// session even if it were also marked lost.
const CLASS_SQL = `case
      when coalesce((c.metadata->>'legacy_aggregate')::boolean, false) then 'legacy_aggregate'
      when coalesce((c.metadata->>'unrecoverable')::boolean, false) then 'unrecoverable'
      else 'actionable'
    end`;

/**
 * Fleet view: per (machine_id, harness) balance in the three disjoint
 * classes. actionable + unrecoverable + legacy_aggregate = anti_join_total
 * by construction; partial_trace may overlap unrecoverable.
 * $1 = optional machine filter (null = all), $2 = optional harness filter.
 */
export const BALANCE_SQL = `
  select
    machine_id,
    harness,
    count(*) filter (where cls = 'actionable')::int as actionable,
    count(*) filter (where cls = 'unrecoverable')::int as unrecoverable,
    count(*) filter (where cls = 'legacy_aggregate')::int as legacy_aggregate,
    count(*) filter (where partial_trace is not null)::int as partial_trace,
    count(*)::int as anti_join_total
  from (
    select c.machine_id, c.harness,
      ${CLASS_SQL} as cls,
      c.metadata->>'${TOMBSTONE_KEYS.partialTrace}' as partial_trace
    from conversations c
    where ${ANTI_JOIN}
      and ($1::text is null or c.machine_id = $1)
      and ($2::text is null or c.harness = $2)
  ) s
  group by machine_id, harness
  order by machine_id, harness`;

/**
 * Repair selection: the anti-join MINUS the tombstoned classes — only
 * actionable rows. $1 = machine_id, $2 = harness. Tombstoned rows stay in
 * the balance (BALANCE_SQL) but are never selected for repair here; the
 * opt-in lives in the caller (--include-tombstoned re-adds the two keys'
 * negations, never this query's core).
 */
export const ACTIONABLE_SELECTION_SQL = `
  select c.task_id
  from conversations c
  where ${ANTI_JOIN}
    and c.machine_id = $1
    and c.harness = $2
    and not coalesce((c.metadata->>'${TOMBSTONE_KEYS.legacyAggregate}')::boolean, false)
    and not coalesce((c.metadata->>'${TOMBSTONE_KEYS.unrecoverable}')::boolean, false)
  order by c.last_ts desc`;

/**
 * Coherence probe (proposed 19/09, issuecomment-5816501528): ingestion
 * freshness per (machine_id, harness). max_ingested_at vs the local newest
 * source mtime is the staleness signal; the DB side is printed here, each
 * host compares against its own disk. $1 = optional machine filter.
 */
export const PROBE_SQL = `
  select machine_id, harness,
    count(*)::int as conversations,
    max(ingested_at) as max_ingested_at,
    max(last_ts) as max_last_ts
  from conversations
  where ($1::text is null or machine_id = $1)
  group by machine_id, harness
  order by machine_id, harness`;

/**
 * Probe verdict defaults. The acceptance target of #2427 is "latency bounded
 * to a few minutes" — backlogLagH is the committed generous ceiling (1 h),
 * not the target itself. dormantDays separates corpora with no recent local
 * activity (staleness expected, not a defect) from live ones.
 */
export const PROBE_THRESHOLDS = Object.freeze({
  backlogLagH: 1,
  dormantDays: 30,
});

/**
 * Verdict for one PROBE_SQL row. lag_h = max_last_ts - max_ingested_at:
 * how far the newest local activity runs ahead of the newest ingestion —
 * the un-ingested backlog window, NOT the age of the last ingest (a dormant
 * corpus shows a huge age with nothing to ingest).
 *
 * Precedence: DORMANT > BACKLOG > CAUGHT_UP > UNKNOWN.
 *   DORMANT   — max_last_ts older than dormantDays: no recent activity, so
 *               staleness of the last ingest is expected, not a backlog.
 *   BACKLOG   — lag_h > backlogLagH: no ingest EVENT in over an hour while
 *               the corpus shows activity newer than that event. Caveat,
 *               measured 03/10 on po-2024/claude: ingested_at marks ingest
 *               events (sparse for claude corpora — creation-driven), while
 *               last_ts can advance without re-ingest — a BACKLOG verdict
 *               names where to look, the owner confirms against local
 *               sources before calling it a writer failure.
 *   CAUGHT_UP — ingestion within the window (lag may be negative: the last
 *               ingest ran past the newest activity — healthy).
 *   UNKNOWN   — a timestamp is missing: never guess, report it.
 */
export function classifyProbeRow(row, thresholds = PROBE_THRESHOLDS) {
  const ing = row?.max_ingested_at != null ? new Date(row.max_ingested_at) : null;
  const last = row?.max_last_ts != null ? new Date(row.max_last_ts) : null;
  if (!ing || Number.isNaN(ing.getTime()) || !last || Number.isNaN(last.getTime())) {
    return { lag_h: null, verdict: 'UNKNOWN' };
  }
  const lagH = (last.getTime() - ing.getTime()) / 3_600_000;
  const lag = Math.round(lagH * 10) / 10;
  const dormantMs = thresholds.dormantDays * 24 * 3_600_000;
  // Reference clock for dormancy: the row's own activity, not now() — the
  // classifier must stay stable between the SQL run and the render.
  const asOf = row.as_of != null ? new Date(row.as_of).getTime() : Date.now();
  if (Number.isNaN(asOf) || asOf - last.getTime() > dormantMs) return { lag_h: lag, verdict: 'DORMANT' };
  if (lag > thresholds.backlogLagH) return { lag_h: lag, verdict: 'BACKLOG' };
  return { lag_h: lag, verdict: 'CAUGHT_UP' };
}
