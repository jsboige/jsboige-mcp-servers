/**
 * #4736 P1 — the shared `ws-*` collection contract: naming, resolution, probe.
 *
 * Zoo Code (formerly Roo Code) keyed its code index on the workspace path:
 * `ws-` + sha256(fsPath)[0:16], the path being VS Code's raw fsPath with its
 * native case and separators (vector-store/qdrant-client.ts:81-83). Until now
 * that formula lived only in the reader (search-codebase.tool.ts), and the
 * reader still could not reach roo-extensions' own collection by hash — it
 * found it by content match (#2609/#2554). With Zoo decommissioned fleet-wide
 * (08/11/2026), RSM becomes the writer too (user decision 14/11/2026), and a
 * writer that recomputed the name its own way would mint a THIRD twin
 * collection beside the canonical and the decaying one — the exact pathology
 * the liveness preference fights.
 *
 * This module is therefore the ONE contract both sides import: the naming
 * formula, the path-variant ladder, the content-match fallback and the
 * liveness preference that the reader applies, verbatim. The search tool
 * re-exports every moved name so existing imports keep resolving — the
 * identity is pinned by test (same function object, not a copy).
 *
 * P1 is read-only: nothing here writes. `probeWorkspaceCollections` replays
 * the reader's resolution with getCollection/scroll only and returns, per
 * variant, the existence, points_count and the VECTOR CONFIG (size, distance)
 * the future writer must mirror and never recreate (#4736 risk 2).
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { resolve, sep } from 'path';
import { v5 as uuidv5 } from 'uuid';
import { ZOO_CODE_BLOCK_NAMESPACE } from './zoo-parity.js';

// ─── Naming (the Zoo formula) ─────────────────────────────────────────────────

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

// ─── Vector config parsing (shared with the supplement template read) ─────────

/**
 * Parses the vectors config out of a Qdrant `getCollection` response: size and
 * distance, handling the named-vectors shape (`vectors: { default: {...} }`).
 * Extracted from #4352's `readTemplateVectorConfig` so the ws-* probe and the
 * sup-* template read parse the SAME shapes — two parsers here would drift on
 * exactly the field the future writer must mirror (#4736 risk 2).
 * Null when the response holds no usable vectors config.
 */
export function parseVectorsConfig(info: any): { size: number; distance: string } | null {
	const params = info?.config?.params?.vectors ?? info?.result?.config?.params?.vectors;
	const named = params && typeof params === 'object' && !Array.isArray(params) && typeof params.size !== 'number'
		? (Object.values(params)[0] as any)
		: params;
	if (named && typeof named.size === 'number') {
		return { size: named.size, distance: String(named.distance ?? 'Cosine') };
	}
	return null;
}

// ─── Content-based collection matching (moved verbatim from the reader) ───────

