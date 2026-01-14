/**
 * Tests pour DiffDetector - Service de détection des différences
 * 
 * Tests unitaires pour valider le fonctionnement du mécanisme de comparaison
 * baseline-driven de RooSync v2.1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiffDetector } from '../../../src/services/DiffDetector.js';
import { BaselineConfig, MachineInventory } from '../../../src/types/baseline.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('DiffDetector', () => {
  let diffDetector: DiffDetector;
  const testDir = join(__dirname, '../../fixtures/diff-detector-test');

  // Données de test
  const baselineConfig: BaselineConfig = {
    machineId: 'baseline-machine',
    version: '2.1.0',
    lastUpdated: '2025-11-02T17:41:00.000Z',
    config: {
      roo: {
        paths: {
          rooConfig: '/baseline/roo-config',
          mcpSettings: '/baseline/mcp-settings'
        },
        modes: ['code', 'debug', 'architect'],
        mcpSettings: {
          'jupyter-mcp': { enabled: true, autoStart: true },
          'quickfiles': { enabled: true, autoStart: true },
          'searxng': { enabled: false, autoStart: false } // Différence avec machineInventory
        },
        userSettings: {
          theme: 'dark',
          autoSave: true
        }
      },
      hardware: {
        cpu: {
          model: 'Intel i7-11800H',
          cores: 8,
          threads: 16
        } as any,
        memory: {
          total: 34359738368 // 32GB en bytes
        } as any,
        disks: [{ name: 'C:', size: '930GB' }],
        gpu: 'NVIDIA RTX 3070'
      },
      software: {
        powershell: '7.5.3',
        node: '24.6.0',
        python: '3.13.7'
      },
      system: {
        os: 'Windows 11',
        architecture: 'x64'
      }
    }
  };

  const machineInventory: MachineInventory = {
    machineId: 'target-machine',
    timestamp: '2025-11-02T17:41:00.000Z',
    config: {
      roo: {
        modes: ['code', 'debug', 'architect'],
        mcpSettings: {
          'jupyter-mcp': { enabled: true, autoStart: true },
          'quickfiles': { enabled: true, autoStart: true },
          'searxng': { enabled: true, autoStart: true } // Différence : true au lieu de false
        },
        userSettings: {
          theme: 'light', // Différence
          autoSave: true
        }
      },
      hardware: {
        cpu: { // Structure imbriquée pour correspondre au code
          model: 'Intel i7-12700H', // Différence
          cores: 16,
          threads: 32
        } as any,
        memory: { // Structure imbriquée pour correspondre au code
          total: 68719476736 // 64GB en bytes
        } as any,
        disks: [{ name: 'C:', size: '930GB' }],
        gpu: 'NVIDIA RTX 4070' // Différence
      },
      software: {
        powershell: '7.5.3',
        node: '24.6.0',
        python: '3.13.7'
      },
      system: {
        os: 'Windows 11',
        architecture: 'x64'
      }
    },
    metadata: {
      collectionDuration: 1500,
      source: 'local',
      collectorVersion: '2.1.0'
    }
  };

  beforeEach(() => {
    // Créer le répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }
    
    diffDetector = new DiffDetector();
  });

  afterEach(() => {
    // Nettoyer
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
  });

  describe('compareBaselineWithMachine', () => {
    it('devrait détecter les différences de configuration Roo', async () => {
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, machineInventory);
      
      // Vérifier les différences Roo
      const rooDiffs = differences.filter(diff => diff.category === 'config');
      
      expect(rooDiffs.length).toBeGreaterThan(0);
      
      // Vérifier la détection de MCP supplémentaire
      const mcpDiff = rooDiffs.find(diff => diff.path.includes('searxng'));
      expect(mcpDiff).toBeDefined();
      expect(mcpDiff?.severity).toBe('IMPORTANT');
      expect(mcpDiff?.description).toContain('searxng');
      
      // Vérifier la détection de thème différent
      const themeDiff = rooDiffs.find(diff => diff.path === 'roo.userSettings.theme');
      expect(themeDiff).toBeDefined();
      expect(themeDiff?.severity).toBe('IMPORTANT');
    });

    it('devrait détecter les différences matérielles', async () => {
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, machineInventory);
      
      // Vérifier les différences matérielles
      const hardwareDiffs = differences.filter(diff => diff.category === 'hardware');
      
      expect(hardwareDiffs.length).toBeGreaterThan(0);
      
      // Vérifier la détection CPU
      const cpuDiff = hardwareDiffs.find(diff => diff.path.includes('cpu'));
      expect(cpuDiff).toBeDefined();
      expect(cpuDiff?.severity).toBe('IMPORTANT');
      
      // Vérifier la détection RAM
      const ramDiff = hardwareDiffs.find(diff => diff.path.includes('memory'));
      expect(ramDiff).toBeDefined();
      expect(ramDiff?.severity).toBe('IMPORTANT');
      
      // Vérifier la détection GPU
      const gpuDiff = hardwareDiffs.find(diff => diff.path.includes('gpu'));
      expect(gpuDiff).toBeDefined();
      expect(gpuDiff?.severity).toBe('INFO');
    });

    it('devrait retourner un tableau vide si aucune différence', async () => {
      // Créer une machine identique à la baseline
      const identicalMachine: MachineInventory = {
        ...machineInventory,
        config: JSON.parse(JSON.stringify(baselineConfig.config))
      };
      
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, identicalMachine);
      
      expect(differences).toHaveLength(0);
    });

    it('devrait gérer les erreurs de comparaison', async () => {
      // Tester avec des données invalides
      const invalidMachine = {
        machineId: 'invalid',
        timestamp: 'invalid-date',
        config: null as any
      } as MachineInventory;
      
      await expect(diffDetector.compareBaselineWithMachine(baselineConfig, invalidMachine))
        .rejects.toThrow();
    });
  });

  describe('compareInventories', () => {
    it('devrait générer un rapport de comparaison complet', async () => {
      const report = await diffDetector.compareInventories(machineInventory, baselineConfig as any);
      
      // Vérifier la structure du rapport
      expect(report).toHaveProperty('reportId');
      expect(report).toHaveProperty('sourceMachine');
      expect(report).toHaveProperty('targetMachine');
      expect(report).toHaveProperty('differences');
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('metadata');
      
      // Vérifier les métadonnées
      expect(report.metadata).toHaveProperty('comparisonTimestamp');
      expect(report.metadata).toHaveProperty('executionTime');
      expect(report.metadata).toHaveProperty('version');
      
      // Vérifier le résumé
      expect(report.summary).toHaveProperty('total');
      expect(report.summary).toHaveProperty('bySeverity');
      expect(report.summary).toHaveProperty('byCategory');
      
      expect(report.differences.length).toBeGreaterThan(0);
      expect(report.summary.total).toBe(report.differences.length);
    });

    it('devrait calculer correctement le résumé des différences', async () => {
      const report = await diffDetector.compareInventories(machineInventory, baselineConfig as any);
      
      // Vérifier le comptage par sévérité
      expect(report.summary.bySeverity.CRITICAL).toBeGreaterThanOrEqual(0);
      expect(report.summary.bySeverity.IMPORTANT).toBeGreaterThan(0);
      expect(report.summary.bySeverity.WARNING).toBeGreaterThanOrEqual(0);
      expect(report.summary.bySeverity.INFO).toBeGreaterThanOrEqual(0);
      
      // Vérifier le comptage par catégorie
      expect(report.summary.byCategory.roo_config).toBeGreaterThan(0);
      expect(report.summary.byCategory.hardware).toBeGreaterThan(0);
      expect(report.summary.byCategory.software).toBeGreaterThanOrEqual(0);
      expect(report.summary.byCategory.system).toBeGreaterThanOrEqual(0);
      
      // Vérifier la cohérence du total
      const totalBySeverity = Object.values(report.summary.bySeverity).reduce((sum, count) => sum + count, 0);
      const totalByCategory = Object.values(report.summary.byCategory).reduce((sum, count) => sum + count, 0);
      
      expect(totalBySeverity).toBe(report.summary.total);
      expect(totalByCategory).toBe(report.summary.total);
    });

    it('devrait mapper correctement les catégories', async () => {
      const report = await diffDetector.compareInventories(machineInventory, baselineConfig as any);
      
      // Vérifier que toutes les différences ont une catégorie valide
      const validCategories = ['roo_config', 'hardware', 'software', 'system'];
      
      for (const diff of report.differences) {
        expect(validCategories).toContain(diff.category);
      }
    });

    it('devrait générer un ID de rapport unique', async () => {
      const report1 = await diffDetector.compareInventories(machineInventory, baselineConfig as any);
      const report2 = await diffDetector.compareInventories(machineInventory, baselineConfig as any);
      
      expect(report1.reportId).not.toBe(report2.reportId);
      expect(report1.reportId).toMatch(/^comp-\d+-[a-z0-9]+$/);
    });
  });

  describe('détermination de sévérité', () => {
    it('devrait classifier les différences système comme CRITICAL', async () => {
      const systemDiffMachine: MachineInventory = {
        ...machineInventory,
        config: {
          ...machineInventory.config,
          system: {
            os: 'Linux', // Différence critique
            architecture: 'x64'
          }
        }
      };
      
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, systemDiffMachine);
      const systemDiffs = differences.filter(diff => diff.category === 'system');
      
      expect(systemDiffs.length).toBeGreaterThan(0);
      expect(systemDiffs.every(diff => diff.severity === 'CRITICAL')).toBe(true);
    });

    it('devrait classifier les différences config comme CRITICAL', async () => {
      const configDiffMachine: MachineInventory = {
        ...machineInventory,
        config: {
          ...machineInventory.config,
          roo: {
            ...machineInventory.config.roo,
            modes: [] // Différence critique
          }
        }
      };
      
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, configDiffMachine);
      const configDiffs = differences.filter(diff => diff.category === 'config');
      
      expect(configDiffs.length).toBeGreaterThan(0);
      // Vérifier qu'il y a au moins une différence CRITICAL (paths)
      const criticalDiffs = configDiffs.filter(diff => diff.severity === 'CRITICAL');
      expect(criticalDiffs.length).toBeGreaterThan(0);
    });

    it('devrait classifier les différences matérielles selon les seuils', async () => {
      // Test avec différence CPU > 30%
      const highCpuDiffMachine: MachineInventory = {
        ...machineInventory,
        config: {
          ...machineInventory.config,
          hardware: {
            ...machineInventory.config.hardware,
            cpu: {
              model: 'Intel i3-10100', // Beaucoup moins performant
              cores: 4,
              threads: 8
            }
          }
        }
      };
      
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, highCpuDiffMachine);
      const cpuDiffs = differences.filter(diff => diff.path.includes('cpu'));
      
      expect(cpuDiffs.length).toBeGreaterThan(0);
      expect(cpuDiffs.some(diff => diff.severity === 'IMPORTANT')).toBe(true);
    });
  });

  describe('gestion des erreurs', () => {
    it('devrait logger les erreurs de comparaison', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const invalidMachine = {
        machineId: 'invalid',
        timestamp: 'invalid',
        config: null as any
      } as MachineInventory;
      
      // Le test doit s'attendre à ce que l'erreur soit logger ET relancée
      await expect(diffDetector.compareBaselineWithMachine(baselineConfig, invalidMachine)).rejects.toThrow('Machine config est null/undefined');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ERROR] [DiffDetector] Erreur lors de la comparaison baseline/machine')
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('intégration avec les données réelles', () => {
    it('devrait fonctionner avec la structure de données d\'inventaire', async () => {
      // Tester avec la structure réelle générée par Get-MachineInventory.ps1
      const realInventoryStructure: MachineInventory = {
        machineId: 'test-machine',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code', 'debug'],
            mcpSettings: {},
            userSettings: {}
          },
          hardware: {
            cpu: {
              model: 'Test CPU',
              cores: 4,
              threads: 8
            },
            memory: {
              total: 17179869184 // 16GB en bytes
            },
            disks: [{ name: 'C:', size: '500GB' }],
            gpu: 'Test GPU'
          },
          software: {
            powershell: '7.5.0',
            node: '20.0.0',
            python: '3.10.0'
          },
          system: {
            os: 'Windows 10',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1000,
          source: 'local',
          collectorVersion: '2.1.0'
        }
      };
      
      const differences = await diffDetector.compareBaselineWithMachine(baselineConfig, realInventoryStructure);
      
      expect(Array.isArray(differences)).toBe(true);
      expect(differences.length).toBeGreaterThan(0);
      
      // Vérifier que chaque différence a la structure requise
      for (const diff of differences) {
        expect(diff).toHaveProperty('category');
        expect(diff).toHaveProperty('severity');
        expect(diff).toHaveProperty('path');
        expect(diff).toHaveProperty('description');
        expect(diff).toHaveProperty('baselineValue');
        expect(diff).toHaveProperty('actualValue');
        expect(diff).toHaveProperty('recommendedAction');
      }
    });
  });
});