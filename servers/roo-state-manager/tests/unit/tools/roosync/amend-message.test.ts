/**
 * Tests pour roosync_amend_message
 *
 * Vérifie la validation des paramètres et le comportement
 * de l'outil d'amendement de message RooSync.
 *
 * @module roosync/amend_message.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_amend_message - Validation', () => {
  let amendMessage: typeof import('../../../../src/tools/roosync/amend_message.js').amendMessage;

  const mockAmendResult = {
    message_id: 'msg-20260115T100000-abc123',
    amended_at: '2026-01-15T11:00:00.000Z',
    reason: 'Correction de faute de frappe',
    original_content_preserved: true
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        amendMessage: vi.fn().mockResolvedValue(mockAmendResult)
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

    vi.doMock('os', () => ({
      default: {
        hostname: vi.fn().mockReturnValue('test-machine')
      }
    }));

    // Importer le module après les mocks
    const module = await import('../../../../src/tools/roosync/amend_message.js');
    amendMessage = module.amendMessage;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "message_id" est vide', async () => {
      const args = {
        message_id: '',
        new_content: 'Updated content'
      };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "new_content" est vide', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        new_content: ''
      };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "message_id" est manquant', async () => {
      const args = { new_content: 'Content' } as { message_id: string; new_content: string };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('amendement de message', () => {
    it('devrait amender un message avec succès', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        new_content: 'Updated content'
      };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('amendé');
      expect(result.content[0].text).toContain('msg-20260115T100000-abc123');
    });

    it('devrait accepter une raison optionnelle', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        new_content: 'Fixed content',
        reason: 'Correction de typo'
      };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('amendé');
    });

    it('devrait mentionner la préservation du contenu original', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        new_content: 'New content'
      };

      const result = await amendMessage(args);

      expect(result.content[0].text).toContain('original');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        message_id: 'msg-20260115T100000-abc123',
        new_content: 'Updated'
      };

      const result = await amendMessage(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('roosync_amend_message - Interface', () => {
  it('devrait exporter la fonction amendMessage', async () => {
    const module = await import('../../../../src/tools/roosync/amend_message.js');

    expect(module.amendMessage).toBeDefined();
    expect(typeof module.amendMessage).toBe('function');
  });
});
