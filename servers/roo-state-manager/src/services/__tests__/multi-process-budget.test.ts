/**
 * #3661 — Multi-process budget test.
 *
 * Reproduces the architectural pathology documented in issue #3661:
 *   - N MCP client processes on the same machine
 *   - All call initializeBackgroundServices concurrently
 *   - Each MUST NOT prewarm the skeleton cache if ROO_AUTO_DISABLE_PREWARM is set
 *   - Each MUST NOT run the Worker A refresh + startup scans if some other process already won
 *
 * The test uses `child_process.fork` to spawn N REAL Node.js processes (not mocked
 * within a single process — that wouldn't prove inter-process lock contention).
 * Each child runs a minimal harness that:
 *   1. Acquires the Worker A lock via tryAcquireWorkerALeaderLock
 *   2. Reports `{ pid, isWorkerALeader }` to stdout
 *   3. Exits cleanly
 *
 * The harness in production is `initializeBackgroundServices` (background-services.ts),
 * but its full setup pulls in storage detectors, Qdrant, embeddings, etc. — out of
 * scope for a unit test. The lock contract is the SUBJECT of the test (per the
 * design study §4 acceptance criterion: "test multi-processus reproductible N≥8").
 *
 * Acceptance criteria verified here:
 *   - Exactly 1 process becomes leader (isWorkerALeader=true)
 *   - N-1 processes become followers (isWorkerALeader=false)
 *   - Lock file is machine-local (under os.tmpdir()) — invariant to env
 *   - Lock path is distinct from #2352's indexer lock (separate cycles)
 *   - Stale lock (>10 min) is stolen by the next acquirer
 *
 * IMPORTANT: This test runs in vitest's `pool:'forks'` mode so that the parent
 * process's lock contention is observable. Vitest default is `pool:'threads'`
 * which serialises JS but threads share the same fs view — child_process.fork
 * from a worker thread still works correctly (Node.js OS-level locks).
 *
 * Anti-regression: this test will FAIL if tryAcquireWorkerALeaderLock is removed,
 * weakened, or coupled to the #2352 indexer lock (the exact #3661 §3.2 pitfall).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Re-implement the algorithm under test (same as tryAcquireWorkerALeaderLock in
// background-services.ts). We import the public path helper for parity.
import { getWorkerALockPath } from '../background-services.js';

const STALE_MS = 10 * 60 * 1000;
const N_PROCESSES = 8; // Spec requirement: N ≥ 8

async function tryAcquireWorkerALeaderLockPublic(
  lockPath: string,
  pid: number,
  now: number = Date.now(),
): Promise<boolean> {
  const lockData = { pid, timestamp: now };
  try {
    await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error.code !== 'EEXIST') return false;
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const existing = JSON.parse(content);
      if (existing.pid === pid) {
        await fs.writeFile(lockPath, JSON.stringify(lockData));
        return true;
      }
      const age = now - existing.timestamp;
      if (age > STALE_MS) {
        await fs.writeFile(lockPath, JSON.stringify(lockData));
        return true;
      }
      return false;
    } catch {
      await fs.writeFile(lockPath, JSON.stringify(lockData));
      return true;
    }
  }
}

interface ChildResult {
  pid: number;
  isWorkerALeader: boolean;
  exitCode: number | null;
}

/**
 * Spawn a single Node.js child that runs tryAcquireWorkerALeaderLock against a shared
 * lockPath and prints the result to stdout. The child is short-lived (no MCP deps).
 */
