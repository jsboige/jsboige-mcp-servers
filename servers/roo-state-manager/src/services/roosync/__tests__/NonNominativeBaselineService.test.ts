/**
 * Tests pour NonNominativeBaselineService.ts
 * Issue #492 - Couverture des services RooSync
 * Coverage cluster A (#833 coverage deep-queue): public methods mapMachineToBaseline,
 * compareMachines, aggregateBaseline, migrateFromLegacy, getters.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockReadFile, mockWriteFile, mockMkdir, mockAccess } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockAccess: vi.fn()
}));

const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn()
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: mockExistsSync,
		promises: {
			readFile: mockReadFile,
			writeFile: mockWriteFile,
			mkdir: mockMkdir,
			access: mockAccess
		}
	};
});

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}))
}));

vi.mock('../../../utils/encoding-helpers.js', () => ({
	readJSONFileWithoutBOM: vi.fn()
}));

import { NonNominativeBaselineService } from '../NonNominativeBaselineService.js';
import { BaselineServiceError } from '../../../types/baseline.js';
import type { ConfigurationProfile, MachineInventory, AggregationConfig } from '../../../types/non-nominative-baseline.js';
import type { BaselineConfig } from '../../../types/baseline.js';

/** Builds a minimal valid roo-core profile (always-applicable category) with the given configuration. */
function makeRooCoreProfile(configuration: Record<string, any>): ConfigurationProfile {
	return {
		profileId: 'profile-roo-core-test',
		category: 'roo-core',
		name: 'Roo Core',
		description: 'test profile',
		configuration,
		priority: 100,
		compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
		metadata: {
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			version: '1.0.0',
			tags: ['test'],
			stability: 'stable'
		}
	};
}

