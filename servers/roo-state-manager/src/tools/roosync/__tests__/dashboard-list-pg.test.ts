/**
 * ms#1432 review (bloquants 1+2, ai-01 CHANGES 14/10 22:59Z) — la branche PG
 * de handleList ne doit JAMAIS sous-montrer en silence.
 *
 * Avant le fix : des clés vivantes listées par `listRooSyncDashboardKeysFromPg()`
 * mais illisibles en lecture par clé (null/throw — p.ex. rows d'index sans
 * journal, mapRowsToDashboard en échec) rendaient `success: true, « 0 (ou N<M)
 * dashboard(s) trouvé(s) [source: PG] »` — la forme #3459 exacte que le
 * commentaire d'en-tête du chemin prétendait interdire, et la divergence #4187
 * renée sur les hôtes gate-ON.
 *
 * Le fix : la vue PG n'est servie que COMPLÈTE (un résumé par clé vivante,
 * hors retirées) ; incomplète → repli sur le readdir GDrive (remède préféré de
 * la review) avec le manque déclaré dans le message. Cas « toutes retirées » :
 * liveKeys = 0 = vue complète à zéro, réponse vraie.
 *
 * Harness : même forme que dashboard-retirement.test.ts — store espionné à la
 * frontière du module (importOriginal + overrides), tmpdir par test. La
 * vectorisation de la review (a) list OK + reads OK → PG ; (b) list OK +
 * lectures en échec → repli, jamais 0 silencieux ; + le cas partiel (1/2) et
 * le bord toutes-retirées.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

const { listKeysSpy, pgReadSpy, listRetiredSpy, getRetirementSpy } = vi.hoisted(() => ({
  listKeysSpy: vi.fn(),
  pgReadSpy: vi.fn(),
  listRetiredSpy: vi.fn(),
  getRetirementSpy: vi.fn(),
}));

vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listRooSyncDashboardKeysFromPg: listKeysSpy,
    readDashboardFromPg: pgReadSpy,
    listRetiredDashboardKeys: listRetiredSpy,
    getDashboardRetirement: getRetirementSpy,
  };
});

import { roosyncDashboard } from '../dashboard.js';

let testDir: string;
let dashboardsDir: string;

/** Fixture : un dashboard PG complet pour une clé (shape mapRowsToDashboard). */
function pgDashboard(key: string, lastModified: string) {
  return {
    type: key.startsWith('machine-') ? 'machine' : 'workspace',
    key,
    lastModified,
    lastModifiedBy: { machineId: 'seeder', workspace: 'pg' },
    status: { markdown: `## Status ${key}` },
    intercom: {
      messages: [
        {
          id: 'm1',
          timestamp: lastModified,
          author: { machineId: 'seeder', workspace: 'pg' },
          content: `contenu ${key}`,
        },
      ],
      totalMessages: 1,
    },
  };
}

