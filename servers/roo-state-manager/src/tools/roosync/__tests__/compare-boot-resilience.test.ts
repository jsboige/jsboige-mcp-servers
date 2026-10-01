/**
 * Tests #3975 — granularity "boot-resilience" de roosync_compare_config.
 *
 * Constat fondateur : reboot WU po-2025 (01/10/2026), Docker non reparti,
 * hub .50:3000 mort 5h30 — invisible de l'inventaire RSM. Le comparateur
 * doit séparer drift de CONFIG (signal) et RUNTIME (bruit INFO), et rendre
 * un statut de couverture plutôt que des diffs fantômes (#3545) quand un
 * côté n'a pas encore le bloc.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CompareConfigArgsSchema, roosyncCompareConfig } from '../compare-config.js';

const { mockGetConfig, mockGetInventory } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetInventory: vi.fn(),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: vi.fn(async () => ({
    getConfig: mockGetConfig,
    getInventory: mockGetInventory,
  })),
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'RooSyncServiceError';
      this.code = code;
    }
  },
}));

function block(overrides: Record<string, any> = {}) {
  return {
    collectedAt: new Date().toISOString(),
    dockerService: {
      name: 'com.docker.service',
      status: 'Running',
      startType: 'Auto',
    },
    scheduledTasks: [
      { name: 'Docker Desktop Auto-Start', state: 'Ready', lastRunTime: new Date().toISOString(), lastTaskResult: 0 },
    ],
    dockerDesktopAutoStart: { enabled: true },
    autoLogon: { enabled: false },
    windowsUpdate: { policyKeyPresent: true, noAutoRebootWithLoggedOnUsers: 1 },
    ...overrides,
  };
}

function fullInventory(machineId: string, bootResilience: any) {
  return {
    machineId,
    timestamp: new Date().toISOString(),
    inventory: { bootResilience },
    paths: {},
  };
}

describe('compare-config granularity boot-resilience (#3975)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({ machineId: 'myia-po-2024', sharedPath: '/shared' });
  });

  test('schema accepte la granularité boot-resilience', () => {
    const result = CompareConfigArgsSchema.parse({ granularity: 'boot-resilience' });
    expect(result.granularity).toBe('boot-resilience');
  });

  test('blocs identiques → zéro diff', async () => {
    mockGetInventory.mockImplementation(async (mid: string) => fullInventory(mid, block()));
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    expect(result.differences).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.granularity).toBe('boot-resilience');
  });

  test('bloc absent côté cible → garde de couverture (1 WARNING, pas de diffs fantômes)', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025' ? undefined : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].severity).toBe('WARNING');
    expect(result.differences[0].path).toBe('inventory.bootResilience.coverage');
    expect(result.differences[0].description).toContain('myia-po-2025');
  });

  test('StartType divergent → IMPORTANT (signal de survie reboot), status divergent → INFO runtime', async () => {
    // Cas po-2025 réel : service Manual au lieu d'Auto
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025'
        ? block({ dockerService: { name: 'com.docker.service', status: 'Stopped', startType: 'Manual' } })
        : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    const startTypeDiff = result.differences.find(d => d.path.endsWith('dockerService.startType'));
    expect(startTypeDiff).toBeDefined();
    expect(startTypeDiff!.severity).toBe('IMPORTANT');
    expect(startTypeDiff!.action).toBeDefined();
    const statusDiff = result.differences.find(d => d.path.endsWith('dockerService.status'));
    expect(statusDiff).toBeDefined();
    expect(statusDiff!.severity).toBe('INFO');
    expect(statusDiff!.description).toContain('[RUNTIME]');
    expect(result.summary.important).toBe(1);
    expect(result.summary.info).toBe(1);
  });

  test('drift scalaires config → WARNING chacun (autostart Desktop, autologon, politique WU)', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025'
        ? block({
            dockerDesktopAutoStart: { enabled: false },
            autoLogon: { enabled: true },
            windowsUpdate: { policyKeyPresent: true, noAutoRebootWithLoggedOnUsers: 0 },
          })
        : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    expect(result.differences.find(d => d.path.endsWith('dockerDesktopAutoStart.enabled'))?.severity).toBe('WARNING');
    expect(result.differences.find(d => d.path.endsWith('autoLogon.enabled'))?.severity).toBe('WARNING');
    expect(result.differences.find(d => d.path.endsWith('noAutoRebootWithLoggedOnUsers'))?.severity).toBe('WARNING');
    expect(result.summary.warning).toBe(3);
  });

  test('tâches planifiées : présence asymétrique WARNING, état divergent WARNING, lastTaskResult INFO', async () => {
    // Cas po-2025 réel : tâche Auto-Start jamais exécutée (267011) + tâche watchdog absente
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025'
        ? block({
            scheduledTasks: [
              { name: 'Docker Desktop Auto-Start', state: 'Ready', lastRunTime: null, lastTaskResult: 267011 },
            ],
          })
        : block({
            scheduledTasks: [
              { name: 'Docker Desktop Auto-Start', state: 'Ready', lastRunTime: new Date().toISOString(), lastTaskResult: 0 },
              { name: 'Watchdog-Docker-Desktop-Distro', state: 'Ready', lastRunTime: new Date().toISOString(), lastTaskResult: 0 },
            ],
          })
      )
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    const presence = result.differences.find(d => d.path.includes('Watchdog-Docker-Desktop-Distro'));
    expect(presence?.severity).toBe('WARNING');
    const lastResult = result.differences.find(d => d.path.includes('Auto-Start') && d.path.endsWith('lastTaskResult'));
    expect(lastResult?.severity).toBe('INFO');
    expect(lastResult?.description).toContain('267011');
  });

  test('bloc périmé (> 48h) → WARNING fraîcheur', async () => {
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025' ? block({ collectedAt: stale }) : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    const freshness = result.differences.find(d => d.path.endsWith('bootResilience.collectedAt'));
    expect(freshness?.severity).toBe('WARNING');
    expect(freshness?.description).toContain('myia-po-2025');
  });

  test('format MachineCollector (bootResilience top-level) reconnu', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      mid === 'myia-po-2025'
        ? { machineId: mid, timestamp: new Date().toISOString(), bootResilience: block({ autoLogon: { enabled: true } }), paths: {} }
        : fullInventory(mid, block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    expect(result.differences.find(d => d.path.endsWith('autoLogon.enabled'))?.severity).toBe('WARNING');
  });

  test('inventaire null côté cible → garde de couverture, pas de crash', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      mid === 'myia-po-2025' ? null : fullInventory(mid, block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience' });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].path).toBe('inventory.bootResilience.coverage');
  });

  test('detail=values inclut harmonization_candidates et les valeurs formatées', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025'
        ? block({ dockerDesktopAutoStart: { enabled: false } })
        : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience', detail: 'values' });
    const diff = result.differences.find(d => d.path.endsWith('dockerDesktopAutoStart.enabled'));
    expect(diff?.source_value).toBe('true');
    expect(diff?.target_value).toBe('false');
    expect(result.harmonization_candidates?.summary.total).toBe(1);
    expect(result.harmonization_candidates?.divergent_value[0].path).toContain('dockerDesktopAutoStart');
  });

  test('detail=paths omet les valeurs', async () => {
    mockGetInventory.mockImplementation(async (mid: string) =>
      fullInventory(mid, mid === 'myia-po-2025'
        ? block({ dockerDesktopAutoStart: { enabled: false } })
        : block())
    );
    const result = await roosyncCompareConfig({ source: 'myia-po-2024', target: 'myia-po-2025', granularity: 'boot-resilience', detail: 'paths' });
    const diff = result.differences.find(d => d.path.endsWith('dockerDesktopAutoStart.enabled'));
    expect(diff?.source_value).toBeUndefined();
    expect(result.harmonization_candidates).toBeUndefined();
  });
});
