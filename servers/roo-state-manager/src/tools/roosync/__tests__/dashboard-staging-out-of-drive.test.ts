/**
 * Dashboard staging must be created OUTSIDE the DriveFS-synced store.
 *
 * Measured defect (roo-extensions #4003/#3782 fallout, manifest
 * ZZ-debris-racine-2026-10-28, po-2025 28/10): 44 staging files
 * `<dashboard>.md.<pid>[.<seq>].tmp` — mostly 0 bytes, in same-second
 * bursts — landed at the ROOT of the personal Google Drive, as recently as
 * 28/10 22:11 (emitter still live). SUPPOSED mechanism: DriveFS starts
 * uploading the freshly created in-tree staging file, then loses track of it
 * when the writer unlinks it (or the copy-in-place churns the parent), and
 * the cloud copy parks at the Drive root — the same re-parenting behaviour
 * #3782 documented for rename-over-existing.
 *
 * The fix stages in `os.tmpdir()` (machine-local, never synced): the
 * behavioural contract pinned here is that a full write + an incremental
 * append create NO `*.tmp` file inside the shared store, and the copy-in-place
 * copies FROM a source outside the store. Copy-in-place, the try/finally
 * unlink and the landed-write verification are unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Le vrai writeFile/copyFile — récupérés via importActual, JAMAIS via l'import
// du module mocké (qui résoudrait vers le mock et récursionnerait à l'infini).
let fsWriteFileReal: typeof import('fs/promises')['writeFile'];
let fsCopyFileReal: typeof import('fs/promises')['copyFile'];

const { mockWriteFile, mockCopyFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
  mockCopyFile: vi.fn(),
}));

// Le store partagé passe par fs/promises — les deux fonctions sont passées à
// la vraie implémentation en y JOUANT UN JOURNAL des chemins touchés.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: mockWriteFile, copyFile: mockCopyFile };
});

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-staging-out-of-drive-');

describe('dashboard staging out-of-drive (DriveFS root debris)', () => {
  let tmpDir: string;
  let writeTargets: string[];
  let copySources: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsWriteFileReal = actual.writeFile;
    fsCopyFileReal = actual.copyFile;
    writeTargets = [];
    copySources = [];
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) => {
      writeTargets.push(String(file));
      return fsWriteFileReal(file as string, data as string, opts as never);
    }) as typeof fsWriteFileReal);
    mockCopyFile.mockImplementation(((src: unknown, dest: unknown) => {
      copySources.push(String(src));
      return fsCopyFileReal(src as string, dest as string);
    }) as typeof fsCopyFileReal);

    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('write + append create NO .tmp file inside the synced store, and copy from OUTSIDE it', async () => {
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'status initial',
      createIfNotExists: true,
    });
    expect(writeResult.success).toBe(true);

    // Second append on the existing dashboard → incremental emitter (the second
    // staging site) — both write sites must stay out of the store.
    const appendResult = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message un',
      tags: ['INFO'],
    });
    expect(appendResult.success).toBe(true);

    // (1) No staging writeFile inside the synced store — the exact signature of
    // the Drive-root debris (`<store>/dashboards/*.md.<pid>[.<seq>].tmp`).
    const inStoreTmpWrites = writeTargets.filter(
      t => t.startsWith(tmpDir) && t.endsWith('.tmp')
    );
    expect(inStoreTmpWrites).toEqual([]);

    // (2) The copy-in-place sources live outside the synced store.
    const inStoreCopySources = copySources.filter(s => s.startsWith(tmpDir));
    expect(inStoreCopySources).toEqual([]);

    // (3) Nothing .tmp survives in dashboards/ after the calls settle.
    const files = await readdir(path.join(tmpDir, 'dashboards'));
    expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
    expect(files).toContain(`${writeResult.key}.md`);

    // (4) The writes still land: canonical content is intact end to end.
    const content = await readFile(
      path.join(tmpDir, 'dashboards', `${writeResult.key}.md`),
      'utf8'
    );
    expect(content).toContain('message un');
  });
});
