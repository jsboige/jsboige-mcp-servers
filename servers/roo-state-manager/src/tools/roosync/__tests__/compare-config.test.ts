/**
 * Tests pour compare-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { CompareConfigArgsSchema, CompareConfigResultSchema, roosyncCompareConfig } from '../compare-config.js';

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

const { mockIsAvailable, mockExtractSettings, mockExistsSync, mockReadFile, mockReaddir } = vi.hoisted(() => ({
	mockIsAvailable: vi.fn().mockReturnValue(true),
	mockExtractSettings: vi.fn(),
	mockExistsSync: vi.fn().mockReturnValue(false),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn().mockResolvedValue([])
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

vi.mock('../../../services/RooSettingsService.js', () => ({
	RooSettingsService: class {
		isAvailable() { return mockIsAvailable(); }
		extractSettings(...args: any[]) { return mockExtractSettings(...args); }
	},
	SYNC_SAFE_KEYS: new Set([
		'currentApiConfigName', 'listApiConfigMeta', 'apiProvider',
		'autoCondenseContext', 'autoCondenseContextPercent',
		'autoApprovalEnabled', 'alwaysAllowReadOnly',
		'openAiBaseUrl', 'openAiModelId'
	])
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		existsSync: (...args: any[]) => mockExistsSync(...args),
		promises: {
			...actual.promises,
			readFile: (...args: any[]) => mockReadFile(...args),
			readdir: (...args: any[]) => mockReaddir(...args)
		}
	};
});

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
			for (const g of ['mcp', 'mode', 'settings', 'full']) {
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

				await expect(roosyncCompareConfig({ target: 'po-2023' })).rejects.toThrow();
		});

		test('throws when no target machines available', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' }
				}
			});

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

				const result = await roosyncCompareConfig({
				source: 'local-machine',
				target: 'po-2023'
			});

			// local-machine should be resolved to config.machineId = 'ai-01'
			expect(mockCompareRealConfigurations).toHaveBeenCalledWith('ai-01', 'po-2023', false);
		});

		// ============================================================
		// Settings granularity tests (#498/#547)
		// ============================================================

		test('settings granularity compares local live settings vs published target', async () => {
			// Clear env var to use mock config path
			const origEnv = process.env.ROOSYNC_SHARED_PATH;
			delete process.env.ROOSYNC_SHARED_PATH;

			try {
				// Must re-set after vi.clearAllMocks() in beforeEach
				mockIsAvailable.mockReturnValue(true);

				// Mock local live settings
				mockExtractSettings.mockResolvedValue({
					settings: {
						currentApiConfigName: 'Production GLM-5',
						apiProvider: 'openai',
						autoCondenseContext: true,
						autoCondenseContextPercent: 80
					},
					metadata: { machine: 'ai-01', keysCount: 4, totalKeys: 4, mode: 'safe' }
				});

				// Mock published target settings (different profile)
				// Use normalize to handle both / and \ path separators
				mockExistsSync.mockImplementation((p: string) => {
					const norm = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
					if (norm.includes('configs/po-2023')) return true;
					if (norm.includes('roo-settings-safe.json')) return true;
					return false;
				});
				mockReadFile.mockResolvedValue(JSON.stringify({
					settings: {
						currentApiConfigName: 'Dev Local GLM-4.7',
						apiProvider: 'openai',
						autoCondenseContext: true,
						autoCondenseContextPercent: 50
					}
				}));

				mockGetConfig.mockReturnValue({
					machineId: 'ai-01',
					sharedPath: '/shared/path',
					sharedStatePath: '/shared/path'
				});

						const result = await roosyncCompareConfig({
					target: 'po-2023',
					granularity: 'settings'
				});

				expect(result.source).toContain('ai-01');
				expect(result.target).toContain('po-2023');

				// Should detect currentApiConfigName as CRITICAL
				const profileDiff = result.differences.find(
					d => d.path === 'settings.currentApiConfigName'
				);
				expect(profileDiff).toBeDefined();
				expect(profileDiff!.severity).toBe('CRITICAL');

				// Should detect autoCondenseContextPercent as IMPORTANT
				const condenseDiff = result.differences.find(
					d => d.path === 'settings.autoCondenseContextPercent'
				);
				expect(condenseDiff).toBeDefined();
				expect(condenseDiff!.severity).toBe('IMPORTANT');

				// Should NOT flag identical settings (apiProvider, autoCondenseContext)
				const providerDiff = result.differences.find(
					d => d.path === 'settings.apiProvider'
				);
				expect(providerDiff).toBeUndefined();
			} finally {
				if (origEnv !== undefined) process.env.ROOSYNC_SHARED_PATH = origEnv;
			}
		});

		test('settings granularity returns warning when no published settings found', async () => {
			const origEnv = process.env.ROOSYNC_SHARED_PATH;
			delete process.env.ROOSYNC_SHARED_PATH;

			try {
				mockIsAvailable.mockReturnValue(false);
				mockExistsSync.mockReturnValue(false);

				mockGetConfig.mockReturnValue({
					machineId: 'ai-01',
					sharedPath: '/shared/path',
					sharedStatePath: '/shared/path'
				});

						const result = await roosyncCompareConfig({
					target: 'po-2023',
					granularity: 'settings'
				});

				expect(result.differences.length).toBeGreaterThanOrEqual(1);
				expect(result.differences[0].severity).toBe('WARNING');
				expect(result.differences[0].description).toContain('Aucun settings publié');
			} finally {
				if (origEnv !== undefined) process.env.ROOSYNC_SHARED_PATH = origEnv;
			}
		});

		test('settings granularity applies filter correctly', async () => {
			const origEnv = process.env.ROOSYNC_SHARED_PATH;
			delete process.env.ROOSYNC_SHARED_PATH;

			try {
				mockIsAvailable.mockReturnValue(true);

				mockExtractSettings.mockResolvedValue({
					settings: {
						currentApiConfigName: 'Production',
						autoCondenseContextPercent: 80,
						autoApprovalEnabled: true
					},
					metadata: { machine: 'ai-01', keysCount: 3, totalKeys: 3, mode: 'safe' }
				});

				mockExistsSync.mockImplementation((p: string) => {
					const norm = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
					if (norm.includes('configs/po-2023')) return true;
					if (norm.includes('roo-settings-safe.json')) return true;
					return false;
				});
				mockReadFile.mockResolvedValue(JSON.stringify({
					settings: {
						currentApiConfigName: 'Development',
						autoCondenseContextPercent: 50,
						autoApprovalEnabled: false
					}
				}));

				mockGetConfig.mockReturnValue({
					machineId: 'ai-01',
					sharedPath: '/shared/path',
					sharedStatePath: '/shared/path'
				});

						const result = await roosyncCompareConfig({
					target: 'po-2023',
					granularity: 'settings',
					filter: 'condense'
				});

				// Only condense-related diffs should be returned
				const settingsDiffs = result.differences.filter(d => d.category === 'roo_settings');
				expect(settingsDiffs.length).toBe(1);
				expect(settingsDiffs[0].path).toBe('settings.autoCondenseContextPercent');
			} finally {
				if (origEnv !== undefined) process.env.ROOSYNC_SHARED_PATH = origEnv;
			}
		});
	});
});
