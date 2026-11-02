/**
 * Tests unitaires pour roosyncRefreshDashboard
 *
 * #4149 : la frontière mockée est PowerShellExecutor.executeScript (spawn sans
 * shell, argv -File) — les assertions portent sur le TABLEAU d'arguments, plus
 * jamais sur une chaîne de commande interpolée.
 *
 * @module tools/roosync/__tests__/refresh-dashboard.test
 * @version 2.0.0 (#4149 : argv sans shell + repli powershell.exe)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// ─────────────────── hoisted mocks (évite les problèmes de hoisting) ───────────────────

const mockExecuteScript = vi.hoisted(() => vi.fn());
const mockCtorConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockAccessSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('../../../services/PowerShellExecutor.js', () => ({
  // #4149 : le SUT construit l'exécuteur (1er essai pwsh, repli powershell.exe) —
  // les configs sont capturées pour distinguer les deux instances.
  PowerShellExecutor: class MockPowerShellExecutor {
    constructor(config?: Record<string, unknown>) {
      mockCtorConfigs.push(config ?? {});
    }
    executeScript = mockExecuteScript;
  }
}));
vi.mock('fs', () => ({
  accessSync: mockAccessSync,
  default: { accessSync: mockAccessSync }
}));
vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  default: { readFile: mockReadFile }
}));

// ─────────────────── import SUT après mocks ───────────────────

import { roosyncRefreshDashboard } from '../refresh-dashboard.js';

// ─────────────────── helpers ───────────────────

function setupScriptSuccess(stdout: string, stderr = '', exitCode = 0) {
  mockExecuteScript.mockResolvedValue({ success: exitCode === 0, stdout, stderr, exitCode, executionTime: 12 });
}

function setupScriptReject(message: string) {
  mockExecuteScript.mockRejectedValue(new Error(message));
}

/** Args reçus par executeScript au i-ème appel : [scriptPath, argv, options]. */
function argvOfCall(i = 0): string[] {
  return mockExecuteScript.mock.calls[i][1] as string[];
}

// ─────────────────── tests ───────────────────

describe('roosyncRefreshDashboard', () => {
  const originalEnv = process.env.ROOSYNC_SHARED_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtorConfigs.length = 0;
    process.env.ROOSYNC_SHARED_PATH = '/mock/shared/path';
    // findRooExtensionsRoot: accessSync réussit dès la première tentative
    mockAccessSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ROOSYNC_SHARED_PATH = originalEnv;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }
  });

  // ── succès ──

  test('retourne success=true avec un dashboard généré', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}\nDone.`);

    const markdownContent = `# Dashboard

| Machine | Status | Diffs |
|---------|--------|-------|
| myia-ai-01 | ✅ | 0 |
| myia-web1 | ❌ | N/A |

