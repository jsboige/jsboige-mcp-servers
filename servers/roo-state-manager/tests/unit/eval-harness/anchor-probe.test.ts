/**
 * anchor-probe.test.ts — unit tests for probeAnchorState's anchor verdicts
 * (#2609 follow-up, ms#1497 review point 2).
 *
 * Lives under tests/unit/ so it runs under BOTH the unit and CI configs —
 * tests/eval-harness/** is CI-excluded, but the `relocatable ⇒ verified`
 * branch decides PASS/FAIL on the cadenced bench, so its contract must be
 * pinned in CI (same pattern as index-freshness / storm-guard tests).
 *
 * Unlike its siblings, anchor-probe.ts is not import-free: it touches fs
 * (loadLines) and Qdrant (readStoredChunks). The fs side runs against a real
 * temp file (no node:fs mock to leak into other suites); the Qdrant side is
 * injected as a plain fake — probeAnchorState takes the client as a
 * parameter, so no network is ever touched.
 *
 * @issue #2609 V2 follow-ups (ms#1497), Epic #2609 V2(a)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAnchorState } from '../../eval-harness/anchor-probe.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'anchor-probe-test-'));
afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** Current-file shape: the chunk's home block drifted from stored line 2 to ~line 12. */
const DRIFTED_FILE = [
	'const filler0 = 0;',
	'const filler1 = 1;', // stored (wrong) anchor line — the drift replaced it
	'const filler2 = 2;',
	'const filler3 = 3;',
	'const filler4 = 4;',
	'const filler5 = 5;',
	'const filler6 = 6;',
	'const filler7 = 7;',
	'const filler8 = 8;',
	'',
	'export async function searchSemantic(query: string): Promise<Result> {',
	'\tconst filter = buildFilterQuery(query);',
	'\tconst rows = await joinWithPostgres(filter);',
	'\treturn { rows, filter };',
	'}'
].join('\n');

const MULTI_LINE_CHUNK = [
	'export async function searchSemantic(query: string): Promise<Result> {',
	'\tconst filter = buildFilterQuery(query);',
	'\tconst rows = await joinWithPostgres(filter);'
].join('\n');

function writeCurrent(name: string, content: string): string {
	const abs = join(tmpRoot, name);
	writeFileSync(abs, content, 'utf-8');
	return abs;
}

/** Minimal fake of the Qdrant client: one scroll page, then `next_page_offset: null`. */
function fakeQdrant(points: any[]) {
	return {
		scroll: async () => ({ points, next_page_offset: null }),
	};
}

describe('probeAnchorState — anchor verdicts', () => {
	it('match_lines handle present → verified by construction, no probe', async () => {
		const probe = await probeAnchorState(
			{ file_path: 'never-read.ts', start_line: 3, match_lines: '3-17' },
			'/ws',
			fakeQdrant([]),
			'coll',
			new Map()
		);
		expect(probe.state).toBe('verified');
		expect(probe.detail).toContain('match_lines');
	});

	it('no numeric start_line → unverifiable (fail-closed)', async () => {
		const probe = await probeAnchorState({ file_path: 'x.ts' }, '/ws', fakeQdrant([]), 'coll', new Map());
		expect(probe.state).toBe('unverifiable');
	});

	it('stored anchor still verifies within ±5 → verified (not the relocation branch)', async () => {
		const abs = writeCurrent('still-verifies.ts', DRIFTED_FILE);
		const probe = await probeAnchorState(
			{ file_path: abs, start_line: 12 },
			'/ws',
			fakeQdrant([{ payload: { codeChunk: MULTI_LINE_CHUNK, startLine: 12, endLine: 14 } }]),
			'coll',
			new Map()
		);
		expect(probe.state).toBe('verified');
		expect(probe.detail).toContain('still verifies');
	});

	it('drifted anchor whose chunk head relocates uniquely → verified (the untested branch, ms#1497 point 2)', async () => {
		// Stored line 2, true head at line 11 (index 10): 9 lines of drift > ±5,
		// so verifyAnchor refuses — but the chunk head AND its second line exist
		// at the true position, so relocation succeeds and the failure is the
		// tool's, never excused as staleness.
		const abs = writeCurrent('relocatable.ts', DRIFTED_FILE);
		const probe = await probeAnchorState(
			{ file_path: abs, start_line: 2 },
			'/ws',
			fakeQdrant([{ payload: { codeChunk: MULTI_LINE_CHUNK, startLine: 2, endLine: 4 } }]),
			'coll',
			new Map()
		);
		expect(probe.state).toBe('verified');
		expect(probe.detail).toContain('relocates uniquely');
	});

	it('chunk text gone from the current file → stale (index drift)', async () => {
		// The whole home block was replaced by unrelated content: neither the
		// head nor any body line survives → relocation has nothing to find.
		const abs = writeCurrent('gone.ts', DRIFTED_FILE.replace(
			'export async function searchSemantic(query: string): Promise<Result> {\n\tconst filter = buildFilterQuery(query);\n\tconst rows = await joinWithPostgres(filter);',
			'export async function somethingElseEntirely(x: number): number {'
		));
		const probe = await probeAnchorState(
			{ file_path: abs, start_line: 2 },
			'/ws',
			fakeQdrant([{ payload: { codeChunk: MULTI_LINE_CHUNK, startLine: 2, endLine: 4 } }]),
			'coll',
			new Map()
		);
		expect(probe.state).toBe('stale');
		expect(probe.detail).toContain('index drift');
	});

	it('head-prefix survivor without corroboration → stale (relocation refuses, ms#1497 point 1 through the probe)', async () => {
		// Single-line chunk whose 40-char head survives on a DIFFERENT line that
		// diverges after the prefix: relocation must refuse (no corroboration),
		// so the probe classifies the hit as stale rather than excusing it.
		const head = 'const veryLongDeclarationName = computeSomeValue(argumentOne, arg';
		const abs = writeCurrent('prefix-survivor.ts', [
			'const filler0 = 0;',
			'const filler1 = 1;', // stored anchor position (index 1)
			'const filler2 = 2;',
			'const filler3 = 3;',
			'const filler4 = 4;',
			'const filler5 = 5;',
			'const filler6 = 6;',
			'const filler7 = 7;',
			head + 'umentTwo, 1234);' // index 8 — beyond ±5, shares the head, diverges after
		].join('\n'));
		const chunk = head + 'umentTwo, 5678);';
		const probe = await probeAnchorState(
			{ file_path: abs, start_line: 2 },
			'/ws',
			fakeQdrant([{ payload: { codeChunk: chunk, startLine: 2, endLine: 2 } }]),
			'coll',
			new Map()
		);
		expect(probe.state).toBe('stale');
	});
});
