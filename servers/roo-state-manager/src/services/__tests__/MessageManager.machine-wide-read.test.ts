/**
 * Machine-wide targets: read state is per WORKSPACE, not global.
 *
 * The defect these cover: a message addressed to a machine WITHOUT a workspace
 * ("myia-ai-01", as opposed to "myia-ai-01:roo-extensions") is delivered to
 * EVERY workspace of that machine — `matchesRecipient` returns true for all of
 * them, by design. Its read state, however, was GLOBAL: `applyReadTracking`
 * flipped `status: 'read'` for anything that was not the "all"/"All" broadcast.
 * So the first workspace to read such a message consumed it for every other
 * workspace on the machine, which never saw it.
 *
 * The failure was invisible from both ends. Live: the #2287 workspace guard
 * only fires when the TARGET carries a workspace, so a machine-wide target
 * skips it and logs nothing (0 real firings in production logs, against 25
 * cross-machine denials — the guard works, it just cannot see this class).
 * Forensically: `read_by` is machine-granular, so nothing recorded WHICH
 * workspace consumed the message.
 *
 * The principle is not new. `markAsRead` already documents it for broadcasts:
 * "a global 'read' would hide them from machines that have not read them".
 * This is the same sentence with "workspaces" in place of "machines" — a class
 * the reasoning was never extended to.
 *
 * Two MessageManager instances over one shared-state directory model the real
 * situation: separate processes (52 live roo-state-manager processes on ai-01),
 * each with its own cache, sharing one message store.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { MessageManager } from '../MessageManager.js';

const MACHINE = 'myia-ai-01';
const WS_A = 'roo-extensions';
const WS_B = 'CoursIA';

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-mwt-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function seed(sharedState: string, id: string, to: string, status = 'unread'): void {
  const msg = {
    id,
    from: 'myia-po-2023:roo-extensions',
    to,
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'MEDIUM',
    timestamp: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    status,
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

function onDisk(sharedState: string, id: string): any {
  return JSON.parse(readFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), 'utf-8'));
}

/** A fresh manager models a separate process: its own cache, same store. */
function process_(sharedState: string): MessageManager {
  return new MessageManager(sharedState, 5000);
}

describe('MessageManager — machine-wide targets are read per workspace', () => {
  let shared: string;

  beforeEach(() => {
    shared = makeTempSharedState();
  });

  afterEach(() => {
    rmSync(shared, { recursive: true, force: true });
  });

  test('one workspace reading a machine-wide message does NOT consume it for another', async () => {
    const id = 'msg-20260901T100000-mwtaaa';
    seed(shared, id, MACHINE);

    // Both workspaces receive it — that part was never in doubt.
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_A)).map(m => m.id)).toEqual([id]);
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_B)).map(m => m.id)).toEqual([id]);

    // Workspace A reads it.
    expect(await process_(shared).markAsRead(id, `${MACHINE}:${WS_A}`)).toBe(true);

    // A sees it read...
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_A)).map(m => m.id)).toEqual([]);
    expect((await process_(shared).readInbox(MACHINE, 'read', undefined, WS_A)).map(m => m.id)).toEqual([id]);

    // ...and B still has it UNREAD. This is the whole point: before the fix the
    // global status flip made this list empty, and B never learned the message existed.
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_B)).map(m => m.id)).toEqual([id]);
  });

  test('the global status is left untouched, and the reader is recorded per workspace', async () => {
    const id = 'msg-20260901T100001-mwtbbb';
    seed(shared, id, MACHINE);

    await process_(shared).markAsRead(id, `${MACHINE}:${WS_A}`);

    const raw = onDisk(shared, id);
    // A global 'read' is exactly what hid the message from the other workspaces.
    expect(raw.status).toBe('unread');
    expect(raw.read_by_workspace).toEqual([`${MACHINE}:${WS_A}`]);
  });

  test('counts follow the same rule (listing and counting cannot disagree)', async () => {
    const id = 'msg-20260901T100002-mwtccc';
    seed(shared, id, MACHINE);

    await process_(shared).markAsRead(id, `${MACHINE}:${WS_A}`);

    expect(await process_(shared).getFilteredCount(MACHINE, 'all', WS_A))
      .toEqual({ total: 1, unread: 0, read: 1 });
    expect(await process_(shared).getFilteredCount(MACHINE, 'all', WS_B))
      .toEqual({ total: 1, unread: 1, read: 0 });
  });

  test('workspace-targeted messages keep the global flip (unchanged)', async () => {
    const id = 'msg-20260901T100003-mwtddd';
    seed(shared, id, `${MACHINE}:${WS_A}`);

    await process_(shared).markAsRead(id, `${MACHINE}:${WS_A}`);

    expect(onDisk(shared, id).status).toBe('read');
    expect(onDisk(shared, id).read_by_workspace).toBeUndefined();
  });

  test('broadcasts keep per-MACHINE tracking via read_by (unchanged)', async () => {
    const id = 'msg-20260901T100004-mwteee';
    seed(shared, id, 'all');

    await process_(shared).markAsRead(id, `${MACHINE}:${WS_A}`);

    const raw = onDisk(shared, id);
    expect(raw.status).toBe('unread');
    expect(raw.read_by).toEqual([MACHINE]);
    // A broadcast is machine-granular by design: both workspaces of ai-01 now see it read.
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_B)).map(m => m.id)).toEqual([]);
  });

  test('a message already flipped globally is NOT resurrected as unread', async () => {
    // The fleet's existing stock: machine-wide messages read under the OLD
    // semantics carry status 'read' and no per-workspace record — and never
    // will, nothing backfills them. Deciding purely on `read_by_workspace`
    // would report every one of them unread again, on seven machines, the day
    // this ships. Per-workspace tracking governs messages that have not
    // already been consumed globally; it does not reopen the ones that have.
    const id = 'msg-20260901T100006-mwtggg';
    seed(shared, id, MACHINE, 'read');

    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_A)).map(m => m.id)).toEqual([]);
    expect((await process_(shared).readInbox(MACHINE, 'unread', undefined, WS_B)).map(m => m.id)).toEqual([]);
    expect(await process_(shared).getFilteredCount(MACHINE, 'all', WS_B))
      .toEqual({ total: 1, unread: 0, read: 1 });
  });

  test('a reader without a workspace still clears the message (no permanent unread)', async () => {
    const id = 'msg-20260901T100005-mwtfff';
    seed(shared, id, MACHINE);

    // Nothing can be tracked per workspace here, so the global flip must remain
    // available — otherwise such a message could never be cleared at all.
    await process_(shared).markAsRead(id, MACHINE);

    expect(onDisk(shared, id).status).toBe('read');
  });
});
