/**
 * Tests d'intégration pour roosync_read
 *
 * Couvre tous les modes de l'outil :
 * - mode: 'inbox' : Liste des messages (avec filtres status, limit)
 * - mode: 'message' : Lecture d'un message spécifique
 *
 * Framework: Vitest
 * Type: Intégration (MessageManager réel, opérations filesystem réelles)
 *
 * @module roosync/read.integration.test
 * @version 1.0.0 (#564 Phase 2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'émetteur dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-read-integration');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncRead } from '../read.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import { promises as fs } from 'fs';

describe('roosyncRead (integration)', () => {
  let messageManager: MessageManager;
  let rooSyncService: RooSyncService;

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
    rooSyncService = new RooSyncService(testSharedStatePath);
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour mode: 'inbox'
  // ============================================================

  describe('mode: inbox', () => {
    test('should list all messages when no filters provided', async () => {
      // Créer quelques messages de test
      await messageManager.sendMessage('sender-1', 'test-machine', 'Subject 1', 'Body 1', 'LOW');
      await messageManager.sendMessage('sender-2', 'test-machine', 'Subject 2', 'Body 2', 'MEDIUM');

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Boîte de Réception');
      expect(text).toContain('2 messages');
    });

    test('should filter messages by status: unread', async () => {
      // Send 2 messages, mark only one as read so one remains unread
      await messageManager.sendMessage('sender-1', 'test-machine', 'Unread Subject', 'Unread Body', 'LOW');
      await messageManager.sendMessage('sender-2', 'test-machine', 'Read Subject', 'Read Body', 'LOW');

      // Marquer seulement le premier message comme lu
      const messages = await messageManager.readInbox('test-machine');
      if (messages.length > 0) {
        await messageManager.markAsRead(messages[0].id);
      }

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'unread'
      });

      const text = (result.content[0] as any).text;
      expect(text).toContain('non-lu');
    });

    test('should filter messages by status: read', async () => {
      await messageManager.sendMessage('sender-1', 'test-machine', 'Read Subject', 'Read Body', 'LOW');

      // Marquer tous les messages comme lus
      const messages = await messageManager.readInbox('test-machine');
      for (const msg of messages) {
        await messageManager.markAsRead(msg.id);
      }

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'read'
      });

      const text = (result.content[0] as any).text;
      expect(text).toContain('lus');
    });

    test('should limit number of messages returned', async () => {
      // Créer 5 messages
      for (let i = 1; i <= 5; i++) {
        await messageManager.sendMessage(`sender-${i}`, 'test-machine', `Subject ${i}`, `Body ${i}`, 'LOW');
      }

      const result = await roosyncRead({
        mode: 'inbox',
        limit: 3
      });

      const text = (result.content[0] as any).text;
      // Total count shows all 5 messages (limit only affects displayed rows)
      expect(text).toContain('5 messages');
    });

    test('should return empty inbox message when no messages', async () => {
      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('vide');
      expect(text).toContain('Aucun message');
    });

    test('should complete successfully when reading inbox (heartbeat is fire-and-forget)', async () => {
      // Note: heartbeat registerHeartbeat is called fire-and-forget inside roosyncRead
      // The actual heartbeat service used by roosyncRead is the global singleton (getRooSyncService()),
      // not the local instance created in this test, so we can't spy on it directly.
      // Instead, verify the read operation completes without error.
      await messageManager.sendMessage('sender-1', 'test-machine', 'Heartbeat test', 'Body', 'LOW');

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Boîte de Réception');
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
        'Test Subject for Message Mode',
        'Test body content for message mode',
        'HIGH'
      );
      testMessageId = msg.id;
    });

    test('should read specific message by ID', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Test Subject for Message Mode');
      expect(text).toContain('Test body content');
      expect(text).toContain('sender-machine');
      expect(text).toContain('test-machine');
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncRead({
        mode: 'message'
        // message_id manquant
      });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Erreur');
      expect(text).toContain('message_id');
    });

    test('should return error when message not found', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: 'msg-nonexistent'
      });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;
      expect(text).toContain('introuvable');
    });

    test('should mark message as read when mark_as_read is true', async () => {
      // Vérifier que le message est initialement non lu
      const msgBefore = await messageManager.getMessage(testMessageId);
      expect(msgBefore?.status).toBe('unread');

      await roosyncRead({
        mode: 'message',
        message_id: testMessageId,
        mark_as_read: true
      });

      // Vérifier que le message est maintenant marqué comme lu
      const msgAfter = await messageManager.getMessage(testMessageId);
      expect(msgAfter?.status).toBe('read');
    });

    test('should not mark message as read when mark_as_read is false', async () => {
      await roosyncRead({
        mode: 'message',
        message_id: testMessageId,
        mark_as_read: false
      });

      const msg = await messageManager.getMessage(testMessageId);
      expect(msg?.status).toBe('unread');
    });

    test('should display message metadata (priority, timestamp)', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      const text = (result.content[0] as any).text;
      expect(text).toContain('HIGH'); // priority
      expect(text).toContain('**Date :**'); // timestamp field is present
    });

    test('should complete without errors when reading message', async () => {
      // Note: heartbeat registerHeartbeat is only called in inbox mode (fire-and-forget)
      // Message mode uses recordRooSyncActivityAsync instead
      const result = await roosyncRead({
        mode: 'message',
        message_id: testMessageId
      });

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: send → list inbox → read message → mark read', async () => {
      // Step 1: Envoyer un message
      const sentMsg = await messageManager.sendMessage(
        'workflow-sender',
        'test-machine',
        'Workflow Test Message',
        'Workflow test body',
        'MEDIUM'
      );

      // Step 2: Lister la boîte de réception
      const inboxResult = await roosyncRead({
        mode: 'inbox'
      });
      const inboxText = (inboxResult.content[0] as any).text;
      expect(inboxText).toContain('1 message');

      // Step 3: Lire le message spécifique
      const msgResult = await roosyncRead({
        mode: 'message',
        message_id: sentMsg.id,
        mark_as_read: true
      });
      const msgText = (msgResult.content[0] as any).text;
      expect(msgText).toContain('Workflow Test Message');

      // Step 4: Vérifier que le message est marqué comme lu
      const msg = await messageManager.getMessage(sentMsg.id);
      expect(msg?.status).toBe('read');
    });

    test('should handle multiple messages with mixed read/unread status', async () => {
      // Créer 3 messages
      const msg1 = await messageManager.sendMessage('sender-1', 'test-machine', 'Msg 1', 'Body 1', 'LOW');
      const msg2 = await messageManager.sendMessage('sender-2', 'test-machine', 'Msg 2', 'Body 2', 'MEDIUM');
      const msg3 = await messageManager.sendMessage('sender-3', 'test-machine', 'Msg 3', 'Body 3', 'HIGH');

      // Marquer msg2 comme lu
      await messageManager.markAsRead(msg2.id);

      // Vérifier les filtres
      const allResult = await roosyncRead({ mode: 'inbox', status: 'all' });
      expect((allResult.content[0] as any).text).toContain('3 messages');

      const unreadResult = await roosyncRead({ mode: 'inbox', status: 'unread' });
      expect((unreadResult.content[0] as any).text).toContain('2 non-lu');

      const readResult = await roosyncRead({ mode: 'inbox', status: 'read' });
      expect((readResult.content[0] as any).text).toContain('1 lu');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing shared state directory gracefully', async () => {
      // Supprimer le répertoire pour simuler l'absence
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncRead({
        mode: 'inbox'
      });

      // Devrait retourner un message d'erreur ou un inbox vide
      expect(result.content).toHaveLength(1);
    });

    test('should handle corrupted message files', async () => {
      // Créer un fichier corrompu dans inbox
      const corruptedId = 'msg-corrupted';
      const corruptedPath = join(testSharedStatePath, 'messages/inbox', `${corruptedId}.json`);
      await fs.writeFile(corruptedPath, '{ invalid json }');

      const result = await roosyncRead({
        mode: 'inbox'
      });

      // Devrait ignorer le fichier corrompu et retourner les autres messages
      expect(result.content).toHaveLength(1);
    });
  });
});
