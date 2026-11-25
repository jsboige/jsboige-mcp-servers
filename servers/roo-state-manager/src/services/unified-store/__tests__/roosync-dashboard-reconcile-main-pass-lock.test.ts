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
 *      pass only reads — a broken lock must not stop the heal);
 *   4. the cadence stamp (#4850 criterion 2): a pass that ran to its end
 *      refuses the machine's next tick inside the window with
 *      `mainPassSkipped: 'cadence'`, the stamp is taken at the END (an
 *      in-flight pass leaves none, so a killed process cannot wedge the
 *      machine for a whole window), and
 *      `ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE=0` restores the lock
 *      alone;
 *   5. the DAEMON arms that window from its own interval — the deployed
 *      cadence is what this suite pins, not a constant a direct caller
 *      happens to pass.
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
  mainPassCadenceKey,
  isMainPassCadenceEnabled,
  mainPassCadenceTtlMs,
  MAIN_PASS_CADENCE_STAMP_RATIO,
  startDashboardReconcileDaemon,
  stopDashboardReconcileDaemon,
  getDashboardReconcileStatus,
} from '../roosync-dashboard-reconcile.js';

vi.unmock('fs');

// The daemon resolves its reader/writer through the factories (no injection
// seam there by design): the two daemon tests at the end of the suite hook
// these, so "the daemon passes the window" is measured on a real daemon run.
const { daemonHooks } = vi.hoisted(() => ({
  daemonHooks: {
    writer: null as null | Record<string, unknown>,
    reader: null as null | Record<string, unknown>,
  },
}));

vi.mock('../writer-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../writer-factory.js')>();
  return {
    ...actual,
    getUnifiedStoreWriter: () =>
      (daemonHooks.writer as ReturnType<typeof actual.getUnifiedStoreWriter>) ??
      actual.getUnifiedStoreWriter(),
  };
});

