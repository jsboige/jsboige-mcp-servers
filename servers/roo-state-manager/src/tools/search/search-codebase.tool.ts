/**
 * Outil MCP : codebase_search
 * Recherche sémantique dans les collections workspace Roo (code indexé)
 *
 * @version 1.0.0
 * @author #452 Phase 2 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { classifySearchError, formatClassifiedError, isNetworkErrorLike } from './search-error-classifier.js';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { getQdrantClient } from '../../services/qdrant.js';
import { resolveWorkspace } from '../../utils/workspace-resolver.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path';

/**
 * #2609/#2554 (rename-GC gap): the Roo/Zoo Code indexer (reference-only submodule
 * roo-code) lacks reliable garbage-collection of vectors whose source file was
 * renamed/moved/deleted. Surviving orphans make codebase_search return dead paths
 * (e.g. docs archived via `git mv`). Since the MCP only reads the ws-* collections,
 * we post-filter hits whose resolved filePath no longer exists on disk.
 *
 * Returns true if the file is reachable (keep the hit), false if it is a dead path
 * (filter out). Resolves relative payloads against the workspace root; absolute
 * payloads are checked as-is.
 */
function isFilePathReachable(filePath: string, workspaceRoot: string): boolean {
	try {
		const resolved = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);
		return existsSync(resolved);
	} catch {
		// On any FS error, be permissive (don't nuke legitimate hits on edge cases).
		return true;
	}
}

/**
 * Génère le nom de collection Qdrant pour un workspace (même convention que Roo)
 * Roo Code hashes the raw fsPath from VS Code without normalization.
 * We try the exact path first, then common variants (case, separators).
 * @param workspacePath Chemin absolu du workspace
 * @returns Nom de la collection Qdrant (format: ws-XXXXXXXXXXXXXXXX)
 */
export function getWorkspaceCollectionName(workspacePath: string): string {
	// Fix double-escaped backslashes (common in JSON/MCP parameter passing)
	const cleaned = workspacePath.replace(/\\{2,}/g, '\\').replace(/\/+$|\\+$/g, '');
	const hash = createHash('sha256').update(cleaned).digest('hex');
	return `ws-${hash.substring(0, 16)}`;
}

/**
 * Génère toutes les variantes possibles de noms de collection pour un workspace.
 * Roo Code hashes the raw fsPath from VS Code without normalization.
 *
 * Root cause #1085: Roo on Windows uses backslash fsPath (c:\dev\project),
 * but Claude Code may pass forward slashes (c:/dev/project) from Git Bash.
 * The hashes are completely different, so the collection isn't found.
 *
 * Strategy: try path variants first, then fallback to listing Qdrant collections.
 */
