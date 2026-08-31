#!/usr/bin/env node
/**
 * Canonical CI exclusion census for vitest.config.ci.ts (#3322).
 *
 * WHY: three documents disagreed on the CI exclusion count (29 vs 32 vs 33)
 * because every count was taken by hand. This script is THE canonical
 * measure: it parses the `exclude` array of vitest.config.ci.ts and
 * classifies every active entry.
 *
 * Canonical units (#3322 decision):
 *   - "test-file entries"    : explicit exclusion entries matching *.test.* / *.spec.*
 *   - "tests-directory globs": globs rooted under tests/ (archives, eval-harness, e2e)
 *   - "structural entries"   : build-artifact/dir hygiene globs (node_modules, build,
 *                              dist, backups) — NOT test exclusions
 *
 * Usage (from servers/roo-state-manager):
 *   node scripts/count-ci-exclusions.mjs           # human report; exit 1 on header drift or ghost entry
 *   node scripts/count-ci-exclusions.mjs --json    # machine-readable (same exit codes)
 *   node scripts/count-ci-exclusions.mjs --collect # + effective measure (vitest list diff;
 *                                                   # slow, requires node_modules installed)
 *
 * Drift-guard twin: tests/unit/ci-exclusion-drift-guard.test.ts — FAILS in CI
 * when the header counts no longer match this script's parse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'vitest.config.ci.ts');

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const HEADER_RE = /(\d+)\s+test-file entr(?:y|ies)\s*\+\s*(\d+)\s+tests-directory globs/;
const AUDIT_RE = /Last audit:\s*(\d{4}-\d{2}-\d{2})\s*\(#(\d+)\)/;

/**
 * Parse the exclude array of vitest.config.ci.ts.
 * Active entries = quoted strings on non-comment lines.
 */
export function parseCiExclusions(configPath = CONFIG) {
  const src = fs.readFileSync(configPath, 'utf8');
  const arr = src.match(/exclude:\s*\[([\s\S]*?)\]/);
  if (!arr) throw new Error('exclude array not found in vitest.config.ci.ts');

  const active = [];
  for (const line of arr[1].split('\n')) {
    const t = line.trim();
    if (t.startsWith('//')) continue;
    const m = t.match(/^'([^']+)'/);
    if (m) active.push(m[1]);
  }

  const testFileEntries = active.filter((e) => TEST_FILE_RE.test(e));
  const dirGlobEntries = active.filter(
    (e) => !TEST_FILE_RE.test(e) && e.startsWith('tests/') && e.endsWith('/**')
  );
  const structuralEntries = active.filter(
    (e) => !TEST_FILE_RE.test(e) && !dirGlobEntries.includes(e)
  );
  const ghostEntries = testFileEntries.filter((e) => !fs.existsSync(path.join(ROOT, e)));

  const headerCounts = parseHeaderCounts(src);
  return {
    totalActive: active.length,
    testFileEntries,
    dirGlobEntries,
    structuralEntries,
    ghostEntries,
    headerCounts,
  };
}

/** Extract the declared counts from the config header comment. */
export function parseHeaderCounts(src = fs.readFileSync(CONFIG, 'utf8')) {
  const m = src.match(HEADER_RE);
  if (!m) return null;
  return { testFiles: Number(m[1]), dirGlobs: Number(m[2]) };
}

/** Effective measure: files/tests collected by unit config but not by CI. */
function collectEffective() {
  const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const list = (config) =>
    execFileSync(
      process.execPath,
      [vitestBin, 'list', '--config', config],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const unit = list('vitest.config.unit.ts');
  const ci = list('vitest.config.ci.ts');
  const fileOf = (line) => line.split(' > ')[0];
  const unitFiles = new Set(unit.map(fileOf));
  const ciFiles = new Set(ci.map(fileOf));
  const deltaFiles = [...unitFiles].filter((f) => !ciFiles.has(f)).sort();
  const skippedTests = unit.length - ci.length;
  return {
    unitFiles: unitFiles.size,
    ciFiles: ciFiles.size,
    deltaFiles,
    skippedTests,
  };
}

function report({ json = false, collect = false } = {}) {
  const c = parseCiExclusions();
  const declared = { testFiles: c.testFileEntries.length, dirGlobs: c.dirGlobEntries.length };
  const drift =
    !c.headerCounts ||
    c.headerCounts.testFiles !== declared.testFiles ||
    c.headerCounts.dirGlobs !== declared.dirGlobs;
  const audit = fs.readFileSync(CONFIG, 'utf8').match(AUDIT_RE);
  const effective = collect ? collectEffective() : null;

  if (json) {
    console.log(
      JSON.stringify(
        {
          declared,
          structuralEntries: c.structuralEntries.length,
          totalActiveEntries: c.totalActive,
          headerCounts: c.headerCounts,
          headerDrift: drift,
          ghostEntries: c.ghostEntries,
          lastAudit: audit ? { date: audit[1], issue: `#${audit[2]}` } : null,
          effective,
        },
        null,
        2
      )
    );
  } else {
    console.log(`CI exclusion census — vitest.config.ci.ts`);
    console.log(`  test-file entries      : ${declared.testFiles}`);
    console.log(`  tests-directory globs  : ${declared.dirGlobs}`);
    console.log(`  structural entries     : ${c.structuralEntries.length} (not test exclusions)`);
    console.log(`  header declares        : ${c.headerCounts ? `${c.headerCounts.testFiles} + ${c.headerCounts.dirGlobs}` : 'NOT FOUND'}`);
    console.log(`  header drift           : ${drift ? 'YES — update the header' : 'none'}`);
    console.log(`  ghost entries          : ${c.ghostEntries.length}${c.ghostEntries.length ? ' ' + JSON.stringify(c.ghostEntries) : ''}`);
    if (audit) console.log(`  last audit             : ${audit[1]} (#${audit[2]})`);
    if (effective) {
      console.log(`  effective (vitest list diff, unit vs CI):`);
      console.log(`    files collected unit=${effective.unitFiles} ci=${effective.ciFiles}`);
      console.log(`    skipped in CI       : ${effective.deltaFiles.length} files / ${effective.skippedTests} tests`);
    }
  }
  const failed = drift || c.ghostEntries.length > 0;
  if (failed && !json) {
    console.error('\nFAIL: fix the header counts and/or remove ghost entries (see docs/CI-EXCLUSIONS-CENSUS.md).');
  }
  process.exit(failed ? 1 : 0);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--json') || args.includes('--collect')) {
    report({ json: args.includes('--json'), collect: args.includes('--collect') });
  } else {
    report({});
  }
}
