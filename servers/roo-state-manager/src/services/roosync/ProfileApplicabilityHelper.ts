/**
 * Profile applicability matching for non-nominative baselines.
 *
 * Determines whether a ConfigurationProfile is applicable to a machine
 * based on its inventory data. Category-specific rules:
 * - roo-*: Always applicable (all fleet machines run Roo)
 * - hardware-*: Always applicable except hardware-gpu (needs GPU)
 * - software-*: Only if the software is installed and detected
 * - system-*: Always applicable
 *
 * @module services/roosync/ProfileApplicabilityHelper
 * @issue #1843 finding #4
 */

import type { ConfigurationProfile, ConfigurationCategory, MachineInventory } from '../../types/non-nominative-baseline.js';

export class ProfileApplicabilityHelper {
  /**
   * Check if a profile is applicable to a machine based on its inventory.
   * Pure function — no side effects, safe for concurrent use.
   */
  static isApplicable(profile: ConfigurationProfile, inventory: MachineInventory): boolean {
    switch (profile.category) {
      case 'roo-core':
      case 'roo-advanced':
        return true;

      case 'hardware-cpu':
      case 'hardware-memory':
      case 'hardware-storage':
        return true;

      case 'hardware-gpu':
        return this.hasGpu(inventory);

      case 'software-powershell':
        return this.hasSoftware(
          inventory.inventory?.systemInfo?.powershellVersion,
          inventory.inventory?.tools?.powershell?.version,
          inventory.config?.software?.powershell
        );

      case 'software-node':
        return this.hasSoftware(
          undefined,
          inventory.inventory?.tools?.node?.version,
          inventory.config?.software?.node
        );

      case 'software-python':
        return this.hasSoftware(
          undefined,
          inventory.inventory?.tools?.python?.version,
          inventory.config?.software?.python
        );

      case 'system-os':
      case 'system-architecture':
        return true;

      default:
        return true;
    }
  }

  /**
   * Get all applicable profiles from a list, returning both matches and exclusions.
   */
  static filterApplicable(
    profiles: ConfigurationProfile[],
    inventory: MachineInventory
  ): { applicable: ConfigurationProfile[]; excluded: Array<{ profile: ConfigurationProfile; reason: string }> } {
    const applicable: ConfigurationProfile[] = [];
    const excluded: Array<{ profile: ConfigurationProfile; reason: string }> = [];

    for (const profile of profiles) {
      if (this.isApplicable(profile, inventory)) {
        applicable.push(profile);
      } else {
        excluded.push({
          profile,
          reason: this.getExclusionReason(profile, inventory),
        });
      }
    }

    return { applicable, excluded };
  }

  /** Check if the machine has a GPU. */
  private static hasGpu(inventory: MachineInventory): boolean {
    if (inventory.config?.hardware?.gpu) return true;
    const si = inventory.inventory?.systemInfo;
    if (si?.gpu && Array.isArray(si.gpu) && si.gpu.length > 0) return true;
    if (inventory.inventory?.gpuDetails && inventory.inventory.gpuDetails.length > 0) return true;
    return false;
  }

  /** Check if software is installed (non-Unknown version in any source). */
  private static hasSoftware(
    systemInfoVersion: string | undefined,
    toolsVersion: string | undefined,
    legacyVersion: string | undefined
  ): boolean {
    return [systemInfoVersion, toolsVersion, legacyVersion]
      .some(v => v != null && v !== '' && v !== 'Unknown');
  }

  /** Human-readable reason for exclusion. */
  private static getExclusionReason(profile: ConfigurationProfile, inventory: MachineInventory): string {
    const cat = profile.category;

    if (cat === 'hardware-gpu' && !this.hasGpu(inventory)) {
      return 'Machine has no GPU';
    }
    if (cat === 'software-powershell' && !this.hasSoftware(
      inventory.inventory?.systemInfo?.powershellVersion,
      inventory.inventory?.tools?.powershell?.version,
      inventory.config?.software?.powershell
    )) {
      return 'PowerShell not detected';
    }
    if (cat === 'software-node' && !this.hasSoftware(
      undefined,
      inventory.inventory?.tools?.node?.version,
      inventory.config?.software?.node
    )) {
      return 'Node.js not detected';
    }
    if (cat === 'software-python' && !this.hasSoftware(
      undefined,
      inventory.inventory?.tools?.python?.version,
      inventory.config?.software?.python
    )) {
      return 'Python not detected';
    }

    return `Category ${cat} not applicable`;
  }
}

/** All valid categories — used by tests for exhaustive coverage. */
export const ALL_CATEGORIES: ConfigurationCategory[] = [
  'roo-core', 'roo-advanced',
  'hardware-cpu', 'hardware-memory', 'hardware-storage', 'hardware-gpu',
  'software-powershell', 'software-node', 'software-python',
  'system-os', 'system-architecture',
];