export function getWorkspaceCollectionVariants(workspacePath: string): string[] {
	const cleaned = workspacePath.replace(/\\{2,}/g, '\\').replace(/\/+$|\\+$/g, '');
	const variants = new Set<string>();

	// 1. Exact path (cleaned) — as-is
	variants.add(cleaned);

	// 2. Lowercase (Windows is case-insensitive)
	variants.add(cleaned.toLowerCase());

	// 3. With forward slashes (Git Bash / WSL style)
	variants.add(cleaned.replace(/\\/g, '/'));
	variants.add(cleaned.toLowerCase().replace(/\\/g, '/'));

	// 4. With backslashes (Windows native fsPath — Roo's convention)
	variants.add(cleaned.replace(/\//g, '\\'));
	variants.add(cleaned.toLowerCase().replace(/\//g, '\\'));

	// 5. Uppercase drive letter (VS Code may capitalize)
	if (/^[a-z]:/.test(cleaned)) {
		const upper = cleaned[0].toUpperCase() + cleaned.slice(1);
		variants.add(upper);
		variants.add(upper.replace(/\//g, '\\'));
		// #3344: the uppercase-drive form must exist in BOTH separator styles —
		// previously only cleaned's own separator was carried over, so a lowercase
		// backslash input could reach the canonical fsPath hash but never the
		// canonical forward-slash hash (convergence gap caught by the #3344 test).
		variants.add(upper.replace(/\\/g, '/'));
	}
	// 6. Lowercase drive letter — the MIRROR of branch 5. Without it, an
	// uppercase-drive input (VS Code CWD, e.g. D:\dev\CoursIA-2) never generated
	// the lowercase-drive spellings with the rest of the case preserved, so a
	// query could not reach an index hashed under d:\… whenever the path carries
	// uppercase past the drive letter (fleet investigation 2026-09-12, CoursIA-2
	// collection_not_found: d:\ and D:\ inputs must generate the SAME variant set).
	if (/^[A-Z]:/.test(cleaned)) {
		const lower = cleaned[0].toLowerCase() + cleaned.slice(1);
		variants.add(lower);
		variants.add(lower.replace(/\//g, '\\'));
		variants.add(lower.replace(/\\/g, '/'));
	}

	// Generate collection names for each variant
	return [...variants].map(v => {
		const hash = createHash('sha256').update(v).digest('hex');
		return `ws-${hash.substring(0, 16)}`;
	});
}

/**
 * Fallback: list all ws-* collections from Qdrant and return them.
 * Used when no hash variant matches, to handle unknown path formats.
 * #1085: The workspace path hashing is fragile across agents/environments.
 */
/**
 * #3344: bounded retry for transient transport failures on Qdrant calls.
 *
 * The reported failure signature: a single `fetch failed` on the FIRST Qdrant
 * call of a codebase_search, while a diagnose 2 minutes later is fully green —
 * i.e. a transient network event (connection pool race, TLS handshake hiccup),
 * not a backend outage. One retry after a short backoff absorbs exactly that
 * class; persistent failures still propagate to the classifier (which now
 * distinguishes client-failure from Qdrant-down via the /healthz probe).
 */
const TRANSPORT_RETRY_DELAY_MS = parseInt(process.env.QDRANT_TRANSPORT_RETRY_DELAY_MS || '400');

async function withTransportRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (retries > 0 && isNetworkErrorLike(err)) {
			await new Promise(r => setTimeout(r, TRANSPORT_RETRY_DELAY_MS));
			return withTransportRetry(fn, retries - 1);
		}
		throw err;
	}
}

export async function listWorkspaceCollections(): Promise<string[]> {
	try {
		const qdrant = getQdrantClient();
		const response = await withTransportRetry(() => qdrant.getCollections());
		return response.collections
			.map((c: any) => c.name)
			.filter((name: string) => name.startsWith('ws-'));
	} catch (err) {
		// #2636: a Qdrant *outage* (network/TLS) must surface as qdrant_unreachable
		// via the outer classifier, not be folded into an empty list — which the caller
		// then reports as collection_not_found, masking the outage as a missing index.
		// A genuinely empty / 404 listing is still swallowed → [].
		if (isNetworkErrorLike(err)) throw err;
		return [];
	}
}

// ─── Content-based collection matching (L1 fix for #2609/#2554) ───────────────
// Root cause (convergent po-2023 c.32 + po-2024 c.34, 2026-06-19): the workspace
// path hash `ws-{sha256(path)[0:16]}` is fundamentally fragile cross-agent — the
// exact path format the Roo/Zoo indexer hashed is not always reproducible by the
// MCP (backslash vs forward slash, case, file:// vs raw, resolved vs raw). When no
// hash variant matches, the MCP served an empty diagnostic even though the code IS
// indexed (just under a different hash). This content-based fallback identifies the
// right ws-* collection by matching its top-level pathSegments against the actual
// directory structure of the workspace on disk — robust where the hash is not.

/** Strict similarity threshold (Jaccard) below which we refuse to serve a content-matched collection. */
const CONTENT_MATCH_MIN_JACCARD = 0.6;
/**
 * Overlap-coefficient (containment) threshold — #2554/#2766 (inflated-workspace fix).
 * Symmetric Jaccard collapses on real workspaces that accumulated many top-level dirs
 * the indexer never touched (build, temp, logs, node_modules, exports, outputs, profiles,
 * backups, .tmp, ...): the huge union drives Jaccard below CONTENT_MATCH_MIN_JACCARD even
 * though the collection's indexed dirs are a CLEAN SUBSET of the workspace. Live ai-01 case:
 * 30-dir workspace vs 8-dir index, intersection 7 → Jaccard 7/31 = 0.226 (rejected), but
 * overlap = 7 / min(30,8) = 0.875 (accepted). Overlap measures "are the indexed dirs
 * contained in the workspace?" rather than "are the two dir sets the same size?".
 */
const CONTENT_MATCH_MIN_OVERLAP = 0.6;
/** Generic directory names that are NOT discriminant — excluded from the "discriminant dir" requirement. */
const GENERIC_DIRS = new Set([
	'src', 'docs', 'tests', 'test', 'scripts', 'node_modules', '.git', 'config',
	'examples', 'lib', 'libs', 'build', 'dist', 'out', 'public', 'static', 'resources',
	'assets', 'data', 'utils', 'tools', 'vendor', '.vscode', '.idea'
]);
/**
 * Max ws-* collections scanned by the content fallback (cost cap).
 * CoursIA-2 fleet finding (2026-09-20, po-203 cross-workspace [TASK]): with the cap at 10,
 * the only accepting candidates sat at ranks 12-13 of 62 (the in-cap CoursIA-family
 * collection rejected at overlap 0.545 while ranks 12/13 accepted at 0.75) — the cap hid
 * the only reachable match and codebase_search reported collection_not_found for a workspace
 * whose content IS indexed (under a sibling clone's hash). Each candidate costs one
 * payload-only scroll, so scanning the whole fleet's collection set is cheap; the cap now
 * defaults to 64 (>= the observed 62) and stays env-overridable.
 */
const CONTENT_MATCH_MAX_CANDIDATES = parseInt(process.env.CONTENT_MATCH_MAX_CANDIDATES || '64', 10);

/**
 * Build the "signature" of a workspace = the set of top-level directory names on disk.
 * Used to match against a ws-* collection's indexed pathSegments.0.
 * Best-effort: returns null on any FS error (e.g. workspace not mounted) so the caller
 * can skip content-matching rather than crash.
 */
function getWorkspaceRootSignature(workspaceRoot: string): Set<string> | null {
	try {
		const entries = readdirSync(workspaceRoot, { withFileTypes: true });
		const dirs = new Set<string>();
		for (const e of entries) {
			// dirent.isDirectory() excludes files, symlinks-to-files. Symlinked dirs
			// (e.g. submodule checkouts on some setups) are included if isDirectory().
			if (e.isDirectory()) dirs.add(e.name);
		}
		return dirs;
	} catch {
		// Workspace root unreadable / unmounted / ENOENT — skip content-matching.
		return null;
	}
}

/**
 * Query a ws-* collection for a sample of points and extract the set of
 * top-level pathSegments.0 observed = the collection's signature.
 *
 * Uses Qdrant's `scroll` API (no vector / no embedding needed) to cheaply sample
 * points — the same approach used in indexing/cleanup-orphans.ts and diagnose-index.
 * We only request the `pathSegments` payload field, keeping the response tiny.
 *
 * Sample size is deliberately larger than minimal (200 vs 50) to mitigate the
 * insertion-order bias of `scroll`: on a large heterogeneous collection the first
 * N points may cluster in one sub-directory, under-representing other top-level dirs
 * and producing a false-negative match. A 200-pt sample captures a much broader
 * signature. Cost stays negligible (payload-only, and only on the hash-miss path).
 * If false-negatives still appear in the wild, consider a second scroll from a
 * hash-derived offset. (Hardening per web1 review observation.)
 *
 * Returns the collection's signature (set of pathSegments.0 values) plus the sampled
 * relative filePaths (used by the #2609 liveness preference below), or null if the
 * collection is unreadable.
 */
async function getCollectionSignature(
	qdrant: any,
	collectionName: string
): Promise<{ dirs: Set<string>; paths: string[] } | null> {
	try {
		// Sample 200 points: payload-only (no vector). pathSegments is always present
		// on indexed points (qdrant-client.ts:315-331). Robust to scroll's response
		// shape variants (.points or .result.points).
		const result = await qdrant.scroll(collectionName, {
			limit: 200,
			with_payload: { include: ['pathSegments', 'filePath'] },
			with_vector: false,
		});
		const points = result?.points || result?.result?.points || [];
		const sig = new Set<string>();
		const paths: string[] = [];
		for (const p of points) {
			const ps = p?.payload?.pathSegments;
			if (ps && typeof ps === 'object') {
				// pathSegments is keyed by index: { "0": "mcps", "1": "internal", ... }
				const seg0 = ps['0'];
				if (seg0) sig.add(String(seg0));
			} else if (p?.payload?.filePath) {
				// Fallback: derive from filePath (relative path, first segment).
				const seg0 = String(p.payload.filePath).split(/[\\/]/)[0];
				if (seg0) sig.add(seg0);
			}
			if (p?.payload?.filePath) paths.push(String(p.payload.filePath));
		}
		return { dirs: sig, paths };
	} catch {
		return null;
	}
}

// ─── #2609 grain 3 (2026-10-04): liveness preference at content-match resolution ──
// Measured live (ai-01, 2026-10-04): among accepted candidates, the content-match picks
// purely by structural score (points_count-desc order + score tie-break). The decaying
// twin ws-59e7574de63c6e62 (398 567 pts, liveness 0.751 — dead build-vintage dirs) was
// served over the repaired ws-d2ffdbaa832aed16 (328 245 pts, liveness 0.954), and golden
// q3 returned 12/15 unopenable paths. Structural similarity cannot see that a collection
// indexes files that no longer exist under the requested workspace — only the disk can.

/** Rollback: CONTENT_MATCH_LIVENESS=0 restores pure structural-score selection. */
function isContentMatchLivenessEnabled(): boolean {
	return process.env.CONTENT_MATCH_LIVENESS !== '0';
}
/** Liveness ratio of the RESOLVED collection below which the response warns (stale twin). */
const CONTENT_MATCH_LIVENESS_WARN_RATIO = parseFloat(process.env.CONTENT_MATCH_LIVENESS_WARN_RATIO || '0.5');
/** Caps the existsSync sample per candidate (paths come free from the signature scroll). */
const LIVENESS_MAX_PATHS = 100;

/**
 * Estimate a candidate collection's liveness: the share of its sampled indexed paths
 * that still exist under the requested workspace root. Dead paths are exactly the hits
 * the caller could not open, so among structurally-accepted candidates the livelier
 * one delivers more exploitable results (#2609's north-star rubric).
 *
 * Paths escaping the workspace root are skipped (not a liveness signal for THIS
 * workspace). Returns null when fewer than 2 paths are checkable — an undecidable
 * sample must never masquerade as a measured ratio.
 */
export function estimateCollectionLiveness(
	paths: string[],
	workspaceRoot: string
): { ratio: number; checked: number } | null {
	try {
		const root = resolve(workspaceRoot);
		let live = 0;
		let checked = 0;
		for (const raw of paths.slice(0, LIVENESS_MAX_PATHS)) {
			if (!raw) continue;
			const abs = resolve(root, String(raw).replace(/\\/g, '/'));
			if (abs !== root && !abs.startsWith(root + sep)) continue;
			checked++;
			if (existsSync(abs)) live++;
		}
		if (checked < 2) return null;
		return { ratio: live / checked, checked };
	} catch {
		return null;
	}
}

/**
 * Find the ws-* collection whose indexed top-level directories best match the workspace's
 * actual directory structure. Content-based fallback when hash resolution fails.
 *
 * Returns the best-matching collection if it passes the STRICT threshold via EITHER
 * (a) Jaccard ≥ 0.6, OR (b) overlap coefficient ≥ 0.6 with ≥2 shared discriminant dirs
 * (#2554/#2766 inflated-workspace path) — and in both cases at least one discriminant /
 * non-generic dir shared. Else null. On null the caller keeps the honest diagnostic —
 * we never serve a low-confidence guess.
 *
 * Selection among accepted candidates (#2609 grain 3): liveness ratio FIRST (the share
 * of sampled indexed paths still existing under workspaceRoot), structural score as
 * tie-break. A strictly livelier accepted candidate beats a structurally-better but
 * decaying one — both passed the same structural gates, so they index the same
 * workspace; only the disk knows which one still serves openable paths. Liveness
 * applies only when ≥2 candidates are decidable; otherwise the legacy score ranking
 * stands (first on tie — candidates arrive points_count desc).
 *
 * @param qdrant - Qdrant client
 * @param candidates - ws-* collection names to probe (pre-sorted by points_count desc)
 * @param workspaceSignature - top-level dirs of the workspace on disk (null = skip)
 * @param workspaceRoot - requested workspace root (enables the liveness preference)
 * @returns the selected match with its metrics + liveness, or null
 */
export async function findCollectionByContent(
	qdrant: any,
	candidates: string[],
	workspaceSignature: Set<string> | null,
	workspaceRoot?: string
): Promise<{
	name: string;
	jaccard: number;
	overlap: number;
	sharedDiscriminants: number;
	liveness?: { ratio: number; checked: number };
	selection_basis: 'score' | 'liveness';
	liveness_flipped_selection?: boolean;
} | null> {
	if (!workspaceSignature || workspaceSignature.size === 0 || candidates.length === 0) {
		return null;
	}

	// Discriminant dirs = workspace dirs minus generic ones. At least one must be shared.
	const discriminantDirs = new Set([...workspaceSignature].filter(d => !GENERIC_DIRS.has(d)));

	const scanned = Math.min(candidates.length, CONTENT_MATCH_MAX_CANDIDATES);
	type Accepted = {
		name: string;
		jaccard: number;
		overlap: number;
		sharedDiscriminants: number;
		score: number;
		paths: string[];
		liveness: { ratio: number; checked: number } | null;
	};
	const accepted: Accepted[] = [];

	for (let i = 0; i < scanned; i++) {
		const name = candidates[i];
		const sig = await getCollectionSignature(qdrant, name);
		if (!sig || sig.dirs.size === 0) continue;

		// Jaccard similarity between workspace dirs and collection's indexed dirs.
		const intersection = [...workspaceSignature].filter(d => sig.dirs.has(d)).length;
		const union = new Set([...workspaceSignature, ...sig.dirs]).size;
		if (union === 0) continue;
		const jaccard = intersection / union;

		// #2554/#2766: overlap coefficient (containment) = intersection / min(sizes).
		// Robust to an inflated workspace: measures whether the indexed dirs are a subset
		// of the workspace, independent of how many extra non-indexed dirs the workspace has.
		const overlap = intersection / Math.min(workspaceSignature.size, sig.dirs.size);
		const sharedDiscriminantCount = [...discriminantDirs].filter(d => sig.dirs.has(d)).length;

		// STRICT gate: at least one shared discriminant dir, AND either the original
		// Jaccard threshold OR the overlap threshold. The overlap path additionally
		// requires ≥2 shared discriminant (non-generic) dirs so a tiny unrelated
		// collection can't slip through on a single shared dir via the min-size trick.
		const accept = sharedDiscriminantCount >= 1 && (
			jaccard >= CONTENT_MATCH_MIN_JACCARD
			|| (overlap >= CONTENT_MATCH_MIN_OVERLAP && sharedDiscriminantCount >= 2)
		);
		if (accept) {
			// Rank by the stronger of the two metrics so the overlap path can win the
			// tie-break on inflated workspaces where Jaccard is uniformly low.
			accepted.push({
				name,
				jaccard,
				overlap,
				sharedDiscriminants: sharedDiscriminantCount,
				score: Math.max(jaccard, overlap),
				paths: sig.paths,
				liveness: null,
			});
		}
	}
	if (accepted.length === 0) return null;

	// Liveness for every accepted candidate — paths already sampled by the signature
	// scroll, so this costs only bounded existsSync calls (≤ LIVENESS_MAX_PATHS each).
	if (workspaceRoot && isContentMatchLivenessEnabled()) {
		for (const c of accepted) {
			c.liveness = estimateCollectionLiveness(c.paths, workspaceRoot);
		}
	}

	// Legacy selection: best structural score, first on tie (candidates arrive points-desc).
	const byScore = [...accepted].sort((a, b) => b.score - a.score);
	let winner = byScore[0];
	let selectionBasis: 'score' | 'liveness' = 'score';
	let flipped = false;

	const decidable = accepted.filter(c => c.liveness !== null);
	if (decidable.length >= 2) {
		const byLiveness = [...decidable].sort((a, b) =>
			(b.liveness!.ratio - a.liveness!.ratio) || (b.score - a.score));
		if (byLiveness[0] !== winner) flipped = true;
		winner = byLiveness[0];
		selectionBasis = 'liveness';
	}

	return {
		name: winner.name,
		jaccard: winner.jaccard,
		overlap: winner.overlap,
		sharedDiscriminants: winner.sharedDiscriminants,
		...(winner.liveness ? { liveness: winner.liveness } : {}),
		selection_basis: selectionBasis,
		...(flipped ? { liveness_flipped_selection: true } : {}),
	};
}

// ─── #2609 V2(c)(b): partial-collection detection at resolution time ──────────
// V2(b) verdict (c.5869551111): the served collection ws-d2ffdbaa832aed16 was
// PARTIAL (883/5013 files, src/tools/roosync absent) yet hash-matched and was
// served as-is — the L1 content fallback only fires on a hash miss or an EMPTY
// hash match. No ranking lever can surface a file absent from the corpus, so
// V2(c)(b) makes the state visible at resolution time: count distinct indexed
// files, count eligible files on disk, expose `coverage` + `coverage_warning`
// below a named threshold so callers can propose a reindex instead of reading
// silence as coverage.

/** Warn when distinct indexed files / eligible disk files falls below this ratio. */
const COVERAGE_WARN_RATIO = parseFloat(process.env.CODEBASE_COVERAGE_WARN_RATIO || '0.8');
/** Scroll page size for the distinct-file count (payload-only, no vector). */
const COVERAGE_SCROLL_LIMIT = 256;
/** Hard cap on scroll pages — bounds the count on a runaway collection. */
const COVERAGE_SCROLL_MAX_PAGES = 1200;
/** Per-collection TTL: the full scroll is O(points), never re-paid per search. */
const COVERAGE_CACHE_TTL_MS = parseInt(process.env.CODEBASE_COVERAGE_CACHE_TTL_MS || '900000', 10);
/** Extensions the Roo/Zoo indexer parses — the denominator's eligible set. */
const COVERAGE_ELIGIBLE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.ps1', '.sh', '.sql',
	'.json', '.md', '.yml', '.yaml', '.toml', '.cs', '.java', '.go', '.rs', '.rb',
	'.php', '.c', '.h', '.cpp', '.hpp', '.vue', '.svelte'
]);
/**
 * #2609 V2(c)(b) follow-up (ai-01, 2026-09-30): the denominator must mirror what the
 * Roo/Zoo indexer can actually parse. Its DIRS_TO_IGNORE (roo-code/src/services/glob/
 * constants.ts) skips EVERY hidden directory (the ".*" pattern) plus an explicit list —
 * and does NOT skip compiled dirs: bare `build/`, `build-<hash>/` and `build-out/` ARE
 * indexed (measured ai-01 2026-09-30: ~1400 build-vintage and build-out files in a 10k-point
 * corpus sample, ZERO dotdir paths). The previous MCP list skipped build dirs the
 * numerator counts, and counted `.claude/worktrees/**` — 8390 of D:/roo-extensions'
 * 17992 "eligible" files (47%, 3 agent worktrees) that no indexer ever descends into —
 * so coverage read 0.348 where the indexer-aligned ratio is ~0.60. Same semantics as
 * the indexer: hidden dirs + its explicit names, plus its two path patterns expressed
 * as (parent, name) pairs.
 */
const COVERAGE_SKIP_DIR_NAMES = new Set([
	'node_modules', '__pycache__', 'env', 'venv', 'dist', 'out', 'bundle',
	'vendor', 'tmp', 'temp', 'deps', 'pkg', 'Pods',
]);
const COVERAGE_SKIP_DIR_PAIRS = new Set(['target/dependency', 'build/dependencies']);
const isCoverageSkippedDir = (name: string, parentName: string | null): boolean =>
	name.startsWith('.') || COVERAGE_SKIP_DIR_NAMES.has(name)
	|| (parentName !== null && COVERAGE_SKIP_DIR_PAIRS.has(`${parentName}/${name}`));

/** Shape of the `coverage` block exposed in the search response. */
export type CoverageInfo = {
	indexed_files: number;
	eligible_files: number;
	coverage_ratio: number;
	warn_threshold: number;
	below_threshold: boolean;
};

/** Distinct-file count of a collection via full payload-only scroll (no vector). */
async function countIndexedFiles(qdrant: any, collectionName: string): Promise<number | null> {
	try {
		const files = new Set<string>();
		let offset: any = undefined;
		for (let page = 0; page < COVERAGE_SCROLL_MAX_PAGES; page++) {
			const result: any = await qdrant.scroll(collectionName, {
				limit: COVERAGE_SCROLL_LIMIT,
				...(offset !== undefined && offset !== null ? { offset } : {}),
				with_payload: { include: ['filePath'] },
				with_vector: false,
			});
			const points = result?.points || result?.result?.points || [];
			for (const p of points) {
				const fp = p?.payload?.filePath;
				if (fp) files.add(String(fp));
			}
			offset = result?.next_page_offset ?? result?.result?.next_page_offset;
			if (offset === undefined || offset === null) return files.size;
		}
		return files.size; // page cap hit — a lower bound, still reported as-is
	} catch {
		return null;
	}
}

/** Eligible-file count of the workspace on disk (the denominator). 0 = unreadable/empty. */
function countEligibleWorkspaceFiles(workspaceRoot: string): number {
	try {
		let count = 0;
		// Two guards so a pathological (or mocked, path-blind) readdirSync cannot
		// turn the walk into unbounded work: a depth cap AND a total-entry budget.
		// A depth cap alone is NOT enough — a path-blind mock replays the same
		// directory listing at every level, which multiplies into an exponential
		// tree (3 dirs ^ depth 32) and OOMs the worker; the entry budget caps the
		// multiplication itself. Real repos sit orders of magnitude below both.
		const COVERAGE_WALK_MAX_DEPTH = 32;
		const COVERAGE_WALK_MAX_ENTRIES = 100_000;
		let budget = COVERAGE_WALK_MAX_ENTRIES;
		const walk = (dir: string, depth: number, parentName: string | null): void => {
			if (depth > COVERAGE_WALK_MAX_DEPTH || budget <= 0) return;
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				if (--budget <= 0) return;
				if (e.isDirectory()) {
					if (!isCoverageSkippedDir(e.name, parentName)) walk(join(dir, e.name), depth + 1, e.name);
				} else if (typeof e.isFile === 'function' && e.isFile() && COVERAGE_ELIGIBLE_EXTENSIONS.has(extname(e.name).toLowerCase())) {
					count++;
				}
			}
		};
		walk(workspaceRoot, 0, null);
		return count;
	} catch {
		return 0;
	}
}

/**
 * Pure coverage arithmetic — the 883/5013 shape measured on ws-d2ffdbaa832aed16
 * at V2(b) time. Returns null when the ratio is undecidable (no denominator).
 */
export function evaluateCoverage(indexedFiles: number, eligibleFiles: number, threshold: number = COVERAGE_WARN_RATIO): CoverageInfo | null {
	if (!Number.isFinite(indexedFiles) || !Number.isFinite(eligibleFiles) || eligibleFiles <= 0) return null;
	const ratio = indexedFiles / eligibleFiles;
	return {
		indexed_files: indexedFiles,
		eligible_files: eligibleFiles,
		coverage_ratio: Math.round(ratio * 1000) / 1000,
		warn_threshold: threshold,
		below_threshold: ratio < threshold,
	};
}

/** Per-collection coverage cache (module-level, TTL-bounded). */
const coverageCache = new Map<string, { value: CoverageInfo; expiresAt: number }>();

// ─── #2609 V2 follow-up (ai-01, 2026-09-30): overlapping-window merge at ranking ──
// The indexer stores overlapping windows as SEPARATE chunks — measured live, golden
// q3 re-run: build-out/compare-config.js rendered windows 183-213 and 184-214 took
// ranks 2-3 BOTH (same logical passage twice, two of five slots, while the defining
// source sat outside the top-5). The stored chunks were ADJACENT single lines (198,
// 199) that each EXPANDED to an overlapping block — so the merge must compare the
// EXPANDED block ranges (the `range` the caller precomputes), not the stored lines:
// 198 and 199 do not intersect. Merging before the per-file cap lets the freed budget
// backfill with a distinct file instead of a near-duplicate echo.

/**
 * Drops same-logical-file hits whose line ranges strictly intersect, keeping the
 * higher-scored window of each cluster.
 * PRECONDITION: `hits` sorted by score descending (the caller sorts before capping).
 * Hits with `range: null` (no usable lines) are kept as-is — the per-file cap still
 * bounds them.
 */
export function dropOverlappingWindows<T extends { point: any; score: number; range: { s: number; e: number } | null }>(
	hits: T[],
	capKeyOf: (filePath: string) => string,
): { kept: T[]; merged: number } {
	const kept: T[] = [];
	const rangesByCapKey = new Map<string, Array<{ s: number; e: number }>>();
	let merged = 0;
	for (const hit of hits) {
		const { s, e } = hit.range ?? {};
		if (typeof s !== 'number' || typeof e !== 'number') {
			kept.push(hit);
			continue;
		}
		const key = capKeyOf(String(hit.point?.payload?.filePath || ''));
		const ranges = rangesByCapKey.get(key);
		if (ranges?.some(r => s <= r.e && r.s <= e)) {
			merged++;
			continue;
		}
		if (ranges) ranges.push({ s, e });
		else rangesByCapKey.set(key, [{ s, e }]);
		kept.push(hit);
	}
	return { kept, merged };
}

/** Test hook — clears the TTL cache between suites. */
export function clearCoverageCache(): void {
	coverageCache.clear();
}

/** Orchestrates the resolution-time coverage check (cache → scroll → disk walk). */
async function computeCollectionCoverage(qdrant: any, collectionName: string, workspaceRoot: string): Promise<CoverageInfo | null> {
	const cached = coverageCache.get(collectionName);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const indexed = await countIndexedFiles(qdrant, collectionName);
	if (indexed === null) return null;
	const eligible = countEligibleWorkspaceFiles(workspaceRoot);
	if (eligible <= 0) return null; // workspace not on disk here — ratio undecidable
	const value = evaluateCoverage(indexed, eligible);
	if (value) coverageCache.set(collectionName, { value, expiresAt: Date.now() + COVERAGE_CACHE_TTL_MS });
	return value;
}

/**
 * #2609 V2(c)(c): pin the build vintage that SERVES this response. The MCP host
 * runs the compiled server from a vintaged dir (build-<hex>/ — per #3713 the
 * served code legitimately lags the source tree), so two lanes can return
 * divergent rankings while both report success. Callers pinning this field can
 * compare probes across machines (ai-01 17:31Z input: its host served a
 * pre-V2(a) build while po-2025 served fresh code — same query, different code).
 */
export function getServedBuildId(): string {
	try {
		const entry = process.argv[1];
		if (!entry) return 'unknown';
		return basename(dirname(resolve(entry)));
	} catch {
		return 'unknown';
	}
}

/**
 * Get a dedicated OpenAI-compatible client for codebase embeddings.
 * Uses EMBEDDING_API_KEY/EMBEDDING_API_BASE_URL if set (for self-hosted models like Qwen3-4B),
 * otherwise falls back to OPENAI_API_KEY (standard OpenAI).
 * Separate from the task-indexer's OpenAI client to avoid config conflicts.
 */
let codebaseEmbeddingClient: OpenAI | null = null;
// #1275: Track last API key to detect provider switches
let lastEmbeddingApiKey: string | undefined = undefined;

function getCodebaseEmbeddingClient(): OpenAI {
	const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
	// #1275: Re-create client if API key changed (e.g. after /switch-provider)
	if (!codebaseEmbeddingClient || apiKey !== lastEmbeddingApiKey) {
		if (!apiKey) {
			throw new Error('No embedding API key configured. Set EMBEDDING_API_KEY or OPENAI_API_KEY.');
		}
		lastEmbeddingApiKey = apiKey;
		codebaseEmbeddingClient = new OpenAI({
			apiKey,
			baseURL: process.env.EMBEDDING_API_BASE_URL || undefined,
			// #1232: Reduce timeout and retries to prevent MCP Connection closed.
			// 60s (not 15s) since 2026-08-25: measured 45.8s under load. maxRetries=1 -> ~120s
			// worst case, under the 180s codebase_search budget in config/tool-timeouts.ts.
			timeout: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '60000'),
			maxRetries: 1,
		});
	}
	return codebaseEmbeddingClient;
}
/**
 * Reset the embedding client singleton (for testing).
 * @internal
 */
export function resetCodebaseEmbeddingClient(): void {
	codebaseEmbeddingClient = null;
	lastEmbeddingApiKey = undefined;
}

function getCodebaseEmbeddingModel(): string {
	return process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
}

// ─── #3279 Circuit-breaker for embedding API failures ─────────────────────
// When the embedding API is unreachable (TCP down, DNS fail, timeout), the
// OpenAI client blocks for ~60s before failing. Across a fleet with 6 machines
// hitting the same dead endpoint, this burns 6 minutes of agent time per minute
// of real time — no signal, just silence. Issue #3279 (26/08): `codebase_search`
// was measured at 30.6s/call with no fast-fail. Once the breaker opens, subsequent
// calls return immediately with a hint pointing to roosync_search(action:"diagnose").
// Parity with search-semantic.tool.ts which has had this since #1232.
let codebaseEmbeddingFailureTime = 0;
let codebaseEmbeddingFailureReason = '';
const CODEBASE_EMBEDDING_CB_TTL_MS = parseInt(process.env.CODEBASE_EMBEDDING_CB_TTL_MS || '300000'); // 5 min default

/** Check if the circuit-breaker is currently open. If TTL expired, auto-reset. */
function isCodebaseEmbeddingBreakerOpen(): boolean {
	if (codebaseEmbeddingFailureTime === 0) return false;
	const elapsed = Date.now() - codebaseEmbeddingFailureTime;
	if (elapsed > CODEBASE_EMBEDDING_CB_TTL_MS) {
		// TTL expired — half-open: reset and allow the next call to probe
		codebaseEmbeddingFailureTime = 0;
		codebaseEmbeddingFailureReason = '';
		return false;
	}
	return true;
}

/** Record an embedding failure — opens the breaker for CODEBASE_EMBEDDING_CB_TTL_MS. */
function recordCodebaseEmbeddingFailure(reason: string): void {
	codebaseEmbeddingFailureTime = Date.now();
	codebaseEmbeddingFailureReason = reason;
}

/** Record an embedding success — closes the breaker. */
function recordCodebaseEmbeddingSuccess(): void {
	if (codebaseEmbeddingFailureTime !== 0) {
		codebaseEmbeddingFailureTime = 0;
		codebaseEmbeddingFailureReason = '';
	}
}

/**
 * #3279: Build the circuit-breaker error response.
 * Informative and immediate (<1 ms) instead of waiting 30+ s for an OpenAI timeout.
 */
function buildBreakerOpenResponse(query: string, workspace: string): CallToolResult {
	const ttlRemaining = Math.max(
		0,
		Math.round((CODEBASE_EMBEDDING_CB_TTL_MS - (Date.now() - codebaseEmbeddingFailureTime)) / 1000)
	);
	return {
		isError: true,
		content: [{
			type: 'text',
			text: JSON.stringify({
				status: 'embedding_unreachable',
				message: `Embedding service unreachable — fast-fail (circuit-breaker OPEN, ${ttlRemaining}s remaining of ${Math.round(CODEBASE_EMBEDDING_CB_TTL_MS / 1000)}s TTL). Last recorded reason: ${codebaseEmbeddingFailureReason}`,
				hint: 'The embedding backend is down (measured 26/08: TCP port closed). Try roosync_search(action: "text") for a non-semantic alternative, or wait for the breaker to half-open and retry. Run roosync_search(action: "diagnose") to confirm service state.',
				query,
				workspace,
				circuit_breaker: {
					open: true,
					ttl_seconds_remaining: ttlRemaining,
					ttl_total_seconds: Math.round(CODEBASE_EMBEDDING_CB_TTL_MS / 1000),
					last_failure_reason: codebaseEmbeddingFailureReason,
				},
				alternative: 'Use roosync_search(action: "text") with the same query for a non-semantic fallback that does not require embedding.',
			}, null, 2)
		}]
	};
}

/** Reset circuit-breaker state (for testing). @internal */
export function resetCodebaseEmbeddingBreaker(): void {
	codebaseEmbeddingFailureTime = 0;
	codebaseEmbeddingFailureReason = '';
}

/**
 * #3279: Text/keyword fallback when embedding is unreachable.
 *
 * Uses Qdrant's `scroll` API with payload filters — no vector, no embedding needed.
 * Matches the query tokens (≥3 chars) against codeChunk text in payload. Robust
 * to whitespace/punctuation via a case-insensitive regex on whole words.
 *
 * Limits: scrolls the first N points with payload, filters client-side, returns
 * top-K by token-match count. NOT a substitute for semantic search — agents
 * should treat the result as a degraded path and prefer semantic once the
 * breaker half-opens. The `fallback_used` flag tells the caller.
 *
 * Returns null on any error so the caller can surface the original error.
 */
async function tryTextFallback(
	qdrant: any,
	collectionName: string,
	query: string,
	limit: number,
	directoryPrefix: string | undefined,
	workspace: string
): Promise<CallToolResult | null> {
	try {
		const queryTokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter(t => t.length >= 3)
			.slice(0, 10); // cap regex complexity

		if (queryTokens.length === 0) {
			return null;
		}

		// Build a filter that excludes metadata + roo-code + i18n (same as semantic path)
		const filter: any = {
			must_not: [
				{ key: 'type', match: { value: 'metadata' } },
				{ key: 'pathSegments.0', match: { value: 'roo-code' } },
				{ key: 'pathSegments.0', match: { value: 'i18n' } },
			],
		};

		if (directoryPrefix) {
			const normalizedPrefix = directoryPrefix.replace(/\\/g, '/').replace(/^\.\//, '');
			const segments = normalizedPrefix.split('/').filter(Boolean).slice(0, 5);
			if (segments.length > 0) {
				filter.must = segments.map((segment, index) => ({
					key: `pathSegments.${index}`,
					match: { value: segment }
				}));
			}
		}

		// Over-fetch so token-matching has headroom
		const overFetch = Math.min(limit * 4, 200);
		const scrollResult = await qdrant.scroll(collectionName, {
			limit: overFetch,
			filter,
			with_payload: { include: ['filePath', 'codeChunk', 'startLine', 'endLine', 'pathSegments'] },
			with_vector: false,
		});

		const points = scrollResult?.points || scrollResult?.result?.points || [];

		// Score by token-match count (case-insensitive, whole-word-ish)
		const scored: { point: any; score: number; matchedTokens: string[] }[] = [];
		for (const p of points) {
			const codeChunk = String(p.payload?.codeChunk || '');
			const lowerChunk = codeChunk.toLowerCase();
			const matched: string[] = [];
			let count = 0;
			for (const token of queryTokens) {
				if (lowerChunk.includes(token)) {
					matched.push(token);
					count++;
				}
			}
			if (count > 0) {
				scored.push({ point: p, score: count / queryTokens.length, matchedTokens: matched });
			}
		}

		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, limit);

		const results = top.map(({ point, score, matchedTokens }) => ({
			file_path: point.payload?.filePath,
			score,
			relevance: 'text-match',
			matched_tokens: matchedTokens,
			snippet: extractSnippet(point.payload?.codeChunk || '', query),
			...(point.payload?.startLine && point.payload?.endLine
				? { start_line: point.payload.startLine, end_line: point.payload.endLine }
				: {})
		}));

		return {
			isError: false,
			content: [{
				type: 'text',
				text: JSON.stringify({
					status: 'success',
					query,
					workspace,
					collection: collectionName,
					fallback_used: true,
					fallback_reason: 'embedding_unreachable',
					original_search_mode: 'semantic',
					actual_search_mode: 'text',
					results_count: results.length,
					results,
					warning: 'Embedding service unreachable. This is a token-match fallback, NOT a semantic search. Results are ranked by substring match count, not by concept similarity.',
				}, null, 2)
			}]
		};
	} catch {
		return null; // Fallback itself failed — caller surfaces the original semantic error
	}
}

/**
 * Arguments de l'outil codebase_search
 */
export interface CodebaseSearchArgs {
	/** Requête de recherche sémantique */
	query: string;

	/** Chemin absolu du workspace. Fortement recommande — auto-detection via MCP roots/WORKSPACE_PATH echoue souvent. */
	workspace: string;

	/** Préfixe de répertoire pour filtrer les résultats */
	directory_prefix?: string;

	/** Nombre max de résultats (défaut: 15, max: 50) */
	limit?: number;

	/** Score minimum de similarité 0-1 (défaut: 0.5) */
	min_score?: number;
}

/**
 * Configuration par défaut
 */
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const DEFAULT_MIN_SCORE = 0.5;

/**
 * Définition de l'outil MCP codebase_search
 */
export const codebaseSearchTool: Tool = {
	name: 'codebase_search',
	description: 'Recherche sémantique dans le code du workspace indexé par Roo. Trouve du code par concept, pas par texte exact.',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Requête de recherche sémantique (concept, pas texte exact). Ex: "rate limiting for embeddings", "authentication middleware"'
			},
			workspace: {
				type: 'string',
				description: 'Chemin absolu du workspace. Fortement recommande — auto-detection via MCP roots/WORKSPACE_PATH echoue souvent. Passer explicitement recommande.'
			},
			directory_prefix: {
				type: 'string',
				description: 'Préfixe de répertoire pour filtrer. Ex: "src/services", "mcps/internal"'
			},
			limit: {
				type: 'number',
				description: 'Nombre max de résultats (défaut: 15, max: 50)'
			},
			min_score: {
				type: 'number',
				description: 'Score minimum de similarité 0-1 (défaut: 0.5)'
			}
		},
		required: ['query']
	}
};

