/**
 * #4850 — main-pass lock: one complete reconcile pass per MACHINE.
 *
 * Measured ai-01, 21/11: 32 RSM processes (all started in the same reboot
 * hour) each ran the full pass — one `dashboards` readdir then a read+parse
 * per keyed file — 90 s after start and every 6 h, on the same clock, with no
 * lock. These tests pin the contract the issue asks for:
 *
 *   1. two passes launched at the same time → ONE reads the files, the other
 *      reports `mainPassSkipped: 'lock-held'` and reads NOTHING;
 *   2. the lock row is keyed per machine (two hosts never contend), with the
 *      same acquire/TTL/release-holder contract as MIRROR_REPAIR_LOCK_KEY;
 *   3. `ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK=0` restores the old
 *      unlocked behaviour, and a THROWING lock backend degrades to it (this
 *      pass only reads — a broken lock must not stop the heal).
 *
 * The fs/promises seam counts every dashboard `.md` read, so "only one pass
 * read the files" is measured on the actual reads, not inferred from counts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  reconcileDashboardsFromGDrive,
  mainPassLockKey,
  isMainPassLockEnabled,
  MAIN_PASS_LOCK_TTL_MS,
} from '../roosync-dashboard-reconcile.js';

vi.unmock('fs');

const { readState } = vi.hoisted(() => ({
  readState: {
    mdReads: [] as string[],
    blockNextMdRead: false,
    readStarted: null as null | (() => void),
    releaseRead: null as null | (() => void),
  },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      const p = String(path);
      if (p.endsWith('.md')) {
        readState.mdReads.push(p);
        if (readState.blockNextMdRead) {
          readState.blockNextMdRead = false;
          readState.readStarted?.();
          // Hold the pass MID-READ, after its lock is acquired: the second
          // pass below cannot race past the acquisition by finishing first.
          await new Promise<void>((resolve) => {
            readState.releaseRead = resolve;
          });
        }
      }
      return (actual.readFile as unknown as (p: unknown, ...r: unknown[]) => Promise<unknown>)(
        path,
        ...rest
      );
    },
  };
});

/** A dashboard file with exactly `ids` fingerprinted messages. */
function fixture(key: string, ids: string[]): string {
  const blocks = ids.map(
    (id, i) => `### [2026-09-17T10:0${i}:00Z] m1|w1\n[msg: ${id}]\ncontent ${i}\n\n---`
  );
  return [
    '---',
    'type: workspace',
    `key: ${key}`,
    "lastModified: '2026-09-17T10:00:00Z'",
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
    ...blocks.map((b) => b + '\n'),
  ].join('\n');
}

