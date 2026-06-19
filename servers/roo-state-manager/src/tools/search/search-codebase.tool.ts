/**
 * Outil MCP : codebase_search
 * Recherche sémantique dans les collections workspace Roo (code indexé)
 *
 * @version 1.0.0
 * @author #452 Phase 2 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { classifySearchError, formatClassifiedError } from './search-error-classifier.js';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { getQdrantClient } from '../../services/qdrant.js';
import { resolveWorkspace } from '../../utils/workspace-resolver.js';
import { existsSync } from 'fs';
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
	} catch {
		return [];
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
			// #1232: Reduce timeout and retries to prevent MCP Connection closed
			timeout: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '15000'),
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

	try {
		// 1. Calculer les variantes possibles du nom de collection
		const primaryCollectionName = getWorkspaceCollectionName(workspace);
		const collectionVariants = getWorkspaceCollectionVariants(workspace);

		// 2. Trouver la collection existante (essayer toutes les variantes)
		const qdrant = getQdrantClient();
		let collectionName = '';

		for (const variant of collectionVariants) {
			try {
				const collectionInfo = await qdrant.getCollection(variant);
				if (collectionInfo.status !== undefined) {
					collectionName = variant;
					break;
				}
			} catch {
				// Cette variante n'existe pas, essayer la suivante
			}
		}


		// Phase B: Diagnostic fallback — no blind collection selection (#2455)
		// #1085: Hash mismatches between Roo (Windows fsPath backslashes) and
		// Claude Code (Git Bash forward slashes) produce different hashes.
		// #2455: Previously, Phase B blindly took the first ws-* collection with
		// points_count > 0, serving results from unrelated workspaces. Now it
		// returns enriched diagnostic info to help the caller take action.
		if (!collectionName) {
			// Collect diagnostic info about existing ws-* collections
			const allWsCollections = await listWorkspaceCollections();
			const collectionDiagnostics = [];
			for (const wsCol of allWsCollections.slice(0, 10)) {
				try {
					const info = await qdrant.getCollection(wsCol);
					collectionDiagnostics.push({
						collection: wsCol,
						points_count: (info as any)?.points_count ?? 0,
						status: info?.status ?? 'unknown'
					});
				} catch {
					collectionDiagnostics.push({
						collection: wsCol,
						points_count: -1,
						status: 'error'
					});
				}
			}

			return {
				isError: false,
				content: [{
					type: 'text',
					text: JSON.stringify({
						status: 'collection_not_found',
						message: `No Qdrant collection matching workspace "${workspace}" (primary hash: ${primaryCollectionName}). ${collectionVariants.length} hash variants tried, none matched.`,
						hint: 'The workspace must be indexed by Roo Code before searching. If already indexed, the path format may differ from what the indexer used. Check the diagnostic info below for existing collections.',
						tried_variants: collectionVariants,
						primary_hash: primaryCollectionName,
						workspace: workspace,
						workspace_source: workspaceSource,
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

		// 3. Générer l'embedding de la requête (uses dedicated codebase embedding client)
		const embeddingClient = getCodebaseEmbeddingClient();
		const embeddingModel = getCodebaseEmbeddingModel();

		const embeddingResponse = await embeddingClient.embeddings.create({
			model: embeddingModel,
			input: query
		});

		const queryVector = embeddingResponse.data[0].embedding;

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
			limit: effectiveLimit,
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

		const results = finalHits.map((point: any) => ({
			file_path: point.payload.filePath,
			score: point.score,
			relevance: interpretScore(point.score),
			snippet: extractSnippet(point.payload.codeChunk || '', query),
			start_line: point.payload.startLine,
			end_line: point.payload.endLine,
			lines: point.payload.startLine && point.payload.endLine
				? `${point.payload.startLine}-${point.payload.endLine}`
				: undefined
		}));

		// 7. Construire la réponse
		const response = {
			status: 'success',
			query: query,
			workspace: workspace,
			workspace_source: workspaceSource,
			collection: collectionName,
			results_count: results.length,
			min_score_used: effectiveMinScore,
			// #2609/#2554: dead-path filtering observability
			...(deadPathsFiltered > 0 ? { dead_paths_filtered: deadPathsFiltered } : {}),
			...(allDead ? { warning: 'all hits resolved to dead paths — workspace root may be wrong or drive unmounted; returning raw results unfiltered' } : {}),
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
		const classified = await classifySearchError(error, 'codebase_search');

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
