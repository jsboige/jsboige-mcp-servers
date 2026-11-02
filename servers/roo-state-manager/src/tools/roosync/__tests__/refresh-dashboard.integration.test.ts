/**
 * Tests d'intégration pour roosync_refresh_dashboard
 *
 * Couvre les paramètres de l'outil :
 * - baseline: Machine à utiliser comme baseline (défaut: myia-ai-01)
 * - outputDir: Répertoire de sortie (défaut: $ROOSYNC_SHARED_PATH/dashboards)
 *
 * Framework: Vitest
 * Type: Intégration (DashboardService réel, opérations filesystem réelles)
 *
 * @module roosync/refresh-dashboard.integration.test
 * @version 1.3.0 (#4149 : la frontière mockée est PowerShellExecutor.executeScript —
 *   spawn sans shell, argv -File — plus aucune chaîne de commande interpolée)
 */
/*
 * #2639 (2026-10-05) puis #4149 (2026-11-02) — POURQUOI LA FRONTIÈRE EST MOCKÉE ICI.
 *
 * L'exclusion CI historique portait « platform-dependent : shell dur vers pwsh ».
 * Mesuré faux : ce qui manque est le **script du dépôt parent**
 * (`scripts/roosync/generate-mcp-dashboard.ps1`) — `findRooExtensionsRoot()`
 * (refresh-dashboard.ts l.23-46) remonte l'arbre à la recherche d'un `CLAUDE.md` ;
 * dans un checkout **submodule autonome** (la CI) il n'en trouve aucun et vise
 * un script inexistant. C'est une dépendance **PARENT_REPO**, pas de plateforme.
 *
 * Le mock remplace le SEUL point de contact avec l'extérieur — depuis #4149 :
 * `PowerShellExecutor.executeScript` — et reproduit le **contrat du script**,
 * pas son implémentation :
 *   - `New-Item -Force` de l'outputDir        (generate-mcp-dashboard.ps1 l.35-39)
 *   - écriture de `mcp-dashboard.md`          (l.31, l.317)
 *   - stdout portant `Fichier: <chemin>`      (lu par refresh-dashboard.ts)
 *
 * Frontière de fidélité, assumée : le générateur PowerShell lui-même n'est pas
 * exercé ici (il appartient au dépôt parent), ni le spawn réel (couvert par
 * refresh-dashboard.injection.test.ts). Ce que ce fichier couvre : construction
 * de l'argv (script visé, `-Baseline`, `-OutputDir` en éléments distincts),
 * lecture de `Fichier:` sur stdout, parsing du tableau markdown, métriques
 * exactes, chemins d'erreur, repli powershell.exe.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * État partagé avec le mock (hoisted : les fabriques `vi.mock` s'exécutent avant
 * les `import`, une simple `const` du corps serait en TDZ).
 */
const shell = vi.hoisted(() => ({
  /** Appels reçus par `executeScript` : { scriptPath, argv, options } — le contrat de construction s'y lit. */
  calls: [] as Array<{ scriptPath: string; argv: string[]; options: Record<string, unknown> }>,
  /** Force le prochain appel à rejeter (couvre le chemin `throw` de l'outil). */
  failNext: false,
  /** Réussit mais sans marqueur `Fichier:` sur stdout (couverture extraction chemin). */
  noMarker: false,
  /** Tableau markdown minimal respectant le format lu par parseDashboardMachines. */
  fixture: [
    '# MCP Dashboard (fixture #2639)',
    '',
    '| Machine | Status | Diffs |',
    '|---|---|---|',
    '| myia-ai-01 | ✅ OK | 0 |',
    '| myia-po-2023 | ✅ OK | 2 |',
    '| myia-po-2024 | ❌ KO | 5 |',
    ''
  ].join('\n')
}));

