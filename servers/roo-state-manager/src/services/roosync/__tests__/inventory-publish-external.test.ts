/**
 * #4131 grain G-INV — external inventories publish PG-first through
 * `publishExternalInventory` (the surface `scripts/rsm-inventory-save.mjs`
 * consumes).
 *
 * Locks the grain's acceptance criterion and its immediate corollaries:
 *
 *   - PG reachable ⇒ 0 write on G: (upsert under the canonical row key,
 *     writeFile never called) — the measure of 08/11 18:00Z;
 *   - a mixed-case producer publishes the CANONICAL row (normalization
 *     before the identity guard), it is not refused;
 *   - PG down / unconfigured ⇒ the GDrive mirror is the fallback surface,
 *     and the outcome says so (the CLI exits on this verdict, not on logs);
 *   - the kill-switch still restores the mirror after a PG success;
 *   - a DIRECT non-canonical saveToSharedState call surfaces
 *     `refused: 'machineId-non-canonical'` — pinned so the outcome contract
 *     cannot silently drift.
 *
 * Same hoisted-mock harness as inventory-pg-first.test.ts.
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
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as fsPromises from 'fs/promises';
import { InventoryService, INVENTORY_PG_PRIMARY_ENV } from '../InventoryService.js';

function inventoryFor(machineId: string): { machineId: string; timestamp: string; inventory: Record<string, unknown> } {
  return {
    machineId,
    timestamp: '2026-11-05T21:00:00.000Z',
    inventory: { mcpServers: [], systemInfo: { hostname: machineId } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('7.4.6');
  mockStoreMeta.storeMetaUrl.mockReturnValue('postgresql://test');
  mockStoreMeta.readStoreMetaValue.mockResolvedValue(null);
  mockStoreMeta.upsertStoreMetaValue.mockResolvedValue(undefined);
  vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined as any);
  process.env.ROOSYNC_SHARED_PATH = '/mock/shared-state';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ROOSYNC_SHARED_PATH;
});

describe('#4131 grain G-INV — publishExternalInventory', () => {
  const savedFlag = process.env[INVENTORY_PG_PRIMARY_ENV];
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[INVENTORY_PG_PRIMARY_ENV];
    else process.env[INVENTORY_PG_PRIMARY_ENV] = savedFlag;
  });

  it('critère du grain : PG joignable ⇒ 0 écriture sur G:, verdict pgSaved', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('myia-a') as any);

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledWith(
      'inventory:myia-a',
      expect.stringContaining('"machineId": "myia-a"')
    );
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(outcome).toEqual({ pgSaved: true, mirrorSaved: false });
  });

  it('machineId à casse mixte dans le fichier → ligne canonique publiée (normalisation, pas refus)', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('Myia-A') as any);

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledWith(
      'inventory:myia-a',
      expect.stringContaining('"machineId": "myia-a"')
    );
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(outcome.pgSaved).toBe(true);
  });

  it('PG en échec → miroir GDrive écrit, verdict mirrorSaved (le CLI exit 0 sur ce verdict)', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('pg down'));
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('myia-a') as any);

    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    const [filePath] = vi.mocked(fsPromises.writeFile).mock.calls[0];
    expect(String(filePath)).toMatch(/inventories[\\/]myia-a\.json$/);
    expect(outcome).toEqual({ pgSaved: false, mirrorSaved: true });
  });

  it('PG non configuré → miroir GDrive écrit, PG jamais touché', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('myia-a') as any);

    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ pgSaved: false, mirrorSaved: true });
  });

  it('kill-switch =0 → miroir réécrit après le succès PG (comportement opérateur préservé)', async () => {
    process.env[INVENTORY_PG_PRIMARY_ENV] = '0';
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('myia-a') as any);

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ pgSaved: true, mirrorSaved: true });
  });

  it("la collecte n'est PAS relancée : la donnée du fichier fait foi (champ inconnu transporté tel quel)", async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    const svc = InventoryService.getInstance();
    const payload = { ...inventoryFor('myia-a'), marker: 'ginv-roundtrip' } as any;

    await svc.publishExternalInventory(payload);

    const published = JSON.parse(mockStoreMeta.upsertStoreMetaValue.mock.calls[0][1]);
    expect(published.marker).toBe('ginv-roundtrip');
  });
});

describe('#4131 grain G-INV — contrat du verdict saveToSharedState (épinglé pour le CLI)', () => {
  it("appel DIRECT non canonique → refused: 'machineId-non-canonical', rien écrit nulle part", async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    const svc = InventoryService.getInstance();

    const outcome = await (svc as any).saveToSharedState(inventoryFor('Myia-A'));

    expect(outcome).toEqual({
      pgSaved: false,
      mirrorSaved: false,
      refused: 'machineId-non-canonical',
    });
    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('PG et miroir en échec → verdict { false, false } sans throw (le CLI exit 1 sur ce verdict)', async () => {
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);
    vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('gdrive down') as any);
    const svc = InventoryService.getInstance();

    const outcome = await svc.publishExternalInventory(inventoryFor('myia-a') as any);

    expect(outcome).toEqual({ pgSaved: false, mirrorSaved: false });
  });
});
