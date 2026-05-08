/**
 * Error Classification for Semantic Search Failures
 * Issue #2063 - Distinguish infrastructure layer failures (IIS, Qdrant, Embedding)
 *
 * This module provides utilities to classify search failures into specific modes
 * to help operators identify the root cause of semantic search issues.
 *
 * @module tools/search/error-classifier
 */

import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient from '../../services/openai.js';

/**
 * Failure modes for semantic search
 * Each represents a distinct infrastructure layer or error pattern
 */
export type FailureMode =
	| 'embedding_unreachable'      // POST embedding fail → service down or DNS
	| 'embedding_timeout'          // embedding slow > timeout
	| 'embedding_auth_failed'      // embedding API 401/403
	| 'qdrant_unreachable'         // TCP RST / DNS fail / TLS fail
	| 'qdrant_proxy_drop'          // TLS OK + GET OK + POST search timeout (IIS case)
	| 'qdrant_backend_slow'        // POST search 5xx or timeout > QDRANT_SEARCH_TIMEOUT_MS
	| 'qdrant_collection_missing'  // 404 collection
	| 'qdrant_auth_failed'         // 401/403 from Qdrant
	| 'network_unreachable'        // Generic network error
	| 'unknown';                   // Unclassified error

/**
 * Classified error result with diagnostic details
 */
export interface ClassifiedError {
	/** The failure mode category */
	mode: FailureMode;
	/** Human-readable description of the failure */
	description: string;
	/** Likely cause based on the pattern */
	likelyCause: string;
	/** Suggested remediation steps */
	remediation: string;
	/** Raw error message for reference */
	rawError: string;
	/** Additional diagnostic details if available */
	details?: {
		/** Whether TLS handshake succeeded */
		tlsOk?: boolean;
		/** Whether GET /healthz succeeded */
		healthCheckOk?: boolean;
		/** Health check latency in ms */
		healthCheckLatency?: number;
		/** Whether collection exists */
		collectionExists?: boolean;
		/** Collection status if available */
		collectionStatus?: string;
		/** Whether embedding API is reachable */
		embeddingReachable?: boolean;
	};
}

/**
 * Configuration for health check timeouts
 */
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const QUICK_HEALTH_CHECK_MS = 2000;

/**
 * Classify a search error into a specific failure mode
 * Performs targeted health checks to identify the failing layer
 *
 * @param error - The error that occurred during search
 * @param collectionName - The Qdrant collection being queried (optional)
 * @returns Classified error with diagnostic details
 */
export async function classifySearchError(
	error: unknown,
	collectionName?: string
): Promise<ClassifiedError> {
	const rawError = error instanceof Error ? error.message : String(error);
	const errorMsg = rawError.toLowerCase();

	// Quick classification based on error message patterns
	const quickClassify = quickClassifyError(errorMsg);
	if (quickClassify) {
		return quickClassify;
	}

	// If no quick match, perform diagnostic health checks
	return await diagnoseWithHealthChecks(rawError, collectionName);
}

/**
 * Quick error classification based on message patterns
 * Returns null if health checks are needed for definitive classification
 */
