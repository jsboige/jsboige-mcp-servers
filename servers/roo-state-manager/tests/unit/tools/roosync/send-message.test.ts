/**
 * Tests pour roosync_send_message
 *
 * Vérifie la validation des paramètres et la gestion des erreurs
 * pour l'outil d'envoi de messages RooSync.
 *
 * @module roosync/send_message.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_send_message - Validation', () => {
  // Import dynamique après les mocks
  let sendMessage: typeof import('../../../../src/tools/roosync/send_message.js').sendMessage;

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => ({
      MessageManager: vi.fn().mockImplementation(() => ({
        sendMessage: vi.fn().mockResolvedValue({
          id: 'msg-test-123',
          from: 'test-machine',
          to: 'target-machine',
          subject: 'Test',
          body: 'Test body',
          priority: 'MEDIUM',
          timestamp: '2026-01-15T12:00:00Z'
        })
      }))
    }));

    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));

    // Mock de os pour getLocalMachineId()
    vi.doMock('os', () => ({
      hostname: vi.fn().mockReturnValue('test-machine')
    }));

    // Importer le module après les mocks
    const module = await import('../../../../src/tools/roosync/send_message.js');
    sendMessage = module.sendMessage;
  });

  describe('validation des paramètres requis', () => {
    it('devrait rejeter si "to" est vide', async () => {
      const args = {
        to: '',
        subject: 'Test Subject',
        body: 'Test body'
      };

      const result = await sendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "subject" est vide', async () => {
      const args = {
        to: 'target-machine',
        subject: '',
        body: 'Test body'
      };

      const result = await sendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });

    it('devrait rejeter si "body" est vide', async () => {
      const args = {
        to: 'target-machine',
        subject: 'Test Subject',
        body: ''
      };

      const result = await sendMessage(args);

      expect(result.content[0].text).toContain('Erreur');
    });
  });

  describe('structure de la réponse', () => {
    it('devrait retourner un objet avec content array', async () => {
      const args = {
        to: 'target-machine',
        subject: 'Test',
        body: 'Body'
      };

      const result = await sendMessage(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('roosync_send_message - Interface', () => {
  it('devrait exporter la fonction sendMessage', async () => {
    const module = await import('../../../../src/tools/roosync/send_message.js');

    expect(module.sendMessage).toBeDefined();
    expect(typeof module.sendMessage).toBe('function');
  });
});
