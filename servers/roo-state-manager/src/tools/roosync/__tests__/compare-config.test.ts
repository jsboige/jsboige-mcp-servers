/**
 * Tests pour compare-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { CompareConfigArgsSchema, CompareConfigResultSchema, roosyncCompareConfig, compareModelProfiles, isSecretPath, formatValueForDisplay, buildArbitrationCandidates } from '../compare-config.js';

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

		// #2963 (rule #2) regression tests: never render diff against a missing source.

		test('#2963: target section vide alors que source peuplée → WARNING status, pas de "suppressions fantômes"', async () => {
			// Source has 7 MCPs, target has 0 (degraded collection / mcp_settings.json not read).
			// Previously this rendered as "7 MCP supprimés" in WARNING — false-positive drift
			// that misled a coordinator into thinking the target had lost its config.
			mockGetInventory.mockImplementation((machineId: string) => {
				if (machineId === 'ai-01') {
					return Promise.resolve({
						inventory: { mcpServers: {
							'win-cli': { command: 'node' },
							'roo-state-manager': { command: 'node' },
							'playwright': { command: 'node' },
							'sk-agent': { command: 'node' },
							'searxng': { command: 'node' },
							'markitdown': { command: 'node' },
							'extra-mcp': { command: 'node' },
						}}
					});
				}
				// Target — degraded collection, mcpServers empty
				return Promise.resolve({
					inventory: { mcpServers: {} }
				});
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [],
				stats: { added: 0, removed: 0, modified: 0, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2023',
				granularity: 'mcp'
			});

			// Pre-flight short-circuits: GranularDiffDetector is NOT called.
			expect(mockCompareGranular).not.toHaveBeenCalled();
			expect(result.summary.total).toBe(1);
			expect(result.summary.warning).toBe(1);
			expect(result.summary.critical).toBe(0);
			expect(result.differences[0].category).toBe('inventory');
			expect(result.differences[0].description).toMatch(/vide côté cible.*peuplée côté source/);
		});

		test('#2963: les deux côtés ont 0 MCPs → pas de pre-flight (vrai signal aucun MCP configuré)', async () => {
			// Both sides legitimately empty — real signal "no MCP configured anywhere".
			// Pre-flight must not fire (only fires when ONE side is non-empty).
			mockGetInventory.mockResolvedValue({
				inventory: { mcpServers: {} }
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2023',
				diffs: [],
				stats: { added: 0, removed: 0, modified: 0, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2023',
				granularity: 'mcp'
			});

			// Both sections empty → pre-flight does not fire; GranularDiffDetector runs normally.
			expect(mockCompareGranular).toHaveBeenCalled();
			// No phantom diff emitted (none expected from empty/empty).
			expect(result.summary.critical).toBe(0);
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

	// ============================================================
	// #833 C3 (po-2024): compareModelProfiles core branching (source L927-1037)
	// The sibling describe only covers the non-array `.profiles` robustness
	// edge (the 2026-06-21 fleet crash). The 5 core branches — source/target
	// missing, hash-differ (CRITICAL vs IMPORTANT), happy-path empty, and
	// profileThresholds drift — were untested. Pure function, no mocks.
	// ============================================================
	describe('compareModelProfiles — core branching (#833 C3)', () => {
		test('source missing + target present → WARNING recommending model-configs.json collection', () => {
			// Source L948-960: sourceProfile falsy, targetProfile present → early
			// return with a single WARNING whose action nudges toward collecting
			// model-configs.json, description names the target machine.
			const sourceInventory = { roo: {} }; // no modelProfile
			const targetInventory = {
				machineId: 'myia-po-2025',
				roo: { modelProfile: { hash: 'abc', profiles: [], modeApiConfigs: {} } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);

			expect(diffs).toHaveLength(1);
			expect(diffs[0].severity).toBe('WARNING');
			expect(diffs[0].path).toBe('roo.modelProfile');
			expect(diffs[0].description).toContain('myia-po-2025');
			expect(diffs[0].action).toContain('model-configs.json');
		});

		test('target missing → WARNING recommending Get-MachineInventory.ps1 on target', () => {
			// Source L962-972: source present, target falsy → early return WARNING
			// whose action tells the operator to run inventory on the target machine.
			const sourceInventory = {
				roo: { modelProfile: { hash: 'abc', profiles: [], modeApiConfigs: {} } }
			};
			const targetInventory = { machineId: 'myia-web1', roo: {} };

			const diffs = compareModelProfiles(sourceInventory, targetInventory);

			expect(diffs).toHaveLength(1);
			expect(diffs[0].severity).toBe('WARNING');
			expect(diffs[0].description).toContain('myia-web1');
			expect(diffs[0].action).toContain('Get-MachineInventory.ps1');
		});

		test('both missing → no diff (silent early return, no false positive)', () => {
			// Source L949/L959: sourceProfile falsy AND targetProfile falsy → the
			// `if (targetProfile)` guard is false → return [] without pushing.
			const diffs = compareModelProfiles(
				{ roo: {} },
				{ roo: {} }
			);

			expect(diffs).toEqual([]);
		});

		test('hash differ + modeApiConfigs differ → CRITICAL (sync required)', () => {
			// Source L975-987: hashes differ AND the stringified modeApiConfigs
			// differ → CRITICAL on path modeApiConfigs, counts both sides.
			const sourceInventory = {
				roo: { modelProfile: { hash: 'aaa', modeApiConfigs: { code: { model: 'a' } }, profiles: [] } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'bbb', modeApiConfigs: { code: { model: 'b' }, debug: {} }, profiles: [] } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			const modeDiff = diffs.find(d => d.path === 'roo.modelProfile.modeApiConfigs');

			expect(modeDiff).toBeDefined();
			expect(modeDiff!.severity).toBe('CRITICAL');
			expect(modeDiff!.action).toContain('Synchroniser');
			// Description reports per-side mode counts (1 vs 2).
			expect(modeDiff!.description).toMatch(/1 modes/);
			expect(modeDiff!.description).toMatch(/2 modes/);
		});

		test('hash differ + modeApiConfigs identical → IMPORTANT (whitespace/formatting only)', () => {
			// Source L988-996: hashes differ but modeApiConfigs stringify equal →
			// IMPORTANT (not CRITICAL) on path hash, notes formatting/whitespace.
			const modes = { code: { model: 'a' } };
			const sourceInventory = {
				roo: { modelProfile: { hash: 'aaa', modeApiConfigs: modes, profiles: [] } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'bbb', modeApiConfigs: { code: { model: 'a' } }, profiles: [] } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			const hashDiff = diffs.find(d => d.path === 'roo.modelProfile.hash');

			expect(hashDiff).toBeDefined();
			expect(hashDiff!.severity).toBe('IMPORTANT');
			expect(hashDiff!.description).toContain('formatage');
			// CRITICAL modeApiConfigs diff must NOT also fire.
			expect(diffs.find(d => d.path === 'roo.modelProfile.modeApiConfigs')).toBeUndefined();
		});

		test('identical hashes + identical profiles + identical thresholds → no diff', () => {
			// Source: hash equal (L975 guard false), profiles arrays equal
			// (missingProfiles empty), thresholds equal (L1025 false) → [].
			const sourceInventory = {
				roo: { modelProfile: { hash: 'same', modeApiConfigs: {}, profiles: ['production'], profileThresholds: { opus: 25 } } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'same', modeApiConfigs: {}, profiles: ['production'], profileThresholds: { opus: 25 } } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);

			expect(diffs).toEqual([]);
		});

		test('profileThresholds drift → IMPORTANT per divergent profile', () => {
			// Source L1020-1034: for each source threshold whose target value
			// differs (including undefined on target), push an IMPORTANT diff on
			// path `roo.modelProfile.profileThresholds.{profile}`.
			const sourceInventory = {
				roo: { modelProfile: { hash: 'same', modeApiConfigs: {}, profiles: [], profileThresholds: { opus: 25, haiku: 90 } } }
			};
			const targetInventory = {
				roo: { modelProfile: { hash: 'same', modeApiConfigs: {}, profiles: [], profileThresholds: { opus: 50 } } }
			};

			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			const thresholdDiffs = diffs.filter(d => d.path.startsWith('roo.modelProfile.profileThresholds.'));

			expect(thresholdDiffs).toHaveLength(2);
			expect(thresholdDiffs.every(d => d.severity === 'IMPORTANT')).toBe(true);

			const opusDiff = thresholdDiffs.find(d => d.path.endsWith('.opus'));
			expect(opusDiff!.description).toContain('source=25%');
			expect(opusDiff!.description).toContain('cible=50%');

			// haiku missing on target → reported as "non défini".
			const haikuDiff = thresholdDiffs.find(d => d.path.endsWith('.haiku'));
			expect(haikuDiff!.description).toContain('non défini');
		});

		test('reads modelProfile from the inventory.rooConfig fallback path too', () => {
			// Source L945-946: the optional-chain reads `roo.modelProfile` FIRST,
			// then falls back to `inventory.rooConfig.modelProfile`. When only the
			// fallback path is populated, comparison must still work.
			const sourceInventory = { inventory: { rooConfig: { modelProfile: { hash: 'aaa', modeApiConfigs: {}, profiles: [] } } } };
			const targetInventory = { inventory: { rooConfig: { modelProfile: { hash: 'bbb', modeApiConfigs: {}, profiles: [] } } } };

			const diffs = compareModelProfiles(sourceInventory, targetInventory);
			// hash differ + identical modes → IMPORTANT (proves the fallback read resolved).
			expect(diffs.find(d => d.path === 'roo.modelProfile.hash')).toBeDefined();
		});
	});

	// ============================================================
	// #2963: EXPECTED_MACHINE_FIELDS extended to system.os / architecture / platform / arch
	// These are material facts of each machine — must NOT surface as CRITICAL drift.
	// ============================================================
	describe('#2963: EXPECTED_MACHINE_FIELDS downgrades OS/architecture drift to INFO', () => {
		// Format-comparison helper — verify a diff is downgraded to INFO when its path
		// matches the extended machine-field filter. We exercise this indirectly through
		// the compare-config entry point since applyMachineFieldFilter is private.
		const MACHINE_SPECIFIC_PATHS = [
			'system.os', 'system.architecture', 'system.osVersion', 'system.platform', 'system.arch',
			'systemInfo.os', 'systemInfo.arch', 'roo.system.os', 'inventory.system.architecture',
		];

		for (const path of MACHINE_SPECIFIC_PATHS) {
			test(`path "${path}" is treated as machine-specific (downgraded from CRITICAL)`, async () => {
				// Two machines with the same MCPs but different OS strings (Win11 Pro vs Win10).
				// The diff detector would emit CRITICAL diffs on system.os/architecture.
				// Without the EXPECTED_MACHINE_FIELDS extension, these would surface as 2 CRITICAL.
				mockGetInventory.mockImplementation((machineId: string) => {
					if (machineId === 'ai-01') {
						return Promise.resolve({
							system: { os: 'Windows 11 Pro', architecture: 'x64' },
							inventory: { mcpServers: { 'win-cli': { command: 'node' } } }
						});
					}
					return Promise.resolve({
						system: { os: 'Windows 10 Pro', architecture: 'arm64' },
						inventory: { mcpServers: { 'win-cli': { command: 'node' } } }
					});
				});
				// Diff detector emits CRITICAL for the system field difference.
				mockCompareGranular.mockResolvedValue({
					sourceLabel: 'ai-01',
					targetLabel: 'po-2023',
					diffs: [{
						type: 'modified',
						path,
						category: 'system',
						severity: 'CRITICAL',
						description: `Different ${path} between machines`,
					}],
					stats: { added: 0, removed: 0, modified: 1, unchanged: 0 }
				});

				const result = await roosyncCompareConfig({
					source: 'ai-01',
					target: 'po-2023',
					granularity: 'full'
				});

				// The drift item is present but its severity is downgraded to INFO.
				const drift = result.differences.find(d => d.path === path);
				expect(drift).toBeDefined();
				expect(drift!.severity).toBe('INFO');
				expect(drift!.description).toContain('[EXPECTED]');
				// And it does not inflate the CRITICAL count.
				expect(result.summary.critical).toBe(0);
			});
		}
	});

	// ============================================================
	// #3044 — Valeurs divergentes + secret masking + arbitration grouping
	// Critère d'acceptation : "décider harmoniser ou pas pour chaque écart
	// sans ouvrir aucun fichier de config manuellement".
	// ============================================================

	describe('#3044: diverging values + secret masking + arbitration grouping', () => {
		test('isSecretPath detects API_KEY/SECRET/TOKEN/PASSWORD/ACCESS_KEY/PRIVATE_KEY suffixes', () => {
			// Critère #2 : paths sensibles sur la dernière portion doivent être détectés
			expect(isSecretPath('env.EMBEDDING_API_KEY')).toBe(true);
			expect(isSecretPath('inventory.mcpServers.foo.env.QDRANT_API_KEY')).toBe(true);
			expect(isSecretPath('settings.GITHUB_TOKEN')).toBe(true);
			expect(isSecretPath('mcpServers.sk-agent.env.OPENAI_API_KEY')).toBe(true);
			expect(isSecretPath('claudeConfig.PASSWORD')).toBe(true);
			expect(isSecretPath('claudeConfig.PASSWD')).toBe(true);
			expect(isSecretPath('claudeConfig.AWS_ACCESS_KEY')).toBe(true);
			expect(isSecretPath('claudeConfig.PRIVATE_KEY')).toBe(true);
			expect(isSecretPath('claudeConfig.CLIENT_SECRET')).toBe(true);
			// Non-secrets : ne pas sur-masquer
			expect(isSecretPath('env.OPENAI_MODEL')).toBe(false);
			expect(isSecretPath('mcpServers.sk-agent.command')).toBe(false);
			expect(isSecretPath('settings.autoCondenseContext')).toBe(false);
		});

		test('formatValueForDisplay masks secrets as <set:length:N:hash=...> — NEVER the raw value', () => {
			// Critère #2 : la valeur d'un EMBEDDING_API_KEY ne doit JAMAIS apparaître en clair
			const realKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx';
			const masked = formatValueForDisplay(realKey, 'env.EMBEDDING_API_KEY');
			expect(masked).not.toContain(realKey);
			expect(masked).toMatch(/^<set:length:\d+:hash=[0-9a-f]{8}>$/);
			// La longueur est préservée (utilisable pour audit)
			expect(masked).toContain(`length:${realKey.length}`);
		});

		test('formatValueForDisplay returns <unset>/<empty>/<null> markers — never raw undefined', () => {
			expect(formatValueForDisplay(undefined, 'env.SOME_KEY')).toBe('<unset>');
			expect(formatValueForDisplay(null, 'env.SOME_KEY')).toBe('<null>');
			expect(formatValueForDisplay('', 'env.SOME_KEY')).toBe('<empty>');
		});

		test('formatValueForDisplay truncates long strings at VALUE_DISPLAY_MAX_CHARS (~200) — critère #1', () => {
			const longString = 'A'.repeat(500);
			const out = formatValueForDisplay(longString, 'claudeConfig.someField');
			expect(out.length).toBeLessThanOrEqual(210); // head 60% + ellipsis + tail 30% ≈ 180
			expect(out).toContain('…');
			// Doit commencer et finir par la valeur (pas juste tronqué à gauche)
			expect(out.startsWith('A')).toBe(true);
			expect(out.endsWith('A')).toBe(true);
		});

		test('formatValueForDisplay JSON-stringifies objects/arrays', () => {
			expect(formatValueForDisplay({ command: 'node', disabled: false }, 'mcpServers.win-cli'))
				.toBe('{"command":"node","disabled":false}');
			expect(formatValueForDisplay(['a', 'b'], 'mcpServers.list'))
				.toBe('["a","b"]');
		});

		test('granular mcp diff exposes source_value/target_value (default detail=values) — critère #1', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: {
					mcpServers: {
						'win-cli': { command: 'node', args: ['--old'] }
					}
				}
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2026',
				diffs: [
					{
						type: 'modified',
						path: 'win-cli.args',
						category: 'roo_config',
						severity: 'WARNING',
						description: 'Élément modifié: \'win-cli.args\'',
						oldValue: ['--old'],
						newValue: ['--new', '--with-flag'],
					}
				],
				stats: { added: 0, removed: 0, modified: 1, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'mcp'
			});

			expect(result.detail).toBe('values');
			const diff = result.differences.find(d => d.path === 'inventory.mcpServers.win-cli.args');
			expect(diff).toBeDefined();
			expect(diff!.source_value).toBe('["--old"]');
			expect(diff!.target_value).toBe('["--new","--with-flag"]');
			expect(diff!.diff_kind).toBe('value_differs');
		});

		test('granular mcp diff EXCLUDES source_value/target_value when detail="paths" — critère #3', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: { mcpServers: { 'win-cli': { command: 'node' } } }
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2026',
				diffs: [{
					type: 'modified',
					path: 'win-cli.args',
					category: 'roo_config',
					severity: 'WARNING',
					description: 'Élément modifié',
					oldValue: ['--old'],
					newValue: ['--new']
				}],
				stats: { added: 0, removed: 0, modified: 1, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'mcp',
				detail: 'paths'
			});

			expect(result.detail).toBe('paths');
			const diff = result.differences.find(d => d.path === 'inventory.mcpServers.win-cli.args');
			expect(diff).toBeDefined();
			expect(diff!.source_value).toBeUndefined();
			expect(diff!.target_value).toBeUndefined();
			// diff_kind reste (utilisé par arbitration_candidates)
			expect(diff!.diff_kind).toBe('value_differs');
		});

		test('SECRET in env var is masked in source_value/target_value — NO raw key in output', async () => {
			// Simulation : un inventaire qui détecterait une variable d'env sensible.
			// On l'attache via mockCompareGranular avec un path env.* explicite.
			mockGetInventory.mockResolvedValue({
				inventory: { mcpServers: {} }
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2026',
				diffs: [{
					type: 'modified',
					path: 'env.EMBEDDING_API_KEY',
					category: 'roo_config',
					severity: 'WARNING',
					description: 'EMBEDDING_API_KEY diffère',
					oldValue: 'sk-proj-real-secret-key-aaaaaaaaaaaaaaaa',
					newValue: 'sk-proj-different-secret-key-bbbbbbbbbbbbbbb',
				}],
				stats: { added: 0, removed: 0, modified: 1, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'full'
			});

			const secretDiff = result.differences.find(d => d.path === 'env.EMBEDDING_API_KEY');
			expect(secretDiff).toBeDefined();
			expect(secretDiff!.source_value).not.toContain('aaaaaaaa');
			expect(secretDiff!.target_value).not.toContain('bbbbbbbb');
			// Les deux valeurs doivent être masquées en <set:length:N:hash=...>
			expect(secretDiff!.source_value).toMatch(/^<set:length:\d+:hash=[0-9a-f]{8}>$/);
			expect(secretDiff!.target_value).toMatch(/^<set:length:\d+:hash=[0-9a-f]{8}>$/);
		});

		test('arbitration_candidates groups by kind (source-only/target-only/value-differs) — critère #4', async () => {
			mockGetInventory.mockResolvedValue({
				inventory: { mcpServers: {} }
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2026',
				diffs: [
					// présent côté source seul
					{ type: 'removed', path: 'win-cli', category: 'array', severity: 'WARNING',
					  description: 'Élément supprimé', oldValue: { command: 'node' }, newValue: undefined },
					// présent côté cible seul
					{ type: 'added', path: 'sk-agent', category: 'array', severity: 'WARNING',
					  description: 'Élément ajouté', oldValue: undefined, newValue: { command: 'node' } },
					// valeur divergente
					{ type: 'modified', path: 'markitdown', category: 'array', severity: 'WARNING',
					  description: 'Élément modifié', oldValue: { v: 1 }, newValue: { v: 2 } },
					// autre valeur divergente (même kind, doit s'agréger)
					{ type: 'modified', path: 'playwright', category: 'array', severity: 'INFO',
					  description: 'Élément modifié', oldValue: { v: 3 }, newValue: { v: 4 } },
				],
				stats: { added: 1, removed: 1, modified: 2, unchanged: 0 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'mcp'
			});

			// Critère : permet de décider "harmoniser ou pas" sans ouvrir de fichier.
			expect(result.arbitration_candidates).toBeDefined();
			expect(result.arbitration_candidates).toHaveLength(3);

			const byKind = new Map<string, any>();
			for (const c of result.arbitration_candidates!) byKind.set(c.kind, c);

			expect(byKind.get('present_on_source_only')?.count).toBe(1);
			expect(byKind.get('present_on_source_only')?.paths).toContain('inventory.mcpServers.win-cli');

			expect(byKind.get('present_on_target_only')?.count).toBe(1);
			expect(byKind.get('present_on_target_only')?.paths).toContain('inventory.mcpServers.sk-agent');

			expect(byKind.get('value_differs')?.count).toBe(2);
			expect(byKind.get('value_differs')?.paths).toEqual(
				expect.arrayContaining(['inventory.mcpServers.markitdown', 'inventory.mcpServers.playwright'])
			);
			// Severity du groupe value_differs = max(WARNING, INFO) = WARNING
			expect(byKind.get('value_differs')?.severity).toBe('WARNING');
		});

		test('buildArbitrationCandidates pure function — empty input → empty output', () => {
			expect(buildArbitrationCandidates([])).toEqual([]);
		});

		test('buildArbitrationCandidates ignores diffs without diff_kind (e.g. env-var diffs)', () => {
			const out = buildArbitrationCandidates([
				{ severity: 'WARNING', path: 'env.SOMETHING' }, // pas de diff_kind
				{ diff_kind: 'value_differs', severity: 'WARNING', path: 'mcp.foo' },
			]);
			expect(out).toHaveLength(1);
			expect(out[0].kind).toBe('value_differs');
		});

		test('CompareConfigResultSchema accepts the new optional fields (source_value/target_value/diff_kind/arbitration_candidates)', () => {
			// Smoke test : le schéma doit accepter les nouveaux champs sans casser les anciens
			const parsed = CompareConfigResultSchema.parse({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'mcp',
				detail: 'values',
				differences: [
					{
						category: 'roo_config',
						severity: 'WARNING',
						path: 'inventory.mcpServers.win-cli',
						description: '...',
						source_value: '["--old"]',
						target_value: '["--new"]',
						diff_kind: 'value_differs',
					}
				],
				summary: { total: 1, critical: 0, important: 0, warning: 1, info: 0 },
				arbitration_candidates: [
					{ kind: 'value_differs', label: 'libellé', severity: 'WARNING', count: 1, paths: ['x'] }
				]
			});
			expect(parsed.detail).toBe('values');
			expect(parsed.differences[0].source_value).toBe('["--old"]');
			expect(parsed.arbitration_candidates).toHaveLength(1);
		});

		test('CompareConfigArgsSchema accepts detail="values" (default) and detail="paths"', () => {
			expect(CompareConfigArgsSchema.parse({}).detail).toBeUndefined(); // opt, défaut appliqué côté impl
			expect(CompareConfigArgsSchema.parse({ detail: 'values' }).detail).toBe('values');
			expect(CompareConfigArgsSchema.parse({ detail: 'paths' }).detail).toBe('paths');
			expect(() => CompareConfigArgsSchema.parse({ detail: 'full' })).toThrow();
		});

		test('demo issue #3044: sk-agent écart réel ai-01 vs po-2026 → présent_on_target_only avec valeurs', async () => {
			// Reproduction EXACTE du constat de l'issue #3044 :
			// > « sk-agent PRÉSENT côté cible seul, ABSENT côté source »
			// Avant le fix : seul le path était affiché, aucune valeur.
			// Après le fix : l'opérateur voit la valeur de sk-agent côté cible
			// (permettant de décider "harmoniser en l'ajoutant côté source ?").
			mockGetInventory.mockResolvedValue({
				inventory: { mcpServers: {} }
			});
			mockCompareGranular.mockResolvedValue({
				sourceLabel: 'ai-01',
				targetLabel: 'po-2026',
				diffs: [{
					type: 'added',
					path: 'sk-agent',
					category: 'array',
					severity: 'WARNING',
					description: 'Élément ajouté: \'sk-agent\'',
					oldValue: undefined,
					newValue: { command: 'node', args: ['build/index.js'], disabled: false }
				}],
				stats: { added: 1, removed: 0, modified: 0, unchanged: 6 }
			});

			const result = await roosyncCompareConfig({
				source: 'ai-01',
				target: 'po-2026',
				granularity: 'mcp'
			});

			const skAgentDiff = result.differences.find(d => d.path === 'inventory.mcpServers.sk-agent');
			expect(skAgentDiff).toBeDefined();
			expect(skAgentDiff!.diff_kind).toBe('present_on_target_only');
			expect(skAgentDiff!.source_value).toBe('<unset>');
			expect(skAgentDiff!.target_value).toContain('node');
			expect(skAgentDiff!.target_value).toContain('build/index.js');

			// Et la section arbitration est directement utilisable
			const candidate = result.arbitration_candidates?.find(c => c.kind === 'present_on_target_only');
			expect(candidate).toBeDefined();
			expect(candidate!.paths).toContain('inventory.mcpServers.sk-agent');
			expect(candidate!.label).toContain('Présent côté cible seul');
		});
	});
});
