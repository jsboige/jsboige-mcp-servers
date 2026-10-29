/**
 * #4131 Phase D — remote inventories become PG-first.
 *
 * Locks the read and write sides of the blocker removal:
 *
 *   read : PG row present → served from PG, the G: file is NOT read;
 *          PG row absent  → the G: file serves (contract migration-012);
 *          PG row held by ANOTHER machineId → typed error, never a silent
 *          fallback to a stale file.
 *   write: PG upsert first, G: file a tolerated mirror; a PG failure does
 *          not lose the publish (mirror still written).
 *
 * Same hoisted-mock harness as InventoryService.coverage.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(() => '7.4.6'),
}));

vi.mock('fs/promises');
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
    hostname: vi.fn(() => 'test-machine'),
    type: vi.fn(() => 'Windows_NT'),
    release: vi.fn(() => '10.0.19045'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  };
});

vi.mock('../../../utils/shared-state-path.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared-state'),
  ensureStoreSubdir: vi.fn(),
}));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));
vi.mock('../../../utils/encoding-helpers.js', () => ({
  readJSONFileWithoutBOM: vi.fn(),
}));

const mockStoreMeta = vi.hoisted(() => ({
  readStoreMetaValue: vi.fn(),
  upsertStoreMetaValue: vi.fn(),
  storeMetaUrl: vi.fn(),
}));
vi.mock('../../unified-store/store-meta.js', () => ({
  MACHINE_REGISTRY_META_KEY: 'machine_registry',
  inventoryMetaKey: (id: string) => `inventory:${id.toLowerCase()}`,
  readStoreMetaValue: mockStoreMeta.readStoreMetaValue,
  upsertStoreMetaValue: mockStoreMeta.upsertStoreMetaValue,
  storeMetaUrl: mockStoreMeta.storeMetaUrl,
  deleteStoreMetaValue: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import * as fsPromises from 'fs/promises';
import { readJSONFileWithoutBOM } from '../../../utils/encoding-helpers.js';
import { InventoryService } from '../InventoryService.js';
import { InventoryCollectorError } from '../../../types/errors.js';

function inventoryFor(machineId: string): { machineId: string; hostname: string } {
  return { machineId, hostname: `${machineId}-host` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('7.4.6');
  mockStoreMeta.storeMetaUrl.mockReturnValue('postgresql://test');
  mockStoreMeta.readStoreMetaValue.mockResolvedValue(null);
  mockStoreMeta.upsertStoreMetaValue.mockResolvedValue(undefined);
  vi.mocked(readJSONFileWithoutBOM).mockImplementation(((filePath: string) => {
    const m = /inventories[\\/]([^\\/]+)\.json$/.exec(String(filePath));
    if (m) return Promise.resolve(inventoryFor(m[1]));
    return Promise.reject(Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' }));
  }) as any);
  vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined as any);
  process.env.ROOSYNC_SHARED_PATH = '/mock/shared-state';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ROOSYNC_SHARED_PATH;
});

describe('#4131 Phase D — loadRemoteInventory, PG-first', () => {
  it('PG row present → served from PG, G: file NOT read', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(JSON.stringify(inventoryFor('myia-a')));
    const svc = InventoryService.getInstance();

    const inv = await (svc as any).loadRemoteInventory('myia-a');

    expect(inv.machineId).toBe('myia-a');
    expect(mockStoreMeta.readStoreMetaValue).toHaveBeenCalledWith('inventory:myia-a');
    expect(readJSONFileWithoutBOM).not.toHaveBeenCalled();
  });

  it('PG row absent → the G: file serves (migration-012 contract)', async () => {
    const svc = InventoryService.getInstance();

    const inv = await (svc as any).loadRemoteInventory('myia-a');

    expect(inv.machineId).toBe('myia-a');
    expect(readJSONFileWithoutBOM).toHaveBeenCalledTimes(1);
  });

  it('PG row held by ANOTHER machineId → typed error, no silent file fallback', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(JSON.stringify(inventoryFor('someone-else')));
    const svc = InventoryService.getInstance();

    await expect((svc as any).loadRemoteInventory('myia-a')).rejects.toBeInstanceOf(
      InventoryCollectorError
    );
    expect(readJSONFileWithoutBOM).not.toHaveBeenCalled();
  });

  it('PG unreachable → file fallback, no crash', async () => {
    mockStoreMeta.readStoreMetaValue.mockRejectedValue(new Error('connection refused'));
    const svc = InventoryService.getInstance();

    const inv = await (svc as any).loadRemoteInventory('myia-a');

    expect(inv.machineId).toBe('myia-a');
    expect(readJSONFileWithoutBOM).toHaveBeenCalledTimes(1);
  });
});

describe('#4131 Phase D — review ms#1563 (Hermes 🟡) : ligne PG corrompue et ordre des gardes', () => {
  it('corrupt PG row (JSON invalide) → erreur TYPIÉE, PAS de repli fichier', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue('{not json at all');
    const svc = InventoryService.getInstance();

    await expect((svc as any).loadRemoteInventory('myia-a')).rejects.toBeInstanceOf(
      InventoryCollectorError
    );
    expect(readJSONFileWithoutBOM).not.toHaveBeenCalled();
  });

  it('ligne PG présente + ROOSYNC_SHARED_PATH absent → servi depuis PG quand même', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(JSON.stringify(inventoryFor('myia-a')));
    delete process.env.ROOSYNC_SHARED_PATH;
    const svc = InventoryService.getInstance();

    const inv = await (svc as any).loadRemoteInventory('myia-a');

    expect(inv.machineId).toBe('myia-a');
    expect(readJSONFileWithoutBOM).not.toHaveBeenCalled();
  });
});

describe('#4131 Phase D — saveToSharedState, PG-first with tolerated mirror', () => {
  it('upserts PG with the masked JSON, then writes the file mirror', async () => {
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledWith(
      'inventory:myia-a',
      expect.stringContaining('"machineId": "myia-a"')
    );
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('PG save fails → mirror still written, no throw', async () => {
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('pg down'));
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });
});
