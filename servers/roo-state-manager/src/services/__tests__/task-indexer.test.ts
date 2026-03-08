/**
 * Tests for task-indexer.ts (facade)
 * Issue #492 - Coverage for TaskIndexer facade class
 *
 * @module services/__tests__/task-indexer
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
	mockIndexTask,
	mockResetCollection,
	mockCountPointsByHostOs,
	mockUpdateSkeletonIndexTimestamp,
	mockValidateVectorGlobal,
	mockCheckCollectionHealth,
	mockGetCollectionStatus,
	mockStartHealthCheck,
	mockStopHealthCheck,
	mockDetectStorageLocations,
	mockAccess
} = vi.hoisted(() => ({
	mockIndexTask: vi.fn(),
	mockResetCollection: vi.fn(),
	mockCountPointsByHostOs: vi.fn(),
	mockUpdateSkeletonIndexTimestamp: vi.fn(),
	mockValidateVectorGlobal: vi.fn(),
	mockCheckCollectionHealth: vi.fn(),
	mockGetCollectionStatus: vi.fn(),
	mockStartHealthCheck: vi.fn(),
	mockStopHealthCheck: vi.fn(),
	mockDetectStorageLocations: vi.fn(),
	mockAccess: vi.fn()
}));

vi.mock('../task-indexer/VectorIndexer.js', () => ({
	indexTask: mockIndexTask,
	resetCollection: mockResetCollection,
	countPointsByHostOs: mockCountPointsByHostOs,
	updateSkeletonIndexTimestamp: mockUpdateSkeletonIndexTimestamp,
	upsertPointsBatch: vi.fn(),
	qdrantRateLimiter: {}
}));

vi.mock('../task-indexer/EmbeddingValidator.js', () => ({
	validateVectorGlobal: mockValidateVectorGlobal
}));

vi.mock('../task-indexer/ChunkExtractor.js', () => ({
	getHostIdentifier: vi.fn().mockReturnValue('win32-host')
}));

vi.mock('../task-indexer/QdrantHealthMonitor.js', () => ({
	QdrantHealthMonitor: class {
		checkCollectionHealth = mockCheckCollectionHealth;
		getCollectionStatus = mockGetCollectionStatus;
		startHealthCheck = mockStartHealthCheck;
		stopHealthCheck = mockStopHealthCheck;
	},
	logNetworkMetrics: vi.fn()
}));

vi.mock('../qdrant.js', () => ({
	getQdrantClient: vi.fn().mockReturnValue({})
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

vi.mock('fs', () => ({
	promises: {
		access: mockAccess
	}
}));

import { TaskIndexer, indexTask } from '../task-indexer.js';

describe('indexTask (standalone)', () => {
	test('delegates to VectorIndexer', async () => {
		mockIndexTask.mockResolvedValue([{ id: '1' }]);

		const result = await indexTask('task-1', '/path/to/task');

		expect(mockIndexTask).toHaveBeenCalledWith('task-1', '/path/to/task', 'roo');
		expect(result).toEqual([{ id: '1' }]);
	});
});

describe('TaskIndexer class', () => {
	let indexer: TaskIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = new TaskIndexer();
	});

	test('resetCollection delegates to VectorIndexer', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		await indexer.resetCollection();

		expect(mockResetCollection).toHaveBeenCalledTimes(1);
	});

	test('countPointsByHostOs delegates to VectorIndexer', async () => {
		mockCountPointsByHostOs.mockResolvedValue(42);

		const count = await indexer.countPointsByHostOs('win32-host');

		expect(count).toBe(42);
		expect(mockCountPointsByHostOs).toHaveBeenCalledWith('win32-host');
	});

	test('getCollectionStatus delegates to HealthMonitor', async () => {
		mockGetCollectionStatus.mockResolvedValue({ exists: true, count: 100 });

		const status = await indexer.getCollectionStatus();

		expect(status).toEqual({ exists: true, count: 100 });
	});

	test('startHealthCheck delegates to HealthMonitor', () => {
		indexer.startHealthCheck();
		expect(mockStartHealthCheck).toHaveBeenCalledTimes(1);
	});

	test('stopHealthCheck delegates to HealthMonitor', () => {
		indexer.stopHealthCheck();
		expect(mockStopHealthCheck).toHaveBeenCalledTimes(1);
	});

	test('indexTask finds task in storage location', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockIndexTask.mockResolvedValue([{ id: 'p1' }]);
		mockUpdateSkeletonIndexTimestamp.mockResolvedValue(undefined);

		const result = await indexer.indexTask('task-1');

		expect(result).toEqual([{ id: 'p1' }]);
	});

	test('indexTask throws when task not in any location', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/loc1', '/loc2']);
		mockAccess.mockRejectedValue(new Error('ENOENT'));

		await expect(indexer.indexTask('missing')).rejects.toThrow('not found');
	});

	test('updateSkeletonIndexTimestamp delegates to VectorIndexer', async () => {
		mockUpdateSkeletonIndexTimestamp.mockResolvedValue(undefined);

		await indexer.updateSkeletonIndexTimestamp('task-1', '/storage');

		expect(mockUpdateSkeletonIndexTimestamp).toHaveBeenCalledWith('task-1', '/storage');
	});
});
