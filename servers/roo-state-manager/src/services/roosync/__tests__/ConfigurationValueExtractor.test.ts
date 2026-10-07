/**
 * Tests pour ConfigurationValueExtractor.ts (#4106)
 *
 * Le comparateur ne gérait que 2 des 11 catégories (`roo-core`, `hardware-cpu`) ;
 * toute autre catégorie rendait `undefined` côté machine et la comparaison passait
 * en silence. Ces tests verrouillent le contrat centralisé :
 * - les 11 catégories de `ConfigurationCategory` extraient une valeur ;
 * - une catégorie hors nomenclature échoue bruyamment au lieu de rendre `undefined`.
 */

import { describe, test, expect } from 'vitest';
import { ConfigurationValueExtractor } from '../ConfigurationValueExtractor.js';
import { ALL_CATEGORIES } from '../ProfileApplicabilityHelper.js';

describe('ConfigurationValueExtractor', () => {
  // ============================================================
  // Exhaustivité : les 11 catégories connues extraient sans jeter
  // ============================================================

  test('extracts without throwing for every known category (all 11)', () => {
    expect(ALL_CATEGORIES).toHaveLength(11);
    for (const category of ALL_CATEGORIES) {
      expect(() =>
        ConfigurationValueExtractor.extract({ machineId: 'm1' }, category)
      ).not.toThrow();
    }
  });

  test('a category outside ConfigurationCategory throws instead of returning undefined (#4106)', () => {
    expect(() =>
      ConfigurationValueExtractor.extract({ machineId: 'm1' }, 'not-a-category')
    ).toThrow(/Unknown configuration category/);
  });

  // ============================================================
  // Catégories qui étaient déjà gérées (non-régression)
  // ============================================================

  test('roo-core → { modes, mcpSettings } (legacy config.roo)', () => {
    const inventory = { config: { roo: { modes: ['code'], mcpSettings: { s: true } } } };
    expect(ConfigurationValueExtractor.extract(inventory, 'roo-core')).toEqual({
      modes: ['code'],
      mcpSettings: { s: true },
    });
  });

  test('roo-core falls back to inventory.rooModes (current structure)', () => {
    const inventory = { inventory: { rooModes: ['debug'] } };
    expect(ConfigurationValueExtractor.extract(inventory, 'roo-core')).toEqual({
      modes: ['debug'],
      mcpSettings: undefined,
    });
  });

  test('hardware-cpu → config.hardware.cpu', () => {
    expect(
      ConfigurationValueExtractor.extract({ config: { hardware: { cpu: 'AMD' } } }, 'hardware-cpu')
    ).toBe('AMD');
  });

  test('hardware-cpu falls back to inventory.systemInfo', () => {
    const si = { cpuCores: 8 };
    expect(
      ConfigurationValueExtractor.extract({ inventory: { systemInfo: si } }, 'hardware-cpu')
    ).toBe(si);
  });

  // ============================================================
  // Catégories qui rendaient undefined avant le correctif (#4106)
  // ============================================================

  test('roo-advanced → { userSettings }', () => {
    const inventory = { config: { roo: { userSettings: { theme: 'dark' } } } };
    expect(ConfigurationValueExtractor.extract(inventory, 'roo-advanced')).toEqual({
      userSettings: { theme: 'dark' },
    });
  });

  test('hardware-memory → config.hardware.memory', () => {
    const mem = { total: 32 };
    expect(
      ConfigurationValueExtractor.extract({ config: { hardware: { memory: mem } } }, 'hardware-memory')
    ).toBe(mem);
  });

  test('hardware-storage → disks (legacy) or inventory.systemInfo.disks (current)', () => {
    expect(
      ConfigurationValueExtractor.extract({ config: { hardware: { disks: ['a'] } } }, 'hardware-storage')
    ).toEqual(['a']);
    expect(
      ConfigurationValueExtractor.extract(
        { inventory: { systemInfo: { disks: ['b'] } } },
        'hardware-storage'
      )
    ).toEqual(['b']);
  });

  test('hardware-gpu → config.hardware.gpu or inventory.systemInfo.gpu', () => {
    expect(
      ConfigurationValueExtractor.extract({ config: { hardware: { gpu: 'RTX' } } }, 'hardware-gpu')
    ).toBe('RTX');
    expect(
      ConfigurationValueExtractor.extract(
        { inventory: { systemInfo: { gpu: ['igpu'] } } },
        'hardware-gpu'
      )
    ).toEqual(['igpu']);
  });

  test('software-* → { version } from legacy config.software', () => {
    const inventory = { config: { software: { powershell: '7.4', node: '20', python: '3.11' } } };
    expect(ConfigurationValueExtractor.extract(inventory, 'software-powershell')).toEqual({ version: '7.4' });
    expect(ConfigurationValueExtractor.extract(inventory, 'software-node')).toEqual({ version: '20' });
    expect(ConfigurationValueExtractor.extract(inventory, 'software-python')).toEqual({ version: '3.11' });
  });

  test('software-* → { version } from current inventory.tools, with Unknown fallback', () => {
    const inventory = { inventory: { tools: { node: { version: '22' } } } };
    expect(ConfigurationValueExtractor.extract(inventory, 'software-node')).toEqual({ version: '22' });
    // powershell not present anywhere → 'Unknown' (not undefined: the category is known)
    expect(ConfigurationValueExtractor.extract(inventory, 'software-powershell')).toEqual({ version: 'Unknown' });
  });

  test('system-* → { os } / { arch }', () => {
    const inventory = { config: { system: { os: 'Windows', architecture: 'x64' } } };
    expect(ConfigurationValueExtractor.extract(inventory, 'system-os')).toEqual({ os: 'Windows' });
    expect(ConfigurationValueExtractor.extract(inventory, 'system-architecture')).toEqual({ arch: 'x64' });
  });
});
