/**
 * #4302 — PG-primary serving of the four remaining GDrive-only channel
 * paths: bulkOperation, getInboxStats, cleanupExpiredMessages,
 * sendExpiryReminders.
 *
 * Issue criterion, verbatim: "pour chacun des 4 chemins, un test vitest rouge
 * sur `main` (lecteur PG doublé, store GDrive absent ou vide) prouve que la
 * réponse vient de PG sans appel à `ensureInboxCache` ; un second test
 * prouve le repli sur erreur PG."
 *
 * The reader is a fake behind the real gate chain: env vars +
 * `getChannelPgReader()` → `getUnifiedStoreReader()` (mocked factory) → the
 * fake reader. MessageManager itself is real, on a temp store whose inbox is
 * empty (the constructor creates the directories), so any non-empty answer
 * can only come from PG — and the `ensureInboxCache` spy pins the no-GDrive
 * property structurally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RooSyncMessageRow } from '../../../../src/services/unified-store/types.js';

const { mockGetUnifiedStoreReader, mockResetReaderInstance, mockMailbox, mockChannelPool } =
  vi.hoisted(() => ({
    mockGetUnifiedStoreReader: vi.fn(),
    mockResetReaderInstance: vi.fn(),
    /**
     * Fake reader faithful to the PG reader's mailbox semantics: candidates
     * are rows addressed to the machine or broadcast ('all'), newest first.
     * Tests set the return value (rows) or the rejection (PG error) per case.
     */
    mockMailbox: vi.fn(),
    /** Whole-channel pool (#4302 reader method) — same freedom. */
    mockChannelPool: vi.fn(),
  }));

