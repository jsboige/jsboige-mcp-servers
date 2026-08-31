/**
 * #2063 P1: Error classification for semantic search failures.
 * Classifies errors into specific FailureMode categories so operators
 * get directional signals for remediation instead of generic messages.
 */

/** Classified failure modes for search operations */
export type FailureMode =
	| 'embedding_unreachable'    // POST embedding fail → service down or DNS
	| 'embedding_timeout'        // embedding slow > timeout
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
 * Quick health probe to distinguish proxy_drop from qdrant_unreachable.
 * Returns { ok, latencyMs, status } or throws.
 * Timeout: 5 seconds (short, for diagnostic only).
 */
async function probeQdrantHealth(): Promise<{ ok: boolean; latencyMs: number; status?: number }> {
	const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
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
	operation: 'embedding' | 'search' | 'codebase_search'
): Promise<ClassifiedError> {
	const errorMsg = error instanceof Error ? error.message : String(error);
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

	// Collection not found (404)
	if (errorStatus === 404 || errorMsg.includes('Not found') || errorMsg.includes('Collection not found')) {
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
		if (errorMsg.includes('abort') || errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT') ||
			errorCode === 'UND_ERR_CONNECT_TIMEOUT') {
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

		// Abort/timeout → probe health to distinguish proxy_drop vs unreachable
		if (errorMsg.includes('abort') || errorMsg.includes('timeout') ||
			errorMsg.includes('This operation was aborted') ||
			errorCode === 'UND_ERR_CONNECT_TIMEOUT' ||
			isHttpServerError(error)) {
			// Probe health endpoint to classify
			try {
				const health = await probeQdrantHealth();
				if (health.ok) {
					return {
						mode: 'qdrant_proxy_drop',
						originalError: errorMsg,
						message: `Reverse proxy drops POST requests (GET /healthz: ${health.status} in ${health.latencyMs}ms, but POST search timed out)`,
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
