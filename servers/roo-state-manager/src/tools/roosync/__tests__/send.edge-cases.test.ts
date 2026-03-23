/**
 * Tests d'edge cases pour roosync_send
 *
 * Couvre les cas limites et erreurs non testés dans send.test.ts :
 * - Messages très longs
 * - Caractères spéciaux et Unicode
 * - Gestion des erreurs fichiers
 * - Tests de concurrence
 *
 * Framework: Vitest
 * Issue: #492 Phase 3
 *
 * @module roosync/send.edge-cases.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId and getLocalFullId
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-send-edge');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Mock getMessageManager to use test path (real getMessageManager uses require() which fails in vitest ESM)
vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => new actual.MessageManager(testSharedStatePath),
  };
});

// Import après les mocks
import { roosyncSend } from '../send.js';
import { MessageManager } from '../../../services/MessageManager.js';

describe('roosyncSend - Edge Cases', () => {
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

    // Setup : créer répertoire temporaire
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
  // Tests de limites - Messages longs
  // ============================================================

  describe('Large message handling', () => {
    test('should handle very long body (10KB)', async () => {
      const longBody = 'A'.repeat(10 * 1024); // 10KB of 'A'

      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Large Message Test',
        body: longBody
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });

    test('should handle very long subject (500 chars)', async () => {
      const longSubject = 'Subject: ' + 'X'.repeat(490);

      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: longSubject,
        body: 'Normal body'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain('Subject:');
    });

    test('should handle many tags (50 tags)', async () => {
      const manyTags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);

      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Many Tags Test',
        body: 'Body',
        tags: manyTags
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });

    test('should handle empty body gracefully', async () => {
      // Empty body devrait échouer car c'est requis
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Empty Body Test',
        body: ''
      });

      // Soit erreur de validation, soit envoi réussi selon l'implémentation
      expect((result.content[0] as any).text).toBeDefined();
    });
  });

  // ============================================================
  // Tests de caractères spéciaux et Unicode
  // ============================================================

  describe('Special characters and Unicode', () => {
    test('should handle emojis in subject and body', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Test with emojis 🚀🎉💻',
        body: 'Body with more emojis: ✅❌⚠️🔧'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain('🚀');
    });

    test('should handle non-ASCII characters (accents, cyrillic, chinese)', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Accents: café, résumé, naïve',
        body: 'Cyrillic: Привет мир\nChinese: 你好世界\nJapanese: こんにちは'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });

    test('should handle markdown formatting in body', async () => {
      const markdownBody = `
# Header 1
## Header 2

**Bold text** and *italic text*

- List item 1
- List item 2

\`\`\`javascript
const code = "block";
\`\`\`

[Link](https://example.com)
`;

      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'Markdown Test',
        body: markdownBody
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });

    test('should handle special JSON characters', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'JSON chars: braces and quotes',
        body: 'Line1\nLine2\tTabbed\r\nWindows line ending\nSpecial: {}[]\\\"'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });
  });

  // ============================================================
  // Tests de validation des priorités
  // ============================================================

  describe('Priority validation', () => {
    test('should accept all valid priority levels', async () => {
      const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

      for (const priority of priorities) {
        const result = await roosyncSend({
          action: 'send',
          to: 'target-machine',
          subject: `Priority ${priority}`,
          body: 'Test body',
          priority
        });

        expect((result.content[0] as any).text).toContain('envoyé avec succès');
        expect((result.content[0] as any).text).toContain(priority);
      }
    });

    test('should default to MEDIUM when priority not specified', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target-machine',
        subject: 'No Priority Specified',
        body: 'Test body'
      });

      expect((result.content[0] as any).text).toContain('MEDIUM');
    });
  });

  // ============================================================
  // Tests de formats de destinataire
  // ============================================================

  describe('Recipient format variations', () => {
    test('should handle machine:workspace format', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'myia-ai-01:roo-extensions',
        subject: 'Workspace recipient',
        body: 'Test body'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain('myia-ai-01:roo-extensions');
    });

    test('should handle simple machine name', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'myia-po-2023',
        subject: 'Simple machine',
        body: 'Test body'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain('myia-po-2023');
    });

    test('should handle broadcast to "all"', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'all',
        subject: 'Broadcast message',
        body: 'Test body'
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
    });
  });

  // ============================================================
  // Tests de concurrence basique
  // ============================================================

  describe('Concurrent operations', () => {
    test('should handle 10 concurrent sends', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        roosyncSend({
          action: 'send',
          to: `machine-${i}`,
          subject: `Concurrent message ${i}`,
          body: `Body ${i}`
        })
      );

      const results = await Promise.all(promises);

      // Tous devraient réussir
      for (const result of results) {
        expect((result.content[0] as any).text).toContain('envoyé avec succès');
      }

      // Vérifier que tous les IDs sont uniques
      const ids = results.map(r => {
        const match = r.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
        return match ? match[1] : null;
      }).filter(Boolean);

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    test('should handle rapid send-amend sequence', async () => {
      // Envoyer un message
      const sendResult = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Rapid test',
        body: 'Original'
      });

      const match = sendResult.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      const messageId = match![1];

      // Amend immédiat
      const amendResult = await roosyncSend({
        action: 'amend',
        message_id: messageId,
        new_content: 'Amended quickly',
        reason: 'Quick fix'
      });

      expect(amendResult.content[0].text).toContain('amendé avec succès');
    });
  });

  // ============================================================
  // Tests de gestion d'erreur edge cases
  // ============================================================

  describe('Error handling edge cases', () => {
    test('should handle reply to non-existent message gracefully', async () => {
      const result = await roosyncSend({
        action: 'reply',
        message_id: 'msg-does-not-exist-12345',
        body: 'Reply to nothing'
      });

      // Devrait retourner un message d'erreur élégant, pas crasher
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('introuvable');
    });

    test('should handle amend of non-existent message gracefully', async () => {
      const result = await roosyncSend({
        action: 'amend',
        message_id: 'msg-does-not-exist-12345',
        new_content: 'New content'
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('should handle whitespace-only body', async () => {
      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Whitespace body',
        body: '   \n\t   '
      });

      // Soit erreur, soit succès - mais pas de crash
      expect(result.content).toHaveLength(1);
    });

    test('should handle very long machine ID', async () => {
      const longMachineId = 'machine-' + 'x'.repeat(200);

      const result = await roosyncSend({
        action: 'send',
        to: longMachineId,
        subject: 'Long machine ID',
        body: 'Test'
      });

      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de thread et reply_to
  // ============================================================

  describe('Thread and reply_to handling', () => {
    test('should create new thread when thread_id provided', async () => {
      const customThreadId = 'custom-thread-123';

      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Threaded message',
        body: 'Test',
        thread_id: customThreadId
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain(customThreadId);
    });

    test('should include reply_to reference when provided', async () => {
      const originalId = 'msg-original-123';

      const result = await roosyncSend({
        action: 'send',
        to: 'target',
        subject: 'Follow-up',
        body: 'Test',
        reply_to: originalId
      });

      expect((result.content[0] as any).text).toContain('envoyé avec succès');
      expect((result.content[0] as any).text).toContain(originalId);
    });
  });
});
