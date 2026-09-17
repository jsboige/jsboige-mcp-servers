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
 * Usage:   node worker-a-contender.mjs <lockPath> [machineId]
 * stdout:  one JSON line — { pid, isWorkerALeader, error? }
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');

const [, , lockPath, machineId = 'test-machine'] = process.argv;

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

try {
    const { code } = transformSync(readFileSync(sourcePath, 'utf-8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node20',
    });
    writeFileSync(transformedPath, code, 'utf-8');
    const { tryAcquireWorkerALeaderLock } = await import(pathToFileURL(transformedPath).href);
    report({ isWorkerALeader: await tryAcquireWorkerALeaderLock(machineId, { lockPath }) });
} catch (error) {
    report({ isWorkerALeader: false, error: String(error?.message ?? error) });
} finally {
    try {
        rmSync(transformedPath, { force: true });
    } catch {
        /* best effort — the sandbox is torn down by the test anyway */
    }
}
