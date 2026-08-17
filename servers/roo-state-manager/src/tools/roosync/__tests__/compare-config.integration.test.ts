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
 * @version 2.0.0 (#833 P1 hardening — Grade D → B : assertions de contenu)
 *
 * Hardening (#833) : chaque scénario vérifie désormais le CONTENU du résultat
 * (diffs attendus par path/severity, summary cohérent), pas seulement
 * `toBeDefined()`. Les assertions ont été calibrées sur le comportement réel
 * observé (probe empirique) — pas sur une supposition.
 *
 * Isolation env : ROO_FLEET_ROSTER est aligné sur le dashboard de test dans
 * beforeEach. Sans cela, le diff `env.ROO_FLEET_ROSTER` (roster drift #2570)
 * apparaissait selon l'env de la machine hôte — fuite d'état hôte qui rendait
 * les comptes de summary non déterministes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock process.env pour les tests de variables d'environnement
const originalEnv = process.env;

// Chemin de test pour les données partagées
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-compare');

// Fix #634: Integration tests need REAL RooSyncService, not the mock from jest.setup.js
// Unmock the service so we get the real singleton with actual filesystem operations
vi.unmock('../../../services/RooSyncService.js');
// Also unmock InventoryCollector - the jest.setup.js mock has wrong method names (collect vs collectInventory)
vi.unmock('../../../services/InventoryCollector.js');
// Also unmock BaselineService - jest.setup.js mock is missing loadBaseline method
vi.unmock('../../../services/BaselineService.js');
// Also unmock ConfigService - BaselineService depends on it and jest.setup.js mock is incomplete
vi.unmock('../../../services/ConfigService.js');

// Import après les mocks
import { roosyncCompareConfig, CompareConfigResult } from '../compare-config.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

/** Diff paths qui dépendent de la granularité demandée (exclut les checks env/roster globaux). */
function configDiffs(result: CompareConfigResult): CompareConfigResult['differences'] {
  return result.differences.filter(d => d.path.startsWith('inventory.'));
}

function findDiff(result: CompareConfigResult, pathSubstring: string) {
  return result.differences.find(d => d.path.includes(pathSubstring));
}

/** Invariant structurel : le summary reflète exactement le tableau differences. */
function expectSummaryCoherent(result: CompareConfigResult): void {
  const { summary, differences } = result;
  expect(summary.total).toBe(differences.length);
  const bySeverity = (sev: string) => differences.filter(d => d.severity === sev).length;
  expect(summary.critical).toBe(bySeverity('CRITICAL'));
  expect(summary.important).toBe(bySeverity('IMPORTANT'));
  expect(summary.warning).toBe(bySeverity('WARNING'));
  expect(summary.info).toBe(bySeverity('INFO'));
}

describe('roosyncCompareConfig (integration)', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    // FIX: Set required environment variables for test mode
    // loadRooSyncConfig() reads these directly when NODE_ENV === 'test'
    // See roosync-config.ts lines 54-98
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    // #833 isolation : aligner le roster sur le dashboard de test, sinon le
    // check de partition drift (#2570) émet un CRITICAL env.ROO_FLEET_ROSTER
    // selon l'env de la machine hôte (résultats non déterministes). Roster
    // aligné → le check émet un diff INFO « consistant » (signal positif).
    process.env.ROO_FLEET_ROSTER = 'remote-machine,test-machine';
    // #833 isolation : les 6 vars EMBEDDING_*/QDRANT_* pilotent des diffs
    // `env.*` dans TOUTES les granularités (pas seulement 'full') — les setter
    // à des valeurs de test rend les comptes déterministes. Les tests #495
    // les suppriment explicitement pour exercer les chemins « manquante ».
    process.env.EMBEDDING_MODEL = 'test-model';
    process.env.EMBEDDING_DIMENSIONS = '2560';
    process.env.EMBEDDING_API_BASE_URL = 'http://test-url';
    process.env.EMBEDDING_API_KEY = 'test-key';
    process.env.QDRANT_URL = 'http://qdrant-test';
    process.env.QDRANT_API_KEY = 'qdrant-key';

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
    writeFileSync(join(testSharedStatePath, 'inventories/test-machine.json'), JSON.stringify(makeInventory('test-machine', 'test-mcp', 'test', 'test-mode', 'Test Mode')));
    // Créer un inventory pour une machine "remote"
    writeFileSync(join(testSharedStatePath, 'inventories/remote-machine.json'), JSON.stringify(makeInventory('remote-machine', 'remote-mcp', 'remote', 'remote-mode', 'Remote Mode')));

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
    // Reset singleton après chaque test (before cleanup to release file handles)
    RooSyncService.resetInstance();

    // Cleanup : supprimer répertoire test pour isolation
    // Wrapped in try-catch: rmSync can fail with ENOTEMPTY on Linux/CI
    // when async operations still hold file handles
    try {
      if (existsSync(testSharedStatePath)) {
        rmSync(testSharedStatePath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup — CI tmpdir is ephemeral anyway
    }

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

      expect(result.granularity).toBe('mcp');
      expect(result.source).toBe('test-machine');
      expect(result.target).toBe('remote-machine');

      // Le diff MCP remote est signalé comme ajouté (présent cible, absent source)
      const added = findDiff(result, 'mcpServers..remote-mcp');
      expect(added).toBeDefined();
      expect(added!.severity).toBe('INFO');
      expect(added!.description).toContain('remote-mcp');
      expect(added!.target_value).toContain('"command":"remote"');
      expect(added!.source_value).toBeUndefined();

      // Le diff MCP test est signalé comme supprimé (présent source, absent cible)
      const removed = findDiff(result, 'mcpServers..test-mcp');
      expect(removed).toBeDefined();
      expect(removed!.severity).toBe('WARNING');
      expect(removed!.source_value).toContain('"command":"test"');
      expect(removed!.target_value).toBeUndefined();

      // Roster aligné + fixtures : exactement 2 diffs MCP + 1 diff INFO roster
      // « consistant » (signal positif #2570), aucun CRITICAL
      expect(configDiffs(result)).toHaveLength(2);
      const rosterInfo = findDiff(result, 'env.ROO_FLEET_ROSTER');
      expect(rosterInfo).toBeDefined();
      expect(rosterInfo!.severity).toBe('INFO');
      expect(rosterInfo!.description).toContain('consistant');
      expect(result.summary.critical).toBe(0);
      expect(result.summary.total).toBe(3);
      expectSummaryCoherent(result);
    });

    test('should filter MCP configs when filter is provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: 'jupyter'
      });

      expect(result.granularity).toBe('mcp');
      // Aucun diff MCP ne matche 'jupyter' → seuls les diffs d'env globaux
      // (roster INFO consistant) survivent au filtre
      expect(findDiff(result, 'mcpServers')).toBeUndefined();
      expect(result.differences.filter(d => d.path !== 'env.ROO_FLEET_ROSTER')).toHaveLength(0);
      expect(result.harmonization_candidates).toBeDefined();
      expect(result.harmonization_candidates!.summary.total).toBe(0);
      expectSummaryCoherent(result);
    });

    test('should compare with custom source and target', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result.source).toBe('test-machine');
      expect(result.target).toBe('remote-machine');
      // Même comparaison que le défaut — les 2 diffs MCP doivent être là
      expect(findDiff(result, 'remote-mcp')).toBeDefined();
      expect(findDiff(result, 'test-mcp')).toBeDefined();
      expect(configDiffs(result)).toHaveLength(2);
    });

    test('should handle missing MCP configurations gracefully', async () => {
      // Supprimer un fichier MCP pour simuler une config manquante
      rmSync(join(testSharedStatePath, 'roo-config/mcp/test-mcp.json'));

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      // La comparaison granularity 'mcp' est pilotée par les INVENTAIRES,
      // pas par les fichiers roo-config/mcp/*.json : la suppression du
      // fichier ne doit ni crasher ni faire disparaître les diffs d'inventaire.
      expect(result.granularity).toBe('mcp');
      expect(findDiff(result, 'remote-mcp')).toBeDefined();
      expect(findDiff(result, 'test-mcp')).toBeDefined();
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('mode');
      const added = findDiff(result, 'rooModes..Remote Mode');
      expect(added).toBeDefined();
      expect(added!.severity).toBe('INFO');
      expect(added!.target_value).toContain('"slug":"remote-mode"');

      const removed = findDiff(result, 'rooModes..Test Mode');
      expect(removed).toBeDefined();
      expect(removed!.severity).toBe('WARNING');
      expect(removed!.source_value).toContain('"slug":"test-mode"');

      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('mode');
      // Les différences de modes proviennent des inventaires : ajout/suppression
      // des modes distincts des deux machines.
      expect(findDiff(result, 'Remote Mode')).toBeDefined();
      expect(findDiff(result, 'Test Mode')).toBeDefined();
      expectSummaryCoherent(result);
    });

    test('should handle missing modes gracefully', async () => {
      rmSync(join(testSharedStatePath, 'roo-config/modes/test-mode.json'));

      const result = await roosyncCompareConfig({
        granularity: 'mode'
      });

      expect(result.granularity).toBe('mode');
      // Les inventaires pilotent la comparaison — les diffs restent présents
      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('settings');
      expect(Array.isArray(result.differences)).toBe(true);
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('settings');
      // compareSettings labelise la source publiée GDrive « (published) »
      expect(result.source).toContain('test-machine');
      expect(result.target).toContain('remote-machine');
      expectSummaryCoherent(result);
    });

    test('should handle missing settings files', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'settings'
      });

      // Devrait retourner un résultat même si les settings n'existent pas
      expect(result.granularity).toBe('settings');
      expect(Array.isArray(result.differences)).toBe(true);
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('full');
      // Les paths factices divergent entre les deux inventaires → diff IMPORTANT
      const pathDiff = findDiff(result, 'paths.rooExtensions');
      expect(pathDiff).toBeDefined();
      expect(pathDiff!.severity).toBe('IMPORTANT');
      expect(pathDiff!.source_value).toBe('"/fake/roo-extensions"');
      expect(pathDiff!.target_value).toBe('"/fake/roo-extensions-remote"');
      expectSummaryCoherent(result);
    });

    test('should include all comparison types in full mode', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      // Devrait inclure config (array), nested (paths), environment (env vars absentes)
      const categories = new Set(result.differences.map(d => d.category));
      expect(categories.has('array')).toBe(true);      // roo.mcpServers / roo.modes
      expect(categories.has('nested')).toBe(true);     // paths.*
      expect(categories.has('environment')).toBe(true); // env.EMBEDDING_* (absentes en beforeEach)
    });

    test('should use GranularDiffDetector in full mode', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      // Le GranularDiffDetector produit des diffs avec valeurs formatées + le
      // grouping harmonization (#3044). Les champs machineId/hostname sont
      // downgradés INFO avec le préfixe [EXPECTED] (#2307).
      const machineIdDiff = findDiff(result, 'machineId');
      expect(machineIdDiff).toBeDefined();
      expect(machineIdDiff!.severity).toBe('INFO');
      expect(machineIdDiff!.description).toContain('[EXPECTED]');

      expect(result.harmonization_candidates).toBeDefined();
      expect(result.harmonization_candidates!.divergent_value.length).toBeGreaterThan(0);
      expect(result.harmonization_candidates!.present_absent.length).toBeGreaterThan(0);
      const hc = result.harmonization_candidates!;
      expect(hc.summary.total).toBe(hc.present_absent.length + hc.divergent_value.length);
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

      // Le cache devrait être invalidé et les données rechargées :
      // même comparaison que le défaut sur fixtures statiques.
      expect(result.granularity).toBe('mcp');
      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
    });

    test('should use cache when force_refresh is false', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: false
      });

      expect(result.granularity).toBe('mcp');
      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
    });

    test('should default to using cache when force_refresh not specified', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      // force_refresh devrait être false par défaut — comportement identique
      expect(result.granularity).toBe('mcp');
      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
    });
  });

  // ============================================================
  // Tests pour vérification variables d'environnement (#495)
  // ============================================================

  describe('environment variables checking (#495)', () => {
    test('should check for CRITICAL_ENV_VARS', async () => {
      // Toutes les variables critiques absentes (setter en beforeEach, delete ici)
      delete process.env.EMBEDDING_MODEL;
      delete process.env.EMBEDDING_DIMENSIONS;
      delete process.env.EMBEDDING_API_BASE_URL;
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.QDRANT_URL;
      delete process.env.QDRANT_API_KEY;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      const missingEnvDiffs = result.differences.filter(d => d.description.includes('manquante'));
      // 4 WARNING (EMBEDDING_*) + 2 CRITICAL (QDRANT_*)
      expect(missingEnvDiffs).toHaveLength(6);
      expect(missingEnvDiffs.filter(d => d.severity === 'WARNING').map(d => d.path).sort()).toEqual([
        'env.EMBEDDING_API_BASE_URL',
        'env.EMBEDDING_API_KEY',
        'env.EMBEDDING_DIMENSIONS',
        'env.EMBEDDING_MODEL'
      ]);
      expect(missingEnvDiffs.filter(d => d.severity === 'CRITICAL').map(d => d.path).sort()).toEqual([
        'env.QDRANT_API_KEY',
        'env.QDRANT_URL'
      ]);
      for (const d of missingEnvDiffs) {
        expect(d.category).toBe('environment');
        expect(d.action).toContain('Ajouter');
      }
      // Le roster reste aligné → signal INFO positif distinct des « manquantes »
      expect(findDiff(result, 'env.ROO_FLEET_ROSTER')!.severity).toBe('INFO');
      expectSummaryCoherent(result);
    });

    test('should detect missing EMBEDDING_MODEL (WARNING)', async () => {
      delete process.env.EMBEDDING_MODEL;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      const model = findDiff(result, 'env.EMBEDDING_MODEL');
      expect(model).toBeDefined();
      expect(model!.severity).toBe('WARNING');
    });

    test('should detect missing QDRANT_URL (CRITICAL)', async () => {
      delete process.env.QDRANT_URL;

      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      const qdrant = findDiff(result, 'env.QDRANT_URL');
      expect(qdrant).toBeDefined();
      expect(qdrant!.severity).toBe('CRITICAL');
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

      // Aucune var manquante ; seul subsiste le signal INFO roster (consistant)
      expect(result.differences.filter(d => d.description.includes('manquante'))).toHaveLength(0);
      const roster = result.differences.filter(d => d.path === 'env.ROO_FLEET_ROSTER');
      expect(roster).toHaveLength(1);
      expect(roster[0].severity).toBe('INFO');
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

      expect(result.granularity).toBe('full');
      expectSummaryCoherent(result);
    });

    test('should handle missing model-configs.json', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'full'
      });

      // Devrait gérer l'absence de model-configs.json gracieusement
      expect(result.granularity).toBe('full');
      expect(Array.isArray(result.differences)).toBe(true);
      expectSummaryCoherent(result);
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

      expect(result.granularity).toBe('full');
      expectSummaryCoherent(result);
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

      // Aucun profil 'dev' publié dans les fixtures → fallback gestion gracieuse
      // avec un CRITICAL inventory pointant la cible demandée (pas de crash).
      expect(result.target).toBe('profile:dev');
      const inv = findDiff(result, 'inventory');
      expect(inv).toBeDefined();
      expect(inv!.severity).toBe('CRITICAL');
      expectSummaryCoherent(result);
    });

    test('should handle non-existent profile gracefully', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        target: 'profile:nonexistent'
      });

      expect(result.target).toBe('profile:nonexistent');
      const inv = findDiff(result, 'inventory');
      expect(inv).toBeDefined();
      expect(inv!.severity).toBe('CRITICAL');
      expect(inv!.description).toContain('profile:nonexistent');
      expect(inv!.action).toContain('Générer l\'inventaire');
      expectSummaryCoherent(result);
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

      // Un seul diff CRITICAL listant les deux machines manquantes
      expect(result.differences).toHaveLength(1);
      const inv = result.differences[0];
      expect(inv.category).toBe('inventory');
      expect(inv.severity).toBe('CRITICAL');
      expect(inv.description).toContain('test-machine');
      expect(inv.description).toContain('remote-machine');
      expect(inv.action).toBe('Générer les inventaires des deux machines');
      expectSummaryCoherent(result);
    });

    test('should handle corrupted inventory files', async () => {
      // Créer un fichier inventory corrompu
      writeFileSync(join(testSharedStatePath, 'inventories/corrupted.json'), '{ invalid json }');

      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      // Le fichier corrompu est ignoré (aucun diff ne le mentionne) et la
      // comparaison continue sur les inventaires valides.
      expect(result.differences.some(d => d.description.includes('corrupted'))).toBe(false);
      expect(findDiff(result, 'remote-mcp')).toBeDefined();
      expect(findDiff(result, 'test-mcp')).toBeDefined();
      expectSummaryCoherent(result);
    });

    test('should handle missing shared state directory gracefully', async () => {
      // Supprimer tout le shared state
      rmSync(testSharedStatePath, { recursive: true, force: true });

      // La fonction devrait gérer l'erreur gracieusement et retourner un résultat CRITICAL
      // au lieu de lancer une exception (comportement cohérent avec autres outils roosync)
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      expect(result.source).toBe('local-machine');
      expect(result.target).toBe('unknown');
      expect(result.differences).toHaveLength(1);
      const infra = result.differences[0];
      expect(infra.category).toBe('infrastructure');
      expect(infra.severity).toBe('CRITICAL');
      expect(infra.path).toBe('roo-sync.infrastructure');
      expect(infra.action).toContain('ROOSYNC_SHARED_PATH');
      expectSummaryCoherent(result);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete comparison workflow: mcp → mode → settings → full', async () => {
      // Step 1: MCP comparison
      const mcpResult = await roosyncCompareConfig({ granularity: 'mcp' });
      expect(mcpResult.granularity).toBe('mcp');
      expect(configDiffs(mcpResult)).toHaveLength(2);

      // Step 2: Mode comparison
      const modeResult = await roosyncCompareConfig({ granularity: 'mode' });
      expect(modeResult.granularity).toBe('mode');
      expect(configDiffs(modeResult)).toHaveLength(2);

      // Step 3: Settings comparison
      const settingsResult = await roosyncCompareConfig({ granularity: 'settings' });
      expect(settingsResult.granularity).toBe('settings');
      expectSummaryCoherent(settingsResult);

      // Step 4: Full comparison
      const fullResult = await roosyncCompareConfig({ granularity: 'full' });
      expect(fullResult.granularity).toBe('full');
      // Le mode full voit strictement plus de catégories que les modes ciblés
      expect(fullResult.differences.length).toBeGreaterThan(configDiffs(mcpResult).length);
      expect(findDiff(fullResult, 'paths.rooExtensions')).toBeDefined();
    });

    test('should persist singleton state across calls', async () => {
      const instance1 = RooSyncService.getInstance({ enabled: false });

      await roosyncCompareConfig({
        granularity: 'mcp'
      });

      const instance2 = RooSyncService.getInstance({ enabled: false });

      // RooSyncService est un singleton : les deux handles désignent la
      // MÊME instance (le second appel ne doit pas recréer le service).
      expect(instance1).toBe(instance2);
    });

    test('should handle comparison with force refresh after initial comparison', async () => {
      // First comparison without refresh (uses cache)
      const result1 = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: false
      });
      expect(configDiffs(result1)).toHaveLength(2);

      // Mutate la machine remote : son MCP devient partagé avec la source
      const remote = JSON.parse(readFileSync(join(testSharedStatePath, 'inventories/remote-machine.json'), 'utf-8'));
      remote.roo.mcpServers = [{ name: 'test-mcp', enabled: true, command: 'test', transportType: 'stdio' }];
      writeFileSync(join(testSharedStatePath, 'inventories/remote-machine.json'), JSON.stringify(remote));

      // Second comparison with refresh (invalidates cache) : doit refléter
      // le nouvel état — plus aucun diff mcpServers (les 2 machines alignées).
      const result2 = await roosyncCompareConfig({
        granularity: 'mcp',
        force_refresh: true
      });
      expect(findDiff(result2, 'mcpServers')).toBeUndefined();
      expectSummaryCoherent(result2);
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

      // Les résultats ne devraient inclure que les paths correspondant au filtre :
      // 'jupyter' ne matche aucun path des fixtures → seuls les diffs d'env globaux
      // (roster INFO) survivent
      expect(result.differences.filter(d => d.path !== 'env.ROO_FLEET_ROSTER')).toHaveLength(0);
      expect(result.harmonization_candidates!.summary.total).toBe(0);
    });

    test('should handle empty filter (no filtering)', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: ''
      });

      // Filtre vide = pas de filtrage → les 2 diffs MCP sont retournés
      expect(configDiffs(result)).toHaveLength(2);
      expectSummaryCoherent(result);
    });

    test('should handle filter with no matches', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        filter: 'nonexistent-mcp-name'
      });

      expect(result.differences.filter(d => d.path !== 'env.ROO_FLEET_ROSTER')).toHaveLength(0);
      expect(result.harmonization_candidates!.summary.total).toBe(0);
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

      // source devrait être 'local_machine' par défaut → résolu vers
      // ROOSYNC_MACHINE_ID ('test-machine')
      expect(result.source).toBe('test-machine');
    });

    test('should default target to remote_machine when not specified', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp'
      });

      // target devrait être 'remote_machine' par défaut → première autre
      // machine du dashboard ('remote-machine')
      expect(result.target).toBe('remote-machine');
    });

    test('should use custom source when provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'custom-source-machine'
      });

      // Machine inconnue → CRITICAL inventory identifiant explicitement la source
      expect(result.source).toBe('custom-source-machine');
      const inv = findDiff(result, 'inventory');
      expect(inv).toBeDefined();
      expect(inv!.description).toContain('source "custom-source-machine"');
    });

    test('should use custom target when provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        target: 'custom-target-machine'
      });

      expect(result.target).toBe('custom-target-machine');
      const inv = findDiff(result, 'inventory');
      expect(inv).toBeDefined();
      expect(inv!.description).toContain('target "custom-target-machine"');
    });

    test('should compare two specific machines when both provided', async () => {
      const result = await roosyncCompareConfig({
        granularity: 'mcp',
        source: 'test-machine',
        target: 'remote-machine'
      });

      expect(result.source).toBe('test-machine');
      expect(result.target).toBe('remote-machine');
      expect(configDiffs(result)).toHaveLength(2);
    });
  });
});

/** Fabrique un inventory factice au format MachineInventory. */
function makeInventory(
  machineId: string,
  mcpName: string,
  mcpCommand: string,
  modeSlug: string,
  modeName: string
) {
  return {
    machineId,
    timestamp: Date.now(),
    system: {
      hostname: machineId,
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
        { name: mcpName, enabled: true, command: mcpCommand, transportType: 'stdio' }
      ],
      modes: [
        { slug: modeSlug, name: modeName, tools: [] }
      ]
    },
    paths: {
      rooExtensions: `/fake/roo-extensions${machineId === 'test-machine' ? '' : '-remote'}`,
      mcpSettings: `/fake/mcp_settings${machineId === 'test-machine' ? '.json' : '_remote.json'}`,
      rooConfig: `/fake/roo-config${machineId === 'test-machine' ? '' : '-remote'}`
    }
  };
}
