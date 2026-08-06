/**
 * Tests unitaires pour l'outil roosync_compare_config
 * 
 * @module tests/unit/tools/roosync/compare-config
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncCompareConfig } from '../../../../src/tools/roosync/compare-config.js';

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

  describe('partial-alias validation (#alias-validation)', () => {
    it('devrait détecter source="local" (alias partiel) et suggérer "local-machine"', async () => {
      const args = {
        source: 'local',
        target: 'myia-ai-01',
        granularity: 'mcp' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'myia-po-2024' });
      // getDefaultTargetMachine is awaited only when target is undefined; here it's set.
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'x', inventory: {} });

      const result = await roosyncCompareConfig(args);

      // Early return: validation CRITICAL, no inventory lookup performed.
      expect(mockRooSyncService.getInventory).not.toHaveBeenCalled();
      expect(result.summary.critical).toBe(1);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].category).toBe('validation');
      expect(result.differences[0].description).toContain('local-machine');
      expect(result.differences[0].description).toContain('source "local"');
    });

    it('devrait détecter target="local" (alias partiel) aussi', async () => {
      const args = {
        source: 'myia-ai-01',
        target: 'local',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'myia-po-2024' });
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'x', inventory: {} });

      const result = await roosyncCompareConfig(args);

      expect(mockRooSyncService.getInventory).not.toHaveBeenCalled();
      expect(result.summary.critical).toBe(1);
      expect(result.differences[0].description).toContain('local-machine');
      expect(result.differences[0].description).toContain('target "local"');
    });

    it('ne doit PAS bloquer les vrais machineIds ni l\'alias complet "local-machine"', async () => {
      // source = local-machine alias (résolu vers config.machineId), target = vrai machineId
      const args = {
        source: 'local-machine',
        target: 'myia-ai-01',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'myia-po-2024' });
      mockRooSyncService.getInventory.mockResolvedValue({ machineId: 'x', inventory: {} });
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 't', timestamp: new Date().toISOString(),
        sourceLabel: 'myia-po-2024', targetLabel: 'myia-ai-01',
        diffs: [], summary: { total: 0, byType: {}, bySeverity: {}, byCategory: {} },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      // Pas de validation CRITICAL — l'inventaire est bien consulté.
      expect(mockRooSyncService.getInventory).toHaveBeenCalled();
      expect(result.differences.every(d => d.category !== 'validation')).toBe(true);
    });
  });

  describe('error handling with granularity', () => {
    it('devrait retourner un avertissement si inventaire source manquant', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValueOnce(null);  // source null
      mockRooSyncService.getInventory.mockResolvedValueOnce({ machineId: 'machine-b' });  // target ok

      // Code handles null inventory gracefully: returns a CRITICAL diff instead of throwing
      const result = await roosyncCompareConfig(args);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].severity).toBe('CRITICAL');
      expect(result.differences[0].description).toContain('Inventaire');
      expect(result.differences[0].description).toContain('source');
      expect(result.summary.critical).toBe(1);
    });

    it('devrait retourner un avertissement si inventaire target manquant', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValueOnce({ machineId: 'machine-a' });  // source ok
      mockRooSyncService.getInventory.mockResolvedValueOnce(null);  // target null

      // Code handles null inventory gracefully: returns a CRITICAL diff instead of throwing
      const result = await roosyncCompareConfig(args);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].severity).toBe('CRITICAL');
      expect(result.differences[0].description).toContain('Inventaire');
      expect(result.differences[0].description).toContain('target');
      expect(result.summary.critical).toBe(1);
    });
  });

  // #3044 — VibeSync: surface source_value/target_value (masked + truncated)
  // and harmonization_candidates so the caller can arbitrate without opening
  // config files manually.
  describe('#3044 VibeSync — value surfacing + harmonization_candidates', () => {
    it('défaut (detail omis) = values: each diff porte source_value/target_value + harmonization_candidates remplie', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const
        // detail omis → défaut 'values'
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: { mcpServers: { sk: {} } }
      });

      // Diff granulaire simulé: type='modified' avec oldValue/newValue définis
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r1',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'sk-agent.args',
            type: 'modified',
            severity: 'WARNING',
            category: 'array',
            description: "Élément modifié: 'sk-agent'",
            oldValue: { command: 'npx', args: ['-y', 'a'] },
            newValue: { command: 'npx', args: ['-y', 'b'] }
          }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { WARNING: 1 }, byCategory: { array: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      const diff = result.differences[0];
      expect(diff.source_value).toBeDefined();
      expect(diff.target_value).toBeDefined();
      // Source = oldValue côté GranularDiffDetector
      expect(diff.source_value).toContain('npx');
      expect(diff.target_value).toContain('npx');
      // Discrimination present_absent vs divergent_value
      expect(result.harmonization_candidates).toBeDefined();
      expect(result.harmonization_candidates!.summary).toEqual({ total: 1, present_absent: 0, divergent_value: 1 });
      expect(result.harmonization_candidates!.divergent_value[0].path).toContain('sk-agent');
      expect(result.harmonization_candidates!.divergent_value[0].source_value).toContain('npx');
    });

    it('detail="paths" omet values et harmonization_candidates (rendu léger)', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const,
        detail: 'paths' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: { mcpServers: { sk: {} } }
      });

      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r2',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'sk-agent',
            type: 'modified',
            severity: 'WARNING',
            category: 'array',
            description: "Élément modifié: 'sk-agent'",
            oldValue: { command: 'npx' },
            newValue: { command: 'node' }
          }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { WARNING: 1 }, byCategory: { array: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      expect(result.differences[0].source_value).toBeUndefined();
      expect(result.differences[0].target_value).toBeUndefined();
      expect(result.harmonization_candidates).toBeUndefined();
    });

    it('masque les secrets: paths contenant API_KEY/SECRET/TOKEN → <set:len=N:sha256=...>, jamais en clair', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: { mcpServers: {} }
      });

      const SECRET = 'sk-super-secret-1234567890';
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r3',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'embeddings.API_KEY',
            type: 'modified',
            severity: 'CRITICAL',
            category: 'nested',
            description: 'Valeur modifiée',
            oldValue: SECRET,
            newValue: 'different-key-9999'
          }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { CRITICAL: 1 }, byCategory: { nested: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      const diff = result.differences[0];
      // Jamais de fuite du clear text
      expect(diff.source_value).not.toContain(SECRET);
      expect(diff.source_value).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
      expect(diff.target_value).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
      // Deux secrets différents → hashes différents (permet arbitrage "même clé ?")
      expect(diff.source_value).not.toBe(diff.target_value);
    });

    it('masque récursivement les clés sensibles nichées dans un objet', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: { mcpServers: {} }
      });

      const SECRET = 'ghp_abcdef1234567890XYZ';
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r4',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'github.server',
            type: 'modified',
            severity: 'WARNING',
            category: 'nested',
            description: 'Valeur modifiée',
            oldValue: { command: 'npx', env: { GITHUB_TOKEN: SECRET } },
            newValue: { command: 'npx', env: { GITHUB_TOKEN: 'other-token-9999' } }
          }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { WARNING: 1 }, byCategory: { nested: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      const diff = result.differences[0];
      expect(diff.source_value).toBeDefined();
      expect(diff.source_value).not.toContain(SECRET);
      // La valeur maskée doit apparaître dans le rendu stringifié
      expect(diff.source_value).toMatch(/GITHUB_TOKEN.*<set:len=\d+:sha256=[0-9a-f]{8}>/);
    });

    it('tronque les valeurs longues (>200 chars) avec marqueur [...]', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'full' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: {}
      });

      const LONG_VALUE = 'x'.repeat(500);
      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r5',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'config.longField',
            type: 'modified',
            severity: 'INFO',
            category: 'nested',
            description: 'Valeur modifiée',
            oldValue: LONG_VALUE,
            newValue: 'short'
          }
        ],
        summary: { total: 1, byType: { modified: 1 }, bySeverity: { INFO: 1 }, byCategory: { nested: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      const diff = result.differences[0];
      // Tronqué et marqué (le marquer peut être à l'intérieur des quotes pour
      // les strings, ou en suffixe pour le JSON — on accepte les deux)
      expect(diff.source_value!.length).toBeLessThan(LONG_VALUE.length);
      expect(diff.source_value!).toMatch(/\[\.\.\.\]"?$/);
    });

    it('harmonization_candidates sépare present_absent (ajout/suppression) de divergent_value', async () => {
      const args = {
        source: 'machine-a',
        target: 'machine-b',
        granularity: 'mcp' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'machine-a' });
      mockRooSyncService.getInventory.mockResolvedValue({
        machineId: 'machine-a',
        inventory: { mcpServers: {} }
      });

      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r6',
        timestamp: new Date().toISOString(),
        sourceLabel: 'machine-a',
        targetLabel: 'machine-b',
        diffs: [
          {
            id: 'd1',
            path: 'sk-agent',
            type: 'added',
            severity: 'INFO',
            category: 'array',
            description: "Élément ajouté: 'sk-agent'",
            oldValue: undefined,
            newValue: { command: 'npx' }
          },
          {
            id: 'd2',
            path: 'markitdown',
            type: 'removed',
            severity: 'WARNING',
            category: 'array',
            description: "Élément supprimé: 'markitdown'",
            oldValue: { command: 'python' },
            newValue: undefined
          },
          {
            id: 'd3',
            path: 'searxng.enabled',
            type: 'modified',
            severity: 'WARNING',
            category: 'nested',
            description: 'Valeur modifiée',
            oldValue: true,
            newValue: false
          }
        ],
        summary: { total: 3, byType: { added: 1, removed: 1, modified: 1 }, bySeverity: { WARNING: 2, INFO: 1 }, byCategory: { array: 2, nested: 1 } },
        performance: { executionTime: 1, nodesCompared: 3 }
      });

      const result = await roosyncCompareConfig(args);

      expect(result.harmonization_candidates).toBeDefined();
      const hc = result.harmonization_candidates!;
      expect(hc.summary).toEqual({ total: 3, present_absent: 2, divergent_value: 1 });
      expect(hc.present_absent).toHaveLength(2);
      expect(hc.divergent_value).toHaveLength(1);
      // Chaque candidat porte son kind
      expect(hc.present_absent.every(c => c.kind === 'present_absent')).toBe(true);
      expect(hc.divergent_value.every(c => c.kind === 'divergent_value')).toBe(true);
    });

    it('AC #3044 — Demo sk-agent ai-01 vs po-2026: décision "harmoniser ou pas" arbitrable sans ouvrir fichier', async () => {
      // Scénario réel de l'issue: sk-agent absent de po-2026 mais présent sur ai-01.
      // Les DEUX machines ont un inventaire mcp non-vide (le preflight #2963 ne
      // bloque que si un côté est totalement vide — ici on est dans le cas
      // d'un vrai diff "sk-agent supprimé").
      const args = {
        source: 'myia-ai-01',
        target: 'myia-po-2026',
        granularity: 'mcp' as const
      };

      mockRooSyncService.getConfig.mockReturnValue({ machineId: 'myia-ai-01' });
      mockRooSyncService.getInventory.mockImplementation((machineId: string) => Promise.resolve({
        machineId,
        // Les deux côtés peuplés: ai-01 a sk-agent, po-2026 a d'autres MCPs
        inventory: {
          mcpServers: machineId === 'myia-ai-01'
            ? { 'sk-agent': {} }
            : { 'roo-state-manager': {}, 'win-cli': {} }
        }
      }));

      mockGranularDiffDetector.compareGranular.mockResolvedValue({
        reportId: 'r7',
        timestamp: new Date().toISOString(),
        sourceLabel: 'myia-ai-01',
        targetLabel: 'myia-po-2026',
        diffs: [
          {
            id: 'd1',
            path: 'sk-agent',
            type: 'removed',
            severity: 'WARNING',
            category: 'array',
            description: "Élément supprimé: 'sk-agent'",
            oldValue: {
              command: 'cmd',
              args: ['/c', 'python', '-m', 'sk_agent'],
              env: { SK_API_KEY: 'sk-demo-key-not-real-1234567890' }
            },
            newValue: undefined
          }
        ],
        summary: { total: 1, byType: { removed: 1 }, bySeverity: { WARNING: 1 }, byCategory: { array: 1 } },
        performance: { executionTime: 1, nodesCompared: 1 }
      });

      const result = await roosyncCompareConfig(args);

      // AC: la valeur est visible (masquée pour le secret) → arbitrage sans fichier
      const diff = result.differences[0];
      expect(diff.source_value).toBeDefined();
      expect(diff.target_value).toBeUndefined();
      // Secret niché masqué, jamais en clair
      expect(diff.source_value).not.toContain('sk-demo-key-not-real');
      expect(diff.source_value).toMatch(/SK_API_KEY.*<set:len=\d+:sha256=[0-9a-f]{8}>/);
      // Candidat present_absent
      expect(result.harmonization_candidates!.present_absent[0].kind).toBe('present_absent');
      expect(result.harmonization_candidates!.present_absent[0].source_value).toBe(diff.source_value);
    });
  });
});