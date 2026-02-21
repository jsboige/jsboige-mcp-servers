/**
 * Tests unitaires pour roosync_manage
 *
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'mark_read' : Marquer un message comme lu
 * - action: 'archive' : Archiver un message
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/manage.test
 * @version 1.0.0 (CONS-1)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'émetteur dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-manage');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncManage } from '../manage.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncManage', () => {
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
  // Tests pour action manquante / invalide
  // ============================================================

  describe('action validation', () => {
    test('should return error when action is missing', async () => {
      const result = await roosyncManage({ message_id: 'test-id' } as any);

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('action');
    });

    test('should return error when action is invalid', async () => {
      const result = await roosyncManage({ action: 'invalid' as any, message_id: 'test-id' });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('invalid');
    });
  });

  // ============================================================
  // Tests pour action: 'mark_read'
  // ============================================================

  describe('action: mark_read', () => {
    let unreadMessageId: string;

    beforeEach(async () => {
      // Créer un message non-lu pour les tests
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body',
        'MEDIUM'
      );
      unreadMessageId = msg.id;
    });

    test('should mark unread message as read', async () => {
      const result = await roosyncManage({
        action: 'mark_read',
        message_id: unreadMessageId
      });

      expect((result.content[0] as any).text).toContain('Message marqué comme lu');
      expect((result.content[0] as any).text).toContain('UNREAD → ✅ READ');
    });

    test('should return info when message already read', async () => {
      // Marquer comme lu d'abord
      await messageManager.markAsRead(unreadMessageId);

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: unreadMessageId
      });

      expect((result.content[0] as any).text).toContain('déjà marqué comme lu');
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncManage({
        action: 'mark_read'
      } as any);

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('message_id');
    });

    test('should return error when message not found', async () => {
      const result = await roosyncManage({
        action: 'mark_read',
        message_id: 'msg-nonexistent'
      });

      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('should display message details after marking as read', async () => {
      const result = await roosyncManage({
        action: 'mark_read',
        message_id: unreadMessageId
      });

      expect((result.content[0] as any).text).toContain('Test Subject');
      expect((result.content[0] as any).text).toContain('sender-machine');
      expect((result.content[0] as any).text).toContain('test-machine');
    });
  });

  // ============================================================
  // Tests pour action: 'archive'
  // ============================================================

  describe('action: archive', () => {
    let messageToArchiveId: string;

    beforeEach(async () => {
      // Créer un message pour archivage
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Archive Test Subject',
        'Archive test body',
        'LOW'
      );
      messageToArchiveId = msg.id;
    });

    test('should archive existing message', async () => {
      const result = await roosyncManage({
        action: 'archive',
        message_id: messageToArchiveId
      });

      expect((result.content[0] as any).text).toContain('Message archivé avec succès');
      expect((result.content[0] as any).text).toContain('ARCHIVED');
    });

    test('should return info when message already archived', async () => {
      // Archiver d'abord
      await messageManager.archiveMessage(messageToArchiveId);

      const result = await roosyncManage({
        action: 'archive',
        message_id: messageToArchiveId
      });

      expect((result.content[0] as any).text).toContain('déjà archivé');
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncManage({
        action: 'archive'
      } as any);

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('message_id');
    });

    test('should return error when message not found', async () => {
      const result = await roosyncManage({
        action: 'archive',
        message_id: 'msg-nonexistent'
      });

      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('should move message to archive folder', async () => {
      await roosyncManage({
        action: 'archive',
        message_id: messageToArchiveId
      });

      // Vérifier que le fichier est dans archive
      const archivePath = join(testSharedStatePath, 'messages/archive', `${messageToArchiveId}.json`);
      expect(existsSync(archivePath)).toBe(true);
    });

    test('should display archive path in result', async () => {
      const result = await roosyncManage({
        action: 'archive',
        message_id: messageToArchiveId
      });

      expect((result.content[0] as any).text).toContain(`messages/archive/${messageToArchiveId}.json`);
    });

    test('should preserve thread_id info in archive message', async () => {
      // Créer un message avec thread_id
      const threadMsg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Thread Test',
        'Body',
        'MEDIUM',
        ['test'],
        'thread-123'
      );

      const result = await roosyncManage({
        action: 'archive',
        message_id: threadMsg.id
      });

      expect((result.content[0] as any).text).toContain('thread-123');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration', () => {
    test('should handle mark_read then archive workflow', async () => {
      // Créer un message
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Workflow Test',
        'Body',
        'HIGH'
      );

      // Step 1: Mark as read
      const markResult = await roosyncManage({
        action: 'mark_read',
        message_id: msg.id
      });
      expect(markResult.content[0].text).toContain('marqué comme lu');

      // Step 2: Archive
      const archiveResult = await roosyncManage({
        action: 'archive',
        message_id: msg.id
      });
      expect(archiveResult.content[0].text).toContain('archivé avec succès');
      expect(archiveResult.content[0].text).toContain('READ → 📦 ARCHIVED');
    });

    test('should handle direct archive (without reading first)', async () => {
      // Créer un message
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Direct Archive',
        'Body',
        'LOW'
      );

      // Archive directly
      const result = await roosyncManage({
        action: 'archive',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('archivé avec succès');
      expect((result.content[0] as any).text).toContain('UNREAD → 📦 ARCHIVED');
    });

    test('should handle multiple operations on different messages', async () => {
      // Créer plusieurs messages
      const msg1 = await messageManager.sendMessage('s1', 'test-machine', 'Msg1', 'B1', 'LOW');
      const msg2 = await messageManager.sendMessage('s2', 'test-machine', 'Msg2', 'B2', 'MEDIUM');
      const msg3 = await messageManager.sendMessage('s3', 'test-machine', 'Msg3', 'B3', 'HIGH');

      // Mark msg1 as read
      const r1 = await roosyncManage({ action: 'mark_read', message_id: msg1.id });
      expect(r1.content[0].text).toContain('marqué comme lu');

      // Archive msg2
      const r2 = await roosyncManage({ action: 'archive', message_id: msg2.id });
      expect(r2.content[0].text).toContain('archivé');

      // Mark msg3 as read then archive
      await roosyncManage({ action: 'mark_read', message_id: msg3.id });
      const r3 = await roosyncManage({ action: 'archive', message_id: msg3.id });
      expect(r3.content[0].text).toContain('READ → 📦 ARCHIVED');
    });
  });
});
