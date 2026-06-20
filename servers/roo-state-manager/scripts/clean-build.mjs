/**
 * Clean the TypeScript build output directory before recompiling.
 *
 * Why: `tsc` does not delete emitted files whose source `.ts` was removed or
 * consolidated. Over time, dead `.js`/`.d.ts`/`.map` artefacts accumulate in
 * `build/` (orphans) — they pollute audits, can shadow real files, and risk
 * being loaded by residual dynamic imports. Found by idle-task I8 (cycle 43):
 * 35 orphans (e.g. ServiceRegistry, CommitLogService, SmartCleanerService) from
 * past CONS-X consolidations whose source was removed but whose compiled
 * output persisted.
 *
 * This is safe because `build` is a plain `tsc` (full recompile, no
 * `--incremental`/tsBuildInfoFile) and `build/` is gitignored — wiping it only
 * costs the one-time full recompile tsc does anyway.
 *
 * Usage: invoked from the `build` npm script before `tsc`.
 * Keeps `dev` (`tsc -w`) untouched for fast incremental watch-mode dev.
 *
 * @version 1.0.0 — issue #2609/#2554 follow-up (idle-task I8 c.43 friction)
 */
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build');

if (existsSync(buildDir)) {
	rmSync(buildDir, { recursive: true, force: true });
	console.log(`[clean-build] removed ${buildDir}`);
} else {
	console.log('[clean-build] build/ absent — nothing to clean');
}
