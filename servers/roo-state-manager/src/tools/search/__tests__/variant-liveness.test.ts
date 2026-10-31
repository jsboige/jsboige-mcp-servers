/**
 * variant-liveness.test.ts — pins WHICH collection the variant ladder serves
 * (Epic #2609 q3, dispatch deepqueue-20261031b).
 *
 * #4352 taught resolution to probe every spelling and serve the LARGEST. Measured
 * po-2023, 2026-10-31: that rule served the decaying twin — canonical
 * `ws-d2ffdbaa832aed16` (328 245 pts, 0.965 live, all-lowercase spelling) lost to
 * `ws-59e7574de63c6e62` (571 554 pts, 0.900 live, decommissioned `zoo-code` tree).
 * The discriminator these tests protect: liveliness must win when it can be
 * measured on ≥2 candidates, and #4352's points ranking must survive untouched
 * everywhere else — including the very case #4352 was written for, where the big
 * collection IS the live one.
 */

import { describe, it, expect } from 'vitest';
import {
	selectVariantCollection,
	resolveVariantLivenessTimeout,
	type VariantCandidate,
} from '../search-codebase.tool.js';

/** The two collections measured on po-2023 (2026-10-31). */
const CANONICAL: VariantCandidate = { name: 'ws-d2ffdbaa832aed16', points: 328245 };
const DECAYING_TWIN: VariantCandidate = { name: 'ws-59e7574de63c6e62', points: 571554 };

describe('selectVariantCollection', () => {
	it('serves the livelier collection over the larger decaying one (the measured po-2023 case)', () => {
		const sel = selectVariantCollection(
			[DECAYING_TWIN, CANONICAL],
			new Map([
				[DECAYING_TWIN.name, { ratio: 0.9, checked: 200 }],
				[CANONICAL.name, { ratio: 0.965, checked: 200 }],
			]));
		expect(sel?.candidate.name).toBe(CANONICAL.name);
		expect(sel?.basis).toBe('liveness');
		expect(sel?.flipped).toBe(true);
	});

	it('keeps #4352 behaviour when the largest collection is also the livelier one', () => {
		// #4352's founding case: a frozen 328k copy vs a live 486k one. Liveness and
		// points agree here, so the fix must not regress it.
		const frozen: VariantCandidate = { name: 'ws-frozen', points: 328000 };
		const live: VariantCandidate = { name: 'ws-live', points: 486000 };
		const sel = selectVariantCollection(
			[frozen, live],
			new Map([
				[frozen.name, { ratio: 0.42, checked: 200 }],
				[live.name, { ratio: 0.98, checked: 200 }],
			]));
		expect(sel?.candidate.name).toBe(live.name);
		expect(sel?.basis).toBe('liveness');
		expect(sel?.flipped).toBe(false);
	});

	it('falls back to the largest when no liveness map was measured (flag off, single variant)', () => {
		expect(selectVariantCollection([DECAYING_TWIN, CANONICAL], null)?.candidate.name).toBe(DECAYING_TWIN.name);
		expect(selectVariantCollection([DECAYING_TWIN, CANONICAL], undefined)?.candidate.name).toBe(DECAYING_TWIN.name);
		expect(selectVariantCollection([DECAYING_TWIN, CANONICAL], null)?.basis).toBe('points');
	});

	it('never flips on a single decidable candidate — one ratio is not a comparison', () => {
		const sel = selectVariantCollection(
			[DECAYING_TWIN, CANONICAL],
			new Map<string, { ratio: number; checked: number } | null>([
				[DECAYING_TWIN.name, null],
				[CANONICAL.name, { ratio: 1, checked: 200 }],
			]));
		expect(sel?.candidate.name).toBe(DECAYING_TWIN.name);
		expect(sel?.basis).toBe('points');
	});

	it('breaks an equal-liveness tie on points, keeping #4352 rule', () => {
		const sel = selectVariantCollection(
			[CANONICAL, DECAYING_TWIN],
			new Map([
				[CANONICAL.name, { ratio: 0.95, checked: 200 }],
				[DECAYING_TWIN.name, { ratio: 0.95, checked: 200 }],
			]));
		expect(sel?.candidate.name).toBe(DECAYING_TWIN.name);
		expect(sel?.flipped).toBe(false);
	});

	it('returns null when no variant exists', () => {
		expect(selectVariantCollection([], new Map())).toBeNull();
	});

	it('serves the small live canonical over TWO large decaying twins (the ≥3-variant case)', () => {
		// Review ms#1599 blocking hold 1 (measured by executing the shipped code): with a
		// top-2-by-points probe set, the two stale big twins are the only ones measured and
		// the live canonical is never probed while the response claims basis:'liveness'.
		// The probe now covers every existing variant — this pins the RULE on a complete map.
		const stale1: VariantCandidate = { name: 'ws-stale1', points: 900000 };
		const stale2: VariantCandidate = { name: 'ws-stale2', points: 800000 };
		const canonical: VariantCandidate = { name: 'ws-canonical', points: 328245 };
		const sel = selectVariantCollection(
			[stale1, stale2, canonical],
			new Map([
				[stale1.name, { ratio: 0.4, checked: 200 }],
				[stale2.name, { ratio: 0.45, checked: 200 }],
				[canonical.name, { ratio: 0.965, checked: 200 }],
			]));
		expect(sel?.candidate.name).toBe(canonical.name);
		expect(sel?.basis).toBe('liveness');
		expect(sel?.flipped).toBe(true);
	});
});

describe('resolveVariantLivenessTimeout', () => {
	it('defaults to 1500 ms when the env var is unset', () => {
		expect(resolveVariantLivenessTimeout(undefined)).toBe(1500);
	});

	it('falls back to 1500 ms on an invalid value — NaN would fire setTimeout at ~0 ms and silently disarm the rule', () => {
		// Review ms#1599 blocking hold 2: parseFloat('abc') = NaN, setTimeout(fn, NaN)
		// fires at ~0 ms, both probes read null, and the search falls back to points
		// ranking without a word. An env typo must never disable the preference.
		expect(resolveVariantLivenessTimeout('abc')).toBe(1500);
		expect(resolveVariantLivenessTimeout('')).toBe(1500);
	});

	it('rejects zero and negative bounds — a 0 ms bound disarms as surely as NaN', () => {
		expect(resolveVariantLivenessTimeout('0')).toBe(1500);
		expect(resolveVariantLivenessTimeout('-5')).toBe(1500);
	});

	it('accepts a positive finite override', () => {
		expect(resolveVariantLivenessTimeout('3000')).toBe(3000);
		expect(resolveVariantLivenessTimeout('0.5')).toBe(0.5);
	});
});
