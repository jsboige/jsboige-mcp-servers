/**
 * #4131 (file d, ai-01) — InventoryCollector.saveToSharedState devient PG-first.
 *
 * Ce writer écrivait `inventories/{id}-{timestamp}.json` sans aucune porte PG :
 * après le 03/11, tout siège local sans ligne PG ni fichier serait reparti sur
 * G:. Il suit maintenant le même gating qu'InventoryService :
 *
 *   - ligne PG (contenu masqué) = la surface ; le fichier horodaté n'est plus
 *     écrit après un succès PG, sauf kill-switch UNIFIED_STORE_INVENTORY_PG_PRIMARY=0 ;
 *   - PG en échec ou non configuré → le fichier horodaté reste le repli ;
 *   - une publication non canonique (majuscules) n'écrit NULLE part — même
 *     règle (a) qu'InventoryService, la clé étant normalisée en minuscules ;
 *   - la cause d'un échec PG reste lisible au journal (describeError, jamais
 *     String() — "[object Object]" mesuré au journal le 02/11).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStoreMeta = vi.hoisted(() => ({
  readStoreMetaValue: vi.fn(),
  upsertStoreMetaValue: vi.fn(),
  storeMetaUrl: vi.fn(),
}));

const mockWriteFile = vi.hoisted(() => vi.fn());

// Capter le journal sans dépendre de l'instance du lazy logger.
const mockLog = vi.hoisted(() => ({
  warn: [] as unknown[][],
  error: [] as unknown[][],
}));

vi.mock('fs', () => ({
  default: { promises: { writeFile: mockWriteFile } },
  promises: { writeFile: mockWriteFile },
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn()
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    hostname: vi.fn(() => 'test-machine'),
    homedir: vi.fn(() => '/mock/home')
  };
});

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn((...args: unknown[]) => {
      mockLog.warn.push(args);
    }),
    error: vi.fn((...args: unknown[]) => {
      mockLog.error.push(args);
    }),
    debug: vi.fn()
  })
}));

vi.mock('../../utils/git-helpers.js', () => ({
  getGitHelpers: () => ({
    verifyGitAvailable: vi.fn().mockResolvedValue({ available: true, version: 'git version 2.40.0' })
  })
}));

vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => '/mock/shared-state',
  ensureStoreSubdir: vi.fn()
}));

vi.mock('../unified-store/store-meta.js', () => ({
  inventoryMetaKey: (id: string) => `inventory:${id.toLowerCase()}`,
  readStoreMetaValue: mockStoreMeta.readStoreMetaValue,
  upsertStoreMetaValue: mockStoreMeta.upsertStoreMetaValue,
  storeMetaUrl: mockStoreMeta.storeMetaUrl,
  deleteStoreMetaValue: vi.fn()
}));

// La constante du kill-switch suffit — on ne charge pas InventoryService entier.
vi.mock('../roosync/InventoryService.js', () => ({
  INVENTORY_PG_PRIMARY_ENV: 'UNIFIED_STORE_INVENTORY_PG_PRIMARY'
}));

import { InventoryCollector, type MachineInventory } from '../InventoryCollector.js';
import { INVENTORY_PG_PRIMARY_ENV } from '../roosync/InventoryService.js';

function inventoryFor(machineId: string): MachineInventory {
  return {
    machineId,
    timestamp: '2026-11-02T12:00:00.000Z',
    inventory: {},
    paths: {}
  } as unknown as MachineInventory;
}

describe('#4131 — InventoryCollector.saveToSharedState, PG-first', () => {
  const savedFlag = process.env[INVENTORY_PG_PRIMARY_ENV];

  beforeEach(() => {
    vi.clearAllMocks();
    mockLog.warn.length = 0;
    mockLog.error.length = 0;
    delete process.env[INVENTORY_PG_PRIMARY_ENV];
    mockStoreMeta.storeMetaUrl.mockReturnValue('postgresql://test');
    mockStoreMeta.upsertStoreMetaValue.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    process.env.ROOSYNC_SHARED_PATH = '/mock/shared-state';
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[INVENTORY_PG_PRIMARY_ENV];
    else process.env[INVENTORY_PG_PRIMARY_ENV] = savedFlag;
    delete process.env.ROOSYNC_SHARED_PATH;
  });

  it('défaut : succès PG → la ligne est écrite, le fichier horodaté ne l’est PAS', async () => {
    const collector = new InventoryCollector();

    await (collector as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledWith(
      'inventory:myia-a',
      expect.stringContaining('"machineId": "myia-a"')
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveLength(0);
    expect(mockLog.error).toHaveLength(0);
  });

  it('kill-switch =0 → le fichier horodaté est réécrit après le succès PG', async () => {
    process.env[INVENTORY_PG_PRIMARY_ENV] = '0';
    const collector = new InventoryCollector();

    await (collector as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(String(mockWriteFile.mock.calls[0][0])).toMatch(/inventories[\\/]myia-a-.+\.json$/);
  });

  it('échec PG → repli fichier horodaté, cause LISIBLE au journal (pas "[object Object]")', async () => {
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue({ message: 'timeout expired', code: 'XX000' });
    const collector = new InventoryCollector();

    await (collector as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    // JSON.stringify des args : String([msg, obj]) rend précisément le
    // "[object Object]" qu'on chasse.
    const warned = mockLog.warn.map((args) => JSON.stringify(args)).join('\n');
    expect(warned).toContain('timeout expired');
    expect(warned).toContain('XX000');
    expect(warned).not.toContain('[object Object]');
  });

  it('PG non configuré → upsert jamais appelé, fichier horodaté écrit', async () => {
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);
    const collector = new InventoryCollector();

    await (collector as any).saveToSharedState(inventoryFor('myia-a'));

    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('publication NON canonique → aucune écriture (ni PG ni fichier)', async () => {
    const collector = new InventoryCollector();

    await (collector as any).saveToSharedState(inventoryFor('Myia-A'));

    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(String(mockLog.error[0])).toContain("'Myia-A'");
  });
});
