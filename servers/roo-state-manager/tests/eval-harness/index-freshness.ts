/**
 * index-freshness.ts — per-hit stale-anchor classification for the V2
 * block-granularity scenario (#4105 levier 2, GO ai-01 2026-10-15 04:57Z).
 *
 * Why this exists: the scenario's hard rubrics (multi-line block, match_lines
 * handle) grade the V2 render contract, but they also go red when the LIVE
 * INDEX is stale — a stored chunk whose anchor drifted beyond the ±5-line
 * tolerance can never be expanded (verifyAnchor refuses by design), so the
 * tool honestly renders the stored fragment and the rubrics fail for an
 * index-content reason, not a V2 regression (measured po-2027, 2026-10-15:
 * 4 of 6 source-class hits at +18..+385 lines of drift). The rubric was
 * conflating "index périmé" with "bug du rendu V2".
 *
 * Coordinator garde-fous (all three are contracts of this module):
 *   1. classification is PER HIT — a hit is `stale-anchor` only when the
 *      re-verification of ITS anchor fails in the current file. Any hit with
 *      a VALID anchor that still renders single-line or without a handle
 *      stays a FAIL (that is the bug the scenario must keep catching).
 *   2. verdict `INCONCLUSIVE (stale-anchor)` only when no valid-anchor hit
 *      fails AND the stale hits are the sole cause of the red rubrics. Zero
 *      valid-anchor hits in a run reads INCONCLUSIVE, never PASS.
 *   3. staleness stays VISIBLE — the run always logs `index freshness: N/M
 *      source-class hits stale-anchor (…)`, whatever the verdict: without it,
 *      index drift would go silent behind a green run.
 *
 * This module is pure (no fs, no Qdrant): the caller probes each hit's anchor
 * against the current file + the stored chunk and passes the state in — the
 * same split as storm-guard-classification.ts, so the verdict contract is
 * pinned by unit tests under CI (tests/eval-harness/** is CI-excluded).
 *
 * @issue #4105 (levier 2), Epic #2609 V2(a)
 */

/** Per-hit anchor state, established by the caller's probe (anchor-probe.ts). */
export type AnchorState =
	/** the stored anchor still verifies in the current file — or the hit was expanded,
	 * which implies verification (a match_lines handle is only set on the expanded branch) */
	| 'verified'
	/** the stored anchor no longer verifies (drift, dead-path file, position out of
	 * range) — index staleness, not a render regression */
	| 'stale'
	/** the probe could not establish either way — never excused (fail-closed) */
	| 'unverifiable';

export interface HitFreshness {
	/** workspace-relative or absolute path, as returned by the tool */
	file_path: string;
	/** 1-based stored/rendered start line, for the log line (optional — a hit may carry no lines) */
	start_line?: number;
	/** the hit's structural rubrics all pass: multi-line block (end > start), snippet ≥ 200 chars, match_lines handle */
	structuralOk: boolean;
	/** anchor state; callers set 'verified' for structuralOk hits (handle ⇒ expansion ⇒ anchor verified) */
	anchor: AnchorState;
}

export type FreshnessVerdict = 'pass' | 'inconclusive' | 'fail';

export interface FreshnessReport {
	total: number;
	/** structuralOk hits — the valid-anchor population the contract is graded on */
	rendered: number;
	/** structural failures PROVEN stale-anchor (index content, not a render bug) */
	stale: number;
	/** structural failures NOT explained by staleness (verified-anchor bugs + unverifiable probes) — garde-fou 1 */
	broken: string[];
	verdict: FreshnessVerdict;
	/** garde-fou 3 — always logged by the run, whatever the verdict */
	line: string;
}

/** Cap on locations listed in the freshness line (the count keeps the rest). */
export const FRESHNESS_FILES_CAP = 4;

/**
 * Decide the run verdict from the per-hit freshness inputs.
 *
 * Garde-fou 2 mapping: `fail` when any valid-anchor hit fails (broken > 0);
 * `inconclusive` when nothing is broken but no valid-anchor hit exists
 * (rendered === 0 — every failing hit is proven stale, so the V2 contract is
 * unmeasured, never PASS); `pass` otherwise.
 */
export function summarizeIndexFreshness(hits: HitFreshness[]): FreshnessReport {
	const rendered = hits.filter(h => h.structuralOk);
	const stale = hits.filter(h => !h.structuralOk && h.anchor === 'stale');
	const broken = hits.filter(h => !h.structuralOk && h.anchor !== 'stale');

	const verdict: FreshnessVerdict = broken.length > 0
		? 'fail'
		: rendered.length === 0
			? 'inconclusive'
			: 'pass';

	const loc = (h: HitFreshness) => h.start_line !== undefined ? `${h.file_path}:${h.start_line}` : h.file_path;
	const listed = stale.slice(0, FRESHNESS_FILES_CAP).map(loc).join(', ');
	const more = stale.length > FRESHNESS_FILES_CAP ? `, +${stale.length - FRESHNESS_FILES_CAP} more` : '';
	const line = `index freshness: ${stale.length}/${hits.length} source-class hits stale-anchor`
		+ (stale.length ? ` (${listed}${more})` : '');

	return { total: hits.length, rendered: rendered.length, stale: stale.length, broken: broken.map(loc), verdict, line };
}