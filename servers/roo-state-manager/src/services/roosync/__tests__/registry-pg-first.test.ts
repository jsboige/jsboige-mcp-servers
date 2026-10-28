/**
 * #4131 Phase D — the machine registry becomes PG-first.
 *
 * Locks the four behaviors the blocker removal promised (#4131 Phase D table
 * row 10, measured 28/10: 87/87 startups read the G: file, and a failed read
 * degraded to an empty Map IN SILENCE):
 *
 *   1. PG row present     → served from PG, the G: file is NOT read;
 *   2. PG row absent      → the G: file serves AND seeds PG (self-migrating);
 *   3. PG unreachable     → the G: file serves, no crash, no seed;
 *   4. nothing readable   → empty registry but an ERROR line naming BOTH
 *                           causes — registry-empty ≠ fleet-empty (#3459).
 *
 * Save side: PG upsert first, G: file a tolerated mirror; both failing is
 * an error line, never silence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted fs mock — BaselineManager imports `{ promises as fs, existsSync, constants }`.
const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  promises: mockFs,
  existsSync: mockExistsSync,
  constants: { R_OK: 4 },
  mkdirSync: vi.fn(),
}));

// Hoisted store-meta mock — the PG surface under test.
const mockStoreMeta = vi.hoisted(() => ({
  readStoreMetaValue: vi.fn(),
  upsertStoreMetaValue: vi.fn(),
  storeMetaUrl: vi.fn(),
}));

vi.mock('../../unified-store/store-meta.js', () => ({
  MACHINE_REGISTRY_META_KEY: 'machine_registry',
  inventoryMetaKey: (id: string) => `inventory:${id}`,
  readStoreMetaValue: mockStoreMeta.readStoreMetaValue,
  upsertStoreMetaValue: mockStoreMeta.upsertStoreMetaValue,
  storeMetaUrl: mockStoreMeta.storeMetaUrl,
  deleteStoreMetaValue: vi.fn(),
}));

// Logger mock — the assertions read the error lines the implementation must
// emit (registry-empty ≠ fleet-empty is only real if it is OBSERVABLE).
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BaselineManager } from '../BaselineManager.js';

const REGISTRY_FILE = { machines: { 'myia-a': { machineId: 'myia-a' }, 'myia-b': { machineId: 'myia-b' } } };

function pgRow(machines: Record<string, unknown>): string {
  return JSON.stringify({ machines, lastUpdated: '2026-10-28T00:00:00.000Z' });
}

async function makeManager(): Promise<BaselineManager> {
  const mgr = new BaselineManager(
    { machineId: 'test-machine', sharedPath: 'C:\\__no_such_mount__\\shared-state' } as any,
    { loadBaseline: vi.fn() },
    { listDiffs: vi.fn() }
  );
  await mgr.waitForRegistry();
  return mgr;
}

function errorCalls(mgr: BaselineManager): string[] {
  const logger = (mgr as any).logger;
  return logger.error.mock.calls.map((c: unknown[]) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockFs.readFile.mockResolvedValue('{}');
  mockFs.writeFile.mockResolvedValue(undefined);
  mockStoreMeta.storeMetaUrl.mockReturnValue('postgresql://test');
  mockStoreMeta.readStoreMetaValue.mockResolvedValue(null);
  mockStoreMeta.upsertStoreMetaValue.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('#4131 Phase D — registry load, PG-first', () => {
  it('1. PG row present → served from PG, G: file NOT read', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(pgRow(REGISTRY_FILE.machines));
    const mgr = await makeManager();

    expect(mgr.getKnownMachineIds().sort()).toEqual(['myia-a', 'myia-b']);
    // The G: file is a mirror, never a read source once PG holds the row.
    expect(mockFs.readFile).not.toHaveBeenCalled();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('2. PG row absent → G: file serves AND seeds PG once', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify(REGISTRY_FILE));

    const mgr = await makeManager();

    expect(mgr.getKnownMachineIds().sort()).toEqual(['myia-a', 'myia-b']);
    expect(mockStoreMeta.readStoreMetaValue).toHaveBeenCalledWith('machine_registry');
    const seed = mockStoreMeta.upsertStoreMetaValue.mock.calls[0];
    expect(seed[0]).toBe('machine_registry');
    expect(Object.keys(JSON.parse(seed[1]).machines).sort()).toEqual(['myia-a', 'myia-b']);
  });

  it('3. PG unreachable → G: file serves, no seed attempted', async () => {
    mockStoreMeta.readStoreMetaValue.mockRejectedValue(new Error('connection refused'));
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify(REGISTRY_FILE));

    const mgr = await makeManager();

    expect(mgr.getKnownMachineIds().sort()).toEqual(['myia-a', 'myia-b']);
    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
  });

  it('4. nothing readable → empty registry + ONE error line naming both causes', async () => {
    const mgr = await makeManager();

    expect(mgr.getKnownMachineIds()).toEqual([]);
    const lines = errorCalls(mgr).filter((l) => l.includes('[registry] VIDE'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pg: ligne absente');
    expect(lines[0]).toContain('fichier: absent');
  });

  it('no PG URL at all → file behavior, and the error line names the missing PG', async () => {
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);
    const mgr = await makeManager();

    expect(mockStoreMeta.readStoreMetaValue).not.toHaveBeenCalled();
    const lines = errorCalls(mgr).filter((l) => l.includes('[registry] VIDE'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pg: absent (pas d'URL PG)");
  });
});

describe('#4131 Phase D — registry save, PG-first with tolerated mirror', () => {
  it('save upserts PG first, then writes the G: mirror', async () => {
    const mgr = await makeManager();
    vi.clearAllMocks();

    await (mgr as any).addMachineToRegistry('myia-new', 'dashboard');

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
    const [key, value] = mockStoreMeta.upsertStoreMetaValue.mock.calls[0];
    expect(key).toBe('machine_registry');
    expect(Object.keys(JSON.parse(value).machines)).toContain('myia-new');
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('PG save fails → mirror still written, no throw', async () => {
    const mgr = await makeManager();
    vi.clearAllMocks();
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('pg down'));

    await (mgr as any).addMachineToRegistry('myia-new', 'dashboard');

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('both saves fail → one error line, never silence', async () => {
    const mgr = await makeManager();
    vi.clearAllMocks();
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('pg down'));
    mockFs.writeFile.mockRejectedValue(new Error('ENOENT'));

    await (mgr as any).addMachineToRegistry('myia-new', 'dashboard');

    const lines = errorCalls(mgr).filter((l) => l.includes('AUCUNE sauvegarde'));
    expect(lines).toHaveLength(1);
  });
});
