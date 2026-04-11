/**
 * Tests for SynthesisOrchestratorService.ts
 * Issue #492 - Coverage for orchestrator constructor, batch management, cleanup, error paths
 *
 * @module services/synthesis/__tests__/SynthesisOrchestratorService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { SynthesisServiceError, SynthesisServiceErrorCode } from '../../../types/errors.js';

// Mock NarrativeContextBuilderService
const mockBuildNarrativeContext = vi.fn();
class MockNarrativeContextBuilder {
	buildNarrativeContext = mockBuildNarrativeContext;
}

// Mock LLMService
const mockGenerateSynthesis = vi.fn();
const mockCondenseSyntheses = vi.fn();
class MockLLMService {
	generateSynthesis = mockGenerateSynthesis;
	condenseSyntheses = mockCondenseSyntheses;
}

import {
	SynthesisOrchestratorService,
	SynthesisOrchestratorOptions
} from '../SynthesisOrchestratorService.js';

const defaultOptions: SynthesisOrchestratorOptions = {
	synthesisOutputDir: '/tmp/synthesis',
	maxContextSize: 50000,
	maxConcurrency: 2,
	defaultLlmModel: 'test-model'
};

function createService() {
	return new SynthesisOrchestratorService(
		new MockNarrativeContextBuilder() as any,
		new MockLLMService() as any,
		defaultOptions
	);
}

describe('SynthesisOrchestratorService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Constructor
	// ============================================================

	describe('constructor', () => {
		test('creates service with valid dependencies', () => {
			const service = createService();
			expect(service).toBeDefined();
		});

		test('accepts custom options', () => {
			const opts: SynthesisOrchestratorOptions = {
				synthesisOutputDir: '/custom/path',
				maxContextSize: 100000,
				maxConcurrency: 5,
				defaultLlmModel: 'custom-model'
			};
			const service = new SynthesisOrchestratorService(
				new MockNarrativeContextBuilder() as any,
				new MockLLMService() as any,
				opts
			);
			expect(service).toBeDefined();
		});
	});

	// ============================================================
	// synthesizeConversation
	// ============================================================

	describe('synthesizeConversation', () => {
		test('returns analysis with LLM response', async () => {
			const service = createService();

			mockBuildNarrativeContext.mockResolvedValue({
				contextSummary: 'Test context',
				wasCondensed: false,
				buildTrace: {
					rootTaskId: 'task-1',
					parentTaskId: undefined,
					previousSiblingTaskIds: [],
					parentContexts: [],
					siblingContexts: [],
					childContexts: [],
					condensedBatches: []
				}
			});

			mockGenerateSynthesis.mockResolvedValue({
				response: JSON.stringify({
					taskId: 'task-1',
					objectives: { goal: 'test' },
					strategy: { approach: 'simple' },
					quality: { score: 0.9 },
					metrics: {},
					synthesis: {
						initialContextSummary: 'Test',
						finalTaskSummary: 'Done'
					}
				}),
				usage: { totalTokens: 100, estimatedCost: 0.001 },
				context: { modelId: 'test-model' },
				duration: 500
			});

			const result = await service.synthesizeConversation('task-1');

			expect(result.taskId).toBe('task-1');
			expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
			expect(result.llmModelId).toBe('test-model');
		});

		test('returns fallback when LLM response is not valid JSON', async () => {
			const service = createService();

			mockBuildNarrativeContext.mockResolvedValue({
				contextSummary: 'Context',
				wasCondensed: false,
				buildTrace: {
					rootTaskId: 'task-2',
					parentTaskId: undefined,
					previousSiblingTaskIds: []
				}
			});

			mockGenerateSynthesis.mockResolvedValue({
				response: 'This is not valid JSON at all',
				usage: { totalTokens: 50, estimatedCost: 0.0005 },
				context: { modelId: 'test-model' },
				duration: 200
			});

			const result = await service.synthesizeConversation('task-2');

			expect(result.taskId).toBe('task-2');
			expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
			expect(result.objectives).toHaveProperty('rawLlmResponse');
			expect(result.strategy).toHaveProperty('parsingFailed', true);
		});

		test('returns error analysis when LLM call fails', async () => {
			const service = createService();

			mockBuildNarrativeContext.mockResolvedValue({
				contextSummary: 'Context',
				wasCondensed: false,
				buildTrace: {
					rootTaskId: 'task-3',
					parentTaskId: undefined,
					previousSiblingTaskIds: [],
					parentContexts: [],
					siblingContexts: [],
					childContexts: [],
					condensedBatches: []
				}
			});

			mockGenerateSynthesis.mockRejectedValue(new Error('LLM API error'));

			const result = await service.synthesizeConversation('task-3');

			expect(result.taskId).toBe('task-3');
			expect(result.analysisEngineVersion).toBe('3.0.0-phase3-error');
			expect(result.llmModelId).toBe('error-fallback');
			expect(result.metrics.llmError).toBe('LLM API error');
		});

		test('returns error analysis when context building fails', async () => {
			const service = createService();

			mockBuildNarrativeContext.mockRejectedValue(new Error('Context build failed'));

			const result = await service.synthesizeConversation('task-4');

			expect(result.taskId).toBe('task-4');
			expect(result.analysisEngineVersion).toBe('3.0.0-phase3-error');
			expect(result.llmModelId).toBe('error-handler');
			expect(result.metrics.error).toBe('Context build failed');
		});

		test('enriches metrics with context tree data', async () => {
			const service = createService();

			mockBuildNarrativeContext.mockResolvedValue({
				contextSummary: 'Rich context',
				wasCondensed: true,
				condensedBatchPath: '/path/to/condensed',
				buildTrace: {
					rootTaskId: 'root-1',
					parentTaskId: 'parent-1',
					synthesisType: 'hierarchical',
					previousSiblingTaskIds: [],
					parentContexts: [{ taskId: 'parent-1' }],
					siblingContexts: [{ taskId: 'sibling-1' }],
					childContexts: [],
					condensedBatches: [{ path: '/batch/1' }]
				}
			});

			mockGenerateSynthesis.mockResolvedValue({
				response: JSON.stringify({
					objectives: {},
					strategy: {},
					quality: {},
					metrics: {},
					synthesis: {}
				}),
				usage: { totalTokens: 200, estimatedCost: 0.002 },
				context: { modelId: 'gpt-4' },
				duration: 1000
			});

			const result = await service.synthesizeConversation('task-5');

			expect(result.metrics.wasCondensed).toBe(true);
			expect(result.metrics.condensedBatchPath).toBe('/path/to/condensed');
			expect(result.metrics.llmTokens).toBe(200);
			expect(result.metrics.contextTree).toBeDefined();
			expect(result.metrics.contextTree.parentTasks).toHaveLength(1);
			expect(result.metrics.contextTree.siblingTasks).toHaveLength(1);
		});
	});

	// ============================================================
	// updateSynthesisMetadata (not yet implemented)
	// ============================================================

	describe('updateSynthesisMetadata', () => {
		test('updates skeleton with synthesis metadata', async () => {
			const service = createService();
			const skeleton: ConversationSkeleton = {
				taskId: 'test-task',
				workspace: 'test-workspace',
				messages: [],
				metadata: {}
			};
			const analysis: ConversationAnalysis = {
				objectives: { goal: 'Test goal' },
				metrics: { condensedBatchPath: '/tmp/batch.json' }
			} as any;

			const result = await service.updateSynthesisMetadata(skeleton, analysis);

			expect(result.metadata.synthesis).toBeDefined();
			expect(result.metadata.synthesis?.status).toBe('completed');
			expect(result.metadata.synthesis?.headline).toBe('Test goal');
			expect(result.metadata.synthesis?.condensedBatchPath).toBe('/tmp/batch.json');
		});
	});

	// ============================================================
	// Batch methods
	// ============================================================

	describe('startBatchSynthesis', () => {
		test('creates a new batch synthesis task', async () => {
			const service = createService();
			const config: BatchSynthesisConfig = {
				llmModelId: 'test-model',
				maxConcurrency: 2,
				overwriteExisting: false,
				taskFilter: { taskIds: ['task1', 'task2'] }
			};

			const result = await service.startBatchSynthesis(config);

			expect(['queued', 'running']).toContain(result.status);
			expect(result.batchId).toBeDefined();
			expect(result.config).toEqual(config);
			expect(result.progress.totalTasks).toBe(2);
			expect(result.taskIds).toEqual(['task1', 'task2']);
			expect(result.progress.completionPercentage).toBe(0);
		});

		test('throws for workspace-only filter (not yet implemented)', async () => {
			const service = createService();
			const config: BatchSynthesisConfig = {
				llmModelId: 'test-model',
				maxConcurrency: 2,
				overwriteExisting: false,
				taskFilter: { workspace: 'test-workspace' }
			};

			await expect(service.startBatchSynthesis(config))
				.rejects.toThrow(SynthesisServiceError);
		});
	});

	describe('getBatchStatus', () => {
		test('returns null for unknown batch', async () => {
			const service = createService();

			const result = await service.getBatchStatus('unknown-id');
			expect(result).toBeNull();
		});
	});

	describe('cancelBatchSynthesis', () => {
		test('returns false for unknown batch', async () => {
			const service = createService();

			const result = await service.cancelBatchSynthesis('unknown-id');
			expect(result).toBe(false);
		});
	});

	// ============================================================
	// Export
	// ============================================================

	describe('exportSynthesisResults', () => {
		test('throws NO_ANALYSIS_FOUND when no analysis files exist', async () => {
			const service = createService();

			await expect(
				service.exportSynthesisResults(['non-existent-task'], { format: 'json' } as any)
			).rejects.toThrow(SynthesisServiceError);
		});

		test('exports analysis to JSON format', async () => {
			const service = createService();
			const mockFs = vi.importedMocks?.fs || require('fs');

			// Create temporary analysis directory
			const taskId = 'test-export-task';
			const analysisDir = path.join('/tmp/synthesis', taskId);
			await mockFs.promises.mkdir(analysisDir, { recursive: true });

			// Write mock analysis file
			const analysisPath = path.join(analysisDir, 'analysis.json');
			const mockAnalysis = {
				taskId: 'test-export-task',
				objectives: { goal: 'Test export' },
				strategy: { approach: 'simple' },
				quality: { score: 0.8 },
				metrics: {},
				synthesis: { initialContextSummary: 'Test' }
			};
			await mockFs.promises.writeFile(analysisPath, JSON.stringify(mockAnalysis));

			const result = await service.exportSynthesisResults([taskId], { format: 'json' });

			expect(result).toContain('.json');
			expect(result).toContain('exports');

			// Cleanup
			await mockFs.promises.rm(analysisDir, { recursive: true, force: true });
		});

		test('exports analysis to markdown format', async () => {
			const service = createService();
			const mockFs = vi.importedMocks?.fs || require('fs');

			const taskId = 'test-md-task';
			const analysisDir = path.join('/tmp/synthesis', taskId);
			await mockFs.promises.mkdir(analysisDir, { recursive: true });

			const analysisPath = path.join(analysisDir, 'analysis.json');
			const mockAnalysis = {
				taskId: 'test-md-task',
				objectives: { goal: 'Markdown export' },
				synthesis: { initialContextSummary: 'Test MD' }
			};
			await mockFs.promises.writeFile(analysisPath, JSON.stringify(mockAnalysis));

			const result = await service.exportSynthesisResults([taskId], { format: 'markdown' });

			expect(result).toContain('.md');
			expect(result).toContain('exports');

			// Cleanup
			await mockFs.promises.rm(analysisDir, { recursive: true, force: true });
		});

		test('exports multiple analyses to CSV format', async () => {
			const service = createService();
			const mockFs = vi.importedMocks?.fs || require('fs');

			// Create two analysis files
			for (const id of ['task-1', 'task-2']) {
				const analysisDir = path.join('/tmp/synthesis', id);
				await mockFs.promises.mkdir(analysisDir, { recursive: true });

				const analysisPath = path.join(analysisDir, 'analysis.json');
				const mockAnalysis = {
					taskId: id,
					objectives: { goal: `CSV export ${id}` },
					synthesis: { initialContextSummary: `Test ${id}` }
				};
				await mockFs.promises.writeFile(analysisPath, JSON.stringify(mockAnalysis));
			}

			const result = await service.exportSynthesisResults(['task-1', 'task-2'], { format: 'csv' });

			expect(result).toContain('.csv');
			expect(result).toContain('exports');

			// Cleanup
			for (const id of ['task-1', 'task-2']) {
				await mockFs.promises.rm(path.join('/tmp/synthesis', id), { recursive: true, force: true });
			}
		});
	});

	// ============================================================
	// Cleanup
	// ============================================================

	describe('cleanup', () => {
		test('clears active batches', async () => {
			const service = createService();

			await service.cleanup();
			// After cleanup, all batches should be cleared
			const status = await service.getBatchStatus('any');
			expect(status).toBeNull();
		});
	});

	// ============================================================
	// getServiceStats
	// ============================================================

	describe('getServiceStats', () => {
		test('returns stats with zero active batches', () => {
			const service = createService();

			const stats = service.getServiceStats();
			expect(stats.activeBatches).toBe(0);
			expect(stats.totalBatchesProcessed).toBe(0);
			expect(stats.memoryUsage).toBeDefined();
			expect(stats.memoryUsage.heapUsed).toBeGreaterThan(0);
		});
	});
});
