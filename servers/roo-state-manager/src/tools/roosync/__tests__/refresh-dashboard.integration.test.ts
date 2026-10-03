/**
 * Tests d'intégration pour roosync_refresh_dashboard
 *
 * Couvre les paramètres de l'outil :
 * - baseline: Machine à utiliser comme baseline (défaut: myia-ai-01)
 * - outputDir: Répertoire de sortie pour le dashboard (défaut: $ROOSYNC_SHARED_PATH/dashboards)
 *
 * Framework: Vitest
 * Type: Intégration (DashboardService réel, opérations filesystem réelles)
 *
 * @module roosync/refresh-dashboard.integration.test
 * @version 1.1.0 (#564 Phase 2b, #2639 renforcement assertions)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-refresh-dashboard');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncRefreshDashboard } from '../refresh-dashboard.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosync_refresh_dashboard (integration)', { testTimeout: 30000 }, () => {
  // Fix #634: Save original env var to restore after tests
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;

    // Reset singleton so it gets recreated with the test path
    RooSyncService.resetInstance();

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'dashboards'),
      join(testSharedStatePath, 'dashboard')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  });

  afterEach(async () => {
    // Reset singleton to prevent leaking test state to other test files
    RooSyncService.resetInstance();

    // Restore original env var
    if (originalSharedPath !== undefined) {
      process.env.ROOSYNC_SHARED_PATH = originalSharedPath;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }

    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour baseline
  // ============================================================

  describe('baseline parameter', () => {
    test('should use default baseline (myia-ai-01) when not specified', async () => {
      const result = await roosyncRefreshDashboard({});

      expect(result.success).toBe(true);
      expect(result.baseline).toBe('myia-ai-01');
      // Issue #799: nom de fichier FIXE (plus de timestamp)
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });

    test('should accept custom baseline machine', async () => {
      const result = await roosyncRefreshDashboard({
        baseline: 'myia-po-2023'
      });

      expect(result.success).toBe(true);
      expect(result.baseline).toBe('myia-po-2023');
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });

    test('should accept all valid machine IDs', async () => {
      const machines = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];

      for (const machine of machines) {
        const result = await roosyncRefreshDashboard({ baseline: machine });

        expect(result.success).toBe(true);
        expect(result.baseline).toBe(machine);
      }
    });
  });

  // ============================================================
  // Tests pour outputDir
  // ============================================================

  describe('outputDir parameter', () => {
    test('should use default outputDir when not specified', async () => {
      const result = await roosyncRefreshDashboard({});

      expect(result.success).toBe(true);
      // Le défaut écrit sous $ROOSYNC_SHARED_PATH/dashboards (refresh-dashboard.ts l.98)
      expect(result.dashboardPath).toContain(join(testSharedStatePath, 'dashboards'));
    });

    test('should accept custom outputDir', async () => {
      const customOutputDir = join(testSharedStatePath, 'custom-dashboards');

      const result = await roosyncRefreshDashboard({
        outputDir: customOutputDir
      });

      expect(result.success).toBe(true);
      expect(result.dashboardPath).toContain(customOutputDir);
      // Le script PS crée le répertoire (generate-mcp-dashboard.ps1 l.36-39)
      expect(existsSync(customOutputDir)).toBe(true);
    });

    test('should create outputDir if it does not exist', async () => {
      const nonExistentDir = join(testSharedStatePath, 'new-dashboards');

      // Verify directory doesn't exist
      expect(existsSync(nonExistentDir)).toBe(false);

      const result = await roosyncRefreshDashboard({
        outputDir: nonExistentDir
      });

      expect(result.success).toBe(true);
      // Directory created by the script (New-Item -Force, l.36-39)
      expect(existsSync(nonExistentDir)).toBe(true);
      expect(result.dashboardPath).toContain(nonExistentDir);
    });
  });

  // ============================================================
  // Tests de combinaison de paramètres
  // ============================================================

  describe('parameter combinations', () => {
    test('should handle both baseline and outputDir custom values', async () => {
      const result = await roosyncRefreshDashboard({
        baseline: 'myia-po-2025',
        outputDir: join(testSharedStatePath, 'test-output')
      });

      expect(result.success).toBe(true);
      expect(result.baseline).toBe('myia-po-2025');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should return valid result object', async () => {
      const result = await roosyncRefreshDashboard({});

      // Contrat RefreshDashboardResultSchema (refresh-dashboard.ts l.63-78)
      expect(result.success).toBe(true);
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
      // Nom de fichier fixe (#799) => le fallback ISO est TOUJOURS pris (l.135-136)
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.baseline).toBe('myia-ai-01');
      expect(Array.isArray(result.machines)).toBe(true);
      expect(result.metrics).toEqual({
        totalMachines: expect.any(Number),
        machinesWithInventory: expect.any(Number),
        machinesWithoutInventory: expect.any(Number)
      });
      // Cohérence métriques/parse (l.142-146) : totalMachines = machines.length
      expect(result.metrics.totalMachines).toBe(result.machines.length);
    });

    test('should include dashboard path in response', async () => {
      const result = await roosyncRefreshDashboard({});

      expect(result.success).toBe(true);
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
      // Chaque machine parsée porte les 3 champs du schéma {id, status, diffs}
      for (const machine of result.machines) {
        expect(machine).toEqual({
          id: expect.any(String),
          status: expect.any(String),
          diffs: expect.any(String)
        });
      }
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing shared state directory gracefully', async () => {
      // Supprimer le répertoire pour simuler l'absence
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncRefreshDashboard({});

      // L'outil ne retourne jamais success:false — il throw (l.159-162).
      // Retour effectif = succès complet du contrat.
      expect(result.success).toBe(true);
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });

    test('should handle invalid machine ID gracefully', async () => {
      const result = await roosyncRefreshDashboard({
        baseline: 'non-existent-machine'
      });

      // baseline inconnue: le script s'exécute quand même et l'outil
      // retourne le contrat complet avec la baseline demandée (l.92, l.155)
      expect(result.success).toBe(true);
      expect(result.baseline).toBe('non-existent-machine');
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle multiple consecutive refresh operations', async () => {
      // First refresh
      const result1 = await roosyncRefreshDashboard({});
      expect(result1.success).toBe(true);
      expect(result1.baseline).toBe('myia-ai-01');

      // Second refresh (should not conflict)
      const result2 = await roosyncRefreshDashboard({
        baseline: 'myia-po-2024'
      });
      expect(result2.success).toBe(true);
      expect(result2.baseline).toBe('myia-po-2024');
      // Fichier fixe (#799): les deux refresh écrivent le même chemin
      expect(result2.dashboardPath).toBe(result1.dashboardPath);
    });

    test('should persist dashboard state across operations', async () => {
      const baseline = 'myia-po-2026';
      const outputDir = join(testSharedStatePath, 'persist-test');

      // First operation
      const result1 = await roosyncRefreshDashboard({
        baseline,
        outputDir
      });
      expect(result1.success).toBe(true);

      // Second operation should use same state
      const result2 = await roosyncRefreshDashboard({
        baseline,
        outputDir
      });
      expect(result2.success).toBe(true);
      expect(result2.dashboardPath).toBe(result1.dashboardPath);
    });
  });
});