/** Strict similarity threshold (Jaccard) below which we refuse to serve a content-matched collection. */
export const CONTENT_MATCH_MIN_JACCARD = 0.6;
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
export const CONTENT_MATCH_MIN_OVERLAP = 0.6;
/** Generic directory names that are NOT discriminant — excluded from the "discriminant dir" requirement. */
export const GENERIC_DIRS = new Set([
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
export const CONTENT_MATCH_MAX_CANDIDATES = parseInt(process.env.CONTENT_MATCH_MAX_CANDIDATES || '64', 10);

/**
 * Build the "signature" of a workspace = the set of top-level directory names on disk.
 * Used to match against a ws-* collection's indexed pathSegments.0.
 * Best-effort: returns null on any FS error (e.g. workspace not mounted) so the caller
 * can skip content-matching rather than crash.
 */
export function getWorkspaceRootSignature(workspaceRoot: string): Set<string> | null {
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
export async function getCollectionSignature(
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

// ─── #2609 grain 3: liveness preference at content-match resolution ───────────
// Measured live (ai-01, 2026-10-04): among accepted candidates, the content-match picks
// purely by structural score (points_count-desc order + score tie-break). The decaying
// twin ws-59e7574de63c6e62 (398 567 pts, liveness 0.751 — dead build-vintage dirs) was
// served over the repaired ws-d2ffdbaa832aed16 (328 245 pts, liveness 0.954), and golden
// q3 returned 12/15 unopenable paths. Structural similarity cannot see that a collection
// indexes files that no longer exist under the requested workspace — only the disk can.

/** Rollback: CONTENT_MATCH_LIVENESS=0 restores pure structural-score selection. */
export function isContentMatchLivenessEnabled(): boolean {
	return process.env.CONTENT_MATCH_LIVENESS !== '0';
}
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

// ─── #4863: the RSM ws-writer signal, reader-side ──────────────────────────────
// A reader seat whose checkout spelling differs from the writer's resolves its
// own path hash and can be served a writer-less legacy twin that liveness cannot
// disqualify (its files still exist — measured on po-2024: ws-59e7574de63c6e62,
// 571 554 pts, 0.900 live, no writer, served over the canonical ws-d2ffdbaa832aed16
// the web1 loop refreshes). The missing discriminator travels WITH the corpus:
// the writer claims a sentinel point inside the collection on every non-dry pass
// (ws-index-writer claimWsWriter), so any seat can read who refreshes it — no
// shared state, no path spelling. Liveness says "files exist"; the sentinel says
// "a loop refreshes this". Liveness alone is not freshness.

/**
 * The ws-writer sentinel's fixed point id — Zoo's own code-block namespace (an
 * id space, nothing more), under a name Zoo never mints. Distinct from Zoo's
 * `__indexing_metadata__` marker, which this writer never touches.
 * Homed in this module (#4863): the sentinel is a READER+WRITER contract (the
 * reader probes it as the freshness signal above); ws-index-writer re-exports
 * it so existing imports keep resolving — one definition, not two.
 */
export const WS_WRITER_SENTINEL_ID = uuidv5('__rsm_ws_writer__', ZOO_CODE_BLOCK_NAMESPACE);

/** What the reader needs from the sentinel: who writes this collection, since when. */
export interface WsWriterSignal {
	writer: string;
	since: string;
}

/** Rollback for the whole #4863 feature: preference, probes and response block. */
export function isWriterSignalEnabled(): boolean {
	return process.env.WRITER_SIGNAL !== '0';
}

/**
 * Bounds each sentinel probe. Same class as resolveVariantLivenessTimeout: a
 * NaN/≤0 bound would fire setTimeout at ~0 ms and read every probe as
 * undecidable, silently disarming the preference — an env typo must never
 * become an accidental off switch. Invalid values fall back to 1500 ms.
 */
export function resolveWriterProbeTimeout(raw: string | undefined): number {
	const t = parseFloat(raw ?? '1500');
	return Number.isFinite(t) && t > 0 ? t : 1500;
}

/**
 * Reader-side, fail-open probe of the ws-writer sentinel (#4863).
 *
 *   signal    = the collection is written (refreshed) by that lane since `since`
 *   null      = the collection was READ and holds no sentinel — writer-less,
 *               the frozen-corpus case the response must flag
 *   undefined = undecidable (client has no method, transport error, timeout)
 *
 * The writer path keeps its own THROWING read (ws-index-writer readWsWriterRecord:
 * a failed read must refuse a write). The reader inverts that posture — a failed
 * read must not break a search; it only forfeits the preference and the warning.
 */
export async function probeWsWriterSentinel(
	client: CollectionReader,
	collection: string,
	options: { timeoutMs?: number } = {},
): Promise<WsWriterSignal | null | undefined> {
	const parse = (payload: any): WsWriterSignal | null =>
		payload && typeof payload.writer === 'string'
			? { writer: payload.writer, since: String(payload.since ?? '') }
			: null;
	// A late rejection of a race already lost to the timeout must stay handled
	// (same class as the searchPromise note in search-codebase.tool.ts).
	const read: Promise<WsWriterSignal | null | undefined> = (async () => {
		if (typeof client.retrieve === 'function') {
			const res: any = await client.retrieve(collection, {
				ids: [WS_WRITER_SENTINEL_ID],
				with_payload: true,
				with_vector: false,
			});
			// The pinned SDK unwraps retrieve to a bare array; raw HTTP answers {result: [...]}.
			const points = Array.isArray(res) ? res : Array.isArray(res?.result) ? res.result : [];
			return parse(points[0]?.payload);
		}
		if (typeof client.scroll === 'function') {
			const res: any = await client.scroll(collection, {
				filter: { must: [{ has_id: [WS_WRITER_SENTINEL_ID] }] },
				limit: 1,
				with_payload: true,
				with_vector: false,
			});
			return parse((res?.points ?? res?.result?.points ?? [])[0]?.payload);
		}
		return undefined;
	})().catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), options.timeoutMs ?? 1500); });
	try {
		return await Promise.race([read, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// ─── #2609 q3: liveness preference at HASH-VARIANT resolution ─────────────────
// #4352 taught the variant ladder to probe every spelling at once and serve the
// LARGEST collection. Measured po-2023, 2026-10-31: that rule served the decaying
// twin. Points count is a proxy for "live corpus" that inverts exactly when a stale
// collection accumulated junk — the bigger one won every query, and the q3 golden
// never surfaced from it. Liveness now decides among the variants that exist; points
// only break ties. Gated by CONTENT_MATCH_LIVENESS, so `=0` restores the pure #4352
// points ranking — one rollback for both paths.

export interface VariantCandidate {
	name: string;
	points: number | null;
}

/**
 * Bounds each probe — a hung scroll must never hold a search (measured: pending
 * scroll = 15 s timeout). Invalid (NaN/≤0) values fall back to the default: a NaN
 * delay makes setTimeout fire at ~0 ms, every probe reads null, and the preference
 * falls back to points ranking WITHOUT A WORD — an env typo must never silently
 * disarm the rule (review ms#1599, blocking hold 2).
 */
export function resolveVariantLivenessTimeout(raw: string | undefined): number {
	const t = parseFloat(raw ?? '1500');
	return Number.isFinite(t) && t > 0 ? t : 1500;
}

export interface VariantSelection {
	candidate: VariantCandidate;
	/** what decided: 'writer' (#4863, an RSM ws-writer claims the served collection), 'liveness', 'points' = legacy #4352 rule */
	basis: 'points' | 'liveness' | 'writer';
	/** true when the deciding rule overrode the largest-by-points pick */
	flipped: boolean;
}

/**
 * The #4352/#2609 ranking over a pool: liveness first (when ≥2 candidates are
 * decidable — a single measured ratio is not a comparison), largest-by-points
 * otherwise. Extracted so the #4863 writer preference can restrict the pool and
 * reuse the exact same in-pool rules.
 */
function rankVariants(
	candidates: VariantCandidate[],
	liveness: Map<string, { ratio: number; checked: number } | null> | null | undefined
): { candidate: VariantCandidate; basis: 'points' | 'liveness' } {
	const byPoints = candidates.reduce<VariantCandidate>(
		(best, v) => ((v.points ?? -1) > (best.points ?? -1) ? v : best),
		candidates[0]);
	if (!liveness || candidates.length < 2) return { candidate: byPoints, basis: 'points' };

	const decidable = candidates.filter(c => liveness.get(c.name));
	if (decidable.length < 2) return { candidate: byPoints, basis: 'points' };

	const byLiveness = decidable.reduce<VariantCandidate>((best, v) => {
		const ratio = liveness.get(v.name)!.ratio;
		const bestRatio = liveness.get(best.name)!.ratio;
		if (ratio > bestRatio) return v;
		// Equal ratios: the bigger corpus gives more headroom — keep #4352's rule.
		if (ratio === bestRatio && (v.points ?? -1) > (best.points ?? -1)) return v;
		return best;
	}, decidable[0]);

	return { candidate: byLiveness, basis: 'liveness' };
}

/**
 * Choose the collection to serve among the hash variants that exist.
 *
 * #4863: when the writer map says some variants are claimed by an RSM ws-writer
 * and others are not, the WRITER-BEARING ones win outright — a refreshed corpus
 * beats a livelier frozen one (liveness is not freshness), and points only rank
 * within the winning group. An undecidable probe (undefined — timeout, transport)
 * counts as not-writer-bearing without disqualifying the others: a proven writer
 * is always the safer pick than an unknown. All-writer or no-writer pools keep
 * the historical liveness→points behaviour untouched.
 */
export function selectVariantCollection(
	candidates: VariantCandidate[],
	liveness: Map<string, { ratio: number; checked: number } | null> | null | undefined,
	writer?: Map<string, WsWriterSignal | null | undefined> | null
): VariantSelection | null {
	if (candidates.length === 0) return null;
	const byPoints = candidates.reduce<VariantCandidate>(
		(best, v) => ((v.points ?? -1) > (best.points ?? -1) ? v : best),
		candidates[0]);

	if (writer && candidates.length >= 2) {
		const written = candidates.filter(c => writer.get(c.name));
		if (written.length > 0 && written.length < candidates.length) {
			const among = rankVariants(written, liveness);
			return { candidate: among.candidate, basis: 'writer', flipped: among.candidate.name !== byPoints.name };
		}
	}

	const ranked = rankVariants(candidates, liveness);
	return { candidate: ranked.candidate, basis: ranked.basis, flipped: ranked.candidate.name !== byPoints.name };
}

/**
 * #4880: bounds ONE candidate's signature scroll inside the content-match sweep.
 *
 * Measured ai-01, 23/11 13:20Z (read-only): on a cold Qdrant the 3 largest ws-*
 * collections each burned the 15 000 ms client timeout (15 014 / 15 006 / 15 002 ms)
 * while every other candidate answered in ~10 ms. The sweep is SERIAL, so 3 cold
 * candidates alone cost ~45 s and the search hit its 50 s deadline (phase
 * content_match_fallback) — a cold cache read as "the index is missing".
 *
 * Same defensive parsing as resolveVariantLivenessTimeout: a NaN/≤0 bound would fire
 * setTimeout at ~0 ms and read EVERY candidate as unprobed — an env typo must never
 * disarm the sweep. Invalid values fall back to 3000 ms.
 */
export function resolveContentMatchSignatureTimeout(raw: string | undefined): number {
	const t = parseFloat(raw ?? '3000');
	return Number.isFinite(t) && t > 0 ? t : 3000;
}

/** Sentinel: this candidate's signature scroll exceeded the bound. */
const SIGNATURE_PROBE_TIMED_OUT = Symbol('signature-probe-timed-out');
type SignatureProbe = { dirs: Set<string>; paths: string[] } | null | typeof SIGNATURE_PROBE_TIMED_OUT;

/**
 * One candidate's signature scroll, BOUNDED.
 *
 * Same Promise.race + clearTimeout-on-both-exits shape as the variant-liveness probe
 * in search-codebase.tool.ts: the losing setTimeout of a race must not stay pending for
 * the full bound on every candidate. A candidate that exceeds the bound is reported as
 * TIMED OUT (distinct from an unreadable one) so the caller can COUNT it.
 */
async function boundedCollectionSignature(
	qdrant: any,
	collectionName: string,
	timeoutMs: number
): Promise<SignatureProbe> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof SIGNATURE_PROBE_TIMED_OUT>(r => {
		timer = setTimeout(() => r(SIGNATURE_PROBE_TIMED_OUT), timeoutMs);
	});
	// getCollectionSignature swallows its own errors (it returns null), but a late
	// rejection after the race was lost must never become an unhandled rejection.
	const read: Promise<{ dirs: Set<string>; paths: string[] } | null> =
		Promise.resolve(getCollectionSignature(qdrant, collectionName)).catch(() => null);
	return Promise.race([read, timeout]).then(
		v => { clearTimeout(timer); return v; },
		() => { clearTimeout(timer); return null; },
	);
}

/**
 * The outcome of a content-match sweep, for the caller's observability.
 *
 * #4880: `unprobed_candidates` counts the candidates whose signature scroll exceeded
 * CONTENT_MATCH_SIGNATURE_TIMEOUT_MS. A MISS with this count > 0 is a COLD-CACHE miss,
 * not a proof that no collection matches — the two must never read the same.
 */
export interface ContentMatchProbeStats {
	unprobed_candidates: number;
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
 * tie-break. Liveness applies only when ≥2 candidates are decidable; otherwise the
 * legacy score ranking stands (first on tie — candidates arrive points_count desc).
 *
 * #4880: each candidate's signature scroll is BOUNDED
 * (CONTENT_MATCH_SIGNATURE_TIMEOUT_MS, default 3000). A candidate that exceeds the
 * bound is SKIPPED — treated like an unreadable one — and COUNTED. The thresholds and
 * the selection logic are untouched; only the time one cold candidate may cost changes.
 *
 * @param qdrant - Qdrant client
 * @param candidates - ws-* collection names to probe (pre-sorted by points_count desc)
 * @param workspaceSignature - top-level dirs of the workspace on disk (null = skip)
 * @param workspaceRoot - requested workspace root (enables the liveness preference)
 * @param stats - optional out-param carrying the sweep's counters (the miss path has
 *   no match object to carry them)
 * @returns the selected match with its metrics + liveness, or null
 */
export async function findCollectionByContent(
	qdrant: any,
	candidates: string[],
	workspaceSignature: Set<string> | null,
	workspaceRoot?: string,
	stats?: ContentMatchProbeStats
): Promise<{
	name: string;
	jaccard: number;
	overlap: number;
	sharedDiscriminants: number;
	liveness?: { ratio: number; checked: number };
	selection_basis: 'score' | 'liveness' | 'writer';
	liveness_flipped_selection?: boolean;
	writer: WsWriterSignal | null | undefined;
	writer_flipped_selection?: boolean;
	/** #4880: candidates skipped because their signature scroll exceeded the bound. */
	unprobed_candidates: number;
} | null> {
	if (!workspaceSignature || workspaceSignature.size === 0 || candidates.length === 0) {
		if (stats) stats.unprobed_candidates = 0;
		return null;
	}

	// Discriminant dirs = workspace dirs minus generic ones. At least one must be shared.
	const discriminantDirs = new Set([...workspaceSignature].filter(d => !GENERIC_DIRS.has(d)));

	const scanned = Math.min(candidates.length, CONTENT_MATCH_MAX_CANDIDATES);
	const signatureTimeoutMs = resolveContentMatchSignatureTimeout(process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS);
	type Accepted = {
		name: string;
		jaccard: number;
		overlap: number;
		sharedDiscriminants: number;
		score: number;
		paths: string[];
		liveness: { ratio: number; checked: number } | null;
		writer: WsWriterSignal | null | undefined;
	};
	const accepted: Accepted[] = [];
	let unprobedCandidates = 0;

	for (let i = 0; i < scanned; i++) {
		const name = candidates[i];
		const sig = await boundedCollectionSignature(qdrant, name, signatureTimeoutMs);
		// #4880: a cold candidate is skipped like an unreadable one — and counted.
		if (sig === SIGNATURE_PROBE_TIMED_OUT) {
			unprobedCandidates++;
			continue;
		}
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
				writer: undefined,
			});
		}
	}
	// #4880: the counters are published even on a MISS — a miss caused by cold
	// candidates must be distinguishable from a miss caused by no match.
	if (stats) stats.unprobed_candidates = unprobedCandidates;
	if (accepted.length === 0) return null;

	// Liveness for every accepted candidate — paths already sampled by the signature
	// scroll, so this costs only bounded existsSync calls (≤ LIVENESS_MAX_PATHS each).
	if (workspaceRoot && isContentMatchLivenessEnabled()) {
		for (const c of accepted) {
			c.liveness = estimateCollectionLiveness(c.paths, workspaceRoot);
		}
	}

	// #4863: writer signal for every accepted candidate — one bounded point
	// retrieve each, in parallel. A divergent-path reader reaches the writer's
	// collection THROUGH this fallback (the ladder cannot hash to it), so the
	// preference here is what makes the fresh corpus win.
	if (isWriterSignalEnabled()) {
		const boundMs = resolveWriterProbeTimeout(process.env.WRITER_SENTINEL_PROBE_TIMEOUT_MS);
		await Promise.all(accepted.map(async c => {
			c.writer = await probeWsWriterSentinel(qdrant, c.name, { timeoutMs: boundMs });
		}));
	}

	// Legacy selection: best structural score, first on tie (candidates arrive points-desc).
	const byScore = [...accepted].sort((a, b) => b.score - a.score);
	let winner = byScore[0];
	let selectionBasis: 'score' | 'liveness' | 'writer' = 'score';
	let flipped = false;

	const decidable = accepted.filter(c => c.liveness !== null);
	if (decidable.length >= 2) {
		const byLiveness = [...decidable].sort((a, b) =>
			(b.liveness!.ratio - a.liveness!.ratio) || (b.score - a.score));
		if (byLiveness[0] !== winner) flipped = true;
		winner = byLiveness[0];
		selectionBasis = 'liveness';
	}

	// #4863: writer-bearing accepted candidates rank FIRST (same doctrine as
	// selectVariantCollection): among collections of this same repository, the
	// one a refresh loop claims beats a livelier frozen twin.
	const written = accepted.filter(c => c.writer);
	if (written.length > 0 && written.length < accepted.length) {
		const bestWritten = [...written].sort((a, b) =>
			((b.liveness?.ratio ?? -1) - (a.liveness?.ratio ?? -1)) || (b.score - a.score))[0];
		if (bestWritten !== winner) flipped = true;
		winner = bestWritten;
		selectionBasis = 'writer';
	}

	return {
		name: winner.name,
		jaccard: winner.jaccard,
		overlap: winner.overlap,
		sharedDiscriminants: winner.sharedDiscriminants,
		...(winner.liveness ? { liveness: winner.liveness } : {}),
		selection_basis: selectionBasis,
		...(flipped ? { liveness_flipped_selection: true } : {}),
		...(selectionBasis === 'writer' && flipped ? { writer_flipped_selection: true } : {}),
		writer: winner.writer,
		// #4880: the candidates this sweep could not probe (cold signature scroll).
		unprobed_candidates: unprobedCandidates,
	};
}

