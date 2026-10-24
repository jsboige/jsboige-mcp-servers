/**
 * anchor-probe.ts — live probe establishing each source-class hit's anchor
 * state for the freshness classification (#4105 levier 2, GO ai-01
 * 2026-10-15 04:57Z, garde-fou 1).
 *
 * The re-verification runs against the SAME inputs the tool had: the CURRENT
 * file on disk and the STORED chunk payload, scrolled back from the very
 * collection the response names (`parsed.collection`). It calls the tool's
 * exported `verifyAnchor` and `relocateAnchor` itself — the grading harness
 * must not take the tool's word for the cause: a self-reported "stale-anchor"
 * would let a real render regression hide behind it.
 *
 * Classification per hit (mirrors expandHitBlock's control flow):
 *   - match_lines handle present ⇒ expansion ran ⇒ its anchor gate passed by
 *     construction ⇒ 'verified', no probe (a structural failure on such a hit
 *     — e.g. a single-line rendered window — is a genuine bug → FAIL).
 *   - else: load the current file, scroll the stored chunk(s) for this
 *     file+startLine, and re-run verifyAnchor on each exact candidate. Any
 *     true ⇒ 'verified' — the tool's failure was elsewhere (env, range,
 *     render) and is never excused. All false: try relocateAnchor (mirrors
 *     the tool's drift step) — a unique content hit ⇒ 'verified' (the tool
 *     could have re-anchored; its failure is not index staleness), otherwise
 *     ⇒ 'stale' — the tool's expansion necessarily stopped at the anchor
 *     gate (same functions, same inputs).
 *   - anything the probe cannot establish (no numeric start_line, unreadable
 *     or oversized file, index holds no matching chunk, scroll failure) ⇒
 *     'unverifiable' — fail-closed, never excused.
 *
 * Not part of the pure contract module (index-freshness.ts): this file owns
 * the fs/Qdrant side, the unit tests pin the verdict rules on the pure side.
 *
 * @issue #4105 (levier 2), Epic #2609 V2(a)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { verifyAnchor, relocateAnchor } from '../../src/tools/search/search-codebase.tool.js';
import { getQdrantClient } from '../../src/services/qdrant.js';
import { summarizeIndexFreshness, type FreshnessReport, type HitFreshness } from './index-freshness.js';

// Mirrors BLOCK_EXPANSION_MAX_FILE_BYTES (search-codebase.tool.ts): the tool
// never expands a file past this cap, so the probe refuses to excuse one
// either — the non-expansion is the size guard, not index staleness.
const MAX_PROBE_FILE_BYTES = 2 * 1024 * 1024;

const HANDLE_RE = /^\d+(-\d+)?$/;

/** The subset of a codebase_search result the probe reads. */
export interface RawHit {
	file_path?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	snippet?: unknown;
	match_lines?: unknown;
}

/**
 * The scenario's structural rubrics, per hit (kept in sync with the block
 * contract in v2-block-granularity.eval.test.ts): multi-line block
 * (end > start), snippet ≥ 200 chars, match_lines handle present.
 */
export function structuralOk(hit: RawHit): boolean {
	return typeof hit.start_line === 'number'
		&& typeof hit.end_line === 'number'
		&& hit.end_line > hit.start_line
		&& typeof hit.snippet === 'string'
		&& hit.snippet.length >= 200
		&& typeof hit.match_lines === 'string'
		&& HANDLE_RE.test(hit.match_lines);
}

type LinesLoad =
	| { kind: 'ok'; lines: string[] }
	| { kind: 'missing' }
	| { kind: 'oversize' }
	| { kind: 'error' };

function loadLines(abs: string, cache: Map<string, LinesLoad>): LinesLoad {
	const cached = cache.get(abs);
	if (cached) return cached;
	let result: LinesLoad;
	try {
		if (!existsSync(abs)) result = { kind: 'missing' };
		else if (statSync(abs).size > MAX_PROBE_FILE_BYTES) result = { kind: 'oversize' };
		else result = { kind: 'ok', lines: readFileSync(abs, 'utf-8').split(/\r?\n/) };
	} catch {
		result = { kind: 'error' };
	}
	cache.set(abs, result);
	return result;
}

