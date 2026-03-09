/**
 * Tests for roosync_manage bulk operations and cleanup
 *
 * Covers new actions:
 * - action: 'bulk_mark_read' : Mark multiple messages as read with filters
 * - action: 'bulk_archive' : Archive multiple messages with filters
 * - action: 'cleanup' : Auto-cleanup (test messages, old LOW, old read)
 * - action: 'stats' : Inbox statistics
 *
 * Framework: Vitest
 * Type: Integration (MessageManager réel, filesystem réel)
 *
 * @module roosync/manage-bulk.test
 * @version 1.0.0 (#613 ISS-1)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId for test control
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath for isolated test data
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-manage-bulk');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import after mocks
import { roosyncManage } from '../manage.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncManage - bulk operations (#613)', () => {
  let messageManager: MessageManager;

  beforeEach(async () => {
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'messages'),
      join(testSharedStatePath, 'messages/inbox'),
      join(testSharedStatePath, 'messages/sent'),
      join(testSharedStatePath, 'messages/archive')
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    messageManager = new MessageManager(testSharedStatePath);
  });

  afterEach(async () => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  function getText(result: { content: Array<{ type: string; text: string }> }): string {
    return result.content[0].text;
  }

  // Helper to create test messages
  async function createMessages(count: number, overrides: Partial<{
    from: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    subject: string;
    tags: string[];
    timestamp: string;
  }> = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const msg = await messageManager.sendMessage(
        overrides.from || 'sender-machine',
        'test-machine',
        overrides.subject || `Test message ${i}`,
        `Body of test message ${i}`,
        overrides.priority || 'MEDIUM',
        overrides.tags
      );
      // Override timestamp if provided
      if (overrides.timestamp) {
        const inboxFile = join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`);
        const sentFile = join(testSharedStatePath, 'messages/sent', `${msg.id}.json`);
        const updatedMsg = { ...msg, timestamp: overrides.timestamp };
        writeFileSync(inboxFile, JSON.stringify(updatedMsg, null, 2), 'utf-8');
        writeFileSync(sentFile, JSON.stringify(updatedMsg, null, 2), 'utf-8');
      }
      ids.push(msg.id);
    }
    return ids;
  }

  // ============================================================
  // Tests for action: 'bulk_mark_read'
  // ============================================================

  describe('action: bulk_mark_read', () => {
    test('should mark all unread messages as read when no filters', async () => {
      await createMessages(3);

      const result = await roosyncManage({ action: 'bulk_mark_read' });
      const text = getText(result);

      expect(text).toContain('bulk terminée');
      expect(text).toContain('Messages traités :** 3');
    });

    test('should filter by sender', async () => {
      await createMessages(2, { from: 'machine-a' });
      await createMessages(3, { from: 'machine-b' });

      const result = await roosyncManage({ action: 'bulk_mark_read', from: 'machine-a' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 2');
    });

    test('should filter by priority', async () => {
      await createMessages(2, { priority: 'LOW' });
      await createMessages(1, { priority: 'URGENT' });

      const result = await roosyncManage({ action: 'bulk_mark_read', priority: 'LOW' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 2');
    });

    test('should filter by subject_contains', async () => {
      await createMessages(1, { subject: 'Test performance envoi' });
      await createMessages(1, { subject: 'Important directive' });

      const result = await roosyncManage({ action: 'bulk_mark_read', subject_contains: 'performance' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 1');
    });

    test('should filter by before_date', async () => {
      const oldDate = '2026-01-01T00:00:00.000Z';
      await createMessages(2, { timestamp: oldDate });
      await createMessages(1); // current date

      const result = await roosyncManage({ action: 'bulk_mark_read', before_date: '2026-02-01' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 2');
    });

    test('should combine multiple filters (AND logic)', async () => {
      await createMessages(2, { from: 'machine-a', priority: 'LOW' });
      await createMessages(1, { from: 'machine-a', priority: 'HIGH' });
      await createMessages(1, { from: 'machine-b', priority: 'LOW' });

      const result = await roosyncManage({ action: 'bulk_mark_read', from: 'machine-a', priority: 'LOW' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 2');
    });

    test('should return 0 when no messages match', async () => {
      await createMessages(2, { from: 'machine-a' });

      const result = await roosyncManage({ action: 'bulk_mark_read', from: 'nonexistent' });
      const text = getText(result);

      expect(text).toContain('Messages trouvés :** 0');
      expect(text).toContain('Aucun message ne correspond');
    });
  });

  // ============================================================
  // Tests for action: 'bulk_archive'
  // ============================================================

  describe('action: bulk_archive', () => {
    test('should archive messages matching filters', async () => {
      const oldDate = '2026-01-15T00:00:00.000Z';
      await createMessages(3, { timestamp: oldDate });

      const result = await roosyncManage({ action: 'bulk_archive', before_date: '2026-02-01' });
      const text = getText(result);

      expect(text).toContain('bulk terminée');
      expect(text).toContain('Messages traités :** 3');
    });

    test('should archive by sender filter', async () => {
      await createMessages(2, { from: 'test-sender' });
      await createMessages(1, { from: 'important-sender' });

      const result = await roosyncManage({ action: 'bulk_archive', from: 'test-sender' });
      const text = getText(result);

      expect(text).toContain('Messages traités :** 2');
    });
  });

  // ============================================================
  // Tests for action: 'cleanup'
  // ============================================================

  describe('action: cleanup', () => {
    test('should mark test messages as read', async () => {
      await createMessages(3, { from: 'test-sender' });
      await createMessages(1, { from: 'real-machine' });

      const result = await roosyncManage({ action: 'cleanup' });
      const text = getText(result);

      expect(text).toContain('Cleanup terminé');
      expect(text).toContain('État de la boîte après cleanup');
    });

    test('should auto-mark old LOW messages as read', async () => {
      const eightDaysAgo = new Date();
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
      await createMessages(2, { priority: 'LOW', timestamp: eightDaysAgo.toISOString() });
      await createMessages(1, { priority: 'HIGH' }); // should not be affected

      const result = await roosyncManage({ action: 'cleanup' });
      const text = getText(result);

      expect(text).toContain('Cleanup terminé');
      // The LOW messages >7d should be marked as read
      expect(text).toContain('LOW >7j marqués lus : **2**');
    });

    test('should show stats after cleanup', async () => {
      await createMessages(1);

      const result = await roosyncManage({ action: 'cleanup' });
      const text = getText(result);

      expect(text).toContain('Total inbox');
      expect(text).toContain('Non-lus');
      expect(text).toContain('Par priorité');
      expect(text).toContain('Par expéditeur');
    });
  });

  // ============================================================
  // Tests for action: 'stats'
  // ============================================================

  describe('action: stats', () => {
    test('should return inbox statistics', async () => {
      await createMessages(2, { priority: 'HIGH', from: 'machine-a' });
      await createMessages(1, { priority: 'LOW', from: 'machine-b' });

      const result = await roosyncManage({ action: 'stats' });
      const text = getText(result);

      expect(text).toContain('Statistiques inbox');
      expect(text).toContain('Total');
      expect(text).toContain('3');
      expect(text).toContain('Non-lus');
      expect(text).toContain('Par priorité');
      expect(text).toContain('HIGH');
      expect(text).toContain('LOW');
    });

    test('should show empty stats when no messages', async () => {
      const result = await roosyncManage({ action: 'stats' });
      const text = getText(result);

      expect(text).toContain('Statistiques inbox');
      expect(text).toContain('| **Total** | 0 |');
    });
  });

  // ============================================================
  // Tests for MessageManager bulk methods directly
  // ============================================================

  describe('MessageManager.bulkOperation', () => {
    test('should return correct counts', async () => {
      await createMessages(5, { from: 'bulk-sender' });

      const result = await messageManager.bulkOperation(
        'test-machine', 'mark_read',
        { from: 'bulk-sender', status: 'unread' }
      );

      expect(result.matched).toBe(5);
      expect(result.processed).toBe(5);
      expect(result.errors).toBe(0);
      expect(result.message_ids).toHaveLength(5);
    });

    test('should handle tag filter', async () => {
      const msg = await messageManager.sendMessage(
        'sender-machine', 'test-machine',
        'Tagged message', 'Body', 'MEDIUM',
        ['important', 'review']
      );
      await messageManager.sendMessage(
        'sender-machine', 'test-machine',
        'Untagged message', 'Body', 'MEDIUM'
      );

      const result = await messageManager.bulkOperation(
        'test-machine', 'mark_read',
        { tag: 'important', status: 'unread' }
      );

      expect(result.matched).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.message_ids[0]).toBe(msg.id);
    });
  });

  describe('MessageManager.getInboxStats', () => {
    test('should return correct statistics', async () => {
      await createMessages(2, { from: 'machine-a', priority: 'HIGH' });
      await createMessages(1, { from: 'machine-b', priority: 'LOW' });

      const stats = await messageManager.getInboxStats('test-machine');

      expect(stats.total).toBe(3);
      expect(stats.unread).toBe(3);
      expect(stats.read).toBe(0);
      expect(stats.by_priority['HIGH']).toBe(2);
      expect(stats.by_priority['LOW']).toBe(1);
      expect(stats.by_sender['machine-a']).toBe(2);
      expect(stats.by_sender['machine-b']).toBe(1);
      expect(stats.oldest_unread).toBeTruthy();
    });

    test('should track oldest unread correctly', async () => {
      const oldDate = '2026-01-01T00:00:00.000Z';
      await createMessages(1, { timestamp: oldDate });
      await createMessages(1); // current

      const stats = await messageManager.getInboxStats('test-machine');

      expect(stats.oldest_unread).toBe(oldDate);
    });
  });
});
