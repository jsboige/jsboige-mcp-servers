/**
 * Tests for ProfileApplicabilityHelper
 * @module services/roosync/__tests__/ProfileApplicabilityHelper.test
 */

import { describe, it, expect } from 'vitest';
import { ProfileApplicabilityHelper, ALL_CATEGORIES } from '../ProfileApplicabilityHelper.js';
import type { ConfigurationProfile, MachineInventory } from '../../types/non-nominative-baseline.js';

describe('ProfileApplicabilityHelper', () => {
  describe('ALL_CATEGORIES', () => {
    it('should contain all 11 expected categories', () => {
      expect(ALL_CATEGORIES).toHaveLength(11);
      expect(ALL_CATEGORIES).toContain('roo-core');
      expect(ALL_CATEGORIES).toContain('roo-advanced');
      expect(ALL_CATEGORIES).toContain('hardware-cpu');
      expect(ALL_CATEGORIES).toContain('hardware-memory');
      expect(ALL_CATEGORIES).toContain('hardware-storage');
      expect(ALL_CATEGORIES).toContain('hardware-gpu');
      expect(ALL_CATEGORIES).toContain('software-powershell');
      expect(ALL_CATEGORIES).toContain('software-node');
      expect(ALL_CATEGORIES).toContain('software-python');
      expect(ALL_CATEGORIES).toContain('system-os');
      expect(ALL_CATEGORIES).toContain('system-architecture');
    });

    it('should have no duplicate categories', () => {
      const unique = new Set(ALL_CATEGORIES);
      expect(unique.size).toBe(ALL_CATEGORIES.length);
    });
  });

  describe('isApplicable', () => {
    const emptyInventory: MachineInventory = {
      machineId: 'test-machine',
      timestamp: Date.now(),
    };

    const profile = (category: ConfigurationProfile['category']): ConfigurationProfile => ({
      id: `test-${category}`,
      category,
      baselineId: 'baseline-1',
      priority: 1,
      config: {},
    });

    describe('roo-* categories (always applicable)', () => {
      it('should accept roo-core', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('roo-core'), emptyInventory)).toBe(true);
      });

      it('should accept roo-advanced', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('roo-advanced'), emptyInventory)).toBe(true);
      });
    });

    describe('hardware-* categories', () => {
      it('should accept hardware-cpu', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-cpu'), emptyInventory)).toBe(true);
      });

      it('should accept hardware-memory', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-memory'), emptyInventory)).toBe(true);
      });

      it('should accept hardware-storage', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-storage'), emptyInventory)).toBe(true);
      });

      it('should reject hardware-gpu when no GPU present', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-gpu'), emptyInventory)).toBe(false);
      });

      it('should accept hardware-gpu when config.hardware.gpu is true', () => {
        const inventoryWithGpu: MachineInventory = {
          ...emptyInventory,
          config: { hardware: { gpu: true } },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-gpu'), inventoryWithGpu)).toBe(true);
      });

      it('should accept hardware-gpu when systemInfo.gpu array has items', () => {
        const inventoryWithGpu: MachineInventory = {
          ...emptyInventory,
          inventory: {
            systemInfo: {
              gpu: [{ name: 'NVIDIA RTX 3080', vram: 10 }],
            },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-gpu'), inventoryWithGpu)).toBe(true);
      });

      it('should accept hardware-gpu when gpuDetails array has items', () => {
        const inventoryWithGpu: MachineInventory = {
          ...emptyInventory,
          inventory: {
            gpuDetails: [{ name: 'AMD RX 6800' }],
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('hardware-gpu'), inventoryWithGpu)).toBe(true);
      });
    });

    describe('software-* categories', () => {
      it('should reject software-powershell when not detected', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), emptyInventory)).toBe(false);
      });

      it('should accept software-powershell when detected in systemInfo', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            systemInfo: { powershellVersion: '7.4.0' },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), inventory)).toBe(true);
      });

      it('should accept software-powershell when detected in tools', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            tools: { powershell: { version: '7.3.0' } },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), inventory)).toBe(true);
      });

      it('should accept software-powershell when detected in legacy config', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          config: { software: { powershell: true } },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), inventory)).toBe(true);
      });

      it('should reject software-powershell when version is Unknown', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            systemInfo: { powershellVersion: 'Unknown' },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), inventory)).toBe(false);
      });

      it('should reject software-powershell when version is empty string', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            systemInfo: { powershellVersion: '' },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-powershell'), inventory)).toBe(false);
      });

      it('should reject software-node when not detected', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-node'), emptyInventory)).toBe(false);
      });

      it('should accept software-node when detected in tools', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            tools: { node: { version: '20.11.0' } },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-node'), inventory)).toBe(true);
      });

      it('should accept software-node when detected in legacy config', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          config: { software: { node: true } },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-node'), inventory)).toBe(true);
      });

      it('should reject software-python when not detected', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-python'), emptyInventory)).toBe(false);
      });

      it('should accept software-python when detected in tools', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          inventory: {
            tools: { python: { version: '3.12.0' } },
          },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-python'), inventory)).toBe(true);
      });

      it('should accept software-python when detected in legacy config', () => {
        const inventory: MachineInventory = {
          ...emptyInventory,
          config: { software: { python: true } },
        };
        expect(ProfileApplicabilityHelper.isApplicable(profile('software-python'), inventory)).toBe(true);
      });
    });

    describe('system-* categories (always applicable)', () => {
      it('should accept system-os', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('system-os'), emptyInventory)).toBe(true);
      });

      it('should accept system-architecture', () => {
        expect(ProfileApplicabilityHelper.isApplicable(profile('system-architecture'), emptyInventory)).toBe(true);
      });
    });

    describe('unknown category (default to applicable)', () => {
      it('should accept unknown category as fallback', () => {
        const unknownProfile: ConfigurationProfile = {
          id: 'unknown-1',
          category: 'unknown-category' as ConfigurationProfile['category'],
          baselineId: 'baseline-1',
          priority: 1,
          config: {},
        };
        expect(ProfileApplicabilityHelper.isApplicable(unknownProfile, emptyInventory)).toBe(true);
      });
    });
  });

  describe('filterApplicable', () => {
    const emptyInventory: MachineInventory = {
      machineId: 'test-machine',
      timestamp: Date.now(),
    };

    const profile = (category: ConfigurationProfile['category']): ConfigurationProfile => ({
      id: `test-${category}`,
      category,
      baselineId: 'baseline-1',
      priority: 1,
      config: {},
    });

    it('should return all profiles as applicable when inventory matches all', () => {
      const profiles = [
        profile('roo-core'),
        profile('hardware-cpu'),
        profile('system-os'),
      ];

      const result = ProfileApplicabilityHelper.filterApplicable(profiles, emptyInventory);

      expect(result.applicable).toHaveLength(3);
      expect(result.excluded).toHaveLength(0);
    });

    it('should separate applicable from excluded profiles', () => {
      const profiles = [
        profile('roo-core'),
        profile('hardware-gpu'),
        profile('system-os'),
      ];

      const result = ProfileApplicabilityHelper.filterApplicable(profiles, emptyInventory);

      expect(result.applicable).toHaveLength(2);
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].profile.category).toBe('hardware-gpu');
      expect(result.excluded[0].reason).toBe('Machine has no GPU');
    });

    it('should provide exclusion reasons for software profiles', () => {
      const profiles = [
        profile('software-powershell'),
        profile('software-node'),
        profile('software-python'),
      ];

      const result = ProfileApplicabilityHelper.filterApplicable(profiles, emptyInventory);

      expect(result.applicable).toHaveLength(0);
      expect(result.excluded).toHaveLength(3);
      expect(result.excluded[0].reason).toBe('PowerShell not detected');
      expect(result.excluded[1].reason).toBe('Node.js not detected');
      expect(result.excluded[2].reason).toBe('Python not detected');
    });

    it('should handle empty profile list', () => {
      const result = ProfileApplicabilityHelper.filterApplicable([], emptyInventory);

      expect(result.applicable).toHaveLength(0);
      expect(result.excluded).toHaveLength(0);
    });
  });
});