vi.mock('../reader-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reader-factory.js')>();
  return {
    ...actual,
    getUnifiedStoreReader: () =>
      (daemonHooks.reader as ReturnType<typeof actual.getUnifiedStoreReader>) ??
      actual.getUnifiedStoreReader(),
  };
});

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
  /** acquired_at per row — the steal rule needs it (age > TTL → stealable). */
  let lockAcquiredAt: Map<string, number>;
  let acquireCalls: Array<{ key: string; holder: string; ttl: number }>;
  let releaseCalls: Array<{ key: string; holder: string }>;
  let lockBehaviour: 'real' | 'throw';
  /** Key whose acquire throws even when the backend is otherwise healthy. */
  let failAcquireKey: string | null;
  /** Throw on that key's Nth call (1 = the cadence check, 2 = the end stamp). */
  let failAcquireKeyAtCall: number | null;
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
      if (failAcquireKey !== null && key === failAcquireKey) {
        const seen = acquireCalls.filter((c) => c.key === failAcquireKey).length;
        if (failAcquireKeyAtCall === null || seen === failAcquireKeyAtCall) {
          throw new Error('lock backend down for ' + key);
        }
      }
      // Same rule as PgUnifiedStoreWriter's UPDATE: a row is stolen once it is
      // OLDER than its TTL (`acquired_at < NOW() - ttl`).
      const ageMs = Date.now() - (lockAcquiredAt.get(key) ?? 0);
      if (locks.has(key) && ageMs <= ttl) return 'held' as const;
      locks.set(key, holder);
      lockAcquiredAt.set(key, Date.now());
      return 'acquired' as const;
    },
    async releaseRooSyncDashboardLock(key: string, holder: string) {
      releaseCalls.push({ key, holder });
      if (locks.get(key) === holder) {
        locks.delete(key);
        lockAcquiredAt.delete(key);
      }
    },
  };

  /** Age a lock row backwards — TTL expiry is the store's job, not the pass's. */
  const ageLock = (key: string, byMs: number) => {
    const at = lockAcquiredAt.get(key);
    if (at !== undefined) lockAcquiredAt.set(key, at - byMs);
  };

  const fetchArchivedIds = async () => null;

  const runPass = () =>
    reconcileDashboardsFromGDrive({
      dashboardsDir: dir,
      reader: readerDouble,
      writer: writerDouble,
      fetchArchivedIds,
    });

  const WINDOW_MS = 6 * 3600_000;

  /** Same pass, with the daemon's per-machine window armed (#4850). */
  const runCadencedPass = (windowMs: number = WINDOW_MS) =>
    reconcileDashboardsFromGDrive({
      dashboardsDir: dir,
      reader: readerDouble,
      writer: writerDouble,
      fetchArchivedIds,
      mainPassCadenceMs: windowMs,
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
      cadence: process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test/test';
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE = '0'; // archival is not under test
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN;
    process.env.ROOSYNC_DASHBOARD_MIRROR_REPAIR = '0';
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_LOCK; // default ON
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE; // default ON
    writeFileSync(join(dir, 'workspace-a.md'), fixture('workspace-a', ['id-1']));
    locks = new Map();
    lockAcquiredAt = new Map();
    acquireCalls = [];
    releaseCalls = [];
    lockBehaviour = 'real';
    failAcquireKey = null;
    failAcquireKeyAtCall = null;
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
    restore('ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE', saved.cadence);
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

  // ─── Cadence stamp — one COMPLETE pass per machine per window ────────────

  test('passe complète → le tick décalé de la même machine rend cadence sans rien lire', async () => {
    const first = await runCadencedPass();
    expect(first.status).toBe('ok');
    expect(first.mainPassSkipped).toBeUndefined();
    expect(first.parsedKeys).toBe(1);
    // The window is marked and the LOCK row is gone: the stamp paces, the
    // lock only serialises.
    expect([...locks.keys()]).toEqual([mainPassCadenceKey()]);

    readState.mdReads = [];
    readerCalls.length = 0;

    const staggered = await runCadencedPass();

    expect(staggered.mainPassSkipped).toBe('cadence');
    expect(staggered.parsedKeys).toBe(0);
    expect(staggered.filesScanned).toBe(1); // the readdir DID happen (honest count)
    expect(readState.mdReads).toHaveLength(0); // the expensive half never ran
    expect(readerCalls).toHaveLength(0); // never reached the PG read phase
    expect([...locks.keys()]).toEqual([mainPassCadenceKey()]); // refused tick released its lock

    const cadenceTtl = mainPassCadenceTtlMs(WINDOW_MS);
    expect(MAIN_PASS_CADENCE_STAMP_RATIO).toBeLessThan(1);
    expect(cadenceTtl).toBe(Math.round(WINDOW_MS * MAIN_PASS_CADENCE_STAMP_RATIO));
    expect(acquireCalls.map((c) => [c.key, c.ttl])).toEqual([
      [mainPassLockKey(), MAIN_PASS_LOCK_TTL_MS], // pass 1: lock
      [mainPassCadenceKey(), cadenceTtl], // pass 1: check — acquired, dropped at once
      [mainPassCadenceKey(), cadenceTtl], // pass 1: stamp, taken at the END
      [mainPassLockKey(), MAIN_PASS_LOCK_TTL_MS], // pass 2: lock
      [mainPassCadenceKey(), cadenceTtl], // pass 2: check → held
    ]);
    expect(releaseCalls.map((c) => c.key)).toEqual([
      mainPassCadenceKey(), // pass 1: the check released the row it took
      mainPassLockKey(), // pass 1: end of pass
      mainPassLockKey(), // pass 2: refused → released on the way out
    ]);
  });

  test('fenêtre écoulée → la passe suivante relit ; à mi-fenêtre elle est refusée', async () => {
    await runCadencedPass();

    ageLock(mainPassCadenceKey(), WINDOW_MS / 2);
    const midWindow = await runCadencedPass();
    expect(midWindow.mainPassSkipped).toBe('cadence');

    // 90 % of the window is older than the stamp's TTL. The host's next TICK
    // comes a full window after its previous tick — less than a window after
    // the stamp, which the pass took at its END: that tick must run, or a
    // single-host machine would double its cadence.
    ageLock(mainPassCadenceKey(), WINDOW_MS);
    readState.mdReads = [];
    const nextWindow = await runCadencedPass();
    expect(nextWindow.mainPassSkipped).toBeUndefined();
    expect(nextWindow.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
    expect([...locks.keys()]).toEqual([mainPassCadenceKey()]); // re-stamped
  });

  test('interrupteur de cadence =0 → la ligne de cadence n’est même pas consultée', async () => {
    process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE = '0';

    const first = await runCadencedPass();
    expect(first.mainPassSkipped).toBeUndefined();
    expect(acquireCalls).toEqual([
      expect.objectContaining({ key: mainPassLockKey(), ttl: MAIN_PASS_LOCK_TTL_MS }),
    ]);

    readState.mdReads = [];
    const second = await runCadencedPass();
    expect(second.mainPassSkipped).toBeUndefined();
    expect(second.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
  });

  test('le tampon n’est posé qu’à la FIN : une passe en vol n’en laisse aucun', async () => {
    const readStarted = new Promise<void>((resolve) => {
      readState.readStarted = resolve;
    });
    readState.blockNextMdRead = true;

    const inFlight = runCadencedPass();
    await readStarted;

    // Mid-pass: the check row was released, no stamp exists yet — the lock is
    // the only thing covering the flight. A process killed here leaves no
    // stamp, so the machine's next tick runs (30 min lock TTL then reaps).
    expect(locks.has(mainPassCadenceKey())).toBe(false);
    expect(locks.has(mainPassLockKey())).toBe(true);

    readState.releaseRead?.();
    const done = await inFlight;
    expect(done.status).toBe('ok');
    expect(done.mainPassSkipped).toBeUndefined();
    expect(locks.has(mainPassCadenceKey())).toBe(true); // stamped at the end
    expect(locks.has(mainPassLockKey())).toBe(false); // and the lock is gone
  });

  test('cadence injoignable (throw au contrôle) → passe sur le verrou seul, jamais bloquée', async () => {
    failAcquireKey = mainPassCadenceKey();
    failAcquireKeyAtCall = 1; // the check

    const result = await runCadencedPass();

    expect(result.mainPassSkipped).toBeUndefined();
    expect(result.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
    expect(locks.size).toBe(0); // no stamp was attempted (check failure disarms it)
  });

  test('cadence injoignable au tampon final → rien de posé, le tick suivant repasse', async () => {
    failAcquireKey = mainPassCadenceKey();
    failAcquireKeyAtCall = 2; // the end-of-pass stamp

    const first = await runCadencedPass();
    expect(first.status).toBe('ok');
    expect(first.parsedKeys).toBe(1);
    expect(locks.size).toBe(0); // fail-open: a failed stamp never wedges the machine

    failAcquireKey = null;
    readState.mdReads = [];
    const second = await runCadencedPass();
    expect(second.mainPassSkipped).toBeUndefined();
    expect(second.parsedKeys).toBe(1);
    expect(readState.mdReads).toHaveLength(1);
  });

  test('la cadence est par MACHINE, et active par défaut', () => {
    expect(mainPassCadenceKey('myia-po-2024')).toBe(
      'dashboard-reconcile-main-pass-cadence:myia-po-2024'
    );
    expect(mainPassCadenceKey('myia-ai-01')).not.toBe(mainPassCadenceKey('myia-po-2024'));
    expect(mainPassCadenceKey()).not.toBe(mainPassLockKey()); // two rows, two timestamps
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE;
    expect(isMainPassCadenceEnabled()).toBe(true);
    process.env.ROOSYNC_DASHBOARD_RECONCILE_MAIN_PASS_CADENCE = '0';
    expect(isMainPassCadenceEnabled()).toBe(false);
  });

  // ─── Daemon wiring — the deployed window IS the daemon's interval ────────

  test('le daemon arme la fenêtre depuis son intervalle (3 h → tampon 2,7 h)', async () => {
    const realSetImmediate = setImmediate;
    vi.useFakeTimers();
    try {
      daemonHooks.writer = writerDouble;
      daemonHooks.reader = readerDouble;
      const lastRunBefore = getDashboardReconcileStatus().lastRun;

      startDashboardReconcileDaemon({ dashboardsDir: dir, intervalHours: 3 });
      await vi.advanceTimersByTimeAsync(90_000); // the initial delay only
      for (
        let i = 0;
        i < 500 && getDashboardReconcileStatus().lastRun === lastRunBefore;
        i++
      ) {
        // Real immediates let the fs callbacks (libuv, not fake timers) run.
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }

      // The stamp TTL names the window the daemon actually armed: 90 % of 3 h.
      expect(acquireCalls.filter((c) => c.key === mainPassCadenceKey()).map((c) => c.ttl)).toEqual([
        mainPassCadenceTtlMs(3 * 3600_000),
        mainPassCadenceTtlMs(3 * 3600_000),
      ]);
      expect(getDashboardReconcileStatus().lastRun?.result?.parsedKeys).toBe(1);
    } finally {
      stopDashboardReconcileDaemon();
      daemonHooks.writer = null;
      daemonHooks.reader = null;
      vi.useRealTimers();
    }
  });

  test('le daemon refuse un tick décalé quand la machine a déjà une passe complète', async () => {
    const realSetImmediate = setImmediate;
    locks.set(mainPassCadenceKey(), JSON.stringify({ machine: 'sibling', pid: 4242 }));
    lockAcquiredAt.set(mainPassCadenceKey(), Date.now());
    vi.useFakeTimers();
    try {
      daemonHooks.writer = writerDouble;
      daemonHooks.reader = readerDouble;
      const lastRunBefore = getDashboardReconcileStatus().lastRun;

      startDashboardReconcileDaemon({ dashboardsDir: dir, intervalHours: 6 });
      await vi.advanceTimersByTimeAsync(90_000);
      for (
        let i = 0;
        i < 500 && getDashboardReconcileStatus().lastRun === lastRunBefore;
        i++
      ) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }

      const lastRun = getDashboardReconcileStatus().lastRun;
      expect(lastRun?.result?.mainPassSkipped).toBe('cadence');
      expect(lastRun?.result?.parsedKeys).toBe(0);
      expect(readState.mdReads).toHaveLength(0); // the deployed daemon read no file
    } finally {
      stopDashboardReconcileDaemon();
      daemonHooks.writer = null;
      daemonHooks.reader = null;
      vi.useRealTimers();
    }
  });
});