/**
 * Interprète un score de similarité en label qualitatif
 */
function interpretScore(score: number): string {
	if (score >= 0.9) return 'excellent';
	if (score >= 0.75) return 'good';
	if (score >= 0.65) return 'moderate';
	if (score >= 0.5) return 'low';
	return 'marginal';
}

/**
 * Extrait un snippet centré autour des mots-clés de la requête
 */
function extractSnippet(codeChunk: string, query: string, maxChars: number = 500): string {
	if (!codeChunk) return '';

	const lowerChunk = codeChunk.toLowerCase();
	const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

	// Trouver la position du premier mot-clé matchant
	let bestPos = -1;
	for (const word of queryWords) {
		const pos = lowerChunk.indexOf(word);
		if (pos !== -1) {
			bestPos = pos;
			break;
		}
	}

	if (bestPos === -1) {
		// Pas de match, retourner le début
		return codeChunk.length <= maxChars ? codeChunk : codeChunk.substring(0, maxChars) + '...';
	}

	// Centrer le snippet autour du match
	const halfWindow = Math.floor(maxChars / 2);
	const start = Math.max(0, bestPos - halfWindow);
	const end = Math.min(codeChunk.length, bestPos + halfWindow);
	let snippet = codeChunk.substring(start, end).trim();

	if (start > 0) snippet = '...' + snippet;
	if (end < codeChunk.length) snippet = snippet + '...';

	return snippet;
}