describe('dashboard reconcile — main-pass lock (#4850)', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  /** Simulated PG lock rows — real semantics: second acquirer reads 'held'. */
  let locks: Map<string, string>;
  let acquireCalls: Array<{ key: string; holder: string; ttl: number }>;
  let releaseCalls: Array<{ key: string; holder: string }>;
  let lockBehaviour: 'real' | 'throw';
  let readerCalls: string[];

  const readerDouble = {
    async getRooSyncDashboard(key: string) {
      readerCalls.push(key);
      return null;
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard() {
      /* the insert path is not what these tests measure */
    },
    async archiveRooSyncDashboardMessages() {
      return 0;
    },
    async tryAcquireRooSyncDashboardLock(key: string, holder: string, ttl: number) {
      acquireCalls.push({ key, holder, ttl });
      if (lockBehaviour === 'throw') throw new Error('lock backend unreachable');
      if (locks.has(key)) return 'held' as const;
      locks.set(key, holder);
      return 'acquired' as const;
    },
    async releaseRooSyncDashboardLock(key: string, holder: string) {
      releaseCalls.push({ key, holder });
      if (locks.get(key) === holder) locks.delete(key);
    },
  };

  const fetchArchivedIds = async () => null;

  const runPass = () =>
    reconcileDashboardsFromGDrive({
      dashboardsDir: dir,
      reader: readerDouble,
      writer: writerDouble,
      fetchArchivedIds,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dash-main-pass-lock-'));
    saved = {
      dual: process.env.UNIFIED_STORE_DUAL_WRITE,
      url: process.env.UNIFIED_STORE_PG_URL,
      primary: process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY,
      archive: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
      scan: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN,
      repair: process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR,
      lock: process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0'; // archival is not under test
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN;
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR = '0';
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK; // default ON
    writeFileSync(join(dir, 'workspace-a.md'), fixture('workspace-a', ['id-1']));
    locks = new Map();
    acquireCalls = [];
    releaseCalls = [];
    lockBehaviour = 'real';
    readerCalls = [];
    readState.mdReads = [];
    readState.blockNextMdRead = false;
    readState.readStarted = null;
    readState.releaseRead = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    restore('ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK', saved.lock);
  });

  test('deux passes simultanées → une seule lit les fichiers, l’autre rend lock-held', async () => {
    const firstReadStarted = new Promise<void>((resolve) => {
      readState.readStarted = resolve;
    });
    readState.blockNextMdRead = true;

    // Pass A: acquires the row, then blocks MID-READ of workspace-a.md.
    const passA = runPass();
    await firstReadStarted;
    expect(readState.mdReads).toHaveLength(1);
    expect(locks.size).toBe(1);

    // Pass B starts while A holds the lock: it must skip without reading.
    const resultB = await runPass();
    expect(resultB.mainPassSkipped).toBe('lock-held');
    expect(resultB.parsedKeys).toBe(0);
    expect(resultB.filesScanned).toBe(1); // the readdir DID happen (honest count)
    expect(readState.mdReads).toHaveLength(1); // no second read
    expect(readerCalls).toHaveLength(0); // never reached the PG read phase

    // Release A and let it finish: exactly one complete pass.
    readState.releaseRead?.();
    const resultA = await passA;
    expect(resultA.status).toBe('ok');
    expect(resultA.mainPassSkipped).toBeUndefined();
    expect(resultA.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
    expect(locks.size).toBe(0); // released

    // Same per-machine key, same TTL, release under the exact held payload.
    expect(acquireCalls).toHaveLength(2);
    expect(acquireCalls[0].key).toBe(mainPassLockKey());
    expect(acquireCalls[0].ttl).toBe(MAIN_PASS_LOCK_TTL_MS);
    expect(acquireCalls[1].key).toBe(mainPassLockKey());
    expect(JSON.parse(acquireCalls[0].holder).pid).toBe(process.pid);
    expect(releaseCalls).toEqual([{ key: mainPassLockKey(), holder: acquireCalls[0].holder }]);
  });

  test('le verrou de passe est par MACHINE : deux hôtes ne se disputent pas la même ligne', () => {
    expect(mainPassLockKey('myia-po-2024')).toBe('dashboard-reconcile-main-pass:myia-po-2024');
    expect(mainPassLockKey('myia-ai-01')).not.toBe(mainPassLockKey('myia-po-2024'));
    // Default ON unless explicitly switched off.
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK;
    expect(isMainPassLockEnabled()).toBe(true);
    process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK = '0';
    expect(isMainPassLockEnabled()).toBe(false);
  });

  test('interrupteur =0 → ancien comportement, le verrou n’est même pas consulté', async () => {
    process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK = '0';
    // A foreign holder on the same machine must NOT block the pass any more.
    locks.set(mainPassLockKey(), JSON.stringify({ machine: 'other', pid: 1 }));

    const result = await runPass();

    expect(result.mainPassSkipped).toBe('disabled');
    expect(result.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
    expect(acquireCalls).toHaveLength(0);
    expect(locks.size).toBe(1); // the foreign row is left untouched
  });

  test('verrou en panne (throw) → passe exécutée déverrouillée, jamais bloquée', async () => {
    lockBehaviour = 'throw';

    const result = await runPass();

    expect(result.mainPassSkipped).toBeUndefined();
    expect(result.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
    expect(acquireCalls).toHaveLength(1);
    expect(releaseCalls).toHaveLength(0); // nothing was acquired → nothing to release
  });

  test('source illisible → aucun verrou payé (le readdir précède l’acquisition)', async () => {
    rmSync(dir, { recursive: true, force: true }); // no dashboards dir

    const result = await runPass();

    expect(result.status).toBe('skipped-source-unreadable');
    expect(acquireCalls).toHaveLength(0);
  });
});