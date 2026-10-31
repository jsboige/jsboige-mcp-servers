/**
 * index-coverage.ts — "is the known answer even IN the index?" probe for the
 * V2 block-granularity scenario (Epic #2609, q3).
 *
 * Why this exists (measured po-2023, 2026-10-31): the scenario's known answer
 * is the Postgres JOIN block of `search-semantic.tool.ts` (the query asks
 * where that JOIN lives). On this seat the `ws-*` code index holds 388 chunks
 * for that file whose highest startLine is 1325 / endLine 1343, while the
 * file is 1872 lines and the `joinFromQdrant(` call sits at line 1627 — the
 * answer region was never indexed. No ranking can return a block the index
 * does not hold, so the run went red for an INDEX CONTENT reason and the
 * verdict blamed the V2 render contract.
 *
 * This is the same class as the stale-anchor lever of #4105, one shape
 * further: stale-anchor covers "chunk exists, anchor drifted"; this covers
 * "the answer region is beyond the indexed tail" (or the file is not indexed
 * at all). Both are index content, neither is a render regression.
 *
 * Garde-fous (contract of this module):
 *   1. `gap` requires a MEASURED position: the needed line must sit beyond
 *      the highest line the index actually holds for THAT file. A file whose
 *      coverage reaches the needed line reads `covered` — a failing gate then
 *      stays a FAIL (ranking/render), never excused.
 *   2. Anything the probe cannot establish (no Qdrant client, no collection,
 *      scroll failure, unreadable current file, chunks without line fields)
 *      reads `unverifiable` — fail-closed, never excused.
 *   3. Coverage is logged on every run, whatever the verdict: an index that
 *      stopped growing must never go silent behind a green suite.
 *
 * The decision is pure (classifyIndexCoverage) so CI pins it with unit tests;
 * only the scroll side touches Qdrant (same split as index-freshness.ts).
 *
 * @issue Epic #2609 q3 (dispatch deepqueue-20261031b)
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getQdrantClient } from '../../src/services/qdrant.js';

export type CoverageVerdict = 'covered' | 'gap' | 'unverifiable';

export interface CoverageInput {
	/** chunks the index holds for this exact file (0 = file not indexed at all) */
	indexedChunks: number;
	/** highest endLine among those chunks (null when none carries line fields) */
	maxIndexedEnd: number | null;
	/** first line of the known-answer region in the CURRENT file */
	neededStart: number;
	/** last line of the known-answer region in the CURRENT file */
	neededEnd: number;
	/** current file length on disk (null when unreadable) */
	currentLines: number | null;
}

/**
 * Decide whether the known-answer region can be served by this index.
 *
 * - current file unreadable, or chunks carry no line fields → `unverifiable`
 * - the region starts beyond the indexed tail (or nothing is indexed) → `gap`
 * - otherwise → `covered` (a red gate is then the scenario's own business)
 */
export function classifyIndexCoverage(input: CoverageInput): CoverageVerdict {
	if (input.currentLines === null || input.currentLines <= 0) return 'unverifiable';
	if (input.neededStart <= 0 || input.neededEnd < input.neededStart) return 'unverifiable';
	if (input.indexedChunks === 0) return 'gap';
	if (input.maxIndexedEnd === null) return 'unverifiable';
	// Boundary: a region whose first line is still inside the indexed tail is
	// NOT a coverage gap — the index can answer it (possibly badly, which the
	// scenario must keep catching). `>` not `>=` on purpose.
	return input.neededStart > input.maxIndexedEnd ? 'gap' : 'covered';
}

export interface CoverageReport {
	verdict: CoverageVerdict;
	indexedChunks: number;
	maxIndexedEnd: number | null;
	neededStart: number;
	neededEnd: number;
	currentLines: number | null;
	/** human-readable cause, always set */
	reason: string;
	/** one-line summary for the run log (garde-fou 3) */
	line: string;
}

export interface CoverageProbeArgs {
	/** checkout the harness runs from (resolveScenarioWorkspace) */
	workspace: string;
	/** workspace-relative path of the known-answer file, as the tool renders it */
	relPath: string;
	/** known-answer region in the CURRENT file */
	neededStart: number;
	neededEnd: number;
	/** collection the response named (null = the run cannot be probed) */
	collection: string | null | undefined;
}

/**
 * Both separator spellings the index may hold for one logical path.
 *
 * Measured po-2023 2026-10-31: the `ws-*` payload stores `filePath` with
 * BACKSLASHES (`mcps\internal\servers\…`). Deriving the variants from the
 * caller's own spelling alone (`relPath` was written with forward slashes)
 * deduped to a single forward-slash probe, the scroll returned zero chunks,
 * and the probe reported a coverage GAP for a file the index actually held
 * 388 chunks for — a false gap would excuse the gate for the wrong reason.
 */
