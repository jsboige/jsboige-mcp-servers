/**
 * index-freshness.test.ts — unit tests for the stale-anchor verdict contract
 * (#4105 levier 2, GO ai-01 2026-10-15 04:57Z — one test per mandated case).
 *
 * Lives under tests/unit/ so it runs under BOTH the unit and CI configs —
 * tests/eval-harness/** is CI-excluded, but this module is import-free and
 * pure, so the split lets the verdict contract be pinned in CI (same pattern
 * as storm-guard-classification.test.ts).
 *
 * Mandated cases (ai-01 decision):
 *   - valid anchor + single-line hit → FAIL
 *   - all hits stale-anchor → INCONCLUSIVE
 *   - mixed run with one healthy valid-anchor hit → PASS
 *
 * @issue #4105 (levier 2), Epic #2609 V2(a)
 */

import { describe, it, expect } from 'vitest';
import {
	summarizeIndexFreshness,
	FRESHNESS_FILES_CAP,
	type HitFreshness,
} from '../../eval-harness/index-freshness.js';

const ok = (file_path: string, start_line?: number): HitFreshness =>
	({ file_path, start_line, structuralOk: true, anchor: 'verified' });
const stale = (file_path: string, start_line?: number): HitFreshness =>
	({ file_path, start_line, structuralOk: false, anchor: 'stale' });
/** structural failure with a verified anchor — the bug class garde-fou 1 must keep catching */
const broken = (file_path: string, start_line?: number): HitFreshness =>
	({ file_path, start_line, structuralOk: false, anchor: 'verified' });
/** structural failure the probe could not attribute — fail-closed, never excused */
const unverifiable = (file_path: string, start_line?: number): HitFreshness =>
	({ file_path, start_line, structuralOk: false, anchor: 'unverifiable' });

describe('summarizeIndexFreshness — the three mandated cases (garde-fou 2)', () => {
	it('valid anchor + single-line hit → FAIL (the bug the scenario must keep catching)', () => {
		const r = summarizeIndexFreshness([ok('src/a.ts', 10), broken('src/b.ts', 20)]);
		expect(r.verdict).toBe('fail');
		expect(r.broken).toEqual(['src/b.ts:20']);
	});

	it('all source-class hits stale-anchor → INCONCLUSIVE, never PASS', () => {
		const r = summarizeIndexFreshness([stale('src/a.ts', 10), stale('src/b.ts', 20)]);
		expect(r.verdict).toBe('inconclusive');
		expect(r.rendered).toBe(0);
		expect(r.stale).toBe(2);
	});

	it('mixed run with one healthy valid-anchor hit → PASS (stale hits recorded, not graded)', () => {
		const r = summarizeIndexFreshness([ok('src/a.ts', 10), stale('src/b.ts', 20), stale('src/c.ts', 30)]);
		expect(r.verdict).toBe('pass');
		expect(r.rendered).toBe(1);
		expect(r.stale).toBe(2);
		expect(r.broken).toEqual([]);
	});
});

describe('summarizeIndexFreshness — fail-closed boundaries', () => {
	it('an unverifiable anchor is never excused → FAIL', () => {
		const r = summarizeIndexFreshness([ok('src/a.ts', 10), unverifiable('src/b.ts', 20)]);
		expect(r.verdict).toBe('fail');
		expect(r.broken).toEqual(['src/b.ts:20']);
	});

	it('stale hits never mask a broken sibling (stale + verified failure) → FAIL', () => {
		const r = summarizeIndexFreshness([stale('src/a.ts', 10), broken('src/b.ts', 20), ok('src/c.ts', 30)]);
		expect(r.verdict).toBe('fail');
	});

	it('fail dominates inconclusive: broken hits and zero rendered → FAIL, not INCONCLUSIVE', () => {
		const r = summarizeIndexFreshness([unverifiable('src/a.ts', 10)]);
		expect(r.verdict).toBe('fail');
		expect(r.rendered).toBe(0);
	});

	it('zero source-class hits → INCONCLUSIVE, never PASS', () => {
		const r = summarizeIndexFreshness([]);
		expect(r.verdict).toBe('inconclusive');
		expect(r.total).toBe(0);
	});
});

describe('summarizeIndexFreshness — the freshness line (garde-fou 3)', () => {
	it('always reports N/M, with locations and a bounded file list', () => {
		const hits = [
			stale('a.ts', 1), stale('b.ts', 2), stale('c.ts', 3), stale('d.ts', 4),
			stale('e.ts', 5), ok('f.ts'),
		];
		expect(hits.length - 1).toBe(FRESHNESS_FILES_CAP + 1);
		const r = summarizeIndexFreshness(hits);
		expect(r.line).toBe('index freshness: 5/6 source-class hits stale-anchor (a.ts:1, b.ts:2, c.ts:3, d.ts:4, +1 more)');
	});

	it('reads 0/N on a healthy run — the line is never absent', () => {
		expect(summarizeIndexFreshness([ok('a.ts', 1)]).line).toBe('index freshness: 0/1 source-class hits stale-anchor');
	});

	it('omits the :line suffix when a stale hit carries no lines', () => {
		expect(summarizeIndexFreshness([stale('a.ts')]).line).toContain('(a.ts)');
	});
});