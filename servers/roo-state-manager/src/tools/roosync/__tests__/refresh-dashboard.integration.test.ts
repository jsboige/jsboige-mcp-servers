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
 * @version 1.2.0 (#2639 11e réactivation : le shell est mocké à la frontière)
 */
/*
 * #2639 (2026-10-05) — POURQUOI LE SHELL EST MOCKÉ ICI.
 *
 * L'exclusion CI de ce fichier portait « platform-dependent : shell dur vers pwsh ».
 * Mesuré faux : `pwsh` S'EXÉCUTE (aucune erreur de shell, Windows comme runner
 * ubuntu). Ce qui manque est le **script du dépôt parent**
 * (`scripts/roosync/generate-mcp-dashboard.ps1`) — `findRooExtensionsRoot()`
 * (refresh-dashboard.ts l.23-46) remonte l'arbre à la recherche d'un `CLAUDE.md` ;
 * dans un checkout **submodule autonome** (la CI) il n'en trouve aucun, retombe sur
 * `process.cwd()` (= servers/roo-state-manager) et vise donc un script inexistant.
 * Rouge d'abord mesuré : 13/13 `Command failed: pwsh … roo-state-manager\scripts\
 * roosync\generate-mcp-dashboard.ps1`. C'est une dépendance **PARENT_REPO**, pas
 * une dépendance de plateforme.
 *
 * Le mock remplace le SEUL point de contact avec l'extérieur (l.114-119) et
 * reproduit le **contrat du script**, pas son implémentation :
 *   - `New-Item -Force` de l'outputDir        (generate-mcp-dashboard.ps1 l.35-39)
 *   - écriture de `mcp-dashboard.md`          (l.31, l.317)
 *   - stdout portant `Fichier: <chemin>`      (lu par refresh-dashboard.ts l.127)
 *
 * Frontière de fidélité, assumée : le générateur PowerShell lui-même n'est plus
 * exercé ici. Il appartient au dépôt **parent**, qui porte son propre harnais.
 * Ce que ce fichier couvre, et couvre mieux qu'avant : construction de la commande
 * (script visé, `-Baseline`, `-OutputDir`), lecture de `Fichier:` sur stdout,
 * parsing du tableau markdown, métriques exactes, chemin d'erreur.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * État partagé avec le mock (hoisté : les fabriques `vi.mock` s'exécutent avant
 * les `import`, une simple `const` du corps serait en TDZ).
 */
const shell = vi.hoisted(() => ({
  /** Commandes reçues par `exec`, une par appel — le contrat de construction s'y lit. */
  commands: [] as string[],
  /** Force le prochain appel à échouer (couvre le chemin `throw` de l'outil). */
  failNext: false,
  /** Réussit mais sans marqueur `Fichier:` sur stdout (couverture l.127-134). */
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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { mkdirSync: mk, writeFileSync: wf } = await import('fs');
  const { join: j } = await import('path');

  const exec = (
    command: string,
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    shell.commands.push(command);

    if (shell.failNext) {
      shell.failNext = false;
      callback(new Error('Command failed: pwsh (fixture #2639 — échec forcé)'));
      return {} as never;
    }

    if (shell.noMarker) {
      shell.noMarker = false;
      callback(null, { stdout: 'Dashboard généré avec succès\n', stderr: '' });
      return {} as never;
    }

    const outputDir = /-OutputDir '([^']+)'/.exec(command)?.[1];
    if (!outputDir) {
      callback(new Error(`-OutputDir introuvable dans la commande : ${command}`));
      return {} as never;
    }

    try {
      mk(outputDir, { recursive: true });
      const dashboardPath = j(outputDir, 'mcp-dashboard.md');
      wf(dashboardPath, shell.fixture, 'utf8');
      callback(null, { stdout: `Dashboard généré avec succès\nFichier: ${dashboardPath}\n`, stderr: '' });
    } catch (error) {
      callback(error as Error);
    }
    return {} as never;
  };

  return { ...actual, exec };
});

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

    // Reset de l'observation du shell entre les tests
    shell.commands.length = 0;
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

    test('should build the PowerShell command against the detected repo root (#2639)', async () => {
      await roosyncRefreshDashboard({ baseline: 'myia-po-2025' });

      // Un appel shell par refresh, pas deux (anti double-exécution)
      expect(shell.commands).toHaveLength(1);
      const command = shell.commands[0];

      // Script visé : celui du repo root détecté (refresh-dashboard.ts l.106-107).
      // Construit avec `path.join` => séparateur de la plateforme.
      expect(command).toContain(join('scripts', 'roosync', 'generate-mcp-dashboard.ps1'));
      expect(command).toContain('-Baseline \'myia-po-2025\'');
      expect(command).toContain('pwsh -NoProfile -ExecutionPolicy Bypass');
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
      // Défaut construit par interpolation `${sharedPath}/dashboards` (l.98) =>
      // séparateur `/`, quelle que soit la plateforme — assertion volontairement
      // littérale, c'est la forme réellement envoyée au script.
      expect(shell.commands[0]).toContain(`-OutputDir '${testSharedStatePath}/dashboards'`);
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
      expect(shell.commands[0]).toContain(`-OutputDir '${customOutputDir}'`);
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
      // #2639 : la fixture étant connue, les métriques sont assertées EXACTES
      // (avant : `expect.any(Number)` — la formule l.142-146 n'était pas couverte)
      expect(result.metrics).toEqual({
        totalMachines: 3,
        machinesWithInventory: 2,
        machinesWithoutInventory: 1
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

    test('should throw a wrapped error when the generator fails (#2639)', async () => {
      // Chemin d'erreur jamais couvert avant #2639 : l'outil emballe l'échec du
      // shell dans `Erreur lors du rafraîchissement du dashboard` (l.159-162).
      shell.failNext = true;

      await expect(roosyncRefreshDashboard({})).rejects.toThrow(
        /Erreur lors du rafraîchissement du dashboard/
      );
    });

    test('should throw when stdout carries no dashboard path (#2639)', async () => {
      // Le contrat stdout est `Fichier: <chemin>` (l.127-134) : sans lui, l'outil
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
      // Un appel shell par refresh, deux au total
      expect(shell.commands).toHaveLength(2);
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
