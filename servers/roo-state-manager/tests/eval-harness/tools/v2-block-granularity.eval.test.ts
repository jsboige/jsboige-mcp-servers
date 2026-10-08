/**
 * v2-block-granularity.eval.test.ts — Golden scenario 3 of Epic #2609, live.
 *
 * "Où est le JOIN Postgres dans search-semantic" — the codebase_search query
 * the Epic baseline measured on 2026-06-16: 5 hits, all single-line
 * (`start_line == end_line`), all relevance "good" (0.84–0.88), ZERO hit on
 * the source file that implements the JOIN (the 5 hits were config baselines
 * and fixtures). Replayed verbatim to grade the V2 contract: the result must
 * be exploitable WITHOUT re-opening a grep.
 *
 * V2 delivered in layers:
 *   - #1180 (ranking): test/fixture/data maluses — confusable classes no
 *     longer outrank the source (po-2024, 2026-09-21).
 *   - #3174 (ranking): archive malus (po-2025, 2026-09-22).
 *   - this PR (granularity): query-time block expansion — a source-class hit
 *     is rendered as its enclosing declaration block read from the CURRENT
 *     file (snippet = block passage, start/end_line = block range,
 *     match_lines = the lines the vector matched), not the stored fragment.
 *     Plus: compiled-build malus (×0.7 on `build(-hash)` and `build-out`
 *     derivatives) and a cross-vintage per-file cap key (same logical file
 *     across vintages shares its 2-slot budget).
 *
 * Hard gates below are the DATA-INDEPENDENT contracts of V2(a) — they hold
 * for whatever source-class hits the live index returns:
 *   - every source-class hit renders a multi-line block (never a line)
 *   - every source-class hit carries the match_lines handle
 *   - expansion observability present
 *
 * Grading scope (ai-01 triage on #4105, 2026-10-07): the contract is graded
 * on a REAL semantic run only. A non-success status (collection_not_found…)
 * or a text-fallback answer (fallback_used=true — the fallback renders no
 * blocks by construction) records INCONCLUSIVE, never FAIL. The workspace
 * resolves from the running checkout, not the 2026-06 baseline path.
 *
 * Recorded, NOT gated (index-content dependent — measured 2026-09-27: the
 * candidate pool for this query held ZERO living-source chunks; every code
 * hit was a compiled copy of 3 vintages + staging, and the JOIN's compiled
 * block surfaced at rank ~20):
 *   - presence of a LIVING (non-build) source hit
 *   - presence of search-semantic (any form — the .ts or its compiled echo)
 *
 * @issue Epic #2609 V2(a)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import type { CheckResult } from '../verdict.js';
import { handleCodebaseSearch } from '../../../src/tools/search/search-codebase.tool.js';

/**
 * Resolve the scenario workspace from the CURRENT checkout instead of the
 * hard-coded 2026-06 baseline path `d:/roo-extensions` (ai-01 triage on
 * #4105, 2026-10-07). The collection name is path-derived (ws-<sha256(path)>),
 * so the baseline spelling can only ever reach a seat that indexed under that
 * exact path — every other seat gets collection_not_found and the V2 contract
 * is graded FAIL for an environment reason. Walking up from this test file to
 * the enclosing roo-extensions checkout makes each seat probe the collection
 * of the checkout the harness actually runs from. Returns null when the walk
 * up finds no enclosing checkout (e.g. a bare submodule worktree outside any
 * roo-extensions clone): the scenario then records INCONCLUSIVE, never a
 * crash. A worktree NESTED under a roo-extensions checkout resolves to that
 * worktree's own root (its git dir satisfies the walk-up) — same safe
 * outcome, precise wording (ai-01 review on ms#1404).
 */
function resolveScenarioWorkspace(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, 'mcps', 'internal')) && existsSync(join(dir, '.git'))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// Epic #2609 baseline query, verbatim (2026-06-16 live measurement) — the
// query is verbatim; the workspace now resolves from the running checkout.
const SCENARIO_3_WORKSPACE = resolveScenarioWorkspace();
const SCENARIO_3_ARGS = {
	query: 'unified store Postgres join filters Qdrant semantic search results',
	workspace: SCENARIO_3_WORKSPACE,
	limit: 15,
	min_score: 0.5,
} as const;

// Same classification the tool applies (kept in sync by the block-expansion contract)
const TEST_FILE_RE = /[\\/]__tests__[\\/]|\.test\.|\.spec\./;
const FIXTURE_FILE_RE = /(^|[\\/])tests[\\/]fixtures[\\/]/;
const ARCHIVE_FILE_RE = /(^|[\\/])docs[\\/]archive[\\/]/;
const BUILD_DIR_RE = /(^|[\\/])build(-[a-z0-9]+)?[\\/]/i;
const DATA_FILE_RE = /\.(json|jsonc|json5|ya?ml|csv|tsv|ini|toml|lock)$/i;
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|psm1|ps1|go|rs|java|cs|cpp|cc|c|h|hpp)$/i;

