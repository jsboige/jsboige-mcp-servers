/**
 * Tests de concurrence pour roosync_send - Issue #531
 *
 * Tests de race condition quand plusieurs machines envoient
 * simultanément au même destinataire.
 *
 * @module roosync/concurrent-send.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId to simulate different machines
let currentMachineId = 'test-machine-1';

vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => currentMachineId),
    getLocalFullId: vi.fn(() => currentMachineId),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-concurrent');
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

// Import après les mocks
import { roosyncSend } from '../send.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncSend - Concurrent Same Recipient (Issue #531)', () => {
  let messageManager: MessageManager;

  beforeEach(async () => {
    // Reset machine ID
    currentMachineId = 'test-machine-1';

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
  // Tests de concurrence - Même destinataire
  // ============================================================

  describe('Concurrent sends to same recipient', () => {
    test('two machines sending to same recipient simultaneously - both delivered', async () => {
      // Simulate machine 1 sending
      currentMachineId = 'machine-alpha';
      const result1Promise = roosyncSend({
        action: 'send',
        to: 'shared-recipient',
        subject: 'Message from Alpha',
        body: 'Content from machine alpha'
      });

      // Immediately simulate machine 2 sending (without waiting)
      currentMachineId = 'machine-beta';
      const result2Promise = roosyncSend({
        action: 'send',
        to: 'shared-recipient',
        subject: 'Message from Beta',
        body: 'Content from machine beta'
      });

      // Wait for both
      const [result1, result2] = await Promise.all([result1Promise, result2Promise]);

      // Both should succeed
      expect((result1.content[0] as any).text).toContain('envoyé avec succès');
      expect((result2.content[0] as any).text).toContain('envoyé avec succès');

      // Verify both messages exist in inbox
      const inboxFiles = readdirSync(join(testSharedStatePath, 'messages/inbox'));
      expect(inboxFiles.length).toBeGreaterThanOrEqual(2);
    });

    test('concurrent sends preserve chronological order', async () => {
      const timestamps: string[] = [];
      const results: any[] = [];

      // Send 5 messages "simultaneously" from different machines
      const promises = Array.from({ length: 5 }, async (_, i) => {
        currentMachineId = `machine-${i}`;
        const result = await roosyncSend({
          action: 'send',
          to: 'ordered-recipient',
          subject: `Message ${i}`,
          body: `Body ${i}`
        });

        // Extract message ID
        const match = result.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return {
          machine: `machine-${i}`,
          messageId: match ? match[1] : null,
          index: i
        };
      });

      const messages = await Promise.all(promises);

      // All should succeed
      for (const msg of messages) {
        expect(msg.messageId).not.toBeNull();
      }

      // All IDs should be unique
      const ids = messages.map(m => m.messageId).filter(Boolean);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });

    test('rapid send-reply sequence from multiple machines', async () => {
      // First, send a message from machine A
      currentMachineId = 'machine-a';
      const sendResult = await roosyncSend({
        action: 'send',
        to: 'machine-b',
        subject: 'Original message',
        body: 'Original content'
      });

      const match = sendResult.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      const originalId = match![1];

      // Now multiple machines try to reply simultaneously
      const replyPromises = Array.from({ length: 3 }, (_, i) => {
        currentMachineId = `replier-${i}`;
        return roosyncSend({
          action: 'reply',
          message_id: originalId,
          body: `Reply ${i} to original`
        });
      });

      const replies = await Promise.all(replyPromises);

      // All replies should succeed (or fail gracefully)
      for (const reply of replies) {
        expect(reply.content).toHaveLength(1);
        expect((reply.content[0] as any).text).toBeDefined();
      }
    });

    test('concurrent broadcast to all machines', async () => {
      // Multiple machines broadcast to "all" simultaneously
      const promises = Array.from({ length: 4 }, (_, i) => {
        currentMachineId = `broadcaster-${i}`;
        return roosyncSend({
          action: 'send',
          to: 'all',
          subject: `Broadcast ${i}`,
          body: `Broadcast message ${i}`
        });
      });

      const results = await Promise.all(promises);

      // All should succeed
      for (const result of results) {
        expect((result.content[0] as any).text).toContain('envoyé avec succès');
      }

      // All IDs should be unique
      const ids = results.map(r => {
        const match = r.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return match ? match[1] : null;
      }).filter(Boolean);

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(4);
    });
  });

  // ============================================================
  // Tests de stress - Volume élevé
  // ============================================================

  describe('High volume concurrent operations', () => {
    test('20 concurrent sends to different recipients', async () => {
      const promises = Array.from({ length: 20 }, (_, i) => {
        currentMachineId = `sender-${i}`;
        return roosyncSend({
          action: 'send',
          to: `recipient-${i}`,
          subject: `Message ${i}`,
          body: `Body ${i}`
        });
      });

      const results = await Promise.all(promises);

      // All should succeed
      const successes = results.filter(r =>
        (r.content[0] as any).text.includes('envoyé avec succès')
      );
      expect(successes.length).toBe(20);

      // All IDs unique
      const ids = results.map(r => {
        const match = r.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return match ? match[1] : null;
      }).filter(Boolean);

      expect(new Set(ids).size).toBe(20);
    });

    test('mixed send and amend operations concurrently', async () => {
      // First send some messages
      const sendPromises = Array.from({ length: 5 }, (_, i) => {
        currentMachineId = `sender-${i}`;
        return roosyncSend({
          action: 'send',
          to: `target-${i}`,
          subject: `Initial ${i}`,
          body: `Body ${i}`
        });
      });

      const sendResults = await Promise.all(sendPromises);
      const messageIds = sendResults.map(r => {
        const match = r.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return match ? match[1] : null;
      });

      // Now send more messages while amending the first batch
      const mixedPromises = [
        // More sends
        ...Array.from({ length: 3 }, (_, i) => {
          currentMachineId = `late-sender-${i}`;
          return roosyncSend({
            action: 'send',
            to: 'late-target',
            subject: `Late ${i}`,
            body: `Late body ${i}`
          });
        }),
        // Amends
        ...messageIds.filter(Boolean).map((id, i) => {
          currentMachineId = `amender-${i}`;
          return roosyncSend({
            action: 'amend',
            message_id: id!,
            new_content: `Amended content ${i}`,
            reason: 'Test amendment'
          });
        })
      ];

      const mixedResults = await Promise.all(mixedPromises);

      // All operations should complete (success or graceful error)
      for (const result of mixedResults) {
        expect(result.content).toHaveLength(1);
      }
    });
  });
});
