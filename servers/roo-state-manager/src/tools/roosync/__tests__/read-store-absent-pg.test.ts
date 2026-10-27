/**
 * #4293 — roosync_read face à un store partagé absent, PG vivant.
 *
 * La garde #3459 (`assertSharedStoreAccessible`) s'exécutait AVANT toute
 * tentative PG : avec G: démonté, l'inbox et la lecture d'un message étaient
 * coupées même quand PostgreSQL portait déjà la lecture. Ce fichier épingle les
 * quatre cas de chaque mode :
 *
 *   1. G: OK  + PG OK   → lecture servie (PG-premier), rien ne casse ;
 *   2. G: absent + PG OK → PG sert, la garde ne bloque pas ;
 *   3. G: absent + PG KO → erreur explicite (jamais une inbox vide) ;
 *   4. G: absent + drapeau off → erreur de garde, comportement #3459 inchangé.
 *
 * Le lecteur PG est doublé (aucun Postgres requis) ; `readChannelInboxFromPg`
 * et `getChannelMessageFromPg` restent RÉELS pour exercer le repli null et le
 * mapping des lignes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, rmSync } from 'fs';

const { mockGetChannelPgReader, managerRef } = vi.hoisted(() => ({
  mockGetChannelPgReader: vi.fn(),
  managerRef: { current: null as unknown },
}));

vi.mock('../../../services/unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/unified-store/roosync-channel-read.js')>();
  return { ...actual, getChannelPgReader: () => mockGetChannelPgReader() };
});

vi.mock('../../../services/MessageManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/MessageManager.js')>();
  return { ...actual, getMessageManager: () => managerRef.current };
});

import { roosyncRead } from '../read.js';
import { MessageManager, type Message } from '../../../services/MessageManager.js';
import type { RooSyncMessageRow } from '../../../services/unified-store/types.js';

const storePath = path.join(os.tmpdir(), `rsm-4293-read-${process.pid}`);
const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_PG_URL',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function sampleRow(overrides: Partial<RooSyncMessageRow> = {}): RooSyncMessageRow {
  return {
    id: 'msg-20261020T120000-abcdef',
    thread_id: '',
    from_machine: 'myia-po-2024',
    from_workspace: 'roo-extensions',
    to_machine: 'myia-ai-01',
    to_workspace: '',
    subject: '[TASK] store absent mais PG vivant',
    body: 'Contenu servi par PG pendant la coupure G:.',
    priority: 'HIGH',
    status: 'unread',
    tags: ['TASK'],
    attachment_refs: [],
    created_at: '2026-10-20T12:00:00.000Z',
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: {},
    ...overrides,
  };
}

/** Reader PG dont la moitié canal est pilotable par test. */
function fakeReader(overrides: Record<string, unknown> = {}) {
  return {
    isNull: () => false,
    getRooSyncMailbox: vi.fn().mockResolvedValue([sampleRow()]),
    getRooSyncMessageById: vi.fn().mockResolvedValue(sampleRow()),
    // #4131: the PG-PRIMARY gate now DEFAULTS ON wherever a PG URL is
    // configured, so the pre-listing sweeps (auto-archive / cleanup /
    // reminders) take their PG branch on this seat. The fake must answer the
    // whole-channel pool too, else those sweeps see a thrown TypeError and
    // the read fails for the wrong reason.
    getRooSyncChannelMessages: vi.fn().mockResolvedValue([sampleRow()]),
    ...overrides,
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = storePath;
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  process.env.UNIFIED_STORE_PG_URL = 'postgres://test@localhost:5432/test';
  rmSync(storePath, { recursive: true, force: true });
  managerRef.current = new MessageManager(storePath);
  mockGetChannelPgReader.mockReset().mockReturnValue(null);
});

afterEach(() => {
  rmSync(storePath, { recursive: true, force: true });
  for (const key of WATCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('#4293 — roosync_read inbox, store absent + PG', () => {
  it('cas 1 — G: OK + PG OK : la lecture est servie', async () => {
    mkdirSync(storePath, { recursive: true });
    mockGetChannelPgReader.mockReturnValue(fakeReader());

    const text = textOf(await roosyncRead({ mode: 'inbox' }));

    expect(text).toContain('[TASK] store absent mais PG vivant');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 2 — G: absent + PG OK : PG sert l’inbox, la garde ne bloque pas', async () => {
    mockGetChannelPgReader.mockReturnValue(fakeReader());

    const text = textOf(await roosyncRead({ mode: 'inbox' }));

    expect(text).toContain('[TASK] store absent mais PG vivant');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 3 — G: absent + PG en échec : erreur explicite, jamais une inbox vide', async () => {
    mockGetChannelPgReader.mockReturnValue(
      fakeReader({ getRooSyncMailbox: vi.fn().mockRejectedValue(new Error('pg down')) })
    );

    const text = textOf(await roosyncRead({ mode: 'inbox' }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).toContain('PostgreSQL de secours');
    expect(text).not.toContain('Aucun message');
  });

  it('cas 4 — G: absent + drapeau off : erreur de garde #3459 inchangée', async () => {
    mockGetChannelPgReader.mockReturnValue(null);

    const text = textOf(await roosyncRead({ mode: 'inbox' }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('PostgreSQL de secours');
  });
});

describe('#4293 — roosync_read message, store absent + PG', () => {
  const messageId = 'msg-20261020T120000-abcdef';

  function asMessage(): Message {
    const row = sampleRow();
    return {
      id: row.id,
      from: `${row.from_machine}:${row.from_workspace}`,
      to: row.to_machine,
      subject: row.subject,
      body: row.body,
      priority: row.priority as Message['priority'],
      status: row.status,
      timestamp: row.created_at,
      tags: row.tags,
    };
  }

  it('cas 1 — G: OK + PG OK : le message est servi', async () => {
    mkdirSync(storePath, { recursive: true });
    mockGetChannelPgReader.mockReturnValue(
      fakeReader({ getRooSyncMessageById: vi.fn().mockResolvedValue(sampleRow()) })
    );

    const text = textOf(await roosyncRead({ mode: 'message', message_id: messageId }));

    expect(text).toContain('Contenu servi par PG pendant la coupure G:.');
  });

  it('cas 2 — G: absent + PG OK : le message est servi par PG', async () => {
    mockGetChannelPgReader.mockReturnValue(
      fakeReader({ getRooSyncMessageById: vi.fn().mockResolvedValue(sampleRow()) })
    );

    const text = textOf(await roosyncRead({ mode: 'message', message_id: messageId }));

    expect(text).toContain('Contenu servi par PG pendant la coupure G:.');
    expect(text).not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 3 — G: absent + PG en échec : erreur explicite, jamais « Message introuvable »', async () => {
    mockGetChannelPgReader.mockReturnValue(
      fakeReader({ getRooSyncMessageById: vi.fn().mockRejectedValue(new Error('pg down')) })
    );

    const text = textOf(await roosyncRead({ mode: 'message', message_id: messageId }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).toContain('PostgreSQL de secours');
    expect(text).not.toContain('Message introuvable');
  });

  it('cas 4 — G: absent + drapeau off : erreur de garde #3459 inchangée', async () => {
    mockGetChannelPgReader.mockReturnValue(null);

    const text = textOf(await roosyncRead({ mode: 'message', message_id: messageId }));

    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('PostgreSQL de secours');
    // sanity: the fixture is reachable through the PG reader shape used above
    expect(asMessage().id).toBe(messageId);
  });
});