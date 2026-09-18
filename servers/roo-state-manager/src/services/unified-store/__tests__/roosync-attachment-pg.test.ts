/**
 * Tests for the RooSync attachments PG-primary write + PG-first read paths
 * (#3151 §7.5.2).
 *
 * Covers the contract of roosync-attachment-pg.ts and its AttachmentManager
 * wiring:
 *   - gates: write gate rides the channel PG-primary gate; read gate is
 *     READ_PG OR PG_PRIMARY (a machine that stops writing GDrive must not
 *     keep reading it primary)
 *   - parity rule: a PG row with NULL uploader metadata (legacy Phase A
 *     payload-only row) is a MISS on every read → GDrive fallback
 *   - upload: PG-primary success skips the GDrive writes; PG failure falls
 *     back to the GDrive path (whose dual-write hook re-attempts the mirror)
 *   - reads: metadata / payload / batch / scan resolve PG-first with GDrive
 *     fallback, refs order preserved
 *   - delete: both layers, payloads-first ordering; PG failure under the
 *     primary gate surfaces and leaves the GDrive copy intact
 *
 * Factories are mocked so no Postgres is needed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ─── Writer factory mock (module scope: vi.mock factories are hoisted) ──

const mockInsertRooSyncAttachment = vi.fn().mockResolvedValue(undefined);
const mockDeleteRooSyncAttachment = vi.fn().mockResolvedValue(1);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncAttachment: mockInsertRooSyncAttachment,
    deleteRooSyncAttachment: mockDeleteRooSyncAttachment,
  }),
  resetWriterInstance: vi.fn(),
}));

// ─── Reader factory mock ────────────────────────────────────────────

const mockGetRooSyncAttachmentById = vi.fn().mockResolvedValue(null);
const mockListRooSyncAttachmentMetadata = vi.fn().mockResolvedValue([]);
const mockScanRooSyncAttachments = vi.fn().mockResolvedValue([]);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => false,
    getRooSyncAttachmentById: mockGetRooSyncAttachmentById,
    listRooSyncAttachmentMetadata: mockListRooSyncAttachmentMetadata,
    scanRooSyncAttachments: mockScanRooSyncAttachments,
  }),
  resetReaderInstance: vi.fn(),
}));

// Import AFTER the factory mocks are registered.
import {
  isAttachmentPgPrimary,
  getAttachmentPgReader,
  insertRooSyncAttachmentPrimary,
  readAttachmentMetadataFromPg,
  readAttachmentFromPg,
  listAttachmentMetadataFromPg,
  scanAttachmentMetadataFromPg,
  deleteRooSyncAttachmentPrimary,
  deleteRooSyncAttachmentIfPresent,
} from '../roosync-attachment-pg.js';
import type { RooSyncAttachmentMetadataRow } from '../types.js';
import { AttachmentManager } from '../../roosync/AttachmentManager.js';

vi.unmock('fs');
vi.unmock('fs/promises');

// ─── Helpers ─────────────────────────────────────────────────────────

const ENV_KEYS = [
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
] as const;

async function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** All gates on (write-primary machine). */
const PRIMARY_ENV = {
  UNIFIED_STORE_CHANNEL_PG_PRIMARY: '1',
  UNIFIED_STORE_DUAL_WRITE: '1',
  UNIFIED_STORE_PG_URL: 'postgres://t:t@localhost:5432/x',
} as const;

/** Read gate only (dual-write machine). */
const READ_ENV = {
  UNIFIED_STORE_CHANNEL_READ_PG: '1',
  UNIFIED_STORE_DUAL_WRITE: '1',
  UNIFIED_STORE_PG_URL: 'postgres://t:t@localhost:5432/x',
} as const;

function fullRow(overrides?: Partial<RooSyncAttachmentMetadataRow & { payload: Buffer }>) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    filename: 'report.txt',
    mime: 'text/plain',
    size: 12,
    sha256: 'abc123',
    uploaderMachine: 'myia-po-2024',
    uploaderWorkspace: 'roo-extensions',
    messageId: 'msg-20260918T100000-aaaaaa',
    uploadedAt: '2026-09-18T10:00:00.000Z',
    payload: Buffer.from('hello pg row'),
    ...overrides,
  };
}

