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
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'myia-ai-01'),
    getLocalFullId: vi.fn(() => 'myia-ai-01:roo-extensions'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
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

  test('workspace-targeted messages are unaffected', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', MACHINE + ':' + WS, 'Targeted', 'body', 'LOW'
    );

    await roosyncManage({ action: 'mark_read', message_id: msg.id });
    expect(onDisk(msg.id).status).toBe('read');

    expect(getText(await roosyncManage({ action: 'mark_read', message_id: msg.id })))
      .toContain('déjà marqué comme lu');
  });
});
