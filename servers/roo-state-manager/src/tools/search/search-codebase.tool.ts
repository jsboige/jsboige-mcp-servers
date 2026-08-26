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
import { existsSync, readdirSync } from 'fs';
import { isAbsolute, join } from 'path';

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
export async function listWorkspaceCollections(): Promise<string[]> {
	try {
		const qdrant = getQdrantClient();
		const response = await qdrant.getCollections();
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
/** Max ws-* collections scanned by the content fallback (cost cap). */
const CONTENT_MATCH_MAX_CANDIDATES = 10;

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
 * Returns the set of pathSegments.0 values, or null if the collection is unreadable.
 */
async function getCollectionSignature(qdrant: any, collectionName: string): Promise<Set<string> | null> {
	try {
		// Sample 200 points: payload-only (no vector). pathSegments is always present
		// on indexed points (qdrant-client.ts:315-331). Robust to scroll's response
		// shape variants (.points or .result.points).
		const result = await qdrant.scroll(collectionName, {
			limit: 200,
			with_payload: { include: ['pathSegments'] },
			with_vector: false,
		});
		const points = result?.points || result?.result?.points || [];
		const sig = new Set<string>();
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
		}
		return sig;
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
 * @param qdrant - Qdrant client
 * @param candidates - ws-* collection names to probe (pre-sorted by points_count desc)
 * @param workspaceSignature - top-level dirs of the workspace on disk (null = skip)
 * @returns { name, jaccard, overlap } of the best strict match, or null
 */
export async function findCollectionByContent(
	qdrant: any,
	candidates: string[],
	workspaceSignature: Set<string> | null
): Promise<{ name: string; jaccard: number; overlap: number } | null> {
	if (!workspaceSignature || workspaceSignature.size === 0 || candidates.length === 0) {
		return null;
	}

	// Discriminant dirs = workspace dirs minus generic ones. At least one must be shared.
	const discriminantDirs = new Set([...workspaceSignature].filter(d => !GENERIC_DIRS.has(d)));

	let best: { name: string; jaccard: number; overlap: number } | null = null;
	// Rank by the stronger of the two metrics so the overlap path can win the tie-break
	// on inflated workspaces where Jaccard is uniformly low across candidates.
	let bestScore = -1;
	const scanned = Math.min(candidates.length, CONTENT_MATCH_MAX_CANDIDATES);

	for (let i = 0; i < scanned; i++) {
		const name = candidates[i];
		const collSig = await getCollectionSignature(qdrant, name);
		if (!collSig || collSig.size === 0) continue;

		// Jaccard similarity between workspace dirs and collection's indexed dirs.
		const intersection = [...workspaceSignature].filter(d => collSig.has(d)).length;
		const union = new Set([...workspaceSignature, ...collSig]).size;
		if (union === 0) continue;
		const jaccard = intersection / union;

		// #2554/#2766: overlap coefficient (containment) = intersection / min(sizes).
		// Robust to an inflated workspace: measures whether the indexed dirs are a subset
		// of the workspace, independent of how many extra non-indexed dirs the workspace has.
		const overlap = intersection / Math.min(workspaceSignature.size, collSig.size);
		const sharedDiscriminantCount = [...discriminantDirs].filter(d => collSig.has(d)).length;

		// STRICT gate: at least one shared discriminant dir, AND either the original
		// Jaccard threshold OR the overlap threshold. The overlap path additionally
		// requires ≥2 shared discriminant (non-generic) dirs so a tiny unrelated
		// collection can't slip through on a single shared dir via the min-size trick.
		const accept = sharedDiscriminantCount >= 1 && (
			jaccard >= CONTENT_MATCH_MIN_JACCARD
			|| (overlap >= CONTENT_MATCH_MIN_OVERLAP && sharedDiscriminantCount >= 2)
		);
		if (accept) {
			const score = Math.max(jaccard, overlap);
			if (!best || score > bestScore) {
				best = { name, jaccard, overlap };
				bestScore = score;
			}
		}
	}
	return best;
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
	// tests-rank-reranking (po-204 c.194, GO ai-01 c.197): over-fetch a candidate pool so post-retrieval re-ranking (test-file malus +
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
		let contentMatchDetails: { jaccard: number; jaccard_threshold: number; overlap?: number; overlap_threshold?: number } | undefined;
		// points_count of the hash-matched collection (if any). Used to detect the
		// "collection exists but is empty" blind-spot: the hash resolves to a real
		// collection that was never populated (e.g. the indexer hashed a different path
		// format → points went into another ws-* collection). (#2609/#2554 follow-up,
		// convergent finding web1 c.N+4 + po-2026 c.46: po-2023 sees 15 results from a
		// populated collection; web1/po-2026 get 0 from an empty one matched by hash.)
		let hashMatchedPointsCount: number | null = null;

		for (const variant of collectionVariants) {
			try {
				const collectionInfo = await qdrant.getCollection(variant);
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
				? await findCollectionByContent(qdrant, candidates, workspaceSignature)
				: null;

			if (contentMatch) {
				// Strict content-match found — serve results from this collection.
				collectionName = contentMatch.name;
				collectionResolvedBy = 'content-match';
				// #2554/#2766: report BOTH metrics so observability shows how the match was
				// made — Jaccard alone would hide that an inflated workspace matched via overlap.
				contentMatchDetails = {
					jaccard: contentMatch.jaccard,
					jaccard_threshold: CONTENT_MATCH_MIN_JACCARD,
					overlap: contentMatch.overlap,
					overlap_threshold: CONTENT_MATCH_MIN_OVERLAP,
				};
			} else {
				// No strict content-match → honest diagnostic. Enrich with the collection
				// signatures we probed so the caller can identify theirs visually.
				const collectionDiagnostics = [];
				for (const r of ranked.slice(0, 10)) {
					collectionDiagnostics.push({
						collection: r.name,
						points_count: r.points,
						status: r.points >= 0 ? 'green' : 'error'
					});
				}

				// Build signature samples for the top candidates (helps the caller self-identify).
				// Only when we could read the workspace dirs — otherwise signatures are moot
				// (we can't compare them to anything) and we avoid the extra scroll calls.
				const signatureSamples: Record<string, string[]> = {};
				if (workspaceSignature) {
					for (const r of ranked.slice(0, 5)) {
						const sig = await getCollectionSignature(qdrant, r.name);
						if (sig && sig.size > 0) signatureSamples[r.name] = [...sig].slice(0, 8);
					}
				}

				return {
					isError: false,
					content: [{
						type: 'text',
						text: JSON.stringify({
							status: 'collection_not_found',
							message: `No Qdrant collection matching workspace "${workspace}" (primary hash: ${primaryCollectionName}). ${collectionVariants.length} hash variants tried + content-based fallback over ${candidates.length} ws-* collections, no strict match (Jaccard ≥ ${CONTENT_MATCH_MIN_JACCARD} with a discriminant dir required).`,
							hint: 'The workspace hash differs from what the indexer used AND no collection\'s indexed top-level dirs match yours strictly. Inspect the collection signatures below to identify yours, then re-index the workspace from Roo Code / Zoo Code on this machine, or report the path-format mismatch.',
							tried_variants: collectionVariants,
							primary_hash: primaryCollectionName,
							hash_matched_empty: hashMatchedEmpty,
							workspace: workspace,
							workspace_source: workspaceSource,
							workspace_signature: workspaceSignature ? [...workspaceSignature] : null,
							content_match_attempted: true,
							content_match_threshold: CONTENT_MATCH_MIN_JACCARD,
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
			queryVector = embeddingResponse.data[0].embedding;
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
		const searchResults = await qdrant.query(collectionName, {
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
		});

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

		// tests-rank-reranking (po-204 c.194 investigation, GO ai-01 c.197): post-retrieval re-ranking to
		// counter the test-files-rank-above-source asymmetry. text-embedding-3-small scores
		// descriptive test titles (natural-language intent like 'should allow sending between
		// workspaces') higher than the code source they test — the source carries syntactic
		// noise (generics, types, modifiers) that dilutes the signal. Measured firsthand
		// po-204: test-title chunk 0.72 vs source chunk 0.68 on identical intent. The code
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
		const MAX_CHUNKS_PER_FILE = 2;

		const adjusted: { point: any; score: number }[] = finalHits
			.map((point: any) => {
				const fp = String(point.payload.filePath || '');
				let score = point.score;
				if (TEST_FILE_RE.test(fp)) score *= TEST_FILE_MALUS;
				if (FIXTURE_FILE_RE.test(fp)) score *= FIXTURE_FILE_MALUS;
				return { point, score };
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
		const perFileCount = new Map<string, number>();
		const picked: any[] = [];
		const leftovers: { point: any; score: number }[] = [];
		for (const a of adjusted) {
			const fp = String(a.point.payload.filePath || '');
			if ((perFileCount.get(fp) || 0) < MAX_CHUNKS_PER_FILE) {
				picked.push(a.point);
				perFileCount.set(fp, (perFileCount.get(fp) || 0) + 1);
			} else {
				leftovers.push(a);
			}
		}
		for (const a of leftovers) {
			if (picked.length >= effectiveLimit) break;
			picked.push(a.point);
		}
		const rankedHits = picked.slice(0, effectiveLimit);
		let testFileMalusApplied = 0;
		let fixtureMalusApplied = 0;

		const results = rankedHits.map((point: any) => {
			const fp = String(point.payload.filePath || '');
			const isTestFile = TEST_FILE_RE.test(fp);
			const isFixtureFile = FIXTURE_FILE_RE.test(fp);
			if (isTestFile) testFileMalusApplied++;
			if (isFixtureFile) fixtureMalusApplied++;
			// Expose the adjusted (post-malus) score so the value matches the rank order;
			// an unadjusted test at 0.72 ranked below a source at 0.68 would otherwise read
			// as a contradiction. The raw cosine is not surfaced (the order is the signal).
			const adjustedScore = point.score
				* (isTestFile ? TEST_FILE_MALUS : 1)
				* (isFixtureFile ? FIXTURE_FILE_MALUS : 1);
			// #3172: a fixture chunk embeds source code inside a JSON capture — the stored
			// startLine/endLine point at the single-line JSON container, not at the embedded
			// code shown in the snippet ("1-1" navigates to nothing). Omit the line fields
			// rather than render numbers that lead nowhere; the snippet keeps the real line.
			const lineFields = isFixtureFile ? {} : {
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
				snippet: extractSnippet(point.payload.codeChunk || '', query),
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
			results_count: results.length,
			min_score_used: effectiveMinScore,
			// #2609/#2554: dead-path filtering observability
			...(deadPathsFiltered > 0 ? { dead_paths_filtered: deadPathsFiltered } : {}),
			// tests-rank-reranking: test-file re-ranking observability — how many returned hits had the
			// ×0.95 malus applied (tests ranked above source by raw cosine; see block above).
			...(testFileMalusApplied > 0 ? { test_file_malus_applied: testFileMalusApplied } : {}),
			// #3172: fixture-file malus observability — hits from tests/fixtures/** demoted ×0.8.
			...(fixtureMalusApplied > 0 ? { fixture_malus_applied: fixtureMalusApplied } : {}),
			...(allDead ? { warning: 'all hits resolved to dead paths — workspace root may be wrong or drive unmounted; returning raw results unfiltered' } : {}),
			...(recallShrankBelowLimit ? { warning: `dead-path filter reduced recall: ${deadPathsFiltered} of ${rawHits.length} candidate hits unreachable, results_count=${results.length} < limit=${effectiveLimit} (run roosync_indexing cleanup_orphans to reclaim orphan budget)` } : {}),
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
