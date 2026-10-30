/**
 * #2570 (récidive) — lecture du registre des machines TOLÉRANTE aux copies de
 * conflit DriveFS.
 *
 * Mesure du 30/10/2026 (myia-po-2028) : `.machine-registry.json` canonique
 * ABSENT du store partagé, seule la copie de conflit `.machine-registry (1).json`
 * présent (1 435 o, 3 machines). Tout lecteur qui ne connaît que le nom
 * canonique lisait le registre comme ABSENT — référence de flotte vide
 * (ROO_FLEET_ROSTER drift, CRITICAL).
 *
 * Le registre est ADD-ONLY (« il n'oublie aucune machine ») : la lecture doit
 * être l'UNION des copies, pas le choix de l'une d'elles. Aucun jumeau n'est
 * supprimé (préservation d'abord) — et une copie EXISTANTE mais illisible est
 * signalée à part : on ne l'écrase pas (ms#1563).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listMachineRegistryTwins,
  readMachineRegistryFile,
  machineRegistryPath
} from '../machine-registry-file.js';

function writeRegistry(path: string, machines: Record<string, any>, lastUpdated?: string) {
  writeFileSync(
    path,
    JSON.stringify({ machines, lastUpdated }, null, 2),
    'utf-8'
  );
}

describe('machine-registry-file — copies de conflit DriveFS (#2570)', () => {
  let sharedRoot: string;

  beforeEach(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), 'rsm-registry-twin-'));
  });

  afterEach(() => {
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  it('canonique ABSENT + un jumeau → le registre est lu depuis le jumeau', async () => {
    writeRegistry(join(sharedRoot, '.machine-registry (1).json'), {
      'myia-ai-01': { machineId: 'myia-ai-01', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-29T19:46:00.000Z', source: 'service', status: 'online' },
      'myia-po-2025': { machineId: 'myia-po-2025', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-29T19:46:00.000Z', source: 'service', status: 'online' },
      'myia-po-2028': { machineId: 'myia-po-2028', firstSeen: '2026-10-20T00:00:00.000Z', lastSeen: '2026-10-29T19:46:00.000Z', source: 'service', status: 'online' }
    });

    const read = await readMachineRegistryFile(sharedRoot);

    expect(read.data).not.toBeNull();
    expect(Object.keys(read.data!.machines).sort()).toEqual([
      'myia-ai-01',
      'myia-po-2025',
      'myia-po-2028'
    ]);
    expect(read.sources).toEqual([join(sharedRoot, '.machine-registry (1).json')]);
    expect(read.present).toBe(true);
    expect(read.canonicalUnreadable).toBe(false);
  });

  it('canonique + jumeau disjoints → l\'UNION des deux (aucune machine perdue)', async () => {
    writeRegistry(machineRegistryPath(sharedRoot), {
      'myia-ai-01': { machineId: 'myia-ai-01', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-29T19:00:00.000Z', source: 'service', status: 'online' }
    });
    writeRegistry(join(sharedRoot, '.machine-registry (1).json'), {
      'myia-po-2028': { machineId: 'myia-po-2028', firstSeen: '2026-10-20T00:00:00.000Z', lastSeen: '2026-10-29T19:46:00.000Z', source: 'service', status: 'online' }
    });

    const read = await readMachineRegistryFile(sharedRoot);

    expect(Object.keys(read.data!.machines).sort()).toEqual(['myia-ai-01', 'myia-po-2028']);
    expect(read.sources).toHaveLength(2);
  });

  it('même machine dans deux copies → firstSeen le plus ancien, lastSeen le plus récent', async () => {
    writeRegistry(machineRegistryPath(sharedRoot), {
      'myia-po-2028': {
        machineId: 'myia-po-2028',
        firstSeen: '2026-10-20T00:00:00.000Z',
        lastSeen: '2026-10-29T18:00:00.000Z',
        source: 'service',
        status: 'offline'
      }
    });
    writeRegistry(join(sharedRoot, '.machine-registry (1).json'), {
      'myia-po-2028': {
        machineId: 'myia-po-2028',
        firstSeen: '2026-10-19T00:00:00.000Z',
        lastSeen: '2026-10-29T19:46:00.000Z',
        source: 'dashboard',
        status: 'online'
      }
    });

    const read = await readMachineRegistryFile(sharedRoot);

    const entry = read.data!.machines['myia-po-2028'];
    expect(entry.firstSeen).toBe('2026-10-19T00:00:00.000Z');
    expect(entry.lastSeen).toBe('2026-10-29T19:46:00.000Z');
    // La connaissance la plus récente gagne (copie la plus fraîche).
    expect(entry.status).toBe('online');
    expect(entry.source).toBe('dashboard');
  });

  it('aucune copie → registre ABSENT (pas « vide »)', async () => {
    const read = await readMachineRegistryFile(sharedRoot);
    expect(read.data).toBeNull();
    expect(read.present).toBe(false);
    expect(read.unreadableSources).toEqual([]);
  });

  it('lecture = AUCUNE suppression : le jumeau est toujours là après la lecture', async () => {
    const twin = join(sharedRoot, '.machine-registry (1).json');
    writeRegistry(twin, { 'myia-ai-01': { machineId: 'myia-ai-01' } });

    await readMachineRegistryFile(sharedRoot);

    expect(existsSync(twin)).toBe(true);
  });

  it('listMachineRegistryTwins ignore tout ce qui n\'est pas un jumeau du registre', async () => {
    writeRegistry(machineRegistryPath(sharedRoot), {});
    writeRegistry(join(sharedRoot, '.machine-registry (1).json'), {});
    writeRegistry(join(sharedRoot, '.machine-registry (2).json'), {});
    writeFileSync(join(sharedRoot, 'autre (1).json'), '{}', 'utf-8');
    writeFileSync(join(sharedRoot, '.machine-registry.json.bak'), '{}', 'utf-8');

    const twins = await listMachineRegistryTwins(sharedRoot);

    expect(twins.map(p => p.split(/[\\/]/).pop())).toEqual([
      '.machine-registry (1).json',
      '.machine-registry (2).json'
    ]);
  });

  it('une copie illisible ne fait pas tomber la lecture (copies restantes lues)', async () => {
    writeRegistry(machineRegistryPath(sharedRoot), {
      'myia-ai-01': { machineId: 'myia-ai-01', lastSeen: '2026-10-29T19:00:00.000Z' }
    });
    writeFileSync(join(sharedRoot, '.machine-registry (1).json'), '{ ceci n est pas du json', 'utf-8');

    const read = await readMachineRegistryFile(sharedRoot);

    expect(read.data).not.toBeNull();
    expect(Object.keys(read.data!.machines)).toEqual(['myia-ai-01']);
    expect(read.unreadableSources).toEqual([join(sharedRoot, '.machine-registry (1).json')]);
    expect(read.canonicalUnreadable).toBe(false);
  });

  it('canonique ILLISIBLE → signalée à part : jamais écrasée (ms#1563)', async () => {
    writeFileSync(machineRegistryPath(sharedRoot), '{ ceci n est pas du json', 'utf-8');
    writeRegistry(join(sharedRoot, '.machine-registry (1).json'), {
      'myia-po-2028': { machineId: 'myia-po-2028', lastSeen: '2026-10-29T19:46:00.000Z' }
    });

    const read = await readMachineRegistryFile(sharedRoot);

    // Le jumeau reste lisible…
    expect(read.data).not.toBeNull();
    expect(Object.keys(read.data!.machines)).toEqual(['myia-po-2028']);
    // …mais le canonique illisible est signalé : l'appelant refuse d'écrire.
    expect(read.canonicalUnreadable).toBe(true);
    expect(read.unreadableSources).toContain(machineRegistryPath(sharedRoot));
  });

  it('le contenu du registre survit au round-trip : machines + lastUpdated', async () => {
    writeRegistry(
      machineRegistryPath(sharedRoot),
      { 'myia-ai-01': { machineId: 'myia-ai-01', lastSeen: '2026-10-29T19:00:00.000Z' } },
      '2026-10-29T19:00:00.000Z'
    );

    const read = await readMachineRegistryFile(sharedRoot);

    expect(read.data!.lastUpdated).toBe('2026-10-29T19:00:00.000Z');
    expect(JSON.parse(readFileSync(machineRegistryPath(sharedRoot), 'utf-8')).machines['myia-ai-01']).toBeDefined();
  });
});
