/**
 * index-coverage.test.ts — pins the coverage verdict contract of the V2
 * block-granularity scenario (Epic #2609 q3).
 *
 * The scalar these tests protect is the ONE that keeps the new lever honest:
 * a green/INCONCLUSIVE must never be reachable when the index CAN serve the
 * known answer. The discriminating case is the boundary one — `neededStart`
 * exactly at the indexed tail must read `covered`, so the classifier cannot
 * drift from `>` to `>=` and start excusing real ranking failures.
 *
 * Measured facts these fixtures encode (po-2023, 2026-10-31, collection
 * ws-d2ffdbaa832aed16): 388 chunks for `search-semantic.tool.ts`, highest
 * endLine 1343, file 1872 lines, `joinFromQdrant(` call at line 1627.
 */

import { describe, it, expect } from 'vitest';
import { classifyIndexCoverage, filePathSpellings, type CoverageInput } from '../../eval-harness/index-coverage.js';

const base: CoverageInput = {
	indexedChunks: 388,
	maxIndexedEnd: 1343,
	neededStart: 1627,
	neededEnd: 1627,
	currentLines: 1872,
};

describe('classifyIndexCoverage', () => {
	it('reads gap when the known answer sits beyond the indexed tail (the measured po-2023 case)', () => {
		expect(classifyIndexCoverage(base)).toBe('gap');
	});

	it('reads gap when nothing at all is indexed for the file', () => {
		expect(classifyIndexCoverage({ ...base, indexedChunks: 0, maxIndexedEnd: null })).toBe('gap');
	});

	it('reads covered when the indexed tail reaches the answer (boundary: neededStart === maxIndexedEnd)', () => {
		// The discriminator: `>=` instead of `>` here would excuse a real ranking
		// failure, so this case must stay covered.
		expect(classifyIndexCoverage({ ...base, maxIndexedEnd: 1627 })).toBe('covered');
	});

	it('reads gap one line past the tail — the boundary is not permissive', () => {
		expect(classifyIndexCoverage({ ...base, maxIndexedEnd: 1626 })).toBe('gap');
	});

	it('reads covered when the index covers the answer with room to spare', () => {
		expect(classifyIndexCoverage({ ...base, maxIndexedEnd: 1872 })).toBe('covered');
	});

	it('reads unverifiable when the current file cannot be measured', () => {
		expect(classifyIndexCoverage({ ...base, currentLines: null })).toBe('unverifiable');
		expect(classifyIndexCoverage({ ...base, currentLines: 0 })).toBe('unverifiable');
	});

	it('reads unverifiable when the known-answer line could not be located', () => {
		expect(classifyIndexCoverage({ ...base, neededStart: 0 })).toBe('unverifiable');
		expect(classifyIndexCoverage({ ...base, neededEnd: 10 })).toBe('unverifiable');
	});

	it('reads unverifiable when the chunks carry no line fields (never a silent gap)', () => {
		expect(classifyIndexCoverage({ ...base, maxIndexedEnd: null })).toBe('unverifiable');
	});

	it('never excuses a covered index: a red gate on covered coverage stays the scenario verdict', () => {
		const verdicts = [
			classifyIndexCoverage({ ...base, maxIndexedEnd: 1627 }),
			classifyIndexCoverage({ ...base, maxIndexedEnd: 1872 }),
		];
		expect(verdicts.every(v => v === 'covered')).toBe(true);
	});
});

describe('filePathSpellings', () => {
	it('scopes BOTH separator spellings from a forward-slash input (the measured false-gap bug)', () => {
		// Measured po-2023 2026-10-31: probing only the caller's spelling returned
		// zero chunks for a file the index held 388 chunks for — a false `gap`
		// that would have excused the JOIN gate for the wrong reason.
		expect(filePathSpellings('mcps/internal/src/a.ts')).toEqual(['mcps/internal/src/a.ts', 'mcps\\internal\\src\\a.ts']);
	});

	it('scopes both spellings from a backslash input too (symmetric, no duplicate)', () => {
		const out = filePathSpellings('mcps\\internal\\src\\a.ts');
		expect(out).toContain('mcps/internal/src/a.ts');
		expect(out).toContain('mcps\\internal\\src\\a.ts');
		expect(out.length).toBe(2);
	});
});