// ─── #2609 V2(a): query-time block expansion ────────────────────────────────
// The Epic baseline (2026-06-16) measured hits as `start_line == end_line`
// single-line chunks — "un panneau vers un groupe de fichiers", the wrong one.
// Root cause is index-side: the Roo/Zoo indexer splits oversized blocks/lines
// into SEGMENTS (roo-code parser.ts createSegmentBlock — a segment of a long
// line carries start_line == end_line BY CONSTRUCTION), and no query-time fix
// can change what vectors exist. BUT the rubric targets the RESULT, not the
// index: each hit carries filePath + startLine, and the tool already proves
// the file is on disk (isFilePathReachable). Re-reading the CURRENT file and
// expanding the hit's anchor line to its enclosing declaration delivers
// rubric (a) passage (the function block, not a line) and (c) context
// (surrounding lines) with no re-indexation — same pattern as V3's
// conversation_context (post-retrieval enrichment from a second read).
//
// Safety: expansion only applies when the anchor is VERIFIABLE in the current
// file (the stored chunk's head must still be found within ±5 lines of the
// stored startLine) — a stale index must degrade to the raw chunk snippet,
// never render the wrong block. Bounded walks (≤200 back, ≤400 forward),
// bounded render (≤80 lines / ≤3000 chars, cut on line boundaries per the V4
// signal lesson), files ≤2 MB. Rollback: CODEBASE_BLOCK_EXPANSION=0.
/** Read per call (not at module load) so the rollback env is testable and applies without a restart. */
function blockExpansionEnabled(): boolean {
	return process.env.CODEBASE_BLOCK_EXPANSION !== '0';
}
const BLOCK_EXPANSION_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|psm1|ps1|go|rs|java|cs|cpp|cc|c|h|hpp)$/i;
const BLOCK_EXPANSION_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BLOCK_EXPANSION_MAX_RENDER_LINES = 80;
const BLOCK_EXPANSION_MAX_RENDER_CHARS = 3000;
const BLOCK_EXPANSION_MAX_BACKWARD_WALK = 200;
const BLOCK_EXPANSION_MAX_FORWARD_WALK = 400;
const BLOCK_EXPANSION_ANCHOR_TOLERANCE = 5;

/** Naive per-line brace delta — heuristic (string literals/comments can skew, the bounded fallback keeps it honest). */
function countBraces(line: string): number {
	let depth = 0;
	for (const ch of line) {
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
	}
	return depth;
}

function leadingWhitespace(line: string): number {
	const m = line.match(/^[ \t]*/);
	return m ? m[0].length : 0;
}

/** A declaration-looking line (function/class/method/def). The nearest one ABOVE the anchor bounds the block.
 * Plain `const x = ...;` statements do NOT count — they are statements INSIDE the enclosing
 * function, and matching them would shrink the block to the anchor line itself. */
const DECL_START_RE = /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\b|class\b|interface\b|enum\b|def\s+\w+|param\s*\(|using\s+namespace)/;
/** const/let only count as block starts when the RHS IS a function (arrow or function expr) —
 * `export const handleX = async (...)` spans lines and owns a body. */
const ASSIGN_FN_START_RE = /^\s*(export\s+)?(const|let)\s+\w+(\s*:\s*[^=]+)?\s*=\s*(async\s*)?(\([^)]*\)\s*=>|function\b)/;

/** Walk endIdx back over trailing blank lines (cosmetic — a block doesn't end on a blank). */
function trimTrailingBlanks(lines: string[], idx: number): number {
	while (idx > 0 && lines[idx].trim() === '') idx--;
	return idx;
}

