/**
 * Stamp the compiled output with the vintage it was built from.
 *
 * Why: the MCP server is a stdio child — one process per session — and a
 * process loads its modules once. A long-lived interactive session therefore
 * keeps serving the build that existed when it started, indefinitely, while
 * the build on disk moves ahead under it. Nothing in the tool surface exposed
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
 * This stamps `<targetDir>/build-info.json` after `tsc`, so the runtime can
 * answer "which vintage am I?" in one call. Failure is never fatal: a missing
 * or unreadable stamp degrades to `null` fields, never to a broken build.
 *
 * Invariant: the stamp never outruns the build it describes. `builtAt` is the
 * mtime of `<targetDir>/index.js` (the artifact the server loads), and `sha`
 * is only filled when this invocation actually produced that build —
 * otherwise the commit is left null rather than guessed.
 *
 * Usage: exported `writeBuildInfo(targetDir)` — called by
 * `scripts/publish-build.mjs` against the content-addressed vintage.
 * Running this file directly stamps the legacy `build/` dir (compat).
 *
 * @version 1.2.0 — #3713 (stamps a caller-provided vintage dir; 1.1.0: stamp bound to the build, #1076 follow-up; #3351 origin)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

export function writeBuildInfo(targetDir = path.join(root, 'build')) {
  const outFile = path.join(targetDir, 'build-info.json');
  const buildEntry = path.join(targetDir, 'index.js');

  /** mtime of the artifact the server actually loads — the only thing that truly dates a build. */
  let entryMtimeMs = null;
  try {
    entryMtimeMs = fs.statSync(buildEntry).mtimeMs;
  } catch {
    entryMtimeMs = null;
  }

  if (entryMtimeMs === null) {
    // No compiled entry point: there is no build to describe. Stamping here would
    // claim a build that does not exist.
    console.warn(`[build-info] no ${path.relative(root, buildEntry)} — nothing to stamp (non-fatal).`);
    return null;
  }

  // A stamp may only name a commit when THIS invocation produced the build it
  // describes. Run standalone against an older build, we cannot know which commit
  // compiled it — and guessing is exactly how this stamp came to claim a build
  // 8h38 newer than every artifact inside it (myia-ai-01, 2026-09-02: stamp
  // builtAt 02:20:03Z over a build whose newest .js was 2026-09-01 19:42).
  // A fresh process then reads `processPrecedesBuild: false`, emits no note, and
  // believes itself current while serving code hours older than claimed — the
  // instrument turned actively misleading, which is worse than absent.
  const PRODUCED_BY_THIS_RUN_MS = 10 * 60 * 1000;
  const buildIsOurs = Date.now() - entryMtimeMs <= PRODUCED_BY_THIS_RUN_MS;

  const sha = buildIsOurs ? git('rev-parse', 'HEAD') : null;
  const info = {
    sha,
    shortSha: sha ? sha.slice(0, 8) : null,
    // A dirty tree means the stamp names a commit the build does not actually match.
    // Dirty must mean "the COMPILED inputs changed", not "any file in the tree":
    // unrelated untracked debris (logs, scratch dirs) otherwise pins dirty=true forever
    // and every freshness check built on the stamp rebuilds on each run (#3713).
    dirty: !buildIsOurs ? null : git('status', '--porcelain', '--', 'src', 'package.json', 'tsconfig.json') ? true : sha === null ? null : false,
    // The BUILD's timestamp, never the stamp's: `Date.now()` here is what let the
    // stamp outrun the artifacts it describes.
    builtAt: new Date(entryMtimeMs).toISOString(),
    version: packageVersion(),
  };

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(info, null, 2) + '\n', 'utf8');
    const who = info.shortSha ?? (buildIsOurs ? 'no-git' : 'sha-unknown (build not produced by this run)');
    console.log(`[build-info] ${who}${info.dirty ? '-dirty' : ''} @ ${info.builtAt}`);
    return info;
  } catch (err) {
    // Never fail the build over an observability stamp.
    console.warn(`[build-info] stamp not written (non-fatal): ${err.message}`);
    return null;
  }
}

// Direct execution: legacy behavior (stamp build/).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeBuildInfo();
}
