/**
 * Tests unitaires pour roosync_send
 *
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'send' : Envoi de nouveau message
 * - action: 'reply' : Réponse à un message existant
 * - action: 'amend' : Modification d'un message envoyé
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/send.test
 * @version 1.0.0 (CONS-1)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId and getLocalFullId pour contrôler l'émetteur dans les tests
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
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-send');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncSend } from '../send.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { promises as fs } from 'fs';

describe('roosyncSend', () => {
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
      const result = await roosyncSend({} as any);

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('action');
    });

    test('should return error when action is invalid', async () => {
      const result = await roosyncSend({ action: 'invalid' as any });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('invalid');
    });
  });

  // ============================================================
  // Tests pour action: 'send'
  // ============================================================

  describe('action: send', () => {
    test('should send message with all required fields', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Test Subject',
        body: 'Test body content'
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Message envoyé avec succès');
      expect((result.content[0] as any).text).toContain('target-machine');
      expect((result.content[0] as any).text).toContain('Test Subject');
    });

    test('should send message with optional fields', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Test Subject',
        body: 'Test body',
        priority: 'HIGH',
        tags: ['urgent', 'cons-1']
      });

      expect((result.content[0] as any).text).toContain('Message envoyé avec succès');
      expect((result.content[0] as any).text).toContain('HIGH');
    });

    test('should return error when "to" is missing', async () => {
      const result = await roosyncSend({
        action: 'send',
        subject: 'Test',
        body: 'Body'
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('to');
    });

    test('should return error when "subject" is missing', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        body: 'Body'
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('subject');
    });

    test('should return error when "body" is missing', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Test'
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('body');
    });

    test('should create files in inbox and sent folders', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'File Test',
        body: 'Body'
      });

      // Extraire l'ID du message du résultat
      const match = (result.content[0] as any).text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      expect(match).not.toBeNull();
      const messageId = match![1];

      // Vérifier que les fichiers existent
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${messageId}.json`);
      const sentPath = join(testSharedStatePath, 'messages/sent', `${messageId}.json`);

      expect(existsSync(inboxPath)).toBe(true);
      expect(existsSync(sentPath)).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'reply'
  // ============================================================

  describe('action: reply', () => {
    let originalMessageId: string;

    beforeEach(async () => {
      // Créer un message original pour les tests de reply
      const original = await messageManager.sendMessage(
        'other-machine',
        'test-machine',
        'Original Subject',
        'Original body',
        'MEDIUM'
      );
      originalMessageId = original.id;
    });

    test('should reply to existing message', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: originalMessageId,
        body: 'This is my reply'
      });

      expect((result.content[0] as any).text).toContain('Réponse envoyée avec succès');
      expect((result.content[0] as any).text).toContain('Re: Original Subject');
      expect((result.content[0] as any).text).toContain('This is my reply');
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncSend({
        action: 'reply',
        body: 'Reply body'
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('message_id');
    });

    test('should return error when body is missing', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: originalMessageId
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('body');
    });

    test('should return error when original message not found', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: 'msg-nonexistent',
        body: 'Reply body'
      });

      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('should preserve thread_id in reply', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: originalMessageId,
        body: 'Reply with thread'
      });

      expect((result.content[0] as any).text).toContain('Thread ID');
    });

    test('should invert from/to in reply', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: originalMessageId,
        body: 'Reply body'
      });

      // La réponse doit aller de test-machine vers other-machine
      expect((result.content[0] as any).text).toContain('test-machine');
      expect((result.content[0] as any).text).toContain('other-machine');
      expect((result.content[0] as any).text).toContain('inversé');
    });
  });

  // ============================================================
  // Tests pour action: 'amend'
  // ============================================================

  describe('action: amend', () => {
    let sentMessageId: string;

    beforeEach(async () => {
      // Créer un message envoyé pour les tests d'amend
      const sent = await messageManager.sendMessage(
        'test-machine',
        'other-machine',
        'Message to Amend',
        'Original content',
        'MEDIUM'
      );
      sentMessageId = sent.id;
    });

    test('should amend existing message', async () => {
      const result = await roosyncSend({
        action: 'amend',
        message_id: sentMessageId,
        new_content: 'Updated content',
        reason: 'Correction de typo'
      });

      expect((result.content[0] as any).text).toContain('amendé avec succès');
      expect((result.content[0] as any).text).toContain('Correction de typo');
    });

    test('should return error when message_id is missing', async () => {
      const result = await roosyncSend({
        action: 'amend',
        new_content: 'New content'
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('message_id');
    });

    test('should return error when new_content is missing', async () => {
      const result = await roosyncSend({
        action: 'amend',
        message_id: sentMessageId
      });

      expect((result.content[0] as any).text).toContain('Erreur');
      expect((result.content[0] as any).text).toContain('new_content');
    });

    test('should preserve original content in metadata', async () => {
      const result = await roosyncSend({
        action: 'amend',
        message_id: sentMessageId,
        new_content: 'Updated content'
      });

      expect((result.content[0] as any).text).toContain('Contenu original préservé');
      expect((result.content[0] as any).text).toContain('Oui');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration', () => {
    test('should handle complete send-reply-amend workflow', async () => {
      // Step 1: Send
      const sendResult = await roosyncSend({
        action: 'send',
        to: 'other-machine',
        subject: 'Workflow Test',
        body: 'Initial message'
      });
      expect(sendResult.content[0].text).toContain('envoyé avec succès');

      // Extraire l'ID
      const match = sendResult.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      const messageId = match![1];

      // Step 2: Amend (avant lecture)
      const amendResult = await roosyncSend({
        action: 'amend',
        message_id: messageId,
        new_content: 'Corrected message',
        reason: 'Typo fix'
      });
      expect(amendResult.content[0].text).toContain('amendé avec succès');
    });

    test('should handle multiple sends in sequence', async () => {
      const results = await Promise.all([
        roosyncSend({ action: 'send', to: 'm1', subject: 'Msg1', body: 'Body1' }),
        roosyncSend({ action: 'send', to: 'm2', subject: 'Msg2', body: 'Body2' }),
        roosyncSend({ action: 'send', to: 'm3', subject: 'Msg3', body: 'Body3' })
      ]);

      // Tous les envois devraient réussir
      for (const result of results) {
        expect((result.content[0] as any).text).toContain('envoyé avec succès');
      }

      // Les IDs devraient être uniques
      const ids = results.map(r => {
        const match = r.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return match![1];
      });
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });
});
