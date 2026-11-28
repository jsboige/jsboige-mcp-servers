/**
 * #4981 — `read_archive` sur un nom LISTÉ dont le contenu n'est pas servi.
 *
 * Mesuré ai-01 28/11 (12:29Z puis 12:56Z, mêmes comptes) : sous G: (DriveFS),
 * 1 215 archives sur 2 698 passent `stat` et l'ouverture, puis rendent ENOENT
 * à la première lecture. `read_archive` répondait « introuvable » comme pour un
 * fichier absent, et l'organe d'escalade traduisait « ABSENTE du miroir de ce
 * siège » — un diagnostic faux qui envoie chercher une archive qui est là.
 *
 * Contrat éprouvé ici :
 *   - fichier présent, lecture ENOENT, PG muet → échec, « introuvable » garde
 *     sa tête (signature des consommateurs existants), la note dit « illisible
 *     sur ce siège » et le champ `localFile: 'unreadable'` est posé ;
 *   - fichier absent → la réponse d'avant, sans note ni champ ;
 *   - fichier présent, lecture ENOENT, PG tient le lot → servi par PG, comme
 *     avant (le repli n'est pas changé).
 *
 * Seule la lecture `fs.readFile` est doublée, pour les noms marqués : `stat`
 * reste réel, c'est lui qui distingue les deux cas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
  recordSchedulerRunAsync: vi.fn(),
}));

const { unreadable, mockFetchBatches, mockFetchBatch } = vi.hoisted(() => ({
  unreadable: new Set<string>(),
  mockFetchBatches: vi.fn().mockResolvedValue({ batches: [], gap: null }),
  mockFetchBatch: vi.fn().mockResolvedValue({ messages: null, gap: null }),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = (async (p: any, ...rest: any[]) => {
    if (typeof p === 'string' && unreadable.has(path.basename(p))) {
      const err = new Error(`ENOENT: no such file or directory, read`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return (actual.readFile as any)(p, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

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

import { roosyncDashboard, buildArchiveMessagesMarkdown, ARCHIVE_UNREADABLE_NOTE } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

const KEY = 'workspace-test-workspace';

const pgMessages: IntercomMessage[] = [
  {
    id: 'myia-ai-01:roo-extensions:ic-r',
    timestamp: '2026-11-28T02:10:00.000Z',
    author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    content: '[REPAIRED] scope: #4981',
    tags: ['REPAIRED'],
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
      'archivedAt: 2026-11-28T02:14:46.000Z',
      'messageCount: 1',
      '---',
      '',
      buildArchiveMessagesMarkdown(pgMessages),
      '',
    ].join('\n'),
    'utf8'
  );
}

describe('read_archive — nom listé, contenu non servi (#4981)', () => {
  let tmpDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-read-archive-unreadable-'));
    archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    await mkdir(archiveDir, { recursive: true });
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    unreadable.clear();
    mockFetchBatches.mockReset().mockResolvedValue({ batches: [], gap: null });
    mockFetchBatch.mockReset().mockResolvedValue({ messages: null, gap: null });
  });

  afterEach(async () => {
    unreadable.clear();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const read = (archiveFile: string) =>
    roosyncDashboard({ action: 'read_archive', type: 'workspace', archiveFile });

  it('fichier présent, lecture ENOENT, PG muet → « introuvable » + note « illisible sur ce siège » + localFile', async () => {
    const file = name('2026-11-28T02-14-46');
    await writeArchiveFile(archiveDir, file);
    unreadable.add(file);
    const res = await read(file);
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(`Archive '${file}' introuvable${ARCHIVE_UNREADABLE_NOTE}`);
    expect((res as any).message).toContain('illisible sur ce siège');
    expect((res as any).localFile).toBe('unreadable');
    // Le repli PG a bien été tenté avant de conclure.
    expect(mockFetchBatches).toHaveBeenCalledWith(KEY);
  });

  it('fichier absent → la réponse d\'avant, sans note ni champ', async () => {
    const file = name('2026-11-28T02-14-46');
    const res = await read(file);
    expect(res.success).toBe(false);
    expect((res as any).message).toBe(`Archive '${file}' introuvable`);
    expect((res as any).localFile).toBeUndefined();
  });

  it('fichier présent, lecture ENOENT, PG tient le lot → servi par PG (repli inchangé)', async () => {
    const file = name('2026-11-28T02-14-46');
    await writeArchiveFile(archiveDir, file);
    unreadable.add(file);
    mockFetchBatches.mockResolvedValue({
      batches: [{ archivedAt: '2026-11-28T02:14:47.000Z', messageCount: 1 }],
      gap: null,
    });
    mockFetchBatch.mockResolvedValue({ messages: pgMessages, gap: null });
    const res = await read(file);
    expect(res.success).toBe(true);
    expect((res as any).archiveData.messages).toHaveLength(1);
    expect((res as any).localFile).toBeUndefined();
  });

  it('fichier lisible → lu depuis le fichier, jamais marqué illisible', async () => {
    const file = name('2026-11-28T02-14-46');
    await writeArchiveFile(archiveDir, file);
    const res = await read(file);
    expect(res.success).toBe(true);
    expect((res as any).localFile).toBeUndefined();
    expect(mockFetchBatches).not.toHaveBeenCalled();
  });
});
