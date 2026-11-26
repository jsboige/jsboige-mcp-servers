/**
 * #4131 residual — repli PG de `read_archive`.
 *
 * Mesuré po-2024 26/11 sur `workspace-roo-extensions` : 9 lots de
 * condensation en PG sur 30 h, 2 fichiers sur le miroir du siège. La
 * condensation écrit son `.md` sur le siège qui la fait, et depuis la Phase D
 * (#4131) la porte PG-primaire ne maintient plus la copie G: du dashboard —
 * `read_archive` ne lisait que ce miroir, donc la fenêtre d'archives d'un
 * siège n'était pas celle de la flotte (organe check-degraded-escalations :
 * verdict confiant, 45 échéances, sur 7 lots invisibles).
 *
 * Contrat éprouvé ici :
 *   - listing = fichiers du siège + lots PG sans fichier local (nom dérivé du
 *     stamp PG par la règle de nommage de l'écrivain : un consommateur qui
 *     date une archive par son nom la fenêtre comme les autres) ;
 *   - un lot dont un fichier local porte déjà le même événement n'est listé
 *     qu'UNE fois, sous le nom du fichier ;
 *   - un nom illisible ici (absent, ou coque sans frontmatter — la classe
 *     exit 1 de #4796) est servi par son lot PG, dans la MÊME enveloppe
 *     `archiveData` qu'une lecture fichier ;
 *   - un fichier lisible garde la précédence ; pas d'histoire PG = le
 *     comportement d'avant, jamais une fenêtre plus petite ;
 *   - les DEUX familles de nom de l'écrivain sont couvertes : canonique et
 *     `-fallback.md` (review ms#1934, finding 1) ; les autres familles
 *     (`-wt-cleanup-…`) ne sont pas de la forme d'un lot, PG ne les sert pas ;
 *   - un lot n'est retiré du listing que si un fichier local est PROUVÉ son
 *     jumeau (tous ses ids de message sont des lignes du lot) ; proche mais non
 *     prouvé, il est listé EN PLUS et compté — la proximité seule écartait des
 *     lots distincts (mesure 26/11 : 40 couples, 39 jumeaux, 1 lot distinct) ;
 *   - une fenêtre PG partielle est DITE (note + champ `pgArchiveWindow`), jamais
 *     silencieuse ; un nom qui tombe dans la fenêtre de plusieurs lots n'est
 *     servi par aucun (sans contenu, il n'y a pas d'identité pour choisir) ;
 *   - le plafond d'identité (64 comparaisons par listing) dit SÉPARÉMENT les
 *     couples contrôlés et réfutés de ceux que le budget n'a jamais comparés :
 *     présenter un non-contrôlé comme un réfuté transformerait 6 vraies paires
 *     laissées de côté en 6 affirmations fausses (review ms#1934, 26/11).
 *
 * Seules les deux lectures PG ajoutées par ce grain sont doublées : le chemin
 * fichier reste réel (fs + parser), c'est lui qui garde la précédence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
  recordSchedulerRunAsync: vi.fn(),
}));

// Les deux lectures PG rendent `{ ..., gap }` depuis la review ms#1934 : le
// `null` d'avant confondait « pas de capacité PG », « PG muet » et « PG en
// échec », donc une fenêtre partielle ne pouvait pas être dite.
const { mockFetchBatches, mockFetchBatch } = vi.hoisted(() => ({
  mockFetchBatches: vi.fn().mockResolvedValue({ batches: [], gap: null }),
  mockFetchBatch: vi.fn().mockResolvedValue({ messages: null, gap: null }),
}));
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../services/unified-store/roosync-dashboard-store.js')
  >();
  return {
    ...actual,
    fetchArchivedDashboardBatches: mockFetchBatches,
    fetchArchivedDashboardBatch: mockFetchBatch,
  };
});

import { roosyncDashboard, buildArchiveMessagesMarkdown } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

const KEY = 'workspace-test-workspace';
const testTmpBase = path.join(os.tmpdir(), 'dashboard-read-archive-pg-');

const pgMessages: IntercomMessage[] = [
  {
    id: 'myia-po-2026:roo-extensions:ic-a',
    timestamp: '2026-11-25T20:10:00.000Z',
    author: { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
    content: '[DEGRADED] archive reader blind',
    tags: ['ERROR', 'claude-interactive'],
  },
  {
    id: 'myia-ai-01:roo-extensions:ic-b',
    timestamp: '2026-11-25T20:20:00.000Z',
    author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    content: '[REPAIRED] scope: myia-po-2026:roo-extensions:ic-a',
    tags: ['REPAIRED'],
  },
];

const fileMessages: IntercomMessage[] = [
  {
    id: 'test-machine:test-workspace:ic-file',
    timestamp: '2026-11-25T16:50:00.000Z',
    author: { machineId: 'test-machine', workspace: 'test-workspace' },
    content: '[DONE] lu depuis le fichier',
    tags: ['DONE'],
  },
];

function name(stamp: string): string {
  return `${KEY}-${stamp}.md`;
}

type Batches = Array<{ archivedAt: string; messageCount: number }>;
type Gap = null | 'no-url' | 'timeout' | 'error';

/** PG holds these batches for the key, whole window served. */
function windowOf(batches: Batches, gap: Gap = null) {
  return { batches, gap };
}

