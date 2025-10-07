/**
 * Tests unitaires pour MessageToSkeletonTransformer
 * Phase 2a - Triple Grounding
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MessageToSkeletonTransformer } from '../../src/utils/message-to-skeleton-transformer.js';
import { UIMessage } from '../../src/utils/message-types.js';

describe('MessageToSkeletonTransformer', () => {
  let transformer: MessageToSkeletonTransformer;

  beforeEach(() => {
    transformer = new MessageToSkeletonTransformer();
  });

  describe('transform()', () => {
    it('should transform simple messages to skeleton', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Test task</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Subtask 1"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id', '/test/workspace');

      expect(result.skeleton.taskId).toBe('test-id');
      expect(result.skeleton.truncatedInstruction).toBe('test task');
      expect(result.skeleton.childTaskInstructionPrefixes).toHaveLength(1);
      expect(result.metadata.newTaskCount).toBe(1);
    });

    it('should handle messages without instruction', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Some text'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.truncatedInstruction).toBe('');
      expect(result.skeleton.metadata.messageCount).toBe(1);
    });

    it('should detect completion correctly', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Task</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"attempt_completion","message":"Done"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should normalize prefixes when enabled', async () => {
      const transformer = new MessageToSkeletonTransformer({
        normalizePrefixes: true
      });

      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Main</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Create file test.ts and implement feature X"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      // computeInstructionPrefix devrait normaliser ce message
      expect(result.skeleton.childTaskInstructionPrefixes).toBeDefined();
      expect(result.skeleton.childTaskInstructionPrefixes![0].length).toBeLessThanOrEqual(192);
    });

    it('should throw error in strict mode with invalid skeleton', async () => {
      const transformer = new MessageToSkeletonTransformer({
        strictValidation: true
      });

      const messages: UIMessage[] = []; // Messages vides = skeleton invalide

      await expect(
        transformer.transform(messages, '')
      ).rejects.toThrow('Skeleton validation failed');
    });

    it('should handle empty messages array', async () => {
      const messages: UIMessage[] = [];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.taskId).toBe('test-id');
      expect(result.skeleton.metadata.messageCount).toBe(0);
      expect(result.skeleton.isCompleted).toBe(false);
    });

    it('should set workspace correctly', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Test'
        }
      ];

      const result = await transformer.transform(messages, 'test-id', '/my/workspace');

      expect(result.skeleton.metadata.workspace).toBe('/my/workspace');
    });

    it('should calculate timestamps correctly', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'First'
        },
        {
          ts: 2000,
          type: 'say',
          say: 'text',
          text: 'Last'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.metadata.createdAt).toBe(new Date(1000).toISOString());
      expect(result.skeleton.metadata.lastActivity).toBe(new Date(1000).toISOString());
    });
  });

  describe('buildMainInstruction()', () => {
    it('should extract instruction from api_req_started', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Implement feature X</task>"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.truncatedInstruction).toBe('implement feature x');
    });

    it('should fallback to first user message', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'followup',
          text: 'User instruction here'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.truncatedInstruction).toBe('user instruction here');
    });

    it('should return empty string when no instruction found', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: undefined
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.truncatedInstruction).toBe('');
    });

    it('should handle malformed api_req_started', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"No task tags here"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.truncatedInstruction).toBe('');
    });
  });

  describe('buildChildTaskPrefixes()', () => {
    it('should deduplicate identical prefixes', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Main</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Same task"}'
        },
        {
          ts: 3000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"Same task"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.childTaskInstructionPrefixes).toHaveLength(1);
    });

    it('should handle empty new tasks', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'No tasks here'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.childTaskInstructionPrefixes).toBeUndefined();
    });

    it('should normalize multiple tasks', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"<task>Task 1</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"debug","message":"  Task 2  "}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.childTaskInstructionPrefixes).toHaveLength(2);
      expect(result.skeleton.childTaskInstructionPrefixes![0]).toBe('task 1');
      expect(result.skeleton.childTaskInstructionPrefixes![1]).toBe('task 2');
    });
  });

  describe('detectCompletion()', () => {
    it('should detect completion via attempt_completion', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Task</task>"}'
        },
        {
          ts: 2000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"attempt_completion","message":"Result"}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect completion via completion_result', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Working'
        },
        {
          ts: 2000,
          type: 'say',
          say: 'completion_result',
          text: 'Done'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect completion via error', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Working'
        },
        {
          ts: 2000,
          type: 'say',
          say: 'error',
          text: 'Failed'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should not mark as completed if no completion signal', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Just a message'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');
      
      expect(result.skeleton.isCompleted).toBe(false);
    });
  });

  describe('validateSkeletonCompatibility()', () => {
    it('should validate taskId', async () => {
      const transformer = new MessageToSkeletonTransformer({
        strictValidation: true
      });

      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Test'
        }
      ];

      await expect(
        transformer.transform(messages, '')
      ).rejects.toThrow('taskId is required');
    });

    it('should validate prefix length in strict mode', async () => {
      const transformer = new MessageToSkeletonTransformer({
        strictValidation: true,
        normalizePrefixes: false // Désactiver la normalisation pour forcer un préfixe trop long
      });

      // Créer un message avec un préfixe > 192 caractères
      const longMessage = 'A'.repeat(250);
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'tool',
          text: `{"tool":"new_task","mode":"code","message":"${longMessage}"}`
        }
      ];

      await expect(
        transformer.transform(messages, 'test-id')
      ).rejects.toThrow('prefix exceeds 192 chars');
    });

    it('should pass validation for valid skeleton', async () => {
      const transformer = new MessageToSkeletonTransformer({
        strictValidation: true
      });

      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'say',
          say: 'api_req_started',
          text: '{"request":"<task>Valid task</task>"}'
        }
      ];

      const result = await transformer.transform(messages, 'valid-id');

      expect(result.skeleton.taskId).toBe('valid-id');
    });
  });

  describe('metadata', () => {
    it('should calculate messageCount correctly', async () => {
      const messages: UIMessage[] = [
        { ts: 1000, type: 'say', say: 'text', text: 'Msg 1' },
        { ts: 2000, type: 'say', say: 'text', text: 'Msg 2' },
        { ts: 3000, type: 'ask', ask: 'tool', text: '{"tool":"read_file"}' }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.metadata.messageCount).toBe(3);
      expect(result.metadata.messageCount).toBe(3);
    });

    it('should calculate actionCount correctly', async () => {
      const messages: UIMessage[] = [
        { ts: 1000, type: 'say', say: 'text', text: 'Msg' },
        { ts: 2000, type: 'ask', ask: 'tool', text: '{"tool":"read_file"}' },
        { ts: 3000, type: 'ask', ask: 'tool', text: '{"tool":"write_file"}' }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.metadata.actionCount).toBe(2);
      expect(result.metadata.toolCallCount).toBe(2);
    });

    it('should include processing time', async () => {
      const messages: UIMessage[] = [
        { ts: 1000, type: 'say', say: 'text', text: 'Test' }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should track user message count', async () => {
      const messages: UIMessage[] = [
        { ts: 1000, type: 'ask', ask: 'followup', text: 'User 1' },
        { ts: 2000, type: 'ask', ask: 'followup', text: 'User 2' },
        { ts: 3000, type: 'ask', ask: 'tool', text: '{"tool":"test"}' }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.metadata.userMessageCount).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('should handle messages with missing timestamps', async () => {
      const messages: UIMessage[] = [
        {
          ts: 0,
          type: 'say',
          say: 'text',
          text: 'Test'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      expect(result.skeleton.metadata.createdAt).toBeDefined();
    });

    it('should handle very long instructions', async () => {
      const longText = 'A'.repeat(500);
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'followup',
          text: longText
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      // Should be truncated to 192 chars by computeInstructionPrefix
      expect(result.skeleton.truncatedInstruction!.length).toBeLessThanOrEqual(192);
    });

    it('should handle special characters in instructions', async () => {
      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'followup',
          text: '<div>Test &lt;tag&gt;</div>'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      // Should be normalized by computeInstructionPrefix
      expect(result.skeleton.truncatedInstruction).toBeDefined();
    });

    it('should handle normalization disabled', async () => {
      const transformer = new MessageToSkeletonTransformer({
        normalizePrefixes: false
      });

      const messages: UIMessage[] = [
        {
          ts: 1000,
          type: 'ask',
          ask: 'tool',
          text: '{"tool":"new_task","mode":"code","message":"  UPPERCASE Task  "}'
        }
      ];

      const result = await transformer.transform(messages, 'test-id');

      // Without normalization, should preserve case (but still truncate)
      expect(result.skeleton.childTaskInstructionPrefixes).toBeDefined();
    });
  });
});