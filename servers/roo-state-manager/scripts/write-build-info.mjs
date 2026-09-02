/**
 * Stamp the compiled output with the vintage it was built from.
 *
 * Why: the MCP server is a stdio child — one process per session — and a
 * process loads its modules once. A long-lived interactive session therefore
 * keeps serving the build that existed when it started, indefinitely, while
 * `build/` on disk moves ahead under it. Nothing in the tool surface exposed
 * which vintage a caller was actually talking to: `roosync_diagnose` reported
 * Node's version, RAM and directories, but neither the build SHA, the build
 * time, nor the process start time.
 *
 * The cost of that blind spot is a class of false bug report that is
 * indistinguishable from a real one: an agent measures a defect on a stale
 * process and reports the tool broken, long after the fix landed. Measured on
 * myia-ai-01 (2026-09-02): 50 concurrent server processes on one machine,
 * 22 predating the on-disk build and 28 postdating it — and the coordinator's
 * own session reproduced #3351 from a process ~18 h older than the commit that
 * fixed it, while two other machines observed the fix working.
 *
 * This writes `build/build-info.json` after `tsc`, so the runtime can answer
 * "which vintage am I?" in one call. Failure is never fatal: a missing or
 * unreadable stamp degrades to `null` fields, never to a broken build.
 *
 * Usage: invoked by the `postbuild` npm hook (and explicitly from
 * `build:noclean`, which npm's hook does not cover).
 *
 * @version 1.0.0 — issue #3351 follow-up
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'build', 'build-info.json');

/** Best-effort git read; returns null rather than throwing on a tarball/CI checkout without git. */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const sha = git('rev-parse', 'HEAD');
const info = {
  sha,
  shortSha: sha ? sha.slice(0, 8) : null,
  // A dirty tree means the stamp names a commit the build does not actually match.
  dirty: git('status', '--porcelain') ? true : sha === null ? null : false,
  builtAt: new Date().toISOString(),
  version: packageVersion(),
};

try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(info, null, 2) + '\n', 'utf8');
  console.log(`[build-info] ${info.shortSha ?? 'no-git'}${info.dirty ? '-dirty' : ''} @ ${info.builtAt}`);
} catch (err) {
  // Never fail the build over an observability stamp.
  console.warn(`[build-info] stamp not written (non-fatal): ${err.message}`);
}
