#!/usr/bin/env node
/**
 * scan-doc-links.mjs — inventory the health of relative links in repository
 * Markdown files (campaign #2639 / WS3, lot 1).
 *
 * Classes:
 *  - alive       : target resolves from the source file
 *  - dead        : target does not resolve (candidate for repoint/removal)
 *  - code_ref    : `file.ext:NNN` line references — drift with code, treated
 *                  as a separate class (lot 3), never counted as dead
 *  - cross_repo  : href climbs out of the repository root (submodule pointing
 *                  at the parent checkout) — unverifiable in the standalone
 *                  repo, reported separately, never counted as dead
 *
 * Scope:
 *  - frozen trees (point-in-time reports) are reported but excluded from the
 *    default dead count unless --include-frozen: docs/reports/, docs/suivi/,
 *    docs/archives/, docs/consolidated/, docs/fixes/
 *
 * Usage:
 *   node scripts/scan-doc-links.mjs                 # human summary
 *   node scripts/scan-doc-links.mjs --json          # machine-readable
 *   node scripts/scan-doc-links.mjs --fail-on-dead  # exit 1 if any active dead
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, normalize } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SKIP_DIRS = new Set(['node_modules', '.git', '__test-data__', 'build', 'build-out', 'temp', 'outputs', 'exports']);
const FROZEN_PREFIXES = ['docs/reports/', 'docs/suivi/', 'docs/archives/', 'docs/consolidated/', 'docs/fixes/'];
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const EXTERNAL_RE = /^(https?:|#|mailto:|data:)/;
const CODE_REF_RE = /\.(ts|js|mjs|cjs|py|ps1|json|yml|yaml|sh|sql|cjs):\d+/;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const failOnDead = args.includes('--fail-on-dead');
const includeFrozen = args.includes('--include-frozen');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('build-')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function repoRel(p) {
  return relative(ROOT, p).split('\\').join('/');
}

const links = [];
for (const file of walk(ROOT)) {
  const rel = repoRel(file);
  const frozen = FROZEN_PREFIXES.some((pre) => rel.startsWith(pre));
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const href = m[2].trim();
    if (EXTERNAL_RE.test(href)) continue;
    if (CODE_REF_RE.test(href)) {
      links.push({ file: rel, href, cls: 'code_ref', frozen });
      continue;
    }
    const target = href.split('#')[0];
    if (!target) continue;
    const abs = resolve(dirname(file), target);
    // Cross-repo: normalized relative path escapes the repo root.
    const relTarget = relative(ROOT, abs);
    const climbsOut = relTarget.startsWith('..');
    if (climbsOut) {
      links.push({ file: rel, href, cls: 'cross_repo', frozen });
      continue;
    }
    const alive = existsSync(normalize(abs)) && statSync(normalize(abs)) !== undefined;
    links.push({ file: rel, href, cls: alive ? 'alive' : 'dead', frozen });
  }
}

const count = (cls, frozen) => links.filter((l) => l.cls === cls && l.frozen === frozen).length;
const deadActive = links.filter((l) => l.cls === 'dead' && !l.frozen);
const deadFrozen = links.filter((l) => l.cls === 'dead' && l.frozen);

if (asJson) {
  console.log(JSON.stringify({
    root: repoRel(ROOT),
    totals: {
      alive: count('alive', false) + count('alive', true),
      dead_active: deadActive.length,
      dead_frozen: deadFrozen.length,
      code_ref: links.filter((l) => l.cls === 'code_ref').length,
      cross_repo: links.filter((l) => l.cls === 'cross_repo').length,
    },
    links,
  }, null, 2));
} else {
  const totals = {
    alive: count('alive', false) + count('alive', true),
    dead_active: deadActive.length,
    dead_frozen: deadFrozen.length,
    code_ref: links.filter((l) => l.cls === 'code_ref').length,
    cross_repo: links.filter((l) => l.cls === 'cross_repo').length,
  };
  console.log(`doc links — alive=${totals.alive} dead_active=${totals.dead_active} dead_frozen=${totals.dead_frozen} code_ref=${totals.code_ref} cross_repo=${totals.cross_repo}`);
  console.log(`(frozen trees ${includeFrozen ? 'included' : 'excluded from dead count'}; cross-repo and code refs never counted dead)`);
  if (deadActive.length) {
    console.log('\nactive dead links:');
    for (const l of deadActive) console.log(`  ${l.file} :: ${l.href}`);
  }
}

if (failOnDead && deadActive.length > 0) process.exit(1);