/** One batch's rows (or none) and why PG could not hand them over. */
function batchOf(messages: IntercomMessage[] | null, gap: Gap = null) {
  return { messages, gap };
}

async function writeArchiveFile(archiveDir: string, fileName: string): Promise<void> {
  await writeFile(
    path.join(archiveDir, fileName),
    [
      '---',
      'type: workspace',
      `originalKey: ${KEY}`,
      'archivedAt: 2026-11-25T17:02:28.400Z',
      `messageCount: ${fileMessages.length}`,
      '---',
      '',
      buildArchiveMessagesMarkdown(fileMessages),
      '',
    ].join('\n'),
    'utf8'
  );
}

/** An archive in the pre-`[msg:]` format: header-shaped, no id to prove identity with. */
async function writeArchiveFileWithoutIds(archiveDir: string, fileName: string): Promise<void> {
  await writeFile(
    path.join(archiveDir, fileName),
    [
      '---',
      'type: workspace',
      `originalKey: ${KEY}`,
      'archivedAt: 2026-11-25T17:02:28.400Z',
      'messageCount: 1',
      '---',
      '',
      '### [2026-11-25T16:50:00.000Z] test-machine|test-workspace',
      '[DONE] lu depuis le fichier',
      '',
    ].join('\n'),
    'utf8'
  );
}

/** What the listing prints when a batch was recognised as a file's twin. */
function identityNote(count: number): string {
  return ` [${count} lot(s) PG jumeaux d'un fichier local (identité prouvée par les ids de message), listés une seule fois]`;
}

/** …and when a batch was merely near a file: listed in addition, never dropped. */
function unprovenNote(count: number): string {
  return ` [${count} lot(s) PG proche(s) d'un fichier local sans preuve d'identité — listés en plus, jamais écartés]`;
}

/** …and when the identity budget ran out before the pair could be compared. */
function uncheckedNote(count: number): string {
  return ` [${count} lot(s) PG proche(s) d'un fichier local NON CONTRÔLÉS — budget d'identité épuisé (64 comparaisons par listing) : identité ni prouvée ni réfutée, listés en plus]`;
}

