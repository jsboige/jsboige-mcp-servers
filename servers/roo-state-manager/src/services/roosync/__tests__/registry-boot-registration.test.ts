/**
 * #4131 — auto-enregistrement du registre machines au boot PG-first
 * (arbitrage ai-01 (a), message `c.6490889143` : « auto-enregistrement au boot
 * PG-first comme nouveau défaut ; le semis manuel est rejeté »).
 *
 * Le trou mesuré le 29/10 : `addMachineToRegistry` n'avait que DEUX appelants,
 * tous deux dans `loadDashboard` (BaselineManager.ts:436,515) — or les flux
 * PG-first (`inventory`, `dashboard-pg`, `channel-pg`) ne passent jamais par
 * `loadDashboard`. Résultat : `machine_registry` restait au semis d'une seule
 * machine pendant que chaque siège écrivait bien SA ligne d'inventaire.
 *
 * Ce fichier verrouille les cinq propriétés du correctif :
 *
 *   1. un siège ABSENT de la ligne partagée s'y inscrit (1 → 2), source
 *      `service` — celle du fichier historique, sinon `validateMachineUniqueness`
 *      prend l'inscription pour un conflit d'identité ;
 *   2. un siège DÉJÀ présent ne réécrit rien (#2121b) ;
 *   3. une écriture concurrente entre la lecture et l'upsert ne fait pas perdre
 *      l'entrée d'un autre siège (union, jamais remplacement) ;
 *   4. si malgré tout l'upsert est écrasé, l'inscription se re-vérifie et
 *      converge (la perte est réparée dans le même boot) ;
 *   5. les gardes de ms#1563 tiennent : pas de PG → surface fichier seule ;
 *      chargement aveugle → AUCUNE écriture.
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

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BaselineManager } from '../BaselineManager.js';

const LOCAL = 'myia-po-2025';

function pgRow(machines: Record<string, unknown>): string {
  return JSON.stringify({ machines, lastUpdated: '2026-10-29T00:00:00.000Z' });
}

function seat(id: string, source = 'service', status = 'online'): Record<string, string> {
  return { machineId: id, firstSeen: '2026-10-28T00:00:00.000Z', lastSeen: '2026-10-28T00:00:00.000Z', source, status };
}

async function makeManager(machineId = LOCAL): Promise<BaselineManager> {
  const mgr = new BaselineManager(
    { machineId, sharedPath: '/__no_such_mount__/shared-state' } as any,
    { loadBaseline: vi.fn() },
    { listDiffs: vi.fn() }
  );
  await mgr.waitForRegistry();
  return mgr;
}

/** Machines written by the LAST PG upsert. */
function lastWrittenMachines(): Record<string, { source?: string }> {
  const calls = mockStoreMeta.upsertStoreMetaValue.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [key, raw] = calls[calls.length - 1];
  expect(key).toBe('machine_registry');
  return JSON.parse(raw).machines;
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

describe('#4131 (a) — le siège s\'inscrit au boot sur la ligne partagée', () => {
  it('1. siège ABSENT de la ligne PG → il s\'y ajoute, la ligne passe de 1 à 2 machines', async () => {
    mockStoreMeta.readStoreMetaValue
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01') })) // chargement constructeur
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01') })) // fusion avant écriture
      .mockResolvedValue(pgRow({ 'myia-ai-01': seat('myia-ai-01'), [LOCAL]: seat(LOCAL) })); // vérification

    const mgr = await makeManager();
    expect(mgr.getKnownMachineIds()).toEqual(['myia-ai-01']);

    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    const machines = lastWrittenMachines();
    expect(Object.keys(machines).sort()).toEqual(['myia-ai-01', LOCAL]);
    // La source est celle du fichier historique : toute autre valeur ferait
    // passer l'inscription pour un conflit d'identité (validateMachineUniqueness).
    expect(machines[LOCAL].source).toBe('service');
  });

  it('2. siège DÉJÀ présent → aucune réécriture de la ligne (#2121b)', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(pgRow({ [LOCAL]: seat(LOCAL), 'myia-ai-01': seat('myia-ai-01') }));

    const mgr = await makeManager();
    vi.clearAllMocks();
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(pgRow({ [LOCAL]: seat(LOCAL), 'myia-ai-01': seat('myia-ai-01') }));

    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('3. écriture concurrente entre la lecture et l\'upsert → l\'autre siège n\'est PAS perdu', async () => {
    // 1re lecture = chargement du constructeur ; la 2e (celle de l'inscription)
    // voit un siège arrivé entre-temps. Écrire la carte du boot écraserait son
    // entrée : la fusion doit relire la ligne partagée avant d'écrire.
    mockStoreMeta.readStoreMetaValue
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01') }))
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01'), 'myia-po-2023': seat('myia-po-2023') }))
      .mockResolvedValue(pgRow({ 'myia-ai-01': seat('myia-ai-01'), 'myia-po-2023': seat('myia-po-2023'), [LOCAL]: seat(LOCAL) }));

    const mgr = await makeManager();
    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(Object.keys(lastWrittenMachines()).sort()).toEqual(['myia-ai-01', 'myia-po-2023', LOCAL]);
  });

  it('4. upsert écrasé par un écrivain concurrent → re-vérification et convergence dans le même boot', async () => {
    const afterFirstUpsert = pgRow({ 'myia-ai-01': seat('myia-ai-01') }); // notre entrée a disparu
    const afterSecondUpsert = pgRow({ 'myia-ai-01': seat('myia-ai-01'), [LOCAL]: seat(LOCAL) });
    mockStoreMeta.readStoreMetaValue
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01') })) // load
      .mockResolvedValueOnce(pgRow({ 'myia-ai-01': seat('myia-ai-01') })) // merge avant 1er upsert
      .mockResolvedValueOnce(afterFirstUpsert) // vérification : absent → retry
      .mockResolvedValueOnce(afterFirstUpsert) // merge avant 2e upsert
      .mockResolvedValueOnce(afterSecondUpsert); // vérification : présent

    const mgr = await makeManager();
    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(mockStoreMeta.upsertStoreMetaValue).toHaveBeenCalledTimes(2);
    expect(Object.keys(lastWrittenMachines())).toContain(LOCAL);
  });
});

describe('#4131 (a) — l\'inscription au boot ne bloque pas le dashboard', () => {
  // Régression mesurée : le siège s'inscrit au boot avec la source `service`,
  // puis `loadDashboard` refuse de l'injecter au dashboard parce que la source
  // diffère — `getStatus` lève alors MACHINE_NOT_FOUND (e2e
  // « auto-enregistre la machine courante absente du dashboard »).
  it('le siège LOCAL ré-inscrit depuis un autre canal n\'est PAS un conflit d\'identité', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(pgRow({ [LOCAL]: seat(LOCAL) }));
    const mgr = await makeManager();

    const res = await (mgr as any).addMachineToRegistry(LOCAL, 'dashboard');

    expect(res.isValid).toBe(true);
    expect(res.conflictDetected).toBe(false);
  });

  it('un machineId ÉTRANGER reste un conflit — la garde d\'identité ne s\'affaiblit pas', async () => {
    mockStoreMeta.readStoreMetaValue.mockResolvedValue(
      pgRow({ 'myia-po-2023': seat('myia-po-2023', 'baseline') })
    );
    const mgr = await makeManager();

    const res = await (mgr as any).addMachineToRegistry('myia-po-2023', 'dashboard');

    expect(res.isValid).toBe(false);
    expect(res.conflictDetected).toBe(true);
  });
});

describe('#4131 (a) — les gardes de ms#1563 tiennent', () => {
  it('pas d\'URL PG → surface fichier seule, aucun appel PG', async () => {
    mockStoreMeta.storeMetaUrl.mockReturnValue(null);

    const mgr = await makeManager();
    vi.clearAllMocks();

    await mgr.registerLocalMachineFromBoot();

    expect(mockStoreMeta.readStoreMetaValue).not.toHaveBeenCalled();
    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('chargement aveugle (fichier illisible + ligne PG absente) → AUCUNE écriture', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    const mgr = await makeManager();
    vi.clearAllMocks();

    await mgr.registerLocalMachineFromBoot();

    expect(mockStoreMeta.upsertStoreMetaValue).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
