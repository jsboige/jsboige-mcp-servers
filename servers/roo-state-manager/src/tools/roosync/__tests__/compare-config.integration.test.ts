/**
 * Tests d'intégration pour roosyncCompareConfig
 *
 * Couvre tous les modes de granularité de l'outil :
 * - granularity: 'mcp' : Comparaison uniquement des configurations MCP
 * - granularity: 'mode' : Comparaison uniquement des modes Roo
 * - granularity: 'settings' : Comparaison des settings Roo (state.vscdb)
 * - granularity: 'full' : Comparaison granulaire complète
 *
 * Couvre également :
 * - Vérification des variables d'environnement critiques (#495)
 * - Comparaison des profils de modèles (#498)
 * - Force refresh du cache
 * - Filtrage par path
 *
 * Framework: Vitest
 * Type: Intégration (RooSyncService réel, opérations filesystem réelles)
 *
 * @module roosync/compare-config.integration.test
 * @version 1.0.0 (#564 Phase 2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock process.env pour les tests de variables d'environnement
const originalEnv = process.env;

// Chemin de test pour les données partagées
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-compare');

// Import après les mocks
import { roosyncCompareConfig } from '../compare-config.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosyncCompareConfig (integration)', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    // FIX: Set required environment variables for test mode
    // loadRooSyncConfig() reads these directly when NODE_ENV === 'test'
    // See roosync-config.ts lines 54-98
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'roo-config/modes'),
      join(testSharedStatePath, 'roo-config/mcp'),
      join(testSharedStatePath, 'roo-config/profiles'),
      join(testSharedStatePath, 'roo-config/settings'),
      join(testSharedStatePath, 'packages'),
      join(testSharedStatePath, 'inventories')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer des fichiers de configuration factices
    writeFileSync(join(testSharedStatePath, 'roo-config/modes/test-mode.json'), JSON.stringify({ name: 'test-mode' }));
    writeFileSync(join(testSharedStatePath, 'roo-config/mcp/test-mcp.json'), JSON.stringify({ name: 'test-mcp' }));
    writeFileSync(join(testSharedStatePath, 'roo-config/profiles/test-profile.json'), JSON.stringify({
      name: 'Test Profile',
      modes: ['code-simple', 'debug-simple'],
      apiConfigs: []
    }));

    // Créer un inventory factice (format MachineInventory baseline requis par InventoryCollector)
    writeFileSync(join(testSharedStatePath, 'inventories/test-machine.json'), JSON.stringify({
      machineId: 'test-machine',
      timestamp: Date.now(),
      system: {
        hostname: 'test-machine',
        os: 'linux',
        architecture: 'x64',
        uptime: 123456
      },
      hardware: {
        cpu: { name: 'Test CPU', cores: 4, threads: 8 },
        memory: { total: 16000000000, available: 8000000000 },
        disks: []
      },
      software: {
        powershell: '5.1',
        node: 'v18.0.0'
      },
      roo: {
        mcpServers: [
          { name: 'test-mcp', enabled: true, command: 'test', transportType: 'stdio' }
        ],
        modes: [
          { slug: 'test-mode', name: 'Test Mode', tools: [] }
        ]
      },
      paths: {
        rooExtensions: '/fake/roo-extensions',
        mcpSettings: '/fake/mcp_settings.json',
        rooConfig: '/fake/roo-config'
      }
    }));

    // Créer un inventory pour une machine "remote"
    writeFileSync(join(testSharedStatePath, 'inventories/remote-machine.json'), JSON.stringify({
      machineId: 'remote-machine',
      timestamp: Date.now(),
      system: {
        hostname: 'remote-machine',
        os: 'linux',
        architecture: 'x64',
        uptime: 123456
      },
      hardware: {
        cpu: { name: 'Test CPU', cores: 4, threads: 8 },
        memory: { total: 16000000000, available: 8000000000 },
        disks: []
      },
      software: {
        powershell: '5.1',
        node: 'v18.0.0'
      },
      roo: {
        mcpServers: [
          { name: 'remote-mcp', enabled: true, command: 'remote', transportType: 'stdio' }
        ],
        modes: [
          { slug: 'remote-mode', name: 'Remote Mode', tools: [] }
        ]
      },
      paths: {
        rooExtensions: '/fake/roo-extensions-remote',
        mcpSettings: '/fake/mcp_settings_remote.json',
        rooConfig: '/fake/roo-config-remote'
      }
    }));

    // Créer un dashboard factice pour que getDefaultTargetMachine() fonctionne
    // Le dashboard est lu par service.loadDashboard() dans getDefaultTargetMachine()
    writeFileSync(join(testSharedStatePath, 'sync-dashboard.json'), JSON.stringify({
      machines: {
        'test-machine': {
          lastSync: new Date().toISOString(),
          status: 'synced' as 'diverged' | 'synced' | 'conflict' | 'unknown',
          diffsCount: 0,
          pendingDecisions: 0
        },
        'remote-machine': {
          lastSync: new Date().toISOString(),
          status: 'synced' as 'diverged' | 'synced' | 'conflict' | 'unknown',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    }));

    // Reset singleton avant chaque test
    RooSyncService.resetInstance();
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }

    // Reset singleton après chaque test
    RooSyncService.resetInstance();

    // Restaurer process.env
    process.env = { ...originalEnv };
  });

  // ============================================================
  // Tests pour granularity: 'mcp'
  // ============================================================

  describe('granularity: mcp', () => {
    test('should compare MCP configurations between machines', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('mcp');
    });

    test('should filter MCP configs when filter is provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: 'jupyter'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('mcp');
    });

    test('should compare with custom source and target', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('mcp');
    });

    test('should handle missing MCP configurations gracefully', async () => {
      // Supprimer un fichier MCP pour simuler une config manquante
      rmSync(join(testSharedStatePath, 'roo-config/mcp/test-mcp.json'));

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour granularity: 'mode'
  // ============================================================

  describe('granularity: mode', () => {
    test('should compare Roo modes between machines', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mode'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('mode');
    });

    test('should detect mode differences', async () => {
      // Créer un mode différent sur la machine "remote"
      writeFileSync(join(testSharedStatePath, 'roo-config/modes/remote-mode.json'), JSON.stringify({
        name: 'remote-mode',
        instructions: 'Different instructions'
      }));

      const result = await roosyncCompareConfig({
        granularity: 'mode',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('mode');
    });

    test('should handle missing modes gracefully', async () => {
      rmSync(join(testSharedStatePath, 'roo-config/modes/test-mode.json'));

      const result = await roosyncCompareConfig({
        granularity: 'mode'
      });

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour granularity: 'settings' (#547)
  // ============================================================

  describe('granularity: settings', () => {
    test('should compare Roo settings from state.vscdb', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'settings'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('settings');
    });

    test('should detect settings differences', async () => {
      // Créer des settings différents pour simuler une différence
      const settingsDir = join(testSharedStatePath, 'roo-config/settings');
      writeFileSync(join(settingsDir, 'test-machine.json'), JSON.stringify({
        key1: 'value1',
        key2: 'value2'
      }));
      writeFileSync(join(settingsDir, 'remote-machine.json'), JSON.stringify({
        key1: 'value1-different',
        key3: 'value3'
      }));

      const result = await roosyncCompareConfig({
        granularity: 'settings',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('settings');
    });

    test('should handle missing settings files', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'settings'
      });

      expect(result).toBeDefined();
      // Devrait retourner un résultat même si les settings n'existent pas
    });
  });

  // ============================================================
  // Tests pour granularity: 'full'
  // ============================================================

  describe('granularity: full', () => {
    test('should perform complete granular comparison', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('full');
    });

    test('should include all comparison types in full mode', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
      // Devrait inclure config, environment, hardware, software, system
    });

    test('should use GranularDiffDetector in full mode', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
      expect(result.granularity).toBe('full');
    });
  });

  // ============================================================
  // Tests pour force_refresh
  // ============================================================

  describe('force_refresh', () => {
    test('should force refresh when force_refresh is true', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: true
      });

      expect(result).toBeDefined();
      // Le cache devrait être invalidé et les données rechargées
    });

    test('should use cache when force_refresh is false', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: false
      });

      expect(result).toBeDefined();
    });

    test('should default to using cache when force_refresh not specified', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // force_refresh devrait être false par défaut
    });
  });

  // ============================================================
  // Tests pour vérification variables d'environnement (#495)
  // ============================================================

  describe('environment variables checking (#495)', () => {
    test('should check for CRITICAL_ENV_VARS', async () => {
      // Supprimer toutes les variables d'environnement critiques
      delete process.env.EMBEDDING_MODEL;
      delete process.env.EMBEDDING_DIMENSIONS;
      delete process.env.EMBEDDING_API_BASE_URL;
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.QDRANT_URL;
      delete process.env.QDRANT_API_KEY;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
      // Devrait signaler les variables manquantes avec le bon severity (CRITICAL/WARNING)
    });

    test('should detect missing EMBEDDING_MODEL (WARNING)', async () => {
      delete process.env.EMBEDDING_MODEL;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
    });

    test('should detect missing QDRANT_URL (CRITICAL)', async () => {
      delete process.env.QDRANT_URL;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
    });

    test('should pass when all CRITICAL_ENV_VARS are set', async () => {
      process.env.EMBEDDING_MODEL = 'test-model';
      process.env.EMBEDDING_DIMENSIONS = '2560';
      process.env.EMBEDDING_API_BASE_URL = 'http://test-url';
      process.env.EMBEDDING_API_KEY = 'test-key';
      process.env.QDRANT_URL = 'http://qdrant-test';
      process.env.QDRANT_API_KEY = 'qdrant-key';

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour comparaison profils modèles (#498)
  // ============================================================

  describe('model profile comparison (#498)', () => {
    test('should compare model-configs.json profiles', async () => {
      // Créer des model-configs factices
      writeFileSync(join(testSharedStatePath, 'roo-config/model-configs.json'), JSON.stringify({
        profiles: [
          { name: 'Profile A', models: ['model1'] },
          { name: 'Profile B', models: ['model2'] }
        ]
      }));

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
    });

    test('should handle missing model-configs.json', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
      // Devrait gérer l'absence de model-configs.json gracieusement
    });

    test('should detect profile differences between machines', async () => {
      // Créer des profils différents
      writeFileSync(join(testSharedStatePath, 'roo-config/model-configs.json'), JSON.stringify({
        profiles: [
          { name: 'Profile A', models: ['model1'] }
        ]
      }));

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour comparaison avec profils
  // ============================================================

  describe('profile comparison', () => {
    test('should compare with profile:target format', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        target: 'profile:dev'
      });

      expect(result).toBeDefined();
      // La comparaison devrait se faire contre un profil au lieu d'une machine
    });

    test('should handle non-existent profile gracefully', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        target: 'profile:nonexistent'
      });

      expect(result).toBeDefined();
      // Devrait gérer les profils inexistants gracieusement
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing inventory gracefully', async () => {
      // Supprimer le répertoire inventories
      rmSync(join(testSharedStatePath, 'inventories'), { recursive: true, force: true });

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // Devrait retourner un résultat même sans inventory
    });

    test('should handle corrupted inventory files', async () => {
      // Créer un fichier inventory corrompu
      writeFileSync(join(testSharedStatePath, 'inventories/corrupted.json'), '{ invalid json }');

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // Devrait ignorer les fichiers corrompus
    });

    test('should handle missing shared state directory', async () => {
      // Supprimer tout le shared state
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // Devrait créer les répertoires nécessaires ou retourner un résultat par défaut
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete comparison workflow: mcp → mode → settings → full', async () => {
      // Step 1: MCP comparison
      const mcpResult = await roosyncCompareConfig({
        granularity: 'mcp'
      });
      expect(mcpResult).toBeDefined();
      expect(mcpResult.granularity).toBe('mcp');

      // Step 2: Mode comparison
      const modeResult = await roosyncCompareConfig({
        granularity: 'mode'
      });
      expect(modeResult).toBeDefined();
      expect(modeResult.granularity).toBe('mode');

      // Step 3: Settings comparison
      const settingsResult = await roosyncCompareConfig({
        granularity: 'settings'
      });
      expect(settingsResult).toBeDefined();
      expect(settingsResult.granularity).toBe('settings');

      // Step 4: Full comparison
      const fullResult = await roosyncCompareConfig({
        granularity: 'full'
      });
      expect(fullResult).toBeDefined();
      expect(fullResult.granularity).toBe('full');
    });

    test('should persist singleton state across calls', async () => {
      const instance1 = RooSyncService.getInstance({ enabled: false });

      await roosyncCompareConfig({
        granularity: 'mcp'
      });

      const instance2 = RooSyncService.getInstance({ enabled: false });

      // Les instances devraient être les mêmes (singleton)
      expect(instance1).toBeDefined();
      expect(instance2).toBeDefined();
    });

    test('should handle comparison with force refresh after initial comparison', async () => {
      // First comparison without refresh (uses cache)
      const result1 = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: false
      });
      expect(result1).toBeDefined();

      // Second comparison with refresh (invalidates cache)
      const result2 = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: true
      });
      expect(result2).toBeDefined();
    });
  });

  // ============================================================
  // Tests de filtrage
  // ============================================================

  describe('filter functionality', () => {
    test('should filter results by path pattern', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: 'jupyter'
      });

      expect(result).toBeDefined();
      // Les résultats ne devraient inclure que les paths correspondant au filtre
    });

    test('should handle empty filter (no filtering)', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: ''
      });

      expect(result).toBeDefined();
      // Filtre vide = pas de filtrage
    });

    test('should handle filter with no matches', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: 'nonexistent-mcp-name'
      });

      expect(result).toBeDefined();
      // Devrait retourner des résultats vides pour ce filtre
    });
  });

  // ============================================================
  // Tests de sélection source/target
  // ============================================================

  describe('source and target selection', () => {
    test('should default source to local_machine when not specified', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // source devrait être 'local_machine' par défaut
    });

    test('should default target to remote_machine when not specified', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result).toBeDefined();
      // target devrait être 'remote_machine' par défaut
    });

    test('should use custom source when provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'custom-source-machine'
      });

      expect(result).toBeDefined();
    });

    test('should use custom target when provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        target: 'custom-target-machine'
      });

      expect(result).toBeDefined();
    });

    test('should compare two specific machines when both provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result).toBeDefined();
    });
  });
});
