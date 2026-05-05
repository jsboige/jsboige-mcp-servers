/**
 * Tests for ProfileApplicabilityHelper (#1843 finding #4)
 * Validates category-specific profile matching against machine inventory.
 */

import { describe, it, expect } from 'vitest';
import {
  ProfileApplicabilityHelper,
  ALL_CATEGORIES,
} from '../../../../src/services/roosync/ProfileApplicabilityHelper.js';
import type { ConfigurationProfile, MachineInventory } from '../../../../src/types/non-nominative-baseline.js';

function makeProfile(category: ConfigurationCategory, overrides?: Partial<ConfigurationProfile>): ConfigurationProfile {
  return {
    profileId: `test-${category}`,
    category,
    name: `Test ${category}`,
    description: `Test profile for ${category}`,
    configuration: {},
    priority: 1,
    compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
    metadata: { createdAt: '2026-01-01', updatedAt: '2026-01-01', version: '1.0', tags: [], stability: 'stable' },
    ...overrides,
  };
}

function makeInventory(overrides?: Partial<MachineInventory>): MachineInventory {
  return {
    machineId: 'test-machine',
    ...overrides,
  };
}

const FULL_INVENTORY: MachineInventory = makeInventory({
  inventory: {
    systemInfo: {
      powershellVersion: '7.4.6',
      os: 'Windows_NT',
      architecture: 'x64',
      cpuCores: 16,
      hostname: 'test-machine',
      username: 'test-user',
    },
    tools: {
      node: { version: '22.0.0' },
      python: { version: '3.12.0' },
      powershell: { version: '7.4.6' },
    },
    gpuDetails: [{ index: 0, name: 'RTX 3080', memoryTotal: 10240, memoryFree: 5120, memoryUsed: 5120, driverVersion: '550', temperature: 45, source: 'nvidia-smi' }],
  },
});

// === Category: always-applicable ===