function quickClassifyError(errorMsg: string): ClassifiedError | null {
	// Auth failures - easy to detect
	if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('unauthorized') || errorMsg.includes('forbidden')) {
		if (errorMsg.includes('embedding') || errorMsg.includes('openai')) {
			return {
				mode: 'embedding_auth_failed',
				description: 'Embedding API authentication failed',
				likelyCause: 'Invalid or expired API key for embedding service',
				remediation: 'Check EMBEDDING_API_KEY or OPENAI_API_KEY environment variable. Verify the key is valid and has not expired.',
				rawError: errorMsg
			};
		}
		return {
			mode: 'qdrant_auth_failed',
			description: 'Qdrant authentication failed',
			likelyCause: 'Invalid or expired QDRANT_API_KEY',
			remediation: 'Check QDRANT_API_KEY environment variable. Verify the key is valid and has not expired.',
			rawError: errorMsg
		};
	}

	// Collection not found
	if (errorMsg.includes('404') && errorMsg.includes('collection')) {
		return {
			mode: 'qdrant_collection_missing',
			description: 'Qdrant collection not found',
			likelyCause: `Collection does not exist or has not been created`,
			remediation: 'Run roosync_indexing with action: "rebuild" to create the collection, or check QDRANT_COLLECTION_NAME environment variable.',
			rawError: errorMsg
		};
	}

	// Embedding API specific errors - go through health checks for accurate classification
	if (errorMsg.includes('embedding') || errorMsg.includes('openai')) {
		// Let health checks determine the exact failure mode and populate details
		return null;
	}

	// Qdrant connection errors - explicit mention of Qdrant
	if (errorMsg.includes('qdrant')) {
		if (errorMsg.includes('econnrefused') || errorMsg.includes('connection refused')) {
			return {
				mode: 'qdrant_unreachable',
				description: 'Qdrant server is unreachable',
				likelyCause: 'Qdrant service is down or wrong host/port',
				remediation: 'Check QDRANT_URL. Verify Qdrant is running. Check network connectivity and firewall rules.',
				rawError: errorMsg
			};
		}
	}

	// Generic timeout - need health checks to distinguish (IIS proxy vs backend slow)
	if (errorMsg.includes('timeout') || errorMsg.includes('aborted') || errorMsg.includes('timed out')) {
		// Will be handled by diagnoseWithHealthChecks
		return null;
	}

	// Generic connection errors - need health checks to distinguish (Qdrant vs network vs proxy)
	if (errorMsg.includes('econnrefused') || errorMsg.includes('connection refused') || errorMsg.includes('enotfound')) {
		// Will be handled by diagnoseWithHealthChecks
		return null;
	}

	// TLS errors - need health checks to verify
	if (errorMsg.includes('tls') || errorMsg.includes('certificate') || errorMsg.includes('ssl')) {
		// Will be handled by diagnoseWithHealthChecks
		return null;
	}

	// Other network errors that don't specify the service
	if (errorMsg.includes('network') || errorMsg.includes('fetch failed')) {
		return {
			mode: 'network_unreachable',
			description: 'Network connectivity issue',
			likelyCause: 'General network failure or DNS resolution issue',
			remediation: 'Check network connectivity. Verify DNS resolution. Check firewall and proxy settings.',
			rawError: errorMsg
		};
	}

	// Unknown error - try health checks
	return null;
}

/**
 * Perform health checks to classify ambiguous errors
 * This is the key diagnostic path for IIS proxy drops vs backend issues
 */
