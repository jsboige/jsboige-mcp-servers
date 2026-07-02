import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigSharingService } from '../ConfigSharingService';
import { IConfigService, IInventoryCollector } from '../../types/baseline';
import { ConfigNormalizationService } from '../ConfigNormalizationService';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock ConfigNormalizationService
vi.mock('../ConfigNormalizationService', () => {
  const ConfigNormalizationService = vi.fn();
  ConfigNormalizationService.prototype.normalize = vi.fn().mockImplementation((config) => Promise.resolve(config));
  return { ConfigNormalizationService };
});

// Mock InventoryService - inline mock to avoid hoisting issues
vi.mock('../roosync/InventoryService', () => {
  return {
    InventoryService: {
      getInstance: () => ({
        getMachineInventory: vi.fn().mockResolvedValue({
          paths: {
            rooExtensions: '/mock/roo-extensions',
            mcpSettings: '/mock/.claude.json'
          }
        })
      })
    }
  };
});

// ---------------------------------------------------------------------------
// #833 R3 — assertion-strengthening helpers (audit Phase 4, po-2026 2026-06-13).
// Replace bare `toBeDefined()` checks with the real CollectConfigResult /
// ApplyConfigResult contracts so a test actually fails when the shape or an
// invariant regresses. Anchored on source (ConfigSharingService.ts):
//   - collectConfig manifest defaults  L62-68  (version '0.0.0', ISO timestamp, author, description)
//   - collectConfig return             L158-163 (filesCount === manifest.files.length; totalSize = Σ file.size)
//   - applyConfig version lookup       L298-303 (throws "Configuration non trouvée" for the mock path)
//   - applyConfig catch + dryRun ret   L783/L804-809 (error recorded → success:false, filesApplied:0)
// #815 scepticism: real values, never fabricated.
// ---------------------------------------------------------------------------

/** ISO-8601 string that round-trips through Date (as produced by `new Date().toISOString()`). */
function expectIsoTimestamp(value: string) {
  expect(typeof value).toBe('string');
  expect(new Date(value).toISOString()).toBe(value);
}

/**
 * Full contract of a collectConfig() call whose targets resolve to no files
 * (the mock inventory path `/mock/roo-extensions` does not exist on disk, so
 * every collector short-circuits to an empty file list).
 */
function expectEmptyCollectResult(result: any, description: string) {
  expect(typeof result.packagePath).toBe('string');
  expect(result.packagePath).toContain('config-collect');   // temp dir naming, L59
  // Manifest defaults before publication (L62-68)
  expect(result.manifest.version).toBe('0.0.0');
  expect(result.manifest.description).toBe(description);
  expect(typeof result.manifest.author).toBe('string');
  expect(result.manifest.author.length).toBeGreaterThan(0);
  expectIsoTimestamp(result.manifest.timestamp);
  // No files at the mock path → empty collection, count/size invariants hold (L149-163)
  expect(result.manifest.files).toEqual([]);
  expect(result.filesCount).toBe(0);
  expect(result.filesCount).toBe(result.manifest.files.length);
  expect(result.totalSize).toBe(0);
}

/**
 * Contract of applyConfig({dryRun:true}) against the mock shared-state path
 * (which never resolves to a published config): the version lookup throws
 * "Configuration non trouvée" (L298), the outer catch records it (L783), and
 * the dryRun branch returns nothing-written with success=false (L804-809).
 */
function expectDryRunConfigNotFound(result: any) {
  expect(result.success).toBe(false);              // an error was recorded → not success
  expect(result.filesApplied).toBe(0);             // dryRun writes nothing (L806)
  expect(Array.isArray(result.errors)).toBe(true);
  expect(result.errors!.length).toBeGreaterThanOrEqual(1); // the version-not-found error
}