/** Legacy Phase A row: payload-only, no metadata (migration 007 columns NULL). */
function legacyRow(overrides?: Partial<RooSyncAttachmentMetadataRow & { payload: Buffer }>) {
  return fullRow({
    uploaderMachine: null,
    uploaderWorkspace: null,
    messageId: null,
    ...overrides,
  });
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `att-pg-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed a GDrive-style attachment on disk (uuid dir + file + metadata.json). */
function seedGdriveAttachment(
  sharedStateDir: string,
  uuid: string,
  content = 'hello gdrive',
  metaOverrides: Record<string, unknown> = {},
): string {
  const dir = join(sharedStateDir, 'attachments', uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.txt'), content, 'utf-8');
  writeFileSync(
    join(dir, 'metadata.json'),
    JSON.stringify({
      uuid,
      originalName: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(content),
      uploadedAt: '2026-09-01T00:00:00.000Z',
      uploaderMachineId: 'myia-po-2025',
      messageId: 'msg-seeded',
      ...metaOverrides,
    }),
    'utf-8',
  );
  return dir;
}

// ─── Gates ───────────────────────────────────────────────────────────

describe('#3151 §7.5.2 gates', () => {
  test('write gate rides the channel PG-primary gate (Null-writer guard applies)', async () => {
    await withEnv({}, () => {
      expect(isAttachmentPgPrimary()).toBe(false);
    });
    await withEnv({ UNIFIED_STORE_CHANNEL_PG_PRIMARY: '1' }, () => {
      // Without DUAL_WRITE the factory would hand the Null writer whose
      // inserts are silent no-ops — the gate refuses that config.
      expect(isAttachmentPgPrimary()).toBe(false);
    });
    await withEnv(PRIMARY_ENV, () => {
      expect(isAttachmentPgPrimary()).toBe(true);
    });
  });

  test('read gate: READ_PG or PG_PRIMARY, else null', async () => {
    await withEnv({}, () => {
      expect(getAttachmentPgReader()).toBeNull();
    });
    await withEnv({ UNIFIED_STORE_CHANNEL_READ_PG: '1' }, () => {
      // PG_URL missing → gate refuses (reader factory would be Null).
      expect(getAttachmentPgReader()).toBeNull();
    });
    await withEnv(READ_ENV, () => {
      expect(getAttachmentPgReader()).not.toBeNull();
    });
    await withEnv(PRIMARY_ENV, () => {
      expect(getAttachmentPgReader()).not.toBeNull();
    });
  });
});

// ─── insertRooSyncAttachmentPrimary ─────────────────────────────────

describe('#3151 §7.5.2 insertRooSyncAttachmentPrimary', () => {
  beforeEach(() => {
    mockInsertRooSyncAttachment.mockReset().mockResolvedValue(undefined);
  });

  test('persists payload + metadata with sha256, returns true', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      const content = Buffer.from('secret bytes');
      const ok = await insertRooSyncAttachmentPrimary({
        uuid: '22222222-2222-2222-2222-222222222222',
        content,
        filename: 'creds.txt',
        mime: 'text/plain',
        uploaderMachineId: 'myia-po-2023',
        messageId: 'msg-1',
        uploadedAt: '2026-09-18T11:00:00.000Z',
      });
      expect(ok).toBe(true);
      expect(mockInsertRooSyncAttachment).toHaveBeenCalledTimes(1);
      const row = mockInsertRooSyncAttachment.mock.calls[0][0];
      expect(row.id).toBe('22222222-2222-2222-2222-222222222222');
      expect(row.payload).toEqual(content);
      expect(row.size).toBe(content.length);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.uploaderMachine).toBe('myia-po-2023');
      expect(row.messageId).toBe('msg-1');
      expect(row.uploadedAt).toBe('2026-09-18T11:00:00.000Z');
    });
  });

  test('PG failure returns false (caller falls back to the GDrive upload)', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      mockInsertRooSyncAttachment.mockRejectedValueOnce(new Error('connection refused'));
      const ok = await insertRooSyncAttachmentPrimary({
        uuid: 'u1', content: Buffer.from('x'), filename: 'f.txt', mime: 'text/plain',
        uploaderMachineId: 'm', uploadedAt: '2026-09-18T11:00:00.000Z',
      });
      expect(ok).toBe(false);
    });
  });
});

// ─── Read helpers — parity rule ─────────────────────────────────────

describe('#3151 §7.5.2 read helpers', () => {
  beforeEach(() => {
    mockGetRooSyncAttachmentById.mockReset().mockResolvedValue(null);
    mockListRooSyncAttachmentMetadata.mockReset().mockResolvedValue([]);
    mockScanRooSyncAttachments.mockReset().mockResolvedValue([]);
  });

  test('metadata: gate off → null, reader untouched', async () => {
    await withEnv({}, async () => {
      expect(await readAttachmentMetadataFromPg('u1')).toBeNull();
      expect(mockGetRooSyncAttachmentById).not.toHaveBeenCalled();
    });
  });

  test('metadata: full row maps to AttachmentMetadata verbatim', async () => {
    await withEnv(READ_ENV, async () => {
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(fullRow());
      const meta = await readAttachmentMetadataFromPg(fullRow().id);
      expect(meta).toEqual({
        uuid: fullRow().id,
        originalName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        uploadedAt: '2026-09-18T10:00:00.000Z',
        uploaderMachineId: 'myia-po-2024',
        uploaderWorkspace: 'roo-extensions',
        messageId: 'msg-20260918T100000-aaaaaa',
      });
    });
  });

  test('metadata: legacy row (NULL uploader) is a MISS under the parity rule', async () => {
    await withEnv(READ_ENV, async () => {
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(legacyRow());
      expect(await readAttachmentMetadataFromPg(legacyRow().id)).toBeNull();
    });
  });

  test('metadata: absent row → null; PG error → null (never throws)', async () => {
    await withEnv(READ_ENV, async () => {
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(null);
      expect(await readAttachmentMetadataFromPg('missing')).toBeNull();
      mockGetRooSyncAttachmentById.mockRejectedValueOnce(new Error('pool timeout'));
      expect(await readAttachmentMetadataFromPg('any')).toBeNull();
    });
  });

  test('payload read: full row returns { content, meta }', async () => {
    await withEnv(READ_ENV, async () => {
      const row = fullRow({ payload: Buffer.from('payload bytes') });
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(row);
      const out = await readAttachmentFromPg(row.id);
      expect(out?.content.toString()).toBe('payload bytes');
      expect(out?.meta.originalName).toBe('report.txt');
    });
  });

  test('payload read: legacy row → null (GDrive fallback)', async () => {
    await withEnv(READ_ENV, async () => {
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(legacyRow());
      expect(await readAttachmentFromPg(legacyRow().id)).toBeNull();
    });
  });

  test('batch: map holds only fully-servable rows; PG error → null', async () => {
    await withEnv(READ_ENV, async () => {
      mockListRooSyncAttachmentMetadata.mockResolvedValueOnce([
        fullRow(),
        legacyRow({ id: '33333333-3333-3333-3333-333333333333' }),
      ]);
      const map = await listAttachmentMetadataFromPg([fullRow().id, '33333333-3333-3333-3333-333333333333']);
      expect(map).not.toBeNull();
      expect(map!.size).toBe(1);
      expect(map!.has(fullRow().id)).toBe(true);

      mockListRooSyncAttachmentMetadata.mockRejectedValueOnce(new Error('pg down'));
      expect(await listAttachmentMetadataFromPg(['x'])).toBeNull();
    });
  });

  test('scan: READ_PG alone does NOT scan PG (machine still writes GDrive)', async () => {
    await withEnv(READ_ENV, async () => {
      expect(await scanAttachmentMetadataFromPg()).toBeNull();
      expect(mockScanRooSyncAttachments).not.toHaveBeenCalled();
    });
  });

  test('scan: PG_PRIMARY scans PG, drops legacy rows with a warn', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      mockScanRooSyncAttachments.mockResolvedValueOnce([
        fullRow(),
        legacyRow({ id: '44444444-4444-4444-4444-444444444444' }),
      ]);
      const rows = await scanAttachmentMetadataFromPg();
      expect(rows).not.toBeNull();
      expect(rows!).toHaveLength(1);
      expect(rows![0].uuid).toBe(fullRow().id);
    });
  });
});

// ─── Delete helpers ─────────────────────────────────────────────────

describe('#3151 §7.5.2 delete helpers', () => {
  beforeEach(() => {
    mockDeleteRooSyncAttachment.mockReset().mockResolvedValue(1);
  });

  test('primary: writer ok → true; writer throws → false', async () => {
    expect(await deleteRooSyncAttachmentPrimary('u1')).toBe(true);
    mockDeleteRooSyncAttachment.mockRejectedValueOnce(new Error('pg down'));
    expect(await deleteRooSyncAttachmentPrimary('u1')).toBe(false);
  });

  test('if-present: returns the deleted count; null on PG error', async () => {
    mockDeleteRooSyncAttachment.mockResolvedValueOnce(0);
    expect(await deleteRooSyncAttachmentIfPresent('gone')).toBe(0);
    mockDeleteRooSyncAttachment.mockRejectedValueOnce(new Error('pg down'));
    expect(await deleteRooSyncAttachmentIfPresent('x')).toBeNull();
  });
});

// ─── AttachmentManager wiring ───────────────────────────────────────

describe('#3151 §7.5.2 AttachmentManager wiring', () => {
  let sharedStateDir: string;
  let workDir: string;
  let manager: AttachmentManager;

  beforeEach(() => {
    sharedStateDir = makeTempDir();
    workDir = makeTempDir();
    manager = new AttachmentManager(sharedStateDir);
    mockInsertRooSyncAttachment.mockReset().mockResolvedValue(undefined);
    mockDeleteRooSyncAttachment.mockReset().mockResolvedValue(1);
    mockGetRooSyncAttachmentById.mockReset().mockResolvedValue(null);
    mockListRooSyncAttachmentMetadata.mockReset().mockResolvedValue([]);
    mockScanRooSyncAttachments.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(sharedStateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeSource(content = 'local source bytes'): string {
    const filePath = join(workDir, 'src.txt');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // --- upload ---

  test('upload PG-primary success: NO GDrive dir, row carries messageId', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      const ref = await manager.uploadAttachment(makeSource('pg only'), 'myia-po-2023', undefined, 'msg-pg-1');
      expect(existsSync(join(sharedStateDir, 'attachments', ref.uuid))).toBe(false);
      expect(ref.sizeBytes).toBe(Buffer.byteLength('pg only'));
      const row = mockInsertRooSyncAttachment.mock.calls[0][0];
      expect(row.id).toBe(ref.uuid);
      expect(row.messageId).toBe('msg-pg-1');
      expect(row.uploaderMachine).toBe('myia-po-2023');
    });
  });

  test('upload PG-primary failure: falls back to the GDrive path (dir + metadata.json + dual-write retry)', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      mockInsertRooSyncAttachment.mockRejectedValueOnce(new Error('pg down')).mockResolvedValueOnce(undefined);
      const ref = await manager.uploadAttachment(makeSource('fallback'), 'myia-po-2023', undefined, 'msg-pg-2');
      const dir = join(sharedStateDir, 'attachments', ref.uuid);
      expect(existsSync(join(dir, 'src.txt'))).toBe(true);
      expect(existsSync(join(dir, 'metadata.json'))).toBe(true);
      // Attempt 1 = primary insert (failed), attempt 2 = dual-write mirror
      // (fire-and-forget — wait for it).
      await vi.waitFor(() => expect(mockInsertRooSyncAttachment).toHaveBeenCalledTimes(2));
      const mirrorRow = mockInsertRooSyncAttachment.mock.calls[1][0];
      expect(mirrorRow.id).toBe(ref.uuid);
      expect(mirrorRow.messageId).toBe('msg-pg-2');
      expect(mirrorRow.uploadedAt).toBeTruthy();
    });
  });

  test('upload gate off: GDrive path as before, dual-write now carries metadata', async () => {
    await withEnv({ UNIFIED_STORE_DUAL_WRITE: '1', UNIFIED_STORE_PG_URL: 'postgres://t:t@localhost:5432/x' }, async () => {
      const ref = await manager.uploadAttachment(makeSource('legacy path'), 'myia-po-2023', undefined, 'msg-pg-3');
      expect(existsSync(join(sharedStateDir, 'attachments', ref.uuid, 'src.txt'))).toBe(true);
      // Dual-write mirror is fire-and-forget — wait for it.
      await vi.waitFor(() => expect(mockInsertRooSyncAttachment).toHaveBeenCalledTimes(1));
      const row = mockInsertRooSyncAttachment.mock.calls[0][0];
      expect(row.uploaderMachine).toBe('myia-po-2023');
      expect(row.messageId).toBe('msg-pg-3');
    });
  });

  // --- reads ---

  test('getAttachmentMetadata: PG hit serves metadata without touching the tree', async () => {
    await withEnv(READ_ENV, async () => {
      const row = fullRow({ id: '55555555-5555-5555-5555-555555555555' });
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(row);
      const meta = await manager.getAttachmentMetadata(row.id);
      expect(meta?.uploaderMachineId).toBe('myia-po-2024');
      expect(existsSync(join(sharedStateDir, 'attachments'))).toBe(false);
    });
  });

  test('getAttachmentMetadata: legacy PG row falls back to the GDrive metadata.json', async () => {
    await withEnv(READ_ENV, async () => {
      const uuid = '66666666-6666-6666-6666-666666666666';
      seedGdriveAttachment(sharedStateDir, uuid);
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(legacyRow({ id: uuid }));
      const meta = await manager.getAttachmentMetadata(uuid);
      expect(meta?.uploaderMachineId).toBe('myia-po-2025');
      expect(meta?.originalName).toBe('note.txt');
    });
  });

  test('readAttachment: PG hit returns the bytea content, no GDrive copy needed', async () => {
    await withEnv(READ_ENV, async () => {
      const row = fullRow({ id: '77777777-7777-7777-7777-777777777777', payload: Buffer.from('inline pg bytes') });
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(row);
      const out = await manager.readAttachment(row.id);
      expect(out.content.toString()).toBe('inline pg bytes');
      expect(existsSync(join(sharedStateDir, 'attachments'))).toBe(false);
    });
  });

  test('readAttachment: PG miss falls back to the GDrive file', async () => {
    await withEnv(READ_ENV, async () => {
      const uuid = '88888888-8888-8888-8888-888888888888';
      seedGdriveAttachment(sharedStateDir, uuid, 'gdrive bytes');
      const out = await manager.readAttachment(uuid);
      expect(out.content.toString()).toBe('gdrive bytes');
    });
  });

  test('getAttachment: PG hit writes the payload to targetPath', async () => {
    await withEnv(READ_ENV, async () => {
      const row = fullRow({ id: '99999999-9999-9999-9999-999999999999', payload: Buffer.from('copied by pg') });
      mockGetRooSyncAttachmentById.mockResolvedValueOnce(row);
      const target = join(workDir, 'out.txt');
      const meta = await manager.getAttachment(row.id, target);
      expect(meta.originalName).toBe('report.txt');
      expect(readFileSync(target, 'utf-8')).toBe('copied by pg');
    });
  });

  test('listAttachmentsByRefs: PG serves one, GDrive the other, refs order preserved', async () => {
    await withEnv(READ_ENV, async () => {
      const pgUuid = 'aaaaaaaa-0000-0000-0000-000000000001';
      const gdUuid = 'aaaaaaaa-0000-0000-0000-000000000002';
      seedGdriveAttachment(sharedStateDir, gdUuid, 'from gdrive');
      mockListRooSyncAttachmentMetadata.mockResolvedValueOnce([
        fullRow({ id: pgUuid, originalName: 'from-pg.txt' } as never),
      ]);
      const metas = await manager.listAttachmentsByRefs([gdUuid, pgUuid]);
      expect(metas).toHaveLength(2);
      expect(metas[0].uuid).toBe(gdUuid);
      expect(metas[0].uploaderMachineId).toBe('myia-po-2025');
      expect(metas[1].uuid).toBe(pgUuid);
      expect(metas[1].uploaderMachineId).toBe('myia-po-2024');
    });
  });

  test('listAttachments scan: PG_PRIMARY reads PG instead of the tree', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      mockScanRooSyncAttachments.mockResolvedValueOnce([fullRow() as never]);
      const metas = await manager.listAttachments();
      expect(metas).toHaveLength(1);
      expect(metas[0].uuid).toBe(fullRow().id);
      expect(existsSync(join(sharedStateDir, 'attachments'))).toBe(false);
    });
  });

  test('listAttachments scan: READ_PG-only still scans GDrive', async () => {
    await withEnv(READ_ENV, async () => {
      const uuid = 'bbbbbbbb-0000-0000-0000-000000000001';
      seedGdriveAttachment(sharedStateDir, uuid);
      const metas = await manager.listAttachments();
      expect(metas.some((m) => m.uuid === uuid)).toBe(true);
      expect(mockScanRooSyncAttachments).not.toHaveBeenCalled();
    });
  });

  // --- delete ---

  test('delete PG-primary: purges PG, removes the legacy GDrive copy', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      const uuid = 'cccccccc-0000-0000-0000-000000000001';
      const dir = seedGdriveAttachment(sharedStateDir, uuid);
      await manager.deleteAttachment(uuid);
      expect(mockDeleteRooSyncAttachment).toHaveBeenCalledWith(uuid);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test('delete PG-primary failure: throws and leaves the GDrive copy INTACT', async () => {
    await withEnv(PRIMARY_ENV, async () => {
      const uuid = 'cccccccc-0000-0000-0000-000000000002';
      const dir = seedGdriveAttachment(sharedStateDir, uuid);
      mockDeleteRooSyncAttachment.mockRejectedValueOnce(new Error('pg down'));
      await expect(manager.deleteAttachment(uuid)).rejects.toThrow(/purge PG/i);
      expect(existsSync(dir)).toBe(true);
    });
  });

  test('delete GDrive-primary: removes the dir AND purges the bytea mirror', async () => {
    await withEnv({}, async () => {
      const uuid = 'dddddddd-0000-0000-0000-000000000001';
      const dir = seedGdriveAttachment(sharedStateDir, uuid);
      await manager.deleteAttachment(uuid);
      expect(existsSync(dir)).toBe(false);
      expect(mockDeleteRooSyncAttachment).toHaveBeenCalledWith(uuid);
    });
  });

  test('delete GDrive-primary, no dir but PG row: deletes the PG-only row', async () => {
    await withEnv({}, async () => {
      mockDeleteRooSyncAttachment.mockResolvedValueOnce(1);
      await manager.deleteAttachment('eeeeeeee-0000-0000-0000-000000000001');
      expect(mockDeleteRooSyncAttachment).toHaveBeenCalledTimes(1);
    });
  });

  test('delete GDrive-primary, nowhere: throws introuvable; PG unreachable surfaces as retry error', async () => {
    await withEnv({}, async () => {
      mockDeleteRooSyncAttachment.mockResolvedValueOnce(0);
      await expect(manager.deleteAttachment('nowhere-uuid')).rejects.toThrow(/introuvable/i);
      mockDeleteRooSyncAttachment.mockRejectedValueOnce(new Error('pg down'));
      await expect(manager.deleteAttachment('nowhere-uuid')).rejects.toThrow(/PG injoignable/i);
    });
  });
});