/** Scroll every stored chunk for (filePath, startLine). Bounded pagination — the two-key filter matches are few. */
async function readStoredChunks(
	qdrant: any,
	collection: string,
	filePath: string,
	startLine: number
): Promise<any[]> {
	const points: any[] = [];
	let offset: any = undefined;
	for (let page = 0; page < 10; page++) {
		const result: any = await qdrant.scroll(collection, {
			filter: {
				must: [
					{ key: 'filePath', match: { value: filePath } },
					{ key: 'startLine', match: { value: startLine } },
				],
			},
			limit: 100,
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

export interface AnchorProbe {
	state: 'verified' | 'stale' | 'unverifiable';
	detail: string;
}

/**
 * Establish one hit's anchor state. Only called for hits that FAILED
 * structurally — a structuralOk hit implied its verification via the handle.
 */
export async function probeAnchorState(
	hit: RawHit,
	workspace: string,
	qdrant: any,
	collection: string,
	fileCache: Map<string, LinesLoad>
): Promise<AnchorProbe> {
	const fp = String(hit.file_path ?? '');
	const s = hit.start_line;
	if (typeof s !== 'number') {
		return { state: 'unverifiable', detail: 'hit carries no numeric start_line — the anchor cannot be re-verified' };
	}
	if (typeof hit.match_lines === 'string' && HANDLE_RE.test(hit.match_lines)) {
		return { state: 'verified', detail: 'match_lines handle present — expansion ran, its anchor gate passed by construction' };
	}
	const abs = isAbsolute(fp) ? fp : join(workspace, fp);
	const load = loadLines(abs, fileCache);
	if (load.kind === 'missing') {
		return { state: 'stale', detail: 'indexed file no longer exists in the workspace (dead-path vector)' };
	}
	if (load.kind === 'oversize') {
		return { state: 'unverifiable', detail: `file exceeds the tool's ${MAX_PROBE_FILE_BYTES}-byte expansion cap` };
	}
	if (load.kind === 'error') {
		return { state: 'unverifiable', detail: 'current file unreadable — cannot re-verify the anchor' };
	}

	let stored: any[];
	try {
		stored = await readStoredChunks(qdrant, collection, fp, s);
	} catch (err) {
		return { state: 'unverifiable', detail: `stored-chunk scroll failed: ${(err as Error).message}` };
	}
	// Prefer the exact chunk (startLine AND endLine as rendered); fall back to
	// startLine-only when the index no longer holds the exact range.
	const e = hit.end_line;
	const exact = stored.filter(p => typeof e === 'number' && p?.payload?.endLine === e);
	const candidates = exact.length ? exact : stored;
	if (!candidates.length) {
		return { state: 'unverifiable', detail: `index holds no chunk for this file+startLine (${fp}:${s}) — the rendered hit cannot be re-verified` };
	}
	const verified = candidates.some(p => {
		const chunk = String(p?.payload?.codeChunk ?? '');
		return chunk.length > 0 && verifyAnchor(load.lines, s - 1, chunk);
	});
	if (verified) {
		return { state: 'verified', detail: 'stored anchor still verifies — the tool had everything needed to expand (its failure is not index staleness)' };
	}
	// Mirrors expandHitBlock's relocation step (#2609 V2 residual): a drifted
	// stored anchor whose chunk head still relocates by UNIQUE content match was
	// expandable — a structural failure on such a hit is the tool's, not the
	// index's, and must not be excused as staleness.
	const relocatable = candidates.some(p => {
		const chunk = String(p?.payload?.codeChunk ?? '');
		return chunk.length > 0 && relocateAnchor(load.lines, chunk) !== null;
	});
	return relocatable
		? { state: 'verified', detail: 'stored anchor drifted but the chunk head relocates uniquely — the tool had everything needed to expand (its failure is not index staleness)' }
		: { state: 'stale', detail: `stored anchor no longer verifies within ±5 lines of line ${s} and the chunk head no longer exists (or is ambiguous) in the current file (index drift)` };
}

export interface FreshnessAssessment {
	report: FreshnessReport;
	/** one line per non-rendered hit — cause detail for the run log */
	details: string[];
}

/**
 * Probe every structurally-failing source-class hit and decide the run
 * verdict (see index-freshness.ts for the verdict contract).
 */
export async function assessIndexFreshness(
	hits: RawHit[],
	workspace: string,
	collection: string | null | undefined
): Promise<FreshnessAssessment> {
	const inputs: HitFreshness[] = [];
	const details: string[] = [];
	const fileCache = new Map<string, LinesLoad>();
	let qdrant: any = null;
	let qdrantError = '';
	if (!collection) {
		qdrantError = 'the response names no collection — anchors cannot be re-verified';
	} else {
		try {
			qdrant = getQdrantClient();
		} catch (err) {
			qdrantError = `qdrant client unavailable: ${(err as Error).message}`;
		}
	}

	for (const hit of hits) {
		const fp = String(hit.file_path ?? '');
		const start_line = typeof hit.start_line === 'number' ? hit.start_line : undefined;
		if (structuralOk(hit)) {
			inputs.push({ file_path: fp, start_line, structuralOk: true, anchor: 'verified' });
			continue;
		}
		const probe = qdrant
			? await probeAnchorState(hit, workspace, qdrant, String(collection), fileCache)
			: { state: 'unverifiable' as const, detail: qdrantError };
		inputs.push({ file_path: fp, start_line, structuralOk: false, anchor: probe.state });
		details.push(`${fp}${start_line !== undefined ? `:${start_line}` : ''} → ${probe.state} — ${probe.detail}`);
	}

	return { report: summarizeIndexFreshness(inputs), details };
}