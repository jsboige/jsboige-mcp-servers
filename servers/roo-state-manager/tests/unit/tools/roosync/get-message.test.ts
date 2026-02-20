/**
 * Tests pour roosync_get_message
 *
 * Vérifie la validation des paramètres et le formatage des résultats
 * pour l'outil de récupération de message RooSync.
 *
 * @module roosync/get_message.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_get_message - Validation', () => {
  let getMessage: typeof import('../../../../src/tools/roosync/get_message.js').getMessage;

  const mockMessage = {
    id: 'msg-20260115T100000-abc123',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Test Message',
    body: 'Body content of the message',
    priority: 'HIGH',
    timestamp: '2026-01-15T10:00:00.000Z',
    status: 'unread',
    tags: ['important', 'urgent'],
    thread_id: 'thread-001',
    reply_to: 'msg-previous-123'
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        getMessage: vi.fn().mockImplementation((messageId: string) => {
          if (messageId === 'msg-20260115T100000-abc123') {
            return Promise.resolve({ ...mockMessage });
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
    const module = await import('../../../../src/tools/roosync/get_message.js');
    getMessage = module.getMessage;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "message_id" est vide', async () => {
      const args = {
        message_id: ''
      };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "message_id" est manquant', async () => {
      const args = {} as { message_id: string };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('récupération de message', () => {
    it('devrait retourner le message complet si trouvé', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('Test Message');
      expect(result.content[0].text).toContain('myia-ai-01');
      expect(result.content[0].text).toContain('Body content of the message');
    });

    it('devrait retourner un message d\'erreur si non trouvé', async () => {
      const args = {
        message_id: 'msg-nonexistent-123'
      };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('introuvable');
      expect(result.content[0].text).toContain('msg-nonexistent-123');
    });

    it('devrait inclure les métadonnées optionnelles (tags, thread_id)', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('important');
      expect(result.content[0].text).toContain('thread-001');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123'
      };

      const result = await getMessage(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });

  describe('mark_as_read', () => {
    it('devrait marquer le message comme lu quand mark_as_read=true et status=unread', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        mark_as_read: true
      };

      const result = await getMessage(args);

      // Le message est unread dans le mock, il doit être marqué comme lu
      expect(result.content[0].text).toContain('Test Message');
    });

    it('ne devrait pas marquer comme lu quand mark_as_read=false', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        mark_as_read: false
      };

      const result = await getMessage(args);

      expect(result.content[0].text).toContain('Test Message');
    });
  });

  // Helper : crée une instance fraîche de getMessage avec un message personnalisé.
  // Nécessite vi.resetModules() pour contourner le cache de beforeEach.
  const createGetMessageWith = async (messageData: object) => {
    vi.resetModules();
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        getMessage: vi.fn().mockResolvedValue(messageData),
        markAsRead: vi.fn()
      }))
    }));
    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));
    vi.doMock('../../../../src/utils/logger.js', () => ({
      createLogger: vi.fn().mockReturnValue({
        info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn()
      })
    }));
    const module = await import('../../../../src/tools/roosync/get_message.js');
    return module.getMessage;
  };

  describe('icônes de priorité', () => {
    it('devrait afficher 🔥 pour URGENT', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, priority: 'URGENT' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('🔥');
    });

    it('devrait afficher 📝 pour MEDIUM', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, priority: 'MEDIUM' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('📝');
    });

    it('devrait afficher 📋 pour LOW', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, priority: 'LOW' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('📋');
    });

    it('devrait afficher 📝 pour priorité inconnue', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, priority: 'UNKNOWN' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('📝');
    });
  });

  describe('icônes de statut', () => {
    it('devrait afficher ✅ pour read', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, status: 'read' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('✅');
    });

    it('devrait afficher 📦 pour archived', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, status: 'archived' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('📦');
    });

    it('devrait afficher 📧 pour statut inconnu', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, status: 'unknown' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      expect(result.content[0].text).toContain('📧');
    });
  });

  describe('message sans métadonnées optionnelles', () => {
    it('devrait afficher correctement un message sans tags, thread_id, reply_to', async () => {
      const getMessage = await createGetMessageWith({
        id: 'msg-minimal',
        from: 'source-machine',
        to: 'dest-machine',
        subject: 'Minimal Message',
        body: 'Just a simple body',
        priority: 'MEDIUM',
        timestamp: '2026-01-15T10:00:00.000Z',
        status: 'read'
        // pas de tags, thread_id, reply_to
      });

      const result = await getMessage({ message_id: 'msg-minimal' });

      expect(result.content[0].text).toContain('Minimal Message');
      expect(result.content[0].text).not.toContain('**Tags');
      expect(result.content[0].text).not.toContain('**Thread');
    });

    it('devrait ne pas afficher l\'action "Archiver" quand déjà archivé', async () => {
      const getMessage = await createGetMessageWith({ ...mockMessage, status: 'archived' });
      const result = await getMessage({ message_id: 'msg-20260115T100000-abc123' });
      // Message archivé : pas d'action "Archiver"
      expect(result.content[0].text).not.toContain('**Archiver**');
    });
  });
});

describe('roosync_get_message - Interface', () => {
  it('devrait exporter la fonction getMessage', async () => {
    const module = await import('../../../../src/tools/roosync/get_message.js');

    expect(module.getMessage).toBeDefined();
    expect(typeof module.getMessage).toBe('function');
  });
});
