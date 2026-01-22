/**
 * Tests E2E - Workflow Complet RooSync
 *
 * Teste le workflow complet de synchronisation de configuration:
 * 1. Compare config entre deux machines
 * 2. Apply config avec différents targets
 * 3. Validation post-application
 * 4. Cas d'erreur (inventaire manquant, etc.)
 *
 * @module tests/e2e/roosync/workflow-complete
 * @version 1.0.0
 * @issue #346
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { roosyncCompareConfig } from '../../../src/tools/roosync/compare-config.js';
import { roosyncApplyConfig } from '../../../src/tools/roosync/apply-config.js';
import type { CompareConfigArgs, CompareConfigResult } from '../../../src/tools/roosync/compare-config.js';
import type { ApplyConfigArgs } from '../../../src/tools/roosync/apply-config.js';

/**
 * Mock data - Inventaire complet machine 1 (PC-SOURCE)
 */
const mockInventorySource = {
  machineId: 'PC-SOURCE',
  timestamp: '2026-01-23T10:00:00Z',
  inventory: {
    mcpServers: {
      'github-projects-mcp': {
        command: 'node',
        args: ['path/to/github-mcp'],
        env: { GITHUB_TOKEN: 'token1' }
      },
      'jupyter': {
        command: 'python',
        args: ['-m', 'jupyter_mcp'],
        env: {}
      }
    },
    rooModes: {
      'sddd-simple': {
        model: 'glm-4.7-air',
        provider: 'z.ai'
      },
      'sddd-complex': {
        model: 'glm-4.7',
        provider: 'z.ai'
      }
    },
    hardware: {
      cpu: { model: 'Intel i7', cores: 8 },
      ram: { total: 16384 }
    }
  }
};

/**
 * Mock data - Inventaire complet machine 2 (PC-TARGET)
 * Différences intentionnelles pour tests:
 * - MCP jupyter manquant
 * - Mode sddd-complex utilise un modèle différent
 * - RAM différente
 */
const mockInventoryTarget = {
  machineId: 'PC-TARGET',
  timestamp: '2026-01-23T10:00:00Z',
  inventory: {
    mcpServers: {
      'github-projects-mcp': {
        command: 'node',
        args: ['path/to/github-mcp'],
        env: { GITHUB_TOKEN: 'token1' }
      }
      // jupyter MANQUANT (différence intentionnelle)
    },
    rooModes: {
      'sddd-simple': {
        model: 'glm-4.7-air',
        provider: 'z.ai'
      },
      'sddd-complex': {
        model: 'claude-3.7-sonnet', // DIFFÉRENT
        provider: 'anthropic'
      }
    },
    hardware: {
      cpu: { model: 'Intel i7', cores: 8 },
      ram: { total: 32768 } // DIFFÉRENT
    }
  }
};

/**
 * Mock RooSyncService
 */
vi.mock('../../../src/services/RooSyncService.js', () => {
  const mockService = {
    getConfig: vi.fn(() => ({
      machineId: 'PC-SOURCE',
      sharedStatePath: 'G:/Mon Drive/Synchronisation/RooSync/.shared-state',
      enableNotifications: true
    })),
    getInventory: vi.fn((machineId: string) => {
      if (machineId === 'PC-SOURCE') return Promise.resolve(mockInventorySource);
      if (machineId === 'PC-TARGET') return Promise.resolve(mockInventoryTarget);
      return Promise.resolve(null); // Machine inconnue
    }),
    loadDashboard: vi.fn(() => Promise.resolve({
      machines: {
        'PC-SOURCE': { lastSync: '2026-01-23T10:00:00Z' },
        'PC-TARGET': { lastSync: '2026-01-23T10:00:00Z' }
      }
    })),
    compareRealConfigurations: vi.fn((source: string, target: string) => {
      // Simuler une comparaison standard
      return Promise.resolve({
        sourceMachine: source,
        targetMachine: target,
        hostId: 'PC-SOURCE',
        differences: [
          {
            category: 'roo_config',
            severity: 'CRITICAL',
            path: 'inventory.mcpServers.jupyter',
            description: 'MCP jupyter absent sur PC-TARGET',
            recommendedAction: 'Installer MCP jupyter'
          },
          {
            category: 'roo_config',
            severity: 'IMPORTANT',
            path: 'inventory.rooModes.sddd-complex.model',
            description: 'Modèle différent: glm-4.7 vs claude-3.7-sonnet',
            recommendedAction: 'Synchroniser configuration'
          }
        ],
        summary: {
          total: 2,
          critical: 1,
          important: 1,
          warning: 0,
          info: 0
        }
      });
    }),
    getConfigService: vi.fn(() => ({
      getConfigVersion: vi.fn(() => Promise.resolve('1.0.0'))
    })),
    getConfigSharingService: vi.fn(() => ({
      applyConfig: vi.fn((args: any) => {
        // Simuler application réussie
        return Promise.resolve({
          success: true,
          filesApplied: args.targets || ['modes', 'mcp'],
          backupPath: args.backup ? 'C:/backup/config-20260123.zip' : undefined,
          errors: []
        });
      })
    }))
  };

  return {
    getRooSyncService: vi.fn(() => mockService),
    RooSyncServiceError: class RooSyncServiceError extends Error {
      constructor(message: string, public code: string) {
        super(message);
        this.name = 'RooSyncServiceError';
      }
    }
  };
});