vi.mock('../../../../src/services/unified-store/reader-factory.js', () => ({
  getUnifiedStoreReader: () =>
    mockGetUnifiedStoreReader() ?? {
      isNull: () => false,
      // WHERE to_machine = $1 OR to_machine IN ('all','All')
      getRooSyncMailbox: async (machineId: string) =>
        (await mockMailbox(machineId)) as RooSyncMessageRow[],
      getRooSyncChannelMessages: async () =>
        (await mockChannelPool()) as RooSyncMessageRow[],
    },
  resetReaderInstance: mockResetReaderInstance,
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { MessageManager } from '../../../../src/services/MessageManager.js';

const MACHINE = 'myia-po-2023';
const WS = 'ws-4302';

let sharedRoot: string;
let mm: MessageManager;
let cacheSpy: ReturnType<typeof vi.spyOn>;

function row(overrides: Partial<RooSyncMessageRow> & Pick<RooSyncMessageRow, 'id' | 'to_machine'>): RooSyncMessageRow {
  return {
    thread_id: null,
    from_machine: 'other-mac',
    from_workspace: '',
    to_workspace: '',
    subject: 'sujet',
    body: 'corps',
    priority: 'MEDIUM',
    status: 'unread',
    tags: [],
    attachment_refs: [],
    created_at: '2026-10-21T05:00:00Z',
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: {},
    ...overrides,
  };
}

/** Seed one message file in the (real, empty) GDrive twin inbox. */
function seedGDriveMessage(message: Record<string, unknown>): void {
  writeFileSync(join(sharedRoot, 'messages', 'inbox', `${message.id}.json`), JSON.stringify(message, null, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  sharedRoot = mkdtempSync(join(tmpdir(), 'rsm-4302-'));
  mm = new MessageManager(sharedRoot);
  // Private, but the issue criterion names it — spy through the instance.
  cacheSpy = vi.spyOn(mm as unknown as { ensureInboxCache: () => unknown }, 'ensureInboxCache');
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgresql://fake-4302';
  process.env.ROOSYNC_WORKSPACE_ID = WS;
  // Factory mock present by default (gate ON); PG-error cases flip the
  // mailbox/pool mocks to rejecting — the reader is still non-Null there.
  mockGetUnifiedStoreReader.mockReturnValue(undefined);
});

afterEach(() => {
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.ROOSYNC_WORKSPACE_ID;
  rmSync(sharedRoot, { recursive: true, force: true });
});

// ─── bulkOperation ───────────────────────────────────────────────────

describe('#4302 bulkOperation — PG-primary', () => {
  it('serves the match scan from PG without ensureInboxCache (GDrive empty)', async () => {
    mockMailbox.mockResolvedValue([
      row({ id: 'pg-urgent', to_machine: MACHINE, priority: 'URGENT', from_machine: 'alpha-mac', subject: 'panne', tags: ['DONE'] }),
      row({ id: 'pg-medium', to_machine: MACHINE }),
    ]);
    const markAsRead = vi.spyOn(mm, 'markAsRead').mockResolvedValue(true);

    const result = await mm.bulkOperation(MACHINE, 'mark_read', { priority: 'URGENT' });

    expect(result.matched).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.message_ids).toEqual(['pg-urgent']);
    expect(markAsRead).toHaveBeenCalledWith('pg-urgent', `${MACHINE}:${WS}`);
    expect(cacheSpy).not.toHaveBeenCalled();
  });

  it('falls back to the GDrive cache when PG errors', async () => {
    mockMailbox.mockRejectedValue(new Error('PG is down'));
    seedGDriveMessage({ id: 'gdrive-1', from: 'alpha-mac', to: MACHINE, subject: 'panne', body: 'b', priority: 'URGENT', status: 'unread', timestamp: '2026-10-21T05:00:00Z', tags: ['DONE'] });
    const markAsRead = vi.spyOn(mm, 'markAsRead').mockResolvedValue(true);

    const result = await mm.bulkOperation(MACHINE, 'mark_read', { priority: 'URGENT' });

    expect(result.matched).toBe(1);
    expect(markAsRead).toHaveBeenCalledWith('gdrive-1', `${MACHINE}:${WS}`);
    expect(cacheSpy).toHaveBeenCalled();
  });
});

// ─── getInboxStats ───────────────────────────────────────────────────

describe('#4302 getInboxStats — PG-primary', () => {
  it('computes the stats from PG rows without ensureInboxCache (GDrive empty)', async () => {
    mockMailbox.mockResolvedValue([
      // Direct, unread — the oldest unread message in the set.
      row({ id: 'pg-old-unread', to_machine: MACHINE, priority: 'LOW', created_at: '2026-10-20T05:00:00Z' }),
      // Direct, unread.
      row({ id: 'pg-new-unread', to_machine: MACHINE, priority: 'URGENT', created_at: '2026-10-21T04:00:00Z', from_machine: 'beta-mac' }),
      // Direct, read.
      row({ id: 'pg-read', to_machine: MACHINE, status: 'read', priority: 'HIGH' }),
      // Broadcast this machine already read → counts read via read_by.
      row({ id: 'pg-broadcast', to_machine: 'all', read_by: [MACHINE] }),
    ]);

    const stats = await mm.getInboxStats(MACHINE);

    expect(stats.total).toBe(4);
    expect(stats.unread).toBe(2);
    expect(stats.read).toBe(2);
    expect(stats.by_priority).toEqual({ LOW: 1, URGENT: 1, HIGH: 1, MEDIUM: 1 });
    expect(stats.by_priority_unread).toEqual({ LOW: 1, URGENT: 1 });
    expect(stats.by_sender).toEqual({ 'other-mac': 3, 'beta-mac': 1 });
    expect(stats.oldest_unread).toBe('2026-10-20T05:00:00Z');
    expect(cacheSpy).not.toHaveBeenCalled();
  });

  it('falls back to the GDrive cache when PG errors', async () => {
    mockMailbox.mockRejectedValue(new Error('PG is down'));
    seedGDriveMessage({ id: 'gdrive-1', from: 'alpha-mac', to: MACHINE, subject: 's', body: 'b', priority: 'HIGH', status: 'unread', timestamp: '2026-10-21T05:00:00Z' });

    const stats = await mm.getInboxStats(MACHINE);

    expect(stats.total).toBe(1);
    expect(stats.unread).toBe(1);
    expect(stats.by_priority).toEqual({ HIGH: 1 });
    expect(cacheSpy).toHaveBeenCalled();
  });
});

// ─── cleanupExpiredMessages ──────────────────────────────────────────

describe('#4302 cleanupExpiredMessages — PG-primary', () => {
  it('destroys expired messages from the PG pool without ensureInboxCache (GDrive empty)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    mockChannelPool.mockResolvedValue([
      row({
        id: 'pg-expired',
        to_machine: 'another-mac', // global scan: recipient-blind on purpose
        options: { auto_destruct: true, expires_at: past },
      }),
      row({
        id: 'pg-alive',
        to_machine: 'another-mac',
        options: { auto_destruct: true, expires_at: '2099-01-01T00:00:00Z' },
      }),
    ]);
    const destroy = vi.spyOn(mm, 'destroyMessage').mockResolvedValue(true);

    const destroyed = await mm.cleanupExpiredMessages();

    expect(destroyed).toBe(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith('pg-expired', 'ttl_expired');
    expect(cacheSpy).not.toHaveBeenCalled();
  });

  it('falls back to the GDrive pool when PG errors', async () => {
    mockChannelPool.mockRejectedValue(new Error('PG is down'));
    seedGDriveMessage({
      id: 'gdrive-expired',
      from: 'alpha-mac',
      to: MACHINE,
      subject: 's',
      body: 'b',
      priority: 'MEDIUM',
      status: 'unread',
      timestamp: '2026-10-21T04:30:00Z',
      auto_destruct: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const destroy = vi.spyOn(mm, 'destroyMessage').mockResolvedValue(true);

    const destroyed = await mm.cleanupExpiredMessages();

    expect(destroyed).toBe(1);
    expect(destroy).toHaveBeenCalledWith('gdrive-expired', 'ttl_expired');
    expect(cacheSpy).toHaveBeenCalled();
  });
});

// ─── sendExpiryReminders ─────────────────────────────────────────────

describe('#4302 sendExpiryReminders — PG-primary', () => {
  it('sends reminders from the PG pool without ensureInboxCache (GDrive empty)', async () => {
    // expires in ~3 min; TTL 30m → threshold max(5min, 3m) = 5min → eligible.
    const expiresSoon = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    mockChannelPool.mockResolvedValue([
      row({
        id: 'pg-remind-me',
        to_machine: 'another-mac',
        options: { auto_destruct: true, expires_at: expiresSoon, destruct_after: '30m' },
      }),
      // Already destroyed — never reminded.
      row({
        id: 'pg-destroyed',
        to_machine: 'another-mac',
        destroyed_at: '2026-10-21T04:00:00Z',
        options: { auto_destruct: true, expires_at: expiresSoon, destruct_after: '30m' },
      }),
    ]);
    const send = vi.spyOn(mm, 'sendMessage').mockResolvedValue('pg-reminder' as never);

    const sent = await mm.sendExpiryReminders();

    expect(sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // args: (from='system', to, subject, body, ...) — the id lives in the body.
    expect(send.mock.calls[0][2]).toContain('[REMINDER]');
    expect(send.mock.calls[0][3]).toContain('pg-remind-me');
    expect(cacheSpy).not.toHaveBeenCalled();
  });

  it('falls back to the GDrive pool when PG errors', async () => {
    mockChannelPool.mockRejectedValue(new Error('PG is down'));
    seedGDriveMessage({
      id: 'gdrive-remind-me',
      from: 'alpha-mac',
      to: MACHINE,
      subject: 's',
      body: 'b',
      priority: 'MEDIUM',
      status: 'unread',
      timestamp: '2026-10-21T04:30:00Z',
      auto_destruct: true,
      expires_at: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
      destruct_after: '30m',
    });
    const send = vi.spyOn(mm, 'sendMessage').mockResolvedValue('gdrive-reminder' as never);

    const sent = await mm.sendExpiryReminders();

    expect(sent).toBe(1);
    expect(send.mock.calls[0][3]).toContain('gdrive-remind-me');
    expect(cacheSpy).toHaveBeenCalled();
  });
});
