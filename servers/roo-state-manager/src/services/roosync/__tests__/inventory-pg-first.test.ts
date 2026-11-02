/**
 * #4131 Phase D — remote inventories become PG-first.
 *
 * Locks the read and write sides of the blocker removal:
 *
 *   read : PG row present → served from PG, the G: file is NOT read;
 *          PG row absent  → the G: file serves (contract migration-012);
 *          PG row held by ANOTHER machineId → typed error, never a silent
 *          fallback to a stale file.
 *   write: PG upsert first; after a PG success the G: file is no longer
 *          written (end of dual-write, 03/11) unless the kill-switch
 *          UNIFIED_STORE_INVENTORY_PG_PRIMARY=0 is set; a PG failure or no
 *          PG at all does not lose the publish (mirror written).
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
import { InventoryService, INVENTORY_PG_PRIMARY_ENV } from '../InventoryService.js';
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

describe('#4131 Phase D — saveToSharedState, end of dual-write (03/11)', () => {
  const savedFlag = process.env[INVENTORY_PG_PRIMARY_ENV];
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[INVENTORY_PG_PRIMARY_ENV];
    else process.env[INVENTORY_PG_PRIMARY_ENV] = savedFlag;
  });

  it('default: PG upsert succeeds → the G: mirror is NOT written', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledWith(
      'inventory:myia-a',
      expect.stringContaining('"machineId": "myia-a"')
    );
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('flag explicitly ON (=1) behaves as the default: no mirror after a PG success', async () => {
    process.env[INVENTORY_PG_PRIMARY_ENV] = '1';
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it.each(['0', 'false', 'off', ' OFF '])(
    'kill-switch %j → the mirror is written again after the PG success, with the SAME masked text',
    async (value) => {
      process.env[INVENTORY_PG_PRIMARY_ENV] = value;
      const svc = InventoryService.getInstance();

      await (svc as any).saveToSharedState(inventoryFor('myia-a'));

      expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
      const [filePath, written] = vi.mocked(fsPromises.writeFile).mock.calls[0];
      expect(String(filePath)).toMatch(/inventories[\\/]myia-a\.json$/);
      expect(written).toBe(mockStoreMeta.upsertStoreMetaValue.mock.calls[0][1]);
    }
  );

  it('the kill-switch is read at CALL time, not at module load', async () => {
    const svc = InventoryService.getInstance();

    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    await (svc as any).saveToSharedState(inventoryFor('myia-a'));
    expect(fsPromises.writeFile).not.toHaveBeenCalled();

    process.env[INVENTORY_PG_PRIMARY_ENV] = '0';
    await (svc as any).saveToSharedState(inventoryFor('myia-a'));
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('PG save fails → mirror still written (only surface left), no throw', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('pg down'));
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('PG not configured (no store-meta URL) → mirror written, PG never touched', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);
    const svc = InventoryService.getInstance();

    await (svc as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('the kill-switch env name is the one documented for operators', () => {
    expect(INVENTORY_PG_PRIMARY_ENV).toBe('UNIFIED_STORE_INVENTORY_PG_PRIMARY');
  });
});