describe('read_archive — repli PG (#4131 residual)', () => {
  let tmpDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    await mkdir(archiveDir, { recursive: true });
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    mockFetchBatches.mockReset().mockResolvedValue({ batches: [], gap: null });
    mockFetchBatch.mockReset().mockResolvedValue({ messages: null, gap: null });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const list = () => roosyncDashboard({ action: 'read_archive', type: 'workspace' });
  const read = (archiveFile: string) =>
    roosyncDashboard({ action: 'read_archive', type: 'workspace', archiveFile });

  // ─── listing ────────────────────────────────────────────────────────

  it('listing = fichiers du siège + lots PG sans fichier, plus récent d\'abord, nom par la règle de l\'écrivain', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 5 },
      { archivedAt: '2026-11-25T19:06:16.000Z', messageCount: 4 },
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 3 },
    ]));
    // Le lot 17:02:29 porte les messages du fichier → jumeau PROUVÉ.
    mockFetchBatch.mockResolvedValue(batchOf(fileMessages));
    const res = await list();
    expect(res.success).toBe(true);
    // 17-02-29 n'apparaît pas : c'est le jumeau PG du fichier 17-02-28.
    expect((res as any).archives).toEqual([
      name('2026-11-25T20-25-29'),
      name('2026-11-25T19-06-16'),
      name('2026-11-25T17-02-28'),
    ]);
    // La seule paire proche a été vérifiée par les ids de message.
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T17:02:29.000Z');
    expect(mockFetchBatch).toHaveBeenCalledTimes(1);
    expect((res as any).message).toBe(
      `3 archive(s) trouvée(s) pour '${KEY}' (dont 2 sans fichier local, servies par PG)`
      + identityNote(1)
    );
    expect((res as any).pgArchiveWindow).toBe('complete');
  });

  it('jumeau : un fichier daté 68 s AVANT le lot PG (attente de verrou DriveFS, #3205) — un seul nom, celui du fichier', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T22-58-20'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T22:59:28.000Z', messageCount: 9 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(fileMessages));
    const res = await list();
    expect((res as any).archives).toEqual([name('2026-11-25T22-58-20')]);
    expect((res as any).message).toBe(
      `1 archive(s) trouvée(s) pour '${KEY}'` + identityNote(1)
    );
  });

  it('proche mais DISTINCT : un lot dont les ids ne couvrent pas le fichier est listé EN PLUS, jamais écarté', async () => {
    // Mesure po-2024 26/11 : un fichier a deux lots candidats — une passe de
    // réconciliation pose `archived_at` quelques minutes après la condensation.
    // La proximité seule écartait ce lot : perte de complétude (pré-revue ai-01).
    await writeArchiveFile(archiveDir, name('2026-11-25T20-25-29'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:30.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages)); // aucun id commun
    const res = await list();
    expect((res as any).archives).toEqual([
      name('2026-11-25T20-25-30'),
      name('2026-11-25T20-25-29'),
    ]);
    expect((res as any).message).toBe(
      `2 archive(s) trouvée(s) pour '${KEY}'` + unprovenNote(1)
    );
    expect((res as any).message).not.toContain('sans fichier local');
  });

  it('proche, non prouvé, et le nom du lot est déjà pris localement → compté, pas dédoublé en silence', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T20-25-29'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 }, // même seconde
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await list();
    // Un second nom identique ne serait qu'un doublon : la lecture servirait le
    // fichier. Le lot est donc impossible à atteindre par son nom — et le dit.
    expect((res as any).archives).toEqual([name('2026-11-25T20-25-29')]);
    expect((res as any).message).toBe(
      `1 archive(s) trouvée(s) pour '${KEY}'`
      + ` [1 lot(s) PG proche(s) d'un fichier local portent son nom sans preuve d'identité — non atteignables par ce nom]`
    );
  });

  it('sous-ensemble : tous les ids du fichier sont des lignes du lot → jumeau prouvé, un seul nom', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T20-25-29'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 3 },
    ]));
    // Le lot contient le message du fichier ET des lignes que le fichier ne cite pas.
    mockFetchBatch.mockResolvedValue(batchOf([...fileMessages, ...pgMessages]));
    const res = await list();
    expect((res as any).archives).toEqual([name('2026-11-25T20-25-29')]);
    expect((res as any).message).toBe(
      `1 archive(s) trouvée(s) pour '${KEY}'` + identityNote(1)
    );
  });

  it('fichier au format antérieur (aucun `[msg:]`) → identité non prouvable, lot listé en plus', async () => {
    await writeArchiveFileWithoutIds(archiveDir, name('2026-11-25T20-25-29'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:31.000Z', messageCount: 2 },
    ]));
    const res = await list();
    expect((res as any).archives).toHaveLength(2);
    expect((res as any).message).toBe(
      `2 archive(s) trouvée(s) pour '${KEY}'` + unprovenNote(1)
    );
    // Sans id dans le fichier, le lot n'est même pas lu.
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('plafond d\'identité : 10 couples réfutés puis 60 vrais jumeaux — 54 prouvés, 6 NON CONTRÔLÉS dits à part', async () => {
    // Un seul compteur pour tout le listing (64 comparaisons) : les réfutés du
    // début mangent le budget des jumeaux derrière eux. Les compter ensemble
    // ferait dire « 16 lots sans preuve d'identité » là où 6 n'ont jamais été
    // comparés (review ms#1934, 26/11).
    const PAIRS = 70;
    const BASE = Date.parse('2026-11-20T00:00:00Z');
    const STEP = 10 * 60_000; // > la fenêtre de rattachement (6 min), un lot = un candidat
    const isoAt = (i: number) => new Date(BASE + i * STEP).toISOString();
    const stamps: string[] = [];
    for (let i = 0; i < PAIRS; i += 1) {
      const stamp = isoAt(i).replace(/[:.]/g, '-').substring(0, 19);
      stamps.push(stamp);
      await writeArchiveFile(archiveDir, name(stamp));
    }
    mockFetchBatches.mockResolvedValue(windowOf(stamps.map((_, i) => ({
      archivedAt: new Date(BASE + i * STEP + 1000).toISOString(),
      messageCount: 2,
    }))));
    mockFetchBatch.mockImplementation(async (_key: string, archivedAt: string) => {
      const idx = Math.round((Date.parse(archivedAt) - BASE - 1000) / STEP);
      return batchOf(idx < 10 ? pgMessages : fileMessages);
    });
    const res = await list();
    // 70 fichiers + 10 réfutés listés en plus + 6 non contrôlés listés en plus.
    expect((res as any).archives).toHaveLength(70 + 10 + 6);
    expect(mockFetchBatch).toHaveBeenCalledTimes(64);
    expect((res as any).message).toBe(
      `86 archive(s) trouvée(s) pour '${KEY}'`
      + identityNote(54)
      + unprovenNote(10)
      + uncheckedNote(6)
    );
    // Ni « 70 sans preuve », ni les non-contrôlés comptés comme des réfutés.
    expect((res as any).message).not.toContain('70 lot(s)');
    expect((res as any).message).not.toContain('sans fichier local');
  });

  it('fenêtre bornée : 10 min après un fichier = une AUTRE condensation ; au-delà de 2 s AVANT = pas un jumeau', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T08-38-22'));
    await writeArchiveFile(archiveDir, name('2026-11-25T10-00-00'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T10:00:01.000Z', messageCount: 2 }, // jumeau de 10-00-00 (skew 1 s)
      { archivedAt: '2026-11-25T09:59:56.000Z', messageCount: 6 }, // 4 s AVANT 10-00-00 : distinct
      { archivedAt: '2026-11-25T08:48:23.000Z', messageCount: 7 }, // 601 s après 08-38-22 : distinct
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(fileMessages));
    const res = await list();
    expect((res as any).archives).toEqual([
      name('2026-11-25T10-00-00'),
      name('2026-11-25T09-59-56'),
      name('2026-11-25T08-48-23'),
      name('2026-11-25T08-38-22'),
    ]);
    expect((res as any).message).toContain('dont 2 sans fichier local');
    expect((res as any).message).toContain(identityNote(1));
  });

  it('pas d\'histoire PG → le listing d\'actuel, mot pour mot', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    const res = await list();
    expect((res as any).archives).toEqual([name('2026-11-25T17-02-28')]);
    expect((res as any).message).toBe(`1 archive(s) trouvée(s) pour '${KEY}'`);
    expect((res as any).pgArchiveWindow).toBe('complete');
  });

  // ─── famille `-fallback` (review ms#1934, finding 1) ─────────────────

  it('jumeau `-fallback` : le fichier de repli et son lot PG ne sont listés qu\'UNE fois, sous le nom du fichier', async () => {
    await writeArchiveFile(archiveDir, `${KEY}-2026-11-25T20-25-29-fallback.md`);
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(fileMessages));
    const res = await list();
    expect((res as any).archives).toEqual([`${KEY}-2026-11-25T20-25-29-fallback.md`]);
    // Ni doublon sous le nom canonique, ni lot compté « sans fichier local ».
    expect((res as any).message).not.toContain('sans fichier local');
    expect((res as any).message).toContain(identityNote(1));
  });

  it('coque `-fallback` (placeholder DriveFS non hydraté) → servie par PG, plus de rejet', async () => {
    const husk = `${KEY}-2026-11-25T20-25-29-fallback.md`;
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(husk);
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(pgMessages);
    expect((res as any).message).toBe(
      `Archive '${husk}' lue depuis PG (2 messages)`
    );
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T20:25:29.000Z');
  });

  it('`-fallback` ABSENT du siège → son lot PG le sert aussi (même famille, même chemin)', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(`${KEY}-2026-11-25T20-25-29-fallback.md`);
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(pgMessages);
  });

  // ─── fenêtre partielle (review ms#1934 : « garder visible une fenêtre
  // partielle lorsque PG ne répond pas ») ──────────────────────────────

  it.each(['timeout', 'error'] as const)('listing, PG %s → fichiers locaux seuls, mais DIT : note + champ `pgArchiveWindow`', async (gap) => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    mockFetchBatches.mockResolvedValue(windowOf([], gap));
    const res = await list();
    expect(res.success).toBe(true);
    expect((res as any).archives).toEqual([name('2026-11-25T17-02-28')]);
    expect((res as any).message).toBe(
      `1 archive(s) trouvée(s) pour '${KEY}'`
      + (gap === 'timeout'
        ? " [FENÊTRE PARTIELLE : le store PG n'a pas répondu à temps — seuls les fichiers locaux sont listés]"
        : ' [FENÊTRE PARTIELLE : lecture PG en échec — seuls les fichiers locaux sont listés]')
    );
    expect((res as any).pgArchiveWindow).toBe(gap);
  });

  it('lecture, PG muet → « introuvable » garde sa signature et porte la raison', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([], 'timeout'));
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(
      `Archive '${name('2026-11-25T20-25-29')}' introuvable`
      + " [FENÊTRE PARTIELLE : le store PG n'a pas répondu à temps — seuls les fichiers locaux sont listés]"
    );
    expect((res as any).pgArchiveWindow).toBe('timeout');
  });

  it('lecture : lot connu mais PG ne rend pas ses lignes → « introuvable » PARTIEL, pas un lot vide', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(null, 'error'));
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('introuvable');
    expect((res as any).message).toContain('FENÊTRE PARTIELLE');
    expect((res as any).pgArchiveWindow).toBe('error');
  });

  it('nom d\'une famille que PG ne peut pas servir (`-wt-cleanup-…`) → « introuvable » seul, PG jamais consulté, pas de champ', async () => {
    const fork = `${KEY}-wt-cleanup-2026-11-25T20-25-29.md`;
    const res = await read(fork);
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(`Archive '${fork}' introuvable`);
    expect((res as any).pgArchiveWindow).toBeUndefined();
    expect(mockFetchBatches).not.toHaveBeenCalled();
  });

  // ─── lecture ────────────────────────────────────────────────────────

  it('nom d\'un lot PG sans fichier → archiveData servi par PG, même enveloppe qu\'une lecture fichier', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(true);
    expect((res as any).archiveData).toEqual({
      key: KEY,
      archivedAt: '2026-11-25T20:25:29.000Z',
      messageCount: 2,
      messages: pgMessages,
    });
    expect((res as any).message).toBe(
      `Archive '${name('2026-11-25T20-25-29')}' lue depuis PG (2 messages)`
    );
    expect((res as any).pgArchiveWindow).toBe('complete');
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T20:25:29.000Z');
  });

  it('le nom de FICHIER cité par un autre siège (stamp 1 s avant le lot PG) résout vers le même lot', async () => {
    // L'écrivain calcule le nom AVANT l'écriture ; `archived_at` est posé par
    // l'écriture du dashboard qui suit. Paire mesurée : fichier 17-02-28, PG
    // 17:02:29.
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T19:06:16.000Z', messageCount: 12 },
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 3 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(name('2026-11-25T17-02-28'));
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(pgMessages);
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T17:02:29.000Z');
  });

  it('un fichier LISIBLE garde la précédence — PG n\'est jamais consulté', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 99 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(name('2026-11-25T17-02-28'));
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(fileMessages);
    expect((res as any).message).toBe(`Archive '${name('2026-11-25T17-02-28')}' lue (1 messages)`);
    expect((res as any).pgArchiveWindow).toBeUndefined();
    expect(mockFetchBatches).not.toHaveBeenCalled();
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('coque sans frontmatter (placeholder DriveFS non hydraté, #4796) → servie par PG, plus de rejet', async () => {
    const husk = name('2026-11-25T20-25-29');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(husk);
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(pgMessages);
    expect((res as any).message).toContain('lue depuis PG');
  });

  it('pas d\'histoire PG → « introuvable » pour un nom absent (comportement d\'avant)', async () => {
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(`Archive '${name('2026-11-25T20-25-29')}' introuvable`);
    expect((res as any).archiveData).toBeUndefined();
  });

  it('aucun lot dans la fenêtre du nom → « introuvable »', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T08:38:22.000Z', messageCount: 4 },
    ]));
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('introuvable');
    expect((res as any).message).not.toContain('FENÊTRE PARTIELLE');
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  // ─── ambiguïté (mesurée : un nom peut tomber dans la fenêtre de DEUX lots) ──

  it('DEUX lots dans la fenêtre d\'un nom ABSENT → aucun n\'est servi, la réponse dit combien', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-26T00:27:11.000Z', messageCount: 21 },
      { archivedAt: '2026-11-26T00:33:08.000Z', messageCount: 11 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf(pgMessages));
    const res = await read(name('2026-11-26T00-27-11'));
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(
      `Archive '${name('2026-11-26T00-27-11')}' introuvable`
      + ` [2 lots PG tombent dans la fenêtre de cet horodatage — aucun ne peut être identifié sans le contenu du fichier]`
    );
    // Servir « le plus proche » rendrait les messages d'un AUTRE événement sous ce nom.
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('DEUX lots dans la fenêtre d\'une COQUE → le rejet husk porte l\'ambiguïté, pas un contenu deviné', async () => {
    const husk = name('2026-11-26T00-27-11');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-26T00:27:11.000Z', messageCount: 21 },
      { archivedAt: '2026-11-26T00:33:08.000Z', messageCount: 11 },
    ]));
    await expect(read(husk)).rejects.toThrow(/frontmatter manquant/);
    await expect(read(husk)).rejects.toThrow(/2 lots PG tombent dans la fenêtre/);
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('lot connu mais vide → « introuvable » (pas un archiveData vide)', async () => {
    mockFetchBatches.mockResolvedValue(windowOf([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 0 },
    ]));
    mockFetchBatch.mockResolvedValue(batchOf([]));
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(`Archive '${name('2026-11-25T20-25-29')}' introuvable`);
  });

  it('coque sans histoire PG → toujours rejetée (comportement d\'avant : l\'instrument voit sa fenêtre partielle)', async () => {
    const husk = name('2026-11-25T20-25-29');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    await expect(read(husk)).rejects.toThrow(/^Format archive invalide: frontmatter manquant/);
  });

  it('coque ET PG muet → rejetée, le motif porte la fenêtre partielle (pas « transport sain »)', async () => {
    const husk = name('2026-11-25T20-25-29');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    mockFetchBatches.mockResolvedValue(windowOf([], 'timeout'));
    const rejection = read(husk);
    await expect(rejection).rejects.toThrow(/frontmatter manquant/);
    await expect(rejection).rejects.toThrow(/FENÊTRE PARTIELLE/);
  });
});
