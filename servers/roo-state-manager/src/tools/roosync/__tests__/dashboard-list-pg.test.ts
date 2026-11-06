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
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';

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

import { roosyncDashboard, classifyMirrorDivergence, MIRROR_DIVERGENCE_THRESHOLD_MS } from '../dashboard.js';

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

// ─── #4187 : classifyMirrorDivergence (pur) ─────────────────────────────────

describe('classifyMirrorDivergence (#4187, pur)', () => {
  it('fichier plus frais que le miroir PG au-delà du seuil → file-newer', () => {
    const pg = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const fileMtime = Date.now();
    const v = classifyMirrorDivergence(pg, fileMtime);
    expect(v.diverged).toBe(true);
    expect(v.direction).toBe('file-newer');
    expect(v.gapMs).toBeGreaterThan(MIRROR_DIVERGENCE_THRESHOLD_MS);
  });

  it('miroir PG plus frais au-delà du seuil → pg-newer (direction inverse)', () => {
    const pg = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    const v = classifyMirrorDivergence(pg, Date.now());
    expect(v.diverged).toBe(true);
    expect(v.direction).toBe('pg-newer');
  });

  it('écart sous le seuil (latence normale du dual-write) → pas de divergence', () => {
    const pg = new Date(Date.now() - 60 * 1000).toISOString();
    expect(classifyMirrorDivergence(pg, Date.now()).diverged).toBe(false);
  });

  it('une seule surface présente → jamais divergent (fail-open)', () => {
    expect(classifyMirrorDivergence(undefined, Date.now()).diverged).toBe(false);
    expect(classifyMirrorDivergence(new Date().toISOString(), undefined).diverged).toBe(false);
  });

  it('horodatage PG illisible → fail-open, pas de faux positif', () => {
    expect(classifyMirrorDivergence('pas-un-iso', Date.now()).diverged).toBe(false);
  });

  it('miroir coupé (4e param) : écart > seuil dans les DEUX sens → pas divergent, état mirror-off nommé', () => {
    // file-newer : l'export a écrit le fichier après le dernier append PG.
    const pgOld = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const v1 = classifyMirrorDivergence(pgOld, Date.now(), MIRROR_DIVERGENCE_THRESHOLD_MS, true);
    expect(v1.diverged).toBe(false);
    expect(v1.expected).toBe('mirror-off');
    expect(v1.direction).toBe('file-newer');
    expect(v1.gapMs).toBeGreaterThan(MIRROR_DIVERGENCE_THRESHOLD_MS);
    // pg-newer : un append n'a pas encore été exporté vers le fichier.
    const pgNew = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    const v2 = classifyMirrorDivergence(pgNew, Date.now(), MIRROR_DIVERGENCE_THRESHOLD_MS, true);
    expect(v2.diverged).toBe(false);
    expect(v2.expected).toBe('mirror-off');
    expect(v2.direction).toBe('pg-newer');
  });

  it('miroir coupé : sous le seuil ou une seule surface → inchangé, pas d\'état parasite', () => {
    const pg = new Date(Date.now() - 60 * 1000).toISOString();
    const v = classifyMirrorDivergence(pg, Date.now(), MIRROR_DIVERGENCE_THRESHOLD_MS, true);
    expect(v.diverged).toBe(false);
    expect(v.expected).toBeUndefined();
    expect(
      classifyMirrorDivergence(undefined, Date.now(), MIRROR_DIVERGENCE_THRESHOLD_MS, true).expected
    ).toBeUndefined();
  });

  it('4e paramètre default = false : la signature à 3 arguments garde la sémantique #4187', () => {
    const pg = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const v = classifyMirrorDivergence(pg, Date.now());
    expect(v.diverged).toBe(true);
    expect(v.expected).toBeUndefined();
  });
});

// ─── #4187 : garde mirrorDiverged dans la branche PG de handleList ─────────