async function diagnoseWithHealthChecks(
	rawError: string,
	collectionName?: string
): Promise<ClassifiedError> {
	const details: NonNullable<ClassifiedError['details']> = {};
	const effectiveCollectionName = collectionName || process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

	// Health check 1: Qdrant GET /healthz (lightweight)
	let qdrantHealthOk = false;
	let qdrantHealthLatency = 0;
	let collectionStatus: string | undefined;
	try {
		const qdrant = getQdrantClient();
		const healthStart = Date.now();

		// Try a lightweight operation - getCollection info
		const collectionInfo = await qdrant.getCollection(effectiveCollectionName);

		qdrantHealthLatency = Date.now() - healthStart;
		qdrantHealthOk = true;
		details.tlsOk = true;
		details.healthCheckOk = true;
		details.healthCheckLatency = qdrantHealthLatency;
		details.collectionExists = true;
		collectionStatus = collectionInfo.status;
		if (collectionStatus) {
			details.collectionStatus = collectionStatus;
		}
	} catch (healthError) {
		const healthErrorMsg = String(healthError).toLowerCase();

		// TLS / connection failure
		if (healthErrorMsg.includes('econnrefused') || healthErrorMsg.includes('connection refused')) {
			return {
				mode: 'qdrant_unreachable',
				description: 'Qdrant server is unreachable',
				likelyCause: 'Qdrant service is down, wrong host/port, or network routing issue',
				remediation: 'Check QDRANT_URL. Verify Qdrant is running and accessible. Check network routing and firewall rules.',
				rawError,
				details
			};
		}

		// Collection missing
		if (healthErrorMsg.includes('404')) {
			details.collectionExists = false;
			return {
				mode: 'qdrant_collection_missing',
				description: 'Qdrant collection not found',
				likelyCause: `Collection "${effectiveCollectionName}" does not exist`,
				remediation: 'Run roosync_indexing with action: "rebuild" to create the collection, or check QDRANT_COLLECTION_NAME environment variable.',
				rawError,
				details
			};
		}

		// Auth failure
		if (healthErrorMsg.includes('401') || healthErrorMsg.includes('403')) {
			return {
				mode: 'qdrant_auth_failed',
				description: 'Qdrant authentication failed',
				likelyCause: 'Invalid or expired QDRANT_API_KEY',
				remediation: 'Check QDRANT_API_KEY environment variable. Verify the key is valid and has not expired.',
				rawError,
				details
			};
		}

		// TLS error
		if (healthErrorMsg.includes('tls') || healthErrorMsg.includes('certificate') || healthErrorMsg.includes('ssl')) {
			return {
				mode: 'qdrant_unreachable',
				description: 'TLS handshake failed with Qdrant',
				likelyCause: 'Certificate mismatch, TLS version incompatibility, or reverse proxy TLS issue',
				remediation: 'Check QDRANT_URL protocol (https://). Verify reverse proxy TLS configuration. Check certificate validity.',
				rawError,
				details: { ...details, tlsOk: false }
			};
		}
	}

	// Health check 2: Embedding API health check
	let embeddingReachable = false;
	try {
		const openai = getOpenAIClient();
		// Lightweight check - list models (much faster than creating embedding)
		await openai.models.list();
		embeddingReachable = true;
	} catch {
		embeddingReachable = false;
	}
	// Always set this detail
	details.embeddingReachable = embeddingReachable;

	// Classification based on health check results
	const errorMsg = rawError.toLowerCase();

	// Case: Embedding-related error (check embedding API first)
	if (errorMsg.includes('embedding') || errorMsg.includes('openai')) {
		if (!embeddingReachable) {
			return {
				mode: 'embedding_unreachable',
				description: 'Embedding API is unreachable',
				likelyCause: 'Embedding service is down or network issue',
				remediation: 'Check EMBEDDING_API_BASE_URL. Verify embedding service is running. Check network connectivity.',
				rawError,
				details
			};
		}
		// Embedding reachable but error occurred
		if (errorMsg.includes('timeout') || errorMsg.includes('aborted') || errorMsg.includes('timed out')) {
			return {
				mode: 'embedding_timeout',
				description: 'Embedding API request timed out',
				likelyCause: 'Embedding service is overloaded or the model is slow',
				remediation: 'Increase EMBEDDING_TIMEOUT_MS (default 15000). If using self-hosted model, check GPU/CPU utilization. Consider using a faster embedding model.',
				rawError,
				details
			};
		}
		// Other embedding error but API is reachable
		return {
			mode: 'embedding_timeout',
			description: 'Embedding API request failed',
			likelyCause: 'Embedding service error or rate limit',
			remediation: 'Check embedding service logs. Verify API quota. Check EMBEDDING_API_KEY.',
			rawError,
			details
		};
	}

	// Case: IIS proxy drop (TLS OK, GET OK, POST search timeout)
	// This is the key pattern from issue #2063
	// Distinguish from backend slow by checking collection status
	if (qdrantHealthOk && (errorMsg.includes('timeout') || errorMsg.includes('aborted') || errorMsg.includes('timed out'))) {
		// If collection status is yellow/red, it's likely backend slow (optimizer rebuilding, etc)
		if (collectionStatus === 'yellow' || collectionStatus === 'red') {
			return {
				mode: 'qdrant_backend_slow',
				description: 'Qdrant backend is slow to respond',
				likelyCause: `Qdrant is under heavy load, optimizer is rebuilding, or collection is very large (status: ${collectionStatus})`,
				remediation: 'Check Qdrant optimizer status. If collection is large (>10M vectors), consider increasing QDRANT_SEARCH_TIMEOUT_MS. Check Qdrant CPU/memory resources.',
				rawError,
				details
			};
		}
		// Otherwise (status: green), it's likely a proxy drop
		return {
			mode: 'qdrant_proxy_drop',
			description: 'Qdrant search request timed out despite health check passing',
			likelyCause: 'Reverse proxy (IIS/nginx) is dropping POST requests or has too short timeout. GET requests pass but POST /search times out.',
			remediation: 'Check reverse proxy configuration (IIS ARR, nginx proxy_read_timeout). Increase timeout for POST requests to Qdrant. Check IIS application pool recycle settings.',
			rawError,
			details
		};
	}

	// Case: Qdrant unreachable (health check failed)
	if (!qdrantHealthOk) {
		if (errorMsg.includes('econnrefused') || errorMsg.includes('connection refused')) {
			return {
				mode: 'qdrant_unreachable',
				description: 'Qdrant server is unreachable',
				likelyCause: 'Qdrant service is down, wrong host/port, or network routing issue',
				remediation: 'Check QDRANT_URL. Verify Qdrant is running and accessible. Check network routing and firewall rules.',
				rawError,
				details
			};
		}
		if (errorMsg.includes('404')) {
			// Already handled in the catch block above, but for safety
			return {
				mode: 'qdrant_collection_missing',
				description: 'Qdrant collection not found',
				likelyCause: `Collection "${effectiveCollectionName}" does not exist`,
				remediation: 'Run roosync_indexing with action: "rebuild" to create the collection, or check QDRANT_COLLECTION_NAME environment variable.',
				rawError,
				details
			};
		}
		if (errorMsg.includes('401') || errorMsg.includes('403')) {
			// Already handled in the catch block above, but for safety
			return {
				mode: 'qdrant_auth_failed',
				description: 'Qdrant authentication failed',
				likelyCause: 'Invalid or expired QDRANT_API_KEY',
				remediation: 'Check QDRANT_API_KEY environment variable. Verify the key is valid and has not expired.',
				rawError,
				details
			};
		}
	}

	// Default: unknown with whatever details we gathered
	return {
		mode: 'unknown',
		description: 'Unclassified error',
		likelyCause: 'Could not determine specific failure mode from error pattern and health checks',
		remediation: 'Check the raw error message. Run roosync_search(action: "diagnose") for backend state. Check logs for more details.',
		rawError,
		details
	};
}

