/**
 * #3482 — anti-twin guard on the message archive writer.
 *
 * Fleet measurement (ai-01, 07/09): 1560 byte-identical ` (N).json` twins in
 * messages/archive/ over seven months — the unifying mechanism is a write to an
 * ALREADY-OCCUPIED name producing a twin instead of replacing (wedged DriveFS).
 * The archive writer hits it via re-archiving: the sync layer resurrects an
 * inbox file for an id already archived, archiveMessage rewrites the occupied
 * canonical, DriveFS deviates the rewrite to `id (1).json`.
 *
 * These tests hold both halves of the fix:
 *   1. Re-archive with the canonical already present and IDENTICAL content →
 *      the rewrite is SKIPPED (terminal state — rewriting an occupied name is
 *      the twin-producing gesture), the inbox is still drained, archiveMessage
 *      still returns true (idempotence preserved).
 *   2. Re-archive where the resurrected inbox copy DIVERGED (markAsRead after
 *      resurrection accumulates read_by_workspace on the inbox copy) → the
 *      canonical is REWRITTEN with the incoming state — skipping would erase
 *      that state silently since the inbox is unlinked right after (review
 *      of #1115: the skip must be conditioned on content, not existence).
 *   3. First-archive write with a fresh twin sibling in the write window →
 *      loud [MESSAGE-TWIN] logger.error naming the twin — never blocking the
 *      archive itself.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: mockLoggerError
  })
}));

import { MessageManager } from '../MessageManager.js';

const READER = 'myia-po-2025:roo-extensions';

describe('MessageManager archive twin guard (#3482)', () => {
  let sharedState: string;
  let archiveDir: string;
  let inboxDir: string;
  let manager: MessageManager;

  beforeEach(() => {
    sharedState = join(tmpdir(), 'mm-twin-' + randomUUID());
    inboxDir = join(sharedState, 'messages', 'inbox');
    archiveDir = join(sharedState, 'messages', 'archive');
    for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
      mkdirSync(join(sharedState, sub), { recursive: true });
    }
    manager = new MessageManager(sharedState, 5000);
    mockLoggerError.mockClear();
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
  });

  const seedInbox = (id: string, to: string = READER): void => {
    // Fixed timestamp: a resurrection must replay the SAME bytes for the
    // identical-skip test — a wall-clock stamp would make every resurrected
    // copy diverge from the canonical by construction.
    writeFileSync(
      join(inboxDir, id + '.json'),
      JSON.stringify({
        id,
        from: 'myia-ai-01',
        to,
        subject: 's',
        body: 'b',
        status: 'unread',
        timestamp: '2026-09-07T05:00:00.000Z'
      }),
      'utf8'
    );
  };

  test('re-archive with IDENTICAL canonical SKIPS the rewrite and still drains the inbox', async () => {
    const id = 'msg-twintest-resurrected';
    seedInbox(id);
    const canonical = join(archiveDir, id + '.json');

    await manager.archiveMessage(id);
    const firstArchiveBytes = readFileSync(canonical, 'utf8');

    // Sync resurrection: the inbox copy reappears with the same content.
    seedInbox(id);
    const ok = await manager.archiveMessage(id);

    expect(ok).toBe(true);
    expect(readFileSync(canonical, 'utf8')).toBe(firstArchiveBytes);
    // Inbox drained — the resurrection is consumed either way.
    expect(() => readFileSync(join(inboxDir, id + '.json'), 'utf8')).toThrow();
  });

  test('re-archive after markAsRead on the resurrected copy PRESERVES read_by_workspace in the canonical', async () => {
    // The path review of #1115 verified: archive → sync resurrects the inbox →
    // a workspace markAsRead accumulates read_by_workspace on the inbox copy →
    // re-archive must WRITE that state (skip-on-existence would erase it, the
    // inbox being unlinked right after — a machine-wide message would then
    // reappear unread to a reader who had read it).
    const id = 'msg-twintest-readstate';
    const machineWideTarget = 'myia-po-2025';
    seedInbox(id, machineWideTarget);
    await manager.archiveMessage(id);

    // Resurrection + a workspace of the machine reads the message.
    seedInbox(id, machineWideTarget);
    const read = await manager.markAsRead(id, READER);
    expect(read).toBe(true);

    const ok = await manager.archiveMessage(id);

    expect(ok).toBe(true);
    const archived = JSON.parse(readFileSync(join(archiveDir, id + '.json'), 'utf8'));
    expect(archived.status).toBe('archived');
    expect(archived.read_by).toContain('myia-po-2025');
    expect(archived.read_by_workspace).toContain('myia-po-2025:roo-extensions');
    expect(() => readFileSync(join(inboxDir, id + '.json'), 'utf8')).toThrow();
  });

  test('first archive writes the canonical with status archived', async () => {
    const id = 'msg-twintest-fresh';
    seedInbox(id);

    const ok = await manager.archiveMessage(id);

    expect(ok).toBe(true);
    const archived = JSON.parse(readFileSync(join(archiveDir, id + '.json'), 'utf8'));
    expect(archived.status).toBe('archived');
  });

  test('fresh twin sibling in the write window triggers a loud [MESSAGE-TWIN] error without blocking', async () => {
    const id = 'msg-twintest-deviated';
    seedInbox(id);
    // Simulate the deviation artifact: a collision-named twin with a fresh
    // mtime inside the upcoming write's window.
    const twin = join(archiveDir, id + ' (1).json');
    writeFileSync(twin, '{}', 'utf8');
    const now = new Date();
    utimesSync(twin, now, now);

    const ok = await manager.archiveMessage(id);

    expect(ok).toBe(true);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('[MESSAGE-TWIN]'),
      expect.anything()
    );
  });

  test('stale archived twin (mtime outside the window) does not alarm', async () => {
    const id = 'msg-twintest-stale';
    seedInbox(id);
    const twin = join(archiveDir, id + ' (1).json');
    writeFileSync(twin, 'old twin from months ago', 'utf8');
    const oneHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(twin, oneHourAgo, oneHourAgo);

    const ok = await manager.archiveMessage(id);

    expect(ok).toBe(true);
    const twinCalls = mockLoggerError.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('[MESSAGE-TWIN]')
    );
    expect(twinCalls).toHaveLength(0);
  });
});