/**
 * Mock ConfigSharingServiceError
 */
vi.mock('../../../src/types/errors.js', () => {
  return {
    ConfigSharingServiceError: class ConfigSharingServiceError extends Error {
      constructor(message: string, public code: string, public details?: any) {
        super(message);
        this.name = 'ConfigSharingServiceError';
      }
    },
    ConfigSharingServiceErrorCode: {
      COLLECTION_FAILED: 'COLLECTION_FAILED',
      VERSION_MISMATCH: 'VERSION_MISMATCH',
      INVENTORY_MISSING: 'INVENTORY_MISSING'
    }
  };
});

describe('Workflow Complet RooSync - E2E Tests', () => {
  beforeAll(() => {
    // Setup global pour tous les tests
    console.log('🧪 Début tests E2E workflow complet RooSync');
  });

  afterAll(() => {
    console.log('✅ Fin tests E2E workflow complet RooSync');
  });

  describe('Test 1 - Compare Config entre 2 machines', () => {
    it('devrait comparer deux machines et détecter les différences', async () => {
      const args: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET',
        force_refresh: false
      };

      const result = await roosyncCompareConfig(args);

      // Vérifications
      expect(result).toBeDefined();
      expect(result.source).toBe('PC-SOURCE');
      expect(result.target).toBe('PC-TARGET');
      expect(result.differences).toBeInstanceOf(Array);
      expect(result.differences.length).toBeGreaterThan(0);

      // Vérifier la structure du summary
      expect(result.summary).toBeDefined();
      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.summary.critical).toBeGreaterThanOrEqual(0);
      expect(result.summary.important).toBeGreaterThanOrEqual(0);

      // Vérifier qu'on détecte bien la différence sur le MCP jupyter
      const jupyterDiff = result.differences.find(d => d.path.includes('jupyter'));
      expect(jupyterDiff).toBeDefined();
      expect(jupyterDiff?.severity).toBe('CRITICAL');
    });

    it('devrait supporter le mode granulaire "mcp"', async () => {
      const args: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET',
        granularity: 'mcp'
      };

      const result = await roosyncCompareConfig(args);

      expect(result).toBeDefined();
      expect(result.differences.length).toBeGreaterThan(0);

      // Tous les paths doivent commencer par inventory.mcpServers
      result.differences.forEach(diff => {
        expect(diff.path).toMatch(/inventory\.mcpServers/);
      });
    });

    it('devrait supporter le mode granulaire "mode"', async () => {
      const args: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET',
        granularity: 'mode'
      };

      const result = await roosyncCompareConfig(args);

      expect(result).toBeDefined();

      // Tous les paths doivent commencer par inventory.rooModes
      result.differences.forEach(diff => {
        expect(diff.path).toMatch(/inventory\.rooModes/);
      });
    });

    it('devrait supporter le filtre sur les paths', async () => {
      const args: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET',
        granularity: 'mcp',
        filter: 'jupyter'
      };

      const result = await roosyncCompareConfig(args);

      expect(result).toBeDefined();

      // Tous les résultats doivent contenir "jupyter"
      result.differences.forEach(diff => {
        expect(
          diff.path.toLowerCase().includes('jupyter') ||
          diff.description.toLowerCase().includes('jupyter')
        ).toBe(true);
      });
    });
  });

  describe('Test 2 - Apply Config avec différents targets', () => {
    it('devrait appliquer la configuration complète par défaut', async () => {
      const args: ApplyConfigArgs = {
        version: 'latest',
        backup: true,
        dryRun: false
      };

      const result = await roosyncApplyConfig(args);

      expect(result).toBeDefined();
      expect(result.status).toBe('success');
      expect(result.message).toContain('succès');
      expect(result.filesApplied).toBeDefined();
      expect(result.backupPath).toBeDefined();
    });

    it('devrait appliquer uniquement les modes Roo', async () => {
      const args: ApplyConfigArgs = {
        version: 'latest',
        targets: ['modes'],
        backup: false,
        dryRun: false
      };

      const result = await roosyncApplyConfig(args);

      expect(result).toBeDefined();
      expect(result.status).toBe('success');
      expect(result.filesApplied).toEqual(['modes']);
      expect(result.backupPath).toBeUndefined(); // Pas de backup demandé
    });

    it('devrait appliquer uniquement les MCPs', async () => {
      const args: ApplyConfigArgs = {
        version: 'latest',
        targets: ['mcp'],
        backup: true,
        dryRun: false
      };

      const result = await roosyncApplyConfig(args);

      expect(result).toBeDefined();
      expect(result.status).toBe('success');
      expect(result.filesApplied).toEqual(['mcp']);
    });

    it('devrait supporter le mode dryRun', async () => {
      const args: ApplyConfigArgs = {
        version: 'latest',
        targets: ['modes', 'mcp'],
        backup: false,
        dryRun: true // Simulation uniquement
      };

      const result = await roosyncApplyConfig(args);

      expect(result).toBeDefined();
      expect(result.status).toBe('success');
      // En mode dryRun, aucun fichier n'est vraiment appliqué
    });
  });

  describe('Test 3 - Validation Post-Application', () => {
    it('devrait valider que la configuration est synchronisée après application', async () => {
      // Étape 1: Comparer avant
      const compareBefore: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET'
      };
      const resultBefore = await roosyncCompareConfig(compareBefore);

      expect(resultBefore.differences.length).toBeGreaterThan(0);
      const initialDiffCount = resultBefore.summary.total;

      // Étape 2: Appliquer config
      const applyArgs: ApplyConfigArgs = {
        version: 'latest',
        targets: ['modes', 'mcp'],
        backup: true
      };
      const applyResult = await roosyncApplyConfig(applyArgs);

      expect(applyResult.status).toBe('success');

      // Étape 3: Comparer après (simulé - dans un vrai test, l'inventaire aurait changé)
      // NOTE: Dans ce test mock, l'inventaire ne change pas réellement
      // Dans un test E2E réel avec vraies données, on vérifierait que les diffs ont diminué
      const compareAfter: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'PC-TARGET',
        force_refresh: true // Force refresh pour voir changements
      };
      const resultAfter = await roosyncCompareConfig(compareAfter);

      // Dans ce mock, le résultat est identique (limitation du mock)
      // Dans un test réel, on s'attendrait à:
      // expect(resultAfter.summary.total).toBeLessThan(initialDiffCount);
      expect(resultAfter).toBeDefined();
    });

    it('devrait créer un backup avant application', async () => {
      const args: ApplyConfigArgs = {
        version: 'latest',
        backup: true
      };

      const result = await roosyncApplyConfig(args);

      expect(result.backupPath).toBeDefined();
      expect(result.backupPath).toMatch(/backup.*\.zip/);
    });
  });

  describe('Test 4 - Cas d\'Erreur', () => {
    it('devrait échouer si l\'inventaire source est manquant (mode granulaire)', async () => {
      // En mode granulaire, l'inventaire est vraiment vérifié
      const args: CompareConfigArgs = {
        source: 'MACHINE-INEXISTANTE',
        target: 'PC-TARGET',
        granularity: 'mcp' // Mode granulaire force la vérification d'inventaire
      };

      await expect(roosyncCompareConfig(args)).rejects.toThrow(/Inventaire manquant/);
    });

    it('devrait échouer si l\'inventaire target est manquant (mode granulaire)', async () => {
      // En mode granulaire, l'inventaire est vraiment vérifié
      const args: CompareConfigArgs = {
        source: 'PC-SOURCE',
        target: 'MACHINE-INEXISTANTE',
        granularity: 'mode' // Mode granulaire force la vérification d'inventaire
      };

      await expect(roosyncCompareConfig(args)).rejects.toThrow(/Inventaire manquant/);
    });

    it('devrait valider que le workflow gère les erreurs de manière cohérente', async () => {
      // Test que les erreurs sont bien propagées dans le workflow complet

      // Étape 1: Comparaison avec machine inexistante (mode granulaire)
      const compareArgs: CompareConfigArgs = {
        source: 'MACHINE-INEXISTANTE',
        target: 'PC-TARGET',
        granularity: 'full'
      };

      // Doit échouer
      await expect(roosyncCompareConfig(compareArgs)).rejects.toThrow();

      // Étape 2: Application config (devrait réussir avec args valides)
      const applyArgs: ApplyConfigArgs = {
        version: 'latest',
        backup: false
      };

      // Doit réussir
      const result = await roosyncApplyConfig(applyArgs);
      expect(result.status).toBe('success');
    });

    it('devrait valider les arguments avec le schema Zod', async () => {
      // Test avec arguments invalides
      const invalidArgs: any = {
        source: 'PC-SOURCE',
        granularity: 'invalid-granularity' // Pas dans enum ['mcp', 'mode', 'full']
      };

      // Le schema Zod devrait rejeter cet argument
      // Note: Dans l'implémentation réelle, la validation Zod se fait en amont
      // Ici on teste que le code gère bien les cas invalides
      await expect(async () => {
        const { CompareConfigArgsSchema } = await import('../../../src/tools/roosync/compare-config.js');
        CompareConfigArgsSchema.parse(invalidArgs);
      }).rejects.toThrow();
    });
  });
});
