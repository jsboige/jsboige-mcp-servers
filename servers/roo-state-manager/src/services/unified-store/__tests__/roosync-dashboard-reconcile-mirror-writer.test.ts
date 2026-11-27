/**
 * #4596 — ONE designated writer for the Drive mirror (RX169 option a).
 *
 * @module services/unified-store/__tests__/roosync-dashboard-reconcile-mirror-writer
 *
 * WHY. The ` (N)` conflict copies of `dashboards/` were born on 07/11 23:50Z
 * out of whole-file rewrites of one Drive item by several seats at once. The
 * fleet lock of the mirror repair serialises the rewrites in TIME; it never
 * designated a publisher. `ROOSYNC_DASHBOARD_MIRROR_WRITER` does: unset means
 * `myia-ai-01`, a machine name means that seat only, `*` restores the previous
 * behaviour on every seat (the kill-switch).
 *
 * WHAT THESE TESTS PIN (closure criterion 1 of the issue):
 *   - the verdict itself — absent value (default), explicit seat, `*`, case
 *     folding, call-time read, the TWO names a seat answers to for the
 *     election (its declaration — `ROOSYNC_MACHINE_ID` first, then the
 *     hostname — and its hostname) and the lock rows, which stay on the
 *     hostname whatever that variable says;
 *   - the two guarded points of THIS module: mirror repair AND materialization
 *     are both held by the same branch, and a non-designated seat returns
 *     `mirrorRepairSkipped: 'not-designated-writer'` BEFORE asking for the
 *     fleet lock (the lock key never appears in the journal);
 *   - what stays UNGUARDED on purpose: the file→PG import pass (the file is a
 *     source there, not an export) and the existing precedence (`disabled`,
 *     `not-pg-primary` speak first);
 *   - a corrupt file is not rebuilt from PG on a non-designated seat — it keeps
 *     the legacy error path, and its bytes stay untouched.
 *
 * Harness duplicated from the sibling mirror suite (surgical-change rule: the
 * existing describes are not refactored to share it).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  reconcileDashboardsFromGDrive,
  mainPassCadenceKey,
  mainPassLockKey,
  MIRROR_REPAIR_LOCK_KEY,
} from '../roosync-dashboard-reconcile.js';
import {
  MIRROR_WRITER_ALL,
  MIRROR_WRITER_DEFAULT,
  MIRROR_WRITER_ENV,
  dashboardMirrorWriter,
  isDesignatedMirrorWriter,
  mirrorWriterMachineId,
  mirrorWriterSeatIdentities,
  reconcileLockMachineId,
} from '../dashboard-mirror-writer.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';
import type { Dashboard } from '../../../tools/roosync/dashboard-schemas.js';

const { retiredKeysSpy } = vi.hoisted(() => ({ retiredKeysSpy: vi.fn() }));

vi.mock('../roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listRetiredDashboardKeys: retiredKeysSpy };
});

// ─────────────────────────────────────────────────────────────────────────────
// The verdict — a pure env read, no store, no filesystem.
// ─────────────────────────────────────────────────────────────────────────────

describe('#4596 — mirror writer verdict (read at call time)', () => {
  const KEYS = [MIRROR_WRITER_ENV, 'ROOSYNC_MACHINE_ID', 'COMPUTERNAME', 'HOSTNAME'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('unset ⇒ default `myia-ai-01`: that seat writes, no other seat does', () => {
    delete process.env[MIRROR_WRITER_ENV];
    expect(dashboardMirrorWriter()).toBe(MIRROR_WRITER_DEFAULT);
    expect(isDesignatedMirrorWriter(MIRROR_WRITER_DEFAULT)).toBe(true);
    expect(isDesignatedMirrorWriter('myia-po-2024')).toBe(false);
    expect(isDesignatedMirrorWriter('myia-web1')).toBe(false);
  });

  test('blank and whitespace-only fall back to the default — never "nobody writes"', () => {
    // A half-typed variable must not freeze the mirror fleet-wide.
    process.env[MIRROR_WRITER_ENV] = '';
    expect(dashboardMirrorWriter()).toBe(MIRROR_WRITER_DEFAULT);
    process.env[MIRROR_WRITER_ENV] = '   ';
    expect(dashboardMirrorWriter()).toBe(MIRROR_WRITER_DEFAULT);
    expect(isDesignatedMirrorWriter(MIRROR_WRITER_DEFAULT)).toBe(true);
  });

  test('`*` is the kill-switch: every seat publishes again', () => {
    process.env[MIRROR_WRITER_ENV] = MIRROR_WRITER_ALL;
    expect(dashboardMirrorWriter()).toBe(MIRROR_WRITER_ALL);
    for (const seat of ['myia-ai-01', 'myia-po-2024', 'myia-web2', 'anything']) {
      expect(isDesignatedMirrorWriter(seat)).toBe(true);
    }
  });

  test('comparison folds case on both sides (Windows COMPUTERNAME is upper-case)', () => {
    // A strict compare would silence ai-01 itself: the default is lower-case,
    // the machine name it is compared with arrives upper-case.
    process.env[MIRROR_WRITER_ENV] = 'MYIA-AI-01';
    expect(isDesignatedMirrorWriter('myia-ai-01')).toBe(true);
    process.env[MIRROR_WRITER_ENV] = 'myia-po-2024';
    expect(isDesignatedMirrorWriter('MYIA-PO-2024')).toBe(true);
    // …and folding never makes two different seats equal.
    expect(isDesignatedMirrorWriter('MYIA-PO-2023')).toBe(false);
  });

  test('an explicit other seat is honoured: this one is not the writer', () => {
    process.env[MIRROR_WRITER_ENV] = 'myia-po-2023';
    expect(isDesignatedMirrorWriter('myia-po-2024')).toBe(false);
    expect(isDesignatedMirrorWriter('myia-po-2023')).toBe(true);
  });

  test('the variable is read at CALL time — a live host flips without a restart', () => {
    process.env[MIRROR_WRITER_ENV] = 'myia-po-2024';
    expect(isDesignatedMirrorWriter('myia-po-2024')).toBe(true);
    process.env[MIRROR_WRITER_ENV] = 'myia-ai-01';
    expect(isDesignatedMirrorWriter('myia-po-2024')).toBe(false);
    process.env[MIRROR_WRITER_ENV] = MIRROR_WRITER_ALL;
    expect(isDesignatedMirrorWriter('myia-po-2024')).toBe(true);
  });

  test('election identity: `ROOSYNC_MACHINE_ID` first (the stamps’ vocabulary), then COMPUTERNAME, then HOSTNAME', () => {
    delete process.env.ROOSYNC_MACHINE_ID;
    process.env.COMPUTERNAME = 'MYIA-PO-2024';
    process.env.HOSTNAME = 'ignored-host';
    expect(mirrorWriterMachineId()).toBe('MYIA-PO-2024');
    // The operator's declaration wins over the hostname, folded to lower case
    // like every machine id of this store.
    process.env.ROOSYNC_MACHINE_ID = 'MYIA-PO-2024';
    expect(mirrorWriterMachineId()).toBe('myia-po-2024');
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.COMPUTERNAME;
    expect(mirrorWriterMachineId()).toBe('ignored-host');
  });

  test('a host that only DECLARES its machine is a seat — no COMPUTERNAME required (review 27/11)', () => {
    // A container or WSL host of the designated machine: no COMPUTERNAME,
    // HOSTNAME = a container id. Read from the hostname alone, the default
    // `myia-ai-01` designated NOBODY — and the 24 h criterion ("no new ` (N)`
    // copy") stays green while no mirror is written at all.
    delete process.env.COMPUTERNAME;
    process.env.HOSTNAME = 'a29e7f8c9e1a';
    delete process.env[MIRROR_WRITER_ENV];
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
    expect(mirrorWriterMachineId()).toBe('myia-ai-01');
    expect(isDesignatedMirrorWriter()).toBe(true);
    // …the declaration is what elects: the same host declaring another
    // machine is not the writer.
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
    expect(isDesignatedMirrorWriter()).toBe(false);
  });

  test('a blank declaration is no declaration — the hostname still speaks', () => {
    process.env.ROOSYNC_MACHINE_ID = '   ';
    process.env.COMPUTERNAME = 'MYIA-AI-01';
    delete process.env[MIRROR_WRITER_ENV];
    expect(mirrorWriterMachineId()).toBe('MYIA-AI-01');
    expect(isDesignatedMirrorWriter()).toBe(true);
  });

  test('a host keeps answering to its NAME when its declaration says otherwise (independent review 27/11)', () => {
    // The default names a MACHINE. Its own Windows host must publish even
    // when the `ROOSYNC_MACHINE_ID` line of its `.env` carries another value:
    // no other seat can read that line before a merge, so it must not decide
    // alone — read from the declaration alone, the default elected nobody.
    delete process.env[MIRROR_WRITER_ENV];
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
    process.env.COMPUTERNAME = 'MYIA-AI-01';
    expect(mirrorWriterSeatIdentities()).toEqual(['myia-po-2024', 'myia-ai-01']);
    expect(isDesignatedMirrorWriter()).toBe(true);
    // One name only, when the declaration and the hostname agree.
    process.env.ROOSYNC_MACHINE_ID = 'MyIA-Ai-01';
    expect(mirrorWriterSeatIdentities()).toEqual(['myia-ai-01']);
    expect(isDesignatedMirrorWriter()).toBe(true);
  });

  test('two names never over-elect: a writer that is neither of them is refused', () => {
    process.env[MIRROR_WRITER_ENV] = 'myia-po-2025';
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
    process.env.COMPUTERNAME = 'MYIA-AI-01';
    expect(isDesignatedMirrorWriter()).toBe(false);
    // An explicit argument is a pure compare: it answers for THAT name, the
    // host's own names are not consulted.
    expect(isDesignatedMirrorWriter('myia-po-2025')).toBe(true);
    expect(isDesignatedMirrorWriter('myia-ai-01')).toBe(false);
  });

  test('election ≠ serialisation: the lock rows keep the hostname spelling, whatever the declaration says', () => {
    // `mainPassLockKey` and `mainPassCadenceKey` (#4850) are one row PER
    // MACHINE. If the declaration moved them, a host without `.env`, an
    // older-vintage host or a host reading another `.env` would stop
    // contending on its own machine's row.
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
    process.env.COMPUTERNAME = 'MYIA-PO-2024';
    process.env.HOSTNAME = 'ignored-host';
    expect(reconcileLockMachineId()).toBe('MYIA-PO-2024');
    expect(mainPassLockKey()).toBe('dashboard-reconcile-main-pass:MYIA-PO-2024');
    expect(mainPassCadenceKey()).toBe('dashboard-reconcile-main-pass-cadence:MYIA-PO-2024');
    // …the fallback of the keys is the lock's own chain, too.
    delete process.env.COMPUTERNAME;
    expect(reconcileLockMachineId()).toBe('ignored-host');
    expect(mainPassLockKey()).toBe('dashboard-reconcile-main-pass:ignored-host');
    // The election, on the same env, follows the declaration — not the keys.
    expect(mirrorWriterMachineId()).toBe('myia-po-2024');
  });

  test('the default argument IS this seat — dashboardMirrorWriter and the identity share one source', () => {
    delete process.env.ROOSYNC_MACHINE_ID;
    process.env.COMPUTERNAME = 'MYIA-PO-2024';
    process.env[MIRROR_WRITER_ENV] = MIRROR_WRITER_DEFAULT;
    expect(isDesignatedMirrorWriter()).toBe(false);
    process.env[MIRROR_WRITER_ENV] = 'MYIA-PO-2024';
    expect(isDesignatedMirrorWriter()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two guarded points of the reconcile: repair + materialization.
// ─────────────────────────────────────────────────────────────────────────────

describe('#4596 — mirror repair and materialization are held by the designation', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  let pgRows: Map<string, { id: string; createdAt: string }[]>;
  let writeMirrorCalls: { key: string; ids: string[] }[];
  let syncCalls: { key: string; ids: string[] }[];
  let askedLockKeys: string[];
  let lockStatus: 'acquired' | 'held' | 'unavailable';
  let pgKeysList: string[];
  let listCalls: number;

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
      listCalls++;
      return [...pgKeysList];
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard(_row: RooSyncDashboardRow, messages: RooSyncDashboardMessageRow[]) {
      syncCalls.push({ key: _row.key, ids: messages.map((m) => m.message_id) });
    },
    async archiveRooSyncDashboardMessages() {
      return 0;
    },
    async tryAcquireRooSyncDashboardLock(lockKey: string) {
      askedLockKeys.push(lockKey);
      // Only the mirror-repair row is contended here; the other pass locks
      // (main pass, cadence, archive scan) stay 'unavailable' like a fake
      // writer without a PG half — they are not what these tests measure.
      return lockKey === MIRROR_REPAIR_LOCK_KEY ? lockStatus : 'unavailable';
    },
    async releaseRooSyncDashboardLock() {
      /* no-op */
    },
  };

  const writeMirror = async (key: string, dashboard: Dashboard) => {
    writeMirrorCalls.push({ key, ids: dashboard.intercom.messages.map((m) => m.id) });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dash-mirror-writer-'));
    saved = {
      dual: process.env.UNIFIED_STORE_DUAL_WRITE,
      url: process.env.UNIFIED_STORE_PG_URL,
      primary: process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY,
      archive: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
      scan: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN,
      repair: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR,
      max: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX,
      writer: process.env[MIRROR_WRITER_ENV],
      machineId: process.env.ROOSYNC_MACHINE_ID,
      computer: process.env.COMPUTERNAME,
      host: process.env.HOSTNAME,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0'; // archival is not under test
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR;
    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR_MAX;
    delete process.env[MIRROR_WRITER_ENV];
    // The seat DECLARES itself, as every real host does through its `.env`:
    // the election reads the declaration first, the hostname only after. Left
    // to the ambient value, "this seat" would be whatever the setup file set.
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
    process.env.COMPUTERNAME = 'MYIA-PO-2024';
    pgRows = new Map();
    writeMirrorCalls = [];
    syncCalls = [];
    askedLockKeys = [];
    lockStatus = 'unavailable';
    pgKeysList = [];
    listCalls = 0;
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
    restore(MIRROR_WRITER_ENV, saved.writer);
    restore('ROOSYNC_MACHINE_ID', saved.machineId);
    restore('COMPUTERNAME', saved.computer);
    restore('HOSTNAME', saved.host);
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content, 'utf8');
  const run = () =>
    reconcileDashboardsFromGDrive({
      dashboardsDir: dir,
      writer: writerDouble,
      reader: readerDouble,
      writeMirror,
    });

  /** A dashboard file whose intercom holds exactly `ids`. */
  function fixture(key: string, ids: string[]): string {
    const blocks = ids.map((id, i) => {
      const ts = `2026-09-17T10:0${i}:00Z`;
      return `### [${ts}] m1|w1\n[msg: ${id}]\ncontent ${i}\n\n---\n`;
    });
    return [
      '---',
      'type: workspace',
      `key: ${key}`,
      `lastModified: '2026-09-17T10:00:00Z'`,
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

  test('unset writer (default ai-01) on another seat: no repair, and the fleet lock is NEVER asked', async () => {
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-designated-writer');
    expect(result.mirrorRepaired).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    // The witness that the designation is decided BEFORE the lock take: a
    // guarded seat never contends for a lock it would not use.
    expect(askedLockKeys).not.toContain(MIRROR_REPAIR_LOCK_KEY);
    // The file is untouched — it is the designated seat's export to rewrite.
    const onDisk = readFileSync(join(dir, 'workspace-a.md'), 'utf8');
    expect(onDisk).toContain('[msg: old]');
    expect(onDisk).not.toContain('[msg: newer]');
  });

  test('naming ai-01 explicitly changes nothing on another seat — same word, same silence', async () => {
    process.env[MIRROR_WRITER_ENV] = MIRROR_WRITER_DEFAULT;
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-designated-writer');
    expect(writeMirrorCalls).toHaveLength(0);
    expect(askedLockKeys).not.toContain(MIRROR_REPAIR_LOCK_KEY);
  });

  test('materialization is held too: the PG key listing is not even read', async () => {
    pgKeysList = ['workspace-newborn'];
    pgRows.set('workspace-newborn', [{ id: 'n1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-designated-writer');
    expect(result.mirrorMaterialized).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    // Both guarded points hang off the SAME branch: no arming ⇒ the pass body
    // never runs, so the reader is never asked for a key listing.
    expect(listCalls).toBe(0);
    expect(existsSync(join(dir, 'workspace-newborn.md'))).toBe(false);
  });

  test('the file→PG import stays UNGUARDED — the file is a source there, not an export', async () => {
    write('workspace-a.md', fixture('workspace-a', ['old', 'disk-only']));
    pgRows.set('workspace-a', [{ id: 'old', createdAt: '2026-09-17T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-designated-writer');
    expect(result.gapMessages).toBe(1);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].ids).toEqual(['disk-only']);
  });

  test('the designated seat (ai-01, default) repairs AND materializes, asking for the fleet lock', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
    process.env.COMPUTERNAME = 'MYIA-AI-01';
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);
    pgKeysList = ['workspace-newborn'];
    pgRows.set('workspace-newborn', [{ id: 'n1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBeUndefined();
    expect(result.mirrorRepaired).toBe(1);
    expect(result.mirrorMaterialized).toBe(1);
    expect(writeMirrorCalls.map((c) => c.key).sort()).toEqual(['workspace-a', 'workspace-newborn']);
    expect(writeMirrorCalls.find((c) => c.key === 'workspace-a')?.ids).toEqual(['old', 'newer']);
    expect(askedLockKeys).toContain(MIRROR_REPAIR_LOCK_KEY);
  });

  test('`*` restores the previous behaviour on a non-designated seat', async () => {
    process.env[MIRROR_WRITER_ENV] = MIRROR_WRITER_ALL;
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);
    pgKeysList = ['workspace-newborn'];
    pgRows.set('workspace-newborn', [{ id: 'n1', createdAt: '2026-11-01T10:00:00Z' }]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBeUndefined();
    expect(result.mirrorRepaired).toBe(1);
    expect(result.mirrorMaterialized).toBe(1);
    expect(askedLockKeys).toContain(MIRROR_REPAIR_LOCK_KEY);
  });

  test('designating THIS seat arms it, whatever the spelling', async () => {
    // Declaration and hostname spell the seat differently from the variable.
    process.env.ROOSYNC_MACHINE_ID = 'MYIA-PO-2024';
    process.env[MIRROR_WRITER_ENV] = 'myia-po-2024';
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [
      { id: 'old', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'newer', createdAt: '2026-09-20T00:00:00Z' },
    ]);

    const result = await run();

    expect(result.mirrorRepairSkipped).toBeUndefined();
    expect(result.mirrorRepaired).toBe(1);
    expect(writeMirrorCalls).toHaveLength(1);
  });

  test('existing precedence is preserved: the kill-switch and the PG gate speak first', async () => {
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR = '0';
    write('workspace-a.md', fixture('workspace-a', ['old']));
    pgRows.set('workspace-a', [{ id: 'old', createdAt: '2026-09-17T10:00:00Z' }]);
    let result = await run();
    expect(result.mirrorRepairSkipped).toBe('disabled');
    expect(askedLockKeys).not.toContain(MIRROR_REPAIR_LOCK_KEY);

    delete process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    result = await run();
    expect(result.mirrorRepairSkipped).toBe('not-pg-primary');
    expect(askedLockKeys).not.toContain(MIRROR_REPAIR_LOCK_KEY);
  });

  test('an unreadable file is NOT rebuilt from PG on a non-designated seat — bytes intact', async () => {
    write('machine-web1.md', '');
    pgRows.set('machine-web1', [{ id: 'm1', createdAt: '2026-11-05T10:00:00Z' }]);
    pgKeysList = ['machine-web1'];

    const result = await run();

    expect(result.mirrorRepairSkipped).toBe('not-designated-writer');
    expect(result.mirrorRebuiltFromCorrupt).toBe(0);
    expect(result.mirrorMaterialized).toBe(0);
    expect(writeMirrorCalls).toHaveLength(0);
    // The legacy path: the corrupt file is an error for this pass (so no
    // cadence stamp is taken here — disclosed in the PR), and it keeps its
    // bytes. The designated seat's rebuild is what heals it.
    expect(result.errors).toBe(1);
    expect(readFileSync(join(dir, 'machine-web1.md'), 'utf8')).toBe('');
  });
});
