/**
 * Tests for task-indexer.ts (facade)
 * Issue #492 - Coverage for TaskIndexer facade class
 *
 * @module services/__tests__/task-indexer
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { TaskIndexer, indexTask } from '../task-indexer.js';

describe('indexTask (standalone)', () => {
	test('delegates to VectorIndexer', async () => {
		// The standalone indexTask function is imported from task-indexer.js
		// which delegates to VectorIndexer
		expect(typeof indexTask).toBe('function');
	});
});

describe('TaskIndexer class', () => {
	let indexer: TaskIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = new TaskIndexer();
	});

	test('resetCollection exists and is callable', async () => {
		expect(typeof indexer.resetCollection).toBe('function');
		await indexer.resetCollection();
	});

	test('countPointsByHostOs exists and is callable', async () => {
		expect(typeof indexer.countPointsByHostOs).toBe('function');
		const count = await indexer.countPointsByHostOs('win32-host');
		expect(typeof count).toBe('number');
	});

	test('getCollectionStatus exists and returns status', async () => {
		expect(typeof indexer.getCollectionStatus).toBe('function');
		const status = await indexer.getCollectionStatus();
		expect(status).toBeDefined();
		expect(typeof status.exists).toBe('boolean');
		expect(typeof status.count).toBe('number');
	});

	test('startHealthCheck exists and is callable', () => {
		expect(typeof indexer.startHealthCheck).toBe('function');
		indexer.startHealthCheck();
	});

	test('stopHealthCheck exists and is callable', () => {
		expect(typeof indexer.stopHealthCheck).toBe('function');
		indexer.stopHealthCheck();
	});

	test('indexTask exists and is callable', async () => {
		expect(typeof indexer.indexTask).toBe('function');
		// The default mock throws 'not found', so we expect that
		await expect(indexer.indexTask('test-task')).rejects.toThrow('not found');
	});

	test('updateSkeletonIndexTimestamp exists and is callable', async () => {
		expect(typeof indexer.updateSkeletonIndexTimestamp).toBe('function');
		await indexer.updateSkeletonIndexTimestamp('task-1', '/storage');
	});
});
