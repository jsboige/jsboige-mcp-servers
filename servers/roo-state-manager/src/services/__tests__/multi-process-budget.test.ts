/**
 * #3661 — Worker A election: production primitive + N-process acceptance.
 *
 * Reproduces the architectural pathology documented in issue #3661:
 *   - N MCP client processes on the same machine
 *   - All call initializeBackgroundServices concurrently
 *   - Each MUST NOT prewarm the skeleton cache if ROO_AUTO_DISABLE_PREWARM is set
 *   - Each MUST NOT run the Worker A refresh + startup scans if some other process already won
 *
 * Every assertion here drives the REAL production primitive from
 * `../worker-a-lock.js`. Nothing in this file re-implements the lock algorithm:
 * a copy would stay green after the production election was weakened or removed,
 * which is precisely the guarantee this suite exists to provide.
 *
 * The N-process suite spawns N REAL Node.js processes (not mocked within a single
 * process — that cannot prove inter-process contention). Each child runs
 * `harness/worker-a-contender.mjs`, which loads the same production source under
 * test; the only thing it adds is the surrounding harness.
 *
 * Acceptance criteria verified here:
 *   - Exactly 1 process becomes leader (isWorkerALeader=true)
 *   - N-1 processes become followers (isWorkerALeader=false)
 *   - The winner is the PID actually recorded in the lock file
 *   - Lock file is machine-local (under os.tmpdir()) — invariant to env
 *   - Lock path is distinct from #2352's indexer lock (separate cycles)
 *   - Stale lock (>10 min) is stolen by the next acquirer
 *   - The holder renews on every tick, and a steal makes it step down
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  getWorkerALockPath,
  tryAcquireWorkerALeaderLock,
  ensureWorkerALeadershipForTick,
  WORKER_A_LOCK_STALE_MS,
} from '../worker-a-lock.js';

const N_PROCESSES = 8; // Spec requirement: N ≥ 8
const CONTENDER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'harness',
  'worker-a-contender.mjs'
);

/** Write a lock file directly, as a foreign process would leave it. */
async function seedLock(lockPath: string, pid: number, ageMs = 0): Promise<void> {
  await fs.writeFile(lockPath, JSON.stringify({ pid, timestamp: Date.now() - ageMs }));
}

/** Backdate a lock file's mtime without touching its content (the unreadable-lock path). */
async function backdateLock(lockPath: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(lockPath, when, when);
}

interface ChildResult {
  pid: number;
  isWorkerALeader: boolean;
  error?: string;
}

