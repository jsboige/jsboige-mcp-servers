/**
 * Tests for batch condensation stubs — Strategy A (#1315).
 * Issue #1315 — Implement findExistingCondensedBatch + createCondensedBatch.
 * Focus: Strategy A deterministic condensation (no LLM), disk persistence, in-memory index.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../task-navigator.js', () => ({
	TaskNavigator: class {
		private cache: Map<string, any>;
		constructor(cache: Map<string, any>) { this.cache = cache; }
		getTaskParent() { return null; }
		getTaskChildren() { return []; }
	}
}));

import {
	NarrativeContextBuilderService,
	NarrativeContextBuilderOptions
} from '../NarrativeContextBuilderService.js';
import { SynthesisServiceError, SynthesisServiceErrorCode } from '../../../types/errors.js';

function makeAnalysis(taskId: string, finalTaskSummary: string) {
	return {
		taskId,
		analysisEngineVersion: '1.0.0-test',
		analysisTimestamp: '2026-07-12T10:00:00Z',
		llmModelId: 'test-model',
		contextTrace: { rootTaskId: taskId, parentTaskId: null, previousSiblingTaskIds: [], parentContexts: [], synthesisType: 'test' },
		objectives: {},
		strategy: {},
		quality: {},
		metrics: { messageCount: 10, actionCount: 5 },
		synthesis: { initialContextSummary: '', finalTaskSummary }
	} as any;
}

describe('NarrativeContextBuilderService — batch condensation (#1315 Strategy A)', () => {
	let tmpDir: string;
	let cache: Map<string, any>;
	let options: NarrativeContextBuilderOptions;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncb-batch-'));
		cache = new Map();
		options = {
			synthesisBaseDir: path.join(tmpDir, 'synthesis'),
			condensedBatchesDir: path.join(tmpDir, 'condensed'),
			maxContextSizeBeforeCondensation: 100,
			defaultMaxDepth: 3
		};
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// ============================================================
	// findExistingCondensedBatch
	// ============================================================
	describe('findExistingCondensedBatch', () => {
		test('returns null on empty taskIds', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			expect(await service.findExistingCondensedBatch([])).toBeNull();
		});

		test('returns null when no batch exists (empty dir)', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			expect(await service.findExistingCondensedBatch(['task-1'])).toBeNull();
		});

		test('returns null when taskId not covered by any batch', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			await service.createCondensedBatch([makeAnalysis('task-A', 'summary A')], 'model');
			expect(await service.findExistingCondensedBatch(['task-B'])).toBeNull();
		});

		test('returns null when taskIds span multiple batches', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			await service.createCondensedBatch([makeAnalysis('task-A', 'summary A')], 'model');
			await service.createCondensedBatch([makeAnalysis('task-B', 'summary B')], 'model');
			expect(await service.findExistingCondensedBatch(['task-A', 'task-B'])).toBeNull();
		});

		test('returns batch when all taskIds map to the same batch', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			const created = await service.createCondensedBatch(
				[makeAnalysis('task-A', 'summary A'), makeAnalysis('task-B', 'summary B')],
				'model-x'
			);
			const found = await service.findExistingCondensedBatch(['task-A', 'task-B']);
			expect(found).not.toBeNull();
			expect(found!.batchId).toBe(created.batchId);
			expect(found!.sourceTaskIds.sort()).toEqual(['task-A', 'task-B']);
		});

		test('survives a corrupted batch file in the dir (skipped, not crash)', async () => {
			fs.mkdirSync(options.condensedBatchesDir, { recursive: true });
			fs.writeFileSync(path.join(options.condensedBatchesDir, 'corrupt.json'), '{not valid json');
			const service = new NarrativeContextBuilderService(options, cache);
			// Index load must not throw on the corrupt file.
			expect(await service.findExistingCondensedBatch(['task-1'])).toBeNull();
		});
	});

	// ============================================================
	// createCondensedBatch
	// ============================================================
	describe('createCondensedBatch', () => {
		test('throws NO_ANALYSIS_TO_CONDENSE on empty analyses', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			await expect(service.createCondensedBatch([], 'model')).rejects.toMatchObject({
				code: SynthesisServiceErrorCode.NO_ANALYSIS_TO_CONDENSE
			});
		});

		test('creates a batch with batchId, timestamp, model and sourceTaskIds', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			const batch = await service.createCondensedBatch(
				[makeAnalysis('task-A', 'summary A'), makeAnalysis('task-B', 'summary B')],
				'model-x'
			);
			expect(batch.batchId).toMatch(/^[0-9a-f-]{36}$/i); // UUID
			expect(batch.llmModelId).toBe('model-x');
			expect(batch.creationTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(batch.sourceTaskIds).toEqual(['task-A', 'task-B']);
		});

		test('batchSummary is the deterministic concatenation of finalTaskSummary', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			const batch = await service.createCondensedBatch(
				[makeAnalysis('task-A', 'AAA'), makeAnalysis('task-B', 'BBB')],
				'model'
			);
			expect(batch.batchSummary).toContain('AAA');
			expect(batch.batchSummary).toContain('BBB');
		});

		test('truncates batchSummary to maxContextSizeBeforeCondensation', async () => {
			options.maxContextSizeBeforeCondensation = 20;
			const service = new NarrativeContextBuilderService(options, cache);
			const longSummary = 'X'.repeat(200);
			const batch = await service.createCondensedBatch(
				[makeAnalysis('task-A', longSummary)],
				'model'
			);
			expect(batch.batchSummary.length).toBeLessThanOrEqual(20);
		});

		test('persists the batch as a JSON file under condensedBatchesDir', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			const batch = await service.createCondensedBatch(
				[makeAnalysis('seed-task', 'persisted summary')],
				'model'
			);
			const files = fs.readdirSync(options.condensedBatchesDir).filter(f => f.endsWith('.json'));
			expect(files.length).toBe(1);
			const onDisk = JSON.parse(
				fs.readFileSync(path.join(options.condensedBatchesDir, files[0]), 'utf-8')
			);
			expect(onDisk.batchId).toBe(batch.batchId);
			expect(onDisk.batchSummary).toContain('persisted summary');
		});
	});

	// ============================================================
	// Integration: create then find (in-memory index updated)
	// ============================================================
	describe('integration — create then find', () => {
		test('a freshly created batch is immediately findable via the in-memory index', async () => {
			const service = new NarrativeContextBuilderService(options, cache);
			await service.createCondensedBatch([makeAnalysis('task-X', 'hello')], 'm');
			const found = await service.findExistingCondensedBatch(['task-X']);
			expect(found).not.toBeNull();
			expect(found!.batchSummary).toContain('hello');
		});

		test('a new service instance finds a batch persisted by a previous instance (disk reload)', async () => {
			const service1 = new NarrativeContextBuilderService(options, cache);
			const created = await service1.createCondensedBatch([makeAnalysis('task-Y', 'on disk')], 'm');
			// Nouvelle instance : l'index doit se recharger depuis le disque.
			const service2 = new NarrativeContextBuilderService(options, cache);
			const found = await service2.findExistingCondensedBatch(['task-Y']);
			expect(found).not.toBeNull();
			expect(found!.batchId).toBe(created.batchId);
		});
	});
});
