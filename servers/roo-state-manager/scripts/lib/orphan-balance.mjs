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
