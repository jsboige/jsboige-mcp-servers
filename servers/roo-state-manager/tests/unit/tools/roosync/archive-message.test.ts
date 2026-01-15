/**
 * Tests pour roosync_archive_message
 *
 * Vérifie la validation des paramètres et le comportement
 * de l'outil d'archivage de message RooSync.
 *
 * @module roosync/archive_message.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_archive_message - Validation', () => {
  let archiveMessage: typeof import('../../../../src/tools/roosync/archive_message.js').archiveMessage;

  const mockInboxMessage = {
    id: 'msg-20260115T100000-abc123',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Test Message',
    body: 'Body content',
    priority: 'HIGH',
    timestamp: '2026-01-15T10:00:00.000Z',
    status: 'read',
    tags: [],
    thread_id: 'thread-001'
  };

  const mockArchivedMessage = {
    ...mockInboxMessage,
    id: 'msg-20260115T110000-def456',
    status: 'archived'
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        getMessage: vi.fn().mockImplementation((messageId: string) => {
          if (messageId === 'msg-20260115T100000-abc123') {
            return Promise.resolve({ ...mockInboxMessage });
          }
          if (messageId === 'msg-20260115T110000-def456') {
            return Promise.resolve({ ...mockArchivedMessage });
          }
          return Promise.resolve(null);
        }),
        archiveMessage: vi.fn().mockResolvedValue(undefined)
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
    const module = await import('../../../../src/tools/roosync/archive_message.js');
    archiveMessage = module.archiveMessage;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "message_id" est vide', async () => {
      const args = {
        message_id: ''
      };

      const result = await archiveMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "message_id" est manquant', async () => {
      const args = {} as { message_id: string };

      const result = await archiveMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('archivage de message', () => {
    it('devrait archiver un message existant', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await archiveMessage(args);

      expect(result.content[0].text).toContain('archivé');
      expect(result.content[0].text).toContain('Test Message');
    });

    it('devrait indiquer si le message est déjà archivé', async () => {
      const args = {
        message_id: 'msg-20260115T110000-def456'
      };

      const result = await archiveMessage(args);

      expect(result.content[0].text).toContain('déjà archivé');
    });

    it('devrait retourner un message d\'erreur si non trouvé', async () => {
      const args = {
        message_id: 'msg-nonexistent-123'
      };

      const result = await archiveMessage(args);

      expect(result.content[0].text).toContain('introuvable');
    });

    it('devrait mentionner le thread si présent', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await archiveMessage(args);

      // Le message a un thread_id, donc des actions thread devraient être mentionnées
      expect(result.content[0].text).toContain('thread');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await archiveMessage(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('roosync_archive_message - Interface', () => {
  it('devrait exporter la fonction archiveMessage', async () => {
    const module = await import('../../../../src/tools/roosync/archive_message.js');

    expect(module.archiveMessage).toBeDefined();
    expect(typeof module.archiveMessage).toBe('function');
  });
});