describe('ProfileApplicabilityHelper — always applicable categories', () => {
  const alwaysCategories: ConfigurationCategory[] = [
    'roo-core', 'roo-advanced',
    'hardware-cpu', 'hardware-memory', 'hardware-storage',
    'system-os', 'system-architecture',
  ];

  it.each(alwaysCategories)('returns true for %s with minimal inventory', (cat) => {
    const profile = makeProfile(cat);
    const inventory = makeInventory();
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it.each(alwaysCategories)('returns true for %s with full inventory', (cat) => {
    const profile = makeProfile(cat);
    expect(ProfileApplicabilityHelper.isApplicable(profile, FULL_INVENTORY)).toBe(true);
  });
});

// === Category: hardware-gpu ===

describe('ProfileApplicabilityHelper — hardware-gpu', () => {
  it('returns true when gpuDetails present', () => {
    const profile = makeProfile('hardware-gpu');
    expect(ProfileApplicabilityHelper.isApplicable(profile, FULL_INVENTORY)).toBe(true);
  });

  it('returns true when legacy config.hardware.gpu present', () => {
    const profile = makeProfile('hardware-gpu');
    const inventory = makeInventory({ config: { hardware: { gpu: { model: 'GTX 1060' } } } });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns false when no GPU detected', () => {
    const profile = makeProfile('hardware-gpu');
    const inventory = makeInventory();
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
  });

  it('returns false when gpuDetails is empty array', () => {
    const profile = makeProfile('hardware-gpu');
    const inventory = makeInventory({ inventory: { gpuDetails: [] } });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
  });
});

// === Category: software-powershell ===

describe('ProfileApplicabilityHelper — software-powershell', () => {
  it('returns true when systemInfo.powershellVersion present', () => {
    const profile = makeProfile('software-powershell');
    const inventory = makeInventory({
      inventory: { systemInfo: { powershellVersion: '7.4.6' } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns true when tools.powershell.version present', () => {
    const profile = makeProfile('software-powershell');
    const inventory = makeInventory({
      inventory: { tools: { powershell: { version: '7.4.6' } } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns true when legacy config.software.powershell present', () => {
    const profile = makeProfile('software-powershell');
    const inventory = makeInventory({
      config: { software: { powershell: '5.1' } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns false when version is "Unknown"', () => {
    const profile = makeProfile('software-powershell');
    const inventory = makeInventory({
      inventory: { systemInfo: { powershellVersion: 'Unknown' } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
  });

  it('returns false when no PowerShell detected at all', () => {
    const profile = makeProfile('software-powershell');
    const inventory = makeInventory();
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(false);
  });
});

// === Category: software-node ===

describe('ProfileApplicabilityHelper — software-node', () => {
  it('returns true when tools.node.version present', () => {
    const profile = makeProfile('software-node');
    const inventory = makeInventory({
      inventory: { tools: { node: { version: '22.0.0' } } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns true when legacy config.software.node present', () => {
    const profile = makeProfile('software-node');
    const inventory = makeInventory({
      config: { software: { node: '20.0.0' } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns false when no Node.js detected', () => {
    const profile = makeProfile('software-node');
    expect(ProfileApplicabilityHelper.isApplicable(profile, makeInventory())).toBe(false);
  });
});

// === Category: software-python ===

describe('ProfileApplicabilityHelper — software-python', () => {
  it('returns true when tools.python.version present', () => {
    const profile = makeProfile('software-python');
    const inventory = makeInventory({
      inventory: { tools: { python: { version: '3.12.0' } } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns true when legacy config.software.python present', () => {
    const profile = makeProfile('software-python');
    const inventory = makeInventory({
      config: { software: { python: '3.11.0' } },
    });
    expect(ProfileApplicabilityHelper.isApplicable(profile, inventory)).toBe(true);
  });

  it('returns false when no Python detected', () => {
    const profile = makeProfile('software-python');
    expect(ProfileApplicabilityHelper.isApplicable(profile, makeInventory())).toBe(false);
  });
});

// === filterApplicable ===

describe('ProfileApplicabilityHelper — filterApplicable', () => {
  it('separates applicable from excluded profiles', () => {
    const profiles = ALL_CATEGORIES.map(cat => makeProfile(cat));
    const inventory = FULL_INVENTORY;

    const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);

    // All categories should be applicable on FULL_INVENTORY
    expect(result.applicable).toHaveLength(ALL_CATEGORIES.length);
    expect(result.excluded).toHaveLength(0);
  });

  it('excludes GPU and software profiles on minimal machine', () => {
    const profiles = ALL_CATEGORIES.map(cat => makeProfile(cat));
    const inventory = makeInventory(); // No GPU, no software

    const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);

    expect(result.applicable.length).toBeLessThan(ALL_CATEGORIES.length);
    expect(result.excluded.length).toBeGreaterThan(0);

    // Excluded categories should include hardware-gpu and software-*
    const excludedCats = result.excluded.map(e => e.profile.category);
    expect(excludedCats).toContain('hardware-gpu');
    expect(excludedCats).toContain('software-powershell');
    expect(excludedCats).toContain('software-node');
    expect(excludedCats).toContain('software-python');

    // Always-applicable categories should not be excluded
    expect(excludedCats).not.toContain('roo-core');
    expect(excludedCats).not.toContain('system-os');
  });

  it('provides human-readable exclusion reasons', () => {
    const profiles = [makeProfile('hardware-gpu')];
    const inventory = makeInventory();

    const result = ProfileApplicabilityHelper.filterApplicable(profiles, inventory);

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].reason).toContain('GPU');
  });
});

// === Exhaustive coverage ===

describe('ProfileApplicabilityHelper — ALL_CATEGORIES constant', () => {
  it('has exactly 11 categories', () => {
    expect(ALL_CATEGORIES).toHaveLength(11);
  });

  it('includes all defined categories', () => {
    const expected: ConfigurationCategory[] = [
      'roo-core', 'roo-advanced',
      'hardware-cpu', 'hardware-memory', 'hardware-storage', 'hardware-gpu',
      'software-powershell', 'software-node', 'software-python',
      'system-os', 'system-architecture',
    ];
    expect(ALL_CATEGORIES.sort()).toEqual(expected.sort());
  });
});
