/**
 * #4352 (a3): the ONE codebase-embedding client, shared by every writer and reader
 * of a `ws-`/`sup-` collection.
 *
 * Lived inside `search-codebase.tool.ts` until the supplement index needed it too.
 * Copying the factory would have been the silent-drift trap: a reader configured
 * with `EMBEDDING_API_BASE_URL` and a writer that forgot it produce vectors from
 * two different models in one collection, and every search on it returns a
 * meaningless ranking with no error anywhere. Same env contract, same client.
 */
import { createHash } from 'crypto';
import OpenAI from 'openai';
import {
	getCanonicalEmbeddingBaseUrl,
	getEmbeddingClientTimeoutMs,
	getEmbeddingEndpointPlan,
} from '../embedding-endpoints.js';

let codebaseEmbeddingClient: OpenAI | null = null;
// #4352 (a5): query path, same endpoint list but a short attempt ceiling and a
// total budget. The writer keeps the long ceiling it needs on a loaded backend.
let codebaseEmbeddingQueryClient: OpenAI | null = null;
// #1275: track the last API key so a provider switch (/switch-provider) rebuilds the client.
let lastEmbeddingApiKey: string | undefined = undefined;
let lastEmbeddingQueryApiKey: string | undefined = undefined;

function buildCodebaseEmbeddingClient(mode: 'index' | 'query'): OpenAI {
	const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('No embedding API key configured. Set EMBEDDING_API_KEY or OPENAI_API_KEY.');
	}
	const plan = getEmbeddingEndpointPlan(mode);
	const failoverActive = plan.endpoints.length > 1;
	return new OpenAI({
		apiKey,
		baseURL: plan.baseURL,
		// #1232: short timeout + few retries so a dead endpoint cannot hold the MCP
		// host. 60s (not 15s) since 2026-08-25: measured 45.8s under load;
		// maxRetries=1 → ~120s worst case, under the 180s codebase_search budget.
		timeout: failoverActive
			? getEmbeddingClientTimeoutMs(mode, plan.endpoints.length)
			: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '60000'),
		// The query wrapper already spent its whole budget; an SDK retry would
		// double a wait the acceptance criterion bounds at 15 s.
		maxRetries: mode === 'query' && failoverActive ? 0 : 1,
		...(plan.fetch ? { fetch: plan.fetch } : {}),
	});
}

/**
 * Dedicated OpenAI-compatible client for codebase embeddings.
 * Uses EMBEDDING_API_KEY/EMBEDDING_API_BASE_URL(S) if set (self-hosted models
 * such as Qwen3-4B), otherwise falls back to OPENAI_API_KEY. Separate from the
 * task-indexer's client so the two configurations cannot fight.
 */
export function getCodebaseEmbeddingClient(): OpenAI {
	const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
	if (!codebaseEmbeddingClient || apiKey !== lastEmbeddingApiKey) {
		lastEmbeddingApiKey = apiKey;
		codebaseEmbeddingClient = buildCodebaseEmbeddingClient('index');
	}
	return codebaseEmbeddingClient;
}

/** #4352 (a5): interactive query client for `codebase_search`. */
export function getCodebaseEmbeddingQueryClient(): OpenAI {
	const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
	if (!codebaseEmbeddingQueryClient || apiKey !== lastEmbeddingQueryApiKey) {
		lastEmbeddingQueryApiKey = apiKey;
		codebaseEmbeddingQueryClient = buildCodebaseEmbeddingClient('query');
	}
	return codebaseEmbeddingQueryClient;
}

/** The embedding model name both the indexer and the search use. */
export function getCodebaseEmbeddingModel(): string {
	return process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
}

/**
 * Host of the embedding endpoint, for the supplement sentinel fingerprint
 * (review ms#1514, Hermes point 2): the SAME model name served by two
 * `EMBEDDING_API_BASE_URL`s is two vector spaces, exactly like a model switch.
 * Host only — an unparseable base is hashed, never recorded raw, so no
 * credential that might live in a URL can end up in a Qdrant payload.
 */
export function getCodebaseEmbeddingEndpoint(): string {
	// #4352 (a5): the fingerprint names the CANONICAL endpoint (first list entry),
	// whichever endpoint actually served the call. A failover must not read as a
	// model switch and force a collection rebuild.
	const base = getCanonicalEmbeddingBaseUrl();
	if (!base) return 'default';
	try {
		const host = new URL(base).host;
		if (host) return host;
	} catch { /* fall through to the hash */ }
	return 'unparsed-' + createHash('sha256').update(base).digest('hex').slice(0, 8);
}

/** Reset the singletons (provider switch, endpoint move, or tests). */
export function resetCodebaseEmbeddingClient(): void {
	codebaseEmbeddingClient = null;
	codebaseEmbeddingQueryClient = null;
	lastEmbeddingApiKey = undefined;
	lastEmbeddingQueryApiKey = undefined;
}

/**
 * Embeds a batch of texts with the shared client, validating the response so a
 * quota/partial answer cannot push an `undefined` vector into Qdrant (#3999).
 * Throws on any malformed response — a misaligned batch must never be written.
 */
export async function embedCodebaseTexts(texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	const client = getCodebaseEmbeddingClient();
	const model = getCodebaseEmbeddingModel();
	const response = await client.embeddings.create({ model, input: texts });
	const vectors = (response.data ?? []).map((d) => d?.embedding);
	if (vectors.length !== texts.length
		|| vectors.some((v) => !Array.isArray(v) || v.length === 0 || !v.every(Number.isFinite))) {
		throw new Error(
			`Réponse embedding invalide du modèle ${model}: ${vectors.length} vecteur(s) pour ${texts.length} texte(s) (#3999)`
		);
	}
	return vectors as number[][];
}
