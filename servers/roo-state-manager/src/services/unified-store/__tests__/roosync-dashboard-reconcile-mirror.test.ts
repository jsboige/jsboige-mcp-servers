/**
 * #4131 demande 2 — mirror repair (PG → file).
 *
 * @module services/unified-store/__tests__/roosync-dashboard-reconcile-mirror
 *
 * The passes in the parent module all read the FILE and heal PG (pre-cutover
 * direction). On a PG-primary seat the file is only a bounded export whose
 * GDrive half may expire — measured twice on ai-01 28/10 — and nothing ever
 * repaired it. These tests pin the two properties that make the repair safe:
 * it only ever fires when the file is BEHIND PG, and it never throws.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reconcileDashboardsFromGDrive } from '../roosync-dashboard-reconcile.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';
import type { Dashboard } from '../../../tools/roosync/dashboard-schemas.js';

/** A dashboard file whose intercom holds exactly `ids`, at `stamp` seconds. */
function fixture(key: string, ids: string[], stamp = '2026-09-17T10:00:00Z'): string {
  const blocks = ids.map((id, i) => {
    const ts = `2026-09-17T10:0${i}:00Z`;
    return `### [${ts}] m1|w1\n[msg: ${id}]\ncontent ${i}\n\n---\n`;
  });
  return [
    '---',
    'type: workspace',
    `key: ${key}`,
    `lastModified: '${stamp}'`,
    'lastModifiedBy:',
    '  machineId: m1',
    '  workspace: w1',
    `totalMessages: ${ids.length}`,
    '---',
    '',
    '## Status',
    '',
    'status body',
    '',
    '## Intercom',
    '',
    ...blocks,
  ].join('\n');
}

