/**
 * #2063 P1: Error classification for semantic search failures.
 * Classifies errors into specific FailureMode categories so operators
 * get directional signals for remediation instead of generic messages.
 */

import { effectiveQdrantUrl } from '../../services/qdrant-url.js';

/** Classified failure modes for search operations */
export type FailureMode =
	| 'embedding_unreachable'    // POST embedding fail → service down or DNS
	| 'embedding_timeout'        // embedding slow > timeout
	| 'embedding_endpoint_not_found' // #4438 item 1: 404 on the embedder call — wrong path/model, NOT a Qdrant collection issue
	| 'qdrant_unreachable'       // TCP RST / DNS fail / TLS fail
	| 'qdrant_client_failure'    // #3344: transport failed BUT /healthz is UP → client/path-specific, not a Qdrant outage
	| 'qdrant_proxy_drop'        // TLS OK + GET OK + POST search timeout (IIS/ARR pattern)
	| 'qdrant_backend_slow'      // POST search 5xx or timeout > configured threshold
	| 'qdrant_collection_missing'// 404 collection
	| 'auth_failed'              // 401/403
	| 'resource_exhausted'       // EMFILE, ENOMEM, etc. — too many open files / out of memory
	| 'unknown';

export interface ClassifiedError {
	mode: FailureMode;
	originalError: string;
	message: string;
	hint: string;
}

/**
 * #4438: which backend component a classified mode implicates.
 *
 * The degraded banner used to name ONE component for every infrastructure mode
 * ("embedding backend unreachable"), so a Qdrant outage sent the operator to
 * the embeddings lane — the wrong owner, on the wrong stage. `diagnose` already
 * tells the two apart (`qdrant_connection` for Qdrant, `openai_connection` for
 * the embeddings); this mapping is that same distinction, derived from the mode
 * that the classifier produced. `null` = the mode implicates no known component
 * (unclassified, or `unknown`): the caller must then assert NO cause.
 */
export type FailureComponent = 'qdrant' | 'embeddings' | 'auth' | 'resources';

export function failureComponent(mode: FailureMode | string | null): FailureComponent | null {
	if (mode === null) return null;
	if (mode.startsWith('qdrant_')) return 'qdrant';
	if (mode.startsWith('embedding_')) return 'embeddings';
	if (mode === 'auth_failed') return 'auth';
	if (mode === 'resource_exhausted') return 'resources';
	return null;
}

/** Network error codes that indicate unreachable backend */
const NETWORK_ERROR_PATTERNS = [
	'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
	'CERT_HAS_EXPIRED', 'EPIPE', 'EAI_AGAIN',
];

/** Resource exhaustion error codes (EMFILE, ENOMEM, etc.) */
const RESOURCE_EXHAUSTED_PATTERNS = [
	'EMFILE', 'ENOMEM', 'ENOSPC', 'ENOBUFS',
	'too many open files', 'out of memory', 'no space left on device',
];

function isResourceExhausted(errorCode: string, errorMsg: string): boolean {
	return RESOURCE_EXHAUSTED_PATTERNS.some(p => errorCode === p || errorMsg.toLowerCase().includes(p.toLowerCase()));
}

function isNetworkError(errorCode: string, errorMsg: string): boolean {
	return NETWORK_ERROR_PATTERNS.some(p => errorCode === p || errorMsg.includes(p));
}

/**
 * #2636: Public predicate — true when an error looks like a backend connection
 * failure (TCP/DNS/TLS reset, or a `fetch failed`), as opposed to a genuine 404.
 * Lets callers (e.g. codebase_search's collection-listing swallow points) tell a
 * Qdrant *outage* apart from a missing collection BEFORE they fold the error into
 * an empty result — so the outage can still reach `classifySearchError` and surface
 * as `qdrant_unreachable` instead of being masked as `collection_not_found`.
 * Reuses NETWORK_ERROR_PATTERNS so the distinction is not reinvented.
 */
export function isNetworkErrorLike(error: unknown): boolean {
	const errorMsg = error instanceof Error ? error.message : String(error);
	const errorCode = (error as any)?.code || '';
	return isNetworkError(errorCode, errorMsg) || errorMsg.includes('fetch failed');
}

