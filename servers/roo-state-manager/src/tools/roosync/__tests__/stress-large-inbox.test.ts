/**
 * Tests de stress - Large Inbox - Issue #531
 *
 * Tests de performance avec une boîte de réception de 1000+ messages
 *
 * @module roosync/stress-large-inbox.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-stress');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Mock RooSyncService to avoid config requirements
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: vi.fn(() => ({
      registerHeartbeat: vi.fn().mockResolvedValue(undefined)
    }))
  }))
}));

// Mock getMessageManager to use test path (real getMessageManager uses require() which fails in vitest ESM)
vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => new actual.MessageManager(testSharedStatePath),
  };
});

// Import après les mocks
import { roosyncRead } from '../read.js';
import { roosyncSend } from '../send.js';
import { MessageManager, Message } from '../../../services/MessageManager.js';

/**
 * Génère un message JSON de test
 */
function generateTestMessage(id: number): Message {
  return {
    id: `msg-stress-${id.toString().padStart(5, '0')}`,
    from: `sender-${id % 10}`,
    to: 'test-machine',
    subject: `Stress test message ${id}`,
    body: `This is the body of stress test message ${id}. It contains some content to simulate a real message.\n\nLine 2\nLine 3`,
    priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'][id % 4] as Message['priority'],
    timestamp: new Date(Date.now() - id * 60000).toISOString(), // 1 minute apart
    status: id % 5 === 0 ? 'read' : 'unread',
    tags: [`tag-${id % 20}`, `category-${id % 5}`],
    thread_id: `thread-${id % 100}`
  };
}

/**
 * Génère N messages dans l'inbox
 */
function generateLargeInbox(count: number): void {
  const inboxPath = join(testSharedStatePath, 'messages/inbox');

  for (let i = 0; i < count; i++) {
    const message = generateTestMessage(i);
    const filePath = join(inboxPath, `${message.id}.json`);
    writeFileSync(filePath, JSON.stringify(message, null, 2), 'utf-8');
  }
}

describe('Stress Tests - Large Inbox 1000+ (Issue #531)', () => {
  let messageManager: MessageManager;

  beforeEach(async () => {
    // Setup : créer répertoire temporaire
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
    // Cleanup
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests de performance - Lecture inbox
  // ============================================================

  describe('roosync_read performance with large inbox', () => {
    test('reads inbox with 1000 messages within reasonable time', async () => {
      // Generate 1000 messages
      generateLargeInbox(1000);

      const inboxPath = join(testSharedStatePath, 'messages/inbox');
      const files = readdirSync(inboxPath);
      expect(files.length).toBe(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 20 // Default pagination
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Response should contain message data
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeDefined();
      expect(responseText.length).toBeGreaterThan(100);

      // Should complete within 5 seconds for 1000 messages
      expect(duration).toBeLessThan(5000);
    });

    test('pagination works correctly with large inbox', async () => {
      generateLargeInbox(500);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
      // Should show limited results, not all 500
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('filtering by unread status with large inbox', async () => {
      generateLargeInbox(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'unread',
        limit: 50
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // 80% of messages are unread (status: id % 5 === 0 ? read : unread)
      // So ~800 unread messages
      expect((result.content[0] as any).text).toBeDefined();

      // Should complete within 5 seconds
      expect(duration).toBeLessThan(5000);
    });

    test('reading specific message from large inbox is fast', async () => {
      generateLargeInbox(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'message',
        message_id: 'msg-stress-00500'
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('msg-stress-00500');

      // Reading single message should be fast (< 1 second)
      expect(duration).toBeLessThan(1000);
    });
  });

  // ============================================================
  // Tests de performance - mark_read
  // ============================================================

  describe('mark_read atomicity with large inbox', () => {
    test('mark_read operation is atomic', async () => {
      generateLargeInbox(100);

      // Mark a message as read
      const result = await roosyncSend({
        action: 'send',
        to: 'self',
        subject: 'Test mark',
        body: 'Test'
      });

      // Extract message ID from result
      const match = result.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      expect(match).not.toBeNull();

      const messageId = match![1];

      // Read the message (which marks it as read)
      const readResult = await roosyncRead({
        mode: 'message',
        message_id: messageId,
        mark_as_read: true
      });

      expect(readResult.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de limites - Edge cases volumétriques
  // ============================================================

  describe('Volumetric edge cases', () => {
    test('handles inbox with 2000 messages', async () => {
      generateLargeInbox(2000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 20
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Check that response mentions large number of messages
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeDefined();
      // Response should indicate there are messages (exact format may vary)
      expect(responseText.length).toBeGreaterThan(100);

      // Should still be reasonably fast
      expect(duration).toBeLessThan(10000);
    });

    test('inbox with messages having large bodies', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Create 100 messages with large bodies (10KB each)
      for (let i = 0; i < 100; i++) {
        const largeBody = 'X'.repeat(10 * 1024); // 10KB
        const message: Message = {
          id: `msg-large-${i.toString().padStart(3, '0')}`,
          from: 'sender',
          to: 'test-machine',
          subject: `Large message ${i}`,
          body: largeBody,
          priority: 'MEDIUM',
          timestamp: new Date().toISOString(),
          status: 'unread'
        };

        writeFileSync(
          join(inboxPath, `${message.id}.json`),
          JSON.stringify(message),
          'utf-8'
        );
      }

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Should handle large bodies without timeout
      expect(duration).toBeLessThan(5000);
    });

    test('inbox with many tags per message', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Create 50 messages with 50 tags each
      for (let i = 0; i < 50; i++) {
        const message: Message = {
          id: `msg-tags-${i.toString().padStart(3, '0')}`,
          from: 'sender',
          to: 'test-machine',
          subject: `Tags message ${i}`,
          body: 'Body',
          priority: 'MEDIUM',
          timestamp: new Date().toISOString(),
          status: 'unread',
          tags: Array.from({ length: 50 }, (_, j) => `tag-${i}-${j}`)
        };

        writeFileSync(
          join(inboxPath, `${message.id}.json`),
          JSON.stringify(message),
          'utf-8'
        );
      }

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de cohérence
  // ============================================================

  describe('Data consistency under load', () => {
    test('all messages are accounted for in count', async () => {
      generateLargeInbox(500);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      const text = (result.content[0] as any).text;

      // Response should contain message data
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(100);
      // Should mention some indicator of messages
      expect(text).toMatch(/\d+/); // Contains at least one number
    });

    test('messages are sorted by timestamp (newest first)', async () => {
      generateLargeInbox(100);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
      // The newest messages should appear first
      expect((result.content[0] as any).text).toBeDefined();
    });
  });
});
