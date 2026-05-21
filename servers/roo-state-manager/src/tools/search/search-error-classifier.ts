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
	const errorCode = (error as any)?.code || '';
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
				originalError: errorMsg,
				message: 'Embedding service unreachable',
				hint: `Check EMBEDDING_API_BASE_URL (${process.env.EMBEDDING_API_BASE_URL || 'not set'}). DNS/TCP failure.`,
			};
		}
		if (errorMsg.includes('abort') || errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT') ||
			errorCode === 'UND_ERR_CONNECT_TIMEOUT') {
			return {
				mode: 'embedding_timeout',
				originalError: errorMsg,
				message: `Embedding service timeout (> ${process.env.EMBEDDING_TIMEOUT_MS || '15000'}ms)`,
				hint: 'Embedding service is slow or overloaded. Try again or use roosync_search(action: "text") as fallback.',
			};
		}
	}

	// Qdrant-level errors (search or codebase_search operations)
	if (operation === 'search' || operation === 'codebase_search') {
		// TCP/DNS/TLS failures → qdrant_unreachable
		if (isNetworkError(errorCode, errorMsg) || errorMsg.includes('fetch failed')) {
			return {
				mode: 'qdrant_unreachable',
				originalError: errorMsg,
				message: `Qdrant unreachable (network/TLS error: ${errorCode || 'unknown'})`,
				hint: `Check QDRANT_URL (${process.env.QDRANT_URL || 'not set'}), DNS resolution, and TLS certificate.`,
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
