#!/usr/bin/env node
/**
 * #3661 — child-process contender for the N-process acceptance test.
 *
 * Runs the PRODUCTION Worker A lock primitive in a real OS process. It loads
 * `src/services/worker-a-lock.ts` from SOURCE (transformed by esbuild, the same
 * transpiler vitest uses) rather than re-implementing the algorithm or importing
 * a built artifact:
 *   - a re-implementation keeps passing after the production election is
 *     weakened — the failure mode the acceptance criterion must catch;
 *   - a `build/` artifact can predate the diff under test, so a green run would
 *     attest to code nobody is reviewing.
 * Loading the source keeps the child in lockstep with the working tree on both
 * Node 20 (CI) and Node 22.
 *
 * Usage:   node worker-a-contender.mjs <lockPath> [machineId] [holdMs]
 * stdout:  one JSON line — { pid, isWorkerALeader, error? }
 *
 * #4352: with dead-PID stealing, a contender that exits the instant it wins
 * leaves a fresh lock on a dead holder — every later probe then steals, and a
 * concurrent N-process race would mint N leaders. Real holders are long-lived
 * MCP processes; `holdMs` models that: the WINNER stays alive that long before
 * exiting (followers exit immediately). Sequential takeover tests pass 0 and
 * rely on the holder being provably dead for the next contender.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');

const [, , lockPath, machineId = 'test-machine', holdMsArg = '0'] = process.argv;
const holdMs = Number.parseInt(holdMsArg, 10) || 0;

function report(result) {
    console.log(JSON.stringify({ pid: process.pid, ...result }));
    process.exit(0);
}

if (!lockPath) {
    report({ isWorkerALeader: false, error: 'missing <lockPath> argument' });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', '..', 'worker-a-lock.ts');
const transformedPath = path.join(os.tmpdir(), `rsm-3661-contender-${process.pid}.mjs`);
// #4352: worker-a-lock now imports shared satellites (pid-liveness, then W1
// added lock-participation). The contender is written to a temp dir, so the
// relative './x.js' specifiers would resolve against THAT directory and fail.
// Transform EACH satellite source (same production-source rule as the lock
// itself) and rewrite every specifier to its absolute file URL.
const SATELLITES = [
    { src: 'pid-liveness.ts', tmp: `rsm-4352-pid-liveness-${process.pid}.mjs` },
    { src: 'lock-participation.ts', tmp: `rsm-4352-lock-participation-${process.pid}.mjs` },
    // #4352 W3: readLockForAtomicity extracted to its own module (shared with
    // background-services.ts) — worker-a-lock.ts imports it, so it transforms too.
    { src: 'lock-atomicity.ts', tmp: `rsm-4352-lock-atomicity-${process.pid}.mjs` },
];

try {
    const rewrittenSpecifiers = new Map();
    for (const { src, tmp } of SATELLITES) {
        const satellitePath = path.join(os.tmpdir(), tmp);
        const { code: satCode } = transformSync(readFileSync(path.join(here, '..', '..', src), 'utf-8'), {
            loader: 'ts',
            format: 'esm',
            target: 'node20',
        });
        writeFileSync(satellitePath, satCode, 'utf-8');
        rewrittenSpecifiers.set(`./${src.replace(/\.ts$/, '.js')}`, pathToFileURL(satellitePath).href);
    }

    const { code } = transformSync(readFileSync(sourcePath, 'utf-8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node20',
    });
    let rewritten = code;
    for (const [specifier, href] of rewrittenSpecifiers) {
        // Plain string replace (split/join) — a regex would need every dot of
        // the specifier escaped and `.{mod}.js` would silently over-match.
        rewritten = rewritten
            .split(`'${specifier}'`).join(`'${href}'`)
            .split(`"${specifier}"`).join(`"${href}"`);
    }
    writeFileSync(transformedPath, rewritten, 'utf-8');
    const { tryAcquireWorkerALeaderLock } = await import(pathToFileURL(transformedPath).href);
    const isWorkerALeader = await tryAcquireWorkerALeaderLock(machineId, { lockPath });
    console.log(JSON.stringify({ pid: process.pid, isWorkerALeader }));
    if (holdMs > 0 && isWorkerALeader) {
        // Model a real long-lived holder: stay alive so concurrent contenders
        // probing the lock see a LIVE pid (they must stay followers). Fall
        // through to the finally cleanup when the hold elapses.
        await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
} catch (error) {
    report({ isWorkerALeader: false, error: String(error?.message ?? error) });
} finally {
    const temps = [transformedPath, ...SATELLITES.map(({ tmp }) => path.join(os.tmpdir(), tmp))];
    for (const p of temps) {
        try {
            rmSync(p, { force: true });
        } catch {
            /* best effort — the sandbox is torn down by the test anyway */
        }
    }
}
