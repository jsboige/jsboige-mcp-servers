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
 * La review ms#1576 (ai-01) a déplacé l'exigence : l'invariant annoncé
 * (« true ⇔ la ligne partagée liste ce siège ») ne tenait pas, pour deux
 * raisons que ce fichier verrouille désormais :
 *
 *   BLOQUANT #1 — la décision « déjà inscrit » se prenait sur la MÉMOIRE. Une
 *   mémoire portant notre siège (repli fichier, chargement précédent) alors
 *   que la ligne PG ne le porte pas renvoyait `true` sans jamais écrire.
 *   → `needsRegistryWrite` lit l'entrée de la LIGNE.
 *
 *   BLOQUANT #2 — l'`upsert` remplaçait la ligne entière : deux sièges qui
 *   démarrent ensemble s'écrasent, et celui qui a perdu peut avoir déjà
 *   vérifié sa propre présence. ai-01 a retiré son propre remède (délai
 *   aléatoire + vérification de surensemble) comme non prouvé
 *   (c.6495611063) : il faut une union ATOMIQUE côté stockage.
 *   → `mergeStoreMetaJsonMap`, et le client n'envoie QUE son propre siège.
 *
 * Le faux PG ci-dessous implémente le contrat de `mergeStoreMetaJsonMap`
 * (union appliquée sur l'état courant, dans la même opération). Ce que ces
 * tests prouvent est donc : le client ne peut pas écraser, et il converge
 * quand le stockage tient sa promesse. L'atomicité elle-même est portée par
 * le `INSERT … ON CONFLICT DO UPDATE` de `store-meta.ts` (verrou de ligne PG),
 * qui n'est pas exerçable ici sans base réelle — dit tel quel dans la PR.
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
  mergeStoreMetaJsonMap: vi.fn(),
  storeMetaUrl: vi.fn(),
}));

