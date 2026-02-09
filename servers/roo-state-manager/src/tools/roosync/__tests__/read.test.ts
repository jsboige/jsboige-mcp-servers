/**
 * Tests unitaires pour roosync_read
 *
 * Couvre tous les modes de l'outil consolidé :
 * - mode: 'inbox' : Lire la boîte de réception
 * - mode: 'message' : Obtenir les détails d'un message
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/read.test
 * @version 1.0.0 (CONS-1)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId and getLocalWorkspaceId pour contrôler l'émetteur dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-read');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncRead } from '../read.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncRead', () => {
  let messageManager: MessageManager;

  beforeEach(async () => {
    // Setup : créer répertoire temporaire pour tests isolés
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
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour mode manquant / invalide
  // ============================================================

  describe('mode validation', () => {
    test('should return error when mode is missing', async () => {
      const result = await roosyncRead({} as any);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Erreur');
      expect(result.content[0].text).toContain('mode');
    });

    test('should return error when mode is invalid', async () => {
      const result = await roosyncRead({ mode: 'invalid' as any });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Erreur');
      expect(result.content[0].text).toContain('invalid');
    });
  });

  // ============================================================
  // Tests pour mode: 'inbox'
  // ============================================================

  describe('mode: inbox', () => {
    test('should return empty inbox message when no messages', async () => {
      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Aucun message');
    });

    test('should list messages in inbox', async () => {
      // Créer des messages pour test
      await messageManager.sendMessage(
        'sender-1',
        'test-machine',
        'Subject 1',
        'Body 1',
        'MEDIUM'
      );
      await messageManager.sendMessage(
        'sender-2',
        'test-machine',
        'Subject 2',
        'Body 2',
        'HIGH'
      );

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content[0].text).toContain('Boîte de Réception');
      expect(result.content[0].text).toContain('test-machine');
      expect(result.content[0].text).toContain('2 message');
    });

    test('should filter by status unread', async () => {
      // Créer un message et le marquer comme lu
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Read Message',
        'Body',
        'LOW'
      );
      await messageManager.markAsRead(msg.id);

      // Créer un message non lu
      await messageManager.sendMessage(
        'sender-2',
        'test-machine',
        'Unread Message',
        'Body 2',
        'MEDIUM'
      );

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'unread'
      });

      expect(result.content[0].text).toContain('Boîte de Réception');
      // Should show the unread message
      expect(result.content[0].text).toContain('sender-2');
    });

    test('should respect limit parameter', async () => {
      // Créer 3 messages
      await messageManager.sendMessage('s1', 'test-machine', 'Msg1', 'B1', 'LOW');
      await messageManager.sendMessage('s2', 'test-machine', 'Msg2', 'B2', 'MEDIUM');
      await messageManager.sendMessage('s3', 'test-machine', 'Msg3', 'B3', 'HIGH');

      const result = await roosyncRead({
        mode: 'inbox',
        limit: 2
      });

      expect(result.content[0].text).toContain('Boîte de Réception');
      // When status='all' (default) and limit=2, both displayed list and count are limited
      expect(result.content[0].text).toContain('2 message');
    });

    test('should show preview of most recent message', async () => {
      await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Latest Subject',
        'This is the body of the latest message',
        'HIGH'
      );

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content[0].text).toContain('Aperçu du message le plus récent');
      expect(result.content[0].text).toContain('Latest Subject');
    });

    test('should show actions available', async () => {
      await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Test',
        'Body',
        'MEDIUM'
      );

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content[0].text).toContain('Actions disponibles');
      expect(result.content[0].text).toContain('roosync_read');
    });
  });

  // ============================================================
  // Tests pour mode: 'message'
  // ============================================================

  describe('mode: message', () => {
    let testMessageId: string;

    beforeEach(async () => {
      // Créer un message pour les tests
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body content with **markdown**',
        'HIGH',
        ['tag1', 'tag2'],
        'thread-123'
      );
      testMessageId = msg.id;
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncRead({
        mode: 'message'
      });

      expect(result.content[0].text).toContain('Erreur');
      expect(result.content[0].text).toContain('message_id');
    });

    test('should return error when message not found', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: 'msg-nonexistent'
      });

      expect(result.content[0].text).toContain('introuvable');
    });

    test('should display full message details', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result.content[0].text).toContain('Test Subject');
      expect(result.content[0].text).toContain('sender-machine');
      expect(result.content[0].text).toContain('test-machine');
      expect(result.content[0].text).toContain('HIGH');
      expect(result.content[0].text).toContain('Test body content');
    });

    test('should display tags', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result.content[0].text).toContain('tag1');
      expect(result.content[0].text).toContain('tag2');
    });

    test('should display thread_id', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result.content[0].text).toContain('thread-123');
    });

    test('should mark message as read when mark_as_read is true', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId,
        mark_as_read: true
      });

      expect(result.content[0].text).toContain('READ');

      // Verify the message is actually marked as read
      const msg = await messageManager.getMessage(testMessageId);
      expect(msg?.status).toBe('read');
    });

    test('should not mark message as read by default', async () => {
      await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      // Verify the message is still unread
      const msg = await messageManager.getMessage(testMessageId);
      expect(msg?.status).toBe('unread');
    });

    test('should show available actions', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result.content[0].text).toContain('Actions disponibles');
      expect(result.content[0].text).toContain('roosync_manage');
      expect(result.content[0].text).toContain('roosync_send');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration', () => {
    test('should handle inbox then message detail workflow', async () => {
      // Créer un message
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Workflow Test',
        'Workflow body',
        'MEDIUM'
      );

      // Step 1: List inbox
      const inboxResult = await roosyncRead({ mode: 'inbox' });
      expect(inboxResult.content[0].text).toContain('Boîte de Réception');
      expect(inboxResult.content[0].text).toContain('Workflow Test');

      // Step 2: Read message detail
      const detailResult = await roosyncRead({
        mode: 'message',
        message_id: msg.id,
        mark_as_read: true
      });
      expect(detailResult.content[0].text).toContain('Workflow body');
      expect(detailResult.content[0].text).toContain('READ');
    });

    test('should handle multiple messages with different statuses', async () => {
      // Create 2 messages
      const msg1 = await messageManager.sendMessage('s1', 'test-machine', 'Msg1', 'B1', 'LOW');
      const msg2 = await messageManager.sendMessage('s2', 'test-machine', 'Msg2', 'B2', 'HIGH');

      // Read msg1 to mark it as read
      await roosyncRead({
        mode: 'message',
        message_id: msg1.id,
        mark_as_read: true
      });

      // List all messages
      const allResult = await roosyncRead({ mode: 'inbox', status: 'all' });
      expect(allResult.content[0].text).toContain('2 message');

      // List only unread
      const unreadResult = await roosyncRead({ mode: 'inbox', status: 'unread' });
      expect(unreadResult.content[0].text).toContain('non-lu');
    });
  });
});
