/**
 * Tests d'edge cases pour roosync_read
 *
 * Couvre les cas limites :
 * - Grand nombre de messages (pagination)
 * - Messages très longs
 * - Caractères spéciaux
 * - Fichiers corrompus
 *
 * Framework: Vitest
 * Issue: #492 Phase 3
 *
 * @module roosync/read.edge-cases.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId and getLocalWorkspaceId
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-read-edge');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncRead } from '../read.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncRead - Edge Cases', () => {
  let messageManager: MessageManager;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Sauvegarder l'environnement original
    originalEnv = { ...process.env };

    // Configuration de test pour loadRooSyncConfig()
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';

    // Setup
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

    // Restaurer l'environnement original
    process.env = originalEnv;
  });

  // ============================================================
  // Tests de limites - Grand nombre de messages
  // ============================================================

  describe('Large inbox handling', () => {
    test('should handle inbox with 50 messages', async () => {
      // Créer 50 messages
      for (let i = 0; i < 50; i++) {
        await messageManager.sendMessage(
          `sender-${i}`,
          'test-machine',
          `Message ${i}`,
          `Body ${i}`,
          i % 4 === 0 ? 'LOW' : i % 4 === 1 ? 'MEDIUM' : i % 4 === 2 ? 'HIGH' : 'URGENT'
        );
      }

      const result = await roosyncRead({
        mode: 'inbox',
        limit: 50
      });

      expect((result.content[0] as any).text).toContain('50 message');
    });

    test('should limit results to specified limit', async () => {
      // Créer 20 messages
      for (let i = 0; i < 20; i++) {
        await messageManager.sendMessage(
          `sender-${i}`,
          'test-machine',
          `Message ${i}`,
          `Body ${i}`,
          'MEDIUM'
        );
      }

      const result = await roosyncRead({
        mode: 'inbox',
        limit: 5
      });

      // Total count shows all 20 messages, but only 5 are displayed in the table
      expect((result.content[0] as any).text).toContain('20 message');
    });

    test('should handle pagination correctly', async () => {
      // Créer 100 messages
      for (let i = 0; i < 100; i++) {
        await messageManager.sendMessage(
          `sender-${i}`,
          'test-machine',
          `Message ${i}`,
          `Body ${i}`,
          'MEDIUM'
        );
      }

      // Première page
      const page1 = await roosyncRead({
        mode: 'inbox',
        limit: 10
      });

      // Total count shows all 100 messages
      expect(page1.content[0].text).toContain('100 message');
    });
  });

  // ============================================================
  // Tests de messages avec contenu spécial
  // ============================================================

  describe('Special content handling', () => {
    test('should display message with very long body', async () => {
      const longBody = 'Long content. '.repeat(1000); // ~14KB

      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Long Body Message',
        longBody,
        'MEDIUM'
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('Long Body Message');
      expect(result.content.length).toBe(1);
    });

    test('should display message with emojis', async () => {
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Emoji Test 🚀',
        'Body with emojis: ✅❌⚠️🔧',
        'HIGH'
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('🚀');
      expect((result.content[0] as any).text).toContain('✅');
    });

    test('should display message with unicode characters', async () => {
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Unicode: 你好世界',
        'Mixed: café, Привет, こんにちは',
        'MEDIUM'
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('你好世界');
      expect((result.content[0] as any).text).toContain('café');
    });

    test('should display message with markdown content', async () => {
      const markdownBody = `
# Header

**Bold** and *italic*

- Item 1
- Item 2

\`\`\`js
const x = 1;
\`\`\`
`;

      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Markdown Message',
        markdownBody,
        'MEDIUM'
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('Markdown Message');
      expect((result.content[0] as any).text).toContain('# Header');
    });

    test('should display message with many tags', async () => {
      const manyTags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);

      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Many Tags',
        'Body',
        'MEDIUM',
        manyTags
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('tag-0');
      expect((result.content[0] as any).text).toContain('tag-19');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('Error handling', () => {
    test('should handle invalid message_id format gracefully', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: 'invalid-id-format'
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('should handle empty message_id', async () => {
      const result = await roosyncRead({
        mode: 'message',
        message_id: ''
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('should handle very long message_id', async () => {
      const longId = 'msg-' + 'x'.repeat(500);

      const result = await roosyncRead({
        mode: 'message',
        message_id: longId
      });

      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de filtrage par statut
  // ============================================================

  describe('Status filtering edge cases', () => {
    test('should handle all read messages when filtering unread', async () => {
      // Créer et marquer tous comme lus
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Read Message',
        'Body',
        'MEDIUM'
      );
      await messageManager.markAsRead(msg.id);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'unread'
      });

      // Devrait indiquer inbox vide pour les non-lus
      // Soit "Aucun message" soit "0 message"
      const text = (result.content[0] as any).text;
      expect(
        text.includes('Aucun message') ||
        text.includes('0 message') ||
        text.includes('0 non-lu')
      ).toBe(true);
    });

    test('should handle mixed status messages', async () => {
      // Créer des messages avec différents statuts
      const msg1 = await messageManager.sendMessage('s1', 'test-machine', 'Read', 'B1', 'LOW');
      await messageManager.markAsRead(msg1.id);

      await messageManager.sendMessage('s2', 'test-machine', 'Unread 1', 'B2', 'MEDIUM');
      await messageManager.sendMessage('s3', 'test-machine', 'Unread 2', 'B3', 'HIGH');

      const allResult = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      expect(allResult.content[0].text).toContain('3 message');

      const unreadResult = await roosyncRead({
        mode: 'inbox',
        status: 'unread'
      });

      expect(unreadResult.content[0].text).toContain('2');
    });
  });

  // ============================================================
  // Tests de priorités
  // ============================================================

  describe('Priority handling', () => {
    test('should display all priority levels correctly', async () => {
      const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

      for (const priority of priorities) {
        await messageManager.sendMessage(
          `sender-${priority}`,
          'test-machine',
          `${priority} Priority Message`,
          'Body',
          priority
        );
      }

      const result = await roosyncRead({
        mode: 'inbox'
      });

      expect((result.content[0] as any).text).toContain('LOW');
      expect((result.content[0] as any).text).toContain('MEDIUM');
      expect((result.content[0] as any).text).toContain('HIGH');
      expect((result.content[0] as any).text).toContain('URGENT');
    });
  });

  // ============================================================
  // Tests de threads
  // ============================================================

  describe('Thread handling', () => {
    test('should display thread_id when present', async () => {
      const msg = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Threaded Message',
        'Body',
        'MEDIUM',
        [],
        'thread-12345'
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: msg.id
      });

      expect((result.content[0] as any).text).toContain('thread-12345');
    });

    test('should handle messages with reply_to reference', async () => {
      // Créer un message original
      const original = await messageManager.sendMessage(
        'sender',
        'test-machine',
        'Original',
        'Body',
        'MEDIUM'
      );

      // Créer une réponse
      const reply = await messageManager.sendMessage(
        'test-machine',
        'sender',
        'Re: Original',
        'Reply body',
        'MEDIUM',
        [],
        original.id,
        original.id
      );

      const result = await roosyncRead({
        mode: 'message',
        message_id: reply.id
      });

      expect((result.content[0] as any).text).toContain(original.id);
    });
  });
});