vi.mock('../../unified-store/store-meta.js', () => ({
  MACHINE_REGISTRY_META_KEY: 'machine_registry',
  inventoryMetaKey: (id: string) => `inventory:${id}`,
  readStoreMetaValue: mockStoreMeta.readStoreMetaValue,
  upsertStoreMetaValue: mockStoreMeta.upsertStoreMetaValue,
  mergeStoreMetaJsonMap: mockStoreMeta.mergeStoreMetaJsonMap,
  storeMetaUrl: mockStoreMeta.storeMetaUrl,
  deleteStoreMetaValue: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BaselineManager } from '../BaselineManager.js';

const LOCAL = 'myia-po-2025';
const OTHER = 'myia-po-2023';

function pgRow(machines: Record<string, unknown>): string {
  return JSON.stringify({ machines, lastUpdated: '2026-10-29T00:00:00.000Z' });
}

function seat(id: string, source = 'service', status = 'online'): Record<string, string> {
  return { machineId: id, firstSeen: '2026-10-28T00:00:00.000Z', lastSeen: '2026-10-28T00:00:00.000Z', source, status };
}

/**
 * Faux PG implémentant le CONTRAT de `mergeStoreMetaJsonMap` : une union
 * appliquée sur l'état courant au moment de l'écriture, jamais un
 * remplacement de la carte reçue du client.
 */
function installAtomicPg(initial: Record<string, any> = {}) {
  const state: { machines: Record<string, any> } = { machines: { ...initial } };
  /** Payloads reçus, dans l'ordre — chaque appel = une écriture du client. */
  const writes: Array<Record<string, any>> = [];

  mockStoreMeta.readStoreMetaValue.mockImplementation(async () =>
    JSON.stringify({ machines: state.machines, lastUpdated: '2026-10-29T00:00:00.000Z' })
  );
  mockStoreMeta.mergeStoreMetaJsonMap.mockImplementation(
    async (_key: string, field: string, incoming: string) => {
      const patch = JSON.parse(incoming);
      writes.push(patch[field] || {});
      // La fusion porte SUR l'état courant : un siège arrivé entre-temps survit.
      state.machines = { ...state.machines, ...(patch[field] || {}) };
      return JSON.stringify({ machines: state.machines, lastUpdated: patch.lastUpdated });
    }
  );

  return { state, writes };
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

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockFs.readFile.mockResolvedValue('{}');
  mockFs.writeFile.mockResolvedValue(undefined);
  mockStoreMeta.storeMetaUrl.mockReturnValue('postgresql://test');
  mockStoreMeta.readStoreMetaValue.mockResolvedValue(null);
  mockStoreMeta.upsertStoreMetaValue.mockResolvedValue(undefined);
  mockStoreMeta.mergeStoreMetaJsonMap.mockImplementation(
    async (_key: string, field: string, incoming: string) => incoming
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('#4131 (a) — le siège s\'inscrit au boot sur la ligne partagée', () => {
  it('1. siège ABSENT de la ligne PG → il s\'y ajoute, la ligne passe de 1 à 2 machines', async () => {
    const pg = installAtomicPg({ 'myia-ai-01': seat('myia-ai-01') });

    const mgr = await makeManager();
    expect(mgr.getKnownMachineIds()).toEqual(['myia-ai-01']);

    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(Object.keys(pg.state.machines).sort()).toEqual(['myia-ai-01', LOCAL]);
    // La source est celle du fichier historique : toute autre valeur ferait
    // passer l'inscription pour un conflit d'identité (validateMachineUniqueness).
    expect(pg.state.machines[LOCAL].source).toBe('service');
  });

  it('2. siège DÉJÀ présent et en ligne → aucune écriture (#2121b)', async () => {
    const pg = installAtomicPg({ [LOCAL]: seat(LOCAL), 'myia-ai-01': seat('myia-ai-01') });

    const mgr = await makeManager();
    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(pg.writes).toHaveLength(0);
    expect(mockStoreMeta.mergeStoreMetaJsonMap).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('3. présent mais hors ligne → auto-guérison, et l\'écriture ne porte QUE notre siège', async () => {
    // Un siège qui démarre est en ligne. L'écriture ne doit mentionner aucun
    // id étranger : c'est ce qui rend la fusion atomique inoffensive pour les
    // autres sièges, quoi qu'il arrive entre la lecture et l'écriture.
    const pg = installAtomicPg({ [LOCAL]: seat(LOCAL, 'service', 'offline'), 'myia-ai-01': seat('myia-ai-01') });

    const mgr = await makeManager();
    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(pg.writes).toHaveLength(1);
    expect(Object.keys(pg.writes[0])).toEqual([LOCAL]);
    expect(pg.state.machines[LOCAL].status).toBe('online');
  });

  it('4. la fusion sort sans notre id (écriture non aboutie) → nouvel essai, convergence dans le même boot', async () => {
    const pg = installAtomicPg({ 'myia-ai-01': seat('myia-ai-01') });

    // 1er appel : la fusion ne rapporte PAS notre siège (écriture perdue).
    // 2e appel : elle le rapporte.
    const realMerge = mockStoreMeta.mergeStoreMetaJsonMap.getMockImplementation() as
      ((key: string, field: string, incoming: string) => Promise<string>) | undefined;
    mockStoreMeta.mergeStoreMetaJsonMap
      .mockImplementationOnce(async () =>
        JSON.stringify({ machines: { 'myia-ai-01': seat('myia-ai-01') }, lastUpdated: '2026-10-29T00:00:00.000Z' })
      )
      .mockImplementation((key: string, field: string, incoming: string) =>
        realMerge!(key, field, incoming)
      );

    const mgr = await makeManager();
    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(mockStoreMeta.mergeStoreMetaJsonMap).toHaveBeenCalledTimes(2);
    expect(Object.keys(pg.state.machines)).toContain(LOCAL);
  });
});

describe('ms#1576 bloquant #1 — la décision se prend sur la LIGNE, jamais sur la mémoire', () => {
  it('la mémoire porte le siège, la ligne PG ne le porte pas → une écriture, puis true', async () => {
    // Repli fichier au chargement (ligne PG absente à ce moment), puis la ligne
    // existe mais ne nous liste pas : le seed de la première lecture n'a pas
    // abouti (son échec est toléré, cf. loadMachineRegistry). L'ANCIENNE
    // décision, prise sur `this.machineRegistry`, renvoyait `true` sans écrire
    // et laissait le siège absent jusqu'au redémarrage suivant.
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ machines: { [LOCAL]: seat(LOCAL) }, lastUpdated: '2026-10-29T00:00:00.000Z' }));
    mockStoreMeta.upsertStoreMetaValue.mockRejectedValue(new Error('seed perdu (simulé)'));

    const pg = installAtomicPg({});
    mockStoreMeta.readStoreMetaValue.mockResolvedValueOnce(null); // 1re lecture : ligne absente
    // puis installAtomicPg sert l'état courant (vide au départ)

    const mgr = await makeManager();
    expect(mgr.getKnownMachineIds()).toEqual([LOCAL]); // la mémoire nous porte bien

    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    // Témoin de mutation : revenir à la décision mémoire (`mergeSharedRegistry`)
    // fait tomber ce compte à 0 et laisse la ligne vide.
    expect(pg.writes).toHaveLength(1);
    expect(pg.state.machines[LOCAL]).toBeDefined();
  });

  it('présent dans la ligne et en ligne, absent de la mémoire → aucune réécriture, mémoire alignée sur la ligne', async () => {
    installAtomicPg({ [LOCAL]: seat(LOCAL) });

    const mgr = await makeManager();
    expect(mgr.getKnownMachineIds()).toEqual([LOCAL]);

    const registered = await mgr.registerLocalMachineFromBoot();

    expect(registered).toBe(true);
    expect(mockStoreMeta.mergeStoreMetaJsonMap).not.toHaveBeenCalled();
  });
});

describe('ms#1576 bloquant #2 — deux sièges qui démarrent ensemble ne se perdent pas', () => {
  it('entrelacement de deux BaselineManager sur la même ligne → les deux ids sortent présents', async () => {
    const pg = installAtomicPg({ 'myia-ai-01': seat('myia-ai-01') });

    const a = await makeManager(LOCAL);
    const b = await makeManager(OTHER);

    const [ra, rb] = await Promise.all([
      a.registerLocalMachineFromBoot(),
      b.registerLocalMachineFromBoot(),
    ]);

    expect(ra).toBe(true);
    expect(rb).toBe(true);
    expect(Object.keys(pg.state.machines).sort()).toEqual([LOCAL, OTHER, 'myia-ai-01'].sort());

    // Le client n'a jamais envoyé d'id étranger : il ne peut donc pas écraser
    // l'inscription d'un voisin, même si sa lecture précède l'écriture du voisin.
    for (const write of pg.writes) {
      expect(Object.keys(write)).toHaveLength(1);
    }
  });
});

describe('#4131 (a) — l\'inscription au boot ne bloque pas le dashboard', () => {
  // Régression mesurée : le siège s'inscrit au boot avec la source `service`,
  // puis `loadDashboard` refuse de l'injecter au dashboard parce que la source
  // diffère — `getStatus` lève alors MACHINE_NOT_FOUND (e2e
  // « auto-enregistre la machine courante absente du dashboard »).
  it('le siège LOCAL ré-inscrit depuis un autre canal n\'est PAS un conflit d\'identité', async () => {
    installAtomicPg({ [LOCAL]: seat(LOCAL) });
    const mgr = await makeManager();

    const res = await (mgr as any).addMachineToRegistry(LOCAL, 'dashboard');

    expect(res.isValid).toBe(true);
    expect(res.conflictDetected).toBe(false);
  });

  it('un machineId ÉTRANGER reste un conflit — la garde d\'identité ne s\'affaiblit pas', async () => {
    installAtomicPg({ [OTHER]: seat(OTHER, 'baseline') });
    const mgr = await makeManager();

    const res = await (mgr as any).addMachineToRegistry(OTHER, 'dashboard');

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
    expect(mockStoreMeta.mergeStoreMetaJsonMap).not.toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('chargement aveugle (fichier illisible + ligne PG absente) → AUCUNE écriture', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    const mgr = await makeManager();
    vi.clearAllMocks();

    await mgr.registerLocalMachineFromBoot();

    expect(mockStoreMeta.mergeStoreMetaJsonMap).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
