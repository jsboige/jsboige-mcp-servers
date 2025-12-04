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
import { join } from 'path';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';

// État global pour les mocks
let mockFiles: Map<string, string>;
let mockDirs: Set<string>;

// Mock fs module avec des implémentations qui utilisent l'état global
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    return mockDirs.has(path) || mockFiles.has(path);
  }),
  mkdirSync: vi.fn((path: string, options?: any) => {
    if (options?.recursive) {
      const parts = path.split('/');
      let currentPath = '';
      for (const part of parts) {
        if (part) {
          currentPath += '/' + part;
          mockDirs.add(currentPath);
        }
      }
    } else {
      mockDirs.add(path);
    }
    return undefined;
  }),
  readFileSync: vi.fn((path: string, encoding?: string) => {
    if (mockFiles.has(path)) {
      return mockFiles.get(path)!;
    }
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    mockFiles.set(path, content);
    return undefined;
  }),
  rmSync: vi.fn((path: string, options?: any) => {
    if (options?.recursive) {
      // Supprimer récursivement
      for (const [filePath] of mockFiles) {
        if (filePath.startsWith(path)) {
          mockFiles.delete(filePath);
        }
      }
      for (const dirPath of mockDirs) {
        if (dirPath.startsWith(path)) {
          mockDirs.delete(dirPath);
        }
      }
    } else {
      mockFiles.delete(path);
      mockDirs.delete(path);
    }
    return undefined;
  }),
  readdirSync: vi.fn((path: string) => {
    const files: string[] = [];
    for (const [filePath] of mockFiles) {
      if (filePath.startsWith(path) && filePath !== path) {
        const relativePath = filePath.substring(path.length + 1);
        const firstPart = relativePath.split(/[/\\]/)[0];
        if (firstPart && !files.includes(firstPart)) {
          files.push(firstPart);
        }
      }
    }
    return files;
  }),
  unlinkSync: vi.fn((path: string) => {
    if (!mockFiles.has(path)) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    mockFiles.delete(path);
    return undefined;
  }),
  promises: {
    writeFile: vi.fn(async (path: string, content: string) => {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (!mockDirs.has(dir)) {
        mockDirs.add(dir);
      }
      mockFiles.set(path, content);
    }),
    readFile: vi.fn(async (path: string, encoding?: string) => {
      if (mockFiles.has(path)) {
        return mockFiles.get(path)!;
      }
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }),
    readdir: vi.fn(async (path: string) => {
      if (!mockDirs.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      const files: string[] = [];
      for (const [filePath] of mockFiles) {
        if (filePath.startsWith(path) && filePath !== path) {
          const relativePath = filePath.substring(path.length + 1);
          const firstPart = relativePath.split(/[/\\]/)[0];
          if (firstPart && !files.includes(firstPart)) {
            files.push(firstPart);
          }
        }
      }
      return files;
    }),
    unlink: vi.fn(async (path: string) => {
      if (!mockFiles.has(path)) {
        throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      }
      mockFiles.delete(path);
    }),
    mkdir: vi.fn(async (path: string, options?: any) => {
      if (options?.recursive) {
        const parts = path.split('/');
        let currentPath = '';
        for (const part of parts) {
          if (part) {
            currentPath += '/' + part;
            mockDirs.add(currentPath);
          }
        }
      } else {
        mockDirs.add(path);
      }
    }),
  },
}));

// Mock path module
vi.mock('path', () => ({
  join: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
  basename: vi.fn((path: string) => {
    return path.split('/').pop() || '';
  }),
  dirname: vi.fn((path: string) => {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '/';
  }),
  extname: vi.fn((path: string) => {
    const parts = path.split('.');
    return parts.length > 1 ? '.' + parts.pop() : '';
  }),
  resolve: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
}));