describe('dashboard reconcile — mirror repair (#4131 demande 2)', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  let pgRows: Map<string, { id: string; createdAt: string }[]>;
  let writeMirrorCalls: { key: string; ids: string[] }[];
  let archiveCalls: { key: string; ids: string[] }[];
  let lockStatus: 'acquired' | 'held' | 'unavailable';
  let mirrorThrows: Set<string>;

  const rowOf = (key: string, count: number): RooSyncDashboardRow => ({
    key,
    type: 'workspace',
    machine_id: null,
    workspace: key.replace(/^workspace-/, ''),
    content: 'status body',
    status_json: {
      lastModified: '2026-09-17T10:00:00Z',
      lastModifiedBy: { machineId: 'm1', workspace: 'w1' },
      totalMessages: count,
    },
  });

  const readerDouble = {
    async getRooSyncDashboard(key: string) {
      const rows = pgRows.get(key);
      if (!rows) return null;
      return {
        dashboard: rowOf(key, rows.length),
        messages: rows.map(
          (r) =>
            ({
              dashboard_key: key,
              message_id: r.id,
              author_machine: 'm1',
              author_workspace: 'w1',
              content: `pg content ${r.id}`,
              created_at: r.createdAt,
              tags: [],
              team_stage: null,
              reply_to: null,
              acknowledged_at: null,
              archived_at: null,
            }) as RooSyncDashboardMessageRow
        ),
      };
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard() {
      /* inserts are not what these tests measure */
    },
    async archiveRooSyncDashboardMessages(key: string, ids: string[]) {
      archiveCalls.push({ key, ids: [...ids] });
      return ids.length;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async tryAcquireRooSyncDashboardLock(_key: string, _holder: string, _ttl: number) {
      return lockStatus;
    },
    async releaseRooSyncDashboardLock() {
      /* no-op */
    },
  };

  const writeMirror = async (key: string, dashboard: Dashboard) => {
    if (mirrorThrows.has(key)) throw new Error('mirror write expired: ' + key);
    writeMirrorCalls.push({ key, ids: dashboard.intercom.messages.map((m) => m.id) });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dash-mirror-'));
    saved = {
      dual: process.env.UNIFIED_STORE_DUAL_WRITE,
      url: process.env.UNIFIED_STORE_PG_URL,
      primary: process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY,
      archive: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
      scan: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN,
      repair: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR,
      max: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0'; // archival is not under test
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX;
    pgRows = new Map();
    writeMirrorCalls = [];
    archiveCalls = [];
    lockStatus = 'unavailable';
    mirrorThrows = new Set();
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('UNIFIED_STORE_DUAL_WRITE', saved.dual);
    restore('UNIFIED_STORE_PG_URL', saved.url);
    restore('UNIFIED_STORE_DASHBOARD_PG_PRIMARY', saved.primary);
    restore('ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE', saved.archive);
    restore('ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN', saved.scan);
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR', saved.repair);
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX', saved.max);
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content, 'utf8');
  const run = () =>
    reconcileDashboardsFromGDrive({ dashboardsDir: dir, writer: writerDouble, reader: readerDouble, writeMirror });

  test('rewrites a file that is BEHIND PG, with the whole PG view', async () => {
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(1);
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].key).toBe('workspace-a');
    expect(writeMirrorCalls[0].ids).toEqual(['old', 'newer']);
  });

  test('rewrites an EMPTY mirror (0 ids on disk, rows in PG)', async () => {
    // Measured shape on ai-01 28/10 for `machine-myia-po-2025`: the backup held
    // nothing while PG held 22 messages. This is the worst lag, not a skip.
    write('workspace-empty.md', fixture('workspace-empty', []));
    pgRows.set('workspace-empty', [
      { id: 'a', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'b', createdAt: '2026-09-17T11:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(1);
    expect(writeMirrorCalls[0].ids).toEqual(['a', 'b']);
  });

  test('NEVER rewrites a file AHEAD of PG — that direction is the insert pass', async () => {
    write('workspace-a.md', fixture('workspace-a', ['disk-only']));
    pgRows.set('workspace-a', [{ id: 'older', createdAt: '2026-09-01T00:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    expect(result.mirrorAheadKeys).toEqual(['workspace-a.md']);
  });

  test('a fork file is never rewritten, even when behind', async () => {
    write('workspace-a (2).md', fixture('workspace-a (2)', []));
    pgRows.set('workspace-a (2)', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
  });

  test('is a no-op (and says so) when the seat is not PG-primary', async () => {
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    write('workspace-a.md', fixture('workspace-a', []));
    pgRows.set('workspace-a', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-pg-primary');
    expect(writeMirrorCalls).toHaveLength(0);
  });

  test('kill-switch ROOSYNC_DASHBOARD_MIRROR_REPAIR=0 disables it', async () => {
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR = '0';
    write('workspace-a.md', fixture('workspace-a', []));
    pgRows.set('workspace-a', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('disabled');
    expect(writeMirrorCalls).toHaveLength(0);
  });

  test('another process holding the fleet lock skips the pass without repairing', async () => {
    lockStatus = 'held';
    write('workspace-a.md', fixture('workspace-a', []));
    pgRows.set('workspace-a', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('lock-held');
    expect(writeMirrorCalls).toHaveLength(0);
  });

  test('honours the per-pass write budget and reports what it deferred', async () => {
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX = '1';
    for (const k of ['workspace-a', 'workspace-b', 'workspace-c']) {
      write(`${k}.md`, fixture(k, []));
      pgRows.set(k, [{ id: `${k}-1`, createdAt: '2026-09-17T10:00:00Z' }]);
    }

    const result = await run();

    expect(result.mirrorRepaired).toBe(1);
    expect(result.mirrorRepairDeferred).toBe(2);
    expect(writeMirrorCalls).toHaveLength(1);
  });

  test('a failed rewrite is counted, never thrown, and the pass still returns', async () => {
    write('workspace-a.md', fixture('workspace-a', []));
    pgRows.set('workspace-a', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);
    mirrorThrows.add('workspace-a');

    const result = await run();

    expect(result.mirrorRepairFailed).toBe(1);
    expect(result.mirrorRepaired).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.failures.some((f) => f.includes('mirror repair failed'))).toBe(true);
  });

  test('a repaired key never loses a row to the archival pass in the same pass', async () => {
    // The two directions are disjoint: repair only fires when the file lags, and
    // a lagging file is exactly what the archival pass refuses to act on. Pinned
    // because "repair the mirror" and "archive what the file no longer shows" are
    // one line apart and pulling in opposite directions.
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '1';
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(1);
    expect(archiveCalls).toHaveLength(0);
    expect(result.archivedRows).toBe(0);
  });

  test('a healthy key is neither rewritten nor reported', async () => {
    write('workspace-a.md', fixture('workspace-a', ['same']));
    pgRows.set('workspace-a', [{ id: 'same', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorChecked).toBe(1);
    expect(result.mirrorRepaired).toBe(0);
    expect(result.mirrorAheadKeys).toHaveLength(0);
    expect(writeMirrorCalls).toHaveLength(0);
  });
});
