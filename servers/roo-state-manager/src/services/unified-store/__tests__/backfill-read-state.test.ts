/**
 * Pure tests for the G-R read-state backfill logic (#4131, review ms#1410
 * point 2) — fusion, idempotence and the pre-image -> restore round-trip.
 * No DB, no env: they exercise scripts/lib/backfill-read-state-logic.mjs,
 * which mirrors the APPLY SQL of backfill-roosync-read-state.mjs exactly.
 * If the UPDATE in that script changes semantics, these tests must follow.
 */

import { describe, test, expect } from 'vitest';
import {
  rowDecision,
  applyToPgRow,
  preimageRow,
  restoreToPgRow,
} from '../../../../scripts/lib/backfill-read-state-logic.mjs';

const file = (over: Record<string, unknown> = {}) => ({
  status: 'unread',
  read_by: [],
  read_by_workspace: [],
  ...over,
});
const pg = (over: Record<string, unknown> = {}) => ({
  status: 'unread',
  read_by: [],
  read_by_workspace: [],
  ...over,
});

describe('G-R backfill logic — fusion (rowDecision + applyToPgRow)', () => {
  test('file entries PG lacks are detected as additions', () => {
    const d = rowDecision(file({ read_by: ['a', 'b'] }), pg({ read_by: ['a'] }));
    expect(d.divergent).toBe(true);
    expect(d.delta.read_by_added).toEqual(['b']);
  });

  test('union KEEPS entries present only in PG (never dropped, reported)', () => {
    const d = rowDecision(file({ read_by: ['a'] }), pg({ read_by: ['a', 'pg-only'] }));
    expect(d.delta.read_by_pg_only_kept).toEqual(['pg-only']);
    const applied = applyToPgRow(pg({ read_by: ['a', 'pg-only'] }), file({ read_by: ['a'] }));
    expect(applied.read_by).toEqual(['a', 'pg-only']);
  });

  test('PG-only entries alone do NOT make a row divergent (apply writes nothing to fix)', () => {
    const d = rowDecision(file({ read_by: ['a'] }), pg({ read_by: ['a', 'pg-only'] }));
    expect(d.divergent).toBe(false);
  });

  test('never read -> unread: a PG row already read stays read even when the file says unread', () => {
    const d = rowDecision(file({ status: 'unread' }), pg({ status: 'read' }));
    expect(d.divergent).toBe(false); // promotion-only: nothing to apply
    expect(d.pgAheadOfFile).toBe(true); // stale-file anomaly, reported not fixed
    const applied = applyToPgRow(pg({ status: 'read' }), file({ status: 'unread' }));
    expect(applied.status).toBe('read');
  });

  test('unread -> read promotion is a divergence apply fixes', () => {
    const d = rowDecision(file({ status: 'read' }), pg({ status: 'unread' }));
    expect(d.divergent).toBe(true);
    expect(d.delta.status_promotion).toBe(true);
    expect(applyToPgRow(pg({ status: 'unread' }), file({ status: 'read' })).status).toBe('read');
  });

  test('read_by_workspace merges by union too', () => {
    const d = rowDecision(
      file({ read_by_workspace: ['m:w1'] }),
      pg({ read_by_workspace: ['m:w0'] })
    );
    expect(d.divergent).toBe(true);
    expect(applyToPgRow(pg({ read_by_workspace: ['m:w0'] }), file({ read_by_workspace: ['m:w1'] })).read_by_workspace)
      .toEqual(['m:w0', 'm:w1']);
  });

  test('a dual-write racing apply is unioned, not overwritten (the ms#1410 race)', () => {
    // The script measured PG at T0, the row moved at T1 (mark_read mirror),
    // the UPDATE unions against the CURRENT row at T2.
    const pgAtT0 = pg({ read_by: ['lane-a'] });
    const fileAtT0 = file({ read_by: ['lane-a', 'lane-b'] });
    const pgAtT1 = { ...pgAtT0, read_by: ['lane-a', 'lane-c'] }; // concurrent mark_read
    const pgAtT2 = applyToPgRow(pgAtT1, fileAtT0); // SQL: read_by || file, vs CURRENT row
    expect(pgAtT2.read_by).toEqual(['lane-a', 'lane-c', 'lane-b']); // lane-c survives
  });
});