Some other content
`;
    mockReadFile.mockResolvedValue(markdownContent);

    const result = await roosyncRefreshDashboard({});

    expect(result.success).toBe(true);
    expect(result.dashboardPath).toBe(dashboardPath);
    expect(result.baseline).toBe('myia-ai-01');
    expect(result.timestamp).toBe('2026-02-22_11-00-00');
    expect(result.machines).toHaveLength(2);
    expect(result.machines[0].id).toBe('myia-ai-01');
    expect(result.metrics.totalMachines).toBe(2);
    expect(result.metrics.machinesWithInventory).toBe(1);
    expect(result.metrics.machinesWithoutInventory).toBe(1);
  });

  test('utilise la baseline et outputDir passés en paramètre — en ARGV, un élément par valeur', async () => {
    const dashboardPath = '/custom/out/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({ baseline: 'myia-po-2025', outputDir: '/custom/out' });

    const argv = argvOfCall(0);
    // Forme argv plate : la valeur est un élément distinct, jamais concaténée
    expect(argv).toEqual(['-Baseline', 'myia-po-2025', '-OutputDir', '/custom/out']);
    // Le script est visé en chemin absolu via -File (posé par PowerShellExecutor,
    // ici mocké : le SUT lui passe le chemin détecté)
    const scriptPath = mockExecuteScript.mock.calls[0][0] as string;
    expect(scriptPath).toContain(join('scripts', 'roosync', 'generate-mcp-dashboard.ps1'));
  });

  test('utilise outputDir par défaut basé sur ROOSYNC_SHARED_PATH', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({});

    expect(argvOfCall(0)).toEqual(['-Baseline', 'myia-ai-01', '-OutputDir', '/mock/shared/path/dashboards']);
  });

  test('timestamp utilise toISOString si pas de match de pattern dans le chemin', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/custom-name.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    const result = await roosyncRefreshDashboard({});

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('gère stderr non-fatal contenant WARNING (exit 0)', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`, 'WARNING: some PowerShell warning');
    mockReadFile.mockResolvedValue('');

    const result = await roosyncRefreshDashboard({});
    expect(result.success).toBe(true);
  });

  // ── #4149 : injection fermée — l'apostrophe est un littéral ──

  test("#4149 : une apostrophe dans baseline reste UN seul élément argv littéral", async () => {
    const payload = "x'; $env:PWNED_4149='oui'; '";
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({ baseline: payload });

    const argv = argvOfCall(0);
    expect(argv).toEqual(['-Baseline', payload, '-OutputDir', '/mock/shared/path/dashboards']);
    // L'argv ne peut pas se scinder : exactement 4 éléments, aucun échappement.
    expect(argv.filter((a) => a.includes('Baseline'))).toHaveLength(1);
  });

  test("#4149 : une apostrophe dans outputDir reste UN seul élément argv littéral", async () => {
    const payload = "d'out'; Remove-Item -Recurse C:\\; '";
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({ outputDir: payload });

    expect(argvOfCall(0)).toEqual(['-Baseline', 'myia-ai-01', '-OutputDir', payload]);
  });

  test("#4149 : le repli powershell.exe ne se déclenche QUE sur ENOENT de spawn", async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard.md';
    // 1er essai (pwsh) : ENOENT ; repli (powershell.exe) : succès
    mockExecuteScript
      .mockRejectedValueOnce(new Error('PowerShell execution failed: spawn pwsh.exe ENOENT'))
      .mockResolvedValueOnce({ success: true, stdout: `Fichier: ${dashboardPath}`, stderr: '', exitCode: 0, executionTime: 20 });
    mockReadFile.mockResolvedValue('');

    const result = await roosyncRefreshDashboard({});

    expect(result.success).toBe(true);
    expect(mockCtorConfigs).toHaveLength(2);
    // Le repli porte explicitement powershell.exe (#2368)
    expect(mockCtorConfigs[1]).toMatchObject({ powershellPath: 'powershell.exe' });
    // Même argv rejoué à l'identique
    expect(argvOfCall(1)).toEqual(['-Baseline', 'myia-ai-01', '-OutputDir', '/mock/shared/path/dashboards']);
  });

  test("#4149 : «Script not found» n'est PAS un ENOENT de spawn — pas de repli, échec direct", async () => {
    mockExecuteScript.mockRejectedValue(new Error('Script not found: C:\\x\\generate-mcp-dashboard.ps1'));
    mockReadFile.mockResolvedValue('');

    await expect(roosyncRefreshDashboard({})).rejects.toThrow('Erreur lors du rafraîchissement du dashboard');
    expect(mockCtorConfigs).toHaveLength(1); // aucun repli
  });

  test("#4149 : pwsh ET powershell.exe absents — l'échec du repli remonte enveloppé", async () => {
    mockExecuteScript
      .mockRejectedValueOnce(new Error('PowerShell execution failed: spawn pwsh.exe ENOENT'))
      .mockRejectedValueOnce(new Error('PowerShell execution failed: spawn powershell.exe ENOENT'));

    await expect(roosyncRefreshDashboard({})).rejects.toThrow('Erreur lors du rafraîchissement du dashboard');
    expect(mockCtorConfigs).toHaveLength(2);
  });

  // ── erreurs ──

  test('lève une erreur si ROOSYNC_SHARED_PATH non défini', async () => {
    delete process.env.ROOSYNC_SHARED_PATH;

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('ROOSYNC_SHARED_PATH non configuré');
  });

  test('lève une erreur si le script échoue (exit non nul)', async () => {
    mockExecuteScript.mockResolvedValue({ success: false, stdout: '', stderr: 'boom', exitCode: 1, executionTime: 5 });

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('generate-mcp-dashboard.ps1 a échoué (exit 1)');
  });

  test('lève une erreur si executeScript rejette hors ENOENT', async () => {
    setupScriptReject('PowerShell execution failed: EACCES permission denied');

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('Erreur lors du rafraîchissement du dashboard');
  });

  test('lève une erreur si le chemin dashboard introuvable dans stdout', async () => {
    setupScriptSuccess('Script done. No path returned.');

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('Impossible de déterminer le chemin du dashboard');
  });

  // ── parsing dashboard (parseDashboardMachines) ──

  test('parseDashboardMachines : retourne [] si readFile échoue', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await roosyncRefreshDashboard({});

    expect(result.machines).toEqual([]);
    expect(result.metrics.totalMachines).toBe(0);
  });

  test('parseDashboardMachines : parse correctement plusieurs lignes', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);

    const content = `# MCP Dashboard

| Machine | Status | Diffs |
|---------|--------|-------|
| myia-ai-01 | ✅ Inventaire OK | 2 |
| myia-po-2023 | ✅ Inventaire OK | 0 |
| myia-web1 | ❌ Pas d'inventaire | N/A |

## Autre section
`;
    mockReadFile.mockResolvedValue(content);

    const result = await roosyncRefreshDashboard({});

    expect(result.machines).toHaveLength(3);
    expect(result.machines[0]).toEqual({ id: 'myia-ai-01', status: '✅ Inventaire OK', diffs: '2' });
    expect(result.metrics.machinesWithInventory).toBe(2);
    expect(result.metrics.machinesWithoutInventory).toBe(1);
  });

  test('parseDashboardMachines : arrête au premier non-pipe après le tableau', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupScriptSuccess(`Fichier: ${dashboardPath}`);

    const content = `| Machine | Status | Diffs |
|---|---|---|
| myia-ai-01 | ✅ | 0 |

This line stops the table
| ignored | row | here |
`;
    mockReadFile.mockResolvedValue(content);

    const result = await roosyncRefreshDashboard({});
    expect(result.machines).toHaveLength(1);
  });
});
