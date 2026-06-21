/**
 * Tests pour compare-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { CompareConfigArgsSchema, CompareConfigResultSchema, roosyncCompareConfig, compareModelProfiles } from '../compare-config.js';

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

		test('returns CRITICAL diff when no target machines available (graceful handling)', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' }
				}
			});

				const result = await roosyncCompareConfig({});

				// Should resolve (not reject) with CRITICAL infrastructure difference
				expect(result).toBeDefined();
				expect(result.differences.length).toBeGreaterThan(0);
				const criticalDiff = result.differences.find(d => d.severity === 'CRITICAL');
				expect(criticalDiff).toBeDefined();
				expect(criticalDiff!.description).toContain('Aucune autre machine');
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

		// #1410: Deduplicate baseline-induced false positives
		test('deduplicates identical diffs from baseline comparison', async () => {
			mockLoadDashboard.mockResolvedValue({
				machines: {
					'ai-01': { status: 'online' },
					'po-2023': { status: 'online' }
				}
			});
			// Simulates compareRealConfigurations output where both machines
			// deviate from baseline identically (e.g. both have "Unknown" GPU)
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'ai-01',
				targetMachine: 'po-2023',
				hostId: 'ai-01',
				differences: [
					{
						category: 'hardware',
						severity: 'INFO',
						path: 'hardware.gpu',
						description: 'GPU diff : Unknown vs None',
						recommendedAction: 'Check GPU config',
						machineId: 'ai-01'
					},
					{
						category: 'hardware',
						severity: 'INFO',
						path: 'hardware.gpu',
						description: 'GPU diff : Unknown vs None',
						recommendedAction: 'Check GPU config',
						machineId: 'po-2023'
					},
					{
						category: 'software',
						severity: 'INFO',
						path: 'software.node',
						description: 'Node diff : Unknown vs N/A',
						recommendedAction: 'Update Node',
						machineId: 'ai-01'
					},
					{
						category: 'software',
						severity: 'INFO',
						path: 'software.node',
						description: 'Node diff : Unknown vs N/A',
						recommendedAction: 'Update Node',
						machineId: 'po-2023'
					}
				]
			});

			const result = await roosyncCompareConfig({ target: 'po-2023' });

			// 4 raw diffs -> 2 deduplicated (plus possible env diffs)
			const nonEnvDiffs = result.differences.filter(d => d.category !== 'environment');
			expect(nonEnvDiffs.length).toBe(2);
			expect(nonEnvDiffs.map(d => d.path).sort()).toEqual(['hardware.gpu', 'software.node']);
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

		test('mode granularity compares Roo modes between machines', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: {
					rooModes: {
						'code-simple': { groups: ['read', 'edit', 'browser', 'mcp'], terminal: false },
						'debug-simple': { groups: ['read', 'edit', 'browser', 'mcp'], terminal: false }
					}
				}
			});

			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [
					{
						type: 'modified',
						path: 'code-simple.terminal',
						category: 'roo_config',
						severity: 'WARNING',
						description: 'Terminal setting differs'
					}
				],
				stats: { added: 0, removed: 0, modified: 1, unchanged: 1 }
			});

			const result = await roosyncCompareConfig({
				target: 'po-2023',
				granularity: 'mode'
			});

			expect(mockCompareGranular).toHaveBeenCalled();
			expect(result.differences[0].path).toContain('inventory.rooModes');
			expect(result.differences[0].category).toBe('roo_config');
		});

		test('claude granularity compares Claude Code config', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: {
					claudeConfig: {
						mcpServers: {
							'roo-state-manager': { enabled: true }
						}
					}
				}
			});

			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [
					{
						type: 'added',
						path: 'mcpServers.sk-agent',
						category: 'claude_config',
						severity: 'WARNING',
						description: 'MCP server present on target only'
					}
				],
				stats: { added: 1, removed: 0, modified: 0, unchanged: 1 }
			});

			const result = await roosyncCompareConfig({
				target: 'po-2023',
				granularity: 'claude'
			});

			expect(result.differences[0].path).toContain('inventory.claudeConfig');
			expect(result.differences[0].category).toBe('claude_config');
		});

		test('returns graceful CRITICAL when RooSyncService initialization fails', async () => {
			// Mock getConfig to throw an error (simulating service initialization failure)
			mockGetConfig.mockImplementationOnce(() => {
				throw new Error('ENOENT: no such file or directory, open \'\\\\network\\share\'');
			});

			const result = await roosyncCompareConfig({
				target: 'po-2023'
			});

			expect(result.differences.length).toBe(1);
			expect(result.differences[0].severity).toBe('CRITICAL');
			expect(result.differences[0].description).toContain('manquant ou inaccessible');
			expect(result.summary.critical).toBe(1);
		});
	});

	// ============================================================
	// #2570 — ROO_FLEET_ROSTER consistency check
	// ============================================================
	describe('roosyncCompareConfig — fleet roster consistency (#2570)', () => {
		const FLEET_6 = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];
		const FLEET_5_MISSING_2024 = ['myia-ai-01', 'myia-po-2023', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];

		function mockDashboard6() {
			const machines: Record<string, { status: string }> = {};
			for (const m of FLEET_6) machines[m] = { status: 'online' };
			mockLoadDashboard.mockResolvedValue({ machines });
		}

		test('WARNING when ROO_FLEET_ROSTER unset (partitioning disabled)', async () => {
			mockGetConfig.mockReturnValue({ machineId: 'myia-po-2024', sharedPath: '/shared', fleetRoster: null });
			mockDashboard6();
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'myia-po-2024', targetMachine: 'myia-ai-01', hostId: 'myia-po-2024', differences: []
			});

			const result = await roosyncCompareConfig({ target: 'myia-ai-01' });

			const rosterDiff = result.differences.find(d => d.path === 'env.ROO_FLEET_ROSTER');
			expect(rosterDiff).toBeDefined();
			expect(rosterDiff!.severity).toBe('WARNING');
			expect(rosterDiff!.description).toContain('partitioning DÉSACTIVÉ');
		});

		test('CRITICAL when roster size mismatches dashboard (5 vs 6 → partition drift)', async () => {
			mockGetConfig.mockReturnValue({ machineId: 'myia-po-2026', sharedPath: '/shared', fleetRoster: FLEET_5_MISSING_2024 });
			mockDashboard6();
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'myia-po-2026', targetMachine: 'myia-ai-01', hostId: 'myia-po-2026', differences: []
			});

			const result = await roosyncCompareConfig({ target: 'myia-ai-01' });

			const rosterDiff = result.differences.find(d => d.path === 'env.ROO_FLEET_ROSTER');
			expect(rosterDiff).toBeDefined();
			expect(rosterDiff!.severity).toBe('CRITICAL');
			expect(rosterDiff!.description).toContain('Mismatch taille');
			expect(rosterDiff!.description).toContain('myia-po-2024');
		});

		test('CRITICAL when roster content differs from dashboard (same size, different members)', async () => {
			// Same size 6 but one member swapped
			const swapped = [...FLEET_6];
			swapped[swapped.indexOf('myia-po-2024')] = 'myia-phantom';
			mockGetConfig.mockReturnValue({ machineId: 'myia-po-2024', sharedPath: '/shared', fleetRoster: swapped });
			mockDashboard6();
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'myia-po-2024', targetMachine: 'myia-ai-01', hostId: 'myia-po-2024', differences: []
			});

			const result = await roosyncCompareConfig({ target: 'myia-ai-01' });

			const rosterDiff = result.differences.find(d => d.path === 'env.ROO_FLEET_ROSTER');
			expect(rosterDiff).toBeDefined();
			expect(rosterDiff!.severity).toBe('CRITICAL');
			expect(rosterDiff!.description).toContain('Mismatch contenu');
		});

		test('INFO when roster consistent with dashboard (6/6 canonical)', async () => {
			mockGetConfig.mockReturnValue({ machineId: 'myia-po-2024', sharedPath: '/shared', fleetRoster: FLEET_6 });
			mockDashboard6();
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'myia-po-2024', targetMachine: 'myia-ai-01', hostId: 'myia-po-2024', differences: []
			});

			const result = await roosyncCompareConfig({ target: 'myia-ai-01' });

			const rosterDiff = result.differences.find(d => d.path === 'env.ROO_FLEET_ROSTER');
			expect(rosterDiff).toBeDefined();
			expect(rosterDiff!.severity).toBe('INFO');
			expect(rosterDiff!.description).toContain('consistant');
		});

		test('no roster diff when dashboard load fails (never breaks compare_config)', async () => {
			mockGetConfig.mockReturnValue({ machineId: 'myia-po-2024', sharedPath: '/shared', fleetRoster: null });
			mockLoadDashboard.mockRejectedValue(new Error('GDrive offline'));
			mockCompareRealConfigurations.mockResolvedValue({
				sourceMachine: 'myia-po-2024', targetMachine: 'myia-ai-01', hostId: 'myia-po-2024', differences: []
			});

			const result = await roosyncCompareConfig({ target: 'myia-ai-01' });

			const rosterDiff = result.differences.find(d => d.path === 'env.ROO_FLEET_ROSTER');
			expect(rosterDiff).toBeUndefined(); // check silently skipped, compare_config still returns
		});
	});

	// ============================================================
	// Non-array .profiles robustness (fleet crash 2026-06-21)
	// ============================================================
	describe('compareModelProfiles — non-array .profiles robustness', () => {
		test('does not throw when modelProfile.profiles is a truthy non-array (degraded config sync)', () => {
			// During a config-sync outage (reverse proxy down), the inventory can return
			// modelProfile.profiles as a truthy non-array (keyed object / partial shape).
			// The old `|| []` guard only caught falsy, so `.filter` threw
			// `sourceProfiles.filter is not a function` — fleet-wide crash reproduced
			// 2026-06-21 during the po-203 reverse-proxy outage (po-2024/web1/po-2026).
			const sourceInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: { production: { id: 'production' } } } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: { production: { id: 'production' } } } }
			};

			// Must not throw, and must not emit a false "missing profiles" diff from
			// the degraded (non-array) read.
			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			const profilesDiff = diffs.find(d => d.path === 'roo.modelProfile.profiles');
			expect(profilesDiff).toBeUndefined();
		});

		test('still detects missing profiles when .profiles are proper arrays', () => {
			const sourceInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: ['production', 'dev'] } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: ['production'] } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			const profilesDiff = diffs.find(d => d.path === 'roo.modelProfile.profiles');
			expect(profilesDiff).toBeDefined();
			expect(profilesDiff!.severity).toBe('WARNING');
			expect(profilesDiff!.description).toContain('dev');
		});

		test('does not throw when one side has a non-array .profiles and the other an array', () => {
			// Mixed degraded/healthy reads across the two machines must not crash either.
			const sourceInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: { production: {} } } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: ['production'] } }
			};

			expect(() => compareModelProfiles(sourceInventory, targetInventory)).not.toThrow();
		});
	});
});
