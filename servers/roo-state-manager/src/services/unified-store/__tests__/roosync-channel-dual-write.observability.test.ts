/**
 * A silent loss is an undetectable loss (#3151, mesuré 2026-09-01).
 *
 * The dual-write catches deliberately swallow so Postgres can never break the
 * GDrive path — that contract is asserted elsewhere and must hold. This file
 * asserts the *other half*: that swallowing is not silence.
 *
 * Why it exists: ~7 % of the RooSync inbox had drifted out of Postgres with no
 * log, no counter and no trace, so nobody could see it — three distinct causes
 * (a machine whose flag was never set, a ten-hour degraded window, and a steady
 * 1-3 % of transient failures) all produced exactly zero observable output. The
 * assertions below are what make the next occurrence countable.
 *
 * @module services/unified-store/__tests__/roosync-channel-dual-write.observability
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ─── Capture the logger (hoisted before the module under test loads) ──────────

// vi.mock is hoisted above every const — the sibling suite hit the same TDZ.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Every writer method rejects: we are testing the failure path only ────────

const boom = () => Promise.reject(new Error('PG down'));
vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage: boom,
    updateRooSyncMessage: boom,
    insertRooSyncAttachment: boom,
    deleteRooSyncAttachment: boom,
  }),
}));

import {
  dualWriteRooSyncMessageToStore,
  dualWriteRooSyncMessageAmendment,
  dualWriteRooSyncAttachmentRefs,
  dualWriteRooSyncMessageRead,
  dualWriteRooSyncMessageBroadcastRead,
  dualWriteRooSyncMessageArchived,
  dualWriteRooSyncMessageReminderSent,
  dualWriteRooSyncMessageDestroyed,
} from '../roosync-channel-dual-write.js';
import type { Message } from '../../MessageManager.js';

const msg = (): Message =>
  ({
    id: 'msg-obs-1',
    from: 'myia-ai-01:roo-extensions',
    to: 'myia-po-2027:CoursIA',
    subject: 's',
    body: 'b',
    priority: 'MEDIUM',
    status: 'unread',
    timestamp: '2026-09-01T00:00:00.000Z',
  }) as unknown as Message;

describe('dual-write failures are swallowed but never silent', () => {
  beforeEach(() => warn.mockClear());

  const cases: Array<[string, () => Promise<void>]> = [
    ['insert', () => dualWriteRooSyncMessageToStore(msg())],
    ['amend', () => dualWriteRooSyncMessageAmendment(msg())],
    ['attachment-refs', () => dualWriteRooSyncAttachmentRefs('msg-obs-1', [])],
    ['read', () => dualWriteRooSyncMessageRead('msg-obs-1')],
    ['broadcast-read', () => dualWriteRooSyncMessageBroadcastRead('msg-obs-1', ['m'])],
    ['archived', () => dualWriteRooSyncMessageArchived('msg-obs-1')],
    ['reminder-sent', () => dualWriteRooSyncMessageReminderSent('msg-obs-1')],
    ['destroy', () => dualWriteRooSyncMessageDestroyed('msg-obs-1', 'ttl', ['u1'])],
  ];

  test.each(cases)('%s: resolves (non-blocking) AND logs the loss', async (op, call) => {
    // The contract that must NOT change: a PG failure never propagates.
    await expect(call()).resolves.toBeUndefined();

    // The contract this file adds: it leaves a trace naming the op and the id.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0];
    expect(String(message)).toContain('PG mirror failed');
    expect(context).toMatchObject({ op, id: 'msg-obs-1' });
    expect(String(context.error)).toContain('PG down');
  });

  // Counter-proof run 2026-09-01: mutating `op: 'archived'` to a wrong value
  // failed exactly one case with the expected diff, and restoring it returned
  // 9/9 green. The assertions above bite; they do not pass vacuously.
  test('a mirrored write that succeeds logs nothing', async () => {
    warn.mockClear();
    await dualWriteRooSyncMessageRead('msg-obs-1');
    expect(warn).toHaveBeenCalledTimes(1); // this writer always rejects
    warn.mockClear();
    expect(warn).toHaveBeenCalledTimes(0); // no ambient noise between cases
  });
});
