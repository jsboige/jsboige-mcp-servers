/**
 * #2570 (récidive) — Témoin : BaselineManager lit le registre des machines
 * depuis une copie de conflit DriveFS quand le nom canonique est ABSENT.
 *
 * Mesure du 30/10/2026 (myia-po-2028) : `.machine-registry.json` canonique
 * absent du store partagé, seul `.machine-registry (1).json` présent (3
 * machines) ⇒ le registre était lu comme ABSENT et la référence de flotte
 * s'effondrait (ROO_FLEET_ROSTER drift, CRITICAL).
 *
 * Le témoin est un fichier RÉEL (tmpdir), pas un mock : la seule preuve qui
 * compte est « la machine qui n'existe que dans le jumeau se retrouve dans
 * l'écriture canonique ».
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BaselineManager } from '../BaselineManager.js';

const passthroughCache = async (_key: string, fetchFn: () => Promise<any>) => fetchFn();

function seedRegistryTwin(sharedRoot: string, machines: Record<string, any>) {
  writeFileSync(
    join(sharedRoot, '.machine-registry (1).json'),
    JSON.stringify({ machines, lastUpdated: '2026-10-29T19:46:36.000Z' }, null, 2),
    'utf-8'
  );
}

describe('BaselineManager — registre forké DriveFS (#2570)', () => {
  let manager: BaselineManager;
  let sharedRoot: string;
  const mockConfig = () => ({
    machineId: 'test-machine',
    sharedPath: sharedRoot,
    cacheEnabled: true,
    cacheTTL: 300000
  });

  beforeEach(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), 'rsm-registry-twin-bm-'));
    manager = new BaselineManager(
      mockConfig() as any,
      { loadBaseline: vi.fn(), updateBaseline: vi.fn() } as any,
      { listDiffs: vi.fn() } as any,
      { getState: vi.fn(), getActiveBaseline: vi.fn(), getMachineMappings: vi.fn() } as any
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  it('canonique ABSENT, machine présente seulement dans le jumeau → elle survit dans l\'écriture canonique', async () => {
    writeFileSync(join(sharedRoot, 'sync-dashboard.json'), JSON.stringify({ machines: {} }), 'utf-8');
    seedRegistryTwin(sharedRoot, {
      'myia-po-2025': {
        machineId: 'myia-po-2025',
        firstSeen: '2026-10-01T00:00:00.000Z',
        lastSeen: '2026-10-29T19:46:36.000Z',
        source: 'service',
        status: 'online'
      }
    });

    // Le manager est (re)construit APRÈS le peuplement : son constructeur
    // lance la lecture du registre — un registre écrit après le constructeur
    // ne serait jamais vu (le debounce de #2121(b) rejoue le mêmeidiome).
    manager = new BaselineManager(
      mockConfig() as any,
      { loadBaseline: vi.fn(), updateBaseline: vi.fn() } as any,
      { listDiffs: vi.fn() } as any,
      { getState: vi.fn(), getActiveBaseline: vi.fn(), getMachineMappings: vi.fn() } as any
    );

    await manager.waitForRegistry();
    await manager.loadDashboard(passthroughCache);

    // Le canonique est (re)créé : c'est la sentinelle que les lecteurs qui ne
    // connaissent que ce nom retrouvent.
    const canonical = join(sharedRoot, '.machine-registry.json');
    expect(existsSync(canonical)).toBe(true);

    const written = JSON.parse(readFileSync(canonical, 'utf-8'));
    expect(written.machines['myia-po-2025']).toBeDefined();

    // Le jumeau n'est PAS supprimé (préservation avant toute suppression).
    expect(existsSync(join(sharedRoot, '.machine-registry (1).json'))).toBe(true);
  });

  it('canonique ABSENT et aucun jumeau → aucun fichier de registre inventé', async () => {
    writeFileSync(join(sharedRoot, 'sync-dashboard.json'), JSON.stringify({ machines: {} }), 'utf-8');

    await manager.waitForRegistry();
    await manager.loadDashboard(passthroughCache);

    // Le registre reste absent : le writer ajoute son propre siège, rien de plus.
    const canonical = join(sharedRoot, '.machine-registry.json');
    if (existsSync(canonical)) {
      const written = JSON.parse(readFileSync(canonical, 'utf-8'));
      expect(Object.keys(written.machines)).toEqual(['test-machine']);
    }
  });
});
