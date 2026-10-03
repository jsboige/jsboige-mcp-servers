// #2427 — two-count orphan-balance predicate: single-source invariants.
//
// The classes were frozen by the live 02/10 run (issuecomment-5954196677);
// these tests fail on any drift between the SQL constants, the JS classifier
// and the marker keys the store actually carries.
import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_SELECTION_SQL,
  BALANCE_SQL,
  PROBE_SQL,
  PROBE_THRESHOLDS,
  TOMBSTONE_KEYS,
  classifyOrphanMetadata,
  classifyProbeRow,
  partialTraceOf,
} from '../../../scripts/lib/orphan-balance.mjs';

const ANTI_JOIN_CORE = 'not exists (select 1 from messages m where m.task_id = c.task_id)';

describe('classifyOrphanMetadata (JS side of the two-count predicate)', () => {
  it('null / undefined / empty metadata are actionable', () => {
    expect(classifyOrphanMetadata(null)).toBe('actionable');
    expect(classifyOrphanMetadata(undefined)).toBe('actionable');
    expect(classifyOrphanMetadata({})).toBe('actionable');
  });

  it('unrecoverable rows (live marker shape: boolean + proof) are not actionable', () => {
    expect(classifyOrphanMetadata({
      unrecoverable: true,
      proof: 'roo-extensions#2427 issuecomment-5883921696',
      arbitration: 'roo-extensions#2427 issuecomment-5933447265',
    })).toBe('unrecoverable');
  });

  it('legacy_aggregate rows are not actionable', () => {
    expect(classifyOrphanMetadata({ legacy_aggregate: true })).toBe('legacy_aggregate');
  });

  it('legacy_aggregate wins over unrecoverable (an aggregate is never a session)', () => {
    expect(classifyOrphanMetadata({ legacy_aggregate: true, unrecoverable: true })).toBe('legacy_aggregate');
  });

  it('partial_trace alone stays actionable — it is informational, not a class', () => {
    expect(classifyOrphanMetadata({ partial_trace: 'qdrant' })).toBe('actionable');
  });

  it('marker-key names match the live store markers (rename = store migration)', () => {
    expect(TOMBSTONE_KEYS).toEqual({
      unrecoverable: 'unrecoverable',
      legacyAggregate: 'legacy_aggregate',
      partialTrace: 'partial_trace',
    });
  });
});

describe('partialTraceOf', () => {
  it('reads the informational trace, null otherwise', () => {
    expect(partialTraceOf({ partial_trace: 'qdrant' })).toBe('qdrant');
    expect(partialTraceOf({ partial_trace: '' })).toBeNull();
    expect(partialTraceOf(null)).toBeNull();
  });
});

describe('BALANCE_SQL (fleet view)', () => {
  it('carries the anti-join core and the machine/harness grouping', () => {
    expect(BALANCE_SQL).toContain(ANTI_JOIN_CORE);
    expect(BALANCE_SQL).toContain('c.msg_count > 0');
    expect(BALANCE_SQL).toContain('group by machine_id, harness');
  });

  it('counts the three disjoint classes side by side — never one number', () => {
    expect(BALANCE_SQL).toContain("filter (where cls = 'actionable')");
    expect(BALANCE_SQL).toContain("filter (where cls = 'unrecoverable')");
    expect(BALANCE_SQL).toContain("filter (where cls = 'legacy_aggregate')");
    expect(BALANCE_SQL).toContain('as anti_join_total');
  });

  it('interpolates the live marker keys from TOMBSTONE_KEYS', () => {
    expect(BALANCE_SQL).toContain(`->>'${TOMBSTONE_KEYS.legacyAggregate}'`);
    expect(BALANCE_SQL).toContain(`->>'${TOMBSTONE_KEYS.unrecoverable}'`);
    expect(BALANCE_SQL).toContain(`->>'${TOMBSTONE_KEYS.partialTrace}'`);
  });

  it('classifies legacy_aggregate BEFORE unrecoverable (SQL mirrors the JS classifier)', () => {
    // The ->> operator only appears in the case expression (the count filters
    // use the bare cls alias), so these positions ARE the case's precedence.
    expect(BALANCE_SQL.indexOf(`->>'${TOMBSTONE_KEYS.legacyAggregate}'`))
      .toBeLessThan(BALANCE_SQL.indexOf(`->>'${TOMBSTONE_KEYS.unrecoverable}'`));
    // and the JS side agrees
    expect(classifyOrphanMetadata({ legacy_aggregate: true, unrecoverable: true })).toBe('legacy_aggregate');
  });
});

