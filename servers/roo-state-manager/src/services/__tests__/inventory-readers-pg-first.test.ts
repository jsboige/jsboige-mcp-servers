/**
 * #4131 Phase D (end of dual-write, 03/11) — the two inventory readers that
 * predate the PG row read it FIRST.
 *
 * Once a PG upsert succeeds, InventoryService no longer rewrites
 * `inventories/{machineId}.json` on G:, so a reader that only knows the file
 * would serve an inventory that ages forever. Locked here, for both
 * InventoryCollectorWrapper.loadFromSharedState (RooSyncService / baseline)
 * and InventoryCollector.loadFromSharedState:
 *
 *   PG row present     → served from PG, the G: file is NOT read;
 *   PG row absent      → the G: file serves, as before;
 *   PG unreachable     → the G: file serves, as before;
 *   PG row unreadable  → null, never the stale file;
 *   PG not configured  → PG never touched, the G: file serves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  existsSync: vi.fn(),
  readStoreMetaValue: vi.fn(),
  storeMetaUrl: vi.fn(),
  getMachineInventory: vi.fn(),
}));

vi.mock('fs', () => {
  const promises = { readFile: h.readFile, readdir: h.readdir, mkdir: vi.fn(), writeFile: vi.fn() };
  const api = { existsSync: h.existsSync, readFileSync: vi.fn(), mkdirSync: vi.fn(), promises };
  return { ...api, default: api };
});
vi.mock('child_process', () => ({
  exec: (_cmd: string, _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }),
}));
vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared'),
  ensureStoreSubdir: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../utils/git-helpers.js', () => ({
  getGitHelpers: () => ({
    verifyGitAvailable: vi.fn().mockResolvedValue({ available: true, version: 'git 2.40.0' }),
  }),
}));
vi.mock('../roosync/InventoryService.js', () => ({
  InventoryService: { getInstance: vi.fn(() => ({ getMachineInventory: h.getMachineInventory })) },
}));
vi.mock('../unified-store/store-meta.js', () => ({
  inventoryMetaKey: (id: string) => `inventory:${id.toLowerCase()}`,
  readStoreMetaValue: h.readStoreMetaValue,
  storeMetaUrl: h.storeMetaUrl,
}));

import { InventoryCollectorWrapper } from '../InventoryCollectorWrapper.js';
import { InventoryCollector } from '../InventoryCollector.js';

const MACHINE = 'remote-box';

/** The FullInventory text InventoryService upserts (and used to mirror). */
function fullInventoryText(timestamp: string, machineId = MACHINE): string {
  return JSON.stringify({
    machineId,
    timestamp,
    paths: { rooExtensions: 'D:/roo' },
    inventory: { systemInfo: { os: 'Windows 11', hostname: machineId } },
  });
}

const PG_TS = '2026-11-02T08:00:00.000Z';
const FILE_TS = '2026-10-29T22:04:00.000Z';

/** The G: side holds the exact `{machineId}.json`, with an OLDER timestamp. */
function staleFileOnG() {
  h.existsSync.mockImplementation((p: any) => String(p).includes('inventories'));
  h.readFile.mockResolvedValue(fullInventoryText(FILE_TS));
  h.readdir.mockResolvedValue([`${MACHINE}.json`]);
}

function makeWrapper() {
  const collector = {
    collectInventory: vi.fn().mockResolvedValue(null),
    getCacheStats: vi.fn(),
    clearCache: vi.fn(),
  } as unknown as InventoryCollector;
  return new InventoryCollectorWrapper(collector);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.storeMetaUrl.mockReturnValue('postgresql://test');
  h.readStoreMetaValue.mockResolvedValue(null);
  h.getMachineInventory.mockResolvedValue(null);
  staleFileOnG();
});

type Reader = { name: string; load: (machineId: string) => Promise<any> };

const readers: Reader[] = [
  {
    name: 'InventoryCollectorWrapper',
    load: (id) => (makeWrapper() as any).loadFromSharedState(id),
  },
  {
    name: 'InventoryCollector',
    load: (id) => (new InventoryCollector() as any).loadFromSharedState(id),
  },
];

describe.each(readers)('#4131 Phase D — $name.loadFromSharedState reads PG first', ({ load }) => {
  it('PG row present → served from PG (newer timestamp), the G: file is NOT read', async () => {
    h.readStoreMetaValue.mockResolvedValue(fullInventoryText(PG_TS));

    const inv = await load(MACHINE);

    expect(h.readStoreMetaValue).toHaveBeenCalledWith(`inventory:${MACHINE}`);
    expect(inv).not.toBeNull();
    expect(inv.machineId).toBe(MACHINE);
    expect(inv.timestamp).toBe(PG_TS);
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('the PG key is lower-cased like the writer (mixed-case machineId)', async () => {
    h.readStoreMetaValue.mockResolvedValue(fullInventoryText(PG_TS));

    await load('Remote-Box');

    expect(h.readStoreMetaValue).toHaveBeenCalledWith('inventory:remote-box');
  });

  it('PG row absent → the G: file serves, as before', async () => {
    const inv = await load(MACHINE);

    expect(h.readStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(h.readFile).toHaveBeenCalled();
    expect(inv.timestamp).toBe(FILE_TS);
  });

  it('PG unreachable → the G: file serves, no throw', async () => {
    h.readStoreMetaValue.mockRejectedValue(new Error('connection refused'));

    const inv = await load(MACHINE);

    expect(h.readFile).toHaveBeenCalled();
    expect(inv.timestamp).toBe(FILE_TS);
  });

  it('PG row present but unreadable → null, never the stale G: file', async () => {
    h.readStoreMetaValue.mockResolvedValue('{not json at all');

    const inv = await load(MACHINE);

    expect(inv).toBeNull();
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('PG not configured → PG never touched, the G: file serves', async () => {
    h.storeMetaUrl.mockReturnValue(null);

    const inv = await load(MACHINE);

    expect(h.readStoreMetaValue).not.toHaveBeenCalled();
    expect(inv.timestamp).toBe(FILE_TS);
  });
});

describe('#4131 Phase D — the PG-first read reaches the public entry points', () => {
  it('InventoryCollector.collectInventory(remote) returns the PG row and caches it', async () => {
    h.readStoreMetaValue.mockResolvedValue(fullInventoryText(PG_TS));
    const collector = new InventoryCollector();

    const first = await collector.collectInventory(MACHINE);
    const second = await collector.collectInventory(MACHINE);

    expect(first?.timestamp).toBe(PG_TS);
    expect(second).toBe(first);
    expect(h.readStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('InventoryCollectorWrapper.collectInventory returns the PG row before any local collection', async () => {
    h.readStoreMetaValue.mockResolvedValue(fullInventoryText(PG_TS));
    const collectInventory = vi.fn().mockResolvedValue(null);
    const wrapper = new InventoryCollectorWrapper({
      collectInventory,
      getCacheStats: vi.fn(),
      clearCache: vi.fn(),
    } as unknown as InventoryCollector);

    const inv = await wrapper.collectInventory(MACHINE);

    expect(inv?.timestamp).toBe(PG_TS);
    expect(collectInventory).not.toHaveBeenCalled();
    expect(h.getMachineInventory).not.toHaveBeenCalled();
  });
});
