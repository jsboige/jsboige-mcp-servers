/**
 * Clean the TypeScript build output directory before recompiling.
 *
 * Why: `tsc` does not delete emitted files whose source `.ts` was removed or
 * consolidated. Over time, dead `.js`/`.d.ts`/`.map` artefacts accumulate in
 * the output dir (orphans) — they pollute audits, can shadow real files, and
 * risk being loaded by residual dynamic imports. Found by idle-task I8
 * (cycle 43): 35 orphans (e.g. ServiceRegistry, CommitLogService,
 * SmartCleanerService) from past CONS-X consolidations whose source was
 * removed but whose compiled output persisted.
 *
 * This is safe because `build` is a plain `tsc` (full recompile, no
 * `--incremental`/tsBuildInfoFile) and the output dir is gitignored — wiping
 * it only costs the one-time full recompile tsc does anyway.
 *
 * Since #3713, `tsc` emits into `build-out/` (scratch, safe to wipe) and
 * `publish-build.mjs` copies the tree into immutable `build-<sha>/` vintages.
 * The legacy `build/` dir is deliberately NOT touched anymore: vintages are
 * managed by publish retention, and pre-#3713 wrappers still running point at
 * `build/` — deleting or rewriting it would break their lazy imports exactly
 * the way the fixed-path rebuild did.
 *
 * Usage: invoked from the `build` npm script before `tsc`.
 * Keeps `dev` (`tsc -w`) untouched for fast incremental watch-mode dev.
 *
 * @version 2.0.0 — #3713 (targets build-out/; leaves build/ frozen; 1.0.0: #2609/#2554 follow-up)
 */
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build-out');

if (existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
    console.log(`[clean-build] removed ${buildDir}`);
} else {
    console.log('[clean-build] build-out/ absent — nothing to clean');
}
