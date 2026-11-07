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
 *
 * #4131 G-DASH (suite ms#1664): the second describe pins the MATERIALIZATION
 * pass — a key born after the cutover has NO file to repair, so without this
 * pass it would never get a G: export. The store module is mocked at the
 * boundary (importOriginal) to control `listRetiredDashboardKeys`: the real
 * one is fail-open internally and reads the production reader, neither of
 * which a unit double can reach.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reconcileDashboardsFromGDrive } from '../roosync-dashboard-reconcile.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';
import type { Dashboard } from '../../../tools/roosync/dashboard-schemas.js';

const { retiredKeysSpy, transientReadPaths } = vi.hoisted(() => ({
  retiredKeysSpy: vi.fn(),
  // Paths whose NEXT readFile must throw once (review ms#1682: transient
  // DriveFS miss). Pass-through for everything else, so the real-fs harness
  // of the rest of this file is unchanged.
  transientReadPaths: [] as string[],
}));

vi.mock('../roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listRetiredDashboardKeys: retiredKeysSpy };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      const idx = transientReadPaths.indexOf(String(path));
      if (idx >= 0) {
        transientReadPaths.splice(idx, 1);
        throw Object.assign(new Error(`EBUSY: transient read (test) on ${String(path)}`), { code: 'EBUSY' });
      }
      return (actual.readFile as unknown as (p: unknown, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

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
  let lockThrows: boolean;
  let mirrorThrows: Set<string>;
  let pgKeysList: string[];
  let pgKeyListThrows: boolean;

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
    // #4131 G-DASH — the materialization pass lists PG keys through the SAME
    // reader seam; without this method the pass would read a TypeError as
    // "list unreachable" and silently skip (the catch is honest but blind).
    async listRooSyncDashboardKeys() {
      if (pgKeyListThrows) throw new Error('pg key listing unreachable');
      return [...pgKeysList];
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
      if (lockThrows) throw new Error('lock backend unreachable');
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
    lockThrows = false;
    mirrorThrows = new Set();
    pgKeysList = [];
    pgKeyListThrows = false;
    retiredKeysSpy.mockReset().mockResolvedValue(new Set<string>());
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

  test('a lock acquire that THROWS holds the repair, never runs it unlocked (#4131 review minor 2)', async () => {
    // The repair is a WRITE: fail-open on the lock let two seats rewrite the
    // same file at once. The PASS survives a degraded lock backend; only the
    // repair is held for the next pass.
    lockThrows = true;
    write('workspace-a.md', fixture('workspace-a', []));
    pgRows.set('workspace-a', [{ id: 'x', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('lock-degraded');
    expect(result.mirrorRepaired).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    expect(result.status).toBe('ok');
  });

  test('HOLDS the repair when the file holds id-less messages PG does not have (#4131 review blocker)', async () => {
    // A watchdog block (`### [ts] machine|workspace` with NO [msg:] line)
    // never enters PG — the `persisted.has(m.id)` filter skips it by design —
    // so the PG view does not contain it. Rewriting the file from that view
    // would erase it from its only surface. The key is held, never rewritten.
    // The id-less block is stamped BETWEEN the file id and pgMax so the file
    // still reads as BEHIND (a newer id-less block would make it "ahead").
    const idlessBlock =
      '### [2026-09-17T10:05:00Z] watch|vllm\nwatchdog heartbeat, no [msg:] line\n\n---\n';
    write('workspace-a.md', fixture('workspace-a', ['old']) + idlessBlock);
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorIdlessHeldKeys).toBe(1);
    expect(result.mirrorRepaired).toBe(0);
    expect(result.mirrorRepairDeferred).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    // The id-less block survives on disk — the file was never rewritten.
    expect(readFileSync(join(dir, 'workspace-a.md'), 'utf8')).toContain('watchdog heartbeat');
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

describe('dashboard reconcile — materialization of PG-only keys (#4131 G-DASH, suite ms#1664)', () => {
  // Same harness as the repair describe above (shared doubles via the outer
  // IIFE-less module scope is NOT possible — each describe redeclares; we
  // mirror the minimal pieces instead of refactoring the sibling describe,
  // surgical-change rule).
  let dir: string;
  let saved: Record<string, string | undefined>;
  let pgRows: Map<string, { id: string; createdAt: string }[]>;
  let writeMirrorCalls: { key: string; ids: string[] }[];
  let lockStatus: 'acquired' | 'held' | 'unavailable';
  let mirrorThrows: Set<string>;
  let pgKeysList: string[];
  let pgKeyListThrows: boolean;

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
    async listRooSyncDashboardKeys() {
      if (pgKeyListThrows) throw new Error('pg key listing unreachable');
      return [...pgKeysList];
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard() {
      /* inserts are not what these tests measure */
    },
    async archiveRooSyncDashboardMessages() {
      return 0;
    },
    async tryAcquireRooSyncDashboardLock() {
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
    dir = mkdtempSync(join(tmpdir(), 'dash-materialize-'));
    saved = {
      dual: process.env.UNIFIED_STORE_DUAL_WRITE,
      url: process.env.UNIFIED_STORE_PG_URL,
      primary: process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY,
      archive: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
      repair: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR,
      max: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0';
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX;
    pgRows = new Map();
    writeMirrorCalls = [];
    lockStatus = 'unavailable';
    mirrorThrows = new Set();
    pgKeysList = [];
    pgKeyListThrows = false;
    retiredKeysSpy.mockReset().mockResolvedValue(new Set<string>());
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
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR', saved.repair);
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX', saved.max);
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content, 'utf8');
  const run = () =>
    reconcileDashboardsFromGDrive({ dashboardsDir: dir, writer: writerDouble, reader: readerDouble, writeMirror });

  test('materializes a PG-only key born after the cutover — the repair has no file to act on', async () => {
    // Key born post-cutover: PG holds it, G: never did (mirror off per append
    // since ms#1664). Without this pass it would NEVER get an export.
    pgKeysList = ['workspace-newborn'];
    pgRows.set('workspace-newborn', [
      { id: 'n1', createdAt: '2026-11-01T10:00:00Z' },
      { id: 'n2', createdAt: '2026-11-02T10:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorMaterialized).toBe(1);
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].key).toBe('workspace-newborn');
    expect(writeMirrorCalls[0].ids).toEqual(['n1', 'n2']);
    expect(result.mirrorMaterializeFailed).toBe(0);
    expect(result.mirrorMaterializeDeferred).toBe(0);
  });

  test('a key whose file exists is NEVER materialized, healthy or not', async () => {
    // The file loop owns existing files (repair); materialization must not
    // double-write a key that already has its export.
    pgKeysList = ['workspace-a'];
    write('workspace-a.md', fixture('workspace-a', ['same']));
    pgRows.set('workspace-a', [{ id: 'same', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorMaterialized).toBe(0);
    expect(result.mirrorRepaired).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
  });

  test('materialization shares the per-pass write budget with the repair', async () => {
    // A materialize IS a mirror write: with MAX=1, a repair that consumes the
    // budget leaves the newborn key deferred to the next pass.
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX = '1';
    write('workspace-behind.md', fixture('workspace-behind', ['old']));
    pgRows.set('workspace-behind', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);
    pgKeysList = ['workspace-behind', 'workspace-later'];
    pgRows.set('workspace-later', [{ id: 'late-1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepaired).toBe(1);
    expect(result.mirrorMaterialized).toBe(0);
    expect(result.mirrorMaterializeDeferred).toBe(1);
    expect(writeMirrorCalls).toHaveLength(1); // the repair only
    expect(writeMirrorCalls[0].key).toBe('workspace-behind');
  });

  test('never exhumes a retired key — retirement is a visibility mark', async () => {
    // A merged-away key still lives in PG rows; materializing it would
    // resurrect it as a raw G: file the retirement can no longer hide.
    retiredKeysSpy.mockResolvedValue(new Set(['workspace-gone']));
    pgKeysList = ['workspace-gone'];
    pgRows.set('workspace-gone', [{ id: 'g1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorMaterialized).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    expect(result.mirrorMaterializeDeferred).toBe(0);
  });

  test('an unreachable PG key list skips the pass and DECLARES it', async () => {
    pgKeyListThrows = true;
    pgRows.set('workspace-newborn', [{ id: 'n1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.status).toBe('ok');
    expect(result.mirrorMaterialized).toBe(0);
    expect(result.failures.some((f) => f.includes('pg-key-list'))).toBe(true);
  });

  test('a listed key with an unreadable journal is skipped, not failed', async () => {
    // Listed (index rows) but getRooSyncDashboard returns null — nothing to
    // export yet. Not a failure: the next pass retries (repair's tolerance).
    pgKeysList = ['workspace-ghost'];
    // pgRows has NO entry for it → reader returns null.

    const result = await run();

    expect(result.mirrorMaterialized).toBe(0);
    expect(result.mirrorMaterializeFailed).toBe(0);
    expect(result.mirrorMaterializeDeferred).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  test('a materialization write that throws is counted, never thrown', async () => {
    pgKeysList = ['workspace-newborn'];
    pgRows.set('workspace-newborn', [{ id: 'n1', createdAt: '2026-11-01T10:00:00Z' }]);
    mirrorThrows.add('workspace-newborn');

    const result = await run();

    expect(result.mirrorMaterializeFailed).toBe(1);
    expect(result.mirrorMaterialized).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.failures.some((f) => f.includes('mirror materialize failed'))).toBe(true);
  });

  test('invalid-shape keys from the PG listing are ignored (#G-B shape guard)', async () => {
    // The store inherits pre-pilot data faults (empty key, broken case); the
    // listing must not turn them into G: exports.
    pgKeysList = ['workspace-ok', 'garbage', ''];
    pgRows.set('workspace-ok', [{ id: 'ok-1', createdAt: '2026-11-01T10:00:00Z' }]);
    pgRows.set('garbage', [{ id: 'junk-1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorMaterialized).toBe(1);
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].key).toBe('workspace-ok');
  });

  test('a canonical key that exists ONLY as fork files on disk IS materialized', async () => {
    // `keyed` counts fork-derived names ('workspace-a (2)'), not the canonical
    // 'workspace-a': a key whose disk trace is only conflict copies still has
    // no canonical export — that export is this pass's job (the forks remain
    // the merge remedy's domain, never rewritten here).
    write('workspace-a (2).md', fixture('workspace-a (2)', []));
    pgKeysList = ['workspace-a'];
    pgRows.set('workspace-a', [{ id: 'a1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorMaterialized).toBe(1);
    expect(writeMirrorCalls[0].key).toBe('workspace-a');
    // The fork file itself is untouched by THIS pass.
    expect(readFileSync(join(dir, 'workspace-a (2).md'), 'utf8')).toContain('status body');
  });
});

describe('dashboard reconcile — unreadable files rebuilt from PG (#4131 G-DASH, corrupt-file blind spot)', () => {
  // Measured 06/11: `machine-myia-web1.md` sat at 0 bytes while its 8 live
  // siblings held 10-44 KB. Neither pass could heal it — the repair pass
  // counted an error and continued, and the materialization pass excluded the
  // key BY NAME from the directory listing — so the corrupt file permanently
  // blocked its own export. These tests pin the criterion: an existing but
  // unreadable file is treated as ABSENT (rebuilt from a readable journal,
  // left intact otherwise, never overwritten with empty), and it no longer
  // blocks its key's materialization. Same harness duplication rule as the
  // sibling describes above.
  let dir: string;
  let saved: Record<string, string | undefined>;
  let pgRows: Map<string, { id: string; createdAt: string }[]>;
  let writeMirrorCalls: { key: string; ids: string[] }[];
  let pgKeysList: string[];

  const rowOf = (key: string, count: number): RooSyncDashboardRow => ({
    key,
    type: 'machine',
    machine_id: key.replace(/^machine-/, ''),
    workspace: null,
    content: 'status body',
    status_json: {
      lastModified: '2026-11-06T08:34:00Z',
      lastModifiedBy: { machineId: 'web1', workspace: 'w1' },
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
              author_machine: 'web1',
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
    async listRooSyncDashboardKeys() {
      return [...pgKeysList];
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard() {
      /* inserts are not what these tests measure */
    },
    async archiveRooSyncDashboardMessages() {
      return 0;
    },
    async tryAcquireRooSyncDashboardLock() {
      return 'unavailable' as const;
    },
    async releaseRooSyncDashboardLock() {
      /* no-op */
    },
  };

  const writeMirror = async (key: string, dashboard: Dashboard) => {
    writeMirrorCalls.push({ key, ids: dashboard.intercom.messages.map((m) => m.id) });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dash-corrupt-'));
    saved = {
      dual: process.env.UNIFIED_STORE_DUAL_WRITE,
      url: process.env.UNIFIED_STORE_PG_URL,
      primary: process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY,
      archive: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
      repair: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR,
      max: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0';
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX;
    pgRows = new Map();
    writeMirrorCalls = [];
    pgKeysList = [];
    transientReadPaths.length = 0;
    retiredKeysSpy.mockReset().mockResolvedValue(new Set<string>());
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
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR', saved.repair);
    restore('ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX', saved.max);
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content, 'utf8');
  const run = () =>
    reconcileDashboardsFromGDrive({ dashboardsDir: dir, writer: writerDouble, reader: readerDouble, writeMirror });

  test('rebuilds a 0-byte file from a readable PG journal — repair, not error', async () => {
    // The measured shape: machine-myia-web1.md at 0 bytes with its journal
    // alive in PG. Must come back as a mirrorRebuiltFromCorrupt write carrying
    // the whole PG view — and NOT be re-written by the materialization pass
    // (the key stays "present" once rebuilt).
    write('machine-web1.md', '');
    pgRows.set('machine-web1', [
      { id: 'm1', createdAt: '2026-11-05T10:00:00Z' },
      { id: 'm2', createdAt: '2026-11-06T08:34:00Z' },
    ]);
    pgKeysList = ['machine-web1'];

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(1);
    expect(result.mirrorRepaired).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.mirrorMaterialized).toBe(0); // no double write
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].key).toBe('machine-web1');
    expect(writeMirrorCalls[0].ids).toEqual(['m1', 'm2']);
  });

  test('transient read failure, recovered on retry — NO rebuild (review ms#1682)', async () => {
    // A HEALTHY file whose first read throws (DriveFS transient miss) can be
    // AHEAD of PG; rebuilding it from PG would silently drop that content.
    // The retry parses ⇒ not corrupt: file untouched, no writeMirror, the
    // next reconcile pass processes it normally.
    write('workspace-a.md', fixture('workspace-a', ['a1', 'a2']));
    // PG journal exists (would-be rebuild source) — the test fails loudly if
    // the retry-once guard is missing: the rebuild would fire and drop a1/a2.
    pgRows.set('workspace-a', [{ id: 'm1', createdAt: '2026-11-05T10:00:00Z' }]);
    pgKeysList = ['workspace-a'];
    transientReadPaths.push(join(dir, 'workspace-a.md'));

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(0);
    expect(result.mirrorRepairFailed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.mirrorMaterialized).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0); // ahead-of-PG content preserved
    expect(readFileSync(join(dir, 'workspace-a.md'), 'utf8')).toContain('[msg: a1]');
  });

  test('PERSISTENT read failure (retry also throws) still takes the rebuild path', async () => {
    // Pins that retry-once does not weaken the corrupt-file handling: two
    // consecutive failures = genuinely unreadable ⇒ rebuild from PG.
    write('workspace-a.md', fixture('workspace-a', ['a1']));
    pgRows.set('workspace-a', [{ id: 'm1', createdAt: '2026-11-05T10:00:00Z' }]);
    pgKeysList = ['workspace-a'];
    transientReadPaths.push(join(dir, 'workspace-a.md'), join(dir, 'workspace-a.md'));

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(1);
    expect(result.errors).toBe(0);
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].ids).toEqual(['m1']);
  });

  test('rebuilds a corrupt-frontmatter file the same way (unreadable ≠ only-empty)', async () => {
    write('machine-web1.md', 'no frontmatter, no sections — truncated mid-write');
    pgRows.set('machine-web1', [{ id: 'm1', createdAt: '2026-11-05T10:00:00Z' }]);
    pgKeysList = ['machine-web1'];

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(1);
    expect(result.errors).toBe(0);
    expect(writeMirrorCalls).toHaveLength(1);
    expect(writeMirrorCalls[0].ids).toEqual(['m1']);
  });

  test('no readable PG journal ⇒ mirrorRepairFailed, file INTACT — never an overwrite with empty', async () => {
    write('machine-web1.md', '');
    // pgRows has NO entry → the reader returns null. Key still listed so the
    // materialization pass also sees it (and skips on `!existing` too).
    pgKeysList = ['machine-web1'];

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(0);
    expect(result.mirrorRepairFailed).toBe(1);
    expect(result.mirrorMaterialized).toBe(0);
    expect(result.mirrorMaterializeFailed).toBe(0);
    expect(result.errors).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    // The 0-byte file must still be 0 bytes — no ghost write.
    expect(readFileSync(join(dir, 'machine-web1.md'), 'utf8')).toBe('');
  });

  test('a corrupt key deferred by the write budget stays MATERIALIZABLE', async () => {
    // Pins the fileKeys exclusion: before, the key's NAME in the directory
    // listing excluded it from materialization forever. Two corrupt files with
    // MAX=1: one consumes the budget (rebuilt), the other defers — order of
    // the readdir does not matter, the counts 1/1 hold either way. The
    // DEFERRED key then reaching the materialization budget check (and being
    // deferred there too, not silently skipped) is what proves its own
    // corrupt file no longer excludes it.
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX = '1';
    write('machine-web1.md', '');
    write('machine-web2.md', '');
    pgRows.set('machine-web1', [{ id: 'm1', createdAt: '2026-11-05T10:00:00Z' }]);
    pgRows.set('machine-web2', [{ id: 'm2', createdAt: '2026-11-05T10:00:00Z' }]);
    pgKeysList = ['machine-web1', 'machine-web2'];

    const result = await run();

    expect(result.mirrorRebuiltFromCorrupt).toBe(1);
    expect(result.mirrorRepairDeferred).toBe(1);
    expect(result.mirrorMaterializeDeferred).toBe(1);
    expect(result.mirrorMaterialized).toBe(0);
    expect(result.mirrorMaterializeFailed).toBe(0);
    expect(result.errors).toBe(0);
    expect(writeMirrorCalls).toHaveLength(1);
  });
});