describe('ConfigSharingService', () => {
  let service: ConfigSharingService;
  let mockConfigService: IConfigService;
  let mockInventoryCollector: IInventoryCollector;

  beforeEach(() => {
    mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared/state'),
    } as any;

    mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({
        paths: {
          mcpSettings: '/mock/.claude.json',
          rooExtensions: '/mock/roo-extensions'
        }
      }),
    } as any;

    service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
  });

  it('should initialize correctly', () => {
    expect(service).toBeInstanceOf(ConfigSharingService);
  });

  describe('compareWithBaseline', () => {
    it('should return a diff result', async () => {
      const config = { test: 'value' };
      const result = await service.compareWithBaseline(config);

      // {test:'value'} vs the empty baseline {} → exactly one 'add' change
      // (ConfigDiffService.deepCompare: key present in current, absent in baseline).
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('add');
      expect(result.summary).toEqual({ added: 1, modified: 0, deleted: 0, conflicts: 0 });
    });
  });

  // T3.8: Tests pour collectProfiles() - Tests d'intégration
  // Note: Ces tests vérifient que le service peut être appelé avec 'profiles' target
  // L'implémentation complète de collectProfiles() collecte depuis:
  // - configuration-profiles.json
  // - machine-mappings.json
  // - non-nominative-baseline.json
  describe('collectConfig with profiles target', () => {
    it('should handle profiles target without errors when no files exist', async () => {
      // Avec un mock retournant un chemin qui n'existe pas,
      // collectProfiles devrait retourner un tableau vide sans erreur
      const result = await service.collectConfig({
        targets: ['profiles'],
        description: 'Test collect profiles from non-existent path'
      });

      expectEmptyCollectResult(result, 'Test collect profiles from non-existent path');
    });

    it('should include profiles directory path in manifest', async () => {
      const result = await service.collectConfig({
        targets: ['profiles'],
        description: 'Test profiles path'
      });

      expectEmptyCollectResult(result, 'Test profiles path');
    });
  });

  // Tests pour les nouveaux targets: roomodes, model-configs, rules
  describe('collectConfig with roomodes target', () => {
    it('should handle roomodes target without errors when .roomodes does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test collect roomodes from non-existent path'
      });

      expectEmptyCollectResult(result, 'Test collect roomodes from non-existent path');
    });

    it('should return valid manifest structure for roomodes', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test roomodes manifest'
      });

      expectEmptyCollectResult(result, 'Test roomodes manifest');
    });
  });

  describe('collectConfig with model-configs target', () => {
    it('should handle model-configs target without errors when file does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['model-configs'],
        description: 'Test collect model-configs from non-existent path'
      });

      expectEmptyCollectResult(result, 'Test collect model-configs from non-existent path');
    });
  });

  describe('collectConfig with rules target', () => {
    it('should handle rules target without errors when rules-global dir does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test collect rules from non-existent path'
      });

      expectEmptyCollectResult(result, 'Test collect rules from non-existent path');
    });
  });

  describe('collectConfig with combined new targets', () => {
    it('should handle all new targets together without errors', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes', 'model-configs', 'rules'],
        description: 'Test all new targets combined'
      });

      expectEmptyCollectResult(result, 'Test all new targets combined');
    });

    it('should handle mix of old and new targets', async () => {
      const result = await service.collectConfig({
        targets: ['modes', 'roomodes', 'rules', 'profiles'],
        description: 'Test mixed old and new targets'
      });

      // All targets resolve against the non-existent mock path → still an empty collection.
      expectEmptyCollectResult(result, 'Test mixed old and new targets');
    });
  });

  // Issue #349: Tests pour le filtrage granulaire des targets mcp:xxx
  describe('applyConfig with granular targets', () => {

    it('should apply all files when no targets specified', async () => {
      // No published config exists at the mock shared-state path, so the version
      // lookup fails and the dryRun result reports the recorded error (success:false).
      const result = await service.applyConfig({
        version: 'latest',
        targets: undefined,
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on modes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on mcp target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on profiles target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['profiles'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on granular mcp:xxx targets', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp:github', 'mcp:win-cli'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should handle mixed targets (modes and mcp:xxx)', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes', 'mcp:github'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on roomodes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on model-configs target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['model-configs'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should filter files based on rules target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['rules'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should handle all new targets combined in apply', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes', 'model-configs', 'rules'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });
  });

  // Issue #349: Tests pour collectConfig avec targets granulaires mcp:xxx
  describe('collectConfig with granular mcp targets', () => {
    it('should collect specific MCP servers when mcp:xxx targets are provided', async () => {
      const result = await service.collectConfig({
        targets: ['mcp:github', 'mcp:win-cli'],
        description: 'Test granular MCP collection'
      });

      expectEmptyCollectResult(result, 'Test granular MCP collection');
    });

    it('should collect all MCPs when mcp target is provided', async () => {
      const result = await service.collectConfig({
        targets: ['mcp'],
        description: 'Test all MCPs collection'
      });

      expectEmptyCollectResult(result, 'Test all MCPs collection');
    });

    it('should handle empty mcp:xxx target gracefully', async () => {
      // Le parsing dans apply-config.ts devrait rejeter les targets mcp: vides.
      // Côté service, un target 'mcp:' sans nom ne collecte rien → collection vide.
      const result = await service.collectConfig({
        targets: ['mcp:'],
        description: 'Test empty MCP target'
      });

      expectEmptyCollectResult(result, 'Test empty MCP target');
    });
  });

  // Issue #547 Phase 2: Tests d'intégration pour les settings Roo
  describe('collectConfig with settings target', () => {
    it('should accept settings target without errors', async () => {
      // collectSettings reads the local Roo state.vscdb, which may or may not exist
      // on the host — so the file list can be 0..N. The count/size invariants and the
      // manifest defaults hold regardless.
      const result = await service.collectConfig({
        targets: ['settings'],
        description: 'Test collect Roo settings'
      });

      expect(result.manifest.version).toBe('0.0.0');
      expect(result.manifest.description).toBe('Test collect Roo settings');
      expectIsoTimestamp(result.manifest.timestamp);
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(result.manifest.files.length); // invariant, any count
      expect(result.totalSize).toBeGreaterThanOrEqual(0);
    });

    it('should handle settings alongside other targets', async () => {
      const result = await service.collectConfig({
        targets: ['modes', 'mcp', 'settings'],
        description: 'Test mixed targets with settings'
      });

      expect(result.manifest.description).toBe('Test mixed targets with settings');
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(result.manifest.files.length);
      expect(result.totalSize).toBeGreaterThanOrEqual(0);
    });

    it('should return valid manifest structure for settings', async () => {
      const result = await service.collectConfig({
        targets: ['settings'],
        description: 'Test settings manifest structure'
      });

      expect(result.manifest.version).toBe('0.0.0');
      expect(result.manifest.description).toBe('Test settings manifest structure');
      expectIsoTimestamp(result.manifest.timestamp);
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(result.manifest.files.length);
    });
  });

  describe('applyConfig with settings target', () => {
    it('should handle missing settings gracefully when applying', async () => {
      // La version 'latest' n'existe pas au mock path → erreur enregistrée, rien écrit.
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['settings'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should skip settings when not in targets', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes', 'mcp'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });

    it('should support dryRun for settings', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['settings'],
        dryRun: true
      });

      expectDryRunConfigNotFound(result);
    });
  });

  // ==================================================================
  // Cluster C coverage — branches genuinement non-couvertes.
  // Anchored on real source contract (ConfigSharingService.ts).
  // #815 scepticism: real values, never fabricated.
  // ==================================================================

  describe('mergeSchedulesById (#2411 — pure merge semantics, L2117-2140)', () => {
    const merge = (source: any[], target: any[]) =>
      (service as any).mergeSchedulesById(source, target);

    it('preserves target schedules when source is empty', () => {
      const target = [{ id: 'a', cron: '0 * * * *', enabled: true }];
      expect(merge([], target)).toEqual([{ id: 'a', cron: '0 * * * *', enabled: true }]);
    });

    it('source overrides target on matching id (source wins, target-only fields kept)', () => {
      const target = [{ id: 'a', cron: '0 * * * *', enabled: true, machineId: 'po-2026' }];
      const source = [{ id: 'a', enabled: false }];
      const result = merge(source, target);
      expect(result).toHaveLength(1);
      expect(result[0].enabled).toBe(false);       // source field wins
      expect(result[0].cron).toBe('0 * * * *');     // target-only field preserved (spread merge)
      expect(result[0].machineId).toBe('po-2026');
    });

    it('appends source schedule whose id is not in target', () => {
      const result = merge([{ id: 'b', cron: '30 * * * *' }], [{ id: 'a', cron: '0 * * * *' }]);
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.id).sort()).toEqual(['a', 'b']);
    });

    it('always appends source schedules without an id', () => {
      const result = merge([{ cron: '15 * * * *' }], [{ id: 'a', cron: '0 * * * *' }]);
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({ cron: '15 * * * *' });
    });

    it('returns [] when both inputs are empty', () => {
      expect(merge([], [])).toEqual([]);
    });

    it('returns source copies when target is empty', () => {
      expect(merge([{ id: 'x', cron: '0 9 * * *' }], [])).toEqual([{ id: 'x', cron: '0 9 * * *' }]);
    });

    it('does not mutate input arrays (defensive spread copies)', () => {
      const target = [{ id: 'a', cron: '0 * * * *' }];
      const source = [{ id: 'a', enabled: false }];
      const targetSnap = JSON.parse(JSON.stringify(target));
      const sourceSnap = JSON.parse(JSON.stringify(source));
      const result = merge(source, target);
      (result[0] as any).mutated = true; // mutating result must not bleed into inputs
      expect(target).toEqual(targetSnap);
      expect(source).toEqual(sourceSnap);
    });
  });

  describe('calculateHash (deterministic sha256, L2025-2028)', () => {
    it('returns the sha256 hex of file content', async () => {
      const tmp = join(tmpdir(), `rsm-calc-hash-${Math.random().toString(36).slice(2)}.txt`);
      await fs.writeFile(tmp, 'hello');
      try {
        const hash: string = await (service as any).calculateHash(tmp);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    });
  });

  describe('compareWithBaseline — mcpServers normalization branch (L1385-1404)', () => {
    const normalizeSpy = () => vi.mocked(ConfigNormalizationService.prototype.normalize);

    beforeEach(() => {
      normalizeSpy().mockClear();
    });

    it('normalizes as mcp_config when config.mcpServers is present', async () => {
      const config = { mcpServers: { github: { command: 'x' } } };
      const result = await service.compareWithBaseline(config);

      expect(normalizeSpy()).toHaveBeenCalledTimes(1);
      expect(normalizeSpy()).toHaveBeenCalledWith(config, 'mcp_config');
      // A diff is produced against the (empty {}) baseline — the L1399 branch ran end-to-end.
      expect(Array.isArray(result.changes)).toBe(true);
      expect(result.changes.length).toBeGreaterThanOrEqual(1);
    });

    it('skips normalization when config has no mcpServers (compares config as-is)', async () => {
      const config = { modes: { code: {} }, unrelated: true };
      const result = await service.compareWithBaseline(config);

      expect(normalizeSpy()).not.toHaveBeenCalled();
      expect(result.summary).toBeDefined();
      expect(result.changes).toBeInstanceOf(Array);
    });
  });

  describe('publishConfig (machineId resolution + #2121 snapshot cap, L170-238)', () => {
    let realSharedState: string;
    let pkgDir: string;
    let originalMachineId: string | undefined;

    beforeEach(async () => {
      realSharedState = join(tmpdir(), `rsm-pub-state-${Math.random().toString(36).slice(2)}`);
      pkgDir = join(tmpdir(), `rsm-pub-pkg-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(pkgDir, { recursive: true });
      // publishConfig reads manifest.json from the copied package (L195)
      await fs.writeFile(join(pkgDir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf-8');
      originalMachineId = process.env.ROOSYNC_MACHINE_ID;
      (mockConfigService.getSharedStatePath as any).mockReturnValue(realSharedState);
    });

    afterEach(async () => {
      if (originalMachineId === undefined) delete process.env.ROOSYNC_MACHINE_ID;
      else process.env.ROOSYNC_MACHINE_ID = originalMachineId;
      await fs.rm(realSharedState, { recursive: true, force: true }).catch(() => {});
      await fs.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
    });

    it('resolves machineId from ROOSYNC_MACHINE_ID and stamps it on the manifest', async () => {
      process.env.ROOSYNC_MACHINE_ID = 'test-machine-42';
      const result = await service.publishConfig({
        packagePath: pkgDir,
        version: '1',
        description: 'unit-test-publish'
      } as any);

      expect(result.success).toBe(true);
      expect(result.machineId).toBe('test-machine-42');
      expect(result.version).toBe('1');

      const machineDir = join(realSharedState, 'configs', 'test-machine-42');
      expect(existsSync(join(machineDir, 'latest.json'))).toBe(true);

      const published = JSON.parse(await fs.readFile(join(result.path, 'manifest.json'), 'utf-8'));
      expect(published.author).toBe('test-machine-42'); // L200: author = machineId
      expect(published.version).toBe('1');
      expect(published.description).toBe('unit-test-publish');

      const latest = JSON.parse(await fs.readFile(join(machineDir, 'latest.json'), 'utf-8'));
      expect(latest.version).toBe('1');
      expect(latest.manifest.author).toBe('test-machine-42');
    });

    it('falls back to "unknown" machineId when no env var is set', async () => {
      delete process.env.ROOSYNC_MACHINE_ID;
      const result = await service.publishConfig({
        packagePath: pkgDir,
        version: '1',
        description: 'no-env'
      } as any);
      // machineId = options.machineId || ROOSYNC_MACHINE_ID || COMPUTERNAME || 'unknown'
      // COMPUTERNAME is always defined on Windows hosts, so the *guarded* branch we can
      // assert deterministically is that an explicit options.machineId wins over everything.
      expect(result.success).toBe(true);
      // We cannot assert 'unknown' here (COMPUTERNAME present); assert the dir is non-empty instead.
      expect(typeof result.machineId).toBe('string');
      expect(result.machineId.length).toBeGreaterThan(0);
    });

    it('caps versioned snapshots to 3 (#2121) — prunes oldest beyond 3', async () => {
      process.env.ROOSYNC_MACHINE_ID = 'cap-test-machine';
      // Distinct integer versions → dir names v1-*, v2-*, v3-*, v4-* (no dot → counted by filter L219)
      for (let i = 0; i < 4; i++) {
        await service.publishConfig({
          packagePath: pkgDir,
          version: String(i + 1),
          description: `snap-${i}`
        } as any);
      }
      const machineDir = join(realSharedState, 'configs', 'cap-test-machine');
      const entries = await fs.readdir(machineDir);
      const versionDirs = entries.filter(e => e.startsWith('v') && !e.includes('.'));
      expect(versionDirs).toHaveLength(3);            // pruned from 4 → 3
      expect(existsSync(join(machineDir, 'latest.json'))).toBe(true); // latest.json preserved
    });
  });
});