/**
 * #4736 P2: true when an error looks like a timeout/abort — including the
 * Qdrant JS client's `Request Timeout` (capital T: the case-sensitive
 * `includes('timeout')` checks elsewhere in this file miss it) and undici's
 * UND_ERR_CONNECT_TIMEOUT. Lets callers re-throw a timed-out call instead of
 * folding it into an empty result: listWorkspaceCollections() swallowed the
 * timeout and the reader then reported `collection_not_found` with
 * `existing_collections: []` while 65 ws-* candidates existed (measured on a
 * cold Qdrant, 15/11) — a slow backend masked as a missing index.
 */
export function isTimeoutLikeError(error: unknown): boolean {
	const errorMsg = error instanceof Error ? error.message : String(error);
	const errorCode = (error as any)?.code || '';
	return errorCode === 'ETIMEDOUT'
		|| errorCode === 'UND_ERR_CONNECT_TIMEOUT'
		|| /timeout|timed out|abort/i.test(errorMsg);
}

/**
 * Quick health probe to distinguish proxy_drop from qdrant_unreachable.
 * Returns { ok, latencyMs, status } or throws.
 * Timeout: 5 seconds (short, for diagnostic only).
 */
async function probeQdrantHealth(): Promise<{ ok: boolean; latencyMs: number; status?: number }> {
	// #4880: same dialled URL as the client — a probe that resolves `localhost`
	// on a saturated threadpool would fail with it and misread a healthy Qdrant.
	const qdrantUrl = effectiveQdrantUrl(process.env.QDRANT_URL || 'http://localhost:6333');
	const apiKey = process.env.QDRANT_API_KEY;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);

	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers['api-key'] = apiKey;

		const start = Date.now();
		const resp = await fetch(`${qdrantUrl}/healthz`, {
			signal: controller.signal,
			headers,
		});
		const latencyMs = Date.now() - start;
		return { ok: resp.ok, latencyMs, status: resp.status };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * #4352: a loopback QDRANT_URL has no reverse proxy in the path, so a search that
 * times out while /healthz answers is Qdrant itself being slow on that search
 * (cold cache, on-disk vectors, CPU), never a proxy drop. Qdrant's own search
 * timeout ("Operation 'Search' timed out") says the same on any host.
 */
// Qdrant's exact wording only: the OpenAI SDK says "Request timed out." for an
// embedding timeout, which roosync_search reports under operation 'search'.
const QDRANT_OWN_SEARCH_TIMEOUT = /Operation '?Search'? timed out/i;

// #4881: RFC1918 private ranges join the loopback exemption. Fleet executors
// hit Qdrant directly on its native port (synthetic example: 10.0.0.5:6333,
// measured on po-204) — no reverse proxy sits in that path, so a timed-out
// search there is Qdrant itself being slow, exactly like the #4352 localhost
// case.
function isPrivateLanHost(host: string): boolean {
	if (/^10\./.test(host)) return true;
	const m = /^172\.(\d+)\./.exec(host);
	if (m) {
		const n = parseInt(m[1], 10);
		return n >= 16 && n <= 31;
	}
	return /^192\.168\./.test(host);
}

function qdrantHasNoProxyInPath(errorMsg: string): boolean {
	if (QDRANT_OWN_SEARCH_TIMEOUT.test(errorMsg)) return true;
	try {
		const host = new URL(process.env.QDRANT_URL || 'http://localhost:6333').hostname;
		return host === 'localhost' || host === '[::1]' || /^127\./.test(host) || isPrivateLanHost(host);
	} catch {
		return false;
	}
}

/**
 * #4881: a verdict that blames the reverse proxy needs proof that POSTs are
 * actually dropped — GET /healthz passing proves nothing, it is trivial and
 * never touches the search path. This probe runs the lightest POST Qdrant has
 * (scroll, limit 1, no payload) on the first listed collection. Any HTTP
 * response — whatever the status — proves the POST method traverses the path,
 * so the failing heavy search is the backend being slow on THAT search.
 * Returns { ok: false } when the POST itself fails/aborts (the proxy-drop
 * signature), and null when the probe cannot run (listing failure, no
 * collections, malformed body): no proof either way.
 *
 * Follow-ups c.7090296934: (a) kill-switch QDRANT_LIGHT_POST_PROBE=0 (fleet
 * convention: the fix is the default, the env var exists only to turn it
 * off); (b) the caller bounds the probe by the time left before the
 * codebase_search global deadline — otherwise the worst case (5 s listing +
 * 10 s scroll) stacks after the search abort and the deadline response wins,
 * losing the proxy/backend distinction.
 */
