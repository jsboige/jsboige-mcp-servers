/**
 * #4293 — roosync_read mode=attachments, store partagé absent, config du pilote
 * (`UNIFIED_STORE_CHANNEL_PG_PRIMARY=1`).
 *
 * Un drapeau PG-primary à 1 ne prouve pas que PG a répondu : quand le scan PG
 * échoue, `listAttachments` retombait en silence sur un disque absent et rendait
 * « Aucune pièce jointe ». Ce fichier épingle :
 *   1. scan PG qui RÉPOND vide → vide probant ;
 *   2. scan PG tombé (null)    → erreur explicite des deux moitiés ;
 *   3. refs présentes, métadonnées illisibles → erreur explicite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { rmSync } from 'fs';

const {
  mockGetAttachmentPgReader,
  mockScanAttachmentMetadataFromPg,
  mockListAttachments,
  mockListAttachmentsByRefs,
  mockGetMessage,
} = vi.hoisted(() => ({
  mockGetAttachmentPgReader: vi.fn(),
  mockScanAttachmentMetadataFromPg: vi.fn(),
  mockListAttachments: vi.fn(),
  mockListAttachmentsByRefs: vi.fn(),
  mockGetMessage: vi.fn(),
}));

vi.mock('../../../services/roosync/AttachmentManager.js', () => ({
  AttachmentManager: class {
    listAttachments = mockListAttachments;
    listAttachmentsByRefs = mockListAttachmentsByRefs;
  },
}));

vi.mock('../../../services/unified-store/roosync-attachment-pg.js', () => ({
  getAttachmentPgReader: mockGetAttachmentPgReader,
  scanAttachmentMetadataFromPg: mockScanAttachmentMetadataFromPg,
}));

vi.mock('../../../services/MessageManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/MessageManager.js')>();
  return { ...actual, getMessageManager: () => ({ getMessage: mockGetMessage }) };
});

import { roosyncRead } from '../read.js';

const storePath = path.join(os.tmpdir(), `rsm-4293-read-attachments-${process.pid}`);
const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
] as const;
let savedEnv: Record<string, string | undefined> = {};

const messageId = 'msg-20261021T010000-attach';
const fakeReader = { isNull: () => false };
const textOf = (result: { content: Array<{ type: string; text: string }> }) => result.content[0]!.text;

beforeEach(() => {
  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = storePath;
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
  // Store absent : le répertoire n'existe pas.
  rmSync(storePath, { recursive: true, force: true });
  mockGetAttachmentPgReader.mockReset().mockReturnValue(fakeReader);
  mockScanAttachmentMetadataFromPg.mockReset().mockResolvedValue(null);
  mockListAttachments.mockReset().mockResolvedValue([]);
  mockListAttachmentsByRefs.mockReset().mockResolvedValue([]);
  mockGetMessage.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  rmSync(storePath, { recursive: true, force: true });
  for (const key of WATCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('#4293 — roosync_read attachments, store absent + PG-primary', () => {
  it('cas 1 — message inconnu, scan PG qui RÉPOND vide : le vide est probant', async () => {
    mockScanAttachmentMetadataFromPg.mockResolvedValue([]);

    const text = textOf(await roosyncRead({ mode: 'attachments', message_id: messageId }));

    expect(text).toContain('Aucune pièce jointe pour ce message');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
    // Le disque absent n'est jamais scanné.
    expect(mockListAttachments).not.toHaveBeenCalled();
  });

  it('cas 2 — message inconnu, PG tombé : erreur explicite, jamais « aucune pièce jointe »', async () => {
    mockScanAttachmentMetadataFromPg.mockResolvedValue(null);

    const text = textOf(await roosyncRead({ mode: 'attachments', message_id: messageId }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).toContain('PostgreSQL de secours');
    expect(text).not.toContain('Aucune pièce jointe pour ce message');
  });

  it('cas 3 — refs présentes, métadonnées illisibles : erreur explicite', async () => {
    mockGetMessage.mockResolvedValue({
      id: messageId,
      attachments: [{ uuid: 'att-uuid-4293', filename: 'rapport.pdf', sizeBytes: 1024 }],
    });
    mockListAttachmentsByRefs.mockResolvedValue([]);

    const text = textOf(await roosyncRead({ mode: 'attachments', message_id: messageId }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('Aucune pièce jointe pour ce message');
  });
});