describe('G-R backfill logic — terminal states (archived, ms#1410 2nd review)', () => {
  test('PG archived at T0 stays archived — a T0 file read does NOT resurrect it', () => {
    const d = rowDecision(file({ status: 'read' }), pg({ status: 'archived' }));
    expect(d.divergent).toBe(false); // nothing for apply to write
    expect(d.delta.status_promotion).toBeNull(); // contract: promote || null
    expect(applyToPgRow(pg({ status: 'archived' }), file({ status: 'read' })).status).toBe('archived');
  });

  test('concurrent archiving at T1 survives the T2 UPDATE (the concrete scenario)', () => {
    // T0: file scanned as read, PG still unread -> apply would have promoted.
    // T1: another writer archives the row (the file moves out of the inbox).
    // T2: the UPDATE re-evaluates the CURRENT status and keeps archived.
    const fileAtT0 = file({ status: 'read' });
    const pgAtT1 = pg({ status: 'archived' });
    expect(applyToPgRow(pgAtT1, fileAtT0).status).toBe('archived');
    // the pre-image captured 'archived' verbatim, so --restore can restore it
    expect(preimageRow('m', pgAtT1).status).toBe('archived');
    expect(restoreToPgRow(preimageRow('m', pgAtT1)).status).toBe('archived');
  });

  test('array union stays MONOTONE on a terminal row (archived does not freeze read_by)', () => {
    const applied = applyToPgRow(
      pg({ status: 'archived', read_by: ['pg-only'] }),
      file({ status: 'read', read_by: ['a'] })
    );
    expect(applied.status).toBe('archived'); // status untouched
    expect(applied.read_by).toEqual(['pg-only', 'a']); // arrays still union
  });

  test('a file-side archived status is not a promotion source (out of scope, no write)', () => {
    const d = rowDecision(file({ status: 'archived' }), pg({ status: 'unread' }));
    expect(d.divergent).toBe(false);
    expect(applyToPgRow(pg({ status: 'unread' }), file({ status: 'archived' })).status).toBe('unread');
  });
});

describe('G-R backfill logic — idempotence (2nd pass = 0 divergente)', () => {
  test('re-deciding after a simulated apply converges every row', () => {
    const cases = [
      [file({ status: 'read', read_by: ['a', 'b'] }), pg({ status: 'unread', read_by: ['a'] })],
      [file({ status: 'unread', read_by: ['a'] }), pg({ status: 'read', read_by: ['a', 'x'] })],
      [file({ status: 'read', read_by_workspace: ['m:w1'] }), pg({ read_by_workspace: ['m:w0', 'm:w1'] })],
      [file({ status: 'unread' }), pg({ status: 'unread' })],
      [file({ read_by: [] }), pg({ read_by: ['pg-only'] })],
      [file({ status: 'read' }), pg({ status: 'archived' })], // terminal, untouched
    ];
    for (const [f, p] of cases) {
      const first = rowDecision(f, p);
      const after = applyToPgRow(p, f);
      const second = rowDecision(f, after);
      expect(second.divergent).toBe(false);
      expect(second.delta.read_by_added).toEqual([]);
      expect(second.delta.read_by_workspace_added).toEqual([]);
      // sanity: non-divergent rows were also non-divergent before
      if (!first.divergent) expect(first.pgAheadOfFile || first.delta.read_by_added.length === 0).toBe(true);
    }
  });
});

describe('G-R backfill logic — pre-image -> apply -> restore round-trip', () => {
  test('restore returns the row to its exact pre-apply values', () => {
    const pg0 = pg({ status: 'unread', read_by: ['pg-only'], read_by_workspace: ['m:w0'] });
    const f = file({ status: 'read', read_by: ['a'], read_by_workspace: ['m:w1'] });

    const pre = preimageRow('msg-1', pg0);
    expect(pre).toEqual({
      id: 'msg-1',
      status: 'unread',
      read_by: ['pg-only'],
      read_by_workspace: ['m:w0'],
    });

    const pg1 = applyToPgRow(pg0, f);
    expect(pg1.status).toBe('read');
    expect(pg1.read_by).toEqual(['pg-only', 'a']);

    const pg2 = restoreToPgRow(pre); // what --restore UPDATE writes
    expect(pg2).toEqual({ status: 'unread', read_by: ['pg-only'], read_by_workspace: ['m:w0'] });
  });

  test('pre-image rows are defensive copies (later mutation of the row cannot corrupt the save)', () => {
    const row = pg({ read_by: ['a'] });
    const pre = preimageRow('id', row);
    row.read_by.push('mutated-after');
    expect(pre.read_by).toEqual(['a']);
  });
});