/** Spawn one real Node process that runs the production lock primitive. */
function spawnLockContender(lockPath: string, machineId: string): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CONTENDER_SCRIPT, lockPath, machineId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const lastLine = stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop() || '';
      try {
        const parsed = JSON.parse(lastLine) as ChildResult;
        resolve({ ...parsed, error: parsed.error });
      } catch {
        reject(new Error(`Child did not emit valid JSON (exit=${code}). stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

describe('getWorkerALockPath — #3661 machine-local keying (regression)', () => {
  it('returns a machineId-keyed absolute lock path with the #3661 prefix', async () => {
    const p = await getWorkerALockPath('myia-po-2025');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith('roosync-worker-a-leader-myia-po-2025.lock')).toBe(true);
  });

  it('lock path is DISTINCT from the #2352 indexer lock path (separate cycles)', async () => {
    // #3661 design study §3.2 pitfall: coupling the two elections means a Qdrant
    // leader crash paralyzes Worker A too. The two locks MUST live in different
    // files even for the same machine.
    const { getLeaderLockPath } = await import('../background-services.js');
    const a = await getWorkerALockPath('myia-po-2025');
    const b = await getLeaderLockPath('myia-po-2025');
    expect(a).not.toBe(b);
    expect(path.basename(a)).toContain('worker-a-leader-');
    expect(path.basename(b)).toContain('indexer-leader-');
  });

  it('gives each machine its own lock (machineId-keyed)', async () => {
    const a = await getWorkerALockPath('myia-ai-01');
    const b = await getWorkerALockPath('myia-po-2026');
    expect(a).not.toBe(b);
    expect(a.endsWith('roosync-worker-a-leader-myia-ai-01.lock')).toBe(true);
    expect(b.endsWith('roosync-worker-a-leader-myia-po-2026.lock')).toBe(true);
  });

  it('sanitizes unsafe machineId chars for filesystem safety', async () => {
    const p = await getWorkerALockPath('My_Bad Machine/01');
    expect(p.endsWith('roosync-worker-a-leader-my-bad-machine-01.lock')).toBe(true);
  });

  it('falls back to "local" when machineId is empty', async () => {
    const p = await getWorkerALockPath('');
    expect(p.endsWith('roosync-worker-a-leader-local.lock')).toBe(true);
  });
});

describe('tryAcquireWorkerALeaderLock — production primitive', () => {
  let sandbox: string;
  let lockPath: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-3661-worker-a-'));
    lockPath = path.join(sandbox, 'roosync-worker-a-leader-local.lock');
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('first process acquires the lock', async () => {
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(true);
  });

  it('second process with fresh lock from a different PID is rejected', async () => {
    await seedLock(lockPath, process.pid + 1);
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(false);
  });

  it('same PID renews the lock (consecutive ticks of the leader)', async () => {
    await seedLock(lockPath, process.pid, 60_000);
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(true);
    // Renewal must refresh the timestamp — that is what keeps the lock alive.
    const { timestamp } = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(timestamp).toBeGreaterThan(Date.now() - 30_000);
  });

  it('stale lock (>10 min) is stolen by the next acquirer', async () => {
    await seedLock(lockPath, process.pid + 1, WORKER_A_LOCK_STALE_MS + 60_000);
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(true);
  });

  it('a freshly-created EMPTY lock does not mint a second leader', async () => {
    // A holder is between O_CREAT and its write() for a few microseconds — the
    // entry exists with zero bytes. Treating unparseable content as "abandoned,
    // so I lead" would hand out two leaders, i.e. the N× pathology #3661 removes.
    await fs.writeFile(lockPath, '');
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(false);
  });

  it('an abandoned unreadable lock is stolen once past the stale threshold', async () => {
    await fs.writeFile(lockPath, '');
    await backdateLock(lockPath, WORKER_A_LOCK_STALE_MS + 60_000);
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath })).toBe(true);
  });

  it('unexpected filesystem failure is fail-closed (follower, never leader)', async () => {
    // A directory in place of the lock file: writeFile fails with EISDIR, which
    // is NOT EEXIST — the primitive must not claim leadership on an unknown error.
    const dirAsLock = path.join(sandbox, 'a-directory');
    await fs.mkdir(dirAsLock);
    expect(await tryAcquireWorkerALeaderLock('test-machine', { lockPath: dirAsLock })).toBe(false);
  });
});

describe('ensureWorkerALeadershipForTick — renewal / step-down (regression)', () => {
  let sandbox: string;
  let lockPath: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-3661-tick-'));
    lockPath = path.join(sandbox, 'roosync-worker-a-leader-local.lock');
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('a follower stays a follower while another PID holds a live lock, and does no work', async () => {
    const state = { machineId: 'test-machine', isWorkerALeader: false };
    await seedLock(lockPath, process.pid + 1);
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('follower');
    expect(state.isWorkerALeader).toBe(false);
  });

  it('an unowned machine is taken over by a follower on its next tick', async () => {
    const state = { machineId: 'test-machine', isWorkerALeader: false };
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('became-leader');
    expect(state.isWorkerALeader).toBe(true);
  });

  it('the leader renews on every tick, so the lock never ages out under it', async () => {
    const state = { machineId: 'test-machine', isWorkerALeader: false };
    await ensureWorkerALeadershipForTick(state, { lockPath });
    // Backdate the lock to just under the threshold: this is the state a
    // BOOT-ONLY acquisition reaches after ~10 min of ticking. Renewing on the
    // next tick must reset it — that refresh is the entire difference between
    // holding the lock across a long-lived process and losing it to a starter.
    await seedLock(lockPath, process.pid, WORKER_A_LOCK_STALE_MS - 60_000);
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('leading');
    const renewed = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(Date.now() - renewed.timestamp).toBeLessThan(30_000);
  });

  it('a leader whose lock was stolen steps down, then re-elects', async () => {
    const state = { machineId: 'test-machine', isWorkerALeader: true };
    await seedLock(lockPath, process.pid + 1); // another process now owns the lock
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('stepped-down');
    expect(state.isWorkerALeader).toBe(false);
    // Step-down must NOT clear the interval: the next tick re-runs the election.
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('follower');
  });

  it('an OLD stale lock is taken over by a starter (the boot-only failure mode)', async () => {
    const state = { machineId: 'test-machine', isWorkerALeader: false };
    // What a leader that only acquired at boot leaves behind after 10 min without
    // renewing: a lock any later starter can steal, yielding a second stack.
    await seedLock(lockPath, process.pid + 1, WORKER_A_LOCK_STALE_MS + 60_000);
    expect(await ensureWorkerALeadershipForTick(state, { lockPath })).toBe('became-leader');
    expect(state.isWorkerALeader).toBe(true);
  });
});

/**
 * N-process reproduction of the #3661 pathology. Each child runs the production
 * primitive from source (see harness/worker-a-contender.mjs). The test spawns N
 * real Node.js processes that all race for the same lock at approximately the
 * same instant. Exactly ONE process should become leader; the remaining N-1 must
 * be followers. This is the acceptance criterion for the "pas N scans identiques
 * au demarrage" claim in issue §4.
 */
describe('Worker A leader-election — N-process budget (#3661 acceptance)', () => {
  let sandbox: string;
  let lockPath: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-3661-bbox-'));
    lockPath = path.join(sandbox, 'roosync-worker-a-leader-local.lock');
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it(`N=${N_PROCESSES} concurrent processes: exactly 1 leader, N-1 followers`, async () => {
    // Spawn N contenders in parallel — they all hit the lock at roughly the same time.
    // The OS-level writeFile with flag:'wx' is the serialization point.
    const promises: Promise<ChildResult>[] = [];
    for (let i = 0; i < N_PROCESSES; i++) {
      promises.push(spawnLockContender(lockPath, 'test-machine'));
    }

    const results = await Promise.all(promises);
    const failures = results.filter(r => r.error);
    expect(failures, `contender(s) crashed: ${JSON.stringify(failures)}`).toHaveLength(0);

    const leaders = results.filter(r => r.isWorkerALeader);
    const followers = results.filter(r => !r.isWorkerALeader);

    expect(leaders.length).toBe(1);
    expect(followers.length).toBe(N_PROCESSES - 1);

    // The winner must be the PID the lock file actually names — a leader flag
    // that does not match the on-disk owner would let two stacks run.
    const onDisk = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(leaders[0].pid);
  }, 60_000);
});
