/**
 * #4982 — a failed G: archive write no longer aborts a condensation pass under
 * PG-primary, as long as the PG journal proves the batch BEFORE the live is
 * trimmed. Short of that proof, the pass still aborts — and says why.
 *
 * Measured on ai-01 (28/11): DriveFS refused the archive temporary with
 * `ENOENT … dashboards\archive\workspace-Maintenance-2026-11-28T12-02-51.md.tmp`
 * (then the same on `global`). The pass threw before anything else, the PG
 * archive batch (stamped by the condensed write that follows) was never laid
 * either, and `workspace-Maintenance` grew to 92,4 % of its cap.
 *
 * Two levels:
 *  1. `writeArchiveOrProveInPg` directly, with a REAL ENOENT: the archive path
 *     sits in a directory that does not exist, so creating `<path>.tmp` fails
 *     exactly as on ai-01.
 *  2. A real condensation (truncation fallback) whose archive `.md.tmp` write
 *     is refused with ENOENT — the end-to-end behaviour of the pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Dashboard, IntercomMessage } from '../dashboard-schemas.js';

// The real writeFile — taken through importActual in beforeEach, never through
// the mocked module (which would resolve to the mock and recurse).
let fsWriteFileReal: typeof import('fs/promises')['writeFile'];

const {
  mockReadDashboardFromPg,
  mockReadDashboardFromPgUngated,
  mockFetchArchivedIds,
  mockIsDashboardPgPrimary,
  mockDualWriteDashboardSyncChecked,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockReadDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  mockFetchArchivedIds: vi.fn().mockResolvedValue(null),
  mockIsDashboardPgPrimary: vi.fn().mockReturnValue(false),
  mockDualWriteDashboardSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  mockWriteFile: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: mockWriteFile };
});

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  isDashboardPgPrimary: mockIsDashboardPgPrimary,
  dualWriteDashboardSyncChecked: mockDualWriteDashboardSyncChecked,
  readDashboardFromPgUngated: mockReadDashboardFromPgUngated,
  readDashboardFromPg: mockReadDashboardFromPg,
  probeDashboardJournalForHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  dualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
  dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  getDashboardRetirement: vi.fn().mockResolvedValue(null),
  listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  readDashboardSharedLock: vi.fn().mockResolvedValue(null),
  fetchArchivedDashboardMessageIds: mockFetchArchivedIds,
}));

// No chat client: condensation takes the truncation fallback (#1792) — the
// archive write under test is the same call on both paths.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, writeArchiveOrProveInPg } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condense-archive-pg-proof-');

function message(id: string): IntercomMessage {
  return {
    id,
    timestamp: new Date().toISOString(),
    author: { machineId: 'other-machine', workspace: 'other-workspace' },
    content: `message ${id}`,
  };
}

function pgView(key: string, messages: IntercomMessage[]): Dashboard {
  return {
    type: 'workspace',
    key,
    lastModified: new Date().toISOString(),
    lastModifiedBy: { machineId: 'other-machine', workspace: 'other-workspace' },
    status: { markdown: 'pg status' },
    intercom: { messages, totalMessages: messages.length },
  };
}

let tmpDir: string;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  fsWriteFileReal = actual.writeFile;
  mockWriteFile.mockReset().mockImplementation((...args: Parameters<typeof fsWriteFileReal>) => fsWriteFileReal(...args));
  process.env.CONDENSE_DETACHED = '0';
  tmpDir = await mkdtemp(testTmpBase);
  process.env.ROOSYNC_SHARED_PATH = tmpDir;
  process.env.ROOSYNC_MACHINE_ID = 'test-machine';
  process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  process.env.ROOSYNC_DASHBOARD_MIRROR_WRITER = '*';
  mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
  mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);
  mockFetchArchivedIds.mockReset().mockResolvedValue(null);
  mockIsDashboardPgPrimary.mockReset().mockReturnValue(false);
  mockDualWriteDashboardSyncChecked.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.ROOSYNC_SHARED_PATH;
  delete process.env.ROOSYNC_MACHINE_ID;
  delete process.env.ROOSYNC_WORKSPACE_ID;
  delete process.env.ROOSYNC_DASHBOARD_MIRROR_WRITER;
  delete process.env.CONDENSE_DETACHED;
  vi.clearAllMocks();
});

describe('#4982 writeArchiveOrProveInPg — real ENOENT on the archive .tmp', () => {
  const KEY = 'workspace-Maintenance';
  /** The directory does not exist: creating `<path>.tmp` fails with ENOENT, as on ai-01. */
  const missingArchivePath = (): string =>
    path.join(tmpDir, 'archive-missing', `${KEY}-2026-11-28T12-02-51.md`);

  it('writes the file and returns null when the directory exists', async () => {
    const archivePath = path.join(tmpDir, `${KEY}-ok.md`);
    const result = await writeArchiveOrProveInPg(KEY, archivePath, 'content', [message('a')]);
    expect(result).toBeNull();
    expect(await readFile(archivePath, 'utf8')).toBe('content');
    expect(mockReadDashboardFromPgUngated).not.toHaveBeenCalled();
  });

  it('outside PG-primary, rethrows the original ENOENT (abort unchanged)', async () => {
    await expect(
      writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a')])
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mockReadDashboardFromPgUngated).not.toHaveBeenCalled();
  });

  it('under PG-primary, returns the failure once every id is re-read in the PG journal', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    const batch = [message('a'), message('b')];
    mockReadDashboardFromPgUngated.mockResolvedValue(pgView(KEY, [...batch, message('kept')]));

    const result = await writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', batch);

    expect(result).not.toBeNull();
    expect(result!.error).toMatch(/ENOENT/);
    expect(result!.error).toMatch(/\.md\.tmp/);
    expect(result!.pgProvenMessages).toBe(2);
    expect(mockReadDashboardFromPgUngated).toHaveBeenCalledWith(KEY);
  });

  it('counts an id already archived in PG as proven', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockResolvedValue(pgView(KEY, [message('a')]));
    mockFetchArchivedIds.mockResolvedValue(new Set(['b']));

    const result = await writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a'), message('b')]);

    expect(result?.pgProvenMessages).toBe(2);
    expect(mockFetchArchivedIds).toHaveBeenCalledWith(KEY);
  });

  it('aborts, and says so, when one id is in neither the active nor the archived rows', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockResolvedValue(pgView(KEY, [message('a')]));
    mockFetchArchivedIds.mockResolvedValue(new Set<string>());

    await expect(
      writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a'), message('lost')])
    ).rejects.toThrow(/Condensation abandonnée \(#4982\).*ENOENT.*1\/2 id\(s\) absents du journal PG \(ex\. lost\).*Aucun message retiré/);
  });

  it('aborts when the PG journal cannot be read', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockResolvedValue(null);

    await expect(
      writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a')])
    ).rejects.toThrow(/Condensation abandonnée \(#4982\).*lecture PG impossible/);
  });

  it('aborts when the archived ids are unreadable and an id is not active', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockResolvedValue(pgView(KEY, []));
    mockFetchArchivedIds.mockResolvedValue(null);

    await expect(
      writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a')])
    ).rejects.toThrow(/Condensation abandonnée \(#4982\).*ids archivés illisibles/);
  });

  it('aborts on a message without id — it has no PG row by construction', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockResolvedValue(pgView(KEY, [message('a')]));
    const noId = { ...message('x'), id: '' };

    await expect(
      writeArchiveOrProveInPg(KEY, missingArchivePath(), 'content', [message('a'), noId])
    ).rejects.toThrow(/Condensation abandonnée \(#4982\).*message sans id/);
    expect(mockReadDashboardFromPgUngated).not.toHaveBeenCalled();
  });
});

describe('#4982 condensation pass — the archive .md.tmp is refused with ENOENT', () => {
  /** A view over the 92 % threshold — the lever the #3151/#4131 suites use. */
  function overThresholdView(key: string): Dashboard {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `bulk-${i}`,
      timestamp: new Date(Date.now() - (20 - i) * 60_000).toISOString(),
      author: { machineId: 'other-machine', workspace: 'other-workspace' },
      content: `Bulk message ${i}: ${'b'.repeat(2600)}`,
    }));
    return pgView(key, messages);
  }

  const isArchiveTmp = (p: unknown): boolean => /[\\/]archive[\\/][^\\/]+\.md\.tmp$/.test(String(p));

  /** Refuse the archive temporary like DriveFS did on ai-01; every other write is real. */
  function refuseArchiveTmp(): void {
    mockWriteFile.mockImplementation((...args: Parameters<typeof fsWriteFileReal>) => {
      if (isArchiveTmp(args[0])) {
        const err = Object.assign(
          new Error(`ENOENT: no such file or directory, open '${String(args[0])}'`),
          { code: 'ENOENT', errno: -4058, syscall: 'open', path: String(args[0]) }
        );
        return Promise.reject(err);
      }
      return fsWriteFileReal(...args);
    });
  }

  /** Seed a dashboard, then make the next append see an over-cap view. */
  async function seed(): Promise<{ key: string; filePath: string }> {
    const write = await roosyncDashboard({
      action: 'write', type: 'workspace', content: 'status', createIfNotExists: true,
    });
    const key = write.key as string;
    for (let i = 0; i < 4; i++) {
      await roosyncDashboard({ action: 'append', type: 'workspace', content: `File message ${i}`, tags: ['INFO'] });
    }
    mockReadDashboardFromPg.mockImplementation(async () => overThresholdView(key));
    return { key, filePath: path.join(tmpDir, 'dashboards', `${key}.md`) };
  }

  const condensedWrites = () =>
    mockDualWriteDashboardSyncChecked.mock.calls.filter((c) => (c[1] as { condensed?: boolean } | undefined)?.condensed === true);

  async function archiveFiles(): Promise<string[]> {
    return (await readdir(path.join(tmpDir, 'dashboards', 'archive')).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.md') || f.endsWith('.md.tmp'));
  }

  it('PG-primary + batch proven: the pass completes, trims the live and says the file is missing', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    const { key, filePath } = await seed();
    // The proof reads the PG journal: every bulk message has its row there.
    mockReadDashboardFromPgUngated.mockImplementation(async () => overThresholdView(key));
    refuseArchiveTmp();

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'Message that trips condensation', tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.condensed).toBe(true);
    // The archive temporary really was refused, and nothing landed on "G:".
    expect(mockWriteFile.mock.calls.some((c) => isArchiveTmp(c[0]))).toBe(true);
    expect(await archiveFiles()).toEqual([]);

    // Order of the proof: PG re-read BEFORE the condensed write that trims.
    const writes = condensedWrites();
    expect(writes.length).toBeGreaterThan(0);
    const proofOrder = mockReadDashboardFromPgUngated.mock.invocationCallOrder[0];
    const trimOrder = mockDualWriteDashboardSyncChecked.mock.invocationCallOrder[
      mockDualWriteDashboardSyncChecked.mock.calls.indexOf(writes[0])
    ];
    expect(proofOrder).toBeLessThan(trimOrder);

    // The trimmed live dropped archived bulk messages, and the notice names the gap.
    const trimmed = writes[0][0] as Dashboard;
    const trimmedIds = new Set(trimmed.intercom.messages.map((m) => m.id));
    expect(trimmedIds.has('bulk-0')).toBe(false);
    const notice = trimmed.intercom.messages.map((m) => m.content).join('\n');
    expect(notice).toContain("Fichier d'archive non écrit");
    expect(notice).toMatch(/ENOENT/);
    expect(notice).toMatch(/le lot vit dans le journal PG \(\d+ messages relus avant retrait\)/);
    expect(await readFile(filePath, 'utf8')).toContain("Fichier d'archive non écrit");
  });

  it('PG-primary + batch NOT proven: the pass aborts, no condensed write, no message removed', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    await seed();
    mockReadDashboardFromPgUngated.mockResolvedValue(null);
    refuseArchiveTmp();

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'Message that trips condensation', tags: ['INFO'],
    });

    // The message itself is persisted (write-first); only the condensation failed.
    expect(result.success).toBe(true);
    expect(result.condensed).toBe(false);
    expect(mockReadDashboardFromPgUngated).toHaveBeenCalled();
    expect(condensedWrites()).toEqual([]);
    expect(await archiveFiles()).toEqual([]);
  });

  it('outside PG-primary, an archive ENOENT keeps the historical abort', async () => {
    await seed();
    refuseArchiveTmp();

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'Message that trips condensation', tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.condensed).toBe(false);
    expect(mockReadDashboardFromPgUngated).not.toHaveBeenCalled();
    expect(condensedWrites()).toEqual([]);
  });
});
