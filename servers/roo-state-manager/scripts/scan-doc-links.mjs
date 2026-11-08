#!/usr/bin/env node
/**
 * scan-doc-links.mjs — inventory the health of relative links in repository
 * Markdown files (campaign #2639 / WS3, lot 1).
 *
 * Classes:
 *  - alive       : target resolves from the source file
 *  - dead        : target does not resolve (candidate for repoint/removal)
 *  - code_ref    : `file.ext:NNN` line references the instrument does NOT
 *                  control — frozen-tree sources, refs climbing out of the
 *                  root, or shapes it cannot parse. Never counted as dead.
 *  - code_ref_in_range (lot 3): the cited file exists AND every cited line
 *                  exists. "In range" means exactly that — it does NOT mean
 *                  the line still shows what the doc claims; a ref drifts
 *                  freely inside the file without leaving the range
 *                  (c.6721181082). Repairs re-point to a symbol, not a line.
 *  - code_ref_dead : FILE_MISSING | LINE_OUT_OF_RANGE | RANGE_INVALID —
 *                  candidates for the repair lot, never a gate flag.
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
 *   node scripts/scan-doc-links.mjs --root ../sk-agent   # scan another server
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, normalize } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// `--root <dir>` scans another server of the monorepo (lot 2: jupyter-papermill,
// sk-agent, jinavigator). Without it the instrument can only measure the server
// it ships in, and "0 dead links" elsewhere would be an unmeasured claim.
const rootArgIdx = process.argv.indexOf('--root');
const ROOT = rootArgIdx > -1 && process.argv[rootArgIdx + 1]
  ? resolve(process.argv[rootArgIdx + 1])
  : repoRoot;
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

/**
 * Drop code before matching. A fenced block or an inline span is CODE, not a
 * link — jinavigator's USAGE.md holds `dateRegex = /\b(202\d)[-\/](0[1-9]|1[0-2]).../`
 * and the bare `[1-9](0[1-9]|1[0-2])` shape read as a markdown link, reporting
 * two dead targets in a file that has none. An unclosed fence is left alone on
 * purpose: the failure mode we accept is a reported false positive, never a
 * real dead link silently hidden.
 */
function stripCode(text) {
  const withoutFences = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  // Inline spans too. A link whose TEXT is backticked (`[`x`](y)`) survives:
  // only the span is blanked, the `](y)` after it is outside the span.
  return withoutFences.replace(/`[^`\n]*`/g, '');
}

/**
 * Lot 3 — control the `path:line[-line]` shape instead of only counting it.
 * `in_range` says the file exists and the cited lines exist, nothing more:
 * a ref drifts freely inside the file without ever leaving the range, so a
 * later repair must re-point to a symbol, never to a bare line (c.6721181082).
 */
function checkCodeRef(fromDir, href) {
  const m = href.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!m) return { cls: 'code_ref', reason: 'unparsed' };
  const abs = resolve(fromDir, m[1]);
  if (relative(ROOT, abs).startsWith('..')) return { cls: 'code_ref', reason: 'cross_root' };
  if (!existsSync(normalize(abs))) return { cls: 'code_ref_dead', reason: 'FILE_MISSING' };
  if (!statSync(normalize(abs)).isFile()) return { cls: 'code_ref', reason: 'not_a_file' };
  const lineCount = readFileSync(abs, 'utf8').replace(/\n$/, '').split('\n').length;
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start > lineCount) return { cls: 'code_ref_dead', reason: 'LINE_OUT_OF_RANGE' };
  if (end < start || end > lineCount) return { cls: 'code_ref_dead', reason: 'RANGE_INVALID' };
  return { cls: 'code_ref_in_range' };
}

const links = [];
for (const file of walk(ROOT)) {
  const rel = repoRel(file);
  const frozen = FROZEN_PREFIXES.some((pre) => rel.startsWith(pre));
  const text = stripCode(readFileSync(file, 'utf8'));
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const href = m[2].trim();
    if (EXTERNAL_RE.test(href)) continue;
    if (CODE_REF_RE.test(href)) {
      // Frozen first (c.6719230995 §3): a point-in-time report cites the
      // lines of its era — freezing is correct, not a bypass. Never controlled.
      if (frozen) {
        links.push({ file: rel, href, cls: 'code_ref', frozen });
        continue;
      }
      const verdict = checkCodeRef(dirname(file), href);
      links.push({ file: rel, href, cls: verdict.cls, reason: verdict.reason, frozen });
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
const codeRefDead = links.filter((l) => l.cls === 'code_ref_dead');
const totals = {
  alive: count('alive', false) + count('alive', true),
  dead_active: deadActive.length,
  dead_frozen: deadFrozen.length,
  code_ref: links.filter((l) => l.cls === 'code_ref').length,
  code_ref_in_range: links.filter((l) => l.cls === 'code_ref_in_range').length,
  code_ref_dead: codeRefDead.length,
  cross_repo: links.filter((l) => l.cls === 'cross_repo').length,
};

if (asJson) {
  console.log(JSON.stringify({
    root: repoRel(ROOT),
    totals,
    links,
  }, null, 2));
} else {
  console.log(`doc links — alive=${totals.alive} dead_active=${totals.dead_active} dead_frozen=${totals.dead_frozen} code_ref=${totals.code_ref} (uncontrolled) code_ref_in_range=${totals.code_ref_in_range} code_ref_dead=${totals.code_ref_dead} cross_repo=${totals.cross_repo}`);
  console.log(`(frozen trees ${includeFrozen ? 'included' : 'excluded from dead count'}; cross-repo and code refs never counted dead)`);
  if (deadActive.length) {
    console.log('\nactive dead links:');
    for (const l of deadActive) console.log(`  ${l.file} :: ${l.href}`);
  }
  if (codeRefDead.length) {
    console.log('\ncode refs dead (repair-lot candidates, not a gate):');
    for (const l of codeRefDead) console.log(`  ${l.file} :: ${l.href} [${l.reason}]`);
  }
}

if (failOnDead && deadActive.length > 0) process.exit(1);