/**
 * Expand the anchor line (0-based index) to its enclosing declaration block.
 * Brace languages: walk forward from the declaration until depth closes.
 * Braceless languages (python): end when indentation drops below the FIRST BODY
 * line's indent (the declaration itself may sit at column 0).
 * No declaration found in bounded walk → blank-line window fallback (still a
 * passage, not a fragment).
 */
export function computeBlockRange(lines: string[], anchorIdx: number): { startIdx: number; endIdx: number } | null {
	if (anchorIdx < 0 || anchorIdx >= lines.length) return null;

	// 1. Backward: nearest declaration-looking line at or above the anchor.
	let startIdx = -1;
	for (let i = anchorIdx; i >= 0 && i >= anchorIdx - BLOCK_EXPANSION_MAX_BACKWARD_WALK; i--) {
		if (DECL_START_RE.test(lines[i]) || ASSIGN_FN_START_RE.test(lines[i])) { startIdx = i; break; }
	}

	if (startIdx >= 0) {
		let endIdx = Math.min(lines.length - 1, startIdx + BLOCK_EXPANSION_MAX_FORWARD_WALK);
		let depth = 0;
		let opened = false;
		let bodyIndent: number | null = null;
		for (let i = startIdx; i <= endIdx; i++) {
			const line = lines[i];
			depth += countBraces(line);
			if (line.includes('{')) opened = true;
			if (opened && depth <= 0) { endIdx = i; break; }
			if (!opened && i > startIdx && line.trim() !== '') {
				if (bodyIndent === null) {
					bodyIndent = leadingWhitespace(line);
				} else if (leadingWhitespace(line) < bodyIndent) {
					endIdx = trimTrailingBlanks(lines, i - 1);
					break;
				}
			}
		}
		// Correctness guard: the computed block MUST contain the anchor. On minified or
		// compiled code (build-* artifacts, anonymous assignments) the declaration regex
		// can latch onto a function that CLOSES BEFORE the anchor line — rendering it
		// would show the wrong code while the block range reads like a confident handle.
		// Fall through to the blank-line window, which contains the anchor by construction.
		if (endIdx >= anchorIdx) {
			return { startIdx, endIdx };
		}
	}

	// 2. Fallback: blank-line-delimited window around the anchor (±15 lines, snapped to blanks).
	let s = anchorIdx;
	const stopUp = Math.max(0, anchorIdx - 15);
	while (s > stopUp && lines[s - 1] !== undefined && lines[s - 1].trim() !== '') s--;
	let e = anchorIdx;
	const stopDown = Math.min(lines.length - 1, anchorIdx + 15);
	while (e < stopDown && lines[e + 1] !== undefined && lines[e + 1].trim() !== '') e++;
	return { startIdx: s, endIdx: e };
}

/**
 * Stale-index guard: the stored chunk's head must still be locatable within
 * ±tolerance lines of the stored startLine in the CURRENT file. A segment of a
 * long line is a substring of the file line, so we test containment of the
 * chunk's first non-empty 40 chars, not equality.
 */
export function verifyAnchor(lines: string[], anchorIdx: number, codeChunk: string): boolean {
	const firstChunkLine = codeChunk.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
	if (!firstChunkLine) return false;
	const probe = firstChunkLine.slice(0, 40);
	if (!probe) return false;
	const from = Math.max(0, anchorIdx - BLOCK_EXPANSION_ANCHOR_TOLERANCE);
	const to = Math.min(lines.length - 1, anchorIdx + BLOCK_EXPANSION_ANCHOR_TOLERANCE);
	for (let i = from; i <= to; i++) {
		if (lines[i].includes(probe)) return true;
	}
	return false;
}

/**
 * Render the block as a passage: window the render around the anchor if the
 * block exceeds the line/char budget (cuts on LINE boundaries — never
 * mid-line), with honest omission markers. Returns 1-based line numbers, or
 * null when no line-bounded window fits the char budget (see below).
 */
export function renderBlock(
	lines: string[],
	range: { startIdx: number; endIdx: number },
	anchorIdx: number
): { text: string; startLine: number; endLine: number } | null {
	let s = range.startIdx;
	let e = range.endIdx;
	if (e - s + 1 > BLOCK_EXPANSION_MAX_RENDER_LINES) {
		s = Math.max(range.startIdx, anchorIdx - Math.floor(BLOCK_EXPANSION_MAX_RENDER_LINES / 2));
		e = Math.min(range.endIdx, s + BLOCK_EXPANSION_MAX_RENDER_LINES - 1);
	}
	// Char budget: shrink the window around the anchor, line by line, until it fits.
	while (e - s + 1 > 5 && lines.slice(s, e + 1).join('\n').length > BLOCK_EXPANSION_MAX_RENDER_CHARS) {
		if (anchorIdx - s >= e - anchorIdx) s++;
		else e--;
	}
	// The loop above stops at a 5-line floor, whatever those lines weigh: a minified
	// bundle is ONE line and would otherwise ship whole (up to the 2 MB file cap) in a
	// single atomic tool result (#3579 class). No line-bounded window fits, so degrade:
	// null -> the caller keeps the raw chunk snippet (extractSnippet, bounded), which is
	// also the segment the vector actually matched.
	if (lines.slice(s, e + 1).join('\n').length > BLOCK_EXPANSION_MAX_RENDER_CHARS) return null;
	const above = s - range.startIdx;
	const below = range.endIdx - e;
	const parts: string[] = [];
	if (above > 0) parts.push(`[... ${above} lines above the rendered window omitted within the block ...]`);
	parts.push(lines.slice(s, e + 1).join('\n'));
	if (below > 0) parts.push(`[... ${below} lines below the rendered window omitted within the block ...]`);
	return { text: parts.join('\n'), startLine: s + 1, endLine: e + 1 };
}

/**
 * #2609 V2(a): expand one hit to its enclosing block read from the CURRENT file.
 * Returns null (caller keeps the raw chunk snippet) when: disabled by env,
 * non-source file, file unreadable/too large/absent, anchor line out of range,
 * the anchor can't be verified (file drifted since indexing), or no line-bounded
 * window fits the char budget (minified / very long lines).
 */
export function expandHitBlock(
	filePath: string,
	storedStartLine: number,
	codeChunk: string,
	workspaceRoot: string,
	fileLinesCache: Map<string, string[] | null>
): { text: string; startLine: number; endLine: number } | null {
	if (!blockExpansionEnabled()) return null;
	try {
		const abs = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);
		let lines = fileLinesCache.get(abs);
		if (lines === undefined) {
			try {
				if (statSync(abs).size > BLOCK_EXPANSION_MAX_FILE_BYTES) {
					fileLinesCache.set(abs, null);
					return null;
				}
				lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
			} catch {
				fileLinesCache.set(abs, null);
				return null;
			}
			fileLinesCache.set(abs, lines);
		}
		if (!lines) return null;
		const anchorIdx = storedStartLine - 1; // payload startLine is 1-based (parser: row + 1)
		if (anchorIdx < 0 || anchorIdx >= lines.length) return null;
		if (!verifyAnchor(lines, anchorIdx, codeChunk)) return null;
		const range = computeBlockRange(lines, anchorIdx);
		if (!range) return null;
		return renderBlock(lines, range, anchorIdx);
	} catch {
		return null;
	}
}

/**
 * Handler principal de l'outil codebase_search
 */
