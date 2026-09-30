/**
 * `roosync_manage` must agree with `readInbox` on what "already read" means.
 *
 * Machine-wide targets ("myia-ai-01", no workspace) are delivered to EVERY
 * workspace of the machine, so their readers are tracked per workspace in
 * `read_by_workspace` and the global `status` deliberately stays 'unread' —
 * a global flip would hide the message from workspaces that never saw it.
 *
 * `roosync_manage` computed its own answer with `message.status === 'read'`.
 * That is a FOURTH decision site, in another file, that the centralisation in
 * MessageManager.perReaderStatus did not reach: it would tell a workspace that
 * had already read such a message that it had not, and rewrite the file for
 * nothing — while `readInbox` reported the opposite.
 *
 * The same defect class as the bug being fixed: a check standing on a
 * NEIGHBOURING property (the global status) of the one that matters (this
 * reader's state).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MACHINE = 'myia-ai-01';
const WS = 'roo-extensions';

vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  const getLocalMachineId = vi.fn(() => 'myia-ai-01');
  const getLocalFullId = vi.fn(() => 'myia-ai-01:roo-extensions');
  const getLocalWorkspaceId = vi.fn(() => 'roo-extensions');
  return {
    ...actual,
    getLocalMachineId,
    getLocalFullId,
    getLocalWorkspaceId,
    // #3591: the real resolveCallerIdentity binds to the real module
    // internals and bypasses the mocks above — reimplement it against them.
    resolveCallerIdentity: (as?: string) => {
      if (!as) {
        return { machineId: getLocalMachineId(), workspaceId: getLocalWorkspaceId(), fullId: getLocalFullId() };
      }
      const parsed = actual.parseMachineWorkspace(actual.canonicalizeFullId(as));
      return {
        machineId: parsed.machineId,
        workspaceId: parsed.workspaceId,
        fullId: parsed.workspaceId ? `${parsed.machineId}:${parsed.workspaceId}` : parsed.machineId,
      };
    },
  };
});

const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-manage-machine-wide');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => new actual.MessageManager(testSharedStatePath),
  };
});

import { roosyncManage } from '../manage.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncManage — machine-wide targets (integration)', () => {
  let messageManager: MessageManager;

  beforeEach(() => {
    for (const sub of ['', 'messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
      const dir = join(testSharedStatePath, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    messageManager = new MessageManager(testSharedStatePath);
  });

  afterEach(() => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  const getText = (r: { content: Array<{ type: string; text: string }> }) => r.content[0].text;

  const onDisk = (id: string) =>
    JSON.parse(readFileSync(join(testSharedStatePath, 'messages', 'inbox', id + '.json'), 'utf-8'));

  test('a second mark_read from the same workspace is recognised as already read', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE, 'Machine-wide notice', 'body', 'MEDIUM'
    );

    expect(getText(await roosyncManage({ action: 'mark_read', message_id: msg.id })))
      .toContain('marqué comme lu');

    // Tracked per workspace; the global status stays unread by design.
    const raw = onDisk(msg.id);
    expect(raw.status).toBe('unread');
    expect(raw.read_by_workspace).toEqual([MACHINE + ':' + WS]);

    // Reading `status` here answered "not read" and rewrote the file for nothing.
    const second = getText(await roosyncManage({ action: 'mark_read', message_id: msg.id }));
    expect(second).toContain('déjà marqué comme lu');
    expect(second).toContain('workspace(s)');
    expect(second).toContain(MACHINE + ':' + WS);
  });

  test('getInboxStats agrees with readInbox once the workspace has read it', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE, 'Machine-wide notice', 'body', 'MEDIUM'
    );
    await roosyncManage({ action: 'mark_read', message_id: msg.id });

    // Same on-disk state as the test above: read per workspace, globally 'unread'.
    expect(onDisk(msg.id).status).toBe('unread');

    // A FIFTH decision site. `getInboxStats` open-coded the broadcast half of
    // perReaderStatus and fell back to the global status for everything else,
    // so it answered "unread" on a message this workspace had just read — the
    // `roosync_messages(action:"stats")` surface contradicting action:"inbox"
    // on the very same mailbox (ai-01, 2026-09-07: 117 unread vs 0).
    const stats = await messageManager.getInboxStats(MACHINE);
    const inbox = await messageManager.readInbox(MACHINE, 'unread', undefined, WS);

    expect(stats.total).toBe(1);
    expect(stats.unread).toBe(0);
    expect(stats.oldest_unread).toBeNull();
    expect(inbox).toHaveLength(0);
    expect(stats.unread).toBe(inbox.length);
  });

  test('a machine-wide message this workspace has NOT read still counts as unread', async () => {
    // Negative control: without it, `stats.unread = 0` would also pass on a
    // predicate that simply never reports unread.
    await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE, 'Unread notice', 'body', 'MEDIUM'
    );

    const stats = await messageManager.getInboxStats(MACHINE);
    expect(stats.unread).toBe(1);
    expect(stats.oldest_unread).not.toBeNull();
  });

  test('workspace-targeted messages are unaffected', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE + ':' + WS, 'Targeted', 'body', 'LOW'
    );

    await roosyncManage({ action: 'mark_read', message_id: msg.id });
    expect(onDisk(msg.id).status).toBe('read');

    expect(getText(await roosyncManage({ action: 'mark_read', message_id: msg.id })))
      .toContain('déjà marqué comme lu');
  });

  test('#3960: a globally-flipped machine-wide message stays unread for workspaces that never read it', async () => {
    // Incident 30/09 (msg-20260930T0450): a URGENT machine-wide DM was read
    // by one workspace, then its GLOBAL status got flipped to 'read' (a
    // workspace-less reader falls back to the global flip) — and every other
    // workspace of the machine stopped seeing it. perReaderStatus used to
    // honour the global 'read' whenever the reader was not listed, hiding the
    // message from the very session it was addressed to.
    const msg = await messageManager.sendMessage(
      'myia-po-2025:roo-extensions', MACHINE, 'Decision attendue dans la journee', 'body', 'URGENT'
    );

    // Another workspace reads it first -> tracked per workspace, global stays 'unread'.
    await messageManager.markAsRead(msg.id, MACHINE + ':Argumentum');
    expect(onDisk(msg.id).read_by_workspace).toEqual([MACHINE + ':Argumentum']);
    expect(onDisk(msg.id).status).toBe('unread');

    // A workspace-less reader then clears it globally (legacy fallback).
    await messageManager.markAsRead(msg.id, MACHINE);
    expect(onDisk(msg.id).status).toBe('read');
    expect(onDisk(msg.id).read_by_workspace).toEqual([MACHINE + ':Argumentum']);

    // The workspaces that never read it still see it — including in the
    // unread-only inbox view, the exact surface the incident hid it from.
    const unreadHere = await messageManager.readInbox(MACHINE, 'unread', undefined, 'CoursIA');
    expect(unreadHere.map((m: any) => m.id)).toContain(msg.id);
    const allHere = await messageManager.readInbox(MACHINE, 'all', undefined, 'CoursIA');
    const shown = allHere.find((m: any) => m.id === msg.id);
    expect(shown?.status).toBe('unread');

    // The workspace that read it still sees it read.
    const allArg = await messageManager.readInbox(MACHINE, 'all', undefined, 'Argumentum');
    expect(allArg.find((m: any) => m.id === msg.id)?.status).toBe('read');

    // And the session it was destined for can now consume it for real.
    const marked = getText(await roosyncManage({ action: 'mark_read', message_id: msg.id, as: MACHINE + ':CoursIA' }));
    expect(marked).toContain('marqué comme lu');
    expect(onDisk(msg.id).read_by_workspace).toContain(MACHINE + ':CoursIA');
  });

  test('#3960: a legacy machine-wide message (global read, no workspace record) stays read everywhere', async () => {
    // Negative control: messages consumed under the OLD semantics — global
    // 'read' with NO per-workspace record at all — must not resurface as
    // unread for every workspace the day this ships.
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE, 'Legacy notice', 'body', 'LOW'
    );

    // Workspace-less reader only: global flip, no read_by_workspace entry.
    await messageManager.markAsRead(msg.id, MACHINE);
    expect(onDisk(msg.id).status).toBe('read');
    expect(onDisk(msg.id).read_by_workspace).toBeUndefined();

    const unreadHere = await messageManager.readInbox(MACHINE, 'unread', undefined, 'CoursIA');
    expect(unreadHere.map((m: any) => m.id)).not.toContain(msg.id);
    const allHere = await messageManager.readInbox(MACHINE, 'all', undefined, 'CoursIA');
    expect(allHere.find((m: any) => m.id === msg.id)?.status).toBe('read');
  });
});
