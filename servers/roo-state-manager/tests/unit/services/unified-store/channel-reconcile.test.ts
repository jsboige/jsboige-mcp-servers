/**
 * channel-reconcile — #3151 Phase B arming prerequisite.
 *
 * Hardened per the user directive 29/09/2026 ("blindez les tests unitaires"):
 * every property the reconcile pass claims is asserted here — membership
 * rule, grace window boundary, manifest completeness (denominator =
 * ghosts + live + withinGrace), dry-run purity, batch chunking — plus the
 * reader guard that keeps destroyed rows out of PG-primary mailboxes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  idFromInboxFilename,
  buildLiveIdSet,
  computeReconcileResult,
  batchIds,
} from '../../../../src/services/unified-store/channel-reconcile.js';
import type { ReconcileCandidate } from '../../../../src/services/unified-store/channel-reconcile.js';

// ─── Reconcile pure logic ───────────────────────────────────────────

describe('idFromInboxFilename', () => {
  it('extracts the id from an exact `<id>.json` filename', () => {
    expect(idFromInboxFilename('adj-secretary-throughput-reply-20260929.json')).toBe('adj-secretary-throughput-reply-20260929');
  });

  it('handles generated ids (msg-<ts>-<rand>) — the id IS the filename stem', () => {
    expect(idFromInboxFilename('msg-20260305T030334-a59b55.json')).toBe('msg-20260305T030334-a59b55');
  });

  it('returns null for non-json entries (tmp files, directories)', () => {
    expect(idFromInboxFilename('msg-x.json.tmp')).toBeNull();
    expect(idFromInboxFilename('readme.txt')).toBeNull();
  });
});

describe('buildLiveIdSet', () => {
  it('ignores non-json files entirely', () => {
    const set = buildLiveIdSet(['a.json', 'b.json', 'c.txt', '.DS_Store']);
    expect(set.size).toBe(2);
    expect(set.has('a')).toBe(true);
    expect(set.has('c')).toBe(false);
  });
});

describe('computeReconcileResult', () => {
  const CUTOFF = Date.parse('2026-09-27T00:00:00Z');
  const GRACE_HOURS = 48;

  const candidates: ReconcileCandidate[] = [
    // Live: file present in the pool — never touched, whatever its age.
    { id: 'live-old', status: 'unread', created_at: '2026-03-05T00:00:00Z' },
    { id: 'live-recent', status: 'read', created_at: '2026-09-28T12:00:00Z' },
    // Ghost: file absent AND older than the grace cutoff.
    { id: 'ghost-unread', status: 'unread', created_at: '2026-03-05T00:00:00Z' },
    { id: 'ghost-read', status: 'read', created_at: '2026-08-20T00:00:00Z' },
    // Absent but within the grace window — protected, never a ghost.
    { id: 'grace-protected', status: 'unread', created_at: '2026-09-28T23:00:00Z' },
    // Boundary: exactly AT the cutoff epoch is grace-protected (>= keeps it).
    { id: 'boundary-at-cutoff', status: 'unread', created_at: '2026-09-27T00:00:00Z' },
    // One second older than the cutoff is a ghost.
    { id: 'boundary-just-old', status: 'unread', created_at: '2026-09-26T23:59:59Z' },
  ];

  const liveIds = buildLiveIdSet(['live-old.json', 'live-recent.json']);
  const result = computeReconcileResult(candidates, liveIds, CUTOFF, 'dry-run', GRACE_HOURS);

  it('marks as ghosts exactly the absent rows older than the grace cutoff', () => {
    expect(result.ghosts.map(g => g.id).sort()).toEqual(['boundary-just-old', 'ghost-read', 'ghost-unread']);
  });

  it('never touches rows whose file is live in the pool', () => {
    expect(result.kept.live).toBe(2);
  });

  it('protects absent rows within the grace window and at the exact boundary', () => {
    expect(result.kept.withinGrace).toBe(2); // grace-protected + boundary-at-cutoff
  });

  it('manifest denominator is exact: ghosts + live + withinGrace = candidates', () => {
    expect(result.manifest.candidates).toBe(candidates.length);
    expect(result.manifest.ghosts + result.kept.live + result.kept.withinGrace).toBe(candidates.length);
  });

  it('manifest records status_before and pool size for reversibility', () => {
    expect(result.manifest.pool_files).toBe(2);
    expect(result.manifest.run_kind).toBe('dry-run');
    expect(result.manifest.grace_hours).toBe(GRACE_HOURS);
    const ghost = result.ghosts.find(g => g.id === 'ghost-read');
    expect(ghost?.status_before).toBe('read');
    expect(ghost?.created_at).toBe('2026-08-20T00:00:00Z');
  });

  it('accepts Date objects as created_at and normalizes them to ISO in the manifest', () => {
    const r = computeReconcileResult(
      [{ id: 'g', status: 'unread', created_at: new Date('2026-01-01T00:00:00Z') }],
      buildLiveIdSet(['some-live.json']),
      CUTOFF,
      'apply',
      GRACE_HOURS
    );
    expect(r.ghosts[0].created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(r.manifest.run_kind).toBe('apply');
  });
});

// ─── Sanity guards: a disconnected pool must abort, never archive ────

describe('computeReconcileResult — sanity guards (#1256 review point 1)', () => {
  const CUTOFF = Date.parse('2026-09-27T00:00:00Z');
  const GRACE_HOURS = 48;
  const OLD = '2026-03-05T00:00:00Z';

  const ghostBatch = (n: number, prefix = 'ghost'): ReconcileCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, status: 'unread', created_at: OLD }));
  const liveBatch = (n: number): ReconcileCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `live-${i}`, status: 'read', created_at: OLD }));

  it('aborts (pool-empty) when the pool has NO live file but PG has candidates — nothing archived', () => {
    const r = computeReconcileResult(
      [...ghostBatch(3), ...liveBatch(2)],
      new Set<string>(),
      CUTOFF,
      'apply',
      GRACE_HOURS
    );
    expect(r.manifest.aborted?.reason).toBe('pool-empty');
    expect(r.ghosts).toEqual([]);
    expect(r.manifest.affected).toEqual([]);
    expect(r.manifest.candidates).toBe(5); // the refusal is documented, not hidden
  });

  it('does NOT abort on an empty pool with zero candidates (first-run virgin store)', () => {
    const r = computeReconcileResult([], new Set<string>(), CUTOFF, 'dry-run', GRACE_HOURS);
    expect(r.manifest.aborted).toBeUndefined();
    expect(r.ghosts).toEqual([]);
  });

  it('aborts (ghost-ratio) when > 90% of a large candidate set is ghosts — partial DriveFS mount', () => {
    // 200 candidates: 195 ghosts (97.5%) + 5 live
    const r = computeReconcileResult(
      [...ghostBatch(195), ...liveBatch(5)],
      buildLiveIdSet(liveBatch(5).map(c => `${c.id}.json`)),
      CUTOFF,
      'dry-run',
      GRACE_HOURS
    );
    expect(r.manifest.aborted?.reason).toBe('ghost-ratio');
    expect(r.ghosts).toEqual([]);
    expect(r.manifest.affected).toEqual([]);
  });

  it('does NOT abort on the legitimate 29/09 first-pass ratio (61% ghosts)', () => {
    // 200 candidates: 122 ghosts (61%) + 78 live — the measured fleet reconcile
    const r = computeReconcileResult(
      [...ghostBatch(122), ...liveBatch(78)],
      buildLiveIdSet(liveBatch(78).map(c => `${c.id}.json`)),
      CUTOFF,
      'dry-run',
      GRACE_HOURS
    );
    expect(r.manifest.aborted).toBeUndefined();
    expect(r.ghosts).toHaveLength(122);
  });

  it('ratio boundary: exactly 90% does not abort (strict >)', () => {
    // 100 candidates: 90 ghosts + 10 live = exactly 0.9
    const r = computeReconcileResult(
      [...ghostBatch(90), ...liveBatch(10)],
      buildLiveIdSet(liveBatch(10).map(c => `${c.id}.json`)),
      CUTOFF,
      'dry-run',
      GRACE_HOURS
    );
    expect(r.manifest.aborted).toBeUndefined();
    expect(r.ghosts).toHaveLength(90);
  });

  it('ratio guard stays silent below the minimum population (99 candidates, 98% ghosts)', () => {
    // Small pools (fresh machines, trial --limit runs) are not ratio-judged
    const r = computeReconcileResult(
      [...ghostBatch(97), ...liveBatch(2)],
      buildLiveIdSet(liveBatch(2).map(c => `${c.id}.json`)),
      CUTOFF,
      'dry-run',
      GRACE_HOURS
    );
    expect(r.manifest.aborted).toBeUndefined();
    expect(r.ghosts).toHaveLength(97);
  });

  it('pool-empty guard holds in apply mode too — the UPDATE loop would receive nothing', () => {
    const r = computeReconcileResult(ghostBatch(10), new Set<string>(), CUTOFF, 'apply', GRACE_HOURS);
    expect(r.manifest.run_kind).toBe('apply');
    expect(r.manifest.aborted?.reason).toBe('pool-empty');
    expect(r.ghosts).toEqual([]);
  });
});

describe('batchIds', () => {
  it('returns no batch for an empty list', () => {
    expect(batchIds([])).toEqual([]);
  });

  it('keeps a short list in one batch', () => {
    expect(batchIds(['a', 'b'], 500)).toEqual([['a', 'b']]);
  });

  it('splits exactly at the batch size and carries the remainder', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    const batches = batchIds(ids, 500);
    expect(batches.map(b => b.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(ids);
  });
});

// ─── Reader guard: destroyed rows stay out of PG-primary mailboxes ──

const mockQuery = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      end: vi.fn(),
      query: mockQuery,
    })),
  },
}));

describe('PgUnifiedStoreReader.getRooSyncMailbox — destroyed guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters destroyed_at IS NULL in the mailbox query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { PgUnifiedStoreReader } = await import('../../../../src/services/unified-store/PgUnifiedStoreReader.js');
    const reader = new PgUnifiedStoreReader({
      connectionString: 'postgres://test:test@localhost:5433/unified_store',
    });
    await reader.getRooSyncMailbox('myia-po-2026');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status <> 'archived'");
    expect(sql).toContain('destroyed_at IS NULL');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(mockQuery.mock.calls[0][1]).toEqual(['myia-po-2026']);
  });
});
