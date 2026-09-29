/**
 * Drift-guard for reconcile-roosync-channel.mjs manifest default (#3151, friction web2).
 *
 * The reconcile script ALWAYS writes a rollback manifest. Its default directory
 * must be scripts/manifests/ (gitignored) — not the script dir itself, where
 * every fleet dry-run dirtied the checkout (web1 had to purge one in c.544
 * postcondition). This test pins the three halves of that invariant: the
 * default in the script, the mkdir that makes the default writable, and the
 * .gitignore entry that keeps it untracked.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = readFileSync(
  path.join(SERVER_ROOT, 'scripts', 'reconcile-roosync-channel.mjs'),
  'utf-8'
);
const GITIGNORE = readFileSync(path.join(SERVER_ROOT, '.gitignore'), 'utf-8');

describe('reconcile-roosync-channel manifest default (friction web2)', () => {
  test('default --manifest-dir resolves to scripts/manifests/, not the script dir', () => {
    expect(
      SCRIPT.includes(
        "const manifestDir = manifestDirIdx !== -1 ? args[manifestDirIdx + 1] : path.join(__dirname, 'manifests');"
      )
    ).toBe(true);
  });

  test('manifest dir is created before the write (first run on a fresh checkout must not ENOENT)', () => {
    expect(SCRIPT.includes('mkdirSync(manifestDir, { recursive: true });')).toBe(true);
  });

  test('the default dir is covered by .gitignore (dry-runs never dirty the checkout)', () => {
    const entries = GITIGNORE.split(/\r?\n/).map(l => l.trim());
    expect(entries).toContain('/scripts/manifests/');
  });

  test('usage documents the gitignored default (operators can discover the override)', () => {
    expect(SCRIPT.includes('--manifest-dir DIR')).toBe(true);
    expect(SCRIPT.includes('gitignored')).toBe(true);
  });
});
