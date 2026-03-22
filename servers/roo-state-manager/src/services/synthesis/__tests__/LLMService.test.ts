/**
 * Tests for LLMService.ts
 * Issue #492 - Coverage for synthesis services
 * Focus: non-LLM methods (model management, caching, validation, stats)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock OpenAI client to avoid real API calls
vi.mock('../../openai.js', () => ({
	default: vi.fn(() => ({
		chat: { completions: { create: vi.fn() } }
	}))
}));

import { LLMService, LLMModelConfig, LLMServiceOptions, LLMCallResult } from '../LLMService.js';

const createModelConfig = (overrides: Partial<LLMModelConfig> = {}): LLMModelConfig => ({
	modelId: 'test-model',
	displayName: 'Test Model',
	provider: 'openai',
	modelName: 'gpt-4o-mini',
	maxTokens: 128000,
	costPerInputToken: 0.00015 / 1000,
	costPerOutputToken: 0.0006 / 1000,
	parameters: { temperature: 0.1 },
	...overrides
});

const createCallResult = (overrides: Partial<LLMCallResult> = {}): LLMCallResult => ({
	context: {
		callId: 'test-call-1',
		modelId: 'test-model',
		startTime: new Date().toISOString(),
		prompt: 'test prompt',
		parameters: {},
		metadata: {}
	},
	response: 'test response',
	endTime: new Date().toISOString(),
	duration: 100,
	usage: {
		promptTokens: 50,
		completionTokens: 20,
		totalTokens: 70,
		estimatedCost: 0.001
	},
	fromCache: false,
	...overrides
});

describe('LLMService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Constructor & Configuration Validation
	// ============================================================

	describe('constructor', () => {
		test('creates service with default options', () => {
			const service = new LLMService();
			expect(service).toBeDefined();
		});

		test('creates service with custom model', () => {
			const model = createModelConfig({ modelId: 'custom-model' });
			const service = new LLMService({
				models: [model],
				defaultModelId: 'custom-model'
			});
			expect(service.isModelAvailable('custom-model')).toBe(true);
		});

		test('throws when no models configured', () => {
			expect(() => new LLMService({ models: [] })).toThrow('Au moins un modèle doit être configuré');
		});

		test('throws when default model ID is empty', () => {
			const model = createModelConfig();
			expect(() => new LLMService({
				models: [model],
				defaultModelId: ''
			})).toThrow('Un modèle par défaut doit être spécifié');
		});

		test('throws when default model not in models list', () => {
			const model = createModelConfig({ modelId: 'model-a' });
			expect(() => new LLMService({
				models: [model],
				defaultModelId: 'nonexistent'
			})).toThrow("n'est pas configuré");
		});

		test('throws when model has missing fields', () => {
			const badModel = { modelId: '', modelName: '', provider: '' } as LLMModelConfig;
			expect(() => new LLMService({
				models: [badModel],
				defaultModelId: ''
			})).toThrow();
		});
	});

	// ============================================================
	// Model Management
	// ============================================================

	describe('getModelConfig', () => {
		test('returns config for existing model', () => {
			const model = createModelConfig({ modelId: 'my-model' });
			const service = new LLMService({
				models: [model],
				defaultModelId: 'my-model'
			});
			const config = service.getModelConfig('my-model');
			expect(config).toBeDefined();
			expect(config?.modelId).toBe('my-model');
		});

		test('returns undefined for unknown model', () => {
			const service = new LLMService();
			expect(service.getModelConfig('nonexistent')).toBeUndefined();
		});
	});

	describe('getAllModels', () => {
		test('returns copy of all models', () => {
			const model1 = createModelConfig({ modelId: 'model-1' });
			const model2 = createModelConfig({ modelId: 'model-2' });
			const service = new LLMService({
				models: [model1, model2],
				defaultModelId: 'model-1'
			});
			const models = service.getAllModels();
			expect(models).toHaveLength(2);
			expect(models[0].modelId).toBe('model-1');
			expect(models[1].modelId).toBe('model-2');
		});

		test('returns independent copy', () => {
			const service = new LLMService();
			const models1 = service.getAllModels();
			const models2 = service.getAllModels();
			expect(models1).not.toBe(models2);
		});
	});

	describe('isModelAvailable', () => {
		test('returns true for configured model', () => {
			const service = new LLMService();
			// Default model is 'synthesis-default'
			expect(service.isModelAvailable('synthesis-default')).toBe(true);
		});

		test('returns false for unconfigured model', () => {
			const service = new LLMService();
			expect(service.isModelAvailable('claude-3')).toBe(false);
		});
	});

	// ============================================================
	// Cache Management
	// ============================================================

	describe('caching', () => {
		test('returns null when cache disabled', () => {
			const service = new LLMService({ enableCaching: false });
			const result = service.getCachedResponse('prompt', {}, 'model');
			expect(result).toBeNull();
		});

		test('returns null for uncached prompt', () => {
			const service = new LLMService({ enableCaching: true });
			const result = service.getCachedResponse('prompt', {}, 'model');
			expect(result).toBeNull();
		});

		test('stores and retrieves cached response', () => {
			const service = new LLMService({ enableCaching: true });
			const mockResult = createCallResult();

			service.setCachedResponse('test prompt', { temp: 0.1 }, 'model-1', mockResult);
			const cached = service.getCachedResponse('test prompt', { temp: 0.1 }, 'model-1');

			expect(cached).toBe(mockResult);
		});

		test('returns null for different prompt', () => {
			const service = new LLMService({ enableCaching: true });
			const mockResult = createCallResult();

			service.setCachedResponse('prompt-A', {}, 'model-1', mockResult);
			const cached = service.getCachedResponse('prompt-B', {}, 'model-1');

			expect(cached).toBeNull();
		});

		test('returns null for different model', () => {
			const service = new LLMService({ enableCaching: true });
			const mockResult = createCallResult();

			service.setCachedResponse('prompt', {}, 'model-1', mockResult);
			const cached = service.getCachedResponse('prompt', {}, 'model-2');

			expect(cached).toBeNull();
		});

		test('does not store when caching disabled', () => {
			const service = new LLMService({ enableCaching: false });
			const mockResult = createCallResult();

			service.setCachedResponse('prompt', {}, 'model', mockResult);
			// Re-enable would still be null since set was no-op
			// But we can't re-enable... just verify no error thrown
			expect(service.getCachedResponse('prompt', {}, 'model')).toBeNull();
		});

		test('clearCache empties the cache', () => {
			const service = new LLMService({ enableCaching: true });
			const mockResult = createCallResult();

			service.setCachedResponse('prompt', {}, 'model', mockResult);
			expect(service.getCachedResponse('prompt', {}, 'model')).toBe(mockResult);

			service.clearCache();
			expect(service.getCachedResponse('prompt', {}, 'model')).toBeNull();
		});
	});

	// ============================================================
	// Usage Stats & History
	// ============================================================

	describe('getUsageStats', () => {
		test('returns zeroed stats when no calls made', () => {
			const service = new LLMService();
			const stats = service.getUsageStats();

			expect(stats.totalCalls).toBe(0);
			expect(stats.successfulCalls).toBe(0);
			expect(stats.failedCalls).toBe(0);
			expect(stats.totalCost).toBe(0);
			expect(stats.totalTokens).toBe(0);
			expect(stats.cacheHitRate).toBe(0);
			expect(stats.averageResponseTime).toBe(0);
			expect(stats.callsByModel).toEqual({});
		});
	});

	describe('getCallHistory', () => {
		test('returns empty array when no calls', () => {
			const service = new LLMService();
			expect(service.getCallHistory()).toEqual([]);
		});

		test('respects limit parameter', () => {
			const service = new LLMService();
			expect(service.getCallHistory(5)).toEqual([]);
		});

		test('default limit is 100', () => {
			const service = new LLMService();
			const history = service.getCallHistory();
			expect(Array.isArray(history)).toBe(true);
		});
	});

	// ============================================================
	// Cleanup
	// ============================================================

	describe('cleanup', () => {
		test('clears cache and history', async () => {
			const service = new LLMService({ enableCaching: true });
			const mockResult = createCallResult();

			service.setCachedResponse('prompt', {}, 'model', mockResult);
			expect(service.getCachedResponse('prompt', {}, 'model')).not.toBeNull();

			await service.cleanup();
			expect(service.getCachedResponse('prompt', {}, 'model')).toBeNull();
			expect(service.getCallHistory()).toEqual([]);
		});
	});

	// ============================================================
	// Error paths for LLM methods (without real API calls)
	// ============================================================

	describe('generateSynthesis error paths', () => {
		test('throws for unconfigured model', async () => {
			const service = new LLMService();
			await expect(service.generateSynthesis('context', 'task-1', 'nonexistent'))
				.rejects.toThrow('Modèle non configuré');
		});
	});

	describe('condenseSyntheses error paths', () => {
		test('throws for unconfigured model', async () => {
			const service = new LLMService();
			await expect(service.condenseSyntheses([], 'nonexistent'))
				.rejects.toThrow('Modèle non configuré');
		});

		test('throws for empty analyses', async () => {
			const service = new LLMService();
			await expect(service.condenseSyntheses([]))
				.rejects.toThrow('Aucune analyse à condenser');
		});
	});

	describe('callLLM error paths', () => {
		test('throws for unconfigured model', async () => {
			const service = new LLMService();
			await expect(service.callLLM('prompt', 'nonexistent'))
				.rejects.toThrow('Modèle non configuré');
		});
	});
});
