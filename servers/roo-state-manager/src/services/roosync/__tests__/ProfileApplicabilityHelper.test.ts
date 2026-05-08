/**
 * Tests for ProfileApplicabilityHelper.ts
 * Issue #1843 finding #4 — coverage for profile applicability matching
 */

import { describe, test, expect } from 'vitest';
import { ProfileApplicabilityHelper, ALL_CATEGORIES } from '../ProfileApplicabilityHelper.js';
import type { ConfigurationProfile, MachineInventory } from '../../../types/non-nominative-baseline.js';

/** Helper to create a minimal ConfigurationProfile. */
function makeProfile(category: ConfigurationProfile['category']): ConfigurationProfile {
	return {
		profileId: `test-${category}`,
		category,
		name: `Test ${category}`,
		description: `Test profile for ${category}`,
		configuration: {},
	};
}

/** Helper to create a minimal MachineInventory. */
function makeInventory(overrides: Partial<MachineInventory> = {}): MachineInventory {
	return {
		machineId: 'test-machine',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// isApplicable — always-true categories
// ---------------------------------------------------------------------------
describe('ProfileApplicabilityHelper.isApplicable — always-true categories', () => {
	const alwaysTrue: ConfigurationProfile['category'][] = [
		'roo-core',
		'roo-advanced',
		'hardware-cpu',
		'hardware-memory',
		'hardware-storage',
		'system-os',
		'system-architecture',
	];

	test.each(alwaysTrue)('category "%s" should always be applicable', (cat) => {
		const profile = makeProfile(cat);
		const inventory = makeInventory();
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('unknown category falls through to default (true)', () => {
		const profile = makeProfile('unknown-category' as ConfigurationProfile['category']);
		const inventory = makeInventory();
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isApplicable — hardware-gpu
// ---------------------------------------------------------------------------
describe('ProfileApplicabilityHelper.isApplicable — hardware-gpu', () => {
	const gpuProfile = makeProfile('hardware-gpu');

	test('returns true when config.hardware.gpu is set', () => {
		const inventory = makeInventory({ config: { hardware: { gpu: 'NVIDIA RTX 4090' } } } as any);
		expect(ProfileApplicabilityHelper.isApplicable(gpuProfile, inventory)).toBe(true);
	});

	test('returns true when inventory.systemInfo.gpu is non-empty array', () => {
		const inventory = makeInventory({
			inventory: { systemInfo: { gpu: [{ name: 'RTX 4090' }] } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(gpuProfile, inventory)).toBe(true);
	});

	test('returns true when inventory.gpuDetails is non-empty array', () => {
		const inventory = makeInventory({
			inventory: { gpuDetails: [{ name: 'RTX 4090' }] },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(gpuProfile, inventory)).toBe(true);
	});

	test('returns false when no GPU info is present', () => {
		const inventory = makeInventory();
		expect(ProfileApplicabilityHelper.isApplicable(gpuProfile, inventory)).toBe(false);
	});

	test('returns false when systemInfo.gpu is empty array', () => {
		const inventory = makeInventory({
			inventory: { systemInfo: { gpu: [] } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(gpuProfile, inventory)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isApplicable — software-* categories
// ---------------------------------------------------------------------------
describe('ProfileApplicabilityHelper.isApplicable — software categories', () => {
	test('software-powershell: true when systemInfo.powershellVersion is set', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory({
			inventory: { systemInfo: { powershellVersion: '7.4.0' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-powershell: true when tools.powershell.version is set', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory({
			inventory: { tools: { powershell: { version: '7.3.0' } } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-powershell: true when config.software.powershell is set (legacy)', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory({
			config: { software: { powershell: '5.1' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-powershell: false when version is "Unknown"', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory({
			inventory: { systemInfo: { powershellVersion: 'Unknown' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
	});

	test('software-powershell: false when version is empty string', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory({
			inventory: { systemInfo: { powershellVersion: '' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
	});

	test('software-powershell: false when no version info at all', () => {
		const profile = makeProfile('software-powershell');
		const inventory = makeInventory();
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
	});

	test('software-node: true when tools.node.version is set', () => {
		const profile = makeProfile('software-node');
		const inventory = makeInventory({
			inventory: { tools: { node: { version: '20.11.0' } } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-node: true when config.software.node is set (legacy)', () => {
		const profile = makeProfile('software-node');
		const inventory = makeInventory({
			config: { software: { node: '18.0.0' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-node: false when version is undefined', () => {
		const profile = makeProfile('software-node');
		const inventory = makeInventory();
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
	});

	test('software-python: true when tools.python.version is set', () => {
		const profile = makeProfile('software-python');
		const inventory = makeInventory({
			inventory: { tools: { python: { version: '3.12.0' } } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
	});

	test('software-python: false when version is "Unknown"', () => {
		const profile = makeProfile('software-python');
		const inventory = makeInventory({
			config: { software: { python: 'Unknown' } },
		} as any);
		expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// filterApplicable
// ---------------------------------------------------------------------------
describe('ProfileApplicabilityHelper.filterApplicable', () => {
	test('splits profiles into applicable and excluded with reasons', () => {
		const profiles = [
			makeProfile('roo-core'),
			makeProfile('hardware-gpu'),
			makeProfile('software-node'),
		];
		// Machine without GPU and without Node
		const inventory = makeInventory();
		const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);

		expect(result.applicable).toHaveLength(1);
		expect(result.applicable[0].category).toBe('roo-core');

		expect(result.excluded).toHaveLength(2);
		expect(result.excluded[0].profile.category).toBe('hardware-gpu');
		expect(result.excluded[0].reason).toBe('Machine has no GPU');
		expect(result.excluded[1].profile.category).toBe('software-node');
		expect(result.excluded[1].reason).toBe('Node.js not detected');
	});

	test('returns all applicable when machine has everything', () => {
		const profiles = ALL_CATEGORIES.map(makeProfile);
		const inventory = makeInventory({
			config: { hardware: { gpu: 'RTX 4090' }, software: { powershell: '7.4', node: '20', python: '3.12' } },
			inventory: {
				systemInfo: { powershellVersion: '7.4' },
				tools: { node: { version: '20.0' }, python: { version: '3.12' }, powershell: { version: '7.4' } },
			},
		} as any);

		const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);
		expect(result.applicable).toHaveLength(ALL_CATEGORIES.length);
		expect(result.excluded).toHaveLength(0);
	});

	test('returns empty applicable when no profiles match software requirements', () => {
		const profiles = [
			makeProfile('software-powershell'),
			makeProfile('software-node'),
			makeProfile('software-python'),
		];
		const inventory = makeInventory();
		const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);

		expect(result.applicable).toHaveLength(0);
		expect(result.excluded).toHaveLength(3);
		expect(result.excluded.map(e => e.reason)).toEqual([
			'PowerShell not detected',
			'Node.js not detected',
			'Python not detected',
		]);
	});
});

// ---------------------------------------------------------------------------
// ALL_CATEGORIES constant
// ---------------------------------------------------------------------------
describe('ALL_CATEGORIES constant', () => {
	test('contains exactly 11 categories', () => {
		expect(ALL_CATEGORIES).toHaveLength(11);
	});

	test('contains all expected category strings', () => {
		expect(ALL_CATEGORIES).toContain('roo-core');
		expect(ALL_CATEGORIES).toContain('roo-advanced');
		expect(ALL_CATEGORIES).toContain('hardware-gpu');
		expect(ALL_CATEGORIES).toContain('software-powershell');
		expect(ALL_CATEGORIES).toContain('system-os');
	});
});
