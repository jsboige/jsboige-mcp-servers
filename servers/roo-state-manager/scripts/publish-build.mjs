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
 * Failure safety: if any step fails before the marker switch, the previous
 * vintage stays current — a half-built tree is never published.
 *
 * Usage: invoked by the `build` npm script after `tsc`.
 * Env: `RSM_BUILD_RETENTION` — number of recent vintages to keep (default 3).
 *
 * @version 1.0.0 — issue #3713 (build addressed by content + hot-swap)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vintageNameFor, pruneVintages } from './lib/vintage-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build-out');
const markerFile = path.join(root, 'build-current');
const RETENTION = Number.parseInt(process.env.RSM_BUILD_RETENTION || '3', 10);

if (!fs.existsSync(path.join(outDir, 'index.js'))) {
  console.error('[publish-build] no build-out/index.js — run tsc first (non-fatal, nothing published).');
  process.exit(0);
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const walk = (rel) => {
    const abs = path.join(src, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const absPath = path.join(abs, ent.name);
      const dstPath = path.join(dst, relPath);
      if (ent.isDirectory()) { fs.mkdirSync(dstPath, { recursive: true }); walk(relPath); }
      else if (ent.isFile()) fs.copyFileSync(absPath, dstPath);
    }
  };
  walk('');
}

const vintageId = vintageNameFor(outDir);
const vintageDir = path.join(root, vintageId);

if (!fs.existsSync(vintageDir)) {
  copyTree(outDir, vintageDir);
  console.log(`[publish-build] published ${vintageId}`);
} else {
  console.log(`[publish-build] ${vintageId} already published (content-identical rebuild)`);
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