describe('NonNominativeBaselineService', () => {
	let service: NonNominativeBaselineService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		service = new NonNominativeBaselineService('/shared/path');
	});

	// ============================================================
	// generateMachineHash
	// ============================================================

	describe('generateMachineHash', () => {
		test('generates a 16-char hex string', () => {
			const hash = service.generateMachineHash('test-machine');
			expect(hash).toHaveLength(16);
			expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
		});

		test('generates deterministic hash for same input', () => {
			const hash1 = service.generateMachineHash('test-machine');
			const hash2 = service.generateMachineHash('test-machine');
			expect(hash1).toBe(hash2);
		});

		test('generates different hashes for different inputs', () => {
			const hash1 = service.generateMachineHash('machine-a');
			const hash2 = service.generateMachineHash('machine-b');
			expect(hash1).not.toBe(hash2);
		});

		test('includes salt in hash computation', () => {
			// Same machineId but different service instance should give same hash
			// (salt is constant 'roosync-salt-2024')
			const service2 = new NonNominativeBaselineService('/other/path');
			const hash1 = service.generateMachineHash('test');
			const hash2 = service2.generateMachineHash('test');
			expect(hash1).toBe(hash2);
		});
	});

	// ============================================================
	// createBaseline
	// ============================================================

	describe('createBaseline', () => {
		test('creates baseline with correct structure', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const baseline = await service.createBaseline(
				'Test Baseline',
				'Description for testing',
				[{
					profileId: 'p1',
					category: 'roo-core' as any,
					configuration: { modes: ['code'] },
					priority: 100,
					description: 'Roo core config'
				}]
			);

			expect(baseline.name).toBe('Test Baseline');
			expect(baseline.description).toBe('Description for testing');
			expect(baseline.version).toBe('1.0.0');
			expect(baseline.profiles).toHaveLength(1);
			expect(baseline.baselineId).toMatch(/^baseline-/);
		});

		test('creates baseline with aggregation rules', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const baseline = await service.createBaseline('B', 'D', []);

			expect(baseline.aggregationRules).toBeDefined();
			expect(baseline.aggregationRules.conflictResolution).toBe('highest_priority');
		});

		test('creates baseline with metadata timestamps', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const before = new Date().toISOString();
			const baseline = await service.createBaseline('B', 'D', []);
			const after = new Date().toISOString();

			expect(baseline.metadata.createdAt >= before).toBe(true);
			expect(baseline.metadata.createdAt <= after).toBe(true);
			expect(baseline.metadata.status).toBe('active');
		});

		test('saves baseline to file', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			await service.createBaseline('B', 'D', []);

			expect(mockWriteFile).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Constructor initialization
	// ============================================================

	describe('constructor', () => {
		test('initializes with correct paths', () => {
			const svc = new NonNominativeBaselineService('/test/path');
			// Service should be created without throwing
			expect(svc).toBeDefined();
		});

		test('initializes state with empty values', () => {
			const svc = new NonNominativeBaselineService('/test/path');
			// The hash function should work immediately
			const hash = svc.generateMachineHash('test');
			expect(hash).toBeDefined();
		});
	});

	// ============================================================
	// mapMachineToBaseline (#833 coverage — error + conforme + deviation paths)
	// ============================================================

	describe('mapMachineToBaseline', () => {
		test('throws BaselineServiceError when no active baseline is available', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			// Fresh service: createBaseline never called → state.activeBaseline undefined.
			// Source L486-491 throws BaselineServiceError (code BASELINE_NOT_FOUND).
			await expect(
				service.mapMachineToBaseline('m1', { machineId: 'm1' } as MachineInventory)
			).rejects.toThrow(/Aucune baseline active disponible/);
		});

		test('maps a conformant machine with no deviations (confidence 1.0)', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			// Baseline roo-core profile configuration matches the inventory exactly.
			const profile = makeRooCoreProfile({ modes: ['code'], mcpSettings: { a: 1 } });
			await service.createBaseline('B', 'D', [profile]);

			const inventory = {
				machineId: 'm1',
				config: { roo: { modes: ['code'], mcpSettings: { a: 1 } } }
			} as MachineInventory;

			const mapping = await service.mapMachineToBaseline('m1', inventory);

			expect(mapping.machineHash).toBe(service.generateMachineHash('m1'));
			expect(mapping.baselineId).toBe(service.getActiveBaseline()!.baselineId);
			// roo-core is always-applicable (ProfileApplicabilityHelper L24-26)
			expect(mapping.appliedProfiles).toHaveLength(1);
			expect(mapping.appliedProfiles[0].category).toBe('roo-core');
			expect(mapping.appliedProfiles[0].source).toBe('auto');
			// extractActualValue matches expected → areValuesEqual true → 0 deviations
			expect(mapping.deviations).toHaveLength(0);
			// calculateConfidence: 0 deviations → 1.0 (source L692)
			expect(mapping.metadata.confidence).toBe(1.0);
		});

		test('detects a roo-core deviation and lowers confidence (severity IMPORTANT)', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const profile = makeRooCoreProfile({ modes: ['code'], mcpSettings: { a: 1 } });
			await service.createBaseline('B', 'D', [profile]);

			// Inventory modes differ from the baseline profile → deviation.
			const inventory = {
				machineId: 'm1',
				config: { roo: { modes: ['debug'] } }
			} as MachineInventory;

			const mapping = await service.mapMachineToBaseline('m1', inventory);

			expect(mapping.deviations).toHaveLength(1);
			expect(mapping.deviations[0].category).toBe('roo-core');
			// calculateDeviationSeverity: 'roo-' prefix → IMPORTANT (source L679-680)
			expect(mapping.deviations[0].severity).toBe('IMPORTANT');
			// calculateConfidence: 1 IMPORTANT deviation → penalty 0.1 → 0.9 (source L695-699)
			expect(mapping.metadata.confidence).toBeCloseTo(0.9, 5);
		});
	});

	// ============================================================
	// compareMachines (#833 coverage — error + report aggregation)
	// ============================================================

	describe('compareMachines', () => {
		test('throws BaselineServiceError when no active baseline is available', async () => {
			// Source L708-713 throws when state.activeBaseline undefined.
			await expect(service.compareMachines(['hash1']))
				.rejects.toThrow(/Aucune baseline active disponible/);
		});

		test('builds a comparison report aggregating mapped deviations', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const profile = makeRooCoreProfile({ modes: ['code'], mcpSettings: { a: 1 } });
			await service.createBaseline('B', 'D', [profile]);

			const hash = service.generateMachineHash('m1');
			// Map a non-conformant machine → 1 IMPORTANT deviation recorded in state.
			await service.mapMachineToBaseline('m1', {
				machineId: 'm1',
				config: { roo: { modes: ['debug'] } }
			} as MachineInventory);

			const report = await service.compareMachines([hash]);

			expect(report.baselineId).toBe(service.getActiveBaseline()!.baselineId);
			expect(report.machineHashes).toEqual([hash]);
			expect(report.statistics.totalDifferences).toBe(1);
			// differencesBySeverity counted from the deviation severity (source L751-753)
			expect(report.statistics.differencesBySeverity.IMPORTANT).toBe(1);
			// complianceRate = 1 - (1 diff / (1 machine * 1 profile)) = 0 (source L760-761)
			expect(report.statistics.complianceRate).toBe(0);
		});
	});

	// ============================================================
	// aggregateBaseline (#833 coverage — extraction + majority aggregation)
	// ============================================================

	describe('aggregateBaseline', () => {
		test('aggregates software versions across inventories using majority strategy', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			// Three inventories reporting node versions; 'v1' is the majority.
			// extractCategoryData (source L228-247) collects {version} per inventory for software-node.
			const inventories: MachineInventory[] = [
				{ machineId: 'm1', config: { software: { node: 'v1' } } } as MachineInventory,
				{ machineId: 'm2', config: { software: { node: 'v1' } } } as MachineInventory,
				{ machineId: 'm3', config: { software: { node: 'v2' } } } as MachineInventory
			];
			const config: AggregationConfig = {
				sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
				// Only software-node has a rule → other collected categories return null profile.
				categoryRules: {
					'software-node': { strategy: 'majority', confidenceThreshold: 0.5, autoApply: true }
				} as AggregationConfig['categoryRules'],
				thresholds: { deviationThreshold: 0.1, complianceThreshold: 0.8, outlierDetection: false }
			};

			const baseline = await service.aggregateBaseline(inventories, config);

			const nodeProfile = baseline.profiles.find(p => p.category === 'software-node');
			expect(nodeProfile).toBeDefined();
			// aggregateByMajority on [{version:'v1'},{version:'v1'},{version:'v2'}] → {version:'v1'}
			// (object path, per-key frequency, source L336-365)
			expect(nodeProfile!.configuration).toEqual({ version: 'v1' });
		});
	});

	// ============================================================
	// migrateFromLegacy (#833 coverage — BaselineConfig path + backup option)
	// ============================================================

	describe('migrateFromLegacy', () => {
		test('migrates a legacy BaselineConfig into profiles (no machines, no backup)', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			// BaselineConfig carries a 'config' key → extractProfilesFromLegacy (source L877)
			// builds a roo-core profile (modes+mcpSettings) and a hardware-cpu profile.
			const legacy = {
				machineId: 'legacy-1',
				config: {
					roo: { modes: ['code'], mcpSettings: { x: 1 }, userSettings: {} },
					hardware: { cpu: { model: 'X', cores: 4, threads: 8 } }
				}
			} as any as BaselineConfig;

			const result = await service.migrateFromLegacy(legacy, {
				createBackup: false,
				keepLegacyReferences: false,
				machineMappingStrategy: 'hash',
				autoValidate: false,
				priorityCategories: []
			});

			// No 'machines' key → machine loop skipped → 0 errors → success.
			expect(result.success).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.migratedMachines).toEqual([]);
			// extractProfilesFromLegacy produces exactly 2 profiles for a BaselineConfig.
			expect(result.statistics.profilesCreated).toBe(2);
			expect(result.newBaseline).toBeDefined();
		});

		test('creates a legacy backup file when createBackup option is set', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const legacy = {
				machineId: 'legacy-2',
				config: {
					roo: { modes: ['code'], mcpSettings: {}, userSettings: {} },
					hardware: { cpu: { model: 'Y', cores: 2, threads: 4 } }
				}
			} as any as BaselineConfig;

			await service.migrateFromLegacy(legacy, {
				createBackup: true,
				keepLegacyReferences: false,
				machineMappingStrategy: 'hash',
				autoValidate: false,
				priorityCategories: []
			});

			// createLegacyBackup (source L974-978) writes to <sharedPath>/legacy-backup-<ts>.json
			const backupCall = mockWriteFile.mock.calls.find(c =>
				/legacy-backup-/.test(String(c[0]))
			);
			expect(backupCall).toBeDefined();
		});
	});

	// ============================================================
	// getters (#833 coverage — getState / getActiveBaseline / getMachineMappings)
	// ============================================================

	describe('getters', () => {
		test('getState returns a shallow copy with initial statistics', () => {
			const state = service.getState();
			expect(state.statistics.totalBaselines).toBe(0);
			expect(state.machineMappings).toEqual([]);
			// Source L1118 spreads into a new object → not the internal reference.
			expect(state).not.toBe((service as any).state);
		});

		test('getActiveBaseline returns undefined before any baseline is created', () => {
			expect(service.getActiveBaseline()).toBeUndefined();
		});

		test('getMachineMappings returns a copy of the mappings array', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);
			const profile = makeRooCoreProfile({ modes: ['code'] });
			await service.createBaseline('B', 'D', [profile]);
			await service.mapMachineToBaseline('m1', {
				machineId: 'm1',
				config: { roo: { modes: ['code'] } }
			} as MachineInventory);

			const mappings = service.getMachineMappings();
			expect(mappings).toHaveLength(1);
			// Source L1132 spreads into a new array → not the internal reference.
			expect(mappings).not.toBe((service as any).state.machineMappings);
		});
	});
});
