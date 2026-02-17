/**
 * Outil MCP : codebase_search
 * Recherche sémantique dans les collections workspace Roo (code indexé)
 *
 * @version 1.0.0
 * @author #452 Phase 2 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../services/openai.js';

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
 * Roo Code ne normalise pas le chemin avant le hachage, donc la casse et le
 * séparateur peuvent varier. On essaie toutes les combinaisons plausibles.
 */
export function getWorkspaceCollectionVariants(workspacePath: string): string[] {
	const cleaned = workspacePath.replace(/\\{2,}/g, '\\').replace(/\/+$|\\+$/g, '');
	const variants = new Set<string>();

	// 1. Exact path (cleaned)
	variants.add(cleaned);

	// 2. Lowercase (Windows is case-insensitive)
	variants.add(cleaned.toLowerCase());

	// 3. With forward slashes
	variants.add(cleaned.replace(/\\/g, '/'));
	variants.add(cleaned.toLowerCase().replace(/\\/g, '/'));

	// 4. With backslashes (Windows native)
	variants.add(cleaned.replace(/\//g, '\\'));
	variants.add(cleaned.toLowerCase().replace(/\//g, '\\'));

	// Generate collection names for each variant
	return [...variants].map(v => {
		const hash = createHash('sha256').update(v).digest('hex');
		return `ws-${hash.substring(0, 16)}`;
	});
}

/**
 * Arguments de l'outil codebase_search
 */
export interface CodebaseSearchArgs {
	/** Requête de recherche sémantique */
	query: string;

	/** Chemin du workspace (défaut: process.cwd()) */
	workspace?: string;

	/** Préfixe de répertoire pour filtrer les résultats */
	directory_prefix?: string;

	/** Nombre max de résultats (défaut: 10, max: 30) */
	limit?: number;

	/** Score minimum de similarité 0-1 (défaut: 0.5) */
	min_score?: number;
}

/**
 * Configuration par défaut
 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
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
				description: 'Chemin absolu du workspace (défaut: répertoire courant)'
			},
			directory_prefix: {
				type: 'string',
				description: 'Préfixe de répertoire pour filtrer. Ex: "src/services", "mcps/internal"'
			},
			limit: {
				type: 'number',
				description: 'Nombre max de résultats (défaut: 10, max: 30)'
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
	if (score >= 0.6) return 'moderate';
	if (score >= 0.4) return 'weak';
	return 'marginal';
}

/**
 * Extrait un snippet centré autour des mots-clés de la requête
 */
function extractSnippet(codeChunk: string, query: string, maxChars: number = 200): string {
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
		workspace = process.cwd(),
		directory_prefix,
		limit = DEFAULT_LIMIT,
		min_score = DEFAULT_MIN_SCORE
	} = args;

	// Validation
	if (!query || query.trim().length === 0) {
		return {
			isError: true,
			content: [{ type: 'text', text: 'Le paramètre "query" est requis et ne peut pas être vide.' }]
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

		if (!collectionName) {
			return {
				isError: false,
				content: [{
					type: 'text',
					text: JSON.stringify({
						status: 'collection_not_found',
						message: `Collection Qdrant non trouvée pour le workspace "${workspace}".`,
						hint: 'Le workspace doit être indexé par Roo Code avant de pouvoir effectuer des recherches. Ouvrez le workspace dans VS Code avec Roo activé pour démarrer l\'indexation.',
						tried_collections: collectionVariants,
						workspace: workspace
					}, null, 2)
				}]
			};
		}

		// 3. Générer l'embedding de la requête
		const openai = getOpenAIClient();
		const embeddingModel = getEmbeddingModel();

		const embeddingResponse = await openai.embeddings.create({
			model: embeddingModel,
			input: query
		});

		const queryVector = embeddingResponse.data[0].embedding;

		// 4. Construire le filtre si directory_prefix fourni
		let filter: any = {
			must_not: [{ key: 'type', match: { value: 'metadata' } }]
		};

		if (directory_prefix) {
			// Normaliser le préfixe de répertoire
			const normalizedPrefix = directory_prefix.replace(/\\/g, '/').replace(/^\.\//, '');
			const segments = normalizedPrefix.split('/').filter(Boolean);

			if (segments.length > 0) {
				filter.must = segments.map((segment, index) => ({
					key: `pathSegments.${index}`,
					match: { value: segment }
				}));
			}
		}

		// 5. Effectuer la recherche
		const searchResults = await qdrant.query(collectionName, {
			query: queryVector,
			filter: filter,
			score_threshold: effectiveMinScore,
			limit: effectiveLimit,
			params: {
				hnsw_ef: 128,
				exact: false
			},
			with_payload: {
				include: ['filePath', 'codeChunk', 'startLine', 'endLine', 'pathSegments']
			}
		});

		// 6. Formater les résultats
		const results = searchResults.points
			.filter((p: any) => p.payload?.filePath && p.payload?.codeChunk)
			.map((point: any) => ({
				file_path: point.payload.filePath,
				score: point.score,
				relevance: interpretScore(point.score),
				snippet: extractSnippet(point.payload.codeChunk || '', query, 200),
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
			collection: collectionName,
			results_count: results.length,
			min_score_used: effectiveMinScore,
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
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Détecter les erreurs spécifiques
		if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: JSON.stringify({
						status: 'qdrant_connection_error',
						message: 'Impossible de se connecter à Qdrant.',
						hint: 'Vérifiez que Qdrant est accessible et que les variables QDRANT_URL et QDRANT_API_KEY sont configurées.',
						error: errorMessage
					}, null, 2)
				}]
			};
		}

		if (errorMessage.includes('API key') || errorMessage.includes('Unauthorized')) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: JSON.stringify({
						status: 'auth_error',
						message: 'Erreur d\'authentification avec l\'API d\'embedding ou Qdrant.',
						hint: 'Vérifiez vos clés API (OPENAI_API_KEY, QDRANT_API_KEY).',
						error: errorMessage
					}, null, 2)
				}]
			};
		}

		return {
			isError: true,
			content: [{
				type: 'text',
				text: JSON.stringify({
					status: 'error',
					message: 'Erreur lors de la recherche dans le code.',
					error: errorMessage
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
