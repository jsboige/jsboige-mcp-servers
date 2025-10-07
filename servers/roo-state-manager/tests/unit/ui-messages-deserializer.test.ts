import { describe, it, expect, beforeEach } from '@jest/globals';
import { UIMessagesDeserializer } from '../../src/utils/ui-messages-deserializer.js';
import { UIMessage } from '../../src/utils/message-types.js';

/**
 * Tests unitaires pour UIMessagesDeserializer
 * 
 * IMPORTANT: Ces tests utilisent des fixtures MINIMALES créées dans le test
 * Aucun fichier réel ui_messages.json n'est lu
 * 
 * Basé sur docs/roo-code/ui-messages-deserialization.md
 */
describe('UIMessagesDeserializer', () => {
  let deserializer: UIMessagesDeserializer;

  beforeEach(() => {
    deserializer = new UIMessagesDeserializer();
  });

  describe('safeJsonParse', () => {
    it('devrait parser du JSON valide', () => {
      const result = deserializer.safeJsonParse<{ foo: string }>('{"foo":"bar"}');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('devrait retourner undefined pour du JSON invalide', () => {
      const result = deserializer.safeJsonParse('invalid json{');
      expect(result).toBeUndefined();
    });

    it('devrait retourner defaultValue pour du JSON invalide', () => {
      const result = deserializer.safeJsonParse('invalid', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('devrait retourner defaultValue pour null', () => {
      const result = deserializer.safeJsonParse(null, { default: true });
      expect(result).toEqual({ default: true });
    });

    it('devrait retourner defaultValue pour undefined', () => {
      const result = deserializer.safeJsonParse(undefined, { default: true });
      expect(result).toEqual({ default: true });
    });

    it('devrait gérer des chaînes multi-lignes', () => {
      const json = '{"text":"line1\\nline2\\nline3"}';
      const result = deserializer.safeJsonParse<{ text: string }>(json);
      expect(result?.text).toBe('line1\nline2\nline3');
    });

    it('devrait gérer du JSON imbriqué complexe', () => {
      const json = '{"tool":"new_task","mode":"code","message":"Test task"}';
      const result = deserializer.safeJsonParse<{ tool: string; mode: string; message: string }>(json);
      expect(result).toEqual({
        tool: 'new_task',
        mode: 'code',
        message: 'Test task'
      });
    });
  });

  describe('extractToolCalls', () => {
    it('devrait extraire les tool calls depuis ask:tool messages', () => {
      const messages: UIMessage[] = [
        {
          ts: 1234567890,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Implement feature"}'
        },
        {
          ts: 1234567891,
          type: 'say',
          say: 'text',
          text: 'Some other message'
        }
      ];

      const tools = deserializer.extractToolCalls(messages);
      
      expect(tools).toHaveLength(1);
      expect(tools[0].tool).toBe('new_task');
      expect(tools[0].mode).toBe('code');
      expect(tools[0].message).toBe('Implement feature');
      expect(tools[0].timestamp).toBe(1234567890);
    });

    it('devrait gérer les tool calls avec champ content au lieu de message', () => {
      const messages: UIMessage[] = [
        {
          ts: 1234567890,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"read_file","content":"some/path.ts"}'
        }
      ];

      const tools = deserializer.extractToolCalls(messages);
      
      expect(tools).toHaveLength(1);
      expect(tools[0].tool).toBe('read_file');
      expect(tools[0].message).toBe('some/path.ts');
    });

    it('devrait ignorer les messages sans ask:tool', () => {
      const messages: UIMessage[] = [
        {
          ts: 1234567890,
          type: 'ask',
          ask: 'followup',
          text: '{"question":"What?"}'
        }
      ];

      const tools = deserializer.extractToolCalls(messages);
      
      expect(tools).toHaveLength(0);
    });

    it('devrait ignorer les messages avec JSON invalide', () => {
      const messages: UIMessage[] = [
        {
          ts: 1234567890,
          type: 'ask',
          ask: 'tool',
          text: 'invalid json{'
        }
      ];

      const tools = deserializer.extractToolCalls(messages);
      
      expect(tools).toHaveLength(0);
    });
  });

  describe('extractNewTasks', () => {
    it('devrait extraire seulement les tool calls new_task', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Task 1"}'
        },
        {
          ts: 2,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"read_file","message":"some/file.ts"}'
        },
        {
          ts: 3,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"architect","message":"Task 2"}'
        }
      ];

      const newTasks = deserializer.extractNewTasks(messages);
      
      expect(newTasks).toHaveLength(2);
      expect(newTasks[0].message).toBe('Task 1');
      expect(newTasks[0].mode).toBe('code');
      expect(newTasks[1].message).toBe('Task 2');
      expect(newTasks[1].mode).toBe('architect');
    });

    it('devrait filtrer les new_task sans mode ou message', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code"}'  // Pas de message
        },
        {
          ts: 2,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","message":"Task"}'  // Pas de mode
        }
      ];

      const newTasks = deserializer.extractNewTasks(messages);
      
      expect(newTasks).toHaveLength(0);
    });
  });

  describe('extractApiRequests', () => {
    it('devrait extraire les informations API depuis say:api_req_started', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Test</task>","cost":0.42,"cancelReason":null}'
        }
      ];

      const apiReqs = deserializer.extractApiRequests(messages);
      
      expect(apiReqs).toHaveLength(1);
      expect(apiReqs[0].request).toBe('<task>Test</task>');
      expect(apiReqs[0].cost).toBe(0.42);
      expect(apiReqs[0].cancelReason).toBeNull();
    });

    it('devrait gérer les requêtes annulées', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"Test","cost":0.5,"cancelReason":"user_cancelled"}'
        }
      ];

      const apiReqs = deserializer.extractApiRequests(messages);
      
      expect(apiReqs).toHaveLength(1);
      expect(apiReqs[0].cancelReason).toBe('user_cancelled');
    });

    it('devrait ignorer les messages sans say:api_req_started', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'text',
          text: 'Some text'
        }
      ];

      const apiReqs = deserializer.extractApiRequests(messages);
      
      expect(apiReqs).toHaveLength(0);
    });
  });

  describe('extractUserMessages', () => {
    it('devrait extraire les messages type ask sans ask spécifique', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'ask',
          text: 'User question'
        },
        {
          ts: 2,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"test"}'
        },
        {
          ts: 3,
          type: 'say',
          text: 'System message'
        }
      ];

      const userMsgs = deserializer.extractUserMessages(messages);
      
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].text).toBe('User question');
    });
  });

  describe('extractErrors', () => {
    it('devrait extraire les messages d\'erreur', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'error',
          text: 'Error message'
        },
        {
          ts: 2,
          type: 'say',
          say: 'text',
          text: 'Normal message'
        }
      ];

      const errors = deserializer.extractErrors(messages);
      
      expect(errors).toHaveLength(1);
      expect(errors[0].text).toBe('Error message');
    });
  });

  describe('getInitialInstruction', () => {
    it('devrait retourner le premier message utilisateur', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'text',
          text: 'System init'
        },
        {
          ts: 2,
          type: 'ask',
          text: 'Initial user instruction'
        },
        {
          ts: 3,
          type: 'ask',
          text: 'Follow-up question'
        }
      ];

      const instruction = deserializer.getInitialInstruction(messages);
      
      expect(instruction).toBe('Initial user instruction');
    });

    it('devrait retourner undefined si aucun message utilisateur', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'say',
          say: 'text',
          text: 'System only'
        }
      ];

      const instruction = deserializer.getInitialInstruction(messages);
      
      expect(instruction).toBeUndefined();
    });
  });

  describe('getMessageStats', () => {
    it('devrait calculer les statistiques correctement', () => {
      const messages: UIMessage[] = [
        {
          ts: 1,
          type: 'ask',
          text: 'User message'
        },
        {
          ts: 2,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Task"}'
        },
        {
          ts: 3,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"Test","cost":0.5}'
        },
        {
          ts: 4,
          type: 'say',
          say: 'error',
          text: 'Error occurred'
        },
        {
          ts: 5,
          type: 'say',
          say: 'text',
          text: 'Normal text'
        }
      ];

      const stats = deserializer.getMessageStats(messages);
      
      expect(stats.total).toBe(5);
      expect(stats.askMessages).toBe(2);
      expect(stats.sayMessages).toBe(3);
      expect(stats.toolCalls).toBe(1);
      expect(stats.apiRequests).toBe(1);
      expect(stats.newTasks).toBe(1);
      expect(stats.errors).toBe(1);
    });
  });
});