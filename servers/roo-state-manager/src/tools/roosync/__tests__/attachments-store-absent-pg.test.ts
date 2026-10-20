/**
 * #4293 — roosync_list_attachments face à un store partagé absent, PG vivant.
 *
 * La garde #3459 s'exécutait avant `roosync-attachment-pg.ts` : G: démonté
 * coupait la liste même quand PG portait les métadonnées. Ce fichier épingle :
 *   1. G: OK  + PG OK   → liste servie ;
 *   2. G: absent + PG OK → refs lues dans PG, liste servie ;
 *   3. G: absent + PG KO → erreur explicite, jamais « aucune pièce jointe » ;
 *   4. G: absent + drapeau off → erreur de garde #3459 inchangée ;
 *   5. G: absent + message lu dans PG sans ref → « aucune pièce jointe » est
 *      une réponse PROBANTE (on ne transforme pas un vide définitif en erreur).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, rmSync } from 'fs';

const {
  mockGetAttachmentPgReader,
  mockListAttachments,
  mockListAttachmentsByRefs,
  mockGetMessage,
  mockGetChannelMessageFromPg,
} = vi.hoisted(() => ({
  mockGetAttachmentPgReader: vi.fn(),
  mockListAttachments: vi.fn(),
  mockListAttachmentsByRefs: vi.fn(),
  mockGetMessage: vi.fn(),
  mockGetChannelMessageFromPg: vi.fn(),
}));

vi.mock('../../../services/roosync/AttachmentManager.js', () => ({
  AttachmentManager: class {
    listAttachments = mockListAttachments;
    listAttachmentsByRefs = mockListAttachmentsByRefs;
  },
}));

vi.mock('../../../services/MessageManager.js', () => ({
  getMessageManager: () => ({ getMessage: mockGetMessage }),
}));

vi.mock('../../../services/unified-store/roosync-attachment-pg.js', () => ({
  getAttachmentPgReader: mockGetAttachmentPgReader,
  isAttachmentPgPrimary: () => process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY === '1',
  listAttachmentMetadataFromPg: vi.fn().mockResolvedValue(null),
  scanAttachmentMetadataFromPg: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../services/unified-store/roosync-channel-read.js', () => ({
  getChannelMessageFromPg: mockGetChannelMessageFromPg,
}));

import { roosyncListAttachments } from '../roosync-attachments.tool.js';

const storePath = path.join(os.tmpdir(), `rsm-4293-attachments-${process.pid}`);
const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_PG_URL',
] as const;
let savedEnv: Record<string, string | undefined> = {};

const meta = {
  uuid: 'att-uuid-4293',
  originalName: 'rapport.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  uploadedAt: '2026-10-20T12:00:00.000Z',
  uploaderMachineId: 'myia-po-2024:roo-extensions',
  messageId: 'msg-4293',
};

const fakeReader = { isNull: () => false };
const textOf = (result: { content: Array<{ type: string; text: string }> }) => result.content[0]!.text;

beforeEach(() => {
  savedEnv = {};
  for (const envKey of WATCHED_ENV) savedEnv[envKey] = process.env[envKey];
  process.env.ROOSYNC_SHARED_PATH = storePath;
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  process.env.UNIFIED_STORE_PG_URL = 'postgres://test@localhost:5432/test';
  rmSync(storePath, { recursive: true, force: true });
  mockGetAttachmentPgReader.mockReset().mockReturnValue(null);
  mockListAttachments.mockReset().mockResolvedValue([]);
  mockListAttachmentsByRefs.mockReset().mockResolvedValue([]);
  mockGetMessage.mockReset().mockResolvedValue(null);
  mockGetChannelMessageFromPg.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  rmSync(storePath, { recursive: true, force: true });
  for (const envKey of WATCHED_ENV) {
    if (savedEnv[envKey] === undefined) delete process.env[envKey];
    else process.env[envKey] = savedEnv[envKey];
  }
});

describe('#4293 — roosync_list_attachments, store absent + PG', () => {
  it('cas 1 — G: OK + PG OK : la liste est servie', async () => {
    mkdirSync(storePath, { recursive: true });
    mockGetAttachmentPgReader.mockReturnValue(fakeReader);
    mockListAttachments.mockResolvedValue([meta]);

    const text = textOf(await roosyncListAttachments({}));

    expect(text).toContain('att-uuid-4293');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 2 — G: absent + PG OK : refs lues dans PG, liste servie', async () => {
    mockGetAttachmentPgReader.mockReturnValue(fakeReader);
    mockGetChannelMessageFromPg.mockResolvedValue({
      id: 'msg-4293',
      attachments: [{ uuid: 'att-uuid-4293', filename: 'rapport.pdf', sizeBytes: 1024 }],
    });
    mockListAttachmentsByRefs.mockResolvedValue([meta]);

    const text = textOf(await roosyncListAttachments({ message_id: 'msg-4293' }));

    expect(text).toContain('att-uuid-4293');
    expect(mockListAttachmentsByRefs).toHaveBeenCalledWith(['att-uuid-4293'], expect.anything());
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 3 — G: absent + PG en échec : erreur explicite, jamais « aucune pièce jointe »', async () => {
    mockGetAttachmentPgReader.mockReturnValue(fakeReader);
    mockGetChannelMessageFromPg.mockResolvedValue(null);
    mockListAttachments.mockResolvedValue([]);

    const text = textOf(await roosyncListAttachments({ message_id: 'msg-4293' }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).toContain('PostgreSQL de secours');
    expect(text).not.toContain('Aucune pièce jointe trouvée');
  });

  it('cas 4 — G: absent + drapeau off : erreur de garde #3459 inchangée', async () => {
    mockGetAttachmentPgReader.mockReturnValue(null);

    const text = textOf(await roosyncListAttachments({}));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('PostgreSQL de secours');
  });

  it('cas 5 — G: absent + message PG sans ref : le vide est probant', async () => {
    mockGetAttachmentPgReader.mockReturnValue(fakeReader);
    mockGetChannelMessageFromPg.mockResolvedValue({ id: 'msg-4293', attachments: [] });
    mockListAttachmentsByRefs.mockResolvedValue([]);

    const text = textOf(await roosyncListAttachments({ message_id: 'msg-4293' }));

    expect(text).toContain('Aucune pièce jointe trouvée');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 6 — G: absent + scan PG primaire vide : le vide est probant aussi', async () => {
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    mockGetAttachmentPgReader.mockReturnValue(fakeReader);
    mockListAttachments.mockResolvedValue([]);

    const text = textOf(await roosyncListAttachments({}));

    expect(text).toContain('Aucune pièce jointe trouvée');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });
});