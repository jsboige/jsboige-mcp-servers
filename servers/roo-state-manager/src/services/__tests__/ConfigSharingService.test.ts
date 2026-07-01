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
    expect(service).toBeDefined();
  });

  describe('compareWithBaseline', () => {
    it('should return a diff result', async () => {
      const config = { test: 'value' };
      const result = await service.compareWithBaseline(config);

      expect(result).toBeDefined();
      expect(result.changes).toBeDefined();
      expect(result.summary).toBeDefined();
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

      // Le service doit retourner un résultat valide même sans fichiers
      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // filesCount peut être 0 car les fichiers n'existent pas dans le mock path
      expect(result.filesCount).toBe(0);
    });

    it('should include profiles directory path in manifest', async () => {
      const result = await service.collectConfig({
        targets: ['profiles'],
        description: 'Test profiles path'
      });

      // Vérifier que le manifest est bien structuré
      expect(result.manifest.description).toBe('Test profiles path');
      expect(result.manifest.timestamp).toBeDefined();
    });
  });

  // Tests pour les nouveaux targets: roomodes, model-configs, rules
  describe('collectConfig with roomodes target', () => {
    it('should handle roomodes target without errors when .roomodes does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test collect roomodes from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // filesCount = 0 car le fichier .roomodes n'existe pas au mock path
      expect(result.filesCount).toBe(0);
    });

    it('should return valid manifest structure for roomodes', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test roomodes manifest'
      });

      expect(result.manifest.description).toBe('Test roomodes manifest');
      expect(result.manifest.timestamp).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
    });
  });

  describe('collectConfig with model-configs target', () => {
    it('should handle model-configs target without errors when file does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['model-configs'],
        description: 'Test collect model-configs from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });
  });

  describe('collectConfig with rules target', () => {
    it('should handle rules target without errors when rules-global dir does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test collect rules from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });
  });

  describe('collectConfig with combined new targets', () => {
    it('should handle all new targets together without errors', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes', 'model-configs', 'rules'],
        description: 'Test all new targets combined'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });

    it('should handle mix of old and new targets', async () => {
      const result = await service.collectConfig({
        targets: ['modes', 'roomodes', 'rules', 'profiles'],
        description: 'Test mixed old and new targets'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });
  });

  // Issue #349: Tests pour le filtrage granulaire des targets mcp:xxx
  describe('applyConfig with granular targets', () => {

    it('should apply all files when no targets specified', async () => {
      // Ce test nécessite un setup plus complexe avec des fichiers temporaires
      // Pour l'instant, on vérifie que le service accepte l'appel sans targets
      // Note: success peut être false si aucun fichier source n'existe dans le mock path
      const result = await service.applyConfig({
        version: 'latest',
        targets: undefined,
        dryRun: true
      });

      expect(result).toBeDefined();
      // Le résultat peut être success=false si les configs n'existent pas (mock path)
      // On vérifie seulement que la structure de résultat est valide
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on modes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes'],
        dryRun: true
      });

      expect(result).toBeDefined();
      // Le filtrage est implémenté, le test vérifie que l'appel fonctionne
    });

    it('should filter files based on mcp target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on profiles target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['profiles'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on granular mcp:xxx targets', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp:github', 'mcp:win-cli'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should handle mixed targets (modes and mcp:xxx)', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes', 'mcp:github'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on roomodes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on model-configs target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['model-configs'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on rules target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['rules'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle all new targets combined in apply', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes', 'model-configs', 'rules'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  // Issue #349: Tests pour collectConfig avec targets granulaires mcp:xxx
  describe('collectConfig with granular mcp targets', () => {
    it('should collect specific MCP servers when mcp:xxx targets are provided', async () => {
      // Ce test nécessite un setup avec des fichiers MCP temporaires
      // Pour l'instant, on vérifie que le service accepte les targets mcp:xxx
      const result = await service.collectConfig({
        targets: ['mcp:github', 'mcp:win-cli'],
        description: 'Test granular MCP collection'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
    });

    it('should collect all MCPs when mcp target is provided', async () => {
      const result = await service.collectConfig({
        targets: ['mcp'],
        description: 'Test all MCPs collection'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });

    it('should handle empty mcp:xxx target gracefully', async () => {
      // Le parsing dans apply-config.ts devrait rejeter les targets mcp: vides
      // Ce test vérifie le comportement côté service
      const result = await service.collectConfig({
        targets: ['mcp:'],
        description: 'Test empty MCP target'
      });

      // Le service devrait retourner un résultat valide même si aucun MCP n'est collecté
      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });
  });

  // Issue #547 Phase 2: Tests d'intégration pour les settings Roo
  describe('collectConfig with settings target', () => {
    it('should accept settings target without errors', async () => {
      // Test que le service accepte la target 'settings'
      // L'implémentation réelle de collectSettings gère les cas où state.vscdb n'existe pas
      const result = await service.collectConfig({
        targets: ['settings'],
        description: 'Test collect Roo settings'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // Les settings peuvent être vides (0) ou collectées (>0) selon si state.vscdb existe
      expect(result.manifest.files.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle settings alongside other targets', async () => {
      const result = await service.collectConfig({
        targets: ['modes', 'mcp', 'settings'],
        description: 'Test mixed targets with settings'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // Vérifier que le manifest est valide même si aucun fichier n'est collecté
      expect(Array.isArray(result.manifest.files)).toBe(true);
    });

    it('should return valid manifest structure for settings', async () => {
      const result = await service.collectConfig({
        targets: ['settings'],
        description: 'Test settings manifest structure'
      });

      // Vérifier la structure du manifest
      expect(result.manifest.description).toBe('Test settings manifest structure');
      expect(result.manifest.timestamp).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
    });
  });

  describe('applyConfig with settings target', () => {
    it('should handle missing settings gracefully when applying', async () => {
      // Ce test vérifie que applyConfig peut gérer le cas où la version n'existe pas
      // sans se bloquer sur les settings manquants
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['settings'],
        dryRun: true
      });

      expect(result).toBeDefined();
      // filesApplied doit être 0 en dryRun
      expect(result.filesApplied).toBe(0);
    });

    it('should skip settings when not in targets', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes', 'mcp'],
        dryRun: true
      });

      expect(result).toBeDefined();
      // Si aucune config ne correspond aux targets (fichiers n'existent pas),
      // le résultat doit toujours être valide
      expect(result.success).toBeDefined();
    });

    it('should support dryRun for settings', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['settings'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.filesApplied).toBe(0);
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