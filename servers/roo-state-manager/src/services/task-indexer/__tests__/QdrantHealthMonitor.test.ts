/**
 * Tests for QdrantHealthMonitor.ts
 * Issue #492 - Coverage services task-indexer
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetCollections, mockGetCollection } = vi.hoisted(() => ({
	mockGetCollections: vi.fn(),
	mockGetCollection: vi.fn()
}));

// The source imports from '../qdrant.js' (src/services/qdrant.js)
vi.mock('../../qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		getCollections: mockGetCollections,
		getCollection: mockGetCollection
	}))
}));

describe('QdrantHealthMonitor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ============================================================
	// checkCollectionHealth
	// ============================================================

	test('checkCollectionHealth returns health metrics on success', async () => {
		mockGetCollection.mockResolvedValue({
			status: 'green',
			points_count: 100,
			segments_count: 2,
			indexed_vectors_count: 95,
			optimizer_status: 'ok'
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		const health = await monitor.checkCollectionHealth();

		expect(health.status).toBe('green');
		expect(health.points_count).toBe(100);
		expect(health.segments_count).toBe(2);
		expect(health.indexed_vectors_count).toBe(95);
		expect(health.optimizer_status).toBe('ok');
	});

	test('checkCollectionHealth handles missing fields with defaults', async () => {
		mockGetCollection.mockResolvedValue({});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		const health = await monitor.checkCollectionHealth();

		expect(health.status).toBe('unknown');
		expect(health.points_count).toBe(0);
		expect(health.segments_count).toBe(0);
		expect(health.indexed_vectors_count).toBe(0);
	});

	test('checkCollectionHealth handles optimizer_status object', async () => {
		mockGetCollection.mockResolvedValue({
			status: 'yellow',
			points_count: 50,
			segments_count: 1,
			indexed_vectors_count: 45,
			optimizer_status: { error: 'some error' }
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		const health = await monitor.checkCollectionHealth();

		expect(health.optimizer_status).toBe('some error');
	});

	test('checkCollectionHealth throws on failure', async () => {
		mockGetCollection.mockRejectedValue(new Error('Connection refused'));

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();

		await expect(monitor.checkCollectionHealth()).rejects.toThrow('Connection refused');
	});

	// ============================================================
	// getCollectionStatus
	// ============================================================

	test('getCollectionStatus returns exists:true with count', async () => {
		const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
		mockGetCollections.mockResolvedValue({
			collections: [{ name: expectedCollection }]
		});
		mockGetCollection.mockResolvedValue({ points_count: 42 });

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		const status = await monitor.getCollectionStatus();

		expect(status.exists).toBe(true);
		expect(status.count).toBe(42);
	});

	test('getCollectionStatus returns exists:false when not found', async () => {
		mockGetCollections.mockResolvedValue({
			collections: [{ name: 'other_collection' }]
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		const status = await monitor.getCollectionStatus();

		expect(status.exists).toBe(false);
		expect(status.count).toBe(0);
	});

	test('getCollectionStatus throws on API error', async () => {
		mockGetCollections.mockRejectedValue(new Error('API down'));

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();

		await expect(monitor.getCollectionStatus()).rejects.toThrow('API down');
	});

	// ============================================================
	// startHealthCheck / stopHealthCheck
	// ============================================================

	test('startHealthCheck creates 5-minute interval', async () => {
		mockGetCollection.mockResolvedValue({
			status: 'green',
			points_count: 10,
			segments_count: 1,
			indexed_vectors_count: 10,
			optimizer_status: 'ok'
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		monitor.startHealthCheck();

		// Initial state - no immediate call (setInterval waits first)
		expect(mockGetCollection).toHaveBeenCalledTimes(0);

		// After 5 minutes - first interval fires
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(mockGetCollection).toHaveBeenCalledTimes(1);

		// After another 5 minutes
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(mockGetCollection).toHaveBeenCalledTimes(2);

		monitor.stopHealthCheck();
	});

	test('startHealthCheck does not start twice', async () => {
		mockGetCollection.mockResolvedValue({
			status: 'green',
			points_count: 5,
			segments_count: 1,
			indexed_vectors_count: 5,
			optimizer_status: 'ok'
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		monitor.startHealthCheck();
		monitor.startHealthCheck(); // Second call should be no-op

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		// Only one interval running
		expect(mockGetCollection).toHaveBeenCalledTimes(1);

		monitor.stopHealthCheck();
	});

	test('stopHealthCheck clears interval', async () => {
		mockGetCollection.mockResolvedValue({
			status: 'green',
			points_count: 10,
			segments_count: 1,
			indexed_vectors_count: 10,
			optimizer_status: 'ok'
		});

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		monitor.startHealthCheck();

		// Fire first interval
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(mockGetCollection).toHaveBeenCalledTimes(1);

		monitor.stopHealthCheck();

		// No more calls after stop
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(mockGetCollection).toHaveBeenCalledTimes(1);
	});

	test('stopHealthCheck is safe to call without starting', async () => {
		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		expect(() => monitor.stopHealthCheck()).not.toThrow();
	});

	test('health check interval handles errors gracefully', async () => {
		mockGetCollection.mockRejectedValue(new Error('Intermittent failure'));

		const { QdrantHealthMonitor } = await import('../QdrantHealthMonitor.js');
		const monitor = new QdrantHealthMonitor();
		monitor.startHealthCheck();

		// Should not throw even when checkCollectionHealth throws
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(mockGetCollection).toHaveBeenCalledTimes(1);

		monitor.stopHealthCheck();
	});

	// ============================================================
	// networkMetrics & logNetworkMetrics
	// ============================================================

	test('networkMetrics is exported with initial values', async () => {
		const { networkMetrics } = await import('../QdrantHealthMonitor.js');
		expect(networkMetrics).toBeDefined();
		expect(networkMetrics.qdrantCalls).toBe(0);
		expect(networkMetrics.openaiCalls).toBe(0);
		expect(networkMetrics.cacheHits).toBe(0);
	});

	test('logNetworkMetrics does not throw', async () => {
		const { logNetworkMetrics } = await import('../QdrantHealthMonitor.js');
		expect(() => logNetworkMetrics()).not.toThrow();
	});
});
