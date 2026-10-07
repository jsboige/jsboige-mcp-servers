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
import { parseCiExclusions, parseExcludeSrc } from '../../scripts/count-ci-exclusions.mjs';

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

describe('exclude parser behavior (W2, #2639 — balanced brackets, no writing convention)', () => {
  it('survives a glob character class containing brackets', () => {
    // A lazy `\[(.*?)\]` would close the array at the `]` inside `foo[0-9]`.
    const src = `test: { exclude: [\n  'foo[0-9]*.test.ts',\n  'plain.test.ts',\n] }`;
    expect(parseExcludeSrc(src)).toEqual(['foo[0-9]*.test.ts', 'plain.test.ts']);
  });

  it('is layout-independent: shared lines, leading commas, double quotes', () => {
    const src = `test: { exclude: [ 'a.test.ts', "b.test.ts" , 'tests/e2e/**' ] }`;
    expect(parseExcludeSrc(src)).toEqual(['a.test.ts', 'b.test.ts', 'tests/e2e/**']);
  });

  it('ignores // comments even when they carry quotes or brackets', () => {
    const src = [
      'test: { exclude: [',
      "  'kept.test.ts',",
      "  // commented 'dropped.test.ts' with ] bracket",
      "  'also-kept.test.ts',",
      '] }',
    ].join('\n');
    expect(parseExcludeSrc(src)).toEqual(['kept.test.ts', 'also-kept.test.ts']);
  });

  it('does not treat a quoted // as a comment, nor a quote inside a comment as a string opener', () => {
    const src = `test: { exclude: [ 'https://x/y.test.ts', 'z.test.ts' ] }`;
    expect(parseExcludeSrc(src)).toEqual(['https://x/y.test.ts', 'z.test.ts']);
  });

  it('throws on unbalanced brackets instead of silently truncating', () => {
    const src = `test: { exclude: [ 'a.test.ts', /* never closed`;
    expect(() => parseExcludeSrc(src)).toThrow(/unbalanced/i);
  });
});
