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
	describe('garbage-scanner — additional coverage (#815 Cluster B)', () => {
		// Helpers
		function makeSkeleton(taskId: string, sequence: any[] = [], overrides: any = {}) {
			return {
				taskId,
				metadata: {
					messageCount: 20,
					actionCount: 10,
					totalSize: 5000,
					machineId: 'test-machine',
					createdAt: '2024-01-01T00:00:00Z',
					...overrides,
				},
				sequence,
			} as ConversationSkeleton;
		}
		function makeCandidate(taskId: string, messageCount = 10) {
			return {
				task_id: taskId,
				category: 'low_value' as const,
				score: 0.8,
				details: {
					message_count: messageCount,
					action_count: 5,
					assistant_message_count: 2,
					error_message_count: 5,
					assistant_ratio: 0.2,
					error_ratio: 0.5,
					total_size: 1000,
				},
			};
		}

		// ─── cleanupGarbage: vector removal path (source L385-405, never exercised before) ───
		describe('cleanupGarbage — vector removal', () => {
			test('deletes Qdrant vectors and counts them when remove_vectors=true', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set('vec-task', makeSkeleton('vec-task'));
				const deleteSpy = vi.fn().mockResolvedValue({ status: 'completed' });
				const { getQdrantClient } = await import('../../../services/qdrant.js');
				vi.mocked(getQdrantClient).mockReturnValue({ delete: deleteSpy } as any);

				const result = await cleanupGarbage(cache, [makeCandidate('vec-task', 10)], {
					remove_skeletons: false,
					remove_vectors: true,
				});

				expect(deleteSpy).toHaveBeenCalledWith(
					'test_collection',
					expect.objectContaining({
						filter: { must: [{ key: 'task_id', match: { value: 'vec-task' } }] },
					}),
				);
				expect(result.vectors_deleted).toBe(200); // 10 messages * 20 vectors (source L401)
				expect(result.errors).toHaveLength(0);
			});

			test('records an error when Qdrant delete rejects', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set('vec-fail', makeSkeleton('vec-fail'));
				const deleteSpy = vi.fn().mockRejectedValue(new Error('Qdrant unreachable'));
				const { getQdrantClient } = await import('../../../services/qdrant.js');
				vi.mocked(getQdrantClient).mockReturnValue({ delete: deleteSpy } as any);

				const result = await cleanupGarbage(cache, [makeCandidate('vec-fail', 10)], {
					remove_skeletons: false,
				remove_vectors: true,
				});

				expect(result.vectors_deleted).toBe(0);
			expect(result.errors.length).toBeGreaterThan(0);
				expect(result.errors[0]).toContain('vec-fail');
			});
		});

		// ─── cleanupGarbage: defaults + edge cases ───
		describe('cleanupGarbage — defaults & edges', () => {
			test('defaults to removing both skeletons and vectors when options are unset (source L341-342)', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set('def-task', makeSkeleton('def-task', [], { totalSize: 1000 }));
			// Module-level mock returns objects, but the real contract is string[] (L72) —
			// override so path.join(locations[0]) works and the file-removal path is exercised.
			mockDetectStorageLocations.mockResolvedValue(['/test/storage']);
				const deleteSpy = vi.fn().mockResolvedValue({ status: 'completed' });
				const { getQdrantClient } = await import('../../../services/qdrant.js');
				vi.mocked(getQdrantClient).mockReturnValue({ delete: deleteSpy } as any);

				const result = await cleanupGarbage(cache, [makeCandidate('def-task', 5)], {}); // no remove_* flags

				expect(cache.has('def-task')).toBe(false); // skeleton removed from cache
				expect(vi.mocked(fs.unlink)).toHaveBeenCalled(); // skeleton file unlinked
				expect(deleteSpy).toHaveBeenCalled(); // vectors removed
				expect(result.vectors_deleted).toBe(100); // 5 * 20
				expect(result.skeletons_removed).toBe(1);
			});

			test('skips a missing skeleton file gracefully (ENOENT) but still clears the cache entry', async () => {
				vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
				const cache = new Map<string, ConversationSkeleton>();
				cache.set('missing', makeSkeleton('missing', [], { totalSize: 750 }));

				const result = await cleanupGarbage(cache, [makeCandidate('missing', 10)], {
					remove_skeletons: true,
					remove_vectors: false,
				});

				expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled(); // stat threw first 	 unlink skipped
				expect(result.skeletons_removed).toBe(0); // file did not exist
				expect(cache.has('missing')).toBe(false); // cache still cleared (source L377-381)
				expect(result.space_freed_bytes).toBeGreaterThanOrEqual(750); // cache totalSize counted
			});

			test('returns an empty result for an empty candidate list', async () => {
				const result = await cleanupGarbage(new Map(), [], {
					remove_skeletons: true,
					remove_vectors: true,
				});

				expect(result.skeletons_removed).toBe(0);
				expect(result.vectors_deleted).toBe(0);
				expect(result.space_freed_bytes).toBe(0);
				expect(result.errors).toHaveLength(0);
			});
		});

		// ─── detectDeathSpiral: normalization + threshold boundary + streak reset ───
		describe('scanForGarbage — death spiral deep branches', () => {
			test('detects a spiral despite differing timestamps (normalization strips them, source L105-110)', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set(
				'ts-spiral',
				makeSkeleton(
				'ts-spiral',
				[
					{ role: 'assistant', content: 'Error 502 at 2024-01-01T10:00:00 after 500ms' },
					{ role: 'assistant', content: 'Error 502 at 2024-01-01T10:00:05 after 600ms' },
					{ role: 'assistant', content: 'Error 502 at 2024-01-01T10:00:10 after 700ms' },
					{ role: 'assistant', content: 'Error 502 at 2024-01-01T10:00:15 after 800ms' },
					{ role: 'assistant', content: 'Error 502 at 2024-01-01T10:00:20 after 900ms' },
				],
				{ messageCount: 20 },
				),
				);

				const result = await scanForGarbage(cache, { category: 'death_spiral', min_messages: 10 });

				expect(result.flagged).toHaveLength(1);
				expect(result.flagged[0].category).toBe('death_spiral');
				expect(result.flagged[0].details.death_spiral_count).toBeGreaterThanOrEqual(5);
			});

			test('does NOT flag at 4 consecutive identical errors (threshold is 5, source L67/L131)', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set('border', makeSkeleton('border', Array(4).fill({ role: 'assistant', content: 'Error 502 bad gateway' })));

				const result = await scanForGarbage(cache, { category: 'death_spiral', min_messages: 10 });

				expect(result.flagged).toHaveLength(0); // streak 4 < 5
			});

			test('an intervening non-error message resets the streak (source L123-126)', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				cache.set(
				'reset',
				makeSkeleton('reset', [
					...Array(3).fill({ role: 'assistant', content: 'Error 502' }),
					{ role: 'assistant', content: 'Success: operation completed' },
					...Array(3).fill({ role: 'assistant', content: 'Error 502' }),
				]),
				);

				const result = await scanForGarbage(cache, { category: 'death_spiral', min_messages: 10 });

				expect(result.flagged).toHaveLength(0); // max streak 3 < 5 after reset
			});
		});

		// ─── duplicate score cap ───
		describe('scanForGarbage — duplicate score cap', () => {
			test('caps duplicate score at 1.0 for large groups (source L285)', async () => {
				const cache = new Map<string, ConversationSkeleton>();
				for (let i = 0; i < 10; i++) {
				cache.set(`d-${i}`, makeSkeleton(`d-${i}`, [], { messageCount: 15, totalSize: 3000 }));
				}

				const result = await scanForGarbage(cache, { category: 'duplicate' });

				const dups = result.flagged.filter(f => f.category === 'duplicate');
				expect(dups.length).toBeGreaterThan(0);
				// score = min(0.5 + group.length(10) * 0.1, 1) = min(1.5, 1) = 1.0
				expect(dups[0].score).toBe(1.0);
				expect(dups.every(f => f.score <= 1.0)).toBe(true);
			});
		});

		// ─── low_value characterization (LATENT BUG — see PR description) ───
		describe('scanForGarbage — low_value characterization', () => {
			test('low_value is currently unreachable: errorRatio <= assistantRatio makes the condition self-contradictory', async () => {
				// Suspected latent bug (#1786 follow-up): low_value requires
				//   assistantRatio < 0.05  AND  errorRatio > 0.5   (source L240-241)
				// but errorCount is incremented ONLY on assistant messages (computeRatios L155-162),
				// so errorCount <= assistantCount, hence errorRatio <= assistantRatio always.
				// The conjunction is unsatisfiable. Even an all-error task has assistantRatio = 1.0.
				// This test locks the CURRENT behavior so any future fix is a deliberate change.
				const cache = new Map<string, ConversationSkeleton>();
				cache.set(
				'lv',
				makeSkeleton('lv', Array(20).fill({ role: 'assistant', content: 'Error 502 bad gateway' })),
				);

				const result = await scanForGarbage(cache, { category: 'low_value', min_messages: 10 });

				expect(result.flagged).toHaveLength(0);
				expect(result.by_category.low_value).toBe(0);
			});
		});
	});

});