describe('MessageManager', () => {
  let messageManager: MessageManager;
  let testSharedStatePath: string;

  beforeEach(() => {
    // Initialize in-memory state
    mockFiles = new Map<string, string>();
    mockDirs = new Set<string>();
    
    testSharedStatePath = '/tmp/test-shared-state';
    
    // Initialize directories
    mockDirs.add(testSharedStatePath);
    mockDirs.add(`${testSharedStatePath}/messages`);
    mockDirs.add(`${testSharedStatePath}/messages/inbox`);
    mockDirs.add(`${testSharedStatePath}/messages/sent`);
    mockDirs.add(`${testSharedStatePath}/messages/archive`);
    
    // Create MessageManager instance
    messageManager = new MessageManager(testSharedStatePath);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
        'Test Subject',
        'Test body content'
      );

      expect(message.priority).toBe('MEDIUM');
    });

    test('should handle optional fields (tags, thread_id, reply_to)', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test Subject',
        'Test body content',
        'MEDIUM',
        ['tag1', 'tag2'],
        'thread-123',
        'reply-456'
      );

      expect(message.tags).toEqual(['tag1', 'tag2']);
      expect(message.thread_id).toBe('thread-123');
      expect(message.reply_to).toBe('reply-456');
    });

    test('should save message to both inbox and sent folders', async () => {
      const message = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Test Subject',
        'Test body content'
      );

      // Vérifier que le message est sauvegardé dans les deux dossiers
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
      const sentPath = join(testSharedStatePath, 'messages/sent', `${message.id}.json`);
      
      expect(mockFiles.has(inboxPath)).toBe(true);
      expect(mockFiles.has(sentPath)).toBe(true);
    });

    test('should generate unique message IDs', async () => {
      const message1 = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Subject 1',
        'Body 1'
      );
      const message2 = await messageManager.sendMessage(
        'machine1',
        'machine2',
        'Subject 2',
        'Body 2'
      );

      expect(message1.id).not.toBe(message2.id);
    });
  });

  describe('readInbox', () => {
    beforeEach(async () => {
      // Créer quelques messages de test
      await messageManager.sendMessage('sender1', 'machine1', 'Subject 1', 'Body 1');
      await messageManager.sendMessage('sender2', 'machine1', 'Subject 2', 'Body 2');
      await messageManager.sendMessage('sender3', 'machine2', 'Subject 3', 'Body 3'); // Pour autre destinataire
    });

    test('should return only messages for specified recipient', async () => {
      const messages = await messageManager.readInbox('machine1');
      
      expect(messages).toHaveLength(2);
      expect(messages.every(msg => msg.to === 'machine1')).toBe(true);
    });

    test('should filter by status (unread only)', async () => {
      const messages = await messageManager.readInbox('machine1', 'unread');
      
      expect(messages).toHaveLength(2);
      expect(messages.every(msg => msg.status === 'unread')).toBe(true);
    });

    test('should filter by status (read only)', async () => {
      // Marquer un message comme lu
      const allMessages = await messageManager.readInbox('machine1');
      await messageManager.markAsRead(allMessages[0].id);
      
      const readMessages = await messageManager.readInbox('machine1', 'read');
      
      expect(readMessages).toHaveLength(1);
      expect(readMessages[0].status).toBe('read');
    });

    test('should return all messages when status is "all"', async () => {
      const messages = await messageManager.readInbox('machine1', 'all');
      
      expect(messages).toHaveLength(2);
    });

    test('should limit results when limit parameter is provided', async () => {
      const messages = await messageManager.readInbox('machine1', 'all', 1);
      
      expect(messages).toHaveLength(1);
    });

    test('should sort messages by timestamp (newest first)', async () => {
      const messages = await messageManager.readInbox('machine1', 'all');
      
      expect(new Date(messages[0].timestamp).getTime()).toBeGreaterThanOrEqual(new Date(messages[1].timestamp).getTime());
    });

    test('should return empty array if no messages for recipient', async () => {
      const messages = await messageManager.readInbox('nonexistent');
      
      expect(messages).toHaveLength(0);
    });

    test('should include preview field with truncated body', async () => {
      const longBody = 'This is a very long message body that should be truncated in preview field to make it more manageable for display purposes in user interface.';
      await messageManager.sendMessage('sender1', 'machine1', 'Long Subject', longBody);
      
      const messages = await messageManager.readInbox('machine1');
      
      expect(messages[2].preview).toBeDefined();
      expect(messages[2].preview!.length).toBeLessThan(longBody.length);
      expect(messages[2].preview).toContain('This is a very long message body');
    });

    test('should not truncate preview if body is short', async () => {
      const shortBody = 'Short message';
      await messageManager.sendMessage('sender1', 'machine1', 'Short Subject', shortBody);
      
      const messages = await messageManager.readInbox('machine1');
      
      // Le message court est le 3ème message (index 2)
      expect(messages[2].preview).toBe(shortBody);
    });
  });

  describe('getMessage', () => {
    beforeEach(async () => {
      await messageManager.sendMessage('sender1', 'machine1', 'Subject 1', 'Body 1');
    });

    test('should retrieve message by ID from inbox', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      const message = await messageManager.getMessage(messageId);
      
      expect(message).toBeDefined();
      expect(message!.id).toBe(messageId);
      expect(message!.subject).toBe('Subject 1');
    });

    test('should retrieve message by ID from sent', async () => {
      // Créer un message depuis sender1 vers machine1
      const message = await messageManager.sendMessage('sender1', 'machine1', 'Test Subject', 'Test Body');
      
      // Récupérer le message par son ID
      const retrievedMessage = await messageManager.getMessage(message.id);
      
      expect(retrievedMessage).toBeDefined();
      expect(retrievedMessage!.id).toBe(message.id);
      expect(retrievedMessage!.from).toBe('sender1');
      expect(retrievedMessage!.to).toBe('machine1');
    });

    test('should retrieve message by ID from archive', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      await messageManager.archiveMessage(messageId);
      
      const message = await messageManager.getMessage(messageId);
      
      expect(message).toBeDefined();
      expect(message!.id).toBe(messageId);
      expect(message!.status).toBe('archived');
    });

    test('should return null for non-existent message', async () => {
      const message = await messageManager.getMessage('non-existent-id');
      
      expect(message).toBeNull();
    });
  });

  describe('markAsRead', () => {
    beforeEach(async () => {
      await messageManager.sendMessage('sender1', 'machine1', 'Subject 1', 'Body 1');
    });

    test('should change message status to read', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      const success = await messageManager.markAsRead(messageId);
      
      expect(success).toBe(true);
      
      const message = await messageManager.getMessage(messageId);
      expect(message!.status).toBe('read');
    });

    test('should return false for non-existent message', async () => {
      const success = await messageManager.markAsRead('non-existent-id');
      
      expect(success).toBe(false);
    });

    test('should persist status change to file', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      await messageManager.markAsRead(messageId);
      
      // Vérifier que le fichier a été mis à jour
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${messageId}.json`);
      const fileContent = mockFiles.get(inboxPath);
      const messageData = JSON.parse(fileContent!);
      
      expect(messageData.status).toBe('read');
    });
  });

  describe('archiveMessage', () => {
    beforeEach(async () => {
      await messageManager.sendMessage('sender1', 'machine1', 'Subject 1', 'Body 1');
    });

    test('should move message from inbox to archive', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      const success = await messageManager.archiveMessage(messageId);
      
      expect(success).toBe(true);
      
      // Vérifier que le message n'est plus dans inbox
      const inboxPath = join(testSharedStatePath, 'messages/inbox', `${messageId}.json`);
      expect(mockFiles.has(inboxPath)).toBe(false);
      
      // Vérifier que le message est dans archive
      const archivePath = join(testSharedStatePath, 'messages/archive', `${messageId}.json`);
      expect(mockFiles.has(archivePath)).toBe(true);
    });

    test('should change message status to archived', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      await messageManager.archiveMessage(messageId);
      
      const message = await messageManager.getMessage(messageId);
      expect(message!.status).toBe('archived');
    });

    test('should return false for non-existent message', async () => {
      const success = await messageManager.archiveMessage('non-existent-id');
      
      expect(success).toBe(false);
    });

    test('should not be visible in inbox after archiving', async () => {
      const inboxMessages = await messageManager.readInbox('machine1');
      const messageId = inboxMessages[0].id;
      
      await messageManager.archiveMessage(messageId);
      
      const newInboxMessages = await messageManager.readInbox('machine1');
      expect(newInboxMessages).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty inbox gracefully', async () => {
      const messages = await messageManager.readInbox('machine1');
      
      expect(messages).toHaveLength(0);
    });

    test('should handle messages with undefined optional fields', async () => {
      const message = await messageManager.sendMessage(
        'sender1',
        'machine1',
        'Subject',
        'Body'
      );
      
      expect(message.tags).toBeUndefined();
      expect(message.thread_id).toBeUndefined();
      expect(message.reply_to).toBeUndefined();
    });

    test('should handle messages with all priority levels', async () => {
      const priorities: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'> = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
      
      for (const priority of priorities) {
        const message = await messageManager.sendMessage(
          'sender1',
          'machine1',
          `Subject ${priority}`,
          'Body',
          priority
        );
        
        expect(message.priority).toBe(priority);
      }
    });

    test('should handle special characters in message content', async () => {
      const specialContent = 'Message with émojis 🚀 and accents éàè and special chars @#$%';
      const message = await messageManager.sendMessage(
        'sender1',
        'machine1',
        'Special Subject',
        specialContent
      );
      
      expect(message.body).toBe(specialContent);
      
      // Vérifier que le contenu est correctement sauvegardé
      const retrievedMessage = await messageManager.getMessage(message.id);
      expect(retrievedMessage!.body).toBe(specialContent);
    });

    test('should handle concurrent message creation', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        messageManager.sendMessage(
          'sender1',
          'machine1',
          `Subject ${i}`,
          `Body ${i}`
        )
      );
      
      const messages = await Promise.all(promises);
      
      // Vérifier que tous les IDs sont uniques
      const ids = messages.map(m => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(messages.length);
    });
  });
});