export async function handleCodebaseSearch(args: CodebaseSearchArgs): Promise<CallToolResult> {
	const {
		query,
		workspace: explicitWorkspace,
		directory_prefix,
		limit = DEFAULT_LIMIT,
		min_score = DEFAULT_MIN_SCORE
	} = args;

	if (!query || query.trim().length === 0) {
		return {
			isError: true,
			content: [{ type: 'text', text: 'Le paramètre "query" est requis et ne peut pas être vide.' }]
		};
	}

	// #3999: borner la query envoyée à l'API d'embedding — une requête non bornée
	// part intégralement chez le provider pour un concept qui tient en une phrase.
	const MAX_EMBEDDING_QUERY_CHARS = 2000;
	if (query.length > MAX_EMBEDDING_QUERY_CHARS) {
		return {
			isError: true,
			content: [{ type: 'text', text: `Le paramètre "query" dépasse ${MAX_EMBEDDING_QUERY_CHARS} caractères (${query.length}) — une requête sémantique par concept n'a pas besoin d'être plus longue (#3999).` }]
		};
	}

	// #1861: Auto-detect workspace when not provided
	let workspace: string;
	let workspaceSource: string;
	try {
		const resolved = await resolveWorkspace(explicitWorkspace);
		workspace = resolved.workspace;
		workspaceSource = resolved.source;
	} catch {
		return {
			isError: true,
			content: [{ type: 'text', text: 'Le paramètre "workspace" est requis. Passez le chemin absolu du workspace, ex: "C:/dev/roo-extensions" ou "/home/user/project". L\'auto-détection n\'a pas pu résoudre le workspace (MCP roots indisponibles, WORKSPACE_PATH non configuré).' }]
		};
	}

	// Limiter le nombre de résultats
	const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
	const effectiveMinScore = Math.max(0, Math.min(1, min_score));
	// tests-rank-reranking (po-2024 c.194, GO ai-01 c.197): over-fetch a candidate pool so post-retrieval re-ranking (test-file malus +
	// per-file diversification, see block near result formatting) has headroom to work with.
	// Without this, capping a noisy file at 2 chunks would just shrink recall — there would be
	// no lower-ranked hits from other files to backfill the freed slots. 3× the requested limit
	// (capped at MAX_LIMIT) is enough cross-file headroom; the HNSW cost (hnsw_ef) is unchanged.
	const fetchLimit = Math.min(effectiveLimit * 3, MAX_LIMIT);

	try {
		// 1. Calculer les variantes possibles du nom de collection
		const primaryCollectionName = getWorkspaceCollectionName(workspace);
		const collectionVariants = getWorkspaceCollectionVariants(workspace);

		// 2. Trouver la collection existante (essayer toutes les variantes)
		const qdrant = getQdrantClient();
		let collectionName = '';
		// Tracks how the collection was resolved — 'hash' (normal) or 'content-match' (L1 fallback).
		let collectionResolvedBy: 'hash' | 'content-match' = 'hash';
		let contentMatchDetails: {
			jaccard: number; jaccard_threshold: number;
			overlap?: number; overlap_threshold?: number;
			shared_discriminant_dirs?: number; accepted_via?: 'jaccard' | 'overlap';
			selection_basis?: 'score' | 'liveness';
			liveness_ratio?: number; liveness_checked_paths?: number;
			liveness_flipped_selection?: boolean;
		} | undefined;
		// points_count of the hash-matched collection (if any). Used to detect the
		// "collection exists but is empty" blind-spot: the hash resolves to a real
		// collection that was never populated (e.g. the indexer hashed a different path
		// format → points went into another ws-* collection). (#2609/#2554 follow-up,
		// convergent finding web1 c.N+4 + po-2026 c.46: po-2023 sees 15 results from a
		// populated collection; web1/po-2026 get 0 from an empty one matched by hash.)
		let hashMatchedPointsCount: number | null = null;

		for (const variant of collectionVariants) {
			try {
				const collectionInfo = await withTransportRetry(() => qdrant.getCollection(variant));
				if (collectionInfo.status !== undefined) {
					collectionName = variant;
					hashMatchedPointsCount = (collectionInfo as any)?.points_count ?? null;
					break;
				}
			} catch (err) {
				// #2636: a 404 means "this variant doesn't exist" → try the next one;
				// a network/TLS error means the backend is down → stop and propagate so
				// the outer catch classifies it as qdrant_unreachable (not collection_not_found).
				if (isNetworkErrorLike(err)) throw err;
				// Cette variante n'existe pas, essayer la suivante
			}
		}


		// Phase B: Content-based fallback, then diagnostic (#2609/#2554 L1 fix)
		// #1085/#2455: Hash mismatches (backslash vs forward slash, case, file:// vs raw)
		// make the hash resolution miss the real collection even though the code IS indexed.
		// Convergent root-cause (po-2023 c.32 + po-2024 c.34): the hash is fundamentally
		// fragile cross-agent. Before returning an empty diagnostic, try matching the right
		// ws-* collection by CONTENT (its indexed top-level pathSegments vs the workspace's
		// actual directory structure on disk). If a strict match is found, serve it.
		//
		// TWO trigger conditions (follow-up to #644, finding web1 c.N+4 + po-2026 c.46):
		//  (1) No hash variant matched at all (`!collectionName`) — original case.
		//  (2) A hash variant matched a collection that EXISTS but is EMPTY
		//      (`hashMatchedPointsCount === 0`). The points went into another ws-* collection
		//      under a different hash; serving this empty one would return 0 results. Fall
		//      back to content-matching to find the populated one. The matched-but-empty
		//      collection is reset so the content-match can re-select the best candidate
		//      (including itself, if it turns out non-empty under a re-read — rare).
		const hashMatchedEmpty = collectionName !== '' && hashMatchedPointsCount === 0;
		if (hashMatchedEmpty) {
			collectionName = '';
		}
		if (!collectionName) {
			const allWsCollections = await listWorkspaceCollections();

			// Pre-sort candidates by points_count desc (heuristic: the indexed workspace is
			// usually a large collection; also caps cost by probing the biggest first).
			const ranked: { name: string; points: number }[] = [];
			for (const wsCol of allWsCollections) {
				try {
					const info = await qdrant.getCollection(wsCol);
					ranked.push({ name: wsCol, points: (info as any)?.points_count ?? 0 });
				} catch {
					ranked.push({ name: wsCol, points: -1 });
				}
			}
			ranked.sort((a, b) => b.points - a.points);
			const candidates = ranked.map(r => r.name);

			// Try content-based matching (STRICT threshold — never serve a low-confidence guess).
			const workspaceSignature = getWorkspaceRootSignature(workspace);
			const contentMatch = workspaceSignature
				? await findCollectionByContent(qdrant, candidates, workspaceSignature, workspace)
				: null;

			if (contentMatch) {
				// Strict content-match found — serve results from this collection.
				collectionName = contentMatch.name;
				collectionResolvedBy = 'content-match';
				// #2554/#2766: report BOTH metrics so observability shows how the match was
				// made — Jaccard alone would hide that an inflated workspace matched via overlap.
				// #2609 follow-up (ai-01, 2026-09-30): also NAME the criterion that accepted.
				// A live probe read `jaccard: 0.167 < threshold 0.6` alongside
				// resolved_by=content-match as self-contradictory — it isn't (the
				// overlap/containment path accepted), but the reader had to re-derive the
				// gate from source to know that. accepted_via says it in one field.
				contentMatchDetails = {
					jaccard: contentMatch.jaccard,
					jaccard_threshold: CONTENT_MATCH_MIN_JACCARD,
					overlap: contentMatch.overlap,
					overlap_threshold: CONTENT_MATCH_MIN_OVERLAP,
					shared_discriminant_dirs: contentMatch.sharedDiscriminants,
					accepted_via: contentMatch.jaccard >= CONTENT_MATCH_MIN_JACCARD ? 'jaccard' : 'overlap',
					// #2609 grain 3: what selected the served collection among accepted
					// candidates — liveness (share of sampled paths alive under this
					// workspace) or structural score — plus the winner's liveness numbers.
					selection_basis: contentMatch.selection_basis,
					...(contentMatch.liveness ? {
						liveness_ratio: Math.round(contentMatch.liveness.ratio * 1000) / 1000,
						liveness_checked_paths: contentMatch.liveness.checked,
					} : {}),
					...(contentMatch.liveness_flipped_selection ? { liveness_flipped_selection: true } : {}),
				};
			} else {
				// No strict content-match → honest diagnostic. Enrich with the collection
				// signatures we probed so the caller can identify theirs visually.
				// #3174 (defect 4): top_dirs rides on every existing_collections entry
				// UNCONDITIONALLY. The caller can list their own workspace's root dirs even
				// when we could not (worktree/hash-mismatch path leaves workspaceSignature
				// null and collection_signatures empty) — the diagnostic must still let
				// them self-identify. One payload-only scroll per diagnostic entry.
				const collectionDiagnostics = [];
				const sigByCollection = new Map<string, string[] | null>();
				for (const r of ranked.slice(0, 10)) {
					const sig = await getCollectionSignature(qdrant, r.name);
					const topDirs = sig?.dirs ? [...sig.dirs].slice(0, 8) : null;
					sigByCollection.set(r.name, topDirs);
					collectionDiagnostics.push({
						collection: r.name,
						points_count: r.points,
						status: r.points >= 0 ? 'green' : 'error',
						top_dirs: topDirs
					});
				}

				// Report how many candidates the fallback ACTUALLY probed, not how many
				// exist — with a cap, "over N collections" where N > scanned overstates
				// coverage and hides the cap as a failure mode (CoursIA-2 fleet finding).
				const scannedCandidates = Math.min(candidates.length, CONTENT_MATCH_MAX_CANDIDATES);

				// Legacy shape (kept for existing consumers): top-5 signature samples, only
				// when we could read the workspace dirs and compare them to something.
				// Reads the map populated above — no extra scroll calls.
				const signatureSamples: Record<string, string[]> = {};
				if (workspaceSignature) {
					for (const r of ranked.slice(0, 5)) {
						const dirs = sigByCollection.get(r.name);
						if (dirs && dirs.length > 0) signatureSamples[r.name] = dirs;
					}
				}

				return {
					isError: false,
					content: [{
						type: 'text',
						text: JSON.stringify({
							status: 'collection_not_found',
							message: `No Qdrant collection matching workspace "${workspace}" (primary hash: ${primaryCollectionName}). ${collectionVariants.length} hash variants tried + content-based fallback over ${scannedCandidates} of ${candidates.length} ws-* collections, no strict match. Acceptance is: ≥1 shared discriminant dir AND (Jaccard ≥ ${CONTENT_MATCH_MIN_JACCARD} OR (overlap ≥ ${CONTENT_MATCH_MIN_OVERLAP} AND ≥2 shared discriminant dirs)).`,
							hint: 'The workspace hash differs from what the indexer used AND no collection\'s indexed top-level dirs match yours strictly. Inspect the collection signatures below to identify yours, then re-index the workspace from Roo Code / Zoo Code on this machine, or report the path-format mismatch.',
							tried_variants: collectionVariants,
							primary_hash: primaryCollectionName,
							hash_matched_empty: hashMatchedEmpty,
							workspace: workspace,
							workspace_source: workspaceSource,
							workspace_signature: workspaceSignature ? [...workspaceSignature] : null,
							content_match_attempted: true,
							content_match_jaccard_threshold: CONTENT_MATCH_MIN_JACCARD,
							content_match_overlap_threshold: CONTENT_MATCH_MIN_OVERLAP,
							content_match_discriminant_dirs_required: { jaccard_path: 1, overlap_path: 2 },
							content_match_candidates_total: candidates.length,
							content_match_candidates_scanned: scannedCandidates,
							collection_signatures: signatureSamples,
							existing_collections: collectionDiagnostics,
							fallback_list_tried: true,
							troubleshooting: {
								ripgrep_vscode_1122: 'VS Code 1.122+ renamed ripgrep package to @vscode/ripgrep-universal. Roo Code 3.54 cannot find rg.exe → indexing never starts → collection stays empty. Workaround: copy rg.exe from new path to old path.',
								hash_mismatch: 'Path format differs between indexing (Roo Code fsPath) and search (Claude Code). Common on Windows: backslash vs forward slash, case differences, UNC prefixes.',
								action: 'Re-index the workspace from this machine via Roo Code, or verify the ripgrep binary is accessible.'
							}
						}, null, 2)
					}]
				};
			}
		}

		// #2609 V2(c)(b): partial-collection detection at resolution time. A
		// hash-matched but PARTIAL collection (V2(b): 883/5013, src/tools/roosync
		// absent) is served as-is — the L1 fallback only fires on miss/empty. This
		// surfaces the state in the response so callers can propose a reindex
		// instead of reading silence as coverage. Fail-open: no `coverage` block
		// when the ratio is undecidable (scroll error, workspace not on disk).
		let coverage: CoverageInfo | null = null;
		try {
			coverage = await computeCollectionCoverage(qdrant, collectionName, workspace);
		} catch {
			coverage = null;
		}

		// 3. Générer l'embedding de la requête (uses dedicated codebase embedding client)
		// #3279: Fast-fail check BEFORE the 60s OpenAI client timeout. If the breaker
		// is open, return immediately with an informative error pointing to the
		// non-semantic fallback (roosync_search text, or our own tryTextFallback).
		if (isCodebaseEmbeddingBreakerOpen()) {
			return buildBreakerOpenResponse(query, workspace);
		}

		const embeddingClient = getCodebaseEmbeddingClient();
		const embeddingModel = getCodebaseEmbeddingModel();

		let queryVector: number[];
		try {
			const embeddingResponse = await embeddingClient.embeddings.create({
				model: embeddingModel,
				input: query
			});
			// #3999: valider la réponse AVANT de la pousser dans Qdrant — une
			// réponse vide/malformée (quota, erreur partielle) donnait un vecteur
			// undefined qui échouait en aval, loin de la cause. Pas de pin de
			// dimension ici : la collection peut différer de EMBEDDING_DIMENSIONS
			// (pipeline skeleton) — un mismatch de dimension Qdrant reste explicite.
			const rawVector = embeddingResponse.data?.[0]?.embedding;
			if (!Array.isArray(rawVector) || rawVector.length === 0 || !rawVector.every(Number.isFinite)) {
				throw new Error(`Réponse embedding invalide du modèle ${embeddingModel} (vide ou malformée) — #3999`);
			}
			queryVector = rawVector;
			// #3279: success — close the breaker if it was previously open
			recordCodebaseEmbeddingSuccess();
		} catch (embeddingError) {
			// #3279: Auth errors (401/403) are PERSISTENT — no point in retrying or fallback.
			// Skip the breaker/fallback and let the outer classifier surface the auth failure.
			const errorMsg = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
			const errorStatus = (embeddingError as any)?.status || (embeddingError as any)?.response?.status;
			const isAuthError = errorStatus === 401 || errorStatus === 403 ||
				errorMsg.includes('API key') || errorMsg.includes('Unauthorized') || errorMsg.includes('Forbidden');
			if (isAuthError) {
				const tagged = embeddingError instanceof Error
					? Object.assign(embeddingError, { __codebase_search_source: 'embedding' as const })
					: new Error(errorMsg);
				if (!(embeddingError instanceof Error)) (tagged as any).__codebase_search_source = 'embedding';
				throw tagged;
			}
			// #3279: Network/timeout/unexpected — record failure (opens breaker for TTL),
			// then attempt text fallback so the agent gets SOMETHING instead of a dead error.
			recordCodebaseEmbeddingFailure(errorMsg);
			const fallbackResult = await tryTextFallback(qdrant, collectionName, query, effectiveLimit, directory_prefix, workspace);
			if (fallbackResult) {
				return fallbackResult;
			}
			// Fallback itself failed — tag the error as embedding-originated so the outer
			// classifier routes it to embedding_unreachable/embedding_timeout instead of
			// misclassifying it as qdrant_unreachable (see classifier: 'embedding' branch).
			const tagged = embeddingError instanceof Error
				? Object.assign(embeddingError, { __codebase_search_source: 'embedding' as const })
				: new Error(errorMsg);
			if (!(embeddingError instanceof Error)) (tagged as any).__codebase_search_source = 'embedding';
			throw tagged;
		}

		// 4. Construire le filtre si directory_prefix fourni
		let filter: any = {
			must_not: [
				{ key: 'type', match: { value: 'metadata' } },
				// #1178: Exclude roo-code/ submodule (reference only)
				{ key: 'pathSegments.0', match: { value: 'roo-code' } },
				// Exclude i18n directories
				{ key: 'pathSegments.0', match: { value: 'i18n' } },
			]
		};

		if (directory_prefix) {
			// Normaliser le préfixe de répertoire
			const normalizedPrefix = directory_prefix.replace(/\\/g, '/').replace(/^\.\//, '');
			const segments = normalizedPrefix.split('/').filter(Boolean);

			if (segments.length > 0) {
				// Qdrant only indexes pathSegments.0 through pathSegments.4 (5 levels).
				// Filtering on unindexed levels with HNSW approximate search returns 0 results
				// because post-filter on ANN candidates eliminates everything.
				// Cap at 5 segments to match the indexed depth. (#797)
				const MAX_INDEXED_DEPTH = 5;
				const cappedSegments = segments.slice(0, MAX_INDEXED_DEPTH);
				filter.must = cappedSegments.map((segment, index) => ({
					key: `pathSegments.${index}`,
					match: { value: segment }
				}));
			}
		}

		// 5. Effectuer la recherche
		// #2267: Use native Qdrant timeout (seconds) to prevent indefinite hangs.
		// Follows #1275 convention used in task-searcher.ts and search-semantic.tool.ts.
		const searchTimeoutSec = Math.ceil(parseInt(process.env.QDRANT_SEARCH_TIMEOUT_MS || '30000', 10) / 1000);
		const searchResults = await withTransportRetry(() => qdrant.query(collectionName, {
			query: queryVector,
			filter: filter,
			score_threshold: effectiveMinScore,
			limit: fetchLimit,
			params: {
				hnsw_ef: 256,
				exact: false
			},
			timeout: searchTimeoutSec,
			with_payload: {
				include: ['filePath', 'codeChunk', 'startLine', 'endLine', 'pathSegments']
			}
		}));

		// 6. Formater les résultats
		// #2609/#2554: post-filter dead paths (orphans from rename/delete that the
		// roo-code indexer failed to GC). Filter only AFTER building the full candidate
		// list so we can detect the degenerate case where every hit is dead (e.g. wrong
		// workspace root, unmounted drive) and avoid silently returning 0 results.
		const rawHits: any[] = (searchResults.points || [])
			.filter((p: any) => p.payload?.filePath && p.payload?.codeChunk);

		const liveHits: any[] = [];
		let deadPathsFiltered = 0;
		for (const point of rawHits) {
			if (isFilePathReachable(point.payload.filePath, workspace)) {
				liveHits.push(point);
			} else {
				deadPathsFiltered++;
			}
		}

		// Safety: if filtering killed ALL hits, the workspace root is likely wrong or
		// the drive is unmounted — return the raw hits with a warning instead of an
		// empty list, so the caller gets a signal rather than a silent zero.
		const allDead = rawHits.length > 0 && liveHits.length === 0;
		const finalHits = allDead ? rawHits : liveHits;
		if (allDead) {
			deadPathsFiltered = 0; // rawHits returned as-is, nothing actually filtered out
		}

		// tests-rank-reranking (po-2024 c.194 investigation, GO ai-01 c.197): post-retrieval re-ranking to
		// counter the test-files-rank-above-source asymmetry. text-embedding-3-small scores
		// descriptive test titles (natural-language intent like 'should allow sending between
		// workspaces') higher than the code source they test — the source carries syntactic
		// noise (generics, types, modifiers) that dilutes the signal. Measured firsthand
		// po-2024: test-title chunk 0.72 vs source chunk 0.68 on identical intent. The code
		// chunking lives in Roo Code (reference-only submodule); both correctives below are
		// post-retrieval only, no submodule change.
		//
		// B — test-file malus: nudge test files down (×0.95) so a source chunk within ~0.047
		//     of a test outranks it. Tests stay visible (degraded, not removed).
		// A — per-file diversification: a single noisy file can otherwise occupy most slots
		//     (measured: task-indexer.test.ts = 5/8). Cap at 2 chunks/file, backfill by score.
		// #3172 — fixture-file malus (×0.8): tests/fixtures/** captures embed source code as
		//     JSON strings, so they match code queries as well as the code itself and outrank
		//     the original (measured ai-01: fixture 0.702 above source, 2026-08-19). A fixture
		//     is never the actionable answer to "find the code that does X" — stronger malus
		//     than tests, still visible (degraded, not removed), multiplicative if both apply.
		const TEST_FILE_RE = /[\\/]__tests__[\\/]|\.test\.|\.spec\./;
		const TEST_FILE_MALUS = 0.95;
		const FIXTURE_FILE_RE = /(^|[\\/])tests[\\/]fixtures[\\/]/;
		const FIXTURE_FILE_MALUS = 0.8;
		// #2609 V2 — data/config-file malus (×0.75). V2 names three confusable classes —
		//     "data / config / fixtures". Tests (×0.95) and fixtures (×0.8) were demoted;
		//     data/config files were not, and they won. Measured po-2024 2026-09-21, query
		//     `unified store Postgres join filters Qdrant semantic search results`: two
		//     `roo-config/baselines/*.json` entries took ranks 1-2 at 0.8849 — ABOVE every
		//     source chunk (best .ts 0.821) and with ZERO hit on the file that implements the
		//     JOIN. A config VALUE quotes the query vocabulary verbatim; the code that
		//     implements it carries syntactic noise. ×0.75 puts the measured 0.8849 at
		//     0.6637, below the real source hits, while staying visible (degraded, not
		//     removed) — a "where is X configured" query still finds its file.
		//     PRECEDENCE, not multiplication: a path already classified test/fixture is a
		//     captured blob the #3172 contract keeps VISIBLE at ×0.8. Compounding a second
		//     malus (0.8 × 0.75 = 0.6) would push a 0.70 fixture to 0.42, under min_score
		//     0.5 — i.e. silently remove it from recall. Those two classes are untouched.
		const DATA_FILE_RE = /\.(json|jsonc|json5|ya?ml|csv|tsv|ini|toml|lock)$/i;
		const DATA_FILE_MALUS = 0.75;
		// #3174 (defect 3) — archive-file malus (×0.7): docs/archive/** carries
		// stale-by-design reports that quote current vocabulary verbatim, so they match
		// fresh queries as well as the living code and outrank it (measured po-2025
		// 2026-09-22: 2 docs/archive/reports/** hits in the top-8 of the
		// MAX_DASHBOARD_SIZE_BYTES probe, 0 hit on the real source; corroborated web1
		// c.287/c.488). ×0.7 (not the 0.5 floated in the issue) keeps the contract
		// "degraded, not removed": the measured archive hits sit at 0.72-0.75, and ×0.5
		// would push them under min_score 0.5 — silently removing them from recall,
		// exactly what the #2609 V2 precedence note forbids. PRECEDENCE over data, same
		// rationale: docs/archive/foo.json is first an archived document; compounding
		// 0.7 × 0.75 = 0.525 would drop a 0.75 archived config to 0.39.
		// #2609 V2(b) follow-up (po-2025, 2026-09-28) — the probe's negative is
		// a CORPUS defect, not a ranking one. Same query on two collections of
		// this workspace: the hash-resolved one (ws-d2ffd…) holds NO
		// src/tools/roosync chunk at all — dashboard.ts absent, so no lever
		// (malus or bonus) can surface the source there; a fresh twin of the
		// same repo returns the DEFINING source rank 1 (DashboardSizes
		// interface, the declaration site of the threshold; 0.7607 above the
		// tools-list script at 0.7587). The `const` line itself can never be a
		// chunk: the indexer drops nodes under MIN_BLOCK_CHARS=50 (roo-code
		// parser.ts:180/226) and the const is 43 chars — "definition in top-3"
		// can only mean the declaration site, on a corpus that holds the file.
		const ARCHIVE_FILE_RE = /(^|[\\/])docs[\\/]archive[\\/]/;
		const ARCHIVE_FILE_MALUS = 0.7;
		// #2609 V2(a) — compiled-build malus (×0.7): `build-<hash>/` vintages and the
		//     `build-out/` staging dir are compiled derivatives of the source — a
		//     near-verbatim echo of the query vocabulary without the type noise, and STALE
		//     by construction (only the marker's vintage is live). Measured ai-01
		//     2026-09-27, golden scenario 3 re-run: the TOP source hits of the verbatim
		//     baseline query were `…/build-80b4b9a14965a403/…` and `…/build-out/…`
		//     compiled copies, above every living source chunk. Same family as
		//     #3172/#1180: a derivative is never the actionable answer to "find the code
		//     that does X". Degraded, not removed — an agent debugging the LIVE deployed
		//     vintage can still find it. PRECEDENCE over data (build-x/foo.json is first
		//     a compiled artifact), same rationale as archive-over-data.
		// Only the three real compiled forms: bare `build/`, a hashed vintage `build-<hex>/`
		// and the `build-out/` staging dir. `build(-[a-z0-9]+)?` also caught source dirs such
		// as `build-tools/` or `build-helpers/` (malussed AND merged into another file's cap
		// budget). Keep this pattern and capKeyOf's below identical.
		const BUILD_DIR_RE = /(^|[\\/])build(-[a-f0-9]{8,}|-out)?[\\/]/i;
		const BUILD_DIR_MALUS = 0.7;
		const MAX_CHUNKS_PER_FILE = 2;

		// Single source of truth for the malus: ranking and the rendered `score` MUST agree.
		// Computing the factor twice is exactly how a "rank 2 / score 0.9" contradiction is
		// born (see the adjacent note on exposing the ADJUSTED score).
		const classifyFilePath = (fp: string) => {
			const isTestFile = TEST_FILE_RE.test(fp);
			const isFixtureFile = FIXTURE_FILE_RE.test(fp);
			const isArchiveFile = ARCHIVE_FILE_RE.test(fp);
			const isBuildDirFile = BUILD_DIR_RE.test(fp);
			const isDataFile = !isTestFile && !isFixtureFile && !isArchiveFile && !isBuildDirFile && DATA_FILE_RE.test(fp);
			const factor = (isTestFile ? TEST_FILE_MALUS : 1)
				* (isFixtureFile ? FIXTURE_FILE_MALUS : 1)
				* (isArchiveFile ? ARCHIVE_FILE_MALUS : 1)
				* (isBuildDirFile ? BUILD_DIR_MALUS : 1)
				* (isDataFile ? DATA_FILE_MALUS : 1);
			return { isTestFile, isFixtureFile, isArchiveFile, isBuildDirFile, isDataFile, factor };
		};

		const adjusted: { point: any; score: number }[] = finalHits
			.map((point: any) => {
				const fp = String(point.payload.filePath || '');
				return { point, score: point.score * classifyFilePath(fp).factor };
			})
			// Re-apply min_score on the ADJUSTED (post-malus) score. Qdrant already filters on
			// the RAW score (score_threshold above), but a test file at raw 0.71 passes a 0.70
			// threshold, gets malussed to 0.6745, and would otherwise be returned — contradicting
			// min_score_used. Filtering BEFORE the per-file cap ensures a threshold-eliminated hit
			// doesn't consume a slot of its file (then get dropped, wasting the slot).
			.filter(a => a.score >= effectiveMinScore);
		adjusted.sort((a, b) => b.score - a.score);

		// Per-file cap (A): greedy walk by adjusted score, then backfill with leftovers so
		// recall is preserved when the cap drops hits below the requested limit.
		// #2609 V2(a): the cap key strips the compiled-vintage component (`build-<hash>/`,
		// `build-out/`) — measured live 2026-09-27, golden scenario 3: the same logical file
		// existed as 4 path-distinct copies (3 vintages + staging) and occupied up to 6 of
		// 15 slots, each with its own cap budget. Keyed on the LOGICAL file, the compiled
		// copies share one budget and the freed slots backfill with distinct files.
		const capKeyOf = (fp: string) => fp.replace(/(^|[\\/])build(-[a-f0-9]{8,}|-out)?[\\/]/ig, '');
		// #2609 V2(a): per-call cache of file contents read for block expansion
		// (multiple hits in one file must not re-read it). null = unreadable/skipped.
		const fileLinesCache = new Map<string, string[] | null>();
		// #2609 V2 follow-up (ai-01, 2026-09-30): expansion PRE-PASS on the sorted pool.
		// The measured duplicate (golden q3) was two ADJACENT stored lines (198, 199)
		// that each expanded to an overlapping block (183-213, 184-214) — strict overlap
		// on stored lines cannot see it, so each hit's range is computed (expanded block
		// when expansion applies, stored lines otherwise — the same predicate as render)
		// and the merge runs on those ranges, BEFORE the cap, so the freed budget
		// backfills with a distinct file instead of a near-duplicate echo. Bounded by
		// the over-fetch pool (fetchLimit = 3 × limit), file reads cached per file.
		const withRanges = adjusted.map((a: { point: any; score: number }) => {
			const fp = String(a.point.payload.filePath || '');
			const { isFixtureFile, isArchiveFile, isDataFile } = classifyFilePath(fp);
			const expandable = !isFixtureFile && !isArchiveFile && !isDataFile
				&& BLOCK_EXPANSION_SOURCE_RE.test(fp)
				&& typeof a.point.payload.startLine === 'number';
			const expanded = expandable
				? expandHitBlock(fp, a.point.payload.startLine, String(a.point.payload.codeChunk || ''), workspace, fileLinesCache)
				: null;
			const s = expanded ? expanded.startLine
				: (typeof a.point.payload.startLine === 'number' ? a.point.payload.startLine : null);
			const e = expanded ? expanded.endLine
				: (typeof a.point.payload.endLine === 'number' ? a.point.payload.endLine : null);
			return { point: a.point, score: a.score, expanded, range: (s !== null && e !== null) ? { s, e } : null };
		});
		const { kept: dedupedAdjusted, merged: overlappingChunksMerged } = dropOverlappingWindows(withRanges, capKeyOf);
		const perFileCount = new Map<string, number>();
		const picked: { point: any; score: number; expanded: any }[] = [];
		const leftovers: { point: any; score: number; expanded: any }[] = [];
		for (const a of dedupedAdjusted) {
			const fp = String(a.point.payload.filePath || '');
			const capKey = capKeyOf(fp);
			if ((perFileCount.get(capKey) || 0) < MAX_CHUNKS_PER_FILE) {
				picked.push(a);
				perFileCount.set(capKey, (perFileCount.get(capKey) || 0) + 1);
			} else {
				leftovers.push(a);
			}
		}
		for (const a of leftovers) {
			if (picked.length >= effectiveLimit) break;
			picked.push(a);
		}
		const rankedHits = picked.slice(0, effectiveLimit);
		let testFileMalusApplied = 0;
		let fixtureMalusApplied = 0;
		let dataFileMalusApplied = 0;
		let archiveMalusApplied = 0;
		let buildDirMalusApplied = 0;
		let blockExpansionApplied = 0;

		const results = rankedHits.map((hit) => {
			const point = hit.point;
			const fp = String(point.payload.filePath || '');
			const { isTestFile, isFixtureFile, isDataFile, isArchiveFile, isBuildDirFile, factor } = classifyFilePath(fp);
			if (isTestFile) testFileMalusApplied++;
			if (isFixtureFile) fixtureMalusApplied++;
			if (isDataFile) dataFileMalusApplied++;
			if (isArchiveFile) archiveMalusApplied++;
			if (isBuildDirFile) buildDirMalusApplied++;
			// Expose the adjusted (post-malus) score so the value matches the rank order;
			// an unadjusted test at 0.72 ranked below a source at 0.68 would otherwise read
			// as a contradiction. The raw cosine is not surfaced (the order is the signal).
			const adjustedScore = point.score * factor;
			// #2609 V2(a): expand source-code hits to their enclosing declaration block,
			// read from the CURRENT file on disk (anchor-verified against the stored chunk;
			// see expandHitBlock). The rendered snippet becomes the block passage, and
			// start_line/end_line become the BLOCK range — the honest handle an agent can
			// open directly. The line(s) the vector actually matched stay as `match_lines`.
			// Skipped for fixtures (embedded code inside a JSON container — #3172 contract:
			// line fields stay omitted), archives (stale-by-design docs) and data/config
			// files (no block structure); those keep the raw extractSnippet shape.
			// #2609 V2 follow-up: the expansion now runs in the PRE-PASS above (the merge
			// needs the block ranges before the cap) — reuse it here, never re-expand.
			const expanded = hit.expanded;
			if (expanded) blockExpansionApplied++;
			// #3172: a fixture chunk embeds source code inside a JSON capture — the stored
			// startLine/endLine point at the single-line JSON container, not at the embedded
			// code shown in the snippet ("1-1" navigates to nothing). Omit the line fields
			// rather than render numbers that lead nowhere; the snippet keeps the real line.
			const lineFields = isFixtureFile ? {} : expanded ? {
				start_line: expanded.startLine,
				end_line: expanded.endLine,
				lines: `${expanded.startLine}-${expanded.endLine}`,
				match_lines: point.payload.startLine && point.payload.endLine
					? `${point.payload.startLine}-${point.payload.endLine}`
					: String(point.payload.startLine)
			} : {
				start_line: point.payload.startLine,
				end_line: point.payload.endLine,
				lines: point.payload.startLine && point.payload.endLine
					? `${point.payload.startLine}-${point.payload.endLine}`
					: undefined
			};
			return {
				file_path: point.payload.filePath,
				score: adjustedScore,
				relevance: interpretScore(adjustedScore),
				snippet: expanded ? expanded.text : extractSnippet(point.payload.codeChunk || '', query),
				...lineFields
			};
		});

		// #2609/#2554: warn when the dead-path filter shrank recall below the requested
		// limit in the PARTIAL case (some hits live, some dead). Without this, a caller
		// asking for `limit: 5` could silently receive 3 results with no signal that 2
		// candidates were unreachable orphan vectors. Mutually exclusive with the allDead
		// warning (allDead resets deadPathsFiltered to 0, so this guard never fires then).
		const recallShrankBelowLimit = !allDead
			&& deadPathsFiltered > 0
			&& results.length < effectiveLimit;

		// 7. Construire la réponse
		const response = {
			status: 'success',
			query: query,
			workspace: workspace,
			workspace_source: workspaceSource,
			collection: collectionName,
			// #2609/#2554 L1: how the collection was resolved. 'content-match' means the
			// hash missed and we identified the right ws-* collection by its indexed
			// top-level dirs vs the workspace's actual directory structure.
			collection_resolved_by: collectionResolvedBy,
			...(contentMatchDetails ? { content_match: contentMatchDetails } : {}),
			// #2609 V2(c)(c): the build vintage serving this response — makes probes
			// comparable across machines (divergent rankings ≠ divergent code when
			// hosts serve different vintages; see getServedBuildId).
			served_build: getServedBuildId(),
			// #2609 V2(c)(b): partial-collection observability (computeCollectionCoverage).
			// Absent when undecidable — never a fabricated ratio.
			...(coverage ? { coverage } : {}),
			...(coverage?.below_threshold ? {
				coverage_warning: `collection ${collectionName} is PARTIAL: ${coverage.indexed_files}/${coverage.eligible_files} eligible workspace files indexed (ratio ${coverage.coverage_ratio} < ${coverage.warn_threshold}). Files absent from the corpus cannot be retrieved by any ranking — re-index this workspace (Roo/Zoo Code codebase index on this machine) to repair.`
			} : {}),
			// #2609 grain 3: the resolved collection itself is decaying — most of its
			// sampled indexed paths no longer exist under this workspace. Its hits are
			// dead paths no ranking can revive; only a re-index repairs.
			...(contentMatchDetails?.liveness_ratio !== undefined
				&& contentMatchDetails.liveness_ratio < CONTENT_MATCH_LIVENESS_WARN_RATIO ? {
				liveness_warning: `collection ${collectionName} is DECAYING: only ${contentMatchDetails.liveness_ratio} of its sampled indexed paths still exist under this workspace (stale twin collection). Re-index this workspace (Roo/Zoo Code codebase index) to repair.`
			} : {}),
			results_count: results.length,
			min_score_used: effectiveMinScore,
			// #2609/#2554: dead-path filtering observability
			...(deadPathsFiltered > 0 ? { dead_paths_filtered: deadPathsFiltered } : {}),
			// tests-rank-reranking: test-file re-ranking observability — how many returned hits had the
			// ×0.95 malus applied (tests ranked above source by raw cosine; see block above).
			...(testFileMalusApplied > 0 ? { test_file_malus_applied: testFileMalusApplied } : {}),
			// #3172: fixture-file malus observability — hits from tests/fixtures/** demoted ×0.8.
			...(fixtureMalusApplied > 0 ? { fixture_malus_applied: fixtureMalusApplied } : {}),
			// #2609 V2: data/config-file malus observability — hits from data/config files demoted ×0.75.
			...(dataFileMalusApplied > 0 ? { data_file_malus_applied: dataFileMalusApplied } : {}),
			// #3174 (defect 3): archive-file malus observability — hits from docs/archive/** demoted ×0.7.
			...(archiveMalusApplied > 0 ? { archive_malus_applied: archiveMalusApplied } : {}),
			// #2609 V2(a): compiled-build malus observability — hits from build(-<hash>)/** demoted ×0.7.
			...(buildDirMalusApplied > 0 ? { build_dir_malus_applied: buildDirMalusApplied } : {}),
			// #2609 V2(a): block-expansion observability — how many hits were rendered as
			// their enclosing declaration block (snippet = block, start/end_line = block
			// range, match_lines = the lines the vector matched). Rollback:
			// CODEBASE_BLOCK_EXPANSION=0.
			...(blockExpansionApplied > 0 ? { block_expansion_applied: blockExpansionApplied } : {}),
			// #2609 V2 follow-up: overlapping-window merge observability — same-file
			// chunks whose line windows overlap (or abut ≤2 lines) were folded into the
			// higher-scored window, freeing their slot(s) for a distinct file.
			...(overlappingChunksMerged > 0 ? { overlapping_chunks_merged: overlappingChunksMerged } : {}),
			...(allDead ? { warning: 'all hits resolved to dead paths — workspace root may be wrong or drive unmounted; returning raw results unfiltered' } : {}),
			// #2609: the repair hint must match the store it names — dead-path vectors live in
			// THIS ws-* code collection, which cleanup_orphans never touches (it only covers
			// the conversation collection roo_tasks_semantic_index). The old hint pointed at
			// cleanup_orphans, an action that fixes nothing here.
			...(recallShrankBelowLimit ? { warning: `dead-path filter reduced recall: ${deadPathsFiltered} of ${rawHits.length} candidate hits unreachable, results_count=${results.length} < limit=${effectiveLimit} (repair: re-index this workspace to replace dead-path vectors)` } : {}),
			results: results
		};

		return {
			isError: false,
			content: [{
				type: 'text',
				text: JSON.stringify(response, null, 2)
			}]
		};

	} catch (error) {
		// #2063 P1: Classified error reporting for actionable diagnostics
		// #3279: If the error was tagged by the embedding sub-catch, route it through the
		// embedding-classifier branch (which handles embedding_unreachable / embedding_timeout)
		// instead of misclassifying it as qdrant_unreachable under operation='codebase_search'.
		const operation: 'embedding' | 'codebase_search' =
			(error as any)?.__codebase_search_source === 'embedding' ? 'embedding' : 'codebase_search';
		const classified = await classifySearchError(error, operation);

		return {
			isError: true,
			content: [{
				type: 'text',
				text: JSON.stringify({
					status: classified.mode,
					message: classified.message,
					hint: classified.hint,
					error: classified.originalError
				}, null, 2)
			}]
		};
	}
}

/**
 * Export de la définition pour le registry
 */
export const codebaseSearchToolDefinition = {
	definition: codebaseSearchTool,
	handler: handleCodebaseSearch
};