export function filePathSpellings(relPath: string): string[] {
	const forward = relPath.replace(/\\/g, '/');
	const backslash = forward.replace(/\//g, '\\');
	return Array.from(new Set([forward, backslash]));
}

function countLines(abs: string): number | null {
	try {
		if (!existsSync(abs)) return null;
		return readFileSync(abs, 'utf8').split(/\r?\n/).length;
	} catch {
		return null;
	}
}

/** Scroll every chunk the index holds for one filePath spelling. */
async function scrollFileChunks(qdrant: any, collection: string, filePath: string): Promise<any[]> {
	const points: any[] = [];
	let offset: any = undefined;
	for (let page = 0; page < 10; page++) {
		const result: any = await qdrant.scroll(collection, {
			filter: { must: [{ key: 'filePath', match: { value: filePath } }] },
			limit: 200,
			...(offset !== undefined && offset !== null ? { offset } : {}),
			with_payload: true,
			with_vector: false,
		});
		const batch = result?.points || result?.result?.points || [];
		points.push(...batch);
		offset = result?.next_page_offset ?? result?.result?.next_page_offset ?? null;
		if (offset === null || offset === undefined) break;
	}
	return points;
}

/**
 * Measure the index's coverage of the known-answer file and classify it.
 * Never throws: every failure mode lands in an `unverifiable` report.
 */
export async function probeKnownAnswerCoverage(args: CoverageProbeArgs): Promise<CoverageReport> {
	const abs = isAbsolute(args.relPath) ? args.relPath : join(args.workspace, args.relPath);
	const currentLines = countLines(abs);
	const base: Omit<CoverageReport, 'verdict' | 'reason' | 'line'> = {
		indexedChunks: 0,
		maxIndexedEnd: null,
		neededStart: args.neededStart,
		neededEnd: args.neededEnd,
		currentLines,
	};
	const make = (verdict: CoverageVerdict, reason: string): CoverageReport => ({
		...base,
		verdict,
		reason,
		line: `index coverage ${args.relPath}: ${verdict} — ${reason}`,
	});

	if (currentLines === null) return make('unverifiable', 'current file unreadable — coverage cannot be compared');
	if (!args.collection) return make('unverifiable', 'the response names no collection — coverage cannot be measured');

	let qdrant: any;
	try {
		qdrant = getQdrantClient();
	} catch (err) {
		return make('unverifiable', `qdrant client unavailable: ${(err as Error).message}`);
	}

	// The index hashes neither the separator nor the case of what it stores;
	// both spellings are scrolled and deduped by segment hash when present.
	const spellings = filePathSpellings(args.relPath);
	let chunks: any[] = [];
	try {
		for (const spelling of spellings) {
			chunks = chunks.concat(await scrollFileChunks(qdrant, String(args.collection), spelling));
		}
	} catch (err) {
		return make('unverifiable', `coverage scroll failed: ${(err as Error).message}`);
	}

	const seen = new Set<string>();
	const unique = chunks.filter(p => {
		const key = String(p?.id ?? p?.payload?.segmentHash ?? '');
		if (!key) return true;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const ends = unique
		.map(p => (typeof p?.payload?.endLine === 'number' ? p.payload.endLine : null))
		.filter((v): v is number => v !== null);
	const maxIndexedEnd = ends.length ? Math.max(...ends) : null;
	base.indexedChunks = unique.length;
	base.maxIndexedEnd = maxIndexedEnd;

	// Instrument integrity (measured po-2023 2026-10-31): the same scroll read
	// 388 chunks / max endLine 1343 through a direct REST call while the client
	// path reported 382 / 1837 on this collection. Whichever side is right, a
	// probe that cannot prove its points belong to the requested file must not
	// decide a verdict — so every returned payload is checked against the
	// normalized target path and any foreign point reads `unverifiable`.
	const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
	const wanted = normalize(args.relPath);
	const foreign = unique
		.map(p => String(p?.payload?.filePath ?? ''))
		.filter(fp => fp && normalize(fp) !== wanted);
	if (foreign.length > 0) {
		const sample = Array.from(new Set(foreign)).slice(0, 3).join(' | ');
		return make(
			'unverifiable',
			`the scroll returned ${foreign.length} point(s) outside the requested file (${sample}) — the file filter did not hold, coverage cannot be read from this response`
		);
	}

	if (unique.length === 0) {
		return make('gap', `the index holds no chunk for this file — the known answer cannot be returned by any query`);
	}
	if (maxIndexedEnd !== null && maxIndexedEnd < args.neededStart) {
		return make(
			'gap',
			`index stops at line ${maxIndexedEnd} (${unique.length} chunks) but the known answer starts at line ${args.neededStart} of ${currentLines} — the answer region was never indexed`
		);
	}
	return make(
		'covered',
		`index reaches line ${maxIndexedEnd ?? 'n/a'} (${unique.length} chunks) and covers the known answer at ${args.neededStart}-${args.neededEnd} — a red gate is the scenario's own verdict`
	);
}
