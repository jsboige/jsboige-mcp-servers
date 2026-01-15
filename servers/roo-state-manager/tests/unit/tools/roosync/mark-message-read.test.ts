/**
 * Tests pour roosync_mark_message_read
 *
 * Vérifie la validation des paramètres et le comportement
 * de l'outil de marquage de message comme lu.
 *
 * @module roosync/mark_message_read.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_mark_message_read - Validation', () => {
  let markMessageRead: typeof import('../../../../src/tools/roosync/mark_message_read.js').markMessageRead;

  const mockUnreadMessage = {
    id: 'msg-20260115T100000-abc123',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Test Message',
    body: 'Body content',
    priority: 'HIGH',
    timestamp: '2026-01-15T10:00:00.000Z',
    status: 'unread',
    tags: []
  };

  const mockReadMessage = {
    ...mockUnreadMessage,
    id: 'msg-20260115T110000-def456',
    status: 'read'
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        getMessage: vi.fn().mockImplementation((messageId: string) => {
          if (messageId === 'msg-20260115T100000-abc123') {
            return Promise.resolve({ ...mockUnreadMessage });
          }
          if (messageId === 'msg-20260115T110000-def456') {
            return Promise.resolve({ ...mockReadMessage });
          }
          return Promise.resolve(null);
        }),
        markAsRead: vi.fn().mockResolvedValue(undefined)
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
    const module = await import('../../../../src/tools/roosync/mark_message_read.js');
    markMessageRead = module.markMessageRead;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "message_id" est vide', async () => {
      const args = {
        message_id: ''
      };

      const result = await markMessageRead(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "message_id" est manquant', async () => {
      const args = {} as { message_id: string };

      const result = await markMessageRead(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('marquage de message', () => {
    it('devrait marquer un message non-lu comme lu', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await markMessageRead(args);

      expect(result.content[0].text).toContain('marqué comme lu');
      expect(result.content[0].text).toContain('Test Message');
    });

    it('devrait indiquer si le message est déjà lu', async () => {
      const args = {
        message_id: 'msg-20260115T110000-def456'
      };

      const result = await markMessageRead(args);

      expect(result.content[0].text).toContain('déjà');
    });

    it('devrait retourner un message d\'erreur si non trouvé', async () => {
      const args = {
        message_id: 'msg-nonexistent-123'
      };

      const result = await markMessageRead(args);

      expect(result.content[0].text).toContain('introuvable');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await markMessageRead(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('roosync_mark_message_read - Interface', () => {
  it('devrait exporter la fonction markMessageRead', async () => {
    const module = await import('../../../../src/tools/roosync/mark_message_read.js');

    expect(module.markMessageRead).toBeDefined();
    expect(typeof module.markMessageRead).toBe('function');
  });
});
