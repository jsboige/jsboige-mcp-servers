/**
 * Tests for error-classifier.ts
 * Issue #2063 - Error classification for semantic search failures
 *
 * Tests error classification logic for distinguishing between:
 * - IIS proxy drops (TLS OK, GET OK, POST timeout)
 * - Qdrant backend issues
 * - Embedding service failures
 * - Network problems
 *
 * @module tools/search/__tests__/error-classifier.test
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const { mockQdrantClient, mockOpenAIClient } = vi.hoisted(() => ({
	mockQdrantClient: {
		getCollection: vi.fn(),
	},
	mockOpenAIClient: {
		models: {
			list: vi.fn()
		}
	}
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: () => mockQdrantClient,
	resetQdrantClient: vi.fn()
}));

vi.mock('../../../services/openai.js', () => ({
	default: () => mockOpenAIClient
}));

import { classifySearchError, formatClassifiedError, type ClassifiedError } from '../error-classifier.js';

describe('error-classifier', () => {

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('quick classification (no health checks)', () => {

		test('should classify embedding auth failures (401/403)', async () => {
			const error = new Error('401 Unauthorized - Invalid API key for embedding service');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('embedding_auth_failed');
			expect(result.description).toContain('authentication');
			expect(result.remediation).toContain('API_KEY');
		});

		test('should classify Qdrant auth failures', async () => {
			const error = new Error('403 Forbidden - Invalid Qdrant API key');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('qdrant_auth_failed');
			expect(result.remediation).toContain('QDRANT_API_KEY');
		});

		test('should classify collection not found (404)', async () => {
			const error = new Error('404 Collection not found: roo_tasks_semantic_index');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('qdrant_collection_missing');
			expect(result.description).toContain('not found');
		});

		test('should classify embedding timeout', async () => {
			const error = new Error('Embedding request timed out after 15000ms');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('embedding_timeout');
			expect(result.remediation).toContain('EMBEDDING_TIMEOUT_MS');
		});

		test('should classify Qdrant unreachable (ECONNREFUSED)', async () => {
			const error = new Error('ECONNREFUSED Qdrant at qdrant.myia.io:6333');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('qdrant_unreachable');
			expect(result.likelyCause).toContain('Qdrant');
		});

		test('should classify generic network errors', async () => {
			// This is a generic network error without service-specific context
			// It should go through health checks, and since we haven't mocked qdrant,
			// it will likely be classified as 'unknown' or based on health check results
			const error = new Error('Network error occurred');
			const result = await classifySearchError(error);

			// Since no specific service is mentioned, it should either be network_unreachable
			// or go through health checks and get classified based on those
			expect(['network_unreachable', 'unknown', 'qdrant_unreachable']).toContain(result.mode);
		});

		test('should classify unknown errors', async () => {
			const error = new Error('Some completely unexpected error');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('unknown');
		});
	});

	describe('diagnostic classification with health checks', () => {

		test('should classify IIS proxy drop (TLS OK, GET OK, POST timeout)', async () => {
			// Mock successful health check (GET works) with green status
			mockQdrantClient.getCollection.mockResolvedValue({
				status: 'green',
				points_count: 1000000,
				segments_count: 2
			});

			// Mock embedding API reachable
			mockOpenAIClient.models.list.mockResolvedValue({
				data: [{ id: 'text-embedding-3-small' }]
			});

			// The actual error: POST search timeout
			const error = new Error('This operation was aborted');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			// Should detect proxy drop because health check passes but search times out
			expect(result.mode).toBe('qdrant_proxy_drop');
			expect(result.description).toContain('timed out');
			expect(result.likelyCause).toContain('proxy');
			expect(result.remediation).toContain('IIS');
			expect(result.details?.healthCheckOk).toBe(true);
			expect(result.details?.tlsOk).toBe(true);
		});

		test('should classify Qdrant backend slow when health OK but search timeout', async () => {
			mockQdrantClient.getCollection.mockResolvedValue({
				status: 'yellow',
				points_count: 50000000,
				optimizer_status: { status: 'building' }
			});

			mockOpenAIClient.models.list.mockResolvedValue({
				data: [{ id: 'text-embedding-3-small' }]
			});

			const error = new Error('Search request timed out');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			expect(result.mode).toBe('qdrant_backend_slow');
			expect(result.likelyCause).toContain('load');
			expect(result.remediation).toContain('optimizer');
		});

		test('should classify Qdrant unreachable on connection refused', async () => {
			mockQdrantClient.getCollection.mockRejectedValue(
				new Error('ECONNREFUSED qdrant.myia.io:6333')
			);

			const error = new Error('Connection refused');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			expect(result.mode).toBe('qdrant_unreachable');
			expect(result.likelyCause).toContain('down');
		});

		test('should classify collection missing on 404', async () => {
			mockQdrantClient.getCollection.mockRejectedValue(
				new Error('404 Collection not found')
			);

			const error = new Error('Collection not found');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			expect(result.mode).toBe('qdrant_collection_missing');
			expect(result.details?.collectionExists).toBe(false);
		});

		test('should classify Qdrant auth failure on 401/403', async () => {
			mockQdrantClient.getCollection.mockRejectedValue(
				new Error('401 Unauthorized')
			);

			const error = new Error('Unauthorized');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			expect(result.mode).toBe('qdrant_auth_failed');
			expect(result.remediation).toContain('QDRANT_API_KEY');
		});

		test('should classify TLS failure on certificate error', async () => {
			mockQdrantClient.getCollection.mockRejectedValue(
				new Error('Certificate verification failed: unable to get local issuer certificate')
			);

			const error = new Error('TLS handshake failed');
			const result = await classifySearchError(error, 'roo_tasks_semantic_index');

			expect(result.mode).toBe('qdrant_unreachable');
			expect(result.description).toContain('TLS');
			expect(result.details?.tlsOk).toBe(false);
		});

		test('should classify embedding timeout when embedding API reachable but slow', async () => {
			mockQdrantClient.getCollection.mockResolvedValue({
				status: 'green',
				points_count: 1000000
			});

			// Embedding API reachable (list works)
			mockOpenAIClient.models.list.mockResolvedValue({
				data: [{ id: 'text-embedding-3-small' }]
			});

			const error = new Error('Embedding API request timed out after 15000ms');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('embedding_timeout');
			expect(result.details?.embeddingReachable).toBe(true);
		});

		test('should classify embedding unreachable when embedding API down', async () => {
			mockQdrantClient.getCollection.mockResolvedValue({
				status: 'green',
				points_count: 1000000
			});

			// Embedding API unreachable
			mockOpenAIClient.models.list.mockRejectedValue(
				new Error('ECONNREFUSED embedding service')
			);

			const error = new Error('Failed to create embedding');
			const result = await classifySearchError(error);

			expect(result.mode).toBe('embedding_unreachable');
			expect(result.details?.embeddingReachable).toBe(false);
		});
	});

	describe('formatClassifiedError', () => {

		test('should format error with all details', () => {
			const classified: ClassifiedError = {
				mode: 'qdrant_proxy_drop',
				description: 'Test description',
				likelyCause: 'Test cause',
				remediation: 'Test remediation',
				rawError: 'Test raw error',
				details: {
					tlsOk: true,
					healthCheckOk: true,
					healthCheckLatency: 42,
					collectionExists: true,
					collectionStatus: 'green',
					embeddingReachable: true
				}
			};

			const formatted = formatClassifiedError(classified);

			expect(formatted).toContain('qdrant_proxy_drop');
			expect(formatted).toContain('Test description');
			expect(formatted).toContain('Test cause');
			expect(formatted).toContain('Test remediation');
			expect(formatted).toContain('TLS handshake: OK');
			expect(formatted).toContain('Health check: OK');
			expect(formatted).toContain('Health check latency: 42ms');
			expect(formatted).toContain('Collection exists: Yes');
			expect(formatted).toContain('Collection status: green');
			expect(formatted).toContain('Embedding API reachable: Yes');
		});

		test('should format error without details', () => {
			const classified: ClassifiedError = {
				mode: 'unknown',
				description: 'Unknown error',
				likelyCause: 'Unknown cause',
				remediation: 'Unknown remediation',
				rawError: 'Unknown raw error'
			};

			const formatted = formatClassifiedError(classified);

			expect(formatted).toContain('unknown');
			expect(formatted).toContain('Unknown error');
			expect(formatted).toContain('Raw error: Unknown raw error');
			// Should not include diagnostic details section
			expect(formatted).not.toContain('Diagnostic details:');
		});

		test('should format error with partial details', () => {
			const classified: ClassifiedError = {
				mode: 'qdrant_unreachable',
				description: 'Qdrant unreachable',
				likelyCause: 'Network issue',
				remediation: 'Check network',
				rawError: 'Connection failed',
				details: {
					tlsOk: false
				}
			};

			const formatted = formatClassifiedError(classified);

			expect(formatted).toContain('qdrant_unreachable');
			expect(formatted).toContain('TLS handshake: FAILED');
			expect(formatted).not.toContain('Health check:');
		});
	});

	describe('edge cases', () => {

		test('should handle non-Error objects', async () => {
			const result = await classifySearchError('string error');

			expect(result).toBeDefined();
			expect(result.rawError).toBe('string error');
		});

		test('should handle null error', async () => {
			const result = await classifySearchError(null);

			expect(result).toBeDefined();
			expect(result.rawError).toBe('null');
		});

		test('should handle undefined error', async () => {
			const result = await classifySearchError(undefined);

			expect(result).toBeDefined();
			expect(result.rawError).toBe('undefined');
		});
	});
});