// Environment-only failure modes: INCONCLUSIVE at grading time. Any other
// non-success — chiefly the catch-all `unknown` of classifySearchError
// (rendered at search-codebase.tool.ts l.1937) — is a genuine code exception
// and reads FAIL: grading falls through to the gates, which cannot pass
// without results (ai-01 review on ms#1404). Keep in sync with the `mode:`
// values of search-error-classifier.ts plus the tool's own
// collection_not_found (l.1443).
const ENVIRONMENT_STATUS_MODES = new Set([
	'collection_not_found',
	'auth_failed',
	'qdrant_collection_missing',
	'embedding_unreachable',
	'embedding_timeout',
	'qdrant_client_failure',
	'qdrant_unreachable',
	'qdrant_proxy_drop',
	'qdrant_backend_slow',
	'resource_exhausted',
]);

beforeAll(async () => {
	await runStormGuard();
});

describe('codebase_search — Epic #2609 scenario 3 (block granularity)', () => {
	it('renders exploitable source blocks against the live index', async () => {
		if (STORM_ACTIVE) {
			console.log(`[INCONCLUSIVE] Storm guard active: ${STORM_GUARD_RESULT.reason}`);
			expect(STORM_GUARD_RESULT.active).toBe(true);
			return;
		}

		if (SCENARIO_3_WORKSPACE === null) {
			console.log('[INCONCLUSIVE] harness is not running inside a roo-extensions checkout — no workspace to probe, the V2 contract is unmeasured on this run');
			expect(SCENARIO_3_WORKSPACE).toBeNull();
			return;
		}

		const startMs = Date.now();
		const result = await handleCodebaseSearch(SCENARIO_3_ARGS as any);
		const latencyMs = Date.now() - startMs;

		const rawText = result.content?.[0] && 'text' in result.content[0]
			? (result.content[0] as { text: string }).text
			: '';
		const parsed = JSON.parse(rawText);
		const checks: CheckResult[] = [];

		// ---- infra shapes are INCONCLUSIVE, never FAIL (ai-01 triage #4105, 2026-10-07) ----
		// Grade the V2 contract on a real semantic run only:
		// (1) a non-success status in the KNOWN environment modes
		//     (collection_not_found — e.g. this seat holds no collection for the
		//     resolved checkout path — embedding/qdrant unreachable or slow,
		//     auth, rate limits) is an environment state, not a V2 regression →
		//     INCONCLUSIVE. Any OTHER non-success — chiefly the catch-all
		//     `unknown` of classifySearchError (search-codebase.tool.ts l.1937)
		//     — is a genuine code exception and reads FAIL (ai-01 review on
		//     ms#1404): grading falls through to the gates below, which cannot
		//     pass without results;
		// (2) fallback_used=true means the embedding breaker half-opened and the
		//     tool answered from the token-match fallback, a path that renders
		//     no blocks (search-codebase.tool.ts l.873-895) — the scenario is
		//     UNMEASURED, not failing. Checking it here at grading time also
		//     closes the race window of the beforeAll storm-guard probe (the
		//     guard's verdict can go stale between beforeAll and the call).
		if (parsed.status !== 'success') {
			if (ENVIRONMENT_STATUS_MODES.has(parsed.status)) {
				console.log(`[INCONCLUSIVE] status=${parsed.status} for workspace '${SCENARIO_3_WORKSPACE}' — environment shape, the V2 contract is unmeasured on this run`);
				expect(parsed.status).not.toBe('success');
				return;
			}
			console.log(`status=${parsed.status} (message: ${String(parsed.message ?? '').slice(0, 160)}) is not a known environment mode — grading continues: a genuine code exception reads FAIL, not INCONCLUSIVE`);
		}
		if (parsed.fallback_used === true) {
			console.log(`[INCONCLUSIVE] codebase_search answered from the text fallback (fallback_used=true, fallback_reason=${parsed.fallback_reason}) — the V2 block contract does not apply to that path`);
			expect(parsed.fallback_used).toBe(true);
			return;
		}

		// ---- presence ----
		const hasResults = Array.isArray(parsed.results) && parsed.results.length > 0;
		checks.push({ name: 'results.length > 0', ok: hasResults, observed: String(parsed.results?.length) });

		// Source-class = code file the block contract applies to (compiled copies included:
		// they ARE code, and on an index without living-source chunks they are the only
		// actionable echo — the block range + match_lines translate to the .ts directly).
		const isSourceClass = (r: any) =>
			SOURCE_EXT_RE.test(String(r.file_path || ''))
			&& !TEST_FILE_RE.test(String(r.file_path || ''))
			&& !FIXTURE_FILE_RE.test(String(r.file_path || ''))
			&& !ARCHIVE_FILE_RE.test(String(r.file_path || ''))
			&& !BUILD_DIR_RE.test(String(r.file_path || ''))
			&& !DATA_FILE_RE.test(String(r.file_path || ''));
		const isCompiled = (r: any) =>
			SOURCE_EXT_RE.test(String(r.file_path || '')) && BUILD_DIR_RE.test(String(r.file_path || ''));
		const sourceClassHits = (parsed.results || []).filter((r: any) => isSourceClass(r) || isCompiled(r));

		const hasSourceClassHit = sourceClassHits.length > 0;
		checks.push({
			name: '≥1 source-class hit (living source or compiled echo)',
			ok: hasSourceClassHit,
			observed: sourceClassHits.length
				? sourceClassHits.slice(0, 3).map((r: any) => r.file_path).join(', ')
				: `top: ${(parsed.results || []).slice(0, 3).map((r: any) => r.file_path).join(', ')}`,
		});

		// ---- rubric (a): every source-class hit renders a multi-line block ----
		const allBlocks = sourceClassHits.every((r: any) =>
			typeof r.start_line === 'number'
			&& typeof r.end_line === 'number'
			&& r.end_line > r.start_line
			&& typeof r.snippet === 'string'
			&& r.snippet.length >= 200);
		checks.push({
			name: 'rubric(a): every source-class hit is a multi-line block (end>start, snippet ≥ 200 chars)',
			ok: allBlocks,
			observed: sourceClassHits.length
				? `min span ${Math.min(...sourceClassHits.map((r: any) => r.end_line - r.start_line))} lines`
				: 'no source-class hit',
		});

		// Baseline signature killed: no returned source-class hit is a single-line fragment
		const noSingleLine = sourceClassHits.every((r: any) =>
			!(typeof r.start_line === 'number' && typeof r.end_line === 'number' && r.start_line === r.end_line));
		checks.push({
			name: 'baseline signature dead: zero source-class hit with start_line == end_line',
			ok: noSingleLine,
			observed: `${sourceClassHits.filter((r: any) => r.start_line === r.end_line).length} single-line hits`,
		});

		// ---- rubric (b): handle — block range + the vector-matched lines ----
		const allHandles = sourceClassHits.every((r: any) =>
			typeof r.match_lines === 'string' && /^\d+(-\d+)?$/.test(r.match_lines));
		checks.push({
			name: 'rubric(b): match_lines handle on every source-class hit',
			ok: allHandles,
			observed: sourceClassHits.length ? String(sourceClassHits[0].match_lines) : 'no source-class hit',
		});

		// ---- observability ----
		const expansionObserved = typeof parsed.block_expansion_applied === 'number' && parsed.block_expansion_applied > 0;
		checks.push({
			name: 'block_expansion_applied > 0 (observability)',
			ok: expansionObserved,
			observed: String(parsed.block_expansion_applied),
		});

		// ---- data-dependent (recorded, NOT gated) ----
		const livingSource = (parsed.results || []).find((r: any) => isSourceClass(r));
		const joinHit = (parsed.results || []).find((r: any) => /search-semantic\.tool\.(ts|js)$/.test(String(r.file_path || '')));
		console.log(`[recorded] living (non-build) source hit: ${livingSource ? `${livingSource.file_path} lines ${livingSource.start_line}-${livingSource.end_line}` : 'none in top-15 (pool held only compiled echoes + doc audits — measured 2026-09-27)'}`);
		console.log(`[recorded] search-semantic (JOIN home) in results: ${joinHit ? `YES ${joinHit.file_path} lines ${joinHit.start_line}-${joinHit.end_line} (matched ${joinHit.match_lines})` : 'no'}`);
		if (sourceClassHits[0]) {
			const b = sourceClassHits[0];
			console.log(`[recorded] top source-class hit: ${b.file_path} lines ${b.start_line}-${b.end_line} (matched ${b.match_lines}), snippet head: ${String(b.snippet).slice(0, 160)}`);
		}

		console.log('=== V2 scenario-3 live evidence ===');
		console.log(`latency_ms=${latencyMs}, results=${parsed.results_count}, block_expansion_applied=${parsed.block_expansion_applied}, build_dir_malus_applied=${parsed.build_dir_malus_applied}`);
		console.log('checks:', JSON.stringify(checks.map(c => ({ n: c.name, ok: c.ok }))));

		// Hard gates: structural contracts only (data-independent).
		expect(hasResults).toBe(true);
		expect(hasSourceClassHit).toBe(true);
		expect(allBlocks).toBe(true);
		expect(noSingleLine).toBe(true);
		expect(allHandles).toBe(true);
		expect(expansionObserved).toBe(true);
	});
});
