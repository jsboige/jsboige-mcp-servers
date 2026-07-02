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
			// #694: keep orphans a MINORITY (< 50%) so the fleet-safety guard does not abort.
			// 4 total task_ids, 2 in cache → 2 orphans = exactly 50% (not strictly > 50%) → deletion proceeds.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['keep-1', 'keep-2', 'orphan-1', 'orphan-2']));
			mockFindConversationById.mockResolvedValue(null);
			mockDelete.mockResolvedValue({ status: 'completed' });

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('keep-1', makeSkeleton('keep-1'));
			cache.set('keep-2', makeSkeleton('keep-2'));
			const result = await detectAndCleanupOrphans(cache, false, true);

			expect(result.orphans).toEqual(['orphan-1', 'orphan-2']);
			expect(result.fleet_safety_abort).toBeUndefined();
			expect(result.vectors_deleted).toBe(2);
			expect(mockDelete).toHaveBeenCalledTimes(2);
		});

		test('refuses deletion without confirmation', async () => {
			// #694: 2 total task_ids, 1 in cache → 1 orphan = 50% (not > 50%) → reaches confirm gate.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['keep-1', 'orphan-1']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('keep-1', makeSkeleton('keep-1'));
			const result = await detectAndCleanupOrphans(cache, false, false);

			expect(result.orphans).toEqual(['orphan-1']);
			expect(result.fleet_safety_abort).toBeUndefined();
			expect(result.vectors_deleted).toBe(0);
			expect(result.errors).toContain('Confirmation required for deletion. Set confirm=true to proceed.');
		});

		test('continues on individual delete errors', async () => {
			// #694: 4 total task_ids, 2 in cache → 2 orphans = 50% → deletion proceeds past the guard.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['keep-1', 'keep-2', 'orphan-1', 'orphan-2']));
			mockFindConversationById.mockResolvedValue(null);
			mockDelete
				.mockRejectedValueOnce(new Error('Qdrant timeout'))
				.mockResolvedValueOnce({ status: 'completed' });

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('keep-1', makeSkeleton('keep-1'));
			cache.set('keep-2', makeSkeleton('keep-2'));
			const result = await detectAndCleanupOrphans(cache, false, true);

			expect(result.fleet_safety_abort).toBeUndefined();
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

	// ─── #694 fleet-safety abort (mono-machine artifact on fleet-shared collection) ───
	describe('detectAndCleanupOrphans — fleet-safety threshold abort (#694)', () => {
		test('ABORTS deletion when orphans > 50% of total, even with confirm=true (mono-machine artifact)', async () => {
			// Fleet-shared collection: 100 task_ids, this machine only knows 1 → 99 orphans.
			// 99 > 50 (50% of 100) → must abort to avoid destroying the fleet's index.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(
				Array.from({ length: 100 }, (_, i) => `fleet-task-${i}`),
			));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('fleet-task-0', makeSkeleton('fleet-task-0')); // only 1 known locally

			const result = await detectAndCleanupOrphans(cache, false, true); // confirm=true!

			expect(result.total_task_ids_in_qdrant).toBe(100);
			expect(result.orphans.length).toBe(99); // still reported for visibility
			expect(result.fleet_safety_abort).toBe(true);
			expect(result.abort_reason).toContain('FLEET-SAFETY ABORT');
			expect(result.abort_reason).toContain('99 of 100');
			// CRITICAL: no deletion happened despite confirm=true
			expect(result.vectors_deleted).toBe(0);
			expect(mockDelete).not.toHaveBeenCalled();
		});

		test('does NOT abort when orphans are a minority of total (legit single-machine cleanup)', async () => {
			// 100 task_ids, 90 known locally, 10 orphans → 10% < 50% → legit cleanup, no abort.
			const allIds = Array.from({ length: 100 }, (_, i) => `task-${i}`);
			mockScroll.mockResolvedValueOnce(mockScrollResponse(allIds));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			for (let i = 0; i < 90; i++) {
				cache.set(`task-${i}`, makeSkeleton(`task-${i}`));
			}

			const result = await detectAndCleanupOrphans(cache, false, true);

			expect(result.total_task_ids_in_qdrant).toBe(100);
			expect(result.orphans.length).toBe(10);
			expect(result.fleet_safety_abort).toBeUndefined();
			expect(result.abort_reason).toBeUndefined();
			expect(result.vectors_deleted).toBe(10);
			expect(mockDelete).toHaveBeenCalledTimes(10);
		});

		test('surfaces fleet-safety abort in dry-run mode too (early warning before confirm)', async () => {
			// 4 task_ids, 0 known locally → 4 orphans = 100% > 50% → abort flagged even in dry-run.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['t1', 't2', 't3', 't4']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			const result = await detectAndCleanupOrphans(cache, true); // dry-run

			expect(result.fleet_safety_abort).toBe(true);
			expect(result.abort_reason).toContain('4 of 4');
			expect(result.vectors_deleted).toBe(0);
			expect(mockDelete).not.toHaveBeenCalled();
		});

		test('does not abort at exactly 50% boundary (orphan count must STRICTLY exceed threshold)', async () => {
			// 4 task_ids, 2 known → 2 orphans = exactly 50%. 2 > 2.0 is false → no abort.
			mockScroll.mockResolvedValueOnce(mockScrollResponse(['t1', 't2', 't3', 't4']));
			mockFindConversationById.mockResolvedValue(null);

			const cache = new Map<string, ConversationSkeleton>();
			cache.set('t1', makeSkeleton('t1'));
			cache.set('t2', makeSkeleton('t2'));

			const result = await detectAndCleanupOrphans(cache, true);

			expect(result.orphans.length).toBe(2);
			expect(result.fleet_safety_abort).toBeUndefined();
		});
	});
});