/**
 * Format a classified error as a human-readable message
 */
export function formatClassifiedError(classified: ClassifiedError): string {
	const lines = [
		`Semantic search failed: ${classified.mode}`,
		``,
		`Description: ${classified.description}`,
		`Likely cause: ${classified.likelyCause}`,
		``,
		`Remediation:`,
		`  ${classified.remediation}`,
	];

	if (classified.details && Object.keys(classified.details).length > 0) {
		lines.push(``, `Diagnostic details:`);
		if (classified.details.tlsOk !== undefined) {
			lines.push(`  TLS handshake: ${classified.details.tlsOk ? 'OK' : 'FAILED'}`);
		}
		if (classified.details.healthCheckOk !== undefined) {
			lines.push(`  Health check: ${classified.details.healthCheckOk ? 'OK' : 'FAILED'}`);
		}
		if (classified.details.healthCheckLatency !== undefined) {
			lines.push(`  Health check latency: ${classified.details.healthCheckLatency}ms`);
		}
		if (classified.details.collectionExists !== undefined) {
			lines.push(`  Collection exists: ${classified.details.collectionExists ? 'Yes' : 'No'}`);
		}
		if (classified.details.collectionStatus !== undefined) {
			lines.push(`  Collection status: ${classified.details.collectionStatus}`);
		}
		if (classified.details.embeddingReachable !== undefined) {
			lines.push(`  Embedding API reachable: ${classified.details.embeddingReachable ? 'Yes' : 'No'}`);
		}
	}

	lines.push(``, `Raw error: ${classified.rawError}`);

	return lines.join('\n');
}
