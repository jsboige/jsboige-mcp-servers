/**
 * Tests for ProfileApplicabilityHelper.ts
 * Issue #2642 — test coverage audit gap (0 tests, live prod code wired via NonNominativeBaselineService #1843)
 *
 * Pure-function class: category-based profile applicability matching.
 * No side effects, no mocks required.
 */

import { describe, test, expect } from 'vitest';
import {
  ProfileApplicabilityHelper,
  ALL_CATEGORIES,
} from '../ProfileApplicabilityHelper.js';
import type {
  ConfigurationProfile,
  ConfigurationCategory,
  MachineInventory,
} from '../../../../types/non-nominative-baseline.js';

/** Minimal profile fixture — only `.category` is read by the helper. */
function makeProfile(category: ConfigurationCategory): ConfigurationProfile {
  return {
    profileId: `profile-${category}`,
    category,
    name: category,
    description: 'test profile',
    configuration: {},
    priority: 1,
    compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: '1.0.0',
      tags: [],
      stability: 'stable',
    },
  } as ConfigurationProfile;
}

/** Inventory with no GPU and no detected software — the "bare" baseline. */
function bareInventory(): MachineInventory {
  return { machineId: 'test-machine' };
}

describe('ProfileApplicabilityHelper', () => {
  // ============================================================
  // isApplicable — always-true categories
  // ============================================================
  describe('isApplicable — always-applicable categories', () => {
    test.each(['roo-core', 'roo-advanced'] as ConfigurationCategory[])(
      '%s is always applicable',
      (category) => {
        expect(ProfileApplicabilityHelper.isApplicable(makeProfile(category), bareInventory())).toBe(true);
      }
    );

    test.each(['hardware-cpu', 'hardware-memory', 'hardware-storage'] as ConfigurationCategory[])(
      '%s is always applicable (no detection needed)',
      (category) => {
        expect(ProfileApplicabilityHelper.isApplicable(makeProfile(category), bareInventory())).toBe(true);
      }
    );

    test.each(['system-os', 'system-architecture'] as ConfigurationCategory[])(
      '%s is always applicable',
      (category) => {
        expect(ProfileApplicabilityHelper.isApplicable(makeProfile(category), bareInventory())).toBe(true);
      }
    );
  });

  // ============================================================
  // isApplicable — hardware-gpu (conditional on GPU presence)
  // ============================================================
  describe('isApplicable — hardware-gpu', () => {
    test('not applicable when machine has no GPU (bare inventory)', () => {
      expect(
        ProfileApplicabilityHelper.isApplicable(makeProfile('hardware-gpu'), bareInventory())
      ).toBe(false);
    });

    test('applicable via config.hardware.gpu', () => {
      const inv = { ...bareInventory(), config: { hardware: { gpu: 'NVIDIA RTX 4090' } } };
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('hardware-gpu'), inv)).toBe(true);
    });

    test('applicable via inventory.systemInfo.gpu array (non-empty)', () => {
      const inv = {
        ...bareInventory(),
        inventory: { systemInfo: { gpu: [{ name: 'NVIDIA RTX 4090' }] } },
      } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('hardware-gpu'), inv)).toBe(true);
    });

    test('NOT applicable via empty systemInfo.gpu array', () => {
      const inv = {
        ...bareInventory(),
        inventory: { systemInfo: { gpu: [] } },
      } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('hardware-gpu'), inv)).toBe(false);
    });

    test('applicable via inventory.gpuDetails (nvidia-smi) array (non-empty)', () => {
      const inv = {
        ...bareInventory(),
        inventory: {
          gpuDetails: [{ index: 0, name: 'RTX 4090', memoryTotal: 24576, memoryFree: 24000, memoryUsed: 576, source: 'nvidia-smi' }],
        },
      } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('hardware-gpu'), inv)).toBe(true);
    });
  });

  // ============================================================
  // isApplicable — software-* (conditional on detection)
  // ============================================================
  describe('isApplicable — software-powershell', () => {
    test('not applicable when not detected (bare inventory)', () => {
      expect(
        ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), bareInventory())
      ).toBe(false);
    });

    test('applicable via systemInfo.powershellVersion', () => {
      const inv = { ...bareInventory(), inventory: { systemInfo: { powershellVersion: '7.4.0' } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), inv)).toBe(true);
    });

    test('applicable via tools.powershell.version', () => {
      const inv = { ...bareInventory(), inventory: { tools: { powershell: { version: '7.4.0' } } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), inv)).toBe(true);
    });

    test('applicable via legacy config.software.powershell', () => {
      const inv = { ...bareInventory(), config: { software: { powershell: '7.4.0' } } };
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), inv)).toBe(true);
    });

    test('NOT applicable when only "Unknown" version is present', () => {
      const inv = {
        ...bareInventory(),
        inventory: { systemInfo: { powershellVersion: 'Unknown' }, tools: { powershell: { version: 'Unknown' } } },
        config: { software: { powershell: 'Unknown' } },
      } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), inv)).toBe(false);
    });

    test('NOT applicable when only empty-string versions are present', () => {
      const inv = {
        ...bareInventory(),
        inventory: { tools: { powershell: { version: '' } } },
      } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-powershell'), inv)).toBe(false);
    });
  });

  describe('isApplicable — software-node', () => {
    test('not applicable when not detected', () => {
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-node'), bareInventory())).toBe(false);
    });

    test('applicable via tools.node.version', () => {
      const inv = { ...bareInventory(), inventory: { tools: { node: { version: '20.10.0' } } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-node'), inv)).toBe(true);
    });

    test('applicable via legacy config.software.node', () => {
      const inv = { ...bareInventory(), config: { software: { node: '20.10.0' } } };
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-node'), inv)).toBe(true);
    });

    test('NOT applicable when version is "Unknown"', () => {
      const inv = { ...bareInventory(), inventory: { tools: { node: { version: 'Unknown' } } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-node'), inv)).toBe(false);
    });
  });

  describe('isApplicable — software-python', () => {
    test('not applicable when not detected', () => {
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-python'), bareInventory())).toBe(false);
    });

    test('applicable via tools.python.version', () => {
      const inv = { ...bareInventory(), inventory: { tools: { python: { version: '3.12.0' } } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-python'), inv)).toBe(true);
    });

    test('NOT applicable when version is "Unknown"', () => {
      const inv = { ...bareInventory(), inventory: { tools: { python: { version: 'Unknown' } } } } as MachineInventory;
      expect(ProfileApplicabilityHelper.isApplicable(makeProfile('software-python'), inv)).toBe(false);
    });
  });

  // ============================================================
  // isApplicable — default branch
  // ============================================================
  describe('isApplicable — default branch', () => {
    test('unknown category defaults to applicable (safe default)', () => {
      const unknownProfile = makeProfile('system-os'); // valid but test the default path via cast
      (unknownProfile as { category: string }).category = 'some-future-category';
      expect(ProfileApplicabilityHelper.isApplicable(unknownProfile, bareInventory())).toBe(true);
    });
  });

  // ============================================================
  // filterApplicable — split + exclusion reasons
  // ============================================================
  describe('filterApplicable', () => {
    test('splits a mixed list into applicable + excluded', () => {
      const profiles = [
        makeProfile('roo-core'),          // always true
        makeProfile('hardware-gpu'),      // false (bare inventory)
        makeProfile('software-node'),     // false (bare inventory)
        makeProfile('system-os'),         // always true
      ];
      const result = ProfileApplicabilityHelper.filterApplicable(profiles, bareInventory());
      expect(result.applicable).toHaveLength(2);
      expect(result.applicable.map((p) => p.category)).toEqual(['roo-core', 'system-os']);
      expect(result.excluded).toHaveLength(2);
      expect(result.excluded.map((e) => e.profile.category)).toEqual(['hardware-gpu', 'software-node']);
    });

    test('exclusion reason for missing GPU is human-readable', () => {
      const result = ProfileApplicabilityHelper.filterApplicable([makeProfile('hardware-gpu')], bareInventory());
      expect(result.excluded[0].reason).toBe('Machine has no GPU');
    });

    test('exclusion reason for undetected software names the software', () => {
      const result = ProfileApplicabilityHelper.filterApplicable(
        [makeProfile('software-node'), makeProfile('software-python'), makeProfile('software-powershell')],
        bareInventory()
      );
      expect(result.excluded[0].reason).toBe('Node.js not detected');
      expect(result.excluded[1].reason).toBe('Python not detected');
      expect(result.excluded[2].reason).toBe('PowerShell not detected');
    });

    test('empty input → empty applicable + empty excluded', () => {
      const result = ProfileApplicabilityHelper.filterApplicable([], bareInventory());
      expect(result.applicable).toEqual([]);
      expect(result.excluded).toEqual([]);
    });

    test('all-applicable list → empty excluded', () => {
      const profiles = [makeProfile('roo-core'), makeProfile('system-os')];
      const result = ProfileApplicabilityHelper.filterApplicable(profiles, bareInventory());
      expect(result.applicable).toHaveLength(2);
      expect(result.excluded).toEqual([]);
    });
  });

  // ============================================================
  // ALL_CATEGORIES exhaustive — every category returns a boolean, no throw
  // ============================================================
  describe('ALL_CATEGORIES exhaustive coverage', () => {
    test('every declared category is handled without throwing', () => {
      for (const category of ALL_CATEGORIES) {
        const result = ProfileApplicabilityHelper.isApplicable(makeProfile(category), bareInventory());
        expect(typeof result).toBe('boolean');
      }
    });

    test('ALL_CATEGORIES contains exactly the 11 known categories', () => {
      expect(ALL_CATEGORIES).toHaveLength(11);
      expect(ALL_CATEGORIES).toContain('hardware-gpu');
      expect(ALL_CATEGORIES).toContain('software-powershell');
    });
  });
});
