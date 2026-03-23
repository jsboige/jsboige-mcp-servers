/**
 * Tests for NarrativeContextBuilderService.ts
 * Issue #492 - Coverage for synthesis services
 * Focus: tree traversal, cache, sibling collection, context building
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock TaskNavigator
vi.mock('../../task-navigator.js', () => ({
	TaskNavigator: class {
		private cache: Map<string, any>;
		constructor(cache: Map<string, any>) { this.cache = cache; }
		getTaskParent(taskId: string) {
			const task = this.cache.get(taskId);
			if (task?.parentTaskId) return this.cache.get(task.parentTaskId) || null;
			return null;
		}
		getTaskChildren(taskId: string) {
			const children: any[] = [];
			for (const s of this.cache.values()) {
				if (s.parentTaskId === taskId) children.push(s);
			}
			return children;
		}
	}
}));

import {
	NarrativeContextBuilderService,
	NarrativeContextBuilderOptions,
	TreeTraversalResult
} from '../NarrativeContextBuilderService.js';

function createSkeleton(taskId: string, overrides: Record<string, any> = {}) {
	return {
		taskId,
		parentTaskId: overrides.parentTaskId ?? null,
		metadata: {
			title: overrides.title ?? `Task ${taskId}`,
			messageCount: overrides.messageCount ?? 10,
			actionCount: overrides.actionCount ?? 5,
			workspace: overrides.workspace ?? '/test/workspace',
			mode: overrides.mode ?? 'code',
			lastActivity: overrides.lastActivity ?? '2026-01-15T10:00:00Z'
		},
		sequence: overrides.sequence ?? []
	};
}

const defaultOptions: NarrativeContextBuilderOptions = {
	synthesisBaseDir: '/tmp/synthesis',
	condensedBatchesDir: '/tmp/condensed',
	maxContextSizeBeforeCondensation: 100000,
	defaultMaxDepth: 3
};

describe('NarrativeContextBuilderService', () => {
	let cache: Map<string, any>;

	beforeEach(() => {
		vi.clearAllMocks();
		cache = new Map();
	});

	// ============================================================
	// Constructor & Basic Setup
	// ============================================================

	describe('constructor', () => {
		test('creates service with options and cache', () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			expect(service).toBeDefined();
		});
	});

	// ============================================================
	// Cache Management
	// ============================================================

	describe('clearCaches', () => {
		test('clears analysis cache without affecting conversation cache', () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			service.clearCaches();

			// Conversation cache should not be cleared (it's global)
			expect(cache.size).toBe(1);
		});
	});

	describe('getCacheStats', () => {
		test('returns correct skeleton cache size', () => {
			cache.set('task-1', createSkeleton('task-1'));
			cache.set('task-2', createSkeleton('task-2'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const stats = service.getCacheStats();
			expect(stats.skeletonCacheSize).toBe(2);
			expect(stats.analysisCacheSize).toBe(0);
			expect(stats.memoryUsage).toBeDefined();
		});

		test('returns zero for empty cache', () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const stats = service.getCacheStats();
			expect(stats.skeletonCacheSize).toBe(0);
			expect(stats.analysisCacheSize).toBe(0);
		});
	});

	// ============================================================
	// getConversationSkeleton
	// ============================================================

	describe('getConversationSkeleton', () => {
		test('returns skeleton from cache', async () => {
			const skeleton = createSkeleton('task-1');
			cache.set('task-1', skeleton);
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.getConversationSkeleton('task-1');
			expect(result).toBe(skeleton);
		});

		test('returns null for missing task', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.getConversationSkeleton('nonexistent');
			expect(result).toBeNull();
		});
	});

	// ============================================================
	// collectSiblingTasks
	// ============================================================

	describe('collectSiblingTasks', () => {
		test('returns empty for task without parent', async () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const siblings = await service.collectSiblingTasks('task-1');
			expect(siblings).toEqual([]);
		});

		test('returns empty for missing task', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const siblings = await service.collectSiblingTasks('nonexistent');
			expect(siblings).toEqual([]);
		});

		test('collects preceding sibling tasks', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('sibling-1', createSkeleton('sibling-1', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T08:00:00Z'
			}));
			cache.set('sibling-2', createSkeleton('sibling-2', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T09:00:00Z'
			}));
			cache.set('target', createSkeleton('target', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T10:00:00Z'
			}));

			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const siblings = await service.collectSiblingTasks('target');

			expect(siblings).toHaveLength(2);
			expect(siblings[0].taskId).toBe('sibling-1');
			expect(siblings[1].taskId).toBe('sibling-2');
		});

		test('excludes subsequent siblings by default', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('target', createSkeleton('target', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T08:00:00Z'
			}));
			cache.set('later', createSkeleton('later', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T12:00:00Z'
			}));

			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const siblings = await service.collectSiblingTasks('target');

			expect(siblings).toHaveLength(0);
		});

		test('includes subsequent siblings when requested', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('target', createSkeleton('target', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T08:00:00Z'
			}));
			cache.set('later', createSkeleton('later', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T12:00:00Z'
			}));

			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const siblings = await service.collectSiblingTasks('target', true);

			expect(siblings).toHaveLength(1);
			expect(siblings[0].taskId).toBe('later');
		});
	});

	// ============================================================
	// traverseUpwards
	// ============================================================

	describe('traverseUpwards', () => {
		test('returns empty result for maxDepth 0', async () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('task-1', 0);
			expect(result.collectedSkeletons).toHaveLength(0);
			expect(result.maxDepthReached).toBe(0);
		});

		test('collects single task at depth 1', async () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('task-1', 1);
			expect(result.collectedSkeletons).toHaveLength(1);
			expect(result.collectedSkeletons[0].taskId).toBe('task-1');
			expect(result.maxDepthReached).toBe(1);
		});

		test('traverses up to parent', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('child', createSkeleton('child', { parentTaskId: 'parent' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('child', 5);
			expect(result.collectedSkeletons).toHaveLength(2);
			expect(result.maxDepthReached).toBe(2);
		});

		test('traverses multi-level hierarchy', async () => {
			cache.set('root', createSkeleton('root'));
			cache.set('mid', createSkeleton('mid', { parentTaskId: 'root' }));
			cache.set('leaf', createSkeleton('leaf', { parentTaskId: 'mid' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('leaf', 10);
			expect(result.collectedSkeletons).toHaveLength(3);
			expect(result.maxDepthReached).toBe(3);
		});

		test('respects maxDepth limit', async () => {
			cache.set('root', createSkeleton('root'));
			cache.set('mid', createSkeleton('mid', { parentTaskId: 'root' }));
			cache.set('leaf', createSkeleton('leaf', { parentTaskId: 'mid' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('leaf', 2);
			// Collects leaf + mid but stops before root (maxDepth=2)
			expect(result.collectedSkeletons).toHaveLength(2);
			expect(result.maxDepthReached).toBe(2);
		});

		test('handles missing task gracefully', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.traverseUpwards('nonexistent', 5);
			expect(result.collectedSkeletons).toHaveLength(0);
		});

		test('handles broken parent chain', async () => {
			// Task points to non-existent parent
			cache.set('orphan', createSkeleton('orphan', { parentTaskId: 'deleted-parent' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.traverseUpwards('orphan', 5);
			expect(result.collectedSkeletons).toHaveLength(1);
			expect(result.collectedSkeletons[0].taskId).toBe('orphan');
		});
	});

	// ============================================================
	// collectChildrenSyntheses
	// ============================================================

	describe('collectChildrenSyntheses', () => {
		test('returns empty for task with no children', async () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const children = await service.collectChildrenSyntheses('task-1');
			expect(children).toEqual([]);
		});

		test('returns empty when children have no analyses', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('child-1', createSkeleton('child-1', { parentTaskId: 'parent' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			// No analysis files exist, so returns empty
			const children = await service.collectChildrenSyntheses('parent');
			expect(children).toEqual([]);
		});
	});

	// ============================================================
	// buildNarrativeContext
	// ============================================================

	describe('buildNarrativeContext', () => {
		test('returns error result for empty taskId', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.buildNarrativeContext('');

			expect(result.contextSummary).toContain('Erreur');
			expect(result.wasCondensed).toBe(false);
		});

		test('returns error result for missing task', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.buildNarrativeContext('nonexistent');

			expect(result.contextSummary).toContain('not found');
			expect(result.buildTrace.rootTaskId).toBe('nonexistent');
		});

		test('builds context for simple task', async () => {
			cache.set('task-1', createSkeleton('task-1', {
				title: 'Simple Test Task',
				messageCount: 5,
				actionCount: 3,
				sequence: [
					{ role: 'user', content: 'Do something' },
					{ role: 'assistant', content: 'Done!' }
				]
			}));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.buildNarrativeContext('task-1');

			expect(result.contextSummary).toContain('task-1');
			expect(result.buildTrace.rootTaskId).toBe('task-1');
			expect(result.wasCondensed).toBe(false);
		});

		test('includes parent context in trace', async () => {
			cache.set('parent', createSkeleton('parent', {
				title: 'Parent Task',
				sequence: [{ role: 'user', content: 'Parent work' }]
			}));
			cache.set('child', createSkeleton('child', {
				parentTaskId: 'parent',
				title: 'Child Task',
				sequence: [{ role: 'user', content: 'Child work' }]
			}));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const result = await service.buildNarrativeContext('child');

			expect(result.buildTrace.parentTaskId).toBe('parent');
		});
	});

	// ============================================================
	// enrichContext
	// ============================================================

	describe('enrichContext', () => {
		test('enriches base context with metadata', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const baseContext = {
				taskId: 'task-1',
				contextSummary: 'Base context'
			};

			const enriched = await service.enrichContext(baseContext);

			expect(enriched.taskId).toBe('task-1');
			expect(enriched.enrichmentMetadata).toBeDefined();
			expect(enriched.enrichmentMetadata.enrichmentTimestamp).toBeDefined();
			expect(enriched.semanticAnalysis).toBeDefined();
			expect(enriched.communicationPatterns).toBeDefined();
			expect(enriched.actorProfiles).toBeDefined();
		});

		test('preserves base context properties', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const baseContext = {
				taskId: 'task-1',
				contextSummary: 'My context',
				customField: 'keep me'
			};

			const enriched = await service.enrichContext(baseContext);

			expect(enriched.contextSummary).toBe('My context');
			expect(enriched.customField).toBe('keep me');
		});
	});

	// ============================================================
	// getConversationAnalysis (cache-only, #777 cleanup)
	// ============================================================

	describe('getConversationAnalysis', () => {
		test('returns null when no analysis is cached', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.getConversationAnalysis('task-1');
			expect(result).toBeNull();
		});
	});

	// ============================================================
	// Retired stubs (#788 Phase 2)
	// findExistingCondensedBatch (#775) — removed
	// createCondensedBatch (#776) — removed
	// ============================================================

	// ============================================================
	// buildContextForTask
	// ============================================================

	describe('buildContextForTask', () => {
		test('returns empty context for missing task', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const context = await service.buildContextForTask('nonexistent');
			expect(context).toBe('');
		});

		test('builds context for task with parent chain', async () => {
			cache.set('root', createSkeleton('root'));
			cache.set('child', createSkeleton('child', { parentTaskId: 'root' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const context = await service.buildContextForTask('child');
			expect(typeof context).toBe('string');
		});
	});

	// ============================================================
	// buildInitialContext
	// ============================================================

	describe('buildInitialContext', () => {
		test('returns string even when no real parents found', async () => {
			cache.set('task-1', createSkeleton('task-1'));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const context = await service.buildInitialContext('task-1', {
				maxDepth: 3,
				maxContextSize: 50000,
				includeSiblings: true,
				includeChildrenSyntheses: true
			});

			// traverseUpwards collects task-1 itself, causing header to be added
			// even though no actual parents exist
			expect(typeof context).toBe('string');
		});

		test('includes parent context when available', async () => {
			cache.set('parent', createSkeleton('parent', { messageCount: 20 }));
			cache.set('child', createSkeleton('child', { parentTaskId: 'parent' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const context = await service.buildInitialContext('child', {
				maxDepth: 3,
				maxContextSize: 50000,
				includeSiblings: true,
				includeChildrenSyntheses: false
			});

			expect(context).toContain('Tâches Parentes');
		});

		test('includes sibling context when enabled', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('sibling', createSkeleton('sibling', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T08:00:00Z'
			}));
			cache.set('target', createSkeleton('target', {
				parentTaskId: 'parent',
				lastActivity: '2026-01-15T10:00:00Z'
			}));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			const context = await service.buildInitialContext('target', {
				maxDepth: 3,
				maxContextSize: 50000,
				includeSiblings: true,
				includeChildrenSyntheses: false
			});

			expect(context).toContain('Tâches Sœurs');
		});
	});
});
