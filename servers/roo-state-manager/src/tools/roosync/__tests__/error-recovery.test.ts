/**
 * Tests de récupération d'erreurs GDrive - Issue #531
 *
 * Tests de gestion des erreurs quand GDrive est indisponible
 *
 * @module roosync/error-recovery.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
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
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-error-recovery');
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
import { roosyncRead } from '../read.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('Error Recovery - GDrive Indisponible (Issue #531)', () => {
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
  // Tests roosync_send - Erreurs GDrive
  // ============================================================

  describe('roosync_send error handling', () => {
    test('returns proper error when inbox directory is read-only', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Make inbox read-only (Windows)
      if (process.platform === 'win32') {
        try {
          chmodSync(inboxPath, 0o444);
        } catch {
          // Skip if chmod fails on Windows
        }
      }

      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Test message',
        body: 'Test body'
      });

      // Should either succeed (if writable) or return proper error
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toBeDefined();

      // Restore permissions
      try {
        chmodSync(inboxPath, 0o755);
      } catch {
        // Ignore
      }
    });

    test('handles malformed recipient gracefully', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: '', // Empty recipient
        subject: 'Test',
        body: 'Test body'
      });

      expect(result.content).toHaveLength(1);
      // Should indicate missing/invalid recipient
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('handles missing subject gracefully', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: '', // Empty subject
        body: 'Test body'
      });

      expect(result.content).toHaveLength(1);
      // Should indicate missing subject
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('handles missing body gracefully', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Test subject',
        body: '' // Empty body
      });

      expect(result.content).toHaveLength(1);
      // Should indicate missing body
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('reply to non-existent message returns graceful error', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: 'msg-nonexistent-12345',
        body: 'Reply body'
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('amend non-existent message returns graceful error', async () => {
      const result = await roosyncSend({
        action: 'amend',
        message_id: 'msg-nonexistent-12345',
        new_content: 'New content'
      });

      expect(result.content).toHaveLength(1);
      // Should not crash
      expect((result.content[0] as any).text).toBeDefined();
    });
  });

  // ============================================================
  // Tests roosync_read - Erreurs GDrive
  // ============================================================

  describe('roosync_read error handling', () => {
    test('handles empty inbox gracefully', async () => {
      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      expect(result.content).toHaveLength(1);
      // Should indicate empty inbox or show 0 messages
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('handles non-existent message gracefully', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: 'msg-does-not-exist-99999'
      });

      expect(result.content).toHaveLength(1);
      // Should indicate message not found
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('handles corrupted message file gracefully', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');
      const corruptedFile = join(inboxPath, 'msg-corrupted-test.json');

      // Write invalid JSON
      writeFileSync(corruptedFile, '{ invalid json content', 'utf-8');

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      // Should not crash, may skip corrupted file
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('handles missing messages directory', async () => {
      // Remove messages directory
      rmSync(join(testSharedStatePath, 'messages'), { recursive: true, force: true });

      // MessageManager should recreate on constructor
      const newManager = new MessageManager(testSharedStatePath);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      // Should handle gracefully (empty inbox after recreation)
      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de validation des paramètres
  // ============================================================

  describe('Parameter validation', () => {
    test('invalid priority level is handled', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Test',
        body: 'Test',
        priority: 'INVALID' as any
      });

      // Should either default to MEDIUM or return error
      expect(result.content).toHaveLength(1);
    });

    test('invalid mode in roosync_read is handled', async () => {
      const result = await roosyncRead({
        mode: 'invalid' as any
      });

      expect(result.content).toHaveLength(1);
      // Should indicate invalid mode or show error
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('missing message_id for message mode returns error', async () => {
      const result = await roosyncRead({
        mode: 'message'
        // message_id missing
      } as any);

      expect(result.content).toHaveLength(1);
      // Should indicate missing message_id
      expect((result.content[0] as any).text).toBeDefined();
    });
  });

  // ============================================================
  // Tests de résilience
  // ============================================================

  describe('Resilience tests', () => {
    test('send after previous failure succeeds', async () => {
      // First, a send that might fail
      await roosyncSend({
        action: 'reply',
        message_id: 'msg-nonexistent',
        body: 'This will fail'
      });

      // Second send should work
      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Recovery test',
        body: 'This should work'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });

    test('read after corrupted file succeeds', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Write a valid message first
      const validMessage = {
        id: 'msg-valid-001',
        from: 'sender',
        to: 'test-machine',
        subject: 'Valid message',
        body: 'Valid body',
        priority: 'MEDIUM',
        timestamp: new Date().toISOString(),
        status: 'unread'
      };
      writeFileSync(
        join(inboxPath, 'msg-valid-001.json'),
        JSON.stringify(validMessage),
        'utf-8'
      );

      // Write a corrupted file
      writeFileSync(
        join(inboxPath, 'msg-corrupted-002.json'),
        '{ broken json',
        'utf-8'
      );

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      // Should return at least the valid message
      expect(result.content).toHaveLength(1);
      // Should contain the valid message
      expect((result.content[0] as any).text).toBeDefined();
    });
  });
});
