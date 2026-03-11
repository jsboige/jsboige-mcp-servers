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
vi.unmock('fs/promises');

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
    // Retry logic for Windows ENOTEMPTY issues
    if (existsSync(testSharedStatePath)) {
      for (let i = 0; i < 3; i++) {
        try {
          rmSync(testSharedStatePath, { recursive: true, force: true });
          break;
        } catch (err: unknown) {
          if (i === 2) {
            // Last attempt failed, ignore ENOTEMPTY errors
            if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
              throw err;
            }
          }
          // Wait a bit before retry
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
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

  describe('page/perPage pagination (#638)', () => {
    test('should paginate with page and perPage', async () => {
      for (let i = 0; i < 10; i++) {
        await messageManager.sendMessage('m1', 'machine2', `Msg${i}`, `Body${i}`);
      }

      // Page 1 (3 per page)
      const page1 = await messageManager.readInbox('machine2', 'all', undefined, undefined, 1, 3);
      expect(page1).toHaveLength(3);

      // Page 2
      const page2 = await messageManager.readInbox('machine2', 'all', undefined, undefined, 2, 3);
      expect(page2).toHaveLength(3);

      // Pages should have different messages
      expect(page1[0].id).not.toBe(page2[0].id);

      // Last page (page 4 = 1 remaining)
      const page4 = await messageManager.readInbox('machine2', 'all', undefined, undefined, 4, 3);
      expect(page4).toHaveLength(1);
    });

    test('should return empty array for page beyond data', async () => {
      await messageManager.sendMessage('m1', 'machine2', 'Msg1', 'Body1');

      const result = await messageManager.readInbox('machine2', 'all', undefined, undefined, 100, 10);
      expect(result).toHaveLength(0);
    });
  });

  describe('getFilteredCount (#638)', () => {
    test('should return total, unread, and read counts', async () => {
      const msg1 = await messageManager.sendMessage('m1', 'machine2', 'Msg1', 'Body1');
      await messageManager.sendMessage('m1', 'machine2', 'Msg2', 'Body2');
      await messageManager.sendMessage('m1', 'machine2', 'Msg3', 'Body3');

      // Mark one as read
      await messageManager.markAsRead(msg1.id);

      const counts = await messageManager.getFilteredCount('machine2');
      expect(counts.total).toBe(3);
      expect(counts.unread).toBe(2);
      expect(counts.read).toBe(1);
    });

    test('should return zeros for machine with no messages', async () => {
      const counts = await messageManager.getFilteredCount('nonexistent');
      expect(counts.total).toBe(0);
      expect(counts.unread).toBe(0);
      expect(counts.read).toBe(0);
    });
  });

  describe('inbox cache (#638)', () => {
    test('should invalidate cache after sendMessage', async () => {
      await messageManager.sendMessage('m1', 'machine2', 'Msg1', 'Body1');
      const inbox1 = await messageManager.readInbox('machine2');
      expect(inbox1).toHaveLength(1);

      // Send another — cache should be invalidated
      await messageManager.sendMessage('m1', 'machine2', 'Msg2', 'Body2');
      const inbox2 = await messageManager.readInbox('machine2');
      expect(inbox2).toHaveLength(2);
    });

    test('should invalidate cache after markAsRead', async () => {
      const msg = await messageManager.sendMessage('m1', 'machine2', 'Msg1', 'Body1');
      const countsBefore = await messageManager.getFilteredCount('machine2');
      expect(countsBefore.unread).toBe(1);

      await messageManager.markAsRead(msg.id);
      const countsAfter = await messageManager.getFilteredCount('machine2');
      expect(countsAfter.unread).toBe(0);
      expect(countsAfter.read).toBe(1);
    });

    test('should invalidate cache after archiveMessage', async () => {
      const msg = await messageManager.sendMessage('m1', 'machine2', 'Msg1', 'Body1');
      const inbox1 = await messageManager.readInbox('machine2');
      expect(inbox1).toHaveLength(1);

      await messageManager.archiveMessage(msg.id);
      const inbox2 = await messageManager.readInbox('machine2');
      expect(inbox2).toHaveLength(0);
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

  describe('Workspace messaging (#434)', () => {
    test('should allow sending between same machine different workspaces', async () => {
      const message = await messageManager.sendMessage(
        'myia-ai-01:roo-extensions',
        'myia-ai-01:vllm-hosting',
        'Cross-workspace',
        'Hello from roo-extensions'
      );

      expect(message.from).toBe('myia-ai-01:roo-extensions');
      expect(message.to).toBe('myia-ai-01:vllm-hosting');
    });

    test('should block self-message on same machine:workspace', async () => {
      await expect(
        messageManager.sendMessage(
          'myia-ai-01:roo-extensions',
          'myia-ai-01:roo-extensions',
          'Self',
          'Self message'
        )
      ).rejects.toThrow(/Auto-message interdit/);
    });

    test('should block self-message on same machine (no workspace)', async () => {
      await expect(
        messageManager.sendMessage(
          'myia-ai-01',
          'myia-ai-01',
          'Self',
          'Self message'
        )
      ).rejects.toThrow(/Auto-message interdit/);
    });

    test('readInbox with workspace should see workspace-specific messages', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'myia-ai-01:roo-extensions',
        'For roo-ext workspace',
        'Body'
      );

      const inbox = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].subject).toBe('For roo-ext workspace');
    });

    test('readInbox with different workspace should NOT see workspace-specific messages', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'myia-ai-01:roo-extensions',
        'For roo-ext only',
        'Body'
      );

      const inbox = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'vllm-hosting');
      expect(inbox).toHaveLength(0);
    });

    test('readInbox without workspace should NOT see workspace-targeted messages', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'myia-ai-01:roo-extensions',
        'Workspace-specific',
        'Body'
      );

      const inbox = await messageManager.readInbox('myia-ai-01');
      expect(inbox).toHaveLength(0);
    });

    test('readInbox with workspace should see machine-level messages', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'myia-ai-01',
        'For all workspaces',
        'Body'
      );

      const inbox = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].subject).toBe('For all workspaces');
    });

    test('readInbox with workspace should see broadcast messages', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'all',
        'Broadcast',
        'Body'
      );

      const inbox = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(inbox).toHaveLength(1);
    });

    test('readInbox should see machine-level + workspace-specific + broadcast', async () => {
      await messageManager.sendMessage('myia-po-2024', 'myia-ai-01', 'Machine-level', 'Body');
      await messageManager.sendMessage('myia-po-2024', 'myia-ai-01:roo-extensions', 'Workspace-specific', 'Body');
      await messageManager.sendMessage('myia-po-2024', 'all', 'Broadcast', 'Body');

      const inbox = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(inbox).toHaveLength(3);
    });

    test('checkNewMessages should respect workspace filter', async () => {
      await messageManager.sendMessage(
        'myia-po-2024',
        'myia-ai-01:roo-extensions',
        'Unread workspace msg',
        'Body'
      );

      const unread = await messageManager.checkNewMessages('myia-ai-01', 'roo-extensions');
      expect(unread).toHaveLength(1);

      const otherWs = await messageManager.checkNewMessages('myia-ai-01', 'other-ws');
      expect(otherWs).toHaveLength(0);
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

  // ============================================================
  // amendMessage - Permission check (#576)
  // ============================================================

  describe('amendMessage', () => {
    test('allows amend when sender matches exactly', async () => {
      // Send a message from machine-a:workspace1
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      // Amend from same full ID
      const result = await messageManager.amendMessage(
        msg.id, 'machine-a:workspace1', 'Updated body', 'typo fix'
      );

      expect(result.message_id).toBe(msg.id);
      expect(result.original_content_preserved).toBe(true);
    });

    test('allows amend when same machine but different workspace (#576)', async () => {
      // Send from machine-a:workspace1
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      // Amend from machine-a:different-workspace (same machine, different workspace)
      const result = await messageManager.amendMessage(
        msg.id, 'machine-a:other-workspace', 'Updated body', 'workspace switch'
      );

      expect(result.message_id).toBe(msg.id);
      expect(result.original_content_preserved).toBe(true);
    });

    test('allows amend when sender has no workspace suffix', async () => {
      // Send from machine-a:workspace1
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      // Amend from machine-a (no workspace suffix)
      const result = await messageManager.amendMessage(
        msg.id, 'machine-a', 'Updated body', 'no workspace'
      );

      expect(result.message_id).toBe(msg.id);
    });

    test('rejects amend from different machine', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      await expect(
        messageManager.amendMessage(msg.id, 'machine-c:workspace1', 'Hack', 'unauthorized')
      ).rejects.toThrow('Permission refusée');
    });

    test('rejects amend of already-read message', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      // Mark as read
      await messageManager.markAsRead(msg.id);

      await expect(
        messageManager.amendMessage(msg.id, 'machine-a:workspace1', 'Too late', 'already read')
      ).rejects.toThrow(/lu|archivé/i);
    });

    test('preserves original content on first amend', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a:workspace1', 'machine-b:workspace1',
        'Test subject', 'Original body'
      );

      await messageManager.amendMessage(
        msg.id, 'machine-a:workspace1', 'Updated body', 'first amend'
      );

      // Read the message to check metadata
      const updated = await messageManager.getMessage(msg.id);
      expect(updated).toBeTruthy();
      expect(updated!.metadata?.original_content).toBe('Original body');
      expect(updated!.body).toBe('Updated body');
    });
  });

  // ============================================================
  // Auto-destruct (#629)
  // ============================================================

  describe('auto-destruct (#629)', () => {
    test('should set auto_destruct fields when sending with options', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Secret', 'Sensitive data', 'HIGH',
        ['secret'], undefined, undefined,
        { auto_destruct: true }
      );

      expect(msg.auto_destruct).toBe(true);
      expect(msg.destroyed_at).toBeUndefined();

      const saved = await messageManager.getMessage(msg.id);
      expect(saved!.auto_destruct).toBe(true);
    });

    test('should set expires_at from destruct_after TTL', async () => {
      const before = Date.now();
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'TTL', 'Expires soon', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after: '2h' }
      );

      expect(msg.expires_at).toBeDefined();
      const expiresMs = new Date(msg.expires_at!).getTime();
      // Should expire ~2h from now (within 5s tolerance)
      expect(expiresMs).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000 - 5000);
      expect(expiresMs).toBeLessThanOrEqual(before + 2 * 60 * 60 * 1000 + 5000);
    });

    test('should reject invalid destruct_after format', async () => {
      await expect(
        messageManager.sendMessage(
          'machine-a', 'machine2', 'Bad', 'Body', 'MEDIUM',
          undefined, undefined, undefined,
          { auto_destruct: true, destruct_after: 'invalid' }
        )
      ).rejects.toThrow('Invalid destruct_after format');
    });

    test('should set destruct_after_read_by list', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Multi-reader', 'Secret', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after_read_by: ['machine2', 'machine3'] }
      );

      expect(msg.destruct_after_read_by).toEqual(['machine2', 'machine3']);
    });

    test('should destroy message after recipient reads (simple auto-destruct)', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Secret', 'Top secret content', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true }
      );

      // Mark as read by recipient
      await messageManager.markAsRead(msg.id, 'machine2');

      // Message body should be destroyed
      const destroyed = await messageManager.getMessage(msg.id);
      expect(destroyed!.body).toBe('[DESTROYED]');
      expect(destroyed!.destroyed_at).toBeDefined();
      expect(destroyed!.destroyed_reason).toBe('read_by_recipient');
    });

    test('should NOT destroy before all required readers have read', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Multi', 'Secret for two', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after_read_by: ['machine2', 'machine3'] }
      );

      // Only machine2 reads
      await messageManager.markAsRead(msg.id, 'machine2');

      const afterFirst = await messageManager.getMessage(msg.id);
      expect(afterFirst!.body).toBe('Secret for two'); // NOT destroyed yet
      expect(afterFirst!.destroyed_at).toBeUndefined();
    });

    test('should destroy after ALL required readers have read', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Multi', 'Secret for two', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after_read_by: ['machine2', 'machine3'] }
      );

      await messageManager.markAsRead(msg.id, 'machine2');
      await messageManager.markAsRead(msg.id, 'machine3');

      const destroyed = await messageManager.getMessage(msg.id);
      expect(destroyed!.body).toBe('[DESTROYED]');
      expect(destroyed!.destroyed_reason).toBe('read_by_all');
    });

    test('should not destroy regular messages on read', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Normal', 'Not secret', 'MEDIUM'
      );

      await messageManager.markAsRead(msg.id, 'machine2');

      const read = await messageManager.getMessage(msg.id);
      expect(read!.body).toBe('Not secret'); // Body preserved
      expect(read!.destroyed_at).toBeUndefined();
    });

    test('destroyMessage should be idempotent', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Secret', 'Data', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true }
      );

      await messageManager.destroyMessage(msg.id, 'ttl_expired');
      await messageManager.destroyMessage(msg.id, 'ttl_expired'); // Second call

      const destroyed = await messageManager.getMessage(msg.id);
      expect(destroyed!.body).toBe('[DESTROYED]');
    });

    test('cleanupExpiredMessages should destroy TTL-expired messages', async () => {
      // Create a message with an already-expired TTL
      const msg = await messageManager.sendMessage(
        'machine-a', 'machine2', 'Expired', 'Old secret', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after: '1m' }
      );

      // Manually set expires_at to the past
      const filePath = join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`);
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      content.expires_at = new Date(Date.now() - 60000).toISOString();
      await fs.writeFile(filePath, JSON.stringify(content, null, 2));

      const count = await messageManager.cleanupExpiredMessages();
      expect(count).toBe(1);

      const destroyed = await messageManager.getMessage(msg.id);
      expect(destroyed!.body).toBe('[DESTROYED]');
      expect(destroyed!.destroyed_reason).toBe('ttl_expired');
    });

    test('cleanupExpiredMessages should not destroy non-expired messages', async () => {
      await messageManager.sendMessage(
        'machine-a', 'machine2', 'Future', 'Still valid', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after: '2h' }
      );

      const count = await messageManager.cleanupExpiredMessages();
      expect(count).toBe(0);
    });
  });

  // ============================================================
  // parseDuration (#629)
  // ============================================================

  describe('parseDuration (#629)', () => {
    test('should parse minutes', () => {
      expect(MessageManager.parseDuration('30m')).toBe(30 * 60 * 1000);
    });

    test('should parse hours', () => {
      expect(MessageManager.parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
    });

    test('should parse days', () => {
      expect(MessageManager.parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
    });

    test('should return null for invalid formats', () => {
      expect(MessageManager.parseDuration('invalid')).toBeNull();
      expect(MessageManager.parseDuration('30')).toBeNull();
      expect(MessageManager.parseDuration('m')).toBeNull();
      expect(MessageManager.parseDuration('')).toBeNull();
      expect(MessageManager.parseDuration('30s')).toBeNull();
    });
  });

  describe('sendExpiryReminders (#629)', () => {
    test('should send reminder when TTL is approaching', async () => {
      // Send message with 10-minute TTL
      const msg = await messageManager.sendMessage(
        'sender', 'recipient', 'Expiring secret', 'secret data',
        'HIGH', ['secret'], undefined, undefined,
        { auto_destruct: true, destruct_after: '10m' }
      );

      // Manually set expires_at to 3 minutes from now (within 10% threshold = 1min, but min 5min)
      // threshold = max(5min, 10min*10%) = max(5min, 1min) = 5min
      // So expires_at 3 minutes from now is within the 5min threshold
      const inboxFile = join(testSharedStatePath, 'messages', 'inbox', `${msg.id}.json`);
      const content = JSON.parse(await fs.readFile(inboxFile, 'utf-8'));
      content.expires_at = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // 3min from now
      await fs.writeFile(inboxFile, JSON.stringify(content, null, 2));

      const reminders = await messageManager.sendExpiryReminders();
      expect(reminders).toBe(1);

      // Verify reminder_sent flag was set
      const updated = JSON.parse(await fs.readFile(inboxFile, 'utf-8'));
      expect(updated.reminder_sent).toBe(true);

      // Verify a reminder message was sent
      const sentFiles = await fs.readdir(join(testSharedStatePath, 'messages', 'sent'));
      const reminderFiles = [];
      for (const f of sentFiles.filter(f => f.endsWith('.json'))) {
        const sentMsg = JSON.parse(await fs.readFile(join(testSharedStatePath, 'messages', 'sent', f), 'utf-8'));
        if (sentMsg.subject.includes('[REMINDER]')) {
          reminderFiles.push(sentMsg);
        }
      }
      expect(reminderFiles.length).toBe(1);
      expect(reminderFiles[0].from).toBe('system');
      expect(reminderFiles[0].to).toBe('recipient');
      expect(reminderFiles[0].priority).toBe('HIGH');
    });

    test('should NOT send reminder when TTL is far away', async () => {
      // Send message with 2-hour TTL (expires in 2h, threshold = max(5min, 12min) = 12min)
      await messageManager.sendMessage(
        'sender', 'recipient', 'Far away', 'secret data',
        'MEDIUM', [], undefined, undefined,
        { auto_destruct: true, destruct_after: '2h' }
      );
      // expires_at is 2h from now, well beyond 12min threshold

      const reminders = await messageManager.sendExpiryReminders();
      expect(reminders).toBe(0);
    });

    test('should NOT send reminder twice (idempotent)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'recipient', 'Expiring soon', 'data',
        'MEDIUM', [], undefined, undefined,
        { auto_destruct: true, destruct_after: '10m' }
      );

      // Set expires_at to 2 minutes from now (within 5min threshold)
      const inboxFile = join(testSharedStatePath, 'messages', 'inbox', `${msg.id}.json`);
      const content = JSON.parse(await fs.readFile(inboxFile, 'utf-8'));
      content.expires_at = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      await fs.writeFile(inboxFile, JSON.stringify(content, null, 2));

      // First call sends reminder
      const first = await messageManager.sendExpiryReminders();
      expect(first).toBe(1);

      // Second call should NOT send again
      const second = await messageManager.sendExpiryReminders();
      expect(second).toBe(0);
    });

    test('should NOT send reminder for already destroyed messages', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'recipient', 'Already dead', 'data',
        'MEDIUM', [], undefined, undefined,
        { auto_destruct: true, destruct_after: '10m' }
      );

      // Destroy the message first
      await messageManager.destroyMessage(msg.id, 'ttl_expired');

      const reminders = await messageManager.sendExpiryReminders();
      expect(reminders).toBe(0);
    });

    test('should NOT send reminder for messages without destruct_after', async () => {
      // auto_destruct without TTL (read-based only)
      await messageManager.sendMessage(
        'sender', 'recipient', 'Read-based only', 'data',
        'MEDIUM', [], undefined, undefined,
        { auto_destruct: true }
      );

      const reminders = await messageManager.sendExpiryReminders();
      expect(reminders).toBe(0);
    });
  });
});