/** Fixture : écrire un dashboard .md sur disque (format store, côté GDrive). */
function seedGdriveFile(filename: string, type: 'machine' | 'workspace', lastModified: string): void {
  mkdirSync(dashboardsDir, { recursive: true });
  const fm = [
    '---',
    `type: ${type}`,
    `lastModified: ${lastModified}`,
    'lastModifiedBy:',
    '  machineId: seeder',
    '  workspace: file',
    '---',
    '',
    '## Status',
    '',
    `*Statut de ${filename}.*`,
    '',
    '## Intercom (1 messages)',
    '',
    `### [${lastModified}] seeder|file`,
    '[msg: m1]',
    '',
    `contenu ${filename}`,
    '',
  ].join('\n');
  writeFileSync(path.join(dashboardsDir, filename), fm, 'utf8');
}

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `roosync-list-pg-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  // Layout canonique du store : `${ROOSYNC_SHARED_PATH}/dashboards` (la suite
  // retirement inclut « shared-state » dans sa VAR d'env, pas dans le chemin).
  dashboardsDir = path.join(testDir, 'dashboards');
  mkdirSync(dashboardsDir, { recursive: true });
  process.env.ROOSYNC_SHARED_PATH = testDir;
  process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  listKeysSpy.mockReset().mockResolvedValue(null);
  pgReadSpy.mockReset().mockResolvedValue(null);
  listRetiredSpy.mockReset().mockResolvedValue(new Set<string>());
  getRetirementSpy.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.ROOSYNC_SHARED_PATH;
  delete process.env.ROOSYNC_MACHINE_ID;
  delete process.env.ROOSYNC_WORKSPACE_ID;
});

describe('roosync_dashboard list — branche PG complète ou repli déclaré (#1432 review)', () => {
  it('vue PG complète : résumés PG servis de bout en bout, [source: PG]', async () => {
    listKeysSpy.mockResolvedValue(['workspace-alpha', 'machine-beta']);
    pgReadSpy.mockImplementation(async (key: string) =>
      key === 'workspace-alpha'
        ? pgDashboard('workspace-alpha', '2026-10-15T01:00:00.000Z')
        : pgDashboard('machine-beta', '2026-10-14T23:00:00.000Z')
    );

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    expect(r.message).toContain('[source: PG]');
    expect(r.dashboards).toHaveLength(2);
    // Tri par fraîcheur décroissante : alpha (15/10) avant beta (14/10).
    expect(r.dashboards[0].key).toBe('workspace-alpha');
    expect(r.dashboards[1].key).toBe('machine-beta');
    expect(r.dashboards[0].messageCount).toBe(1);
    // Aucune trace de repli — la vue est complète.
    expect(r.message).not.toContain('repli GDrive');
  });

  it('clés listées mais lectures null : REPLI GDrive, le 0 silencieux est impossible', async () => {
    listKeysSpy.mockResolvedValue(['workspace-alpha', 'machine-beta']);
    pgReadSpy.mockResolvedValue(null); // chaque lecture par clé échoue silencieusement
    // Le fichier GDrive d'alpha existe : le repli doit le servir.
    seedGdriveFile('workspace-alpha.md', 'workspace', '2026-10-15T02:00:00.000Z');

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    // Pas de vue PG servie comme complète…
    expect(r.message).not.toContain('[source: PG]');
    // …mais le manque est DÉCLARÉ dans le message du repli.
    expect(r.message).toContain('repli GDrive');
    expect(r.message).toContain('0/2');
    // La vue servie est celle de GDrive : alpha (fichier), pas 0 dashboards.
    expect(r.dashboards).toHaveLength(1);
    expect(r.dashboards[0].key).toBe('workspace-alpha');
  });

  it('vue PG partielle (1/2 lisible) : repli aussi — le prédicat est la complétude, pas la vacuité', async () => {
    listKeysSpy.mockResolvedValue(['workspace-alpha', 'machine-beta']);
    pgReadSpy.mockImplementation(async (key: string) =>
      key === 'workspace-alpha' ? pgDashboard('workspace-alpha', '2026-10-15T01:00:00.000Z') : null
    );
    // Les deux fichiers existent côté GDrive : le repli sert les deux.
    seedGdriveFile('workspace-alpha.md', 'workspace', '2026-10-15T01:00:00.000Z');
    seedGdriveFile('machine-beta.md', 'machine', '2026-10-14T23:00:00.000Z');

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    expect(r.message).not.toContain('[source: PG]');
    expect(r.message).toContain('1/2');
    expect(r.message).toContain('repli GDrive');
    // Vue GDrive complète : les deux clés restent visibles. NB : les fixtures
    // portent lastModified NON quoté (forme nue, parse YAML en Date) — le tri
    // à 2 éléments prouve aussi la normalisation ISO de parseDashboardMarkdown.
    expect(r.dashboards).toHaveLength(2);
  });

  it('toutes les clés retirées : « 0 [source: PG] » est une réponse VRAIE — pas de repli', async () => {
    listKeysSpy.mockResolvedValue(['workspace-old']);
    listRetiredSpy.mockResolvedValue(new Set(['workspace-old']));
    pgReadSpy.mockResolvedValue(null);

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    expect(r.message).toContain('0 dashboard(s) trouvé(s) [source: PG]');
    expect(r.message).not.toContain('repli GDrive');
    expect(r.dashboards).toHaveLength(0);
  });
});
