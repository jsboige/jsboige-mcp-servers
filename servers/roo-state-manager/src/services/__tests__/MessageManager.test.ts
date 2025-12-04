/**
 * Tests unitaires pour MessageManager
 *
 * Couvre toutes les méthodes publiques et privées exposées :
 * - generateMessageId() : Génération ID unique
 * - sendMessage() : Création et envoi de messages
 * - readInbox() : Lecture messages avec filtres
 * - getMessage() : Récupération par ID
 * - markAsRead() : Changement statut (Phase 2)
 * - archiveMessage() : Archivage (Phase 2)
 *
 * Framework: Vitest
 * Coverage cible: >80%
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageManager, type MessageListItem } from '../MessageManager.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');

describe('MessageManager', () => {
  let messageManager: MessageManager;
  let testSharedStatePath: string;

  beforeEach(async () => {
    // Setup : créer répertoire temporaire pour tests isolés
    testSharedStatePath = join(__dirname, '../../__test-data__/shared-state');

    // Créer structure répertoires de messagerie
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

    // Instancier le MessageManager avec le chemin de test
    messageManager = new MessageManager(testSharedStatePath);
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    test('should initialize with correct paths', () => {
      expect(messageManager).toBeDefined();

      // Vérifier que les répertoires ont été créés
      const inboxPath = join(testSharedStatePath, 'messages/inbox');
      const sentPath = join(testSharedStatePath, 'messages/sent');
      const archivePath = join(testSharedStatePath, 'messages/archive');

      expect(existsSync(inboxPath)).toBe(true);
      expect(existsSync(sentPath)).toBe(true);
      expect(existsSync(archivePath)).toBe(true);
    });
  });

  describe('sendMessage', () => {
    test('should create and send message with all required fields', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test Subject',
        'Test body content',
        'HIGH'
      );

      // Vérifier structure du message
      expect(message).toHaveProperty('id');
      expect(message).toHaveProperty('timestamp');
      expect(message.id).toMatch(/^msg-\d{8}T\d{6}-[a-z0-9]{6}$/);
      expect(message.from).toBe('machine1');
      expect(message.to).toBe('machine2');
      expect(message.subject).toBe('Test Subject');
      expect(message.body).toBe('Test body content');
      expect(message.priority).toBe('HIGH');
      expect(message.status).toBe('unread');
    });

    test('should default to MEDIUM priority if not specified', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test',
        'Body'
      );

      expect(message.priority).toBe('MEDIUM');
    });

    test('should handle optional fields (tags, thread_id, reply_to)', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test',
        'Body',
        'LOW',
        ['tag1', 'tag2'],
        'thread-123',
        'msg-456'
      );

      expect(message.tags).toEqual(['tag1', 'tag2']);
      expect(message.thread_id).toBe('thread-123');
      expect(message.reply_to).toBe('msg-456');
    });

    test('should save message to both inbox and sent folders', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test Save',
        'Body'
      );

      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
      const sentPath = join(testSharedStatePath, 'messages/sent', `${message.id}.json`);

      // Vérifier que les fichiers existent
      expect(existsSync(inboxPath)).toBe(true);
      expect(existsSync(sentPath)).toBe(true);

      // Vérifier contenu des fichiers
      const inboxContent = JSON.parse(await fs.readFile(inboxPath, 'utf-8'));
      const sentContent = JSON.parse(await fs.readFile(sentPath, 'utf-8'));

      expect(inboxContent.id).toBe(message.id);
      expect(sentContent.id).toBe(message.id);
    });

    test('should generate unique message IDs', async () => {
      const msg1 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test1', 'Body1'
      );
      const msg2 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test2', 'Body2'
      );

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('readInbox', () => {
    test('should return only messages for specified recipient', async () => {
      // Créer 3 messages : 2 pour machine2, 1 pour machine3
      await messageManager.sendMessage('machine1', 'machine2', 'Msg1', 'Body1');
      await messageManager.sendMessage('machine1', 'machine2', 'Msg2', 'Body2');
      await messageManager.sendMessage('machine1', 'machine3', 'Msg3', 'Body3');

      const inbox = await messageManager.readInbox('machine2');

      expect(inbox).toHaveLength(2);
      expect(inbox.every((msg: MessageListItem) => msg.to === 'machine2')).toBe(true);
    });

    test('should filter by status (unread only)', async () => {
      const msg1 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Unread', 'Body'
      );
      const msg2 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Read', 'Body'
      );

      // Marquer msg2 comme lu
      await messageManager.markAsRead(msg2.id);

      const unreadOnly = await messageManager.readInbox('machine2', 'unread');

      expect(unreadOnly).toHaveLength(1);
      expect(unreadOnly[0].status).toBe('unread');
      expect(unreadOnly[0].subject).toBe('Unread');
    });

    test('should filter by status (read only)', async () => {
      const msg1 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Unread', 'Body'
      );
      const msg2 = await messageManager.sendMessage(
        'machine1', 'machine2', 'Read', 'Body'
      );

      // Marquer msg2 comme lu
      await messageManager.markAsRead(msg2.id);

      const readOnly = await messageManager.readInbox('machine2', 'read');

      expect(readOnly).toHaveLength(1);
      expect(readOnly[0].status).toBe('read');
      expect(readOnly[0].subject).toBe('Read');
    });

    test('should return all messages when status is "all"', async () => {
      await messageManager.sendMessage('machine1', 'machine2', 'Msg1', 'Body1');
      const msg2 = await messageManager.sendMessage('machine1', 'machine2', 'Msg2', 'Body2');

      await messageManager.markAsRead(msg2.id);

      const all = await messageManager.readInbox('machine2', 'all');

      expect(all).toHaveLength(2);
    });

    test('should limit results when limit parameter is provided', async () => {
      await messageManager.sendMessage('machine1', 'machine2', 'Msg1', 'Body1');
      await messageManager.sendMessage('machine1', 'machine2', 'Msg2', 'Body2');
      await messageManager.sendMessage('machine1', 'machine2', 'Msg3', 'Body3');

      const limited = await messageManager.readInbox('machine2', 'all', 2);

      expect(limited).toHaveLength(2);
    });

    test('should sort messages by timestamp (newest first)', async () => {
      await messageManager.sendMessage('machine1', 'machine2', 'First', 'Body');
      await new Promise(resolve => setTimeout(resolve, 10)); // Petit délai
      await messageManager.sendMessage('machine1', 'machine2', 'Second', 'Body');
      await new Promise(resolve => setTimeout(resolve, 10));
      await messageManager.sendMessage('machine1', 'machine2', 'Third', 'Body');

      const inbox = await messageManager.readInbox('machine2');

      expect(inbox[0].subject).toBe('Third');
      expect(inbox[1].subject).toBe('Second');
      expect(inbox[2].subject).toBe('First');
    });

    test('should return empty array if no messages for recipient', async () => {
      await messageManager.sendMessage('machine1', 'machine2', 'Msg', 'Body');

      const inbox = await messageManager.readInbox('machine3');

      expect(inbox).toEqual([]);
    });

    test('should include preview field with truncated body', async () => {
      const longBody = 'A'.repeat(150);
      await messageManager.sendMessage('machine1', 'machine2', 'Long', longBody);

      const inbox = await messageManager.readInbox('machine2');

      expect(inbox[0].preview).toBe('A'.repeat(100) + '...');
    });

    test('should not truncate preview if body is short', async () => {
      const shortBody = 'Short message';
      await messageManager.sendMessage('machine1', 'machine2', 'Short', shortBody);

      const inbox = await messageManager.readInbox('machine2');

      expect(inbox[0].preview).toBe(shortBody);
    });
  });

  describe('getMessage', () => {
    test('should retrieve message by ID from inbox', async () => {
      const sent = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      const retrieved = await messageManager.getMessage(sent.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(sent.id);
      expect(retrieved?.subject).toBe('Test');
      expect(retrieved?.body).toBe('Body');
    });

    test('should retrieve message by ID from sent', async () => {
      const sent = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      // Supprimer de inbox pour tester recherche dans sent
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${sent.id}.json`);
      await fs.unlink(inboxPath);

      const retrieved = await messageManager.getMessage(sent.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(sent.id);
    });

    test('should retrieve message by ID from archive', async () => {
      const sent = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      // Archiver le message
      await messageManager.archiveMessage(sent.id);

      // Supprimer aussi de sent pour forcer recherche dans archive
      const sentPath = join(testSharedStatePath, 'messages/sent', `${sent.id}.json`);
      await fs.unlink(sentPath);

      const retrieved = await messageManager.getMessage(sent.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(sent.id);
      expect(retrieved?.status).toBe('archived');
    });

    test('should return null for non-existent message', async () => {
      const retrieved = await messageManager.getMessage('msg-nonexistent-123456');

      expect(retrieved).toBeNull();
    });
  });

  describe('markAsRead', () => {
    test('should change message status to read', async () => {
      const message = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      const result = await messageManager.markAsRead(message.id);
      expect(result).toBe(true);

      // Vérifier que le statut a bien changé
      const retrieved = await messageManager.getMessage(message.id);
      expect(retrieved?.status).toBe('read');
    });

    test('should return false for non-existent message', async () => {
      const result = await messageManager.markAsRead('msg-nonexistent-123456');

      expect(result).toBe(false);
    });

    test('should persist status change to file', async () => {
      const message = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      await messageManager.markAsRead(message.id);

      // Lire directement le fichier pour vérifier
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
      const fileContent = JSON.parse(await fs.readFile(inboxPath, 'utf-8'));

      expect(fileContent.status).toBe('read');
    });
  });

  describe('archiveMessage', () => {
    test('should move message from inbox to archive', async () => {
      const message = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      const result = await messageManager.archiveMessage(message.id);
      expect(result).toBe(true);

      // Vérifier que le message n'est plus dans inbox
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
      expect(existsSync(inboxPath)).toBe(false);

      // Vérifier que le message est dans archive
      const archivePath = join(testSharedStatePath, 'messages/archive', `${message.id}.json`);
      expect(existsSync(archivePath)).toBe(true);
    });

    test('should change message status to archived', async () => {
      const message = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      await messageManager.archiveMessage(message.id);

      // Lire directement depuis archive pour vérifier le statut
      const archivePath = join(testSharedStatePath, 'messages/archive', `${message.id}.json`);
      const archivedContent = JSON.parse(await fs.readFile(archivePath, 'utf-8'));
      expect(archivedContent.status).toBe('archived');
    });

    test('should return false for non-existent message', async () => {
      const result = await messageManager.archiveMessage('msg-nonexistent-123456');

      expect(result).toBe(false);
    });

    test('should not be visible in inbox after archiving', async () => {
      const message = await messageManager.sendMessage(
        'machine1', 'machine2', 'Test', 'Body'
      );

      await messageManager.archiveMessage(message.id);

      const inbox = await messageManager.readInbox('machine2');
      expect(inbox).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty inbox gracefully', async () => {
      const inbox = await messageManager.readInbox('machine1');

      expect(inbox).toEqual([]);
    });

    test('should handle messages with undefined optional fields', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test',
        'Body',
        'MEDIUM'
      );

      expect(message.tags).toBeUndefined();
      expect(message.thread_id).toBeUndefined();
      expect(message.reply_to).toBeUndefined();
    });

    test('should handle messages with all priority levels', async () => {
      const priorities: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'> =
        ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

      for (const priority of priorities) {
        const msg = await messageManager.sendMessage(
          'machine1', 'machine2', `Test ${priority}`, 'Body', priority
        );
        expect(msg.priority).toBe(priority);
      }
    });

    test('should handle special characters in message content', async () => {
      const specialSubject = 'Test with émojis 🚀 and spécial chars: <>&"\'';
      const specialBody = 'Line 1\nLine 2\n\tTabbed\n"Quoted"';

      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        specialSubject,
        specialBody
      );

      const retrieved = await messageManager.getMessage(message.id);
      expect(retrieved?.subject).toBe(specialSubject);
      expect(retrieved?.body).toBe(specialBody);
    });

    test('should handle concurrent message creation', async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          messageManager.sendMessage(
            'machine1', 'machine2', `Concurrent ${i}`, `Body ${i}`
          )
        );
      }

      const messages = await Promise.all(promises);

      // Vérifier que tous les IDs sont uniques
      const ids = messages.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);

      // Vérifier que tous les messages sont dans l'inbox
      const inbox = await messageManager.readInbox('machine2');
      expect(inbox).toHaveLength(5);
    });
  });
});