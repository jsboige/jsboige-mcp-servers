/**
 * #4880: the client abort that lets the server-side search budget apply.
 *
 * Both vector searches (`roosync_search` semantic and `codebase_search`) hand
 * Qdrant a server-side budget (QDRANT_SEARCH_TIMEOUT_MS, 30 s by default), but
 * the shared client aborts every request at QDRANT_TIMEOUT_MS (15 s) first —
 * so that budget never applied. Measured on ai-01 (23/11): the semantic path
 * then retried each cut attempt twice (3 x 15 s + 2 s + 4 s of backoff = the
 * 52-57 s seen before the text fallback) on a server that answered the same
 * query shape in 8-14.5 s once warm.
 */

/** Headroom between the server-side search budget and the client abort. */
export const SEARCH_CLIENT_MARGIN_MS = 5000;

/**
 * Returns the client abort budget for a vector search query: the server-side
 * budget rounded up to the second the server receives, plus a margin, so
 * Qdrant's own timeout (a 500 that names it) fires before the client gives up.
 *
 * `null` = keep the shared client. Kill switch QDRANT_SEARCH_TIMEOUT_ALIGN=0
 * restores the legacy behaviour on both tools (shared client; the semantic
 * path also retries timed-out attempts again).
 */
export function resolveSearchClientTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | null {
	if ((env.QDRANT_SEARCH_TIMEOUT_ALIGN ?? '').trim() === '0') return null;
	const raw = parseInt(env.QDRANT_SEARCH_TIMEOUT_MS || '30000', 10);
	const serverBudgetMs = Number.isFinite(raw) && raw > 0 ? raw : 30000;
	return Math.ceil(serverBudgetMs / 1000) * 1000 + SEARCH_CLIENT_MARGIN_MS;
}
