/**
 * Tests unitaires pour roosyncRefreshDashboard
 *
 * Couvre refresh-dashboard.ts (lignes 23-217) :
 * - roosyncRefreshDashboard : success, ROOSYNC_SHARED_PATH manquant,
 *   dashboard path introuvable, erreur exec, parsing dashboard
 *
 * @module tools/roosync/__tests__/refresh-dashboard.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────── hoisted mocks (évite les problèmes de hoisting) ───────────────────

const mockExec = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ exec: mockExec }));
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

function setupExecSuccess(stdout: string, stderr = '') {
  mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
    callback(null, { stdout, stderr });
    return {} as any;
  });
}

function setupExecFailure(errorMessage: string) {
  mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
    callback(new Error(errorMessage), { stdout: '', stderr: '' });
    return {} as any;
  });
}

// ─────────────────── tests ───────────────────

describe('roosyncRefreshDashboard', () => {
  const originalEnv = process.env.ROOSYNC_SHARED_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
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
    setupExecSuccess(`Fichier: ${dashboardPath}\nDone.`);

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

  test('utilise la baseline et outputDir passés en paramètre', async () => {
    const dashboardPath = '/custom/out/mcp-dashboard-2026-02-22_11-00-00.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({ baseline: 'myia-po-2025', outputDir: '/custom/out' });

    const execCall = mockExec.mock.calls[0][0] as string;
    expect(execCall).toContain('myia-po-2025');
    expect(execCall).toContain('/custom/out');
  });

  test('utilise outputDir par défaut basé sur ROOSYNC_SHARED_PATH', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    await roosyncRefreshDashboard({});

    const execCall = mockExec.mock.calls[0][0] as string;
    expect(execCall).toContain('/mock/shared/path/dashboards');
  });

  test('timestamp utilise toISOString si pas de match de pattern dans le chemin', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/custom-name.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockResolvedValue('');

    const result = await roosyncRefreshDashboard({});

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('gère stderr non-fatal contenant WARNING', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`, 'WARNING: some PowerShell warning');
    mockReadFile.mockResolvedValue('');

    const result = await roosyncRefreshDashboard({});
    expect(result.success).toBe(true);
  });

  // ── erreurs ──

  test('lève une erreur si ROOSYNC_SHARED_PATH non défini', async () => {
    delete process.env.ROOSYNC_SHARED_PATH;

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('ROOSYNC_SHARED_PATH non configuré');
  });

  test('lève une erreur si exec échoue', async () => {
    setupExecFailure('pwsh not found');

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('Erreur lors du rafraîchissement du dashboard');
  });

  test('lève une erreur si le chemin dashboard introuvable dans stdout', async () => {
    setupExecSuccess('Script done. No path returned.');

    await expect(roosyncRefreshDashboard({}))
      .rejects.toThrow('Impossible de déterminer le chemin du dashboard');
  });

  // ── parsing dashboard (parseDashboardMachines) ──

  test('parseDashboardMachines : retourne [] si readFile échoue', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await roosyncRefreshDashboard({});

    expect(result.machines).toEqual([]);
    expect(result.metrics.totalMachines).toBe(0);
  });

  test('parseDashboardMachines : parse correctement plusieurs lignes', async () => {
    const dashboardPath = '/mock/shared/path/dashboards/mcp-dashboard-2026-02-22_11-00-00.md';
    setupExecSuccess(`Fichier: ${dashboardPath}`);

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
    setupExecSuccess(`Fichier: ${dashboardPath}`);

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
