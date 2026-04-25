/**
 * Tests for IdentityService — RooSync identity validation
 *
 * Uses real temp directories (no filesystem mocking).
 * Exercises all 5 validation checks: registry, identity, presence, dashboard, config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { IdentityService } from '../../../../src/services/roosync/IdentityService.js';

describe('IdentityService', () => {
  let service: IdentityService;
  let tempDir: string;
  let sharedPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'identity-test-'));
    sharedPath = join(tempDir, '.shared-state');
    await mkdir(sharedPath, { recursive: true });
    service = IdentityService.getInstance();
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // ================================================================
  // Shared path missing
  // ================================================================
  describe('shared path validation', () => {
    it('should return all checks false when shared path does not exist', async () => {
      const result = await service.validateIdentityProtection(
        join(tempDir, 'no-exist'),
        'machine-1'
      );

      expect(result.checks.registryFile).toBe(false);
      expect(result.checks.identityRegistry).toBe(false);
      expect(result.checks.presenceFiles).toBe(false);
      expect(result.checks.dashboardFile).toBe(false);
      expect(result.checks.configFiles).toBe(false);
      expect(result.logs).toContainEqual(expect.stringContaining('does not exist'));
    });
  });

  // ================================================================
  // Registry file
  // ================================================================
  describe('registry file check', () => {
    it('should pass registryFile check when .machine-registry.json exists', async () => {
      const registry = { machines: { 'm1': { name: 'Machine 1' }, 'm2': { name: 'Machine 2' } } };
      await writeFile(
        join(sharedPath, '.machine-registry.json'),
        JSON.stringify(registry)
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.registryFile).toBe(true);
      expect(result.details.registry).toEqual(registry);
      expect(result.logs).toContainEqual(expect.stringContaining('2 machines'));
    });

    it('should warn when registry file is missing', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.registryFile).toBe(false);
      expect(result.logs).toContainEqual(expect.stringContaining('registry not found'));
    });

    it('should handle corrupted registry file', async () => {
      await writeFile(join(sharedPath, '.machine-registry.json'), 'not json');

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.registryFile).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('Error reading'));
    });
  });

  // ================================================================
  // Identity registry
  // ================================================================
  describe('identity registry check', () => {
    it('should pass identityRegistry check when .identity-registry.json exists', async () => {
      const identities = {
        identities: {
          'm1': { status: 'active', agent: 'claude' },
          'm2': { status: 'active', agent: 'roo' }
        }
      };
      await writeFile(
        join(sharedPath, '.identity-registry.json'),
        JSON.stringify(identities)
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.identityRegistry).toBe(true);
      expect(result.details.identities).toEqual(identities);
      expect(result.details.conflicts).toEqual([]);
      expect(result.logs).toContainEqual(expect.stringContaining('No identity conflicts'));
    });

    it('should detect identity conflicts', async () => {
      const identities = {
        identities: {
          'm1': { status: 'conflict', agent: 'claude' },
          'm2': { status: 'active', agent: 'roo' }
        }
      };
      await writeFile(
        join(sharedPath, '.identity-registry.json'),
        JSON.stringify(identities)
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.details.conflicts).toEqual(['m1']);
      expect(result.logs).toContainEqual(expect.stringContaining('Identity conflicts detected'));
    });

    it('should warn when identity registry is missing', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.identityRegistry).toBe(false);
      expect(result.logs).toContainEqual(expect.stringContaining('Identity registry not found'));
    });

    it('should handle corrupted identity registry', async () => {
      await writeFile(join(sharedPath, '.identity-registry.json'), '{bad json');

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.identityRegistry).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('Error reading'));
    });
  });

  // ================================================================
  // Presence files
  // ================================================================
  describe('presence files check', () => {
    it('should pass presenceFiles check when presence dir has JSON files', async () => {
      const presenceDir = join(sharedPath, 'presence');
      await mkdir(presenceDir, { recursive: true });

      await writeFile(
        join(presenceDir, 'm1.json'),
        JSON.stringify({ id: 'm1', status: 'online' })
      );
      await writeFile(
        join(presenceDir, 'm2.json'),
        JSON.stringify({ id: 'm2', status: 'offline' })
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.presenceFiles).toBe(true);
      expect(result.details.presence).toHaveLength(2);
      expect(result.logs).toContainEqual(expect.stringContaining('2 presence files'));
    });

    it('should detect duplicate machine IDs in presence files', async () => {
      const presenceDir = join(sharedPath, 'presence');
      await mkdir(presenceDir, { recursive: true });

      await writeFile(
        join(presenceDir, 'a.json'),
        JSON.stringify({ id: 'm1', status: 'online' })
      );
      await writeFile(
        join(presenceDir, 'b.json'),
        JSON.stringify({ id: 'm1', status: 'offline' })
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.logs).toContainEqual(expect.stringContaining('Duplicate machine IDs'));
    });

    it('should skip non-JSON files in presence directory', async () => {
      const presenceDir = join(sharedPath, 'presence');
      await mkdir(presenceDir, { recursive: true });

      await writeFile(join(presenceDir, 'm1.json'), JSON.stringify({ id: 'm1' }));
      await writeFile(join(presenceDir, 'readme.txt'), 'ignore me');

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.details.presence).toHaveLength(1);
    });

    it('should handle corrupted presence JSON file', async () => {
      const presenceDir = join(sharedPath, 'presence');
      await mkdir(presenceDir, { recursive: true });

      await writeFile(join(presenceDir, 'bad.json'), 'not json');
      await writeFile(join(presenceDir, 'good.json'), JSON.stringify({ id: 'm1' }));

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.details.presence).toHaveLength(1);
      expect(result.logs).toContainEqual(expect.stringContaining('Error reading presence file'));
    });

    it('should warn when presence directory is missing', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.presenceFiles).toBe(false);
      expect(result.logs).toContainEqual(expect.stringContaining('Presence directory not found'));
    });
  });

  // ================================================================
  // Dashboard file
  // ================================================================
  describe('dashboard file check', () => {
    it('should pass dashboardFile check when sync-dashboard.json exists', async () => {
      const dashboard = { machines: { 'm1': { status: 'online' } } };
      await writeFile(
        join(sharedPath, 'sync-dashboard.json'),
        JSON.stringify(dashboard)
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.dashboardFile).toBe(true);
      expect(result.details.dashboard).toEqual(dashboard);
      expect(result.logs).toContainEqual(expect.stringContaining('Dashboard file found'));
    });

    it('should warn when dashboard file is missing', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.dashboardFile).toBe(false);
      expect(result.logs).toContainEqual(expect.stringContaining('Dashboard file not found'));
    });

    it('should handle corrupted dashboard file', async () => {
      await writeFile(join(sharedPath, 'sync-dashboard.json'), 'not json');

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.dashboardFile).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('Error reading dashboard'));
    });
  });

  // ================================================================
  // Config files
  // ================================================================
  describe('config files check', () => {
    it('should pass configFiles check when sync-config.json matches machineId', async () => {
      await writeFile(
        join(sharedPath, 'sync-config.json'),
        JSON.stringify({ machineId: 'm1', version: '2.3' })
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.configFiles).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('matches machine ID'));
    });

    it('should warn when sync-config.json has different machineId', async () => {
      await writeFile(
        join(sharedPath, 'sync-config.json'),
        JSON.stringify({ machineId: 'other-machine', version: '2.3' })
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.configFiles).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('mismatch'));
    });

    it('should not fail when sync-config.json is missing', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.configFiles).toBe(false);
    });

    it('should handle corrupted sync-config.json', async () => {
      await writeFile(join(sharedPath, 'sync-config.json'), '{invalid}');

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.configFiles).toBe(true);
      expect(result.logs).toContainEqual(expect.stringContaining('Error reading'));
    });
  });

  // ================================================================
  // BOM handling
  // ================================================================
  describe('BOM handling', () => {
    it('should handle BOM-prefixed registry file', async () => {
      const registry = { machines: { 'm1': { name: 'Machine 1' } } };
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const content = Buffer.concat([bom, Buffer.from(JSON.stringify(registry), 'utf-8')]);

      await writeFile(join(sharedPath, '.machine-registry.json'), content);

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.registryFile).toBe(true);
      expect(result.details.registry).toEqual(registry);
    });
  });

  // ================================================================
  // Integration: full validation
  // ================================================================
  describe('full validation', () => {
    it('should pass all checks with a complete shared-state setup', async () => {
      // Registry
      await writeFile(
        join(sharedPath, '.machine-registry.json'),
        JSON.stringify({ machines: { 'm1': { name: 'Machine 1' } } })
      );

      // Identity
      await writeFile(
        join(sharedPath, '.identity-registry.json'),
        JSON.stringify({ identities: { 'm1': { status: 'active' } } })
      );

      // Presence
      const presenceDir = join(sharedPath, 'presence');
      await mkdir(presenceDir, { recursive: true });
      await writeFile(
        join(presenceDir, 'm1.json'),
        JSON.stringify({ id: 'm1', status: 'online' })
      );

      // Dashboard
      await writeFile(
        join(sharedPath, 'sync-dashboard.json'),
        JSON.stringify({ machines: {} })
      );

      // Config
      await writeFile(
        join(sharedPath, 'sync-config.json'),
        JSON.stringify({ machineId: 'm1' })
      );

      const result = await service.validateIdentityProtection(sharedPath, 'm1');

      expect(result.checks.registryFile).toBe(true);
      expect(result.checks.identityRegistry).toBe(true);
      expect(result.checks.presenceFiles).toBe(true);
      expect(result.checks.dashboardFile).toBe(true);
      expect(result.checks.configFiles).toBe(true);
      expect(result.details.conflicts).toEqual([]);
      expect(result.details.presence).toHaveLength(1);
      expect(result.machineId).toBe('m1');
      expect(result.sharedPath).toBe(sharedPath);
    });

    it('should return correct machineId and sharedPath', async () => {
      const result = await service.validateIdentityProtection(sharedPath, 'test-machine');

      expect(result.machineId).toBe('test-machine');
      expect(result.sharedPath).toBe(sharedPath);
    });
  });

  // ================================================================
  // Singleton pattern
  // ================================================================
  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = IdentityService.getInstance();
      const b = IdentityService.getInstance();
      expect(a).toBe(b);
    });
  });
});
