/**
 * Publish the compiled output as a content-addressed, immutable vintage.
 *
 * Why: `tsc` used to write into `build/` — a fixed path that every live MCP
 * host also reads. A rebuild therefore rewrote bytes under running processes;
 * Node ESM caches by resolved URL, so a long-lived host ended up with a mixed
 * graph of old importers and new lazy imports, crashing on the next dynamic
 * import (exit-10 cascade, #3713). The only remedy was a full VS Code quit,
 * which made restart frequency equal build frequency.
 *
 * This script turns the build pipeline content-addressed (mechanics live in
 * scripts/lib/vintage-store.mjs, unit-tested there):
 *   1. `tsc` emits into `build-out/` (a scratch dir, safe to rewrite).
 *   2. The emitted tree is hashed deterministically (path+content, sorted).
 *   3. The tree is copied to `build-<vintage>/` — never rewritten afterwards.
 *   4. The `build-current` marker is switched atomically (write tmp + rename).
 *   5. Retention keeps the N most recent vintages plus any vintage a live
 *      wrapper still references (`.ref-<pid>` files, dead-PID refs cleaned).
 *
 * `mcp-wrapper.cjs` resolves the marker once per child spawn and watches it
 * to hot-swap the server process, so a rebuild never touches a byte a live
 * host is reading. Vintages are immutable except `build-info.json` (metadata
 * read via fs, not an ESM module — rewriting it cannot arm a host).
 *
 *   6. Each vintage also carries its own copy of the workspace packages the
 *      server depends on (`@vibesync/core`), under node_modules/<name>, and
 *      that copy counts in the vintage hash (#4918). Linked by npm into
 *      packages/<name>, those packages have one dist/ for every vintage,
 *      rebuilt in place under live hosts: without the copy, a module loaded
 *      late from a running vintage would read the dist/ of a later build.
 *
 * Failure safety: if any step fails before the marker switch, the previous
 * vintage stays current — a half-built tree is never published. The final name
 * only ever appears through an atomic rename of a staging tree whose content
 * hash, recomputed on the copy, equals that name (ms#1910 review). A staged
 * copy that does not hash back to its id — a source changed while it was being
 * copied — is discarded and the publish exits 1. A copy interrupted by a crash
 * leaves `build-<id>.staging-<pid>` behind, which the next publish discards,
 * and an existing directory that does not hash back to its own name is
 * refused, never marked.
 *
 * Usage: invoked by the `build` npm script after `tsc`.
 * Env: `RSM_BUILD_RETENTION` — number of recent vintages to keep (default 3).
 *
 * @version 1.2.0 — ms#1910 review (staged publication, hash verified on the
 *   copy, existing same-id tree refused when incomplete); 1.1.0 — issue #4918
 *   (bundled workspace dependencies); 1.0.0 — #3713 (build addressed by
 *   content + hot-swap)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleInto, bundledParts, cleanStaleStaging, copyTree, pruneVintages, stagingPathFor,
  vintageNameFor, vintageNameOnDisk, workspaceDependencies,
} from './lib/vintage-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build-out');
const markerFile = path.join(root, 'build-current');
const RETENTION = Number.parseInt(process.env.RSM_BUILD_RETENTION || '3', 10);

if (!fs.existsSync(path.join(outDir, 'index.js'))) {
  console.error('[publish-build] no build-out/index.js — run tsc first (non-fatal, nothing published).');
  process.exit(0);
}

// #4918: the vintage must resolve its workspace dependencies to its own copy.
// `bundledParts` throws when one of them has no build to copy — before anything
// is published, so the marker stays on the previous vintage.
const bundled = workspaceDependencies(root);
for (const { name, realDir } of bundled) console.log(`[publish-build] bundling workspace dependency ${name} from ${realDir}`);

// A crashed run leaves only `<vintage>.staging-<pid>` behind, so the next
// publish can never mistake a fragment for a published vintage.
for (const stale of cleanStaleStaging(root)) {
  console.log(`[publish-build] removed stale staging ${stale} (its publish process is gone)`);
}

const vintageId = vintageNameFor(outDir, bundledParts(bundled));
const vintageDir = path.join(root, vintageId);

/**
 * The id is the completion witness, read back from the copy itself: a tree
 * that does not hash to its own name is an interrupted or corrupted publish —
 * or a source that changed while it was being copied — and marking it would
 * serve a half-built tree to every live host. Exits 1, marking nothing.
 */
