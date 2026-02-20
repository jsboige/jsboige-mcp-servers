/**
 * Tests unitaires pour l'outil roosync_compare_config
 * 
 * @module tests/unit/tools/roosync/compare-config
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncCompareConfig, compareConfigToolMetadata } from '../../../../src/tools/roosync/compare-config.js';

// Mock du service RooSync
const mockRooSyncService = {
  getConfig: vi.fn(),
  loadDashboard: vi.fn(),
  compareRealConfigurations: vi.fn(),
  getInventory: vi.fn()
};

// Mock de getRooSyncService
vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => mockRooSyncService,
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'RooSyncServiceError';
    }
  }
}));

// Mock de GranularDiffDetector
const mockGranularDiffDetector = {
  compareGranular: vi.fn()
};

vi.mock('../../../../src/services/GranularDiffDetector.js', () => ({
  GranularDiffDetector: class {
    compareGranular = mockGranularDiffDetector.compareGranular;
  }
}));

describe('roosync_compare_config', () => {
  // Set env vars to prevent checkMissingEnvVars from adding diffs (#495)
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set all CRITICAL_ENV_VARS to prevent extra diffs
    process.env = {
      ...originalEnv,
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '1536',
      EMBEDDING_API_BASE_URL: 'https://api.openai.com/v1',
      EMBEDDING_API_KEY: 'test-key',
      QDRANT_URL: 'http://localhost:6333',
      QDRANT_API_KEY: 'test-qdrant-key'
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('devrait avoir les métadonnées correctes', () => {
    expect(compareConfigToolMetadata.name).toBe('roosync_compare_config');
    expect(compareConfigToolMetadata.description).toContain('Compare les configurations Roo');
    expect(compareConfigToolMetadata.description).toContain('Supporte également la comparaison avec des profils');
    expect(compareConfigToolMetadata.inputSchema.properties.target.description).toContain('ID de la machine cible ou du profil');
  });

  it('devrait supporter la comparaison standard entre deux machines', async () => {
    const args = {
      source: 'local-machine',
      target: 'remote-machine'
    };

    mockRooSyncService.getConfig.mockReturnValue({ machineId: 'local-machine' });
    mockRooSyncService.compareRealConfigurations.mockResolvedValue({
      sourceMachine: 'local-machine',
      targetMachine: 'remote-machine',
      hostId: 'local-host',
      differences: [],
      summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
    });

    const result = await roosyncCompareConfig(args);

    expect(mockRooSyncService.compareRealConfigurations).toHaveBeenCalledWith(
      'local-machine',
      'remote-machine',
      false
    );
    expect(result.source).toBe('local-machine');
    expect(result.target).toBe('remote-machine');
  });

  it('devrait supporter la comparaison avec un profil', async () => {
    const args = {
      source: 'local-machine',
      target: 'profile:dev'
    };

    mockRooSyncService.getConfig.mockReturnValue({ machineId: 'local-machine' });
    mockRooSyncService.compareRealConfigurations.mockResolvedValue({
      sourceMachine: 'local-machine',
      targetMachine: 'profile:dev',
      hostId: 'local-host',
      differences: [],
      summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
    });

    const result = await roosyncCompareConfig(args);

    expect(mockRooSyncService.compareRealConfigurations).toHaveBeenCalledWith(
      'local-machine',
      'profile:dev',
      false
    );
    expect(result.target).toBe('profile:dev');
  });

  describe('granularity parameter', () => {
    it('devrait inclure granularity dans les métadonnées', () => {
      expect(compareConfigToolMetadata.inputSchema.properties.granularity).toBeDefined();
      expect(compareConfigToolMetadata.inputSchema.properties.granularity.enum).toEqual(['mcp', 'mode', 'full']);
    });

    it('devrait utiliser GranularDiffDetector quand granularity=full', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      const mockInventory = {
        machineId: 'machine-a',
        inventory: {
          mcpServers: { server1: { enabled: true } },
          rooModes: { mode1: { name: 'Mode 1' } }
        }
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue(mockInventory);
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'diff-1',
            path: 'config.test',
            type: 'modified',
            severity: 'IMPORTANT',
            category: 'roo_config',
            description: 'Test difference'
          }
        ],
        summary: {
          total: 1,
          byType: { modified: 1 },
          bySeverity: { IMPORTANT: 1 },
          byCategory: { roo_config: 1 }
        },
        performance: { executionTime: 10, nodesCompared: 5 }
      });

      const result = await roosyncCompareConfig(args);

      expect(mockRooSyncService.getInventory).toHaveBeenCalledWith('machine-a', false);
      expect(mockRooSyncService.getInventory).toHaveBeenCalledWith('machine-b', false);
      expect(mockGranularDiffDetector.compareGranular).toHaveBeenCalled();
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].severity).toBe('IMPORTANT');
    });

    it('devrait extraire mcpServers quand granularity=mcp', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const
      };

      const mockInventory = {
        machineId: 'machine-a',
        inventory: {
          mcpServers: { jupyter: { enabled: true }, github: { enabled: false } },
          rooModes: { mode1: { name: 'Mode 1' } }
        }
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue(mockInventory);
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [],
        summary: { total: 0, byType: {}, bySeverity: {}, byCategory: {} },
        performance: { executionTime: 5, nodesCompared: 2 }
      });

      await roosyncCompareConfig(args);

      // Vérifie que compareGranular a reçu les mcpServers
      const compareCall = mockGranularDiffDetector.compareGranular.mock.calls[0];
      expect(compareCall[0]).toEqual({ jupyter: { enabled: true }, github: { enabled: false } });
    });

    it('devrait extraire rooModes quand granularity=mode', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mode' as const
      };

      const mockInventory = {
        machineId: 'machine-a',
        inventory: {
          mcpServers: { server1: {} },
          rooModes: { architect: { name: 'Architect' }, code: { name: 'Code' } }
        }
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue(mockInventory);
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [],
        summary: { total: 0, byType: {}, bySeverity: {}, byCategory: {} },
        performance: { executionTime: 5, nodesCompared: 2 }
      });

      await roosyncCompareConfig(args);

      // Vérifie que compareGranular a reçu les rooModes
      const compareCall = mockGranularDiffDetector.compareGranular.mock.calls[0];
      expect(compareCall[0]).toEqual({ architect: { name: 'Architect' }, code: { name: 'Code' } });
    });
  });

  describe('filter parameter', () => {
    it('devrait inclure filter dans les métadonnées', () => {
      expect(compareConfigToolMetadata.inputSchema.properties.filter).toBeDefined();
      expect(compareConfigToolMetadata.inputSchema.properties.filter.description).toContain('Filtre optionnel');
    });

    it('devrait filtrer les diffs par path', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const,
        filter: 'jupyter'
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'machine-a', inventory: {} });
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          { id: 'd1', path: 'mcpServers.jupyter.enabled', type: 'modified', severity: 'IMPORTANT', category: 'roo_config', description: 'Jupyter config changed' },
          { id: 'd2', path: 'mcpServers.github.enabled', type: 'modified', severity: 'INFO', category: 'roo_config', description: 'GitHub config changed' },
          { id: 'd3', path: 'hardware.cpu', type: 'modified', severity: 'INFO', category: 'hardware', description: 'CPU different' }
        ],
        summary: { total: 3, byType: { modified: 3 }, bySeverity: { IMPORTANT: 1, INFO: 2 }, byCategory: { roo_config: 2, hardware: 1 } },
        performance: { executionTime: 10, nodesCompared: 10 }
      });

      const result = await roosyncCompareConfig(args);

      // Seule la diff avec "jupyter" dans le path doit être retournée
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].path).toContain('jupyter');
      expect(result.summary.total).toBe(1);
    });

    it('devrait filtrer les diffs par description', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const,
        filter: 'GitHub'
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'machine-a', inventory: {} });
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          { id: 'd1', path: 'mcpServers.jupyter', type: 'modified', severity: 'INFO', category: 'roo_config', description: 'Jupyter MCP' },
          { id: 'd2', path: 'mcpServers.gh', type: 'modified', severity: 'INFO', category: 'roo_config', description: 'GitHub MCP changed' }
        ],
        summary: { total: 2, byType: { modified: 2 }, bySeverity: { INFO: 2 }, byCategory: { roo_config: 2 } },
        performance: { executionTime: 10, nodesCompared: 10 }
      });

      const result = await roosyncCompareConfig(args);

      // La diff avec "GitHub" dans la description doit être retournée
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].description).toContain('GitHub');
    });

    it('devrait être case-insensitive pour le filtre', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const,
        filter: 'JUPYTER'  // uppercase
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'machine-a', inventory: {} });
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'test-report',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          { id: 'd1', path: 'mcpServers.jupyter', type: 'modified', severity: 'INFO', category: 'roo_config', description: 'jupyter lowercase' }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { INFO: 1 }, byCategory: { roo_config: 1 } },
        performance: { executionTime: 5, nodesCompared: 5 }
      });

      const result = await roosyncCompareConfig(args);

      expect(result.differences).toHaveLength(1);
    });
  });

  describe('error handling with granularity', () => {
    it('devrait lever une erreur si inventaire source manquant', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValueOnce(null);  // source null
      mockRooSyncService.getInventory.mockResolvedValueOnce({ machineId: 'machine-b' });  // target ok

      await expect(roosyncCompareConfig(args)).rejects.toThrow('Inventaire manquant');
    });

    it('devrait lever une erreur si inventaire target manquant', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValueOnce({ machineId: 'machine-a' });  // source ok
      mockRooSyncService.getInventory.mockResolvedValueOnce(null);  // target null

      await expect(roosyncCompareConfig(args)).rejects.toThrow('Inventaire manquant');
    });
  });
});