describe('ACTIONABLE_SELECTION_SQL (repair selection)', () => {
  it('shares the anti-join core with the fleet view', () => {
    expect(ACTIONABLE_SELECTION_SQL).toContain(ANTI_JOIN_CORE);
    expect(ACTIONABLE_SELECTION_SQL).toContain('c.msg_count > 0');
  });

  it('excludes BOTH tombstone classes — never a silent subtraction, never a repair over a tombstone', () => {
    expect(ACTIONABLE_SELECTION_SQL).toContain(`not coalesce((c.metadata->>'${TOMBSTONE_KEYS.legacyAggregate}')::boolean, false)`);
    expect(ACTIONABLE_SELECTION_SQL).toContain(`not coalesce((c.metadata->>'${TOMBSTONE_KEYS.unrecoverable}')::boolean, false)`);
  });

  it('stays machine- and harness-scoped ($1/$2)', () => {
    expect(ACTIONABLE_SELECTION_SQL).toContain('c.machine_id = $1');
    expect(ACTIONABLE_SELECTION_SQL).toContain('c.harness = $2');
  });
});

describe('PROBE_SQL (coherence probe)', () => {
  it('reports ingestion freshness per (machine, harness) — the 19/09 proposal', () => {
    expect(PROBE_SQL).toContain('max(ingested_at)');
    expect(PROBE_SQL).toContain('group by machine_id, harness');
    expect(PROBE_SQL).toContain('max(last_ts)');
  });
});

describe('classifyProbeRow (probe verdict — lag, not age)', () => {
  const H = 3_600_000;
  const asOf = Date.UTC(2026, 9, 3, 14, 31, 0); // 2026-10-03T14:31Z — pinned, not now()
  const row = (lagH, { lastTsAgeDays = 0, dropIngested = false, dropLast = false } = {}) => {
    const last = new Date(asOf - lastTsAgeDays * 24 * H).toISOString();
    const ingested = new Date(asOf - lastTsAgeDays * 24 * H - lagH * H).toISOString();
    return {
      machine_id: 'myia-x', harness: 'claude', conversations: 1,
      max_ingested_at: dropIngested ? null : ingested,
      max_last_ts: dropLast ? null : last,
      as_of: new Date(asOf).toISOString(),
    };
  };

  it('lag = max_last_ts - max_ingested_at, rounded to 0.1 h', () => {
    expect(classifyProbeRow(row(1.55)).lag_h).toBe(1.6);
    expect(classifyProbeRow(row(-0.44)).lag_h).toBe(-0.4);
  });

  it('BACKLOG when the lag exceeds the committed ceiling (default 1 h)', () => {
    expect(classifyProbeRow(row(1.0)).verdict).toBe('CAUGHT_UP'); // boundary is NOT a backlog
    expect(classifyProbeRow(row(1.1)).verdict).toBe('BACKLOG');
    expect(classifyProbeRow(row(16)).verdict).toBe('BACKLOG'); // measured 03/10: po-2023/claude
  });

  it('negative lag (ingest ran past the newest activity) is CAUGHT_UP', () => {
    expect(classifyProbeRow(row(-2)).verdict).toBe('CAUGHT_UP');
  });

  it('DORMANT wins over BACKLOG — a corpus with no recent activity cannot backlog', () => {
    // ai-01 zoo measured 03/10: last activity ~66 d old, huge staleness, nothing to ingest.
    expect(classifyProbeRow(row(400, { lastTsAgeDays: 66 })).verdict).toBe('DORMANT');
    // boundary: exactly dormantDays old is still LIVE (dormancy is strictly older)
    expect(classifyProbeRow(row(400, { lastTsAgeDays: PROBE_THRESHOLDS.dormantDays })).verdict).toBe('BACKLOG');
    expect(classifyProbeRow(row(400, { lastTsAgeDays: PROBE_THRESHOLDS.dormantDays + 0.5 })).verdict).toBe('DORMANT');
    expect(classifyProbeRow(row(400, { lastTsAgeDays: PROBE_THRESHOLDS.dormantDays - 1 })).verdict).toBe('BACKLOG');
  });

  it('age alone never verdicts: a stale ingest on a dormant corpus is CAUGHT_UP-or-DORMANT, not BACKLOG', () => {
    // po-2025 roo measured 03/10: age 221 h but lag +0.2 h — nothing to ingest.
    expect(classifyProbeRow(row(0.2, { lastTsAgeDays: 9 })).verdict).toBe('CAUGHT_UP');
  });

  it('UNKNOWN on any missing timestamp — never guess', () => {
    expect(classifyProbeRow(row(1, { dropIngested: true }))).toEqual({ lag_h: null, verdict: 'UNKNOWN' });
    expect(classifyProbeRow(row(1, { dropLast: true }))).toEqual({ lag_h: null, verdict: 'UNKNOWN' });
    expect(classifyProbeRow(null)).toEqual({ lag_h: null, verdict: 'UNKNOWN' });
  });

  it('thresholds are overridable and validated by the caller, not here', () => {
    expect(classifyProbeRow(row(1.5), { backlogLagH: 2, dormantDays: 30 }).verdict).toBe('CAUGHT_UP');
    expect(classifyProbeRow(row(400, { lastTsAgeDays: 40 }), { backlogLagH: 1, dormantDays: 60 }).verdict).toBe('BACKLOG');
  });

  it('PROBE_THRESHOLDS defaults are the committed ceiling (1 h lag / 30 d dormant)', () => {
    expect(PROBE_THRESHOLDS.backlogLagH).toBe(1);
    expect(PROBE_THRESHOLDS.dormantDays).toBe(30);
  });
});
