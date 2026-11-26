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
 *     comportement d'avant, jamais une fenêtre plus petite.
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

const { mockFetchBatches, mockFetchBatch } = vi.hoisted(() => ({
  mockFetchBatches: vi.fn().mockResolvedValue(null),
  mockFetchBatch: vi.fn().mockResolvedValue(null),
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
    mockFetchBatches.mockReset().mockResolvedValue(null);
    mockFetchBatch.mockReset().mockResolvedValue(null);
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
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 5 },
      { archivedAt: '2026-11-25T19:06:16.000Z', messageCount: 4 },
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 3 },
    ]);
    const res = await list();
    expect(res.success).toBe(true);
    // 17-02-29 n'apparaît pas : c'est le jumeau PG du fichier 17-02-28.
    expect((res as any).archives).toEqual([
      name('2026-11-25T20-25-29'),
      name('2026-11-25T19-06-16'),
      name('2026-11-25T17-02-28'),
    ]);
    expect((res as any).message).toBe(
      `3 archive(s) trouvée(s) pour '${KEY}' (dont 2 sans fichier local, servies par PG)`
    );
  });

  it('jumeau : un fichier daté 68 s AVANT le lot PG (attente de verrou DriveFS, #3205) — un seul nom, celui du fichier', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T22-58-20'));
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T22:59:28.000Z', messageCount: 9 },
    ]);
    const res = await list();
    expect((res as any).archives).toEqual([name('2026-11-25T22-58-20')]);
    expect((res as any).message).toBe(`1 archive(s) trouvée(s) pour '${KEY}'`);
  });

  it('fenêtre bornée : 10 min après un fichier = une AUTRE condensation ; au-delà de 2 s AVANT = pas un jumeau', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T08-38-22'));
    await writeArchiveFile(archiveDir, name('2026-11-25T10-00-00'));
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T10:00:01.000Z', messageCount: 2 }, // jumeau de 10-00-00 (skew 1 s)
      { archivedAt: '2026-11-25T09:59:56.000Z', messageCount: 6 }, // 4 s AVANT 10-00-00 : distinct
      { archivedAt: '2026-11-25T08:48:23.000Z', messageCount: 7 }, // 601 s après 08-38-22 : distinct
    ]);
    const res = await list();
    expect((res as any).archives).toEqual([
      name('2026-11-25T10-00-00'),
      name('2026-11-25T09-59-56'),
      name('2026-11-25T08-48-23'),
      name('2026-11-25T08-38-22'),
    ]);
    expect((res as any).message).toContain('dont 2 sans fichier local');
  });

  it('pas d\'histoire PG → le listing d\'actuel, mot pour mot', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    const res = await list();
    expect((res as any).archives).toEqual([name('2026-11-25T17-02-28')]);
    expect((res as any).message).toBe(`1 archive(s) trouvée(s) pour '${KEY}'`);
  });

  // ─── lecture ────────────────────────────────────────────────────────

  it('nom d\'un lot PG sans fichier → archiveData servi par PG, même enveloppe qu\'une lecture fichier', async () => {
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]);
    mockFetchBatch.mockResolvedValue(pgMessages);
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
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T20:25:29.000Z');
  });

  it('le nom de FICHIER cité par un autre siège (stamp 1 s avant le lot PG) résout vers le même lot', async () => {
    // L'écrivain calcule le nom AVANT l'écriture ; `archived_at` est posé par
    // l'écriture du dashboard qui suit. Paire mesurée : fichier 17-02-28, PG
    // 17:02:29.
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T19:06:16.000Z', messageCount: 12 },
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 3 },
    ]);
    mockFetchBatch.mockResolvedValue(pgMessages);
    const res = await read(name('2026-11-25T17-02-28'));
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(pgMessages);
    expect(mockFetchBatch).toHaveBeenCalledWith(KEY, '2026-11-25T17:02:29.000Z');
  });

  it('un fichier LISIBLE garde la précédence — PG n\'est jamais consulté', async () => {
    await writeArchiveFile(archiveDir, name('2026-11-25T17-02-28'));
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T17:02:29.000Z', messageCount: 99 },
    ]);
    mockFetchBatch.mockResolvedValue(pgMessages);
    const res = await read(name('2026-11-25T17-02-28'));
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toEqual(fileMessages);
    expect((res as any).message).toBe(`Archive '${name('2026-11-25T17-02-28')}' lue (1 messages)`);
    expect(mockFetchBatches).not.toHaveBeenCalled();
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('coque sans frontmatter (placeholder DriveFS non hydraté, #4796) → servie par PG, plus de rejet', async () => {
    const husk = name('2026-11-25T20-25-29');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 2 },
    ]);
    mockFetchBatch.mockResolvedValue(pgMessages);
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
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T08:38:22.000Z', messageCount: 4 },
    ]);
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('introuvable');
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('lot connu mais vide → « introuvable » (pas un archiveData vide)', async () => {
    mockFetchBatches.mockResolvedValue([
      { archivedAt: '2026-11-25T20:25:29.000Z', messageCount: 0 },
    ]);
    mockFetchBatch.mockResolvedValue([]);
    const res = await read(name('2026-11-25T20-25-29'));
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('introuvable');
  });

  it('famille de nom non canonique (`-fallback.md`) → PG jamais consulté, « introuvable »', async () => {
    const res = await read(`${KEY}-2026-11-25T20-25-29-fallback.md`);
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('introuvable');
    expect(mockFetchBatches).not.toHaveBeenCalled();
  });

  it('coque sans histoire PG → toujours rejetée (comportement d\'avant : l\'instrument voit sa fenêtre partielle)', async () => {
    const husk = name('2026-11-25T20-25-29');
    await writeFile(path.join(archiveDir, husk), '', 'utf8');
    await expect(read(husk)).rejects.toThrow(/frontmatter manquant/);
  });
});