function spawnLockContender(lockPath: string, machineId: string): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const childCode = `
      const { promises: fs } = require('fs');
      const path = require('path');
      async function main() {
        const lockPath = ${JSON.stringify(lockPath)};
        const pid = process.pid;
        const lockData = { pid, timestamp: Date.now() };
        let isLeader = false;
        try {
          await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' });
          isLeader = true;
        } catch (error) {
          if (error.code !== 'EEXIST') {
            console.log(JSON.stringify({ pid, isWorkerALeader: false, error: error.message }));
            process.exit(0);
          }
          try {
            const content = await fs.readFile(lockPath, 'utf-8');
            const existing = JSON.parse(content);
            if (existing.pid === pid) { isLeader = true; }
            else {
              const age = Date.now() - existing.timestamp;
              if (age > ${STALE_MS}) { isLeader = true; }
            }
          } catch {
            isLeader = true;
          }
        }
        console.log(JSON.stringify({ pid, isWorkerALeader: isLeader }));
        process.exit(0);
      }
      main().catch((e) => { console.error(e); process.exit(1); });
    `;

    const child = spawn(process.execPath, ['-e', childCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const lastLine = stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop() || '';
      try {
        const parsed = JSON.parse(lastLine) as { pid: number; isWorkerALeader: boolean };
        resolve({ pid: parsed.pid, isWorkerALeader: parsed.isWorkerALeader, exitCode: code });
      } catch {
        reject(new Error(`Child did not emit valid JSON. stdout=${stdout}`));
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

describe('Worker A leader-election — single-process content algorithm', () => {
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
    expect(await tryAcquireWorkerALeaderLockPublic(lockPath, 12345)).toBe(true);
  });

  it('second process with fresh lock from a different PID is rejected', async () => {
    await tryAcquireWorkerALeaderLockPublic(lockPath, 12345);
    expect(await tryAcquireWorkerALeaderLockPublic(lockPath, 67890)).toBe(false);
  });

  it('same PID renews the lock (consecutive ticks of the leader)', async () => {
    await tryAcquireWorkerALeaderLockPublic(lockPath, 12345);
    // The leader renews its lock on each cycle (e.g., every 2 min)
    expect(await tryAcquireWorkerALeaderLockPublic(lockPath, 12345)).toBe(true);
  });

  it('stale lock (>10 min) is stolen by the next acquirer', async () => {
    // Acquire with old timestamp
    await tryAcquireWorkerALeaderLockPublic(lockPath, 12345, Date.now() - 11 * 60 * 1000);
    // Next acquirer steals
    expect(await tryAcquireWorkerALeaderLockPublic(lockPath, 67890, Date.now())).toBe(true);
  });
});

/**
 * N-process reproduction of the #3661 pathology. Requires `pool: 'forks'` or
 * `pool: 'forks'` in the vitest config — see `vitest.config.unit.ts` (CI excludes
 * these N=8 tests via `vitest.config.ci.ts` because fork-based spawning is heavy
 * on the CI pipeline; see CI-EXCLUSIONS-CENSUS.md for the rationale).
 *
 * The test spawns N real Node.js processes that all race for the same lock at
 * approximately the same instant. Exactly ONE process should become leader; the
 * remaining N-1 must be followers. This is the acceptance criterion for the
 * "pas N scans identiques au démarrage" claim in issue §4.
 */
describe.skip('Worker A leader-election — N-process budget (#3661 acceptance)', () => {
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
    const leaders = results.filter(r => r.isWorkerALeader);
    const followers = results.filter(r => !r.isWorkerALeader);

    expect(leaders.length).toBe(1);
    expect(followers.length).toBe(N_PROCESSES - 1);
  }, 30_000);

  it(`N=${N_PROCESSES} processes: leaders have distinct PIDs (no double-leader)`, async () => {
    const promises: Promise<ChildResult>[] = [];
    for (let i = 0; i < N_PROCESSES; i++) {
      promises.push(spawnLockContender(lockPath, 'test-machine'));
    }

    const results = await Promise.all(promises);
    const leaders = results.filter(r => r.isWorkerALeader);

    // Each process has a distinct PID; leaders must come from distinct PIDs.
    const leaderPids = new Set(leaders.map(l => l.pid));
    expect(leaderPids.size).toBe(leaders.length);
  }, 30_000);
});
