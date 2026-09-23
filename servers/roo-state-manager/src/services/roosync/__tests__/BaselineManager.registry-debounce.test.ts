/**
 * Tests #2121(b) — BaselineManager.addMachineToRegistry debounce
 *
 * Review ai-01 sur #1202 : `registerMachineId` (roosync-config) n'est plus
 * atteint en production depuis le garde caller #452 (validateMachineIdUniqueness
 * rend conflictDetected pour SA PROPRE entrée → RooSyncService ne l'appelle
 * plus après la 1ʳᵉ inscription). Le writer VIVANT du `.machine-registry.json`
 * est `addMachineToRegistry` (appelé depuis loadDashboard quand la machine est
 * absente du dashboard). Ces tests pinent le debounce sur CE chemin-là :
 * dernière écriture seulement sur changement d'état (source/status), sinon
 * stamp en mémoire.
 *
 * Strategy: temp sharedRoot réel (mkdtemp), spy sur fs.promises.writeFile
 * (BaselineManager importe `{ promises as fs }` — même singleton).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BaselineManager } from '../BaselineManager.js';

const passthroughCache = async (_key: string, fetchFn: () => Promise<any>) => fetchFn();

function seedDashboard(sharedRoot: string, machines: any) {
  writeFileSync(
    join(sharedRoot, 'sync-dashboard.json'),
    JSON.stringify({ machines }),
    'utf-8'
  );
}

function seedRegistry(sharedRoot: string, machines: any) {
  writeFileSync(
    join(sharedRoot, '.machine-registry.json'),
    JSON.stringify({ machines, lastUpdated: '2026-09-22T00:00:00.000Z' }, null, 2),
    'utf-8'
  );
}

describe('BaselineManager #2121(b) registry debounce', () => {
  let manager: BaselineManager;
  let sharedRoot: string;
  const mockConfig = () => ({ machineId: 'test-machine', sharedPath: sharedRoot, cacheEnabled: true, cacheTTL: 300000 });

  beforeEach(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), 'rsm-registry-debounce-'));
    manager = new BaselineManager(
      mockConfig() as any,
      { loadBaseline: vi.fn(), updateBaseline: vi.fn() } as any,
      { listDiffs: vi.fn() } as any,
      { getState: vi.fn(), getActiveBaseline: vi.fn(), getMachineMappings: vi.fn() } as any
    );
    vi.spyOn(fsPromises, 'writeFile');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  it('état stable répété (même dashboard, même registre) → AUCUNE écriture au 2ᵉ passage', async () => {
    seedDashboard(sharedRoot, {});

    await manager.waitForRegistry();
    await manager.loadDashboard(passthroughCache);

    // 1ʳᵉ inscription → registre écrit
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    const firstWrite = fsPromises.writeFile.mock.calls[0][0];
    expect(String(firstWrite)).toContain('.machine-registry.json');

    // 2ᵉ passage (cold start / dashboard régénéré) → machine déjà au registre,
    // même source 'dashboard' et même status 'online' → aucune écriture
    await manager.loadDashboard(passthroughCache);
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('status offline pré-existant → ré-écriture (auto-guérison) + firstSeen préservé', async () => {
    seedDashboard(sharedRoot, {});
    seedRegistry(sharedRoot, {
      'test-machine': {
        machineId: 'test-machine',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-09-22T00:00:00.000Z',
        source: 'dashboard',
        status: 'offline'
      }
    });
    manager = new BaselineManager(
      mockConfig() as any,
      { loadBaseline: vi.fn(), updateBaseline: vi.fn() } as any,
      { listDiffs: vi.fn() } as any,
      { getState: vi.fn(), getActiveBaseline: vi.fn(), getMachineMappings: vi.fn() } as any
    );

    await manager.waitForRegistry();
    await manager.loadDashboard(passthroughCache);

    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(join(sharedRoot, '.machine-registry.json'), 'utf-8'));
    expect(written.machines['test-machine'].status).toBe('online');
    expect(written.machines['test-machine'].firstSeen).toBe('2026-01-01T00:00:00.000Z');
  });

  it("machine présente dans le dashboard → addMachineToRegistry pas invoqué, AUCUNE écriture (état de production stable)", async () => {
    seedDashboard(sharedRoot, {
      'test-machine': {
        lastSync: '2026-09-22T00:00:00.000Z',
        status: 'synced',
        diffsCount: 0,
        pendingDecisions: 0
      }
    });

    await manager.waitForRegistry();
    await manager.loadDashboard(passthroughCache);

    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });
});