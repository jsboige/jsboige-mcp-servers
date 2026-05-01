/**
 * Tests for garbage-scanner.ts
 * Issue #1786 - Coverage for garbage detection and cleanup
 *
 * @module tools/indexing/__tests__/garbage-scanner
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// Mock Qdrant client
vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		delete: vi.fn().mockResolvedValue({ status: 'completed' })
	}))
}));

// Mock RooStorageDetector
const mockDetectStorageLocations = vi.fn();
vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

// Mock fs
vi.mock('fs/promises', () => ({
	stat: vi.fn(),
	unlink: vi.fn()
}));

import { scanForGarbage, cleanupGarbage } from '../garbage-scanner.js';
import * as fs from 'fs/promises';

describe('garbage-scanner', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.QDRANT_COLLECTION_NAME = 'test_collection';

		// Default storage location mock
		mockDetectStorageLocations.mockResolvedValue([{
			type: 'vscode',
			path: '/test/storage'
		}]);

		// Default fs mocks - stat returns a Stats-like object
		vi.mocked(fs.stat).mockResolvedValue({
			size: 1000,
			isFile: () => true,
			isDirectory: () => false,
			mode: 0,
			mtime: new Date(),
			atime: new Date(),
			ctime: new Date(),
			birthtime: new Date()
		} as any);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	// ============================================================
	// scanForGarbage - Death Spiral Detection
	// ============================================================

	describe('scanForGarbage - death spiral detection', () => {
		test('detects repeated 502 errors (death spiral)', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('death-spiral-task', {
				taskId: 'death-spiral-task',
				metadata: {
					messageCount: 20,
					actionCount: 10,
					totalSize: 5000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(15).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502 Bad Gateway - upstream service unavailable'
				}))
			});

			const result = await scanForGarbage(cache, {
				category: 'death_spiral',
				min_messages: 10
			});

			expect(result.flagged).toHaveLength(1);
			expect(result.flagged[0].category).toBe('death_spiral');
			expect(result.flagged[0].task_id).toBe('death-spiral-task');
			expect(result.flagged[0].score).toBeGreaterThan(0.5);
			expect(result.by_category.death_spiral).toBe(1);
		});

		test('detects repeated timeout errors', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('timeout-spiral', {
				taskId: 'timeout-spiral',
				metadata: {
					messageCount: 15,
					actionCount: 5,
					totalSize: 3000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(10).fill(null).map(() => ({
					role: 'assistant',
					content: 'Request timeout after 30s'
				}))
			});

			const result = await scanForGarbage(cache, {
				category: 'death_spiral'
			});

			expect(result.flagged).toHaveLength(1);
			expect(result.flagged[0].details.death_spiral_error).toContain('timeout');
		});

		test('does not flag normal errors as death spiral', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('normal-errors', {
				taskId: 'normal-errors',
				metadata: {
					messageCount: 20,
					actionCount: 10,
					totalSize: 5000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: [
					{ role: 'assistant', content: 'Error: file not found' },
					{ role: 'assistant', content: 'Error: permission denied' },
					{ role: 'assistant', content: 'Success: operation completed' },
					{ role: 'assistant', content: 'Warning: deprecated API' }
				]
			});

			const result = await scanForGarbage(cache, {
				category: 'death_spiral'
			});

			expect(result.flagged).toHaveLength(0);
		});
	});

	// ============================================================
	// scanForGarbage - Duplicate Detection
	// ============================================================

	describe('scanForGarbage - duplicate detection', () => {
		test('detects duplicate skeletons with same metadata', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			const baseMetadata = {
				messageCount: 20,
				actionCount: 10,
				totalSize: 5000,
				machineId: 'test-machine',
				createdAt: '2024-01-01T00:00:00Z'
			};

			cache.set('task-1', {
				taskId: 'task-1',
				metadata: baseMetadata,
				sequence: []
			});
			cache.set('task-2', {
				taskId: 'task-2',
				metadata: baseMetadata,
				sequence: []
			});
			cache.set('task-3', {
				taskId: 'task-3',
				metadata: baseMetadata,
				sequence: []
			});

			const result = await scanForGarbage(cache, {
				category: 'duplicate',
				min_messages: 10
			});

			// task-2 and task-3 should be flagged (duplicates of task-1)
			expect(result.flagged.length).toBeGreaterThanOrEqual(2);
			const duplicates = result.flagged.filter(f => f.category === 'duplicate');
			expect(duplicates.length).toBeGreaterThanOrEqual(2);
			expect(duplicates[0].details.duplicate_group_size).toBe(3);
		});

		test('keeps first occurrence of duplicate group', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			const baseMetadata = {
				messageCount: 15,
				actionCount: 5,
				totalSize: 3000,
				machineId: 'test-machine',
				createdAt: '2024-01-01T00:00:00Z'
			};

			cache.set('original', {
				taskId: 'original',
				metadata: baseMetadata,
				sequence: []
			});
			cache.set('dupe-1', {
				taskId: 'dupe-1',
				metadata: baseMetadata,
				sequence: []
			});

			const result = await scanForGarbage(cache, {
				category: 'duplicate'
			});

			const flaggedIds = result.flagged.map(f => f.task_id);
			expect(flaggedIds).not.toContain('original');
			expect(flaggedIds).toContain('dupe-1');
		});
	});

	// ============================================================
	// scanForGarbage - All Categories
	// ============================================================

	describe('scanForGarbage - all categories combined', () => {
		test('scans all categories when category=all', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			// Death spiral task - 10 identical error messages
			cache.set('death-spiral', {
				taskId: 'death-spiral',
				metadata: {
					messageCount: 20,
					actionCount: 10,
					totalSize: 5000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(10).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502 Bad Gateway service unavailable'
				}))
			});

			// Duplicate task
			const baseMetadata = {
				messageCount: 15,
				actionCount: 5,
				totalSize: 3000,
				machineId: 'test-machine',
				createdAt: '2024-01-01T00:00:00Z'
			};
			cache.set('dup-1', {
				taskId: 'dup-1',
				metadata: baseMetadata,
				sequence: []
			});
			cache.set('dup-2', {
				taskId: 'dup-2',
				metadata: baseMetadata,
				sequence: []
			});

			const result = await scanForGarbage(cache, { category: 'all' });

			expect(result.by_category.death_spiral).toBeGreaterThanOrEqual(1);
			expect(result.by_category.duplicate).toBeGreaterThanOrEqual(1);
			expect(result.total_scanned).toBeGreaterThanOrEqual(2);
		});

		test('respects max_results parameter', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			// Create 5 death spiral tasks
			for (let i = 1; i <= 5; i++) {
				cache.set(`task-${i}`, {
					taskId: `task-${i}`,
					metadata: {
						messageCount: 20,
						actionCount: 10,
						totalSize: 5000,
						machineId: 'test-machine',
						createdAt: '2024-01-01T00:00:00Z'
					},
					sequence: Array(10).fill(null).map(() => ({
						role: 'assistant',
						content: 'Error: 502 Bad Gateway'
					}))
				});
			}

			const result = await scanForGarbage(cache, {
				category: 'death_spiral',
				max_results: 3
			});

			expect(result.flagged).toHaveLength(3);
		});

		test('respects min_messages parameter', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			cache.set('small-task', {
				taskId: 'small-task',
				metadata: {
					messageCount: 5,
					actionCount: 2,
					totalSize: 500,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(5).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502'
				}))
			});

			const result = await scanForGarbage(cache, {
				category: 'death_spiral',
				min_messages: 10
			});

			expect(result.flagged).toHaveLength(0);
			expect(result.total_scanned).toBe(0);
		});
	});

	// ============================================================
	// scanForGarbage - Summary Stats
	// ============================================================

	describe('scanForGarbage - summary statistics', () => {
		test('calculates total_size_flagged correctly', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', {
				taskId: 'task-1',
				metadata: {
					messageCount: 20,
					actionCount: 10,
					totalSize: 5000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(10).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502'
				}))
			});
			cache.set('task-2', {
				taskId: 'task-2',
				metadata: {
					messageCount: 15,
					actionCount: 5,
					totalSize: 3000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(10).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502'
				}))
			});

			const result = await scanForGarbage(cache, { category: 'death_spiral' });

			expect(result.total_size_flagged).toBe(8000); // 5000 + 3000
		});

		test('estimates vectors correctly', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', {
				taskId: 'task-1',
				metadata: {
					messageCount: 10,
					actionCount: 5,
					totalSize: 2000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: Array(10).fill(null).map(() => ({
					role: 'assistant',
					content: 'Error: 502'
				}))
			});

			const result = await scanForGarbage(cache, { category: 'death_spiral' });

			// ~20 vectors per message * 10 messages = 200
			expect(result.estimated_vectors_flagged).toBe(200);
		});
	});

	// ============================================================
	// cleanupGarbage
	// ============================================================

	describe('cleanupGarbage', () => {
		test('does not remove skeletons when remove_skeletons=false', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('keep-task', {
				taskId: 'keep-task',
				metadata: {
					messageCount: 10,
					actionCount: 5,
					totalSize: 1000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: []
			});

			const candidates = [{
				task_id: 'keep-task',
				category: 'low_value' as const,
				score: 0.8,
				details: {
					message_count: 10,
					action_count: 5,
					assistant_message_count: 2,
					error_message_count: 5,
					assistant_ratio: 0.2,
					error_ratio: 0.5,
					total_size: 1000
				}
			}];

			const result = await cleanupGarbage(cache, candidates, {
				remove_skeletons: false,
				remove_vectors: false
			});

			expect(result.skeletons_removed).toBe(0);
			expect(cache.has('keep-task')).toBe(true);
			expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
		});

		test('removes tasks from cache when remove_skeletons=true', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-to-remove', {
				taskId: 'task-to-remove',
				metadata: {
					messageCount: 10,
					actionCount: 5,
					totalSize: 1000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: []
			});

			const candidates = [{
				task_id: 'task-to-remove',
				category: 'low_value' as const,
				score: 0.8,
				details: {
					message_count: 10,
					action_count: 5,
					assistant_message_count: 2,
					error_message_count: 5,
					assistant_ratio: 0.2,
					error_ratio: 0.5,
					total_size: 1000
				}
			}];

			await cleanupGarbage(cache, candidates, {
				remove_skeletons: true,
				remove_vectors: false
			});

			// Cache should be cleared
			expect(cache.has('task-to-remove')).toBe(false);
		});

		test('accumulates cache size in space_freed_bytes', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', {
				taskId: 'task-1',
				metadata: {
					messageCount: 10,
					actionCount: 5,
					totalSize: 2000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z'
				},
				sequence: []
			});

			const candidates = [{
				task_id: 'task-1',
				category: 'low_value' as const,
				score: 0.8,
				details: {
					message_count: 10,
					action_count: 5,
					assistant_message_count: 2,
					error_message_count: 5,
					assistant_ratio: 0.2,
					error_ratio: 0.5,
					total_size: 2000
				}
			}];

			const result = await cleanupGarbage(cache, candidates, {
				remove_skeletons: true,
				remove_vectors: false
			});

			// Should include cache size
			expect(result.space_freed_bytes).toBeGreaterThanOrEqual(2000);
		});
	});
});