vi.mock('../../../services/PowerShellExecutor.js', () => ({
  PowerShellExecutor: class MockPowerShellExecutor {
    constructor(_config?: Record<string, unknown>) {
      /* #4149 : config non observée ici — le repli powershell.exe est couvert
         en unitaire (refresh-dashboard.test.ts) où les configs sont capturées. */
    }
    executeScript = vi.fn(
      async (scriptPath: string, argv: string[], options: Record<string, unknown>) => {
        shell.calls.push({ scriptPath, argv: [...argv], options });

        if (shell.failNext) {
          shell.failNext = false;
          throw new Error('PowerShell execution failed: Command failed (fixture #4149 — échec forcé)');
        }

        if (shell.noMarker) {
          shell.noMarker = false;
          return { success: true, stdout: 'Dashboard généré avec succès\n', stderr: '', exitCode: 0, executionTime: 10 };
        }

        const i = argv.indexOf('-OutputDir');
        const outputDir = i !== -1 ? argv[i + 1] : undefined;
        if (!outputDir) {
          throw new Error(`-OutputDir introuvable dans l'argv : ${argv.join(' ')}`);
        }

        // fs réel (non mocké dans ce fichier) — import dynamique ESM, pas require
        const { mkdirSync: mk, writeFileSync: wf } = await import('fs');
        mk(outputDir, { recursive: true });
        const dashboardPath = join(outputDir, 'mcp-dashboard.md');
        wf(dashboardPath, shell.fixture, 'utf8');
        return { success: true, stdout: `Dashboard généré avec succès\nFichier: ${dashboardPath}\n`, stderr: '', exitCode: 0, executionTime: 10 };
      }
    );
  }
}));

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

    // Reset de l'observation de la frontière entre les tests
    shell.calls.length = 0;
    shell.failNext = false;

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

    test('should build the argv against the detected repo root (#4149)', async () => {
      await roosyncRefreshDashboard({ baseline: 'myia-po-2025' });

      // Un appel executeScript par refresh, pas deux (anti double-exécution)
      expect(shell.calls).toHaveLength(1);
      const { scriptPath, argv } = shell.calls[0];

      // Script visé : celui du repo root détecté (refresh-dashboard.ts).
      // Construit avec `path.join` => séparateur de la plateforme.
      expect(scriptPath).toContain(join('scripts', 'roosync', 'generate-mcp-dashboard.ps1'));

      // #4149 : forme ARGV — la baseline est un élément distinct, SANS quotes.
      const i = argv.indexOf('-Baseline');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe('myia-po-2025');
      // Aucune couche de shell : la valeur ne porte ni quote ni échappement
      expect(argv[i + 1]).not.toContain("'");
    });
  });

  // ============================================================
  // Tests pour outputDir
  // ============================================================

  describe('outputDir parameter', () => {
    test('should use default outputDir when not specified', async () => {
      const result = await roosyncRefreshDashboard({});

      expect(result.success).toBe(true);
      // Le défaut écrit sous $ROOSYNC_SHARED_PATH/dashboards (refresh-dashboard.ts)
      expect(result.dashboardPath).toContain(join(testSharedStatePath, 'dashboards'));
      // Défaut construit par interpolation `${sharedPath}/dashboards` =>
      // séparateur `/`, quelle que soit la plateforme — assertion volontairement
      // littérale, c'est la forme réellement envoyée au script.
      const { argv } = shell.calls[0];
      expect(argv[argv.indexOf('-OutputDir') + 1]).toBe(`${testSharedStatePath}/dashboards`);
    });

    test('should accept custom outputDir', async () => {
      const customOutputDir = join(testSharedStatePath, 'custom-dashboards');

      const result = await roosyncRefreshDashboard({
        outputDir: customOutputDir
      });

      expect(result.success).toBe(true);
      expect(result.dashboardPath).toContain(customOutputDir);
      // Le répertoire est créé par le script (generate-mcp-dashboard.ps1 l.36-39) — ici
      // reproduit par la bordure mockée, qui reçoit bien le chemin demandé.
      expect(existsSync(customOutputDir)).toBe(true);
      const { argv } = shell.calls[0];
      expect(argv[argv.indexOf('-OutputDir') + 1]).toBe(customOutputDir);
    });

    test('should create outputDir if it does not exist', async () => {
      const nonExistentDir = join(testSharedStatePath, 'new-dashboards');

      // Verify directory doesn't exist
      expect(existsSync(nonExistentDir)).toBe(false);

      const result = await roosyncRefreshDashboard({
        outputDir: nonExistentDir
      });

      expect(result.success).toBe(true);
      // Répertoire créé par la bordure (contrat du script : New-Item -Force, l.36-39)
      expect(existsSync(nonExistentDir)).toBe(true);
      expect(result.dashboardPath).toContain(nonExistentDir);
    });
  });

  // ============================================================
  // #4149 : injection — l'apostrophe traverse la frontière comme littéral
  // ============================================================

  describe('injection boundary (#4149)', () => {
    test("une apostrophe dans baseline atteint le script comme valeur brute, non exécutée", async () => {
      const payload = "x'; $env:PWNED_4149='oui'; '";
      const result = await roosyncRefreshDashboard({ baseline: payload });

      expect(result.success).toBe(true);
      const { argv } = shell.calls[0];
      const i = argv.indexOf('-Baseline');
      // La payload est UN élément argv, byte-identique — pas de séparation possible
      expect(argv[i + 1]).toBe(payload);
      // L'argv reste plat : 4 éléments exactement, aucune scission
      expect(argv).toHaveLength(4);
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

      // Contrat RefreshDashboardResultSchema (refresh-dashboard.ts)
      expect(result.success).toBe(true);
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
      // Nom de fichier fixe (#799) => le fallback ISO est TOUJOURS pris
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.baseline).toBe('myia-ai-01');
      expect(Array.isArray(result.machines)).toBe(true);
      // #2639 : la fixture étant connue, les métriques sont assertées EXACTES
      expect(result.metrics).toEqual({
        totalMachines: 3,
        machinesWithInventory: 2,
        machinesWithoutInventory: 1
      });
      // Cohérence métriques/parse : totalMachines = machines.length
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
      // #2639 : aller-retour complet stdout -> `Fichier:` -> lecture du fichier -> tableau
      expect(result.machines).toEqual([
        { id: 'myia-ai-01', status: '✅ OK', diffs: '0' },
        { id: 'myia-po-2023', status: '✅ OK', diffs: '2' },
        { id: 'myia-po-2024', status: '❌ KO', diffs: '5' }
      ]);
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

      // L'outil ne retourne jamais success:false — il throw.
      // Retour effectif = succès complet du contrat.
      expect(result.success).toBe(true);
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });

    test('should handle invalid machine ID gracefully', async () => {
      const result = await roosyncRefreshDashboard({
        baseline: 'non-existent-machine'
      });

      // baseline inconnue: le script s'exécute quand même et l'outil
      // retourne le contrat complet avec la baseline demandée
      expect(result.success).toBe(true);
      expect(result.baseline).toBe('non-existent-machine');
      expect(result.dashboardPath).toMatch(/mcp-dashboard\.md$/);
    });

    test('should throw a wrapped error when the generator fails (#4149)', async () => {
      // Chemin d'erreur : l'outil emballe l'échec du script dans
      // `Erreur lors du rafraîchissement du dashboard`.
      shell.failNext = true;

      await expect(roosyncRefreshDashboard({})).rejects.toThrow(
        /Erreur lors du rafraîchissement du dashboard/
      );
    });

    test('should throw when stdout carries no dashboard path (#2639)', async () => {
      // Le contrat stdout est `Fichier: <chemin>` : sans lui, l'outil
      // refuse de deviner plutôt que de rendre un chemin vide.
      shell.noMarker = true;

      await expect(roosyncRefreshDashboard({})).rejects.toThrow(
        /Impossible de déterminer le chemin du dashboard/
      );
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
      // Un appel executeScript par refresh, deux au total
      expect(shell.calls).toHaveLength(2);
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
