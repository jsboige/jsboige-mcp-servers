/**
 * Tests pour ConfigComparator.ts
 * Issue #492 - Couverture des services RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConfigComparator } from '../ConfigComparator.js';

// Mock dependencies
const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn()
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: mockExistsSync
	};
});

vi.mock('../../../services/RooSyncService.js', () => ({
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'RooSyncServiceError';
			this.code = code;
		}
	}
}));

vi.mock('../../../utils/roosync-parsers.js', () => ({
	parseConfigJson: vi.fn()
}));

const mockConfig = {
	machineId: 'test-machine',
	sharedPath: '/shared/path'
};

const mockBaselineService = {
	loadBaseline: vi.fn(),
	compareWithBaseline: vi.fn()
};

describe('ConfigComparator', () => {
	let comparator: ConfigComparator;

	beforeEach(() => {
		vi.clearAllMocks();
		comparator = new ConfigComparator(mockConfig as any, mockBaselineService as any);
	});

	// ============================================================
	// compareWithProfiles
	// ============================================================

	describe('compareWithProfiles', () => {
		test('returns empty array when no profiles', () => {
			const result = comparator.compareWithProfiles({}, []);
			expect(result).toEqual([]);
		});

		test('returns empty array when category not found in inventory', () => {
			const profiles = [{ category: 'unknown-category', configuration: {} }];
			const result = comparator.compareWithProfiles({}, profiles as any);
			expect(result).toEqual([]);
		});

		test('returns deviation when roo-core config differs', () => {
			const inventory = {
				config: {
					roo: {
						modes: ['code', 'debug'],
						mcpSettings: { server1: true }
					}
				}
			};
			const profiles = [{
				category: 'roo-core',
				configuration: {
					modes: ['code'],
					mcpSettings: { server1: false }
				}
			}];

			const result = comparator.compareWithProfiles(inventory, profiles as any);
			expect(result).toHaveLength(1);
			expect(result[0].category).toBe('roo-core');
			expect(result[0].severity).toBe('WARNING');
		});

		test('returns no deviation when roo-core matches', () => {
			const rooConfig = {
				modes: ['code'],
				mcpSettings: { server1: true }
			};
			const inventory = {
				config: { roo: rooConfig }
			};
			const profiles = [{
				category: 'roo-core',
				configuration: rooConfig
			}];

			const result = comparator.compareWithProfiles(inventory, profiles as any);
			expect(result).toEqual([]);
		});

		test('returns deviation for hardware-cpu mismatch', () => {
			const inventory = {
				config: { hardware: { cpu: 'AMD Ryzen 9' } }
			};
			const profiles = [{
				category: 'hardware-cpu',
				configuration: 'Intel i9'
			}];

			const result = comparator.compareWithProfiles(inventory, profiles as any);
			expect(result).toHaveLength(1);
			expect(result[0].category).toBe('hardware-cpu');
		});

		test('handles multiple profiles with mixed results', () => {
			const inventory = {
				config: {
					roo: { modes: ['code'], mcpSettings: {} },
					hardware: { cpu: 'AMD' }
				}
			};
			const profiles = [
				{ category: 'roo-core', configuration: { modes: ['code'], mcpSettings: {} } },
				{ category: 'hardware-cpu', configuration: 'Intel' },
				{ category: 'unknown', configuration: 'anything' }
			];

			const result = comparator.compareWithProfiles(inventory, profiles as any);
			// roo-core matches, hardware-cpu deviates, unknown skipped
			expect(result).toHaveLength(1);
			expect(result[0].category).toBe('hardware-cpu');
		});
	});

	// ============================================================
	// compareConfig
	// ============================================================

	describe('compareConfig', () => {
		test('throws when sync-config.json does not exist', async () => {
			mockExistsSync.mockReturnValue(false);

			await expect(
				comparator.compareConfig(vi.fn(), 'other-machine')
			).rejects.toThrow('introuvable');
		});

		test('returns comparison structure when file exists', async () => {
			mockExistsSync.mockReturnValue(true);

			const result = await comparator.compareConfig(vi.fn(), 'other-machine');
			expect(result.localMachine).toBe('test-machine');
			expect(result.targetMachine).toBe('other-machine');
			expect(result.differences).toEqual([]);
		});

		test('picks first machine from dashboard when no target specified', async () => {
			mockExistsSync.mockReturnValue(true);
			const dashboardLoader = vi.fn().mockResolvedValue({
				machines: {
					'test-machine': {},
					'other-machine': {}
				}
			});

			const result = await comparator.compareConfig(dashboardLoader);
			expect(result.targetMachine).toBe('other-machine');
		});

		test('throws when no other machines found', async () => {
			mockExistsSync.mockReturnValue(true);
			const dashboardLoader = vi.fn().mockResolvedValue({
				machines: { 'test-machine': {} }
			});

			await expect(
				comparator.compareConfig(dashboardLoader)
			).rejects.toThrow('Aucune autre machine');
		});
	});

	// ============================================================
	// listDiffs
	// ============================================================

	describe('listDiffs', () => {
		test('returns empty diffs when no baseline', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue(null);

			const result = await comparator.listDiffs();
			expect(result.totalDiffs).toBe(0);
			expect(result.diffs).toEqual([]);
		});

		test('returns diffs from baseline comparison', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({
				machineId: 'baseline-machine'
			});
			mockBaselineService.compareWithBaseline.mockResolvedValue({
				differences: [
					{ category: 'config', path: '/some/path', description: 'Diff found', severity: 'WARNING' }
				]
			});

			const result = await comparator.listDiffs();
			expect(result.totalDiffs).toBeGreaterThan(0);
		});

		test('filters diffs by type config', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({
				machineId: 'baseline-machine'
			});
			mockBaselineService.compareWithBaseline.mockResolvedValue({
				differences: [
					{ category: 'config', path: '/a', description: 'config diff', severity: 'WARNING' },
					{ category: 'hardware', path: '/b', description: 'hw diff', severity: 'INFO' }
				]
			});

			const result = await comparator.listDiffs('config');
			expect(result.diffs.every(d => d.type === 'config')).toBe(true);
		});

		test('returns all diffs when filter is all', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({
				machineId: 'baseline-machine'
			});
			mockBaselineService.compareWithBaseline.mockResolvedValue({
				differences: [
					{ category: 'config', path: '/a', description: 'diff1', severity: 'WARNING' },
					{ category: 'hardware', path: '/b', description: 'diff2', severity: 'INFO' }
				]
			});

			const result = await comparator.listDiffs('all');
			expect(result.totalDiffs).toBe(2);
		});

		test('deduplicates diffs across machines', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({
				machineId: 'test-machine'
			});
			// Same diff returned for same machine (machineId == config.machineId)
			mockBaselineService.compareWithBaseline.mockResolvedValue({
				differences: [
					{ category: 'config', path: '/same', description: 'same diff', severity: 'WARNING' }
				]
			});

			const result = await comparator.listDiffs();
			// Should not duplicate the same path
			const paths = result.diffs.map(d => d.path);
			const uniquePaths = [...new Set(paths)];
			expect(paths.length).toBe(uniquePaths.length);
		});

		test('handles comparison error gracefully', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({
				machineId: 'baseline-machine'
			});
			mockBaselineService.compareWithBaseline.mockRejectedValue(new Error('compare failed'));

			// Should not throw, just skip that machine
			const result = await comparator.listDiffs();
			expect(result.totalDiffs).toBe(0);
		});
	});

	// ============================================================
	// compareRealConfigurations
	// ============================================================

	describe('compareRealConfigurations', () => {
		test('returns report with differences from both machines', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({});
			mockBaselineService.compareWithBaseline.mockImplementation(async (machineId: string) => ({
				differences: [
					{ category: 'config', path: `/${machineId}/setting`, description: 'diff', severity: 'WARNING' }
				]
			}));

			const result = await comparator.compareRealConfigurations('machine-a', 'machine-b');
			expect(result).not.toBeNull();
			expect(result.sourceMachine).toBe('machine-a');
			expect(result.targetMachine).toBe('machine-b');
			expect(result.differences).toHaveLength(2);
			expect(result.summary.total).toBe(2);
		});

		test('returns null when comparison fails', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({});
			mockBaselineService.compareWithBaseline.mockResolvedValue(null);

			const result = await comparator.compareRealConfigurations('a', 'b');
			expect(result).toBeNull();
		});

		test('throws on baseline load error', async () => {
			mockBaselineService.loadBaseline.mockRejectedValue(new Error('no baseline'));

			await expect(
				comparator.compareRealConfigurations('a', 'b')
			).rejects.toThrow('comparaison r\u00e9elle');
		});

		test('summary categorizes severity levels', async () => {
			mockBaselineService.loadBaseline.mockResolvedValue({});
			mockBaselineService.compareWithBaseline.mockImplementation(async (machineId: string) => {
				if (machineId === 'source') {
					return {
						differences: [
							{ category: 'config', path: '/a', description: 'd', severity: 'CRITICAL' },
							{ category: 'hw', path: '/b', description: 'd', severity: 'INFO' }
						]
					};
				}
				return { differences: [
					{ category: 'sw', path: '/c', description: 'd', severity: 'IMPORTANT' }
				]};
			});

			const result = await comparator.compareRealConfigurations('source', 'target');
			expect(result.summary.critical).toBe(1);
			expect(result.summary.important).toBe(1);
			expect(result.summary.info).toBe(1);
		});
	});
});
