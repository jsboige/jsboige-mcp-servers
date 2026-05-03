/**
 * Tests for cleanup-orphans.ts
 * Issue #1821 - Qdrant orphan vector detection and cleanup
 *
 * @module tools/indexing/__tests__/cleanup-orphans
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// Mock Qdrant scroll/delete
const mockScroll = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		scroll: mockScroll,
		delete: mockDelete,
	}))
}));

// Mock RooStorageDetector — vi.fn() must be inline (hoisted)
vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		findConversationById: vi.fn(),
		detectStorageLocations: vi.fn().mockResolvedValue([]),
	}
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	access: vi.fn(),
}));

// Mock os
vi.mock('os', () => ({
	homedir: vi.fn(() => '/home/testuser'),
}));

// Mock networkMetrics
vi.mock('../../../services/task-indexer/QdrantHealthMonitor.js', () => ({
	networkMetrics: { qdrantCalls: 0 },
}));

import { detectAndCleanupOrphans } from '../cleanup-orphans.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';

const mockFindConversationById = vi.mocked(RooStorageDetector.findConversationById);

function makeSkeleton(taskId: string): ConversationSkeleton {
	return {
		taskId,
		metadata: {
			messageCount: 5,
			actionCount: 2,
			totalSize: 1000,
			machineId: 'test-machine',
			lastActivity: new Date().toISOString(),
			createdAt: new Date().toISOString(),
		},
	} as ConversationSkeleton;
}

function mockScrollResponse(taskIds: string[], nextOffset?: string) {
	const points = taskIds.map(id => ({ id, payload: { task_id: id } }));
	return { points, next_page_offset: nextOffset || null };
}

describe('cleanup-orphans', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.QDRANT_COLLECTION_NAME = 'test_collection';
		mockDelete.mockResolvedValue({ status: 'completed' });
		vi.mocked(fs.access).mockRejectedValue(new Error('not found'));
		vi.mocked(os.homedir).mockReturnValue('/home/testuser');
	});

	describe('detectAndCleanupOrphans — dry run', () => {
		test('returns empty result when no task_ids in Qdrant', async () => {
			mockScroll.mockResolvedValueOnce({ points: [], next_page_offset: null });

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.total_task_ids_in_qdrant).toBe(0);
			expect(result.orphans).toEqual([]);
			expect(result.vectors_deleted).toBe(0);
			expect(result.errors).toEqual([]);
		});

		test('identifies all task_ids as orphans when cache and disk are empty', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['task-1', 'task-2', 'task-3']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.total_task_ids_in_qdrant).toBe(3);
			expect(result.in_cache).toBe(0);
			expect(result.on_disk).toBe(0);
			expect(result.orphans).toEqual(['task-1', 'task-2', 'task-3']);
			expect(result.vectors_deleted).toBe(0);
		});

		test('recognizes task_ids present in cache as non-orphans', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['task-1', 'task-2', 'task-3']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', makeSkeleton('task-1'));
			cache.set('task-3', makeSkeleton('task-3'));

			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.in_cache).toBe(2);
			expect(result.orphans).toEqual(['task-2']);
		});

		test('recognizes task_ids found on Roo disk as non-orphans', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['task-1', 'task-2']));
			mockFindConversationById
				.mockResolvedValueOnce({ taskId: 'task-1', path: '/some/path' })
				.mockResolvedValueOnce(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.on_disk).toBe(1);
			expect(result.orphans).toEqual(['task-2']);
		});

		test('recognizes task_ids found as Claude sessions as non-orphans', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['claude-task-1']));
			mockFindConversationById.mockResolvedValue(null);
			vi.mocked(fs.access).mockResolvedValueOnce(undefined); // .claude/projects exists
			vi.mocked(fs.access).mockResolvedValueOnce(undefined); // .claude/projects/claude-task-1.jsonl exists

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.on_disk).toBe(1);
			expect(result.orphans).toEqual([]);
		});

		test('does not delete in dry-run mode even with orphans', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['orphan-1']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.orphans).toEqual(['orphan-1']);
			expect(result.vectors_deleted).toBe(0);
			expect(mockDelete).not.toHaveBeenCalled();
		});
	});

	describe('detectAndCleanupOrphans — deletion', () => {
		test('deletes orphans when dryRun=false and confirm=true', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['orphan-1', 'orphan-2']));
			mockFindConversationById.mockResolvedValue(null);
			mockDelete.mockResolvedValue({ status: 'completed' });

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, false, true);

			expect(result.orphans).toEqual(['orphan-1', 'orphan-2']);
			expect(result.vectors_deleted).toBe(2);
			expect(mockDelete).toHaveBeenCalledTimes(2);
		});

		test('refuses deletion without confirmation', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['orphan-1']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, false, false);

			expect(result.orphans).toEqual(['orphan-1']);
			expect(result.vectors_deleted).toBe(0);
			expect(result.errors).toContain('Confirmation required for deletion. Set confirm=true to proceed.');
		});

		test('continues on individual delete errors', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['orphan-1', 'orphan-2']));
			mockFindConversationById.mockResolvedValue(null);
			mockDelete
				.mockRejectedValueOnce(new Error('Qdrant timeout'))
				.mockResolvedValueOnce({ status: 'completed' });

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, false, true);

			expect(result.vectors_deleted).toBe(1);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain('orphan-1');
		});
	});

	describe('detectAndCleanupOrphans — pagination', () => {
		test('scrolls multiple pages of task_ids', async () => {
			mockScroll
				.mockResolvedValueOnce(mockScrollResponse(['task-1', 'task-2'], 'offset-1'))
				.mockResolvedValueOnce(mockScrollResponse(['task-3', 'task-4'], null));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', makeSkeleton('task-1'));

			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.total_task_ids_in_qdrant).toBe(4);
			expect(result.in_cache).toBe(1);
			expect(result.orphans.length).toBe(3);
			expect(mockScroll).toHaveBeenCalledTimes(2);
		});

		test('stops scrolling when no more pages', async () => {
			mockScroll
				.mockResolvedValueOnce(mockScrollResponse(['task-1']))
				.mockResolvedValueOnce({ points: [], next_page_offset: null });
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.total_task_ids_in_qdrant).toBe(1);
		});
	});

	describe('detectAndCleanupOrphans — error handling', () => {
		test('returns error when Qdrant scroll fails', async () => {
			mockScroll.mockRejectedValue(new Error('Connection refused'));

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.total_task_ids_in_qdrant).toBe(0);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain('Failed to scroll Qdrant');
		});

		test('skips task_ids with errors during disk check (keeps them)', async () => {
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['task-1', 'task-2']));
			mockFindConversationById
				.mockRejectedValueOnce(new Error('Permission denied'))
				.mockResolvedValueOnce(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			// task-1 had an error during disk check, so it's not an orphan (safer to keep)
			expect(result.orphans).toEqual(['task-2']);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain('task-1');
		});

		test('handles points with missing payload gracefully', async () => {
			mockScroll.mockResolvedValueOnce({
				points: [
					{ id: 'p1', payload: { task_id: 'valid-task' } },
					{ id: 'p2', payload: {} },
					{ id: 'p3', payload: null },
					{ id: 'p4' },
				],
				next_page_offset: null,
			});
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true);

			// Only the point with valid task_id should be counted
			expect(result.total_task_ids_in_qdrant).toBe(1);
			expect(result.orphans).toEqual(['valid-task']);
		});
	});
});
