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
import OpenAI from 'openai';

let codebaseEmbeddingClient: OpenAI | null = null;
// #1275: track the last API key so a provider switch (/switch-provider) rebuilds the client.
let lastEmbeddingApiKey: string | undefined = undefined;

/**
 * Dedicated OpenAI-compatible client for codebase embeddings.
 * Uses EMBEDDING_API_KEY/EMBEDDING_API_BASE_URL if set (self-hosted models such as
 * Qwen3-4B), otherwise falls back to OPENAI_API_KEY. Separate from the task-indexer's
 * client so the two configurations cannot fight.
 */
export function getCodebaseEmbeddingClient(): OpenAI {
	const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
	if (!codebaseEmbeddingClient || apiKey !== lastEmbeddingApiKey) {
		if (!apiKey) {
			throw new Error('No embedding API key configured. Set EMBEDDING_API_KEY or OPENAI_API_KEY.');
		}
		lastEmbeddingApiKey = apiKey;
		codebaseEmbeddingClient = new OpenAI({
			apiKey,
			baseURL: process.env.EMBEDDING_API_BASE_URL || undefined,
			// #1232: short timeout + few retries so a dead endpoint cannot hold the MCP
			// host. 60s (not 15s) since 2026-08-25: measured 45.8s under load;
			// maxRetries=1 → ~120s worst case, under the 180s codebase_search budget.
			timeout: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '60000'),
			maxRetries: 1,
		});
	}
	return codebaseEmbeddingClient;
}

/** The embedding model name both the indexer and the search use. */
export function getCodebaseEmbeddingModel(): string {
	return process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
}

/** Reset the singleton (provider switch, or tests). */
export function resetCodebaseEmbeddingClient(): void {
	codebaseEmbeddingClient = null;
	lastEmbeddingApiKey = undefined;
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
