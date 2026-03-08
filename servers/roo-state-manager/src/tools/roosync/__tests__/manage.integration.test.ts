/**
 * Tests d'intégration pour roosync_manage
 *
 * Couvre les actions de l'outil :
 * - action: 'mark_read' : Marquer un message comme lu
 * - action: 'archive' : Archiver un message
 *
 * Framework: Vitest
 * Type: Intégration (MessageManager réel, opérations filesystem réelles)
 *
 * @module roosync/manage.integration.test
 * @version 1.1.0 (#564 Phase 3, #606 fix)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-manage-integration');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncManage } from '../manage.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncManage (integration)', () => {
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

  // Helper to extract text from roosyncManage result
  function getText(result: { content: Array<{ type: string; text: string }> }): string {
    return result.content[0].text;
  }

  // ============================================================
  // Tests pour action: 'mark_read'
  // ============================================================

  describe('action: mark_read', () => {
    test('should mark unread message as read', async () => {
      // Créer un message non lu
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body content',
        'MEDIUM'
      );

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('marqué comme lu');
      expect(text).toContain(msg.id);

      // Vérifier que le message est maintenant marqué comme lu
      const updatedMsg = await messageManager.getMessage(msg.id);
      expect(updatedMsg?.status).toBe('read');
    });

    test('should return message when already read', async () => {
      // Créer un message et le marquer comme lu directement
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body',
        'LOW'
      );
      await messageManager.markAsRead(msg.id);

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('déjà');
      expect(text).toContain('lu');
    });

    test('should reject mark_read without message_id', async () => {
      const result = await roosyncManage({
        action: 'mark_read'
        // message_id manquant - will be caught by error handler
      } as any);

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('Erreur');
      expect(text).toContain('message_id');
    });

    test('should handle non-existent message gracefully', async () => {
      const result = await roosyncManage({
        action: 'mark_read',
        message_id: 'msg-nonexistent'
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('introuvable');
    });

    test('should complete mark_read operation with heartbeat (fire-and-forget)', async () => {
      // Heartbeat registerHeartbeat is called fire-and-forget inside roosyncManage
      // on the global singleton (getRooSyncService()), not the local test instance
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body',
        'LOW'
      );

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('marqué comme lu');
    });
  });

  // ============================================================
  // Tests pour action: 'archive'
  // ============================================================

  describe('action: archive', () => {
    test('should archive existing message', async () => {
      // Créer un message dans inbox
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject to Archive',
        'Test body for archive',
        'HIGH'
      );

      const result = await roosyncManage({
        action: 'archive',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('archivé');
      expect(text).toContain(msg.id);

      // Vérifier que le message est maintenant archivé (status changed)
      const archivedMsg = await messageManager.getMessage(msg.id);
      expect(archivedMsg).toBeDefined();
      expect(archivedMsg?.status).toBe('archived');
    });

    test('should return message when already archived', async () => {
      // Créer et archiver un message
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body',
        'LOW'
      );
      await messageManager.archiveMessage(msg.id);

      const result = await roosyncManage({
        action: 'archive',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('déjà archivé');
    });

    test('should reject archive without message_id', async () => {
      const result = await roosyncManage({
        action: 'archive'
        // message_id manquant
      } as any);

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('Erreur');
      expect(text).toContain('message_id');
    });

    test('should handle non-existent message gracefully', async () => {
      const result = await roosyncManage({
        action: 'archive',
        message_id: 'msg-nonexistent'
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('introuvable');
    });

    test('should complete archive operation with heartbeat (fire-and-forget)', async () => {
      const msg = await messageManager.sendMessage(
        'sender-machine',
        'test-machine',
        'Test Subject',
        'Test body',
        'LOW'
      );

      const result = await roosyncManage({
        action: 'archive',
        message_id: msg.id
      });

      expect(result).toBeDefined();
      const text = getText(result);
      expect(text).toContain('archivé');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: send → mark_read → archive', async () => {
      // Step 1: Envoyer un message
      const sentMsg = await messageManager.sendMessage(
        'workflow-sender',
        'test-machine',
        'Workflow Integration Test',
        'Testing complete workflow',
        'MEDIUM'
      );

      // Step 2: Marquer comme lu
      const markReadResult = await roosyncManage({
        action: 'mark_read',
        message_id: sentMsg.id
      });
      expect(getText(markReadResult)).toContain('marqué comme lu');

      const msgAfterRead = await messageManager.getMessage(sentMsg.id);
      expect(msgAfterRead?.status).toBe('read');

      // Step 3: Archiver
      const archiveResult = await roosyncManage({
        action: 'archive',
        message_id: sentMsg.id
      });
      expect(getText(archiveResult)).toContain('archivé');

      const archivedMsg = await messageManager.getMessage(sentMsg.id);
      expect(archivedMsg).toBeDefined();
      expect(archivedMsg?.status).toBe('archived');
    });

    test('should handle multiple messages with mixed status', async () => {
      // Créer 3 messages
      const msg1 = await messageManager.sendMessage('sender-1', 'test-machine', 'Msg 1', 'Body 1', 'LOW');
      const msg2 = await messageManager.sendMessage('sender-2', 'test-machine', 'Msg 2', 'Body 2', 'MEDIUM');
      const msg3 = await messageManager.sendMessage('sender-3', 'test-machine', 'Msg 3', 'Body 3', 'HIGH');

      // Marquer msg1 comme lu
      await roosyncManage({ action: 'mark_read', message_id: msg1.id });
      expect((await messageManager.getMessage(msg1.id))?.status).toBe('read');

      // Archiver msg2
      await roosyncManage({ action: 'archive', message_id: msg2.id });
      const archivedMsg2 = await messageManager.getMessage(msg2.id);
      expect(archivedMsg2?.status).toBe('archived');

      // msg3 reste non lu
      expect((await messageManager.getMessage(msg3.id))?.status).toBe('unread');
    });

    test('should handle sequential mark_read then archive operations', async () => {
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Test',
        'Body',
        'LOW'
      );

      // Marquer comme lu
      const readResult = await roosyncManage({ action: 'mark_read', message_id: msg.id });
      expect(getText(readResult)).toContain('marqué comme lu');

      // Archiver
      const archiveResult = await roosyncManage({ action: 'archive', message_id: msg.id });
      expect(getText(archiveResult)).toContain('archivé');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing shared state directory gracefully', async () => {
      // Supprimer le répertoire pour simuler l'absence
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: 'some-id'
      });

      expect(result).toBeDefined();
      // Devrait retourner un message d'erreur ou un résultat gracieux
      expect(result.content).toHaveLength(1);
    });

    test('should handle corrupted message files', async () => {
      // Créer un fichier corrompu dans inbox
      const { writeFile } = await import('fs/promises');
      const corruptedId = 'msg-corrupted';
      const corruptedPath = join(testSharedStatePath, 'messages/inbox', `${corruptedId}.json`);
      await writeFile(corruptedPath, '{ invalid json }');

      const result = await roosyncManage({
        action: 'mark_read',
        message_id: corruptedId
      });

      expect(result).toBeDefined();
      // Devrait gérer le fichier corrompu gracieusement
      expect(result.content).toHaveLength(1);
    });
  });
});