describe('roosync_dashboard list — garde mirrorDiverged (#4187)', () => {
  beforeEach(() => {
    // #4187 surveille un DUAL-WRITE : ses tests l'exercent miroir ON. Depuis
    // ms#1664 le défaut est « miroir coupé » (kill-switch absent) et l'état
    // mirror-off suspend l'instrument — sans cette ligne, ces tests ne
    // garderaient plus rien.
    process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR = '1';
  });
  afterEach(() => {
    delete process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR;
  });

  it('fichier GDrive plus frais que le miroir PG : entrée flaggée + divergence nommée dans le message', async () => {
    listKeysSpy.mockResolvedValue(['workspace-claudish']);
    // Miroir PG figé il y a 30 min (rows périmées — la fenêtre #4187)…
    pgReadSpy.mockResolvedValue(pgDashboard('workspace-claudish', new Date(Date.now() - 30 * 60 * 1000).toISOString()));
    // …pendant que le fichier vit (mtime = maintenant).
    seedGdriveFile('workspace-claudish.md', 'workspace', new Date().toISOString());

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    expect(r.message).toContain('[source: PG]');
    const entry = r.dashboards.find((d: any) => d.key === 'workspace-claudish');
    expect(entry.mirrorDiverged).toBe(true);
    expect(entry.mirrorDivergedDetail).toContain('fichier GDrive plus frais');
    expect(r.message).toContain('mirrorDiverged (#4187)');
    expect(r.message).toContain('workspace-claudish');
  });

  it('surfaces alignées : aucun flag, message inchangé', async () => {
    listKeysSpy.mockResolvedValue(['workspace-alpha']);
    pgReadSpy.mockResolvedValue(pgDashboard('workspace-alpha', new Date().toISOString()));
    seedGdriveFile('workspace-alpha.md', 'workspace', new Date().toISOString());

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    const entry = r.dashboards.find((d: any) => d.key === 'workspace-alpha');
    expect(entry.mirrorDiverged).toBeUndefined();
    expect(r.message).not.toContain('mirrorDiverged');
  });

  it('miroir PG plus frais que le fichier : flaggé aussi (moitié GDrive en retard)', async () => {
    listKeysSpy.mockResolvedValue(['machine-beta']);
    pgReadSpy.mockResolvedValue(pgDashboard('machine-beta', new Date().toISOString()));
    seedGdriveFile('machine-beta.md', 'machine', new Date().toISOString());
    // Le fichier a été écrit il y a 30 min puis plus rien (GDrive en retard).
    const back = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(path.join(dashboardsDir, 'machine-beta.md'), back, back);

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    const entry = r.dashboards.find((d: any) => d.key === 'machine-beta');
    expect(entry.mirrorDiverged).toBe(true);
    expect(entry.mirrorDivergedDetail).toContain('miroir PG plus frais');
    // Review ms#1440 — l'attribution ne doit PAS être inversée : en pg-newer,
    // les compteurs servis viennent de PG (FRAÎCHE) ; c'est la moitié fichier
    // qui est en retard. L'ancienne formulation « surface fichier, périmée »
    // décrivait la moitié qui n'est pas servie.
    expect(entry.mirrorDivergedDetail).toContain('compteurs servis viennent de PG (surface fraîche)');
    expect(entry.mirrorDivergedDetail).toContain('moitié fichier est en retard');
    expect(entry.mirrorDivergedDetail).not.toContain('surface fichier, périmée');
  });

  it('clé PG-sans-fichier : une seule surface, pas de divergence', async () => {
    listKeysSpy.mockResolvedValue(['workspace-pg-only']);
    pgReadSpy.mockResolvedValue(pgDashboard('workspace-pg-only', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()));
    // AUCUN fichier GDrive — dashboard né dégradé (G-B), légitime.

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    const entry = r.dashboards.find((d: any) => d.key === 'workspace-pg-only');
    expect(entry.mirrorDiverged).toBeUndefined();
    expect(r.message).not.toContain('mirrorDiverged');
  });
});

// ─── #4131 G-DASH suite : miroir coupé → #4187 suspendu, silence lisible ────

describe('roosync_dashboard list — miroir coupé : #4187 suspendu avec état nommé (#4131 G-DASH)', () => {
  beforeEach(() => {
    // Défaut post-ms#1664 : kill-switch ABSENT = miroir coupé. Explicitement
    // retiré pour que le défaut soit bien ce que ces tests mesurent.
    delete process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR;
  });
  afterEach(() => {
    delete process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR;
  });

  it('pg-newer massif (append jamais exporté) : PAS de flag, écart compté comme ATTENDU dans le message', async () => {
    listKeysSpy.mockResolvedValue(['workspace-cutover']);
    // PG vivant (append à l'instant), fichier figé il y a 30 min (cutover).
    pgReadSpy.mockResolvedValue(pgDashboard('workspace-cutover', new Date().toISOString()));
    seedGdriveFile('workspace-cutover.md', 'workspace', new Date().toISOString());
    const back = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(path.join(dashboardsDir, 'workspace-cutover.md'), back, back);

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    const entry = r.dashboards.find((d: any) => d.key === 'workspace-cutover');
    expect(entry.mirrorDiverged).toBeUndefined();
    expect(r.message).not.toContain('mirrorDiverged (#4187)');
    // Le silence est lisible : l'état « miroir coupé » est nommé, l'instrument
    // n'est pas mort en silence (exigence symétrique à la sonde #4340).
    expect(r.message).toContain('écart d\'export ATTENDU');
    expect(r.message).toContain('#4187 suspendu');
    expect(r.message).toContain('1 clé(s)');
  });

  it('file-newer (export écrit APRÈS le dernier append) : suspendu AUSSI — un export périodique en produirait en série', async () => {
    listKeysSpy.mockResolvedValue(['machine-quiet']);
    // Dashboard calme : dernier append il y a 40 min, export écrit à l'instant.
    const pgOld = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    pgReadSpy.mockResolvedValue(pgDashboard('machine-quiet', pgOld));
    seedGdriveFile('machine-quiet.md', 'machine', pgOld); // mtime = maintenant

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    expect(r.success).toBe(true);
    const entry = r.dashboards.find((d: any) => d.key === 'machine-quiet');
    expect(entry.mirrorDiverged).toBeUndefined();
    expect(r.message).not.toContain('mirrorDiverged (#4187)');
    expect(r.message).toContain('ATTENDU');
  });

  it('kill-switch posé (miroir réactivé) : l\'alarme #4187 REPREND — l\'état ne masque pas l\'autre', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR = '1';
    listKeysSpy.mockResolvedValue(['workspace-on']);
    const pgOld = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    pgReadSpy.mockResolvedValue(pgDashboard('workspace-on', pgOld));
    seedGdriveFile('workspace-on.md', 'workspace', pgOld); // mtime = maintenant → file-newer

    const r = (await roosyncDashboard({ action: 'list' })) as any;
    const entry = r.dashboards.find((d: any) => d.key === 'workspace-on');
    expect(entry.mirrorDiverged).toBe(true);
    expect(r.message).toContain('mirrorDiverged (#4187)');
  });
});
