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
import { MessageManagerErrorCode } from '../../types/errors.js';
import { AttachmentManager } from '../roosync/AttachmentManager.js';
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

    // po-204 : une clé dashée de projet Claude (ex. "c--dev-roo-extensions" pour
    // C:\dev\roo-extensions) ne matche jamais le basename auto-détecté côté
    // destinataire — le message serait listé dans son inbox mais illisible en
    // getMessage/mark_read. Le send doit le rejeter à la source.
    test('should reject dashed Claude-projects workspace key in recipient (po-204)', async () => {
      await expect(
        messageManager.sendMessage(
          'myia-po-204',
          'myia-po-2024:c--dev-roo-extensions',
          'Dashed',
          'Phantom recipient'
        )
      ).rejects.toMatchObject({
        code: MessageManagerErrorCode.INVALID_RECIPIENT,
        details: { type: 'dashed-workspace-key' }
      });
    });

    test('should allow machine-only and basename recipients (po-204 convention)', async () => {
      await expect(
        messageManager.sendMessage('myia-po-204', 'myia-po-2024', 'Conv', 'Machine only')
      ).resolves.toMatchObject({ to: 'myia-po-2024' });
      await expect(
        messageManager.sendMessage('myia-po-204', 'myia-po-2024:roo-extensions', 'Conv', 'Basename')
      ).resolves.toMatchObject({ to: 'myia-po-2024:roo-extensions' });
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

    /**
     * Attachment purge on destruction.
     *
     * These pin the DEFECT, not the happy path: before the fix, destruction wiped
     * `body` and left the attachment blob in clear on the shared store. Since the
     * attachment is the channel mandated for secrets (value never in the indexed
     * body), the only payload that had to disappear was the one that never did.
     * A test that merely asserted `body === '[DESTROYED]'` passed throughout and
     * guarded nothing — which is why the defect survived this suite.
     */
    describe('attachment purge (destroyMessage)', () => {
      /** Uploads a real attachment and links it to `messageId`. Returns its uuid. */
      async function attachTo(messageId: string, contents: string): Promise<string> {
        const src = join(testSharedStatePath, `payload-${messageId}.env`);
        await fs.writeFile(src, contents, 'utf-8');

        const am = new AttachmentManager(testSharedStatePath);
        const ref = await am.uploadAttachment(src, 'machine-a', 'secret.env', messageId);

        // Link the ref onto the stored message, as the send path does.
        const filePath = join(testSharedStatePath, 'messages/inbox', `${messageId}.json`);
        const stored = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        stored.attachments = [{ uuid: ref.uuid, filename: 'secret.env', sizeBytes: contents.length }];
        await fs.writeFile(filePath, JSON.stringify(stored, null, 2), 'utf-8');

        return ref.uuid;
      }

      const blobDir = (uuid: string) => join(testSharedStatePath, 'attachments', uuid);

      test('destroyMessage removes the attachment blob, not just the body', async () => {
        const msg = await messageManager.sendMessage(
          'machine-a', 'machine2', 'Secret', 'value is in the attachment', 'HIGH',
          undefined, undefined, undefined,
          { auto_destruct: true }
        );
        const uuid = await attachTo(msg.id, 'API_KEY=sk-should-not-survive');
        expect(existsSync(blobDir(uuid))).toBe(true); // precondition

        const ok = await messageManager.destroyMessage(msg.id, 'ttl_expired');

        expect(ok).toBe(true);
        expect(existsSync(blobDir(uuid))).toBe(false); // ← failed before the fix
        expect((await messageManager.getMessage(msg.id))!.body).toBe('[DESTROYED]');
      });

      test('TTL expiry purges attachments (the path secrets actually travel)', async () => {
        const msg = await messageManager.sendMessage(
          'machine-a', 'machine2', 'Rotated key', 'see attachment', 'HIGH',
          undefined, undefined, undefined,
          { auto_destruct: true, destruct_after: '1m' }
        );
        const uuid = await attachTo(msg.id, 'QDRANT_API_KEY=should-not-survive-ttl');

        const filePath = join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`);
        const stored = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        stored.expires_at = new Date(Date.now() - 60_000).toISOString();
        await fs.writeFile(filePath, JSON.stringify(stored, null, 2), 'utf-8');

        expect(await messageManager.cleanupExpiredMessages()).toBe(1);
        expect(existsSync(blobDir(uuid))).toBe(false); // ← failed before the fix
      });

      test('a failed purge leaves the message un-stamped so cleanup retries it', async () => {
        const msg = await messageManager.sendMessage(
          'machine-a', 'machine2', 'Secret', 'body', 'HIGH',
          undefined, undefined, undefined,
          { auto_destruct: true }
        );
        await attachTo(msg.id, 'API_KEY=locked');

        messageManager.setAttachmentManager({
          getAttachmentMetadata: async () => ({ uuid: 'x' }),
          deleteAttachment: async () => { throw new Error('EBUSY: file locked'); },
        } as unknown as AttachmentManager);

        // Reporting success here would rebuild the very defect one layer up:
        // a "destroyed" message whose secret is still on disk.
        expect(await messageManager.destroyMessage(msg.id, 'ttl_expired')).toBe(false);

        const after = await messageManager.getMessage(msg.id);
        expect(after!.destroyed_at).toBeUndefined();
        expect(after!.destroyed_reason).toBeUndefined();
      });

      test('an already-absent attachment is success, not an endless retry', async () => {
        const msg = await messageManager.sendMessage(
          'machine-a', 'machine2', 'Secret', 'body', 'HIGH',
          undefined, undefined, undefined,
          { auto_destruct: true }
        );
        const uuid = await attachTo(msg.id, 'API_KEY=already-gone');

        // Another machine removed it first.
        await new AttachmentManager(testSharedStatePath).deleteAttachment(uuid);

        expect(await messageManager.destroyMessage(msg.id, 'ttl_expired')).toBe(true);
        expect((await messageManager.getMessage(msg.id))!.destroyed_at).toBeDefined();
      });
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

  describe('startAutoArchiveDaemon (#809)', () => {
    afterEach(() => {
      messageManager.stopAutoArchiveDaemon();
    });

    test('should start daemon and store timer reference', () => {
      messageManager.startAutoArchiveDaemon(30, 6);
      // Daemon stores its timer internally — calling stop should clear it
      messageManager.stopAutoArchiveDaemon();
      // Restart should succeed (timer was cleared)
      messageManager.startAutoArchiveDaemon(30, 6);
    });

    test('should be idempotent — duplicate start is noop', () => {
      messageManager.startAutoArchiveDaemon(30, 6);
      // Second call should not throw and not create a second timer
      messageManager.startAutoArchiveDaemon(30, 6);
      // Stop once should fully clean up
      messageManager.stopAutoArchiveDaemon();
    });

    test('stopAutoArchiveDaemon is safe to call when not running', () => {
      // Calling stop without start should not throw
      expect(() => messageManager.stopAutoArchiveDaemon()).not.toThrow();
    });

    test('should not block the event loop (timers are unref-able)', () => {
      messageManager.startAutoArchiveDaemon(30, 6);
      // The daemon starts a setTimeout (initial run) + setInterval (periodic).
      // We can't verify they're unref'd without process inspection, but we can
      // verify they don't fire synchronously and don't crash on stop.
      messageManager.stopAutoArchiveDaemon();
    });
  });

  describe('autoArchiveOld — abandoned unread lane (#3150)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * Writes a message straight into inbox/ with a controlled age. sendMessage()
     * always stamps "now", and the whole point here is what happens to old mail.
     */
    const seedInboxMessage = async (
      id: string,
      ageDays: number,
      status: 'unread' | 'read'
    ): Promise<void> => {
      const message = {
        id,
        from: 'myia-po-2025:roo-extensions',
        to: 'myia-po-2026:roo-extensions',
        subject: `seeded ${id}`,
        body: 'body',
        priority: 'MEDIUM',
        timestamp: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
        status,
        tags: []
      };
      await fs.writeFile(
        join(testSharedStatePath, 'messages/inbox', `${id}.json`),
        JSON.stringify(message, null, 2),
        'utf-8'
      );
    };

    const inInbox = (id: string) =>
      existsSync(join(testSharedStatePath, 'messages/inbox', `${id}.json`));
    const inArchive = (id: string) =>
      existsSync(join(testSharedStatePath, 'messages/archive', `${id}.json`));

    test('archives an unread message past the abandoned horizon', async () => {
      // inbox/ is shared fleet-wide: mail addressed to another machine stays
      // unread forever, because no machine can mark someone else's mail read.
      await seedInboxMessage('msg-abandoned', 120, 'unread');

      const archived = await messageManager.autoArchiveOld(30, true, 90);

      expect(archived).toBe(1);
      expect(inInbox('msg-abandoned')).toBe(false);
      expect(inArchive('msg-abandoned')).toBe(true);
    });

    test('archiving moves the message — it stays readable, nothing is deleted', async () => {
      await seedInboxMessage('msg-preserved', 120, 'unread');

      await messageManager.autoArchiveOld(30, true, 90);

      const recovered = await messageManager.getMessage('msg-preserved');
      expect(recovered).not.toBeNull();
      expect(recovered!.body).toBe('body');
      expect(recovered!.status).toBe('archived');
    });

    test('spares an unread message that has not reached the abandoned horizon', async () => {
      // 45 days is past the read threshold but well short of the unread one:
      // a peer machine may still be catching up on its mail.
      await seedInboxMessage('msg-recent-unread', 45, 'unread');

      const archived = await messageManager.autoArchiveOld(30, true, 90);

      expect(archived).toBe(0);
      expect(inInbox('msg-recent-unread')).toBe(true);
    });

    test('unreadMaxAgeDays=0 restores the pre-#3150 behaviour', async () => {
      // Pins that the new lane is what does the work: with it disabled, the very
      // same 120-day-old unread message is left untouched, exactly as before.
      await seedInboxMessage('msg-lane-off', 120, 'unread');

      const archived = await messageManager.autoArchiveOld(30, true, 0);

      expect(archived).toBe(0);
      expect(inInbox('msg-lane-off')).toBe(true);
    });

    test('still archives read messages on the original threshold', async () => {
      await seedInboxMessage('msg-old-read', 45, 'read');

      const archived = await messageManager.autoArchiveOld(30, true, 90);

      expect(archived).toBe(1);
      expect(inArchive('msg-old-read')).toBe(true);
    });

    test('leaves messages younger than the read threshold alone', async () => {
      await seedInboxMessage('msg-fresh', 5, 'read');

      const archived = await messageManager.autoArchiveOld(30, true, 90);

      expect(archived).toBe(0);
      expect(inInbox('msg-fresh')).toBe(true);
    });
  });

  describe('getAutoArchiveStatus (#3292 — rotation observability)', () => {
    test('before any start: not running, no config, no last run', () => {
      const status = messageManager.getAutoArchiveStatus();
      expect(status.running).toBe(false);
      expect(status.config).toBeNull();
      expect(status.lastRun).toBeNull();
    });

    test('start records the config; stop keeps config + last run for post-mortem', () => {
      messageManager.startAutoArchiveDaemon(30, 6, 90);
      let status = messageManager.getAutoArchiveStatus();
      expect(status.running).toBe(true);
      expect(status.config).toEqual({ maxAgeDays: 30, intervalHours: 6, unreadMaxAgeDays: 90 });

      messageManager.stopAutoArchiveDaemon();
      status = messageManager.getAutoArchiveStatus();
      // running:false WITH a config says "was started, then stopped" — not "never ran"
      expect(status.running).toBe(false);
      expect(status.config).toEqual({ maxAgeDays: 30, intervalHours: 6, unreadMaxAgeDays: 90 });
    });
  });

  describe('getInboxPoolAges (#3292 — shared-pool age histogram)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Drops a file with a controlled timestamp-encoded name straight into inbox/. */
    const seedNamed = async (daysAgo: number, label: string): Promise<void> => {
      const d = new Date(Date.now() - daysAgo * DAY_MS);
      const stamp = d.toISOString().replace(/[-:]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
      await fs.writeFile(
        join(testSharedStatePath, 'messages/inbox', `msg-${stamp}-${label}.json`),
        '{}',
        'utf-8'
      );
    };

    test('buckets by age from filenames, no file parse', async () => {
      await seedNamed(1, 'fresh');       // 0-7
      await seedNamed(15, 'mid');        // 7-30
      await seedNamed(45, 'dead');       // 30-90
      await seedNamed(120, 'ancient');   // >90
      // Non-timestamp id + non-JSON entry: undated / ignored respectively
      await fs.writeFile(join(testSharedStatePath, 'messages/inbox', 'msg-legacy-id.json'), '{}', 'utf-8');
      await fs.writeFile(join(testSharedStatePath, 'messages/inbox', 'desktop.ini'), '[Shell]', 'utf-8');

      const pool = await messageManager.getInboxPoolAges();

      expect(pool).toEqual({
        total: 5,        // 4 dated + 1 undated (desktop.ini excluded)
        d0_7: 1,
        d7_30: 1,
        d30_90: 1,
        d90_plus: 1,
        undated: 1
      });
    });

    test('empty/absent inbox returns zeroed buckets', async () => {
      rmSync(join(testSharedStatePath, 'messages/inbox'), { recursive: true, force: true });
      const pool = await messageManager.getInboxPoolAges();
      expect(pool).toEqual({ total: 0, d0_7: 0, d7_30: 0, d30_90: 0, d90_plus: 0, undated: 0 });
    });
  });

  describe('workspace filtering (#2287)', () => {
    test('getMessage: allows reading messages targeted to caller machine', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Test', 'Body', 'MEDIUM'
      );
      const result = await messageManager.getMessage(msg.id, 'machine-a');
      expect(result).not.toBeNull();
      expect(result!.body).toBe('Body');
    });

    test('getMessage: allows reading messages targeted to caller machine:workspace', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Test', 'Body', 'MEDIUM'
      );
      const result = await messageManager.getMessage(msg.id, 'machine-a:ws-1');
      expect(result).not.toBeNull();
    });

    test('getMessage: blocks reading messages targeted to different workspace', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Secret', 'Private body', 'HIGH'
      );
      // Same machine, different workspace — denied now THROWS (po-204): a null
      // used to render as "Message introuvable" in every tool, lying about a
      // message that exists and is simply addressed elsewhere.
      await expect(messageManager.getMessage(msg.id, 'machine-a:ws-2'))
        .rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });
    });

    test('getMessage: denied error names the actual recipient, not "introuvable" (po-204)', async () => {
      const msg = await messageManager.sendMessage(
        'myia-po-204', 'myia-po-2024', 'Pépites', 'Body'
      );
      // The dashed key is rejected at send since po-204 — drop the message file
      // directly to simulate the pre-fix phantom still living in GDrive.
      const phantom = {
        ...msg,
        id: 'msg-phantom-po204',
        to: 'myia-po-2024:c--dev-roo-extensions'
      };
      await fs.writeFile(
        join(testSharedStatePath, 'messages/inbox/msg-phantom-po204.json'),
        JSON.stringify(phantom), 'utf-8'
      );
      const callerId = 'myia-po-2024:roo-extensions';
      const err = await messageManager.getMessage('msg-phantom-po204', callerId)
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(MessageManagerErrorCode.ACCESS_DENIED);
      expect(err.message).toContain('c--dev-roo-extensions');
      expect(err.message).toContain(callerId);
      expect(err.message).toContain('basename');
    });

    test('getMessage: allows reading messages targeted to same machine (no workspace)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Test', 'Body', 'MEDIUM'
      );
      // Caller with workspace, message targets whole machine → allowed
      const result = await messageManager.getMessage(msg.id, 'machine-a:ws-1');
      expect(result).not.toBeNull();
    });

    test('getMessage: allows reading own sent messages', async () => {
      const msg = await messageManager.sendMessage(
        'machine-a', 'other-machine', 'Sent msg', 'Content', 'MEDIUM'
      );
      // Sender reads their own sent message — should be allowed
      const result = await messageManager.getMessage(msg.id, 'machine-a');
      expect(result).not.toBeNull();
      expect(result!.body).toBe('Content');
    });

    test('getMessage: blocks reading messages from different machine', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Test', 'Private', 'HIGH'
      );
      await expect(messageManager.getMessage(msg.id, 'machine-b'))
        .rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });
    });

    test('getMessage: without callerId skips workspace check (backward compat)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Test', 'Body', 'MEDIUM'
      );
      // No callerId → backward compat, no workspace check
      const result = await messageManager.getMessage(msg.id);
      expect(result).not.toBeNull();
    });

    test('markAsRead: blocks marking read for different workspace', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Test', 'Body', 'MEDIUM'
      );
      // Different workspace on same machine
      const result = await messageManager.markAsRead(msg.id, 'machine-a:ws-2');
      expect(result).toBe(false);
    });

    test('markAsRead: allows marking read for correct workspace', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Test', 'Body', 'MEDIUM'
      );
      const result = await messageManager.markAsRead(msg.id, 'machine-a:ws-1');
      expect(result).toBe(true);
    });

    test('markAsRead: allows marking read for machine-wide messages', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Test', 'Body', 'MEDIUM'
      );
      const result = await messageManager.markAsRead(msg.id, 'machine-a:ws-1');
      expect(result).toBe(true);
    });

    test('markAsRead: allows authorized reader from destruct_after_read_by', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Multi', 'Secret', 'HIGH',
        undefined, undefined, undefined,
        { auto_destruct: true, destruct_after_read_by: ['machine-a', 'machine-b'] }
      );
      // machine-b is in destruct_after_read_by but not the primary recipient
      const result = await messageManager.markAsRead(msg.id, 'machine-b');
      expect(result).toBe(true);
    });

    test('markAsRead: blocks unauthorized reader from different machine', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Test', 'Body', 'MEDIUM'
      );
      const result = await messageManager.markAsRead(msg.id, 'machine-c');
      expect(result).toBe(false);
    });
  });

  describe('bulkOperation (#2730 — bulk mark_read workspace regression)', () => {
    test('bulk mark_read succeeds on messages targeting a specific workspace', async () => {
      // Bug #2730: bulkOperation forwarded machineId (no workspace) to markAsRead,
      // so the #2287 access-control guard rejected any message whose `to` targeted a
      // specific workspace (matchesRecipient returns false when localWorkspaceId is
      // undefined). The unitary mark_read path passed getLocalFullId() and succeeded
      // on the same message — bulk silently logged "mark_read returned false".
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a:ws-1', 'Bulk target', 'Body', 'MEDIUM'
      );
      // bulkOperationHandler passes getLocalMachineId() + effective workspace.
      const result = await messageManager.bulkOperation(
        'machine-a', 'mark_read', { status: 'unread' }, 'ws-1'
      );
      expect(result.matched).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.failed_ids).toHaveLength(0);
      // Confirm the message is actually mutated to read.
      const after = await messageManager.getMessage(msg.id, 'machine-a:ws-1');
      expect(after!.status === 'read' || after!.read_by?.includes('machine-a')).toBe(true);
    });

    test('bulk mark_read still succeeds on machine-wide messages (no workspace)', async () => {
      // Regression guard: messages targeting the whole machine must still work.
      await messageManager.sendMessage(
        'sender', 'machine-a', 'Machine-wide', 'Body', 'MEDIUM'
      );
      const result = await messageManager.bulkOperation(
        'machine-a', 'mark_read', { status: 'unread' }, 'ws-1'
      );
      expect(result.processed).toBe(1);
      expect(result.failed_ids).toHaveLength(0);
    });

    test('bulk mark_read still succeeds on broadcast messages', async () => {
      // Regression guard: broadcasts (to: "all") were never affected.
      await messageManager.sendMessage(
        'sender', 'all', 'Broadcast', 'Body', 'MEDIUM'
      );
      const result = await messageManager.bulkOperation(
        'machine-a', 'mark_read', { status: 'unread' }, 'ws-1'
      );
      expect(result.processed).toBe(1);
      expect(result.failed_ids).toHaveLength(0);
    });
  });

  describe('phantom message fix (#2307 Phase 4)', () => {
    test('markAsRead returns true when message already archived (idempotent)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Phantom Test', 'Body', 'LOW'
      );

      // Manually move message to archive (simulating auto-archive)
      const inboxFile = join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`);
      const archiveFile = join(testSharedStatePath, 'messages/archive', `${msg.id}.json`);
      const content = await fs.readFile(inboxFile, 'utf-8');
      const message = JSON.parse(content);
      message.status = 'archived';
      await fs.writeFile(archiveFile, JSON.stringify(message, null, 2), 'utf-8');
      await fs.unlink(inboxFile);

      // markAsRead should return true (idempotent — already processed)
      const result = await messageManager.markAsRead(msg.id, 'machine-a');
      expect(result).toBe(true);
    });

    test('markAsRead returns false when message truly does not exist', async () => {
      const result = await messageManager.markAsRead('msg-nonexistent-123456', 'machine-a');
      expect(result).toBe(false);
    });

    test('archiveMessage returns true when message already archived (idempotent)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Archive Idempotent', 'Body', 'LOW'
      );

      // Archive it first
      const firstArchive = await messageManager.archiveMessage(msg.id);
      expect(firstArchive).toBe(true);

      // Archive again — should return true (idempotent)
      const secondArchive = await messageManager.archiveMessage(msg.id);
      expect(secondArchive).toBe(true);
    });

    test('archiveMessage returns false when message truly does not exist', async () => {
      const result = await messageManager.archiveMessage('msg-nonexistent-789012');
      expect(result).toBe(false);
    });

    test('getMessage returns cached copy as archived when stale entry detected (#2307 Phase 4)', async () => {
      const msg = await messageManager.sendMessage(
        'sender', 'machine-a', 'Cache Invalidation', 'Body', 'MEDIUM'
      );

      // Force cache build by reading inbox
      await messageManager.readInbox('machine-a');

      // Manually delete BOTH inbox and sent files (simulating auto-archive race)
      const inboxFile = join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`);
      const sentFile = join(testSharedStatePath, 'messages/sent', `${msg.id}.json`);
      await fs.unlink(inboxFile);
      if (existsSync(sentFile)) await fs.unlink(sentFile);

      // getMessage should return cached copy with archived status (not null)
      // so callers can handle it as "already processed" instead of "introuvable"
      const result = await messageManager.getMessage(msg.id, 'machine-a');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('archived');

      // Subsequent inbox read should not list the deleted message (cache was invalidated)
      const inbox = await messageManager.readInbox('machine-a');
      expect(inbox.find(m => m.id === msg.id)).toBeUndefined();
    });

    test('inbox file whose name differs from its internal id is NOT listed (anti-phantom)', async () => {
      // Regression for the long-standing "message fantôme" bug: a file whose on-disk
      // name does not match its internal `id` was LISTED forever (ensureInboxCache keys
      // by `message.id`) yet could never be opened, marked read, or archived — every
      // mutation reconstructs `inbox/${id}.json`, which does not exist. Real-world
      // offender: a legacy `roosync-report.json` carrying id `msg-...-po2026-status`.
      const phantomId = 'msg-20260226T080000-po2026-status';
      const phantom = {
        id: phantomId,
        from: 'machine-b',
        to: 'machine-a',
        subject: '[STATUS] Legacy seed report',
        body: 'Stale status report whose filename does not match its id.',
        priority: 'LOW',
        timestamp: '2026-02-26T08:00:00.000Z',
        status: 'unread',
        tags: ['status']
      };
      // Write with a NON-canonical filename (name !== `${id}.json`).
      const mismatchedFile = join(testSharedStatePath, 'messages/inbox', 'legacy-report.json');
      await fs.writeFile(mismatchedFile, JSON.stringify(phantom, null, 2), 'utf-8');

      // File was written outside the manager → force a cache rebuild.
      messageManager.invalidateCache();

      // The mis-named file must be skipped from the listing (guarded in ensureInboxCache).
      const inbox = await messageManager.readInbox('machine-a', 'all');
      expect(inbox.find(m => m.id === phantomId)).toBeUndefined();

      // And it must not inflate the unread count.
      const counts = await messageManager.getFilteredCount('machine-a', 'all');
      expect(counts.total).toBe(0);
    });
  });

  // ─── Coverage: cache/path + broadcast-filter + send-error clusters (#833 deep-queue, c.35) ───
  // Targets uncovered lines (firsthand scoped coverage 77.27%S): L305-306, L323-327, L528-530,
  // L625-628. Explicitly AVOIDS the attachment/timeout path (L1413-1566) behind #818/#2823.
  describe('coverage — cache TTL + missing-path + broadcast filter + send-error (#833 c.35)', () => {
    test('readInbox returns empty list when inboxPath does not exist (L305-306)', async () => {
      // Remove the inbox dir after construction so ensureInboxCache hits the missing-path branch.
      const inboxDir = join(testSharedStatePath, 'messages', 'inbox');
      rmSync(inboxDir, { recursive: true, force: true });
      expect(existsSync(inboxDir)).toBe(false);

      messageManager.invalidateCache();
      const inbox = await messageManager.readInbox('machine-a', 'all');
      expect(inbox).toEqual([]);
    });

    test('ensureInboxCache refreshes TTL when file count unchanged after TTL expiry (L323-327)', async () => {
      // First readInbox builds the cache from disk (lastInboxFileCount=1, cacheBuiltAt=now).
      await messageManager.sendMessage('machine-x', 'machine-a', 'build', 'body');
      const first = await messageManager.readInbox('machine-a', 'all');
      expect(first).toHaveLength(1);
      expect((messageManager as any).inboxCache).not.toBeNull();

      // Force TTL expiry while keeping the populated cache + stable file count, so the next
      // readInbox skips the fast-path (TTL expired) but hits the count-unchanged refresh branch.
      (messageManager as any).cacheBuiltAt = 0;

      const second = await messageManager.readInbox('machine-a', 'all');
      expect(second).toHaveLength(1);
      // TTL was refreshed (cacheBuiltAt reset to a fresh timestamp > 0).
      expect((messageManager as any).cacheBuiltAt).toBeGreaterThan(0);
    });

    test('readInbox broadcast status filter excludes read broadcasts per-machine (#629 L625-628)', async () => {
      // Broadcast message to 'all', then markAsRead by machine-a → read_by populated.
      const broadcast = await messageManager.sendMessage('machine-x', 'all', 'broadcast', 'hi all');
      expect(broadcast.to).toBe('all');

      const marked = await messageManager.markAsRead(broadcast.id, 'machine-a');
      expect(marked).toBe(true);

      messageManager.invalidateCache();
      // status='unread' → machine-a has read it → excluded.
      const unread = await messageManager.readInbox('machine-a', 'unread');
      expect(unread.find(m => m.id === broadcast.id)).toBeUndefined();
      // status='read' → machine-a has read it → included.
      const read = await messageManager.readInbox('machine-a', 'read');
      expect(read.find(m => m.id === broadcast.id)).toBeDefined();
      // A machine that has NOT read it still sees it as unread.
      const unreadOther = await messageManager.readInbox('machine-b', 'unread');
      expect(unreadOther.find(m => m.id === broadcast.id)).toBeDefined();
    });

    test('sendMessage catch wraps + rethrows when the inbox write fails (L528-530)', async () => {
      // Spy on fs.writeFile (same `promises` binding MessageManager uses) to reject once,
      // forcing the sendMessage try/catch error path.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(
        messageManager.sendMessage('machine-x', 'machine-a', 'fail', 'body')
      ).rejects.toThrow('disk full');

      expect(writeSpy).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });

  // ─── #3292: cold-start recent slice + background hydration + deep opt-out ───
  // Files are written directly (controlled ids/timestamps, filename === `${id}.json`)
  // because 150 real sendMessage calls share the same wall-clock second, making
  // "most recent" ill-defined for the lexical filename sort the slice relies on.
  describe('cold-start recent slice (#3292)', () => {
    const TOTAL = 150;
    const idFor = (i: number) => {
      const mm = String(Math.floor(i / 60)).padStart(2, '0');
      const ss = String(i % 60).padStart(2, '0');
      return `msg-20260828T00${mm}${ss}-${String(i).padStart(6, '0')}`;
    };
    const tsFor = (i: number) => `2026-08-28T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;

    const seedBigPool = async () => {
      for (let i = 0; i < TOTAL; i++) {
        const msg = {
          id: idFor(i),
          from: 'machine-b',
          to: 'machine-a',
          subject: `Pool message ${i}`,
          body: `Body ${i}`,
          priority: 'LOW',
          timestamp: tsFor(i),
          status: 'unread'
        };
        await fs.writeFile(
          join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`),
          JSON.stringify(msg, null, 2),
          'utf-8'
        );
      }
    };

    test('cold start on a big pool serves the recent slice, flagged partial', async () => {
      await seedBigPool();

      const items = await messageManager.readInbox('machine-a', 'all');

      // Assertions in ONE synchronous block: the background hydration started by
      // the slice install progresses on later macrotask ticks — no awaits until
      // both the captured list and the partial flag are checked.
      expect(items).toHaveLength(100);
      expect(items.find(m => m.id === idFor(TOTAL - 1))).toBeDefined();
      expect(items.find(m => m.id === idFor(99))).toBeDefined();
      expect(items.find(m => m.id === idFor(50))).toBeDefined();
      expect(items.find(m => m.id === idFor(49))).toBeUndefined();
      expect(items.find(m => m.id === idFor(0))).toBeUndefined();
      expect(messageManager.isInboxCachePartial()).toBe(true);
    });

    test('deep:true joins the in-flight hydration and returns the full pool (not the slice)', async () => {
      await seedBigPool();

      // Cold start → slice.
      const slice = await messageManager.readInbox('machine-a', 'all');
      expect(slice).toHaveLength(100);

      // deep within the slice TTL must NOT hit the TTL fast path (which would
      // hand back the slice): it rejoins the in-flight rebuild, awaits it, and
      // returns everything.
      const deep = await messageManager.readInbox('machine-a', 'all', undefined, undefined, undefined, undefined, true);
      expect(deep).toHaveLength(TOTAL);
      expect(deep.find(m => m.id === idFor(0))).toBeDefined();
      expect(messageManager.isInboxCachePartial()).toBe(false);

      // Counts now derive from the completed pool, consistent with the deep listing.
      const counts = await messageManager.getFilteredCount('machine-a', 'all');
      expect(counts.total).toBe(TOTAL);
    });

    test('deep:true on a COLD cache parses the full pool directly (no slice detour)', async () => {
      await seedBigPool();

      const deep = await messageManager.readInbox('machine-a', 'all', undefined, undefined, undefined, undefined, true);
      expect(deep).toHaveLength(TOTAL);
      expect(messageManager.isInboxCachePartial()).toBe(false);
    });

    test('pools at or under the slice size keep the exact pre-#3292 behavior', async () => {
      for (let i = 0; i < 50; i++) {
        const msg = {
          id: idFor(i),
          from: 'machine-b',
          to: 'machine-a',
          subject: `Small pool ${i}`,
          body: `Body ${i}`,
          priority: 'LOW',
          timestamp: tsFor(i),
          status: 'unread'
        };
        await fs.writeFile(
          join(testSharedStatePath, 'messages/inbox', `${msg.id}.json`),
          JSON.stringify(msg, null, 2),
          'utf-8'
        );
      }

      const items = await messageManager.readInbox('machine-a', 'all');
      expect(items).toHaveLength(50);
      expect(messageManager.isInboxCachePartial()).toBe(false);

      const counts = await messageManager.getFilteredCount('machine-a', 'all');
      expect(counts.total).toBe(50);
    });
  });
});