/**
 * Tests pour compare-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CompareConfigArgsSchema, CompareConfigResultSchema } from '../compare-config.js';

// Mock dependencies
const { mockGetConfig, mockCompareRealConfigurations, mockLoadDashboard, mockGetInventory } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockCompareRealConfigurations: vi.fn(),
	mockLoadDashboard: vi.fn(),
	mockGetInventory: vi.fn()
}));

const { mockCompareGranular } = vi.hoisted(() => ({
	mockCompareGranular: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		compareRealConfigurations: mockCompareRealConfigurations,
		loadDashboard: mockLoadDashboard,
		getInventory: mockGetInventory
	})),
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'RooSyncServiceError';
			this.code = code;
		}
	}
}));

vi.mock('../../../services/GranularDiffDetector.js', () => ({
	GranularDiffDetector: class {
		compareGranular(...args: any[]) { return mockCompareGranular(...args); }
	}
}));

describe('compare-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({
			machineId: 'ai-01',
			sharedPath: '/shared/path'
		});
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('CompareConfigArgsSchema', () => {
		test('accepts empty input (all optional)', () => {
			const result = CompareConfigArgsSchema.parse({});
			expect(result).toBeDefined();
		});

		test('accepts source and target', () => {
			const result = CompareConfigArgsSchema.parse({
				source: 'ai-01',
				target: 'po-2023'
			});
			expect(result.source).toBe('ai-01');
			expect(result.target).toBe('po-2023');
		});

		test('accepts granularity enum values', () => {
			for (const g of ['mcp', 'mode', 'full']) {
				const result = CompareConfigArgsSchema.parse({ granularity: g });
				expect(result.granularity).toBe(g);
			}
		});

		test('rejects invalid granularity', () => {
			expect(() => CompareConfigArgsSchema.parse({ granularity: 'partial' })).toThrow();
		});

		test('accepts filter string', () => {
			const result = CompareConfigArgsSchema.parse({ filter: 'jupyter' });
			expect(result.filter).toBe('jupyter');
		});

		test('accepts force_refresh boolean', () => {
			const result = CompareConfigArgsSchema.parse({ force_refresh: true });
			expect(result.force_refresh).toBe(true);
		});

		test('accepts all parameters together', () => {
			const result = CompareConfigArgsSchema.parse({
				source: 'ai-01',
				target: 'po-2023',
				force_refresh: true,
				granularity: 'mcp',
				filter: 'win-cli'
			});
			expect(result.source).toBe('ai-01');
			expect(result.granularity).toBe('mcp');
			expect(result.filter).toBe('win-cli');
		});
	});

	describe('CompareConfigResultSchema', () => {
		test('validates a complete result', () => {
			const result = CompareConfigResultSchema.parse({
				source: 'ai-01',
				target: 'po-2023',
				differences: [
					{
						category: 'roo_config',
						severity: 'CRITICAL',
						path: 'mcp.win-cli',
						description: 'Missing on target'
					}
				],
				summary: {
					total: 1,
					critical: 1,
					important: 0,
					warning: 0,
					info: 0
				}
			});
			expect(result.summary.total).toBe(1);
		});

		test('validates empty differences', () => {
			const result = CompareConfigResultSchema.parse({
				source: 'ai-01',
				target: 'po-2023',
				differences: [],
				summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
			});
			expect(result.differences).toHaveLength(0);
		});

		test('validates result with optional host_id', () => {
			const result = CompareConfigResultSchema.parse({
				source: 'ai-01',
				target: 'po-2023',
				host_id: 'myia-ai-01',
				differences: [],
				summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
			});
			expect(result.host_id).toBe('myia-ai-01');
		});

		test('rejects missing required fields', () => {
			expect(() => CompareConfigResultSchema.parse({
				source: 'ai-01'
			})).toThrow();
		});
	});

	// ============================================================
	// roosyncCompareConfig function
	// ============================================================

	describe('roosyncCompareConfig', () => {
		test('uses standard comparison when no granularity', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' },
					'po-2023': { status: 'online' }
				}
			});
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'ai-01',
				targetMachine: 'po-2023',
				hostId: 'myia-ai-01',
				differences: [
					{
						category: 'software',
						severity: 'WARNING',
						path: 'node.version',
						description: 'Node version mismatch',
						recommendedAction: 'Update Node'
					}
				]
			});

			const { roosyncCompareConfig } = await import('../compare-config.js');
			const result = await roosyncCompareConfig({ target: 'po-2023' });

			expect(result.source).toBe('ai-01');
			expect(result.target).toBe('po-2023');
			expect(mockCompareRealConfigurations).toHaveBeenCalled();
		});

		test('uses GranularDiffDetector when granularity specified', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: {
					mcpServers: {
						'win-cli': { command: 'node', disabled: false },
						'roo-state-manager': { command: 'node', disabled: false }
					}
				}
			});

			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [
					{
						type: 'modified',
						path: 'win-cli.args',
						category: 'roo_config',
						severity: 'CRITICAL',
						description: 'Different args for win-cli'
					}
				],
				stats: { added: 0, removed: 0, modified: 1, unchanged: 1 }
			});

			const { roosyncCompareConfig } = await import('../compare-config.js');
			const result = await roosyncCompareConfig({
				target: 'po-2023',
				granularity: 'mcp'
			});

			expect(mockCompareGranular).toHaveBeenCalled();
			expect(result.differences.length).toBeGreaterThanOrEqual(1);
		});

		test('throws when comparison fails', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' },
					'po-2023': { status: 'online' }
				}
			});
			mockCompareRealConfigurations.mockResolvedValue(null);

			const { roosyncCompareConfig } = await import('../compare-config.js');
			await expect(roosyncCompareConfig({ target: 'po-2023' })).rejects.toThrow();
		});

		test('throws when no target machines available', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' }
				}
			});

			const { roosyncCompareConfig } = await import('../compare-config.js');
			await expect(roosyncCompareConfig({})).rejects.toThrow('Aucune autre machine');
		});

		test('applies filter to granular diffs', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: {
					mcpServers: {
						'win-cli': { disabled: false },
						'jupyter': { disabled: true },
						'playwright': { disabled: false }
					}
				}
			});

			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [
					{
						type: 'modified',
						path: 'win-cli.args',
						category: 'roo_config',
						severity: 'CRITICAL',
						description: 'Different win-cli args'
					},
					{
						type: 'modified',
						path: 'jupyter.disabled',
						category: 'roo_config',
						severity: 'WARNING',
						description: 'Jupyter enabled on target'
					}
				],
				stats: { added: 0, removed: 0, modified: 2, unchanged: 1 }
			});

			const { roosyncCompareConfig } = await import('../compare-config.js');
			const result = await roosyncCompareConfig({
				target: 'po-2023',
				granularity: 'mcp',
				filter: 'jupyter'
			});

			// Only jupyter diff should remain (plus env var diffs)
			const nonEnvDiffs = result.differences.filter(d => d.category !== 'environment');
			expect(nonEnvDiffs.length).toBe(1);
			expect(nonEnvDiffs[0].path).toContain('jupyter');
		});

		test('handles local-machine alias for source', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' },
					'po-2023': { status: 'online' }
				}
			});
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'ai-01',
				targetMachine: 'po-2023',
				differences: []
			});

			const { roosyncCompareConfig } = await import('../compare-config.js');
			const result = await roosyncCompareConfig({
				source: 'local-machine',
				target: 'po-2023'
			});

			// local-machine should be resolved to config.machineId = 'ai-01'
			expect(mockCompareRealConfigurations).toHaveBeenCalledWith('ai-01', 'po-2023', false);
		});
	});
});
