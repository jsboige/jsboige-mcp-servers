/**
 * Tests pour roosync_reply_message
 *
 * Vérifie la validation des paramètres et le comportement
 * de l'outil de réponse à un message RooSync.
 *
 * @module roosync/reply_message.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_reply_message - Validation', () => {
  let replyMessage: typeof import('../../../../src/tools/roosync/reply_message.js').replyMessage;

  const mockOriginalMessage = {
    id: 'msg-20260115T100000-abc123',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Original Message',
    body: 'Original body content',
    priority: 'HIGH',
    timestamp: '2026-01-15T10:00:00.000Z',
    status: 'unread',
    tags: ['important'],
    thread_id: 'thread-001'
  };

  const mockReplyMessage = {
    id: 'msg-20260115T110000-reply123',
    from: 'test-machine',
    to: 'myia-ai-01',
    subject: 'Re: Original Message',
    body: 'Reply body',
    priority: 'HIGH',
    timestamp: '2026-01-15T11:00:00.000Z',
    status: 'unread',
    tags: ['reply'],
    thread_id: 'thread-001',
    reply_to: 'msg-20260115T100000-abc123'
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        getMessage: vi.fn().mockImplementation((messageId: string) => {
          if (messageId === 'msg-20260115T100000-abc123') {
            return Promise.resolve({ ...mockOriginalMessage });
          }
          return Promise.resolve(null);
        }),
        sendMessage: vi.fn().mockResolvedValue({ ...mockReplyMessage })
      }))
    }));

    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));

    vi.doMock('../../../../src/utils/logger.js', () => ({
      createLogger: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      })
    }));

    // Importer le module après les mocks
    const module = await import('../../../../src/tools/roosync/reply_message.js');
    replyMessage = module.replyMessage;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "message_id" est vide', async () => {
      const args = {
        message_id: '',
        body: 'Reply body'
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "body" est vide', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: ''
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "message_id" est manquant', async () => {
      const args = { body: 'Reply body' } as { message_id: string; body: string };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('envoi de réponse', () => {
    it('devrait envoyer une réponse au message original', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: 'This is my reply'
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Réponse envoyée');
      expect(result.content[0].text).toContain('Re:');
    });

    it('devrait retourner un message d\'erreur si original non trouvé', async () => {
      const args = {
        message_id: 'msg-nonexistent-123',
        body: 'Reply body'
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('introuvable');
    });

    it('devrait inclure les métadonnées de thread', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: 'Reply with thread info'
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('thread');
    });

    it('devrait accepter une priorité personnalisée', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: 'Urgent reply',
        priority: 'URGENT' as const
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Réponse envoyée');
    });

    it('devrait accepter des tags personnalisés', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: 'Tagged reply',
        tags: ['custom', 'test']
      };

      const result = await replyMessage(args);

      expect(result.content[0].text).toContain('Réponse envoyée');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        body: 'Test reply'
      };

      const result = await replyMessage(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('roosync_reply_message - Interface', () => {
  it('devrait exporter la fonction replyMessage', async () => {
    const module = await import('../../../../src/tools/roosync/reply_message.js');

    expect(module.replyMessage).toBeDefined();
    expect(typeof module.replyMessage).toBe('function');
  });
});