function refuse(what, onDisk, expected, remedy) {
  console.error(`[publish-build] REFUSED: ${what} hashes to ${onDisk}, not ${expected} — incomplete copy, or a source changed while it was being copied. Nothing was published; the marker was not moved.${remedy}`);
  process.exit(1);
}

/** Remove a staging tree; a file still open elsewhere must not turn a clear outcome into a stack trace — the next publish discards what is left once this process is gone. */
function discard(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (fs.existsSync(vintageDir)) {
  const onDisk = vintageNameOnDisk(vintageDir);
  if (onDisk !== vintageId) refuse(`${vintageId}, already on disk,`, onDisk, vintageId, ` Remove ${vintageDir} and rebuild.`);
  console.log(`[publish-build] ${vintageId} already published (content-identical rebuild)`);
} else {
  // Stage, verify ON THE COPY, then rename: the shared workspace dist/ can be
  // rebuilt between the hash above and the copy below, and the final name must
  // only ever appear on a tree that hashes to it.
  const stagingDir = stagingPathFor(vintageDir);
  discard(stagingDir); // ours by pid; a leftover can only be a dead run whose pid was reused
  copyTree(outDir, stagingDir);
  const bundledFiles = bundleInto(stagingDir, bundled);
  const onDisk = vintageNameOnDisk(stagingDir);
  if (onDisk !== vintageId) {
    discard(stagingDir); // not what was hashed: discarded, never renamed
    refuse('the staged copy', onDisk, vintageId, ' Build again.');
  }
  try {
    fs.renameSync(stagingDir, vintageDir);
  } catch (err) {
    discard(stagingDir);
    if (!fs.existsSync(vintageDir)) throw err; // a real failure — not a concurrent publish of the same content
    console.log(`[publish-build] ${vintageId} was published concurrently (same content) — reading that one back`);
    const winner = vintageNameOnDisk(vintageDir);
    if (winner !== vintageId) refuse(`${vintageId}, published concurrently,`, winner, vintageId, ` Remove ${vintageDir} and rebuild.`);
  }
  console.log(`[publish-build] published ${vintageId}`);
  if (bundledFiles > 0) {
    console.log(`[publish-build] bundled ${bundled.map((b) => b.name).join(', ')} into ${vintageId} (${bundledFiles} files)`);
  }
}

// Stamp the vintage with the commit it was built from. Re-run on an identical
// rebuild refreshes builtAt — safe: build-info.json is fs-read metadata, not
// an ESM module, so rewriting it cannot arm a live host.
try {
  const { writeBuildInfo } = await import('./write-build-info.mjs');
  writeBuildInfo(vintageDir, { producedByThisRun: true });
} catch (err) {
  console.warn(`[publish-build] stamp not written (non-fatal): ${err.message}`);
}

// Atomic marker switch: the tmp+rename pair means a reader either sees the old
// vintage or the new one, never a truncated name.
fs.writeFileSync(`${markerFile}.tmp`, `${vintageId}\n`, 'utf-8');
fs.renameSync(`${markerFile}.tmp`, markerFile);
console.log(`[publish-build] marker → ${vintageId}`);

const { pruned, pinned } = pruneVintages(root, { currentName: vintageId, retention: RETENTION });
for (const p of pinned) console.log(`[publish-build] keep ${p} (live wrapper ref)`);
for (const p of pruned) console.log(`[publish-build] pruned ${p}`);