async function probeLightPost(budgetMs?: number): Promise<{ ok: boolean; latencyMs: number } | null> {
	if ((process.env.QDRANT_LIGHT_POST_PROBE ?? '').trim() === '0') return null;
	// #4880: same dialled URL as the client — a probe that resolves `localhost`
	// on a saturated threadpool would fail with it and misread a healthy Qdrant.
	const qdrantUrl = effectiveQdrantUrl(process.env.QDRANT_URL || 'http://localhost:6333');
	const apiKey = process.env.QDRANT_API_KEY;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (apiKey) headers['api-key'] = apiKey;

	// (b) budget: listing min(5000, budget), scroll min(10000, what the listing
	// did NOT consume). The remainder is measured from the ELAPSED time, never
	// from the listing CAP — subtracting the cap (5000) from a 5000 ms budget
	// left 0 for the scroll and silently skipped the probe. A budget below 50 ms
	// means no useful probe — return null (no proof either way).
	const probeStart = Date.now();
	const listingBudget = typeof budgetMs === 'number' ? Math.min(5000, budgetMs) : 5000;
	if (listingBudget < 50) return null;

	let collectionName: string | undefined;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), listingBudget);
		try {
			const resp = await fetch(`${qdrantUrl}/collections`, { headers, signal: controller.signal });
			let body: unknown = null;
			try {
				body = await resp.json();
			} catch {
				body = null;
			}
			collectionName = (body as any)?.result?.collections?.[0]?.name;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
	if (typeof collectionName !== 'string' || !collectionName) return null;

	// The scroll gets what the listing left of the deadline budget, capped at 10 s.
	const remainingBudget = typeof budgetMs === 'number' ? budgetMs - (Date.now() - probeStart) : 10000;
	const scrollBudget = Math.min(10000, remainingBudget);
	if (scrollBudget < 50) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), scrollBudget);
	const start = Date.now();
	try {
		await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collectionName)}/points/scroll`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ limit: 1, with_payload: false }),
			signal: controller.signal,
		});
		// Any HTTP answer (even 4xx/5xx) proves the POST traversed the path.
		return { ok: true, latencyMs: Date.now() - start };
	} catch {
		return { ok: false, latencyMs: Date.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * #3344: Unwrap the `cause` chain of a transport error.
 *
 * Node's undici wraps every low-level failure as `TypeError: fetch failed` with
 * `.code` unset — the real errno (ENOTFOUND, ECONNRESET, ETIMEDOUT, TLS errors…)
 * lives on `.cause` (and for DNS failures on `.cause.errors[i]` of an AggregateError).
 * Without unwrapping, the classifier reported "network/TLS error: unknown", which
 * is exactly the signature that made the #3344 intermittent failure undiagnosable.
 *
 * Returns the deepest informative { code, message } found on the cause chain,
 * or null when the error carries no cause.
 */
export function unwrapTransportCause(error: unknown): { code: string; message: string } | null {
	let cause = (error as any)?.cause;
	let depth = 0;
	while (cause && depth < 5) {
		// AggregateError (DNS ENOTFOUND): individual errno entries sit on `.errors`.
		const aggregateCodes: string[] = Array.isArray(cause.errors)
			? cause.errors.map((e: any) => e?.code).filter((c: unknown) => typeof c === 'string' && c)
			: [];
		const code = (typeof cause.code === 'string' && cause.code)
			|| aggregateCodes[0]
			|| '';
		const msg = typeof cause.message === 'string' ? cause.message : '';
		if (code || msg) {
			return { code, message: aggregateCodes.length > 1 ? msg : (msg || String(cause)) };
		}
		cause = cause.cause;
		depth++;
	}
	return null;
}

/**
 * #4880: the reason Qdrant gave for a failed request, as the JS client carries
 * it (`error.data.status.error`); null when the error has none.
 */
export function qdrantServerReason(error: unknown): string | null {
	const reason = (error as any)?.data?.status?.error;
	return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

/**
 * Check if an error is an HTTP 5xx server error (eligible for circuit breaker).
 */
function isHttpServerError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message;
	return /\b5[0-9]{2}\b/.test(msg) || msg.includes('Bad Gateway') || msg.includes('Service Unavailable') || msg.includes('Gateway Timeout');
}

/**
 * Classify a search error into a specific FailureMode.
 * Optionally probes Qdrant health to distinguish proxy_drop vs unreachable.
 */
export async function classifySearchError(
	error: unknown,
	operation: 'embedding' | 'search' | 'codebase_search',
	/** #4881 follow-up (b): ms remaining before the caller's global deadline;
	 * the light-POST probe is bounded inside it so the deadline response never
	 * eats the classification. Undefined = no bound (roosync_search). */
	probeBudgetMs?: number
): Promise<ClassifiedError> {
	const baseErrorMsg = error instanceof Error ? error.message : String(error);
	// #4880: the Qdrant JS client (1.20) throws with the HTTP status text as its
	// message ("Internal Server Error") and the server's reason in
	// `data.status.error` — e.g. "Timeout error: Operation 'Search' timed out
	// after 999ms" (measured ai-01 23/11). Without the reason, Qdrant's own
	// search timeout matched none of the message tests below and fell to
	// `unknown`; the #4352 QDRANT_OWN_SEARCH_TIMEOUT test never saw its text.
	const qdrantReason = qdrantServerReason(error);
	const errorMsg = qdrantReason ? `${baseErrorMsg}: ${qdrantReason}` : baseErrorMsg;
	// #3344: undici sets no `.code` on "fetch failed" — the errno lives on `.cause`.
	const unwrapped = unwrapTransportCause(error);
	const errorCode = (error as any)?.code || unwrapped?.code || '';
	const causeMessage = unwrapped?.message || '';
	const causeDetail = unwrapped ? `${errorCode || 'no_errno'}: ${causeMessage}` : '';
	const errorStatus = (error as any)?.status || (error as any)?.response?.status;

	// Auth failures (checked first — applies to all operations)
	if (errorStatus === 401 || errorStatus === 403 ||
		errorMsg.includes('API key') || errorMsg.includes('Unauthorized') || errorMsg.includes('Forbidden')) {
		return {
			mode: 'auth_failed',
			originalError: errorMsg,
			message: `Authentication failed during ${operation}`,
			hint: 'Check EMBEDDING_API_KEY / OPENAI_API_KEY / QDRANT_API_KEY in .env',
		};
	}

	// Collection not found (404) — #4438 dispatch item 1: the operation gate
	// below is the fix. A 404 raised by the EMBEDDING call is an endpoint/model
	// problem on the embedder (wrong base-URL path, unknown model); classifying
	// it as a missing Qdrant collection sent the operator to
	// `roosync_indexing(rebuild)` — the wrong cause, and an expensive remedy.
	if (errorStatus === 404 || errorMsg.includes('Not found') || errorMsg.includes('Collection not found')) {
		if (operation === 'embedding') {
			return {
				mode: 'embedding_endpoint_not_found',
				originalError: errorMsg,
				message: 'Embedding endpoint not found (404) — the embedder rejected the path or the model; the Qdrant index is NOT the cause',
				hint: 'Check EMBEDDING_API_BASE_URL (OpenAI-compatible servers expect it to end with /v1) and the embedding model name. Do NOT run roosync_indexing(action: "rebuild").',
			};
		}
		return {
			mode: 'qdrant_collection_missing',
			originalError: errorMsg,
			message: `Qdrant collection not found during ${operation}`,
			hint: 'Run roosync_indexing(action: "rebuild") to create/rebuild the index',
		};
	}

	// Embedding-specific errors
	if (operation === 'embedding') {
		if (isNetworkError(errorCode, errorMsg) || errorMsg.includes('fetch failed')) {
			return {
				mode: 'embedding_unreachable',
				originalError: causeDetail ? `${errorMsg} (cause: ${causeDetail})` : errorMsg,
				message: 'Embedding service unreachable',
				hint: `Check EMBEDDING_API_BASE_URL (${process.env.EMBEDDING_API_BASE_URL || 'not set'}). DNS/TCP failure.`,
			};
		}
		// #4736 P2 review follow-up (b): case-aligned with isTimeoutLikeError —
		// 'Request Timeout' (capital T) under operation='embedding' used to fall
		// through to 'unknown'; the ONE predicate now decides this branch too.
		if (isTimeoutLikeError(error)) {
			return {
				mode: 'embedding_timeout',
				originalError: errorMsg,
				message: `Embedding service timeout (> ${process.env.EMBEDDING_TIMEOUT_MS || '60000'}ms)`,
				hint: 'Embedding service is slow or overloaded. Try again or use roosync_search(action: "text") as fallback.',
			};
		}
	}

	// Qdrant-level errors (search or codebase_search operations)
	if (operation === 'search' || operation === 'codebase_search') {
		// TCP/DNS/TLS failures → probe /healthz to distinguish a real Qdrant outage
		// from a client/path-specific failure (#3344: diagnose was green while
		// codebase_search failed — the two verdicts could not be told apart).
		if (isNetworkError(errorCode, errorMsg) || isNetworkError(errorCode, causeMessage) || errorMsg.includes('fetch failed')) {
			const originalWithCause = causeDetail ? `${errorMsg} (cause: ${causeDetail})` : errorMsg;
			let healthProbe: { ok: boolean; latencyMs: number; status?: number } | null = null;
			try {
				healthProbe = await probeQdrantHealth();
			} catch {
				healthProbe = null;
			}
			if (healthProbe?.ok) {
				return {
					mode: 'qdrant_client_failure',
					originalError: originalWithCause,
					message: `Qdrant is UP (GET /healthz ${healthProbe.status} in ${healthProbe.latencyMs}ms) but the ${operation} transport failed — client/path-specific failure (transient network event or routing), NOT a Qdrant outage`,
					hint: `Transport cause: ${causeDetail || 'unknown (no errno on the cause chain)'}. Qdrant is reachable from this process — do NOT treat this as backend-down. Retry the call; if it persists, inspect the proxy/TLS path between this client and QDRANT_URL (${process.env.QDRANT_URL || 'not set'}).`,
				};
			}
			return {
				mode: 'qdrant_unreachable',
				originalError: originalWithCause,
				message: `Qdrant unreachable (network/TLS error: ${errorCode || 'unknown'}${causeDetail ? ` — ${causeMessage}` : ''}; health probe also failed)`,
				hint: `Check QDRANT_URL (${process.env.QDRANT_URL || 'not set'}), DNS resolution, and TLS certificate. The /healthz probe failed too → the backend or the network path is down from this machine.`,
			};
		}

		// Abort/timeout → probe health to distinguish proxy_drop vs unreachable.
		// #4736 P2 + review follow-up (b): the timeout family is detected by the
		// ONE case-insensitive predicate (isTimeoutLikeError), so every case
		// variant of the Qdrant client's 'Request Timeout' reaches the probe
		// branch (the case-sensitive includes above missed them), and HTTP 408
		// (status computed at the top) joins it. The ONE exclusion is the OpenAI
		// SDK's phrasing "Request timed out." — an embedding timeout that
		// roosync_search reports under 'search' must NOT be blamed on Qdrant
		// (test: "not blamed on Qdrant"); every other 'timed out' message
		// (Qdrant's own "Operation 'Search' timed out", #4352) still enters.
		const isEmbeddingSdkTimeout = /^request timed out\.?$/i.test(errorMsg);
		if ((!isEmbeddingSdkTimeout && isTimeoutLikeError(error)) ||
			// #4880: Qdrant's own search timeout arrives as a 500 whose message is
			// only "Internal Server Error" — its reason (joined above) decides.
			QDRANT_OWN_SEARCH_TIMEOUT.test(errorMsg) ||
			errorStatus === 408 ||
			isHttpServerError(error)) {
			// Probe health endpoint to classify
			try {
				const health = await probeQdrantHealth();
				if (health.ok && qdrantHasNoProxyInPath(errorMsg)) {
					return {
						mode: 'qdrant_backend_slow',
						originalError: errorMsg,
						message: `Qdrant is UP (GET /healthz ${health.status} in ${health.latencyMs}ms) but the ${operation} itself timed out — no proxy in the path, Qdrant is slow on this search`,
						hint: 'Usual causes: first search on a cold cache, vectors stored on disk without quantization, or Qdrant CPU saturated by indexing. Retry once; if it persists, check the collection config (on_disk, quantization) and the container CPU.',
					};
				}
				if (health.ok) {
					// #4881: never blame a proxy without proof that POSTs are
					// dropped. The light-scroll probe decides; when it cannot
					// run, the legacy proxy_drop verdict stands but stays
					// unverified (the message says so).
					const lightPost = await probeLightPost(probeBudgetMs);
					if (lightPost?.ok) {
						return {
							mode: 'qdrant_backend_slow',
							originalError: errorMsg,
							message: `Qdrant is UP (GET /healthz ${health.status} in ${health.latencyMs}ms) and POSTs traverse the path (light scroll answered in ${lightPost.latencyMs}ms) — the ${operation} itself timed out, the backend is slow on this search, NOT a proxy drop`,
							hint: 'A light POST on the same path answered, so the POST method is not being dropped. Usual causes: cold cache, on-disk/unquantized vectors on a large collection, or Qdrant CPU saturated by indexing. Retry once; if it persists, check the collection config (on_disk, quantization) and container CPU.',
						};
					}
					if (lightPost && !lightPost.ok) {
						return {
							mode: 'qdrant_proxy_drop',
							originalError: errorMsg,
							message: `Reverse proxy drops POST requests (GET /healthz: ${health.status} in ${health.latencyMs}ms; light POST scroll also failed after ${lightPost.latencyMs}ms)`,
							hint: 'Likely: IIS/nginx proxy timeout too short, or ARR pool corrupted. Check reverse proxy config (proxy timeout, maxRequestBodySize, requestFiltering).',
						};
					}
					return {
						mode: 'qdrant_proxy_drop',
						originalError: errorMsg,
						message: `Reverse proxy drops POST requests (GET /healthz: ${health.status} in ${health.latencyMs}ms, but POST search timed out; light-POST probe could not run — verdict unverified)`,
						hint: 'Likely: IIS/nginx proxy timeout too short, or ARR pool corrupted. Check reverse proxy config (proxy timeout, maxRequestBodySize, requestFiltering).',
					};
				} else {
					return {
						mode: 'qdrant_backend_slow',
						originalError: errorMsg,
						message: `Qdrant backend degraded (GET /healthz: ${health.status} in ${health.latencyMs}ms)`,
						hint: 'Qdrant backend is slow or unhealthy. Check optimizer status, disk space, and resource usage.',
					};
				}
			} catch {
				return {
					mode: 'qdrant_unreachable',
					originalError: errorMsg,
					message: 'Qdrant completely unreachable (health probe also failed)',
					hint: `Check QDRANT_URL (${process.env.QDRANT_URL || 'not set'}), DNS, and network connectivity.`,
				};
			}
		}

		// HTTP 5xx detected
		if (isHttpServerError(error) || /\b5[0-9]{2}\b/.test(errorMsg)) {
			return {
				mode: 'qdrant_backend_slow',
				originalError: errorMsg,
				message: `Qdrant returned server error during ${operation}`,
				hint: 'Backend overloaded or misconfigured. Check Qdrant logs and optimizer status.',
			};
		}
	}

	// Resource exhaustion (EMFILE, ENOMEM, etc.) — applies to all operations
	if (isResourceExhausted(errorCode, errorMsg)) {
		return {
			mode: 'resource_exhausted',
			originalError: errorMsg,
			message: `Resource exhausted during ${operation}`,
			hint: 'Too many file handles or memory. Close unused processes, increase ulimit, or restart the MCP server to release file descriptors.',
		};
	}

	// Fallback
	return {
		mode: 'unknown',
		originalError: errorMsg,
		message: `Unexpected error during ${operation}`,
		hint: 'Run roosync_search(action: "diagnose") for backend state. Report this issue if it persists.',
	};
}

/**
 * Format a classified error into a user-friendly message.
 */
export function formatClassifiedError(classified: ClassifiedError, includeOriginal = true): string {
	const parts = [
		`Semantic search failed: ${classified.mode}`,
		`  Detected: ${classified.message}`,
		`  Likely cause: ${classified.hint}`,
	];
	if (includeOriginal) {
		parts.push(`  Original error: ${classified.originalError}`);
	}
	return parts.join('\n');
}
