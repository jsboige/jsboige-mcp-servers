/**
 * Tests #3177 — roosync_messages inbox identity resolution
 *
 * 1. Unknown schema param (machineId) must fail loudly naming the real param,
 *    never silently render the server's own identity.
 * 2. A workspace given as a full identity "machine:workspace" must resolve the
 *    requested pair, never concatenate identities.
 *
 * @module roosync/messages-identity.test
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { mockReadInbox, mockGetFilteredCount } = vi.hoisted(() => ({
  mockReadInbox: vi.fn(),
  mockGetFilteredCount: vi.fn()
}));

vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'myia-po-2025'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
    getLocalFullId: vi.fn(() => 'myia-po-2025:roo-extensions')
  };
});

vi.mock('../../../services/MessageManager.js', () => {
  const instance = {
    readInbox: (...args: unknown[]) => mockReadInbox(...args),
    getFilteredCount: (...args: unknown[]) => mockGetFilteredCount(...args)
  };
  return {
    MessageManager: class {},
    getMessageManager: () => instance
  };
});

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: () => Promise.reject(new Error('mock: no service in unit test'))
}));

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn()
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  Logger: class {}
}));

import { roosyncMessages } from '../messages.js';
import { roosyncRead } from '../read.js';

const emptyCounts = { total: 0, unread: 0, read: 0 };

describe('#3177 roosync_messages inbox identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadInbox.mockResolvedValue([]);
    mockGetFilteredCount.mockResolvedValue({ ...emptyCounts });
  });

  test('unknown param machineId → VALIDATION_FAILED naming to_machine', async () => {
    await expect(
      roosyncMessages({ action: 'inbox', machineId: 'myia-po-2026' } as never)
    ).rejects.toThrow(/machineId.*to_machine|to_machine/);
    expect(mockReadInbox).not.toHaveBeenCalled();
  });

  test('other unknown param → explicit error listing it', async () => {
    await expect(
      roosyncMessages({ action: 'inbox', destinataire: 'myia-po-2026' } as never)
    ).rejects.toThrow(/destinataire/);
  });

  test('workspace "machine:workspace" resolves the requested pair, no concatenation', async () => {
    const result = await roosyncRead({ mode: 'inbox', workspace: 'myia-po-2023:roo-extensions' });

    expect(mockReadInbox).toHaveBeenCalledWith('myia-po-2023', 'all', undefined, 'roo-extensions', undefined, undefined);
    const text = result.content[0].text as string;
    expect(text).toContain('myia-po-2023');
    expect(text).toContain('roo-extensions');
    // The concatenated identity must never appear (old bug rendered
    // "myia-po-2025:myia-po-2023:roo-extensions" = nonexistent inbox)
    expect(text).not.toContain('myia-po-2025:myia-po-2023');
  });

  test('to_machine conflicting with workspace identity prefix → error surfaced', async () => {
    // roosyncRead catches errors and renders them as content (#492 error contract)
    const result = await roosyncRead({ mode: 'inbox', workspace: 'myia-po-2023:roo-extensions', to_machine: 'myia-web1' });
    expect(result.content[0].text).toContain("Conflit d'identité");
    expect(mockReadInbox).not.toHaveBeenCalled();
  });

  test('to_machine matching the workspace identity prefix → no conflict, pair resolved', async () => {
    await roosyncRead({ mode: 'inbox', workspace: 'myia-po-2023:roo-extensions', to_machine: 'myia-po-2023' });
    expect(mockReadInbox).toHaveBeenCalledWith('myia-po-2023', 'all', undefined, 'roo-extensions', undefined, undefined);
  });

  test('#1498 regression: plain workspace + to_machine overrides stay untouched', async () => {
    const result = await roosyncRead({ mode: 'inbox', workspace: 'nanoclaw', to_machine: 'myia-ai-01' });
    expect(mockReadInbox).toHaveBeenCalledWith('myia-ai-01', 'all', undefined, 'nanoclaw', undefined, undefined);
    expect(result.content[0].text).toContain('myia-ai-01');
  });

  test('plain local workspace stays untouched (no colon-split false positive)', async () => {
    await roosyncRead({ mode: 'inbox' });
    expect(mockReadInbox).toHaveBeenCalledWith('myia-po-2025', 'all', undefined, 'roo-extensions', undefined, undefined);
  });
});
