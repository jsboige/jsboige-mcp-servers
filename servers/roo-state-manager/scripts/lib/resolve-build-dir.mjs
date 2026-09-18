/**
 * Resolve the directory the server code currently lives in.
 *
 * Since #3713, builds are published as content-addressed vintages
 * (`build-<sha>/`) behind an atomically-switched `build-current` marker; the
 * legacy fixed `build/` dir is frozen and never rewritten. Anything that
 * imports server code from disk (ops scripts, probes) must go through this
 * resolver — importing from a stale fixed path would keep reading a frozen
 * vintage forever.
 *
 * Falls back to `build/` when no valid marker exists (machine not yet
 * migrated to the vintage pipeline).
 *
 * @version 1.0.0 — issue #3713
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveBuildDir(rsmRoot) {
  try {
    const marker = path.join(rsmRoot, 'build-current');
    const name = fs.readFileSync(marker, 'utf-8').trim();
    if (/^build-[0-9a-f]{16}$/.test(name) && fs.existsSync(path.join(rsmRoot, name, 'index.js'))) {
      return path.join(rsmRoot, name);
    }
  } catch {}
  return path.join(rsmRoot, 'build');
}
