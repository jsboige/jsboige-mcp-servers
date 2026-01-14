/**
 * BaselineLoader.test.ts - Tests pour le module de chargement des baselines
 *
 * Tests unitaires pour BaselineLoader, responsable de la lecture,
 * du parsing et de la transformation des fichiers de configuration baseline.
 *
 * @module BaselineLoader.test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { BaselineLoader } from '../BaselineLoader.js';
import { ConfigValidator } from '../ConfigValidator.js';
import {
  BaselineFileConfig,
  BaselineConfig,
  BaselineServiceError,
  BaselineServiceErrorCode
} from '../../../types/baseline.js';

describe('BaselineLoader', () => {
  const testDir = join(process.cwd(), 'test-temp-baseline');
  const baselineFile = join(testDir, 'baseline.json');
  const baselineFileWithBOM = join(testDir, 'baseline-with-bom.json');
  let loader: BaselineLoader;
  let validator: ConfigValidator;

  beforeEach(async () => {
    // Créer le répertoire de test
    await fs.mkdir(testDir, { recursive: true });

    // Créer une instance du validator et du loader
    validator = new ConfigValidator();
    loader = new BaselineLoader(validator);
  });

  afterEach(async () => {
    // Nettoyer les fichiers de test
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignorer les erreurs de nettoyage
    }
  });

  describe('loadBaseline', () => {
    const validBaselineFile: BaselineFileConfig = {
      version: '2.1.0',
      baselineId: 'test-baseline',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine',
      autoSync: true,
      conflictStrategy: 'baseline_wins',
      logLevel: 'INFO',
      sharedStatePath: testDir,
      machines: [
        {
          id: 'machine-1',
          name: 'Test Machine',
          hostname: 'test-host',
          os: 'Windows 11',
          architecture: 'x64',
          lastSeen: new Date().toISOString(),
          roo: {
            modes: ['mode1', 'mode2'],
            mcpServers: [
              { name: 'mcp1', enabled: true, command: 'cmd1', autoStart: true, transportType: 'stdio' },
              { name: 'mcp2', enabled: false, command: 'cmd2', autoStart: false, transportType: 'sse' }
            ],
            sdddSpecs: []
          },
          hardware: {
            cpu: { cores: 8, threads: 16 },
            memory: { total: 17179869184 }
          },
          software: {
            node: 'v18.0.0',
            python: '3.10.0'
          }
        }
      ],
      syncTargets: [],
      syncPaths: [],
      decisions: [],
      messages: []
    };

    beforeEach(async () => {
      await fs.writeFile(baselineFile, JSON.stringify(validBaselineFile, null, 2), 'utf-8');

      // Créer un fichier avec BOM UTF-8
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentWithBOM = Buffer.concat([
        bom,
        Buffer.from(JSON.stringify(validBaselineFile, null, 2), 'utf-8')
      ]);
      await fs.writeFile(baselineFileWithBOM, contentWithBOM);
    });

    it('devrait charger une baseline valide', async () => {
      const result = await loader.loadBaseline(baselineFile);

      expect(result).not.toBeNull();
      expect(result?.machineId).toBe('test-machine');
      expect(result?.version).toBe('2.1.0');
    });

    it('devrait charger une baseline avec BOM UTF-8', async () => {
      const result = await loader.loadBaseline(baselineFileWithBOM);

      expect(result).not.toBeNull();
      expect(result?.machineId).toBe('test-machine');
    });

    it('devrait retourner null si le fichier n\'existe pas', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');
      const result = await loader.loadBaseline(nonExistentFile);

      expect(result).toBeNull();
    });

    it('devrait transformer la structure BaselineFileConfig en BaselineConfig', async () => {
      const result = await loader.loadBaseline(baselineFile);

      expect(result).not.toBeNull();
      expect(result?.config).toBeDefined();
      expect(result?.config.roo).toBeDefined();
      expect(result?.config.hardware).toBeDefined();
      expect(result?.config.software).toBeDefined();
      expect(result?.config.system).toBeDefined();
    });

    it('devrait extraire les paramètres MCP', async () => {
      const result = await loader.loadBaseline(baselineFile);

      expect(result).not.toBeNull();
      expect(result?.config.roo.mcpSettings).toBeDefined();
      // Seuls les serveurs MCP avec un nom et enabled=true sont extraits
      expect(result?.config.roo.mcpSettings['mcp1']).toBeDefined();
      expect(result?.config.roo.mcpSettings['mcp1'].enabled).toBe(true);
      expect(result?.config.roo.mcpSettings['mcp1'].command).toBe('cmd1');
      expect(result?.config.roo.mcpSettings['mcp1'].autoStart).toBe(true);
      expect(result?.config.roo.mcpSettings['mcp1'].transportType).toBe('stdio');
      // mcp2 a enabled=false, donc il ne devrait pas être dans les mcpSettings
      expect(result?.config.roo.mcpSettings['mcp2']).toBeUndefined();
    });

    it('devrait utiliser des valeurs par défaut pour les champs manquants', async () => {
      const minimalBaseline: BaselineFileConfig = {
        ...validBaselineFile,
        machines: [
          {
            ...validBaselineFile.machines[0],
            roo: { modes: [], mcpServers: [], sdddSpecs: [] },
            hardware: { cpu: { cores: 0, threads: 0 }, memory: { total: 0 } },
            software: {},
            os: undefined as any,
            architecture: undefined as any
          }
        ]
      };
      await fs.writeFile(baselineFile, JSON.stringify(minimalBaseline, null, 2), 'utf-8');

      const result = await loader.loadBaseline(baselineFile);

      expect(result).not.toBeNull();
      expect(result?.config.hardware.cpu.model).toBe('Unknown CPU');
      expect(result?.config.software.powershell).toBe('Unknown');
      expect(result?.config.system.os).toBe('Unknown');
      expect(result?.config.system.architecture).toBe('Unknown');
    });

    it('devrait lancer une erreur pour du JSON invalide', async () => {
      const invalidJsonFile = join(testDir, 'invalid.json');
      await fs.writeFile(invalidJsonFile, '{invalid json}', 'utf-8');

      await expect(loader.loadBaseline(invalidJsonFile)).rejects.toThrow(BaselineServiceError);
    });

    it('devrait lancer une erreur pour une baseline invalide', async () => {
      const invalidBaseline: BaselineFileConfig = {
        ...validBaselineFile,
        version: undefined as any
      };
      await fs.writeFile(baselineFile, JSON.stringify(invalidBaseline, null, 2), 'utf-8');

      await expect(loader.loadBaseline(baselineFile)).rejects.toThrow(BaselineServiceError);
    });
  });

  describe('readBaselineFile', () => {
    const validBaselineFile: BaselineFileConfig = {
      version: '2.1.0',
      baselineId: 'test-baseline',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine',
      autoSync: true,
      conflictStrategy: 'baseline_wins',
      logLevel: 'INFO',
      sharedStatePath: testDir,
      machines: [
        {
          id: 'machine-1',
          name: 'Test Machine',
          hostname: 'test-host',
          os: 'Windows 11',
          architecture: 'x64',
          lastSeen: new Date().toISOString(),
          roo: {
            modes: ['mode1'],
            mcpServers: [],
            sdddSpecs: []
          },
          hardware: {
            cpu: { cores: 4, threads: 8 },
            memory: { total: 8589934592 }
          },
          software: {
            node: 'v16.0.0',
            python: '3.9.0'
          }
        }
      ],
      syncTargets: [],
      syncPaths: [],
      decisions: [],
      messages: []
    };

    beforeEach(async () => {
      await fs.writeFile(baselineFile, JSON.stringify(validBaselineFile, null, 2), 'utf-8');
    });

    it('devrait lire un fichier baseline valide', async () => {
      const result = await loader.readBaselineFile(baselineFile);

      expect(result).not.toBeNull();
      expect(result?.version).toBe('2.1.0');
      expect(result?.baselineId).toBe('test-baseline');
      expect(result?.machines).toHaveLength(1);
    });

    it('devrait lire un fichier avec BOM UTF-8', async () => {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentWithBOM = Buffer.concat([
        bom,
        Buffer.from(JSON.stringify(validBaselineFile, null, 2), 'utf-8')
      ]);
      await fs.writeFile(baselineFileWithBOM, contentWithBOM);

      const result = await loader.readBaselineFile(baselineFileWithBOM);

      expect(result).not.toBeNull();
      expect(result?.version).toBe('2.1.0');
    });

    it('devrait lancer une erreur si le fichier n\'existe pas', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');

      await expect(loader.readBaselineFile(nonExistentFile)).rejects.toThrow(BaselineServiceError);
    });

    it('devrait lancer une erreur avec le code BASELINE_NOT_FOUND', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');

      try {
        await loader.readBaselineFile(nonExistentFile);
        expect(true).toBe(false); // Ne devrait pas arriver ici
      } catch (error) {
        expect(error).toBeInstanceOf(BaselineServiceError);
        expect((error as BaselineServiceError).code).toBe(BaselineServiceErrorCode.BASELINE_NOT_FOUND);
      }
    });

    it('devrait lancer une erreur pour du JSON invalide', async () => {
      const invalidJsonFile = join(testDir, 'invalid.json');
      await fs.writeFile(invalidJsonFile, '{invalid json}', 'utf-8');

      await expect(loader.readBaselineFile(invalidJsonFile)).rejects.toThrow(BaselineServiceError);
    });

    it('devrait lancer une erreur avec le code BASELINE_INVALID pour du JSON invalide', async () => {
      const invalidJsonFile = join(testDir, 'invalid.json');
      await fs.writeFile(invalidJsonFile, '{invalid json}', 'utf-8');

      try {
        await loader.readBaselineFile(invalidJsonFile);
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(BaselineServiceError);
        expect((error as BaselineServiceError).code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
      }
    });

    it('devrait lancer une erreur pour une baseline invalide', async () => {
      // Créer un fichier JSON invalide (machineId est null)
      const invalidBaseline = {
        ...validBaselineFile,
        machineId: null
      };
      await fs.writeFile(baselineFile, JSON.stringify(invalidBaseline, null, 2), 'utf-8');

      await expect(loader.readBaselineFile(baselineFile)).rejects.toThrow(BaselineServiceError);
    });
  });

  describe('transformBaselineForDiffDetector', () => {
    const baselineFile: BaselineFileConfig = {
      version: '2.1.0',
      baselineId: 'test-baseline',
      timestamp: '2024-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      autoSync: true,
      conflictStrategy: 'baseline_wins',
      logLevel: 'INFO',
      sharedStatePath: testDir,
      machines: [
        {
          id: 'machine-1',
          name: 'Test Machine',
          hostname: 'test-host',
          os: 'Windows 11',
          architecture: 'x64',
          lastSeen: '2024-01-01T00:00:00.000Z',
          roo: {
            modes: ['mode1', 'mode2', 'mode3'],
            mcpServers: [
              {
                name: 'mcp1',
                enabled: true,
                command: 'npx mcp-server',
                autoStart: true,
                transportType: 'stdio',
                alwaysAllow: ['tool1', 'tool2'],
                description: 'Test MCP server'
              },
              {
                name: 'mcp2',
                enabled: false,
                command: 'npx another-server',
                autoStart: false,
                transportType: 'sse'
              }
            ],
            sdddSpecs: []
          },
          hardware: {
            cpu: { cores: 8, threads: 16 },
            memory: { total: 17179869184 }
          },
          software: {
            node: 'v18.0.0',
            python: '3.10.0'
          }
        }
      ],
      syncTargets: [],
      syncPaths: [],
      decisions: [],
      messages: []
    };

    it('devrait transformer BaselineFileConfig en BaselineConfig', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result).toBeDefined();
      expect(result.machineId).toBe('test-machine');
      expect(result.version).toBe('2.1.0');
      expect(result.lastUpdated).toBe('2024-01-01T00:00:00.000Z');
    });

    it('devrait extraire les modes depuis la première machine', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result.config.roo.modes).toEqual(['mode1', 'mode2', 'mode3']);
    });

    it('devrait extraire et transformer les paramètres MCP', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result.config.roo.mcpSettings).toBeDefined();
      // Seuls les serveurs MCP avec enabled=true sont extraits
      expect(result.config.roo.mcpSettings['mcp1']).toEqual({
        enabled: true,
        command: 'npx mcp-server',
        autoStart: true,
        transportType: 'stdio',
        alwaysAllow: ['tool1', 'tool2'],
        description: 'Test MCP server'
      });
      // mcp2 a enabled=false, donc il ne devrait pas être dans les mcpSettings
      expect(result.config.roo.mcpSettings['mcp2']).toBeUndefined();
    });

    it('devrait ignorer les serveurs MCP sans nom', () => {
      const baselineWithoutName: BaselineFileConfig = {
        ...baselineFile,
        machines: [
          {
            ...baselineFile.machines[0],
            roo: {
              ...baselineFile.machines[0].roo,
              mcpServers: [
                { enabled: true, command: 'cmd' } as any
              ]
            }
          }
        ]
      };

      const result = loader.transformBaselineForDiffDetector(baselineWithoutName);

      expect(Object.keys(result.config.roo.mcpSettings)).toHaveLength(0);
    });

    it('devrait utiliser des valeurs par défaut pour le hardware', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result.config.hardware.cpu.model).toBe('Unknown CPU');
      expect(result.config.hardware.cpu.cores).toBe(8);
      expect(result.config.hardware.cpu.threads).toBe(16);
      expect(result.config.hardware.memory.total).toBe(17179869184);
      expect(result.config.hardware.disks).toEqual([]);
      expect(result.config.hardware.gpu).toBe('Unknown');
    });

    it('devrait utiliser des valeurs par défaut pour le software', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result.config.software.powershell).toBe('Unknown');
      expect(result.config.software.node).toBe('v18.0.0');
      expect(result.config.software.python).toBe('3.10.0');
    });

    it('devrait utiliser des valeurs par défaut pour le system', () => {
      const result = loader.transformBaselineForDiffDetector(baselineFile);

      expect(result.config.system.os).toBe('Windows 11');
      expect(result.config.system.architecture).toBe('x64');
    });

    it('devrait gérer une baseline sans machines', () => {
      const baselineWithoutMachines: BaselineFileConfig = {
        ...baselineFile,
        machines: []
      };

      const result = loader.transformBaselineForDiffDetector(baselineWithoutMachines);

      expect(result.config.roo.modes).toEqual([]);
      expect(result.config.roo.mcpSettings).toEqual({});
      expect(result.config.hardware.cpu.cores).toBe(0);
      expect(result.config.hardware.cpu.threads).toBe(0);
      expect(result.config.hardware.memory.total).toBe(0);
      expect(result.config.software.node).toBe('Unknown');
      expect(result.config.software.python).toBe('Unknown');
    });

    it('devrait utiliser le timestamp si lastUpdated n\'est pas défini', () => {
      const baselineWithoutLastUpdated: BaselineFileConfig = {
        ...baselineFile,
        lastUpdated: undefined
      };

      const result = loader.transformBaselineForDiffDetector(baselineWithoutLastUpdated);

      expect(result.lastUpdated).toBe('2024-01-01T00:00:00.000Z');
    });

    it('devrait utiliser la version par défaut si non définie', () => {
      const baselineWithoutVersion: BaselineFileConfig = {
        ...baselineFile,
        version: undefined as any
      };

      const result = loader.transformBaselineForDiffDetector(baselineWithoutVersion);

      expect(result.version).toBe('2.1');
    });

    it('devrait utiliser le machineId par défaut si non défini', () => {
      const baselineWithoutMachineId: BaselineFileConfig = {
        ...baselineFile,
        machineId: undefined as any
      };

      const result = loader.transformBaselineForDiffDetector(baselineWithoutMachineId);

      expect(result.machineId).toBe('unknown');
    });
  });

  describe('Cas d\'intégration', () => {
    it('devrait gérer un cycle complet de chargement et transformation', async () => {
      const completeBaseline: BaselineFileConfig = {
        version: '2.1.0',
        baselineId: 'integration-test',
        timestamp: new Date().toISOString(),
        machineId: 'integration-machine',
        autoSync: false,
        conflictStrategy: 'target_wins',
        logLevel: 'DEBUG',
        sharedStatePath: testDir,
        machines: [
          {
            id: 'machine-1',
            name: 'Integration Test Machine',
            hostname: 'integration-host',
            os: 'Linux',
            architecture: 'arm64',
            lastSeen: new Date().toISOString(),
            roo: {
              modes: ['dev', 'prod'],
              mcpServers: [
                {
                  name: 'test-mcp',
                  enabled: true,
                  command: 'node server.js',
                  autoStart: true,
                  transportType: 'stdio',
                  alwaysAllow: ['*'],
                  description: 'Test MCP for integration'
                }
              ],
              sdddSpecs: []
            },
            hardware: {
              cpu: { cores: 4, threads: 8 },
              memory: { total: 8589934592 }
            },
            software: {
              node: 'v20.0.0',
              python: '3.11.0'
            }
          }
        ],
        syncTargets: [],
        syncPaths: [],
        decisions: [],
        messages: []
      };

      await fs.writeFile(baselineFile, JSON.stringify(completeBaseline, null, 2), 'utf-8');

      // Charger la baseline
      const loadedBaseline = await loader.loadBaseline(baselineFile);

      expect(loadedBaseline).not.toBeNull();
      expect(loadedBaseline?.machineId).toBe('integration-machine');
      expect(loadedBaseline?.config.roo.modes).toEqual(['dev', 'prod']);
      expect(loadedBaseline?.config.roo.mcpSettings['test-mcp']).toBeDefined();
      expect(loadedBaseline?.config.roo.mcpSettings['test-mcp'].enabled).toBe(true);
      expect(loadedBaseline?.config.software.node).toBe('v20.0.0');
      expect(loadedBaseline?.config.software.python).toBe('3.11.0');
    });

    it('devrait gérer des baselines avec plusieurs machines', async () => {
      const multiMachineBaseline: BaselineFileConfig = {
        version: '2.1.0',
        baselineId: 'multi-machine-test',
        timestamp: new Date().toISOString(),
        machineId: 'primary-machine',
        autoSync: true,
        conflictStrategy: 'baseline_wins',
        logLevel: 'INFO',
        sharedStatePath: testDir,
        machines: [
          {
            id: 'machine-1',
            name: 'Machine 1',
            hostname: 'host1',
            os: 'Windows',
            architecture: 'x64',
            lastSeen: new Date().toISOString(),
            roo: {
              modes: ['mode1'],
              mcpServers: [],
              sdddSpecs: []
            },
            hardware: {
              cpu: { cores: 8, threads: 16 },
              memory: { total: 17179869184 }
            },
            software: {
              node: 'v18.0.0',
              python: '3.10.0'
            }
          },
          {
            id: 'machine-2',
            name: 'Machine 2',
            hostname: 'host2',
            os: 'Linux',
            architecture: 'arm64',
            lastSeen: new Date().toISOString(),
            roo: {
              modes: ['mode2'],
              mcpServers: [],
              sdddSpecs: []
            },
            hardware: {
              cpu: { cores: 4, threads: 8 },
              memory: { total: 8589934592 }
            },
            software: {
              node: 'v16.0.0',
              python: '3.9.0'
            }
          }
        ],
        syncTargets: [],
        syncPaths: [],
        decisions: [],
        messages: []
      };

      await fs.writeFile(baselineFile, JSON.stringify(multiMachineBaseline, null, 2), 'utf-8');

      const loadedBaseline = await loader.loadBaseline(baselineFile);

      // La transformation utilise seulement la première machine
      expect(loadedBaseline).not.toBeNull();
      expect(loadedBaseline?.config.roo.modes).toEqual(['mode1']);
      expect(loadedBaseline?.config.software.node).toBe('v18.0.0');
    });
  });
});
