// Maintenance#358 — the per-worker mkdtemp dirs created by tests/setup-env.ts
// must not outlive the process that created them. Measured before the fix:
// 221 680 leaked rsm-test-* dirs on ai-01 (3 dirs per vitest worker per run).
//
// Proof strategy: spawn a REAL child node process that imports setup-env.ts
// (native type stripping, node >= 22.6 with the flag), have it report the dirs
// it created, then verify — once the child has exited — that exactly those
// dirs are gone. Red without the 'exit' teardown: the child exits normally
// and its dirs would still exist.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_ENV = path.join(__dirname, '..', 'setup-env.ts');

const CHILD_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const fs = await import('node:fs');
await import(pathToFileURL(process.env.SETUP_ENV_PATH).href);
const keys = ['ROOSYNC_LOCK_DIR', 'ROOSYNC_SCAN_LOCK_DIR', 'ROOSYNC_TOOL_USAGE_CACHE_DIR'];
const dirs = keys.map((k) => process.env[k]);
const existed = dirs.map((d) => fs.existsSync(d));
console.log(JSON.stringify({ dirs, existed }));
`.trim();

describe('Maintenance#358 — setup-env per-worker temp dirs are torn down at process exit', () => {
  it('a child importing setup-env.ts leaves no rsm-test-* dir behind', () => {
    // The parent (this vitest worker) already has the three env vars set by
    // its own setup-env run — clear them for the child so it creates its own.
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.ROOSYNC_LOCK_DIR;
    delete env.ROOSYNC_SCAN_LOCK_DIR;
    delete env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
    env.SETUP_ENV_PATH = SETUP_ENV;
    // dotenv in setup-env reads .env.test/.env relative to the file location —
    // cwd is irrelevant, but keep it at the project root for parity.
    env.NODE_OPTIONS = ''; // do not inherit experimental flags from the runner

    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', CHILD_SCRIPT],
      { env, encoding: 'utf-8', timeout: 60_000 },
    );

    expect(child.status).toBe(0);
    const lastLine = child.stdout.trim().split('\n').pop() ?? '';
    const { dirs, existed } = JSON.parse(lastLine) as {
      dirs: (string | undefined)[];
      existed: boolean[];
    };

    // The child really created its own three dirs (they existed while alive).
    expect(dirs).toHaveLength(3);
    dirs.forEach((d) => expect(d).toMatch(/rsm-test-(locks|scan-locks|tus-cache)-/));
    existed.forEach((e) => expect(e).toBe(true));

    // After normal child exit, the exit handler must have removed them.
    dirs.forEach((d) => expect(fs.existsSync(d as string)).toBe(false));
  }, 90_000);

  it('a hard-killed worker\'s dirs are swept by the main-process reaper (Windows vector)', async () => {
    // The forks pool with isolate:true terminates workers by kill: on POSIX a
    // signal the in-process handlers catch; on Windows TerminateProcess — no
    // handler can EVER run there. The globalSetup teardown sweep is the
    // remedy for that vector (measured: 2 913 dirs survived one CI-config
    // run with in-process handlers alone). This test proves the sweep.
    const { sweepRsmTestWorkerDirs } = await import('../setup-env-teardown');
    const spawnStart = Date.now();
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.ROOSYNC_LOCK_DIR;
    delete env.ROOSYNC_SCAN_LOCK_DIR;
    delete env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
    env.SETUP_ENV_PATH = SETUP_ENV;
    env.NODE_OPTIONS = '';

    // A pre-run "stock" dir with an old mtime: the sweep must NEVER touch it
    // (it models ai-01's 221 680 legacy dirs — the purge of those is a
    // separate, deliberate operation, not a side effect of this fix).
    const stockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rsm-test-locks-'),
    );
    const oldTime = new Date(spawnStart - 24 * 3600 * 1000);
    fs.utimesSync(stockDir, oldTime, oldTime);

    // Child creates its three dirs and IDLES — we hard-kill it (on Windows
    // kill() is TerminateProcess: uncatchable; on POSIX SIGTERM runs the
    // in-process cleanup — the sweep must handle whatever remains).
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e',
        CHILD_SCRIPT + '\nsetInterval(() => {}, 1000);'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    const dirs = await new Promise<(string | undefined)[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child never reported its dirs')), 30_000);
      child.stdout.on('data', () => {
        const text = Buffer.concat(stdoutChunks).toString('utf-8');
        const lastLine = text.trim().split('\n').pop();
        if (lastLine && lastLine.startsWith('{')) {
          clearTimeout(timer);
          resolve((JSON.parse(lastLine) as { dirs: (string | undefined)[] }).dirs);
        }
      });
      child.once('error', reject);
    });
    expect(dirs).toHaveLength(3);
    dirs.forEach((d) => expect(fs.existsSync(d as string)).toBe(true));

    child.kill(); // platform kill — Windows: uncatachable hard kill
    await new Promise<void>((resolve) => child.once('exit', resolve));

    // Whatever the in-process handlers could not do, the sweep must.
    const removed = sweepRsmTestWorkerDirs(spawnStart);
    dirs.forEach((d) => expect(fs.existsSync(d as string)).toBe(false));

    // The guard: pre-run stock (old mtime) survives the sweep untouched.
    expect(fs.existsSync(stockDir)).toBe(true);
    fs.rmSync(stockDir, { recursive: true, force: true });
  }, 90_000);
});
