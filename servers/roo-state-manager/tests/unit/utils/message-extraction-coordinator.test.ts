/**
 * Tests unitaires pour le coordinateur d'extraction de messages
 * Validation de l'orchestration des extracteurs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageExtractionCoordinator, messageExtractionCoordinator } from '../../../src/utils/message-extraction-coordinator.js';
import { NewTaskInstruction } from '../../../src/types/conversation.js';

describe('MessageExtractionCoordinator', () => {
  let coordinator: MessageExtractionCoordinator;

  beforeEach(() => {
    coordinator = new MessageExtractionCoordinator();
  });

  afterEach(() => {
    // Nettoyer les variables d'environnement
    delete process.env.ROO_DEBUG_INSTRUCTIONS;
  });

  describe('extractFromMessages', () => {
    it('devrait traiter un tableau de messages vide', () => {
      const result = coordinator.extractFromMessages([]);

      expect(result.instructions).toEqual([]);
      expect(result.processedMessages).toBe(0);
      expect(result.matchedPatterns).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('devrait traiter des messages avec différents patterns', () => {
      const messages = [
        {
          type: 'api_req_started',
          content: {
            tool: 'newTask',
            mode: 'code',
            content: 'Valid API message content'
          }
        },
        {
          type: 'ask',
          ask: 'tool',
          text: JSON.stringify({
            tool: 'newTask',
            mode: 'architect',
            content: 'Valid UI message content'
          })
        }
      ];

      const result = coordinator.extractFromMessages(messages);

      expect(result.instructions).toHaveLength(2);
      expect(result.processedMessages).toBe(2);
      expect(result.matchedPatterns).toContain('API Content Extractor');
      expect(result.matchedPatterns).toContain('UI Ask/Tool Extractor');
      expect(result.errors).toEqual([]);
    });

    it('devrait gérer les erreurs individuelles sans arrêter le traitement', () => {
      const messages = [
        {
          type: 'api_req_started',
          content: {
            tool: 'newTask',
            mode: 'code',
            content: 'Valid message with sufficient length for testing'
          }
        },
        {
          type: 'api_req_started',
          content: {
            tool: 'newTask',
            // Pas de champ 'content' ou 'message' - va générer une erreur dans ApiContentExtractor
          }
        }
      ];

      const result = coordinator.extractFromMessages(messages);

      expect(result.instructions).toHaveLength(1);
      expect(result.processedMessages).toBe(2);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('extractFromMessage', () => {
    it('devrait traiter un message unique', () => {
      const message = {
        type: 'api_req_started',
        content: {
          tool: 'newTask',
          mode: 'code',
          content: 'Single message content'
        }
      };

      const result = coordinator.extractFromMessage(message);

      expect(result.instructions).toHaveLength(1);
      expect(result.processedMessages).toBe(1);
      expect(result.matchedPatterns).toContain('API Content Extractor');
      expect(result.errors).toEqual([]);
    });

    it('devrait retourner un résultat vide pour un message non reconnu', () => {
      const message = {
        type: 'unknown_type',
        content: 'unknown content'
      };

      const result = coordinator.extractFromMessage(message);

      expect(result.instructions).toEqual([]);
      expect(result.processedMessages).toBe(1);
      expect(result.matchedPatterns).toEqual([]);
    });
  });

  describe('getAvailableExtractors', () => {
    it('devrait retourner la liste des extracteurs disponibles', () => {
      const extractors = coordinator.getAvailableExtractors();

      expect(extractors).toContain('API Content Extractor');
      expect(extractors).toContain('API Text Extractor');
      expect(extractors).toContain('UI Ask/Tool Extractor');
      expect(extractors).toContain('UI Object Extractor');
      expect(extractors).toContain('UI XML Pattern Extractor');
      expect(extractors).toContain('UI Simple Task Extractor');
      expect(extractors).toContain('UI Legacy Extractor');
      expect(extractors).toHaveLength(7);
    });
  });

  describe('setDebugEnabled', () => {
    it('devrait activer/désactiver le mode debug', () => {
      coordinator.setDebugEnabled(true);
      expect(coordinator['debugEnabled']).toBe(true);

      coordinator.setDebugEnabled(false);
      expect(coordinator['debugEnabled']).toBe(false);
    });
  });

  describe('Debug Mode', () => {
    beforeEach(() => {
      process.env.ROO_DEBUG_INSTRUCTIONS = '1';
      coordinator = new MessageExtractionCoordinator();
    });

    it('devrait initialiser avec le mode debug activé', () => {
      expect(coordinator['debugEnabled']).toBe(true);
    });
  });

  describe('Patterns Spécifiques', () => {
    it('devrait extraire des instructions depuis les messages API avec content', () => {
      const message = {
        type: 'api_req_started',
        content: {
          tool: 'newTask',
          mode: '💻 Code',
          content: 'API content message with sufficient length for testing'
        }
      };

      const result = coordinator.extractFromMessage(message);

      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0]).toEqual({
        timestamp: expect.any(Number),
        mode: 'code',
        message: 'API content message with sufficient length for testing'
      });
    });

    it('devrait extraire des instructions depuis les messages UI avec XML', () => {
      const message = {
        type: 'tool_result',
        content: '<new_task><mode>architect</mode><message>XML task message</message></new_task>',
        timestamp: '2023-11-28T10:00:00.000Z'
      };

      const result = coordinator.extractFromMessage(message);

      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0]).toEqual({
        timestamp: expect.any(Number),
        mode: 'architect',
        message: 'XML task message'
      });
    });

    it('devrait extraire des instructions depuis les messages legacy', () => {
      const message = {
        type: 'tool_call',
        content: {
          tool: 'new_task',
          mode: 'legacy',
          message: 'Legacy task message'
        },
        timestamp: '2023-11-28T10:00:00.000Z'
      };

      const result = coordinator.extractFromMessage(message);

      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0]).toEqual({
        timestamp: expect.any(Number),
        mode: 'legacy',
        message: 'Legacy task message'
      });
    });
  });
});

describe('messageExtractionCoordinator (Singleton)', () => {
  it('devrait exporter une instance singleton', () => {
    expect(messageExtractionCoordinator).toBeInstanceOf(MessageExtractionCoordinator);
  });

  it('devrait être la même instance à chaque appel', () => {
    const instance1 = messageExtractionCoordinator;
    const instance2 = messageExtractionCoordinator;
    expect(instance1).toBe(instance2);
  });
});