// ─── #4736 P1: the read-only probe ────────────────────────────────────────────

/** Minimal read surface the probe needs — anything that can only read Qdrant. */
export interface CollectionReader {
	getCollection?: (collection: string) => Promise<any>;
	getCollections?: () => Promise<any>;
	scroll?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	// `any` body: the pinned QdrantClient's typed options (ids required) cannot be
	// assigned to Record<string, unknown> (parameter variance) — the probe only
	// ever sends ids/with_payload/with_vector, so the loose shape is the contract.
	retrieve?: (collection: string, body: any) => Promise<any>;
}

/** One spelling variant of the workspace, probed for existence and vector config. */
export interface WorkspaceCollectionProbeVariant {
	name: string;
	exists: boolean;
	points_count: number | null;
	/** The vector config the future writer must mirror and never recreate (#4736 risk 2). */
	vectors: { size: number; distance: string } | null;
	/** Transport-level failure (absent collections carry no error, only exists:false). */
	error?: string;
}

export interface WorkspaceCollectionProbe {
	workspace: string;
	/** ws-<hash> of the cleaned spelling — `getWorkspaceCollectionName`, the shared formula. */
	primary: string;
	/** Every spelling variant probed, in ladder order. */
	variants: WorkspaceCollectionProbeVariant[];
	/** The variants that exist in Qdrant. */
	existing: WorkspaceCollectionProbeVariant[];
	/** What the reader's variant ladder serves (selection among existing variants). */
	hash_resolution: { collection: string | null; basis: 'points' | 'liveness' | 'writer' };
	/** #4863: per-variant RSM ws-writer signals — null = writer-less, undefined = undecidable. */
	writer_signals?: Record<string, WsWriterSignal | null | undefined>;
	/** #4863: the served collection's writer signal — the response's freshness field. */
	resolved_writer?: WsWriterSignal | null | undefined;
	/** Content-match fallback outcome — run only when the ladder resolves nothing non-empty. */
	content_match: {
		candidates_total: number;
		candidates_scanned: number;
		match: {
			name: string;
			jaccard: number;
			overlap: number;
			shared_discriminant_dirs: number;
			accepted_via: 'jaccard' | 'overlap';
			selection_basis: 'score' | 'liveness' | 'writer';
			liveness_ratio?: number;
			/** #4863: the content-matched collection's writer, when its sentinel names one. */
			writer: WsWriterSignal | null | undefined;
		} | null;
	} | null;
	/** The collection `codebase_search` on this workspace resolves today — null when none. */
	resolved: string | null;
	resolved_by: 'hash' | 'content-match' | 'none';
	/** Vector config of the resolved collection, when one resolves. */
	resolved_vectors: { size: number; distance: string } | null;
	/** Read-only by construction: the probe performs getCollection/scroll only. */
	writes: 'none';
}

