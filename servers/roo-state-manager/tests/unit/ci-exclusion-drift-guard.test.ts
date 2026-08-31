/**
 * CI exclusion drift-guard (#3322) — twin of scripts/count-ci-exclusions.mjs.
 *
 * FAILS when:
 *  - the exclusion counts declared in the vitest.config.ci.ts header no longer
 *    match the actual entries (someone added/removed an exclusion without
 *    re-dating the census header), or
 *  - an excluded test file no longer exists on disk (ghost entry), or
 *  - the server README table drifted from the config.
 *
 * After touching the exclude array: re-run
 *   node scripts/count-ci-exclusions.mjs
 * and update the header + README + docs/CI-EXCLUSIONS-CENSUS.md.
 *
 * Pattern: detailLevel drift-guard (#3196).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCiExclusions } from '../../scripts/count-ci-exclusions.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const README = path.join(ROOT, 'README.md');

describe('CI exclusion drift-guard (#3322)', () => {
  const census = parseCiExclusions();

  it('header census counts match the actual exclude entries', () => {
    expect(census.headerCounts, 'header "N test-file entries + N tests-directory globs" is stale — re-run scripts/count-ci-exclusions.mjs and update the header')
      .toEqual({ testFiles: census.testFileEntries.length, dirGlobs: census.dirGlobEntries.length });
  });

  it('no ghost entries (excluded test files must exist on disk)', () => {
    expect(census.ghostEntries, 'exclude entries point at deleted files — remove them (proof: git log --diff-filter=D)').toEqual([]);
  });

  it('header carries a dated audit reference', () => {
    const header = readFileSync(path.join(ROOT, 'vitest.config.ci.ts'), 'utf8');
    expect(header).toMatch(/Last audit:\s*\d{4}-\d{2}-\d{2}\s*\(#\d+\)/);
  });

  it('README "Two Vitest configs" table carries the same declared count', () => {
    const readme = readFileSync(README, 'utf8');
    const m = readme.match(/(\d+)\s+declared test-file exclusions/);
    expect(m, 'README must state "<N> declared test-file exclusions" in the Two Vitest configs table').not.toBeNull();
    expect(Number(m![1])).toBe(census.testFileEntries.length);
  });
});
