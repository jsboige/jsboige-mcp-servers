/**
 * Tests for NarrativeContextBuilderService.ts
 * Issue #492 - Coverage for synthesis services
 * Focus: tree traversal, cache, sibling collection, context building
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

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

// =============================================================================
// Phase 3 helpers (#1315) — tests de batch condensation
// =============================================================================

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationAnalysis } from '../../../models/synthesis/SynthesisModels.js';

/**
 * Crée un répertoire temporaire unique pour un test, automatiquement nettoyé
 * après exécution (via afterEach dans la suite de tests). Garantit l'isolation
 * entre tests du système de fichiers.
 */
function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `narrative-${prefix}-`));
}

function makeAnalysis(taskId: string, finalTaskSummary: string): ConversationAnalysis {
	return {
		taskId,
		analysisEngineVersion: 'v3',
		analysisTimestamp: '2026-01-15T10:00:00Z',
		llmModelId: 'model-1',
		contextTrace: {
			rootTaskId: taskId,
			previousSiblingTaskIds: [],
			synthesisType: 'atomic'
		},
		objectives: {},
		strategy: {},
		quality: {},
		metrics: {},
		synthesis: {
			initialContextSummary: '',
			finalTaskSummary
		}
	};
}

describe('NarrativeContextBuilderService', () => {
	let cache: Map<string, any>;
	const tempDirs: string[] = [];

	function trackedTempDir(prefix: string): string {
		const dir = makeTempDir(prefix);
		tempDirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		cache = new Map();
	});

	afterEach(() => {
		// Cleanup des répertoires temporaires créés par les tests Phase 3 (#1315)
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
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

		test('returns skeleton-derived analyses for children without disk files', async () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('child-1', createSkeleton('child-1', { parentTaskId: 'parent' }));
			const service = new NarrativeContextBuilderService(defaultOptions, cache);

			// Phase 2: getConversationAnalysis generates from skeleton when no disk file
			const children = await service.collectChildrenSyntheses('parent');
			expect(children).toHaveLength(1);
			expect(children[0].taskId).toBe('child-1');
			expect(children[0].synthesis.finalTaskSummary).toContain('10 messages');
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
	// findExistingCondensedBatch (Phase 3 — issue #1315)
	// ============================================================

	describe('findExistingCondensedBatch', () => {
		test('returns null for empty taskIds', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.findExistingCondensedBatch([]);
			expect(result).toBeNull();
		});

		test('returns null when no batches exist on disk', async () => {
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: trackedTempDir('empty-batches')
			}, cache);
			const result = await service.findExistingCondensedBatch(['task-1', 'task-2']);
			expect(result).toBeNull();
		});

		test('returns existing batch when all taskIds are covered by a single batch', async () => {
			const dir = trackedTempDir('find-single');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			const analyses = [
				makeAnalysis('task-A', 'Alpha summary'),
				makeAnalysis('task-B', 'Beta summary')
			];
			const created = await service.createCondensedBatch(analyses, 'model-1');
			service.clearCaches(); // force lazy reload from disk

			const found = await service.findExistingCondensedBatch(['task-A', 'task-B']);
			expect(found).not.toBeNull();
			expect(found!.batchId).toBe(created.batchId);
			expect(found!.sourceTaskIds).toEqual(['task-A', 'task-B']);
			expect(found!.batchSummary).toContain('Alpha summary');
			expect(found!.batchSummary).toContain('Beta summary');
		});

		test('returns null when taskIds span multiple batches', async () => {
			const dir = trackedTempDir('find-multi');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			await service.createCondensedBatch([makeAnalysis('task-A', 'A')], 'model-1');
			await service.createCondensedBatch([makeAnalysis('task-B', 'B')], 'model-1');
			service.clearCaches();

			const found = await service.findExistingCondensedBatch(['task-A', 'task-B']);
			expect(found).toBeNull();
		});

		test('returns null when any requested taskId has no batch', async () => {
			const dir = trackedTempDir('find-missing');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			await service.createCondensedBatch([makeAnalysis('task-A', 'A')], 'model-1');
			service.clearCaches();

			const found = await service.findExistingCondensedBatch(['task-A', 'task-unknown']);
			expect(found).toBeNull();
		});
	});

	// ============================================================
	// createCondensedBatch (Phase 3 — issue #1315)
	// ============================================================

	describe('createCondensedBatch', () => {
		test('rejects empty analyses array', async () => {
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: trackedTempDir('create-empty')
			}, cache);
			await expect(service.createCondensedBatch([], 'model-1'))
				.rejects.toThrow(/at least one analysis/);
		});

		test('creates a batch with deterministic shape and persists to disk', async () => {
			const dir = trackedTempDir('create-happy');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			const analyses = [
				makeAnalysis('task-X', 'Summary X'),
				makeAnalysis('task-Y', 'Summary Y')
			];

			const batch = await service.createCondensedBatch(analyses, 'model-1');

			expect(batch.batchId).toMatch(/^[0-9a-f-]{36}$/i);
			expect(batch.llmModelId).toBe('model-1');
			expect(batch.sourceTaskIds).toEqual(['task-X', 'task-Y']);
			expect(batch.batchSummary).toContain('[task-X]');
			expect(batch.batchSummary).toContain('Summary X');
			expect(batch.batchSummary).toContain('[task-Y]');
			expect(batch.batchSummary).toContain('Summary Y');
			expect(typeof batch.creationTimestamp).toBe('string');
			expect(new Date(batch.creationTimestamp).toISOString()).toBe(batch.creationTimestamp);

			// Vérifier la persistance
			const fs = await import('fs/promises');
			const entries = await fs.readdir(dir);
			const batchFiles = entries.filter(e => e.startsWith('batch-task-X-') && e.endsWith('.json'));
			expect(batchFiles).toHaveLength(1);
		});

		test('truncates summaries that exceed the per-analysis budget', async () => {
			const dir = trackedTempDir('create-truncate');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir,
				// Permet de tester la troncature : 100 / 2 = 50 chars par analyse.
				maxContextSizeBeforeCondensation: 100
			}, cache);
			const longText = 'A'.repeat(500);
			const analyses = [
				makeAnalysis('task-Long', longText),
				makeAnalysis('task-Short', 'short')
			];

			const batch = await service.createCondensedBatch(analyses, 'model-1');
			// L'entrée pour task-Long doit être tronquée et contenir le marqueur d'ellipse
			const longEntry = batch.batchSummary.split('\n').find(p => p.startsWith('[task-Long]'));
			expect(longEntry).toBeDefined();
			// Bracket + taskId + " " + body : on autorise un peu de marge pour le préfixe "[task-Long] "
			expect(longEntry!.length).toBeLessThan(longText.length);
			expect(longEntry).toMatch(/…$/);
		});

		test('handles analyses with missing finalTaskSummary', async () => {
			const dir = trackedTempDir('create-missing');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			const analyses = [
				{
					taskId: 'task-NS',
					analysisEngineVersion: 'v3',
					analysisTimestamp: '2026-01-15T10:00:00Z',
					llmModelId: 'model-1',
					contextTrace: { rootTaskId: 'task-NS', previousSiblingTaskIds: [], synthesisType: 'atomic' },
					objectives: {}, strategy: {}, quality: {}, metrics: {},
					synthesis: { initialContextSummary: '', finalTaskSummary: '' }
				}
			];

			const batch = await service.createCondensedBatch(analyses as any, 'model-1');
			expect(batch.batchSummary).toContain('[No summary for task-NS]');
		});

		test('indexes all source taskIds for subsequent findExistingCondensedBatch', async () => {
			const dir = trackedTempDir('create-indexed');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			await service.createCondensedBatch(
				[makeAnalysis('idx-1', 'I1'), makeAnalysis('idx-2', 'I2')],
				'model-1'
			);

			const found = await service.findExistingCondensedBatch(['idx-1', 'idx-2']);
			expect(found).not.toBeNull();
			expect(found!.batchSummary).toContain('I1');
			expect(found!.batchSummary).toContain('I2');
		});
	});

	// ============================================================
	// getOrCreateCondensedBatch (Phase 3 — issue #1315, wiring public)
	// ============================================================

	describe('getOrCreateCondensedBatch', () => {
		test('creates a new batch when no existing one covers the taskIds', async () => {
			const dir = trackedTempDir('getorcreate-new');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			const analyses = [makeAnalysis('g-1', 'G1'), makeAnalysis('g-2', 'G2')];

			const batch = await service.getOrCreateCondensedBatch(['g-1', 'g-2'], analyses, 'model-1');
			expect(batch.sourceTaskIds).toEqual(['g-1', 'g-2']);
		});

		test('reuses existing batch when taskIds match exactly', async () => {
			const dir = trackedTempDir('getorcreate-exact');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			const analyses = [makeAnalysis('e-1', 'E1'), makeAnalysis('e-2', 'E2')];
			const first = await service.getOrCreateCondensedBatch(['e-1', 'e-2'], analyses, 'model-1');

			const second = await service.getOrCreateCondensedBatch(['e-1', 'e-2'], analyses, 'model-1');
			expect(second.batchId).toBe(first.batchId);
		});

		test('rejects empty taskIds', async () => {
			const dir = trackedTempDir('getorcreate-empty');
			const service = new NarrativeContextBuilderService({
				...defaultOptions,
				condensedBatchesDir: dir
			}, cache);
			await expect(service.getOrCreateCondensedBatch([], [], 'model-1'))
				.rejects.toThrow(/at least one taskId/);
		});
	});

	// ============================================================
	// getConversationAnalysis
	// ============================================================

	describe('getConversationAnalysis', () => {
		test('returns null when no analysis exists', async () => {
			const service = new NarrativeContextBuilderService(defaultOptions, cache);
			const result = await service.getConversationAnalysis('task-1');
			expect(result).toBeNull();
		});
	});

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