/** Distinguishes "this spelling has no collection" (404/not-found) from "Qdrant did not answer". */
function isProvenAbsent(error: unknown): boolean {
	const status = (error as { status?: unknown })?.status ?? (error as { code?: unknown })?.code;
	const message = error instanceof Error ? error.message : String(error);
	return status === 404 || /not found/i.test(message);
}

/**
 * Replays the reader's collection resolution for a workspace, read-only, and returns
 * the per-variant state plus the vector config of what resolves. This is the P1
 * contract instrument: `resolved` is what `codebase_search` serves today on this
 * machine, and the future writer (P2/P3) must target exactly this resolution —
 * a writer keying on the bare hash where the reader serves a content-matched twin
 * would mint a third collection (#4736 risk 1).
 *
 * Resolution mirrors `handleCodebaseSearch` step by step: probe every variant,
 * select among existing ones (liveness first, points tie-break — `selectVariantCollection`),
 * fall back to content match when the ladder resolves nothing or only an EMPTY
 * collection. All calls are getCollection / getCollections / scroll — nothing writes.
 */
export async function probeWorkspaceCollections(
	client: CollectionReader,
	workspacePath: string
): Promise<WorkspaceCollectionProbe> {
	const primary = getWorkspaceCollectionName(workspacePath);
	const variantNames = getWorkspaceCollectionVariants(workspacePath);

	const variants: WorkspaceCollectionProbeVariant[] = await Promise.all(variantNames.map(async name => {
		if (typeof client.getCollection !== 'function') {
			return { name, exists: false, points_count: null, vectors: null, error: 'client has no getCollection' };
		}
		try {
			const info: any = await client.getCollection(name);
			const rawPoints = info?.points_count ?? info?.result?.points_count;
			return {
				name,
				exists: true,
				points_count: typeof rawPoints === 'number' ? rawPoints : null,
				vectors: parseVectorsConfig(info),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				name,
				exists: false,
				points_count: null,
				vectors: null,
				...(isProvenAbsent(error) ? {} : { error: message }),
			};
		}
	}));
	const existing = variants.filter(v => v.exists);

	// Variant selection, liveness first — the same rule and the same bounds as the reader.
	const candidates: VariantCandidate[] = existing.map(v => ({ name: v.name, points: v.points_count }));
	let variantLiveness: Map<string, { ratio: number; checked: number } | null> | null = null;
	if (isContentMatchLivenessEnabled() && existing.length >= 2 && typeof client.scroll === 'function') {
		const boundMs = resolveVariantLivenessTimeout(process.env.VARIANT_LIVENESS_PROBE_TIMEOUT_MS);
		const bounded = (p: Promise<{ dirs: Set<string>; paths: string[] } | null>) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<null>(r => { timer = setTimeout(() => r(null), boundMs); });
			return Promise.race([p, timeout])
				.then(
					v => { clearTimeout(timer); return v; },
					() => { clearTimeout(timer); return null; });
		};
		const sigs = await Promise.all(existing.map(v => bounded(getCollectionSignature(client, v.name))));
		variantLiveness = new Map();
		existing.forEach((v, i) => {
			const sig = sigs[i];
			variantLiveness!.set(v.name, sig ? estimateCollectionLiveness(sig.paths, workspacePath) : null);
		});
	}
	// #4863: writer signal for EVERY existing variant — the preference that makes
	// a divergent-path reader serve the collection the writer seat refreshes
	// instead of its own spelling's writer-less legacy twin. The served
	// collection's signal also becomes the response's freshness field.
	let writerSignals: Map<string, WsWriterSignal | null | undefined> | null = null;
	if (isWriterSignalEnabled() && existing.length > 0) {
		const boundMs = resolveWriterProbeTimeout(process.env.WRITER_SENTINEL_PROBE_TIMEOUT_MS);
		writerSignals = new Map();
		await Promise.all(existing.map(async v => {
			writerSignals!.set(v.name, await probeWsWriterSentinel(client, v.name, { timeoutMs: boundMs }));
		}));
	}
	const selection = selectVariantCollection(candidates, variantLiveness, writerSignals);
	const hashCollection = selection?.candidate.name ?? null;
	const hashEmpty = hashCollection !== null && selection!.candidate.points === 0;

	let resolved: string | null = hashCollection;
	let resolvedBy: 'hash' | 'content-match' | 'none' = hashCollection ? 'hash' : 'none';
	let contentMatch: WorkspaceCollectionProbe['content_match'] = null;
	let resolvedVectors: { size: number; distance: string } | null = null;

	// The reader falls back when the ladder finds NOTHING or only an EMPTY collection.
	if (!hashCollection || hashEmpty) {
		resolved = null;
		resolvedBy = 'none';
		if (typeof client.getCollections === 'function' && typeof client.getCollection === 'function') {
			try {
				const response = await client.getCollections();
				const allWs: string[] = (response?.collections ?? response?.result?.collections ?? [])
					.map((c: any) => c.name)
					.filter((name: string) => name.startsWith('ws-'));
				const ranked: { name: string; points: number }[] = [];
				const vectorsByCollection = new Map<string, { size: number; distance: string } | null>();
				for (const wsCol of allWs) {
					try {
						const info: any = await client.getCollection(wsCol);
						ranked.push({ name: wsCol, points: Number(info?.points_count ?? 0) });
						vectorsByCollection.set(wsCol, parseVectorsConfig(info));
					} catch {
						ranked.push({ name: wsCol, points: -1 });
					}
				}
				ranked.sort((a, b) => b.points - a.points);
				const match = await findCollectionByContent(
					client,
					ranked.map(r => r.name),
					getWorkspaceRootSignature(workspacePath),
					workspacePath
				);
				contentMatch = {
					candidates_total: ranked.length,
					candidates_scanned: Math.min(ranked.length, CONTENT_MATCH_MAX_CANDIDATES),
					match: match ? {
						name: match.name,
						jaccard: match.jaccard,
						overlap: match.overlap,
						shared_discriminant_dirs: match.sharedDiscriminants,
						accepted_via: match.jaccard >= CONTENT_MATCH_MIN_JACCARD ? 'jaccard' : 'overlap',
						selection_basis: match.selection_basis,
						...(match.liveness ? { liveness_ratio: Math.round(match.liveness.ratio * 1000) / 1000 } : {}),
						writer: match.writer,
					} : null,
				};
				if (match) {
					resolved = match.name;
					resolvedBy = 'content-match';
					resolvedVectors = vectorsByCollection.get(match.name) ?? null;
				}
			} catch {
				// listing unreachable — stays resolved:null, honest "none"
			}
		}
	}

	const resolvedEntry = resolvedBy === 'hash' && resolved ? existing.find(v => v.name === resolved) ?? null : null;
	const resolvedWriter = resolvedBy === 'content-match'
		? contentMatch?.match?.writer
		: resolved ? writerSignals?.get(resolved) : undefined;

	return {
		workspace: workspacePath,
		primary,
		variants,
		existing,
		hash_resolution: { collection: hashCollection, basis: selection?.basis ?? 'points' },
		content_match: contentMatch,
		resolved,
		resolved_by: resolvedBy,
		...(writerSignals ? { writer_signals: Object.fromEntries(writerSignals) } : {}),
		...(resolved !== null ? { resolved_writer: resolvedWriter } : {}),
		resolved_vectors: resolvedBy === 'hash' ? resolvedEntry?.vectors ?? null : resolvedVectors,
		writes: 'none',
	};
}
