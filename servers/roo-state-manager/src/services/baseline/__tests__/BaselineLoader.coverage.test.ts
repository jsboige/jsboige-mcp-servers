/**
 * BaselineLoader.coverage.test.ts — complément de couverture #833 Sprint C3
 *
 * Add-only, tests-only. Zéro modification source / test existant.
 * Cible les branches froides laissées par `BaselineLoader.test.ts` :
 *   - `readBaselineFile` catch générique → BASELINE_READ_FAILED (L142-148)
 *   - `transformBaselineForDiffDetector` format "par machine" (L170-175)
 *   - `transformBaselineForDiffDetector` catch générique → BASELINE_TRANSFORM_FAILED (L230)
 *   - arms falsy/erreur non-Baseline des gardes `instanceof`
 *
 * @module BaselineLoader.coverage.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { BaselineLoader } from '../BaselineLoader.js';
import { ConfigValidator } from '../ConfigValidator.js';
import { BaselineFileConfig } from '../../../types/baseline.js';
import { BaselineLoaderError, BaselineLoaderErrorCode } from '../../../types/errors.js';

describe('BaselineLoader — coverage complement (#833 C3)', () => {
  const testDir = join(process.cwd(), 'test-temp-baseline-cov');
  const baselineFile = join(testDir, 'baseline-cov.json');
  let loader: BaselineLoader;
  let validator: ConfigValidator;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    validator = new ConfigValidator();
    loader = new BaselineLoader(validator);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignorer les erreurs de nettoyage
    }
  });

  // --- readBaselineFile : catch générique (L137-148) --------------------------
  describe('readBaselineFile — catch générique BASELINE_READ_FAILED', () => {
    it('enveloppe une erreur non-Baseline du validator en BASELINE_READ_FAILED (L142-148)', async () => {
      // Fichier valide : existsSync=true (L104) + parse OK (L121) → on atteint la
      // validation L134. Un validator qui jette une Error générique (ni
      // BaselineLoaderError ni BaselineServiceError) fait tomber le garde L138
      // dans son arm falsy → throw BASELINE_READ_FAILED (L142-148).
      const validFile: BaselineFileConfig = {
        version: '2.1.0',
        baselineId: 'cov-read',
        timestamp: '2024-01-01T00:00:00.000Z',
        machineId: 'cov-machine',
        autoSync: true,
        conflictStrategy: 'baseline_wins',
        logLevel: 'INFO',
        sharedStatePath: testDir,
        machines: [],
        syncTargets: [],
        syncPaths: [],
        decisions: [],
        messages: []
      };
      await fs.writeFile(baselineFile, JSON.stringify(validFile), 'utf-8');

      const throwingValidator = {
        ensureValidBaselineFileConfig: vi.fn(() => {
          throw new Error('generic validator failure');
        })
      } as unknown as ConfigValidator;
      const stubLoader = new BaselineLoader(throwingValidator);

      await expect(stubLoader.readBaselineFile(baselineFile)).rejects.toThrow(BaselineLoaderError);
      await expect(stubLoader.readBaselineFile(baselineFile)).rejects.toMatchObject({
        code: BaselineLoaderErrorCode.BASELINE_READ_FAILED
      });
      expect(throwingValidator.ensureValidBaselineFileConfig).toHaveBeenCalled();
    });
  });

  // --- transformBaselineForDiffDetector : format "par machine" (L162,L170-175) -
  describe('transformBaselineForDiffDetector — format par machine', () => {
    it('lit les sources à la racine quand config.roo est présent sans machines[] (L170-175)', () => {
      // isPerMachineFormat = !machines?.length && anyFile.config?.roo  → true
      const perMachine = {
        machineId: 'pm-machine',
        version: '3.0',
        timestamp: '2024-02-02T00:00:00.000Z',
        config: {
          roo: {
            modes: ['m1', 'm2'],
            mcpServers: [{ name: 's1', enabled: true, command: 'c1', autoStart: false, transportType: 'stdio' }]
          }
        },
        hardware: { cpu: { cores: 2, threads: 4 }, memory: { total: 1024 } },
        software: { powershell: '7.4', node: 'v20', python: '3.12' },
        system: { os: 'Linux', architecture: 'arm64' }
      };

      const result = loader.transformBaselineForDiffDetector(perMachine as unknown as BaselineFileConfig);

      expect(result.machineId).toBe('pm-machine');
      expect(result.config.roo.modes).toEqual(['m1', 'm2']);
      expect(result.config.roo.mcpSettings['s1']).toBeDefined();
      expect(result.config.hardware.cpu.cores).toBe(2);
      expect(result.config.hardware.cpu.threads).toBe(4);
      expect(result.config.hardware.memory.total).toBe(1024);
      expect(result.config.software.powershell).toBe('7.4');
      expect(result.config.software.node).toBe('v20');
      expect(result.config.system.os).toBe('Linux');
      expect(result.config.system.architecture).toBe('arm64');
    });

    it('applique les fallbacks `|| {}` / `|| Unknown` en format par machine minimal (L172-175,193,218-219)', () => {
      // config.roo = {} (truthy) → format par machine ; hardware/software/system
      // absents → sources défaut `|| {}` ; machineId absent → 'unknown'.
      const perMachineMinimal = { config: { roo: {} } };

      const result = loader.transformBaselineForDiffDetector(perMachineMinimal as unknown as BaselineFileConfig);

      expect(result.machineId).toBe('unknown');
      expect(result.config.roo.modes).toEqual([]);
      expect(result.config.roo.mcpSettings).toEqual({});
      expect(result.config.hardware.cpu.cores).toBe(0);
      expect(result.config.hardware.memory.total).toBe(0);
      expect(result.config.software.powershell).toBe('Unknown');
      expect(result.config.system.os).toBe('Unknown');
      expect(result.config.system.architecture).toBe('Unknown');
    });
  });

  // --- transformBaselineForDiffDetector : format agrégé, machine sans sous-objets
  describe('transformBaselineForDiffDetector — format agrégé, sources absentes', () => {
    it('applique les fallbacks `|| {}` quand machines[0] n\'a ni roo ni hardware ni software (L186-188)', () => {
      // Format agrégé (machines[] présent) mais firstMachine sans roo/hardware/software
      // → rooSource/hardwareSource/softwareSource prennent l'arm `|| {}` droite.
      const sparse = {
        machineId: 'sparse',
        version: '2.1.0',
        timestamp: '2024-03-03T00:00:00.000Z',
        machines: [{ id: 'm-1', os: 'Darwin', architecture: 'arm64' }]
      };

      const result = loader.transformBaselineForDiffDetector(sparse as unknown as BaselineFileConfig);

      expect(result.config.roo.modes).toEqual([]);
      expect(result.config.roo.mcpSettings).toEqual({});
      expect(result.config.hardware.cpu.cores).toBe(0);
      expect(result.config.hardware.memory.total).toBe(0);
      expect(result.config.software.powershell).toBe('Unknown');
      expect(result.config.system.os).toBe('Darwin');
      expect(result.config.system.architecture).toBe('arm64');
    });
  });

  // --- loadBaseline : catch générique avec throw non-Error (L81-86, arm L85) ---
  describe('loadBaseline — catch générique BASELINE_LOAD_FAILED', () => {
    it('enveloppe un throw non-Error du validator en BASELINE_LOAD_FAILED avec cause undefined (L85)', async () => {
      const validFile: BaselineFileConfig = {
        version: '2.1.0',
        baselineId: 'cov-load',
        timestamp: '2024-01-01T00:00:00.000Z',
        machineId: 'cov-machine',
        autoSync: true,
        conflictStrategy: 'baseline_wins',
        logLevel: 'INFO',
        sharedStatePath: testDir,
        machines: [],
        syncTargets: [],
        syncPaths: [],
        decisions: [],
        messages: []
      };
      await fs.writeFile(baselineFile, JSON.stringify(validFile), 'utf-8');

      // Le validator jette une valeur non-Error (string) → dans le catch de
      // loadBaseline, le garde L68/L72 est falsy et `error instanceof Error ? error : undefined`
      // (L85) prend l'arm `: undefined`.
      const throwingValidator = {
        ensureValidBaselineFileConfig: vi.fn(() => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string boom (non-Error)';
        })
      } as unknown as ConfigValidator;
      const stubLoader = new BaselineLoader(throwingValidator);

      await expect(stubLoader.loadBaseline(baselineFile)).rejects.toMatchObject({
        code: BaselineLoaderErrorCode.BASELINE_LOAD_FAILED
      });
    });
  });

  // --- readBaselineFile : debugInfo.pathLength fallback `|| 0` (L98) -----------
  describe('readBaselineFile — chemin vide', () => {
    it('gère un chemin vide : pathLength `|| 0` (L98) puis BASELINE_NOT_FOUND', async () => {
      // '' → `''?.length || 0` = 0 (arm droit) ; existsSync('')=false → NOT_FOUND.
      await expect(loader.readBaselineFile('')).rejects.toMatchObject({
        code: BaselineLoaderErrorCode.BASELINE_NOT_FOUND
      });
    });
  });

  // --- transformBaselineForDiffDetector : catch générique (L225-236) ----------
  describe('transformBaselineForDiffDetector — catch générique BASELINE_TRANSFORM_FAILED', () => {
    it('enveloppe une TypeError interne en BASELINE_TRANSFORM_FAILED (L230)', () => {
      // mcpServers = valeur tronquée non-itérable : `42 || []` = 42 →
      // extractMcpSettings(42) → `(42).forEach` = TypeError → catch L225 →
      // arm non-BaselineLoaderError → throw BASELINE_TRANSFORM_FAILED (L230).
      const badMcp = {
        machineId: 'bad-mcp',
        version: '2.1.0',
        timestamp: '2024-01-01T00:00:00.000Z',
        machines: [
          {
            id: 'm-1',
            os: 'Windows',
            architecture: 'x64',
            roo: { modes: [], mcpServers: 42, sdddSpecs: [] },
            hardware: { cpu: { cores: 1, threads: 1 }, memory: { total: 1 } },
            software: {}
          }
        ]
      };

      expect(() => loader.transformBaselineForDiffDetector(badMcp as unknown as BaselineFileConfig)).toThrow(
        BaselineLoaderError
      );

      try {
        loader.transformBaselineForDiffDetector(badMcp as unknown as BaselineFileConfig);
        expect.unreachable('devrait avoir jeté');
      } catch (error) {
        expect(error).toBeInstanceOf(BaselineLoaderError);
        expect((error as BaselineLoaderError).code).toBe(BaselineLoaderErrorCode.BASELINE_TRANSFORM_FAILED);
      }
    });
  });
});
