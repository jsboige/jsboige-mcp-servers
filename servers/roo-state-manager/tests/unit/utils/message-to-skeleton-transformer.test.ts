import { describe, it, expect } from 'vitest';

vi.unmock('../../../src/utils/message-to-skeleton-transformer.js');
import { MessageToSkeletonTransformer } from '../../../src/utils/message-to-skeleton-transformer';
import { UIMessage } from '../../../src/utils/message-types';

describe('MessageToSkeletonTransformer', () => {
  // Helper to create minimal messages
  function makeMessage(overrides: Partial<UIMessage> & { type: string; ts: number }): UIMessage {
    return overrides as UIMessage;
  }

  // --- transform ---

  describe('transform', () => {
    it('should create skeleton from basic messages', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Fix the login bug', ts: 1000 }),
        makeMessage({ type: 'say', say: 'text', text: 'Working on it', ts: 2000 })
      ];

      const result = await transformer.transform(messages, 'task-123');

      expect(result.skeleton.taskId).toBe('task-123');
      expect(result.skeleton.metadata.messageCount).toBe(2);
      expect(result.skeleton.metadata.actionCount).toBe(0);
      expect(result.metadata.messageCount).toBe(2);
      expect(result.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect completion from attempt_completion tool', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Do work', ts: 1000 }),
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'attempt_completion', mode: 'code', message: 'Done' }), ts: 2000 },
        makeMessage({ type: 'say', say: 'completion_result', text: 'Result', ts: 3000 })
      ];

      const result = await transformer.transform(messages, 'task-456');
      expect(result.skeleton.isCompleted).toBe(true);
      expect(result.skeleton.metadata.lastActivity).toBeDefined();
    });

    it('should detect completion from last message say type', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Task', ts: 1000 }),
        makeMessage({ type: 'say', say: 'completion_result', text: 'Done', ts: 2000 })
      ];

      const result = await transformer.transform(messages, 'task-789');
      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect incompletion for ongoing tasks', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Start task', ts: 1000 }),
        makeMessage({ type: 'say', say: 'text', text: 'Working...', ts: 2000 })
      ];

      const result = await transformer.transform(messages, 'task-ongoing');
      expect(result.skeleton.isCompleted).toBe(false);
    });

    it('should extract tool calls count', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Read files', ts: 1000 }),
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'read_file', mode: 'code' }), ts: 2000 },
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'write_file', mode: 'code' }), ts: 3000 }
      ];

      const result = await transformer.transform(messages, 'task-tools');
      expect(result.skeleton.metadata.actionCount).toBe(2);
      expect(result.metadata.toolCallCount).toBe(2);
    });

    it('should extract new task instructions', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Delegate', ts: 1000 }),
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code-simple', message: 'Fix auth module login validation bug' }), ts: 2000 }
      ];

      const result = await transformer.transform(messages, 'task-delegate');
      expect(result.skeleton.childTaskInstructionPrefixes).toBeDefined();
      expect(result.skeleton.childTaskInstructionPrefixes!.length).toBeGreaterThanOrEqual(1);
      expect(result.metadata.newTaskCount).toBe(1);
    });

    it('should deduplicate child task prefixes', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Delegate', ts: 1000 }),
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code', message: 'Fix auth login bug in the authentication module' }), ts: 2000 },
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code', message: 'Fix auth login bug in the authentication module' }), ts: 3000 }
      ];

      const result = await transformer.transform(messages, 'task-dedup');
      // Same message should be deduplicated
      expect(result.skeleton.childTaskInstructionPrefixes!.length).toBe(1);
    });

    it('should handle empty messages array', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const result = await transformer.transform([], 'task-empty');

      expect(result.skeleton.taskId).toBe('task-empty');
      expect(result.skeleton.metadata.messageCount).toBe(0);
      expect(result.skeleton.isCompleted).toBe(false);
    });

    it('should use provided workspace parameter', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Test', ts: 1000 })
      ];

      const result = await transformer.transform(messages, 'task-ws', 'C:/dev/my-project');
      expect(result.skeleton.metadata.workspace).toBe('C:/dev/my-project');
    });

    it('should auto-detect workspace from environment_details', async () => {
      const transformer = new MessageToSkeletonTransformer();
      const messages: UIMessage[] = [
        makeMessage({
          type: 'say',
          say: 'text',
          text: '<environment_details>\n# Current Workspace Directory (C:/dev/my-project) Files\n</environment_details>',
          ts: 1000
        })
      ];

      const result = await transformer.transform(messages, 'task-autows');
      expect(result.skeleton.metadata.workspace).toBe('C:/dev/my-project');
    });
  });

  // --- strictValidation ---

  describe('strictValidation', () => {
    it('should pass validation for valid skeleton', async () => {
      const transformer = new MessageToSkeletonTransformer({ strictValidation: true });
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Valid task', ts: 1000 }),
        makeMessage({ type: 'say', say: 'text', text: 'Response', ts: 2000 })
      ];

      // Should not throw
      const result = await transformer.transform(messages, 'task-valid');
      expect(result.skeleton.taskId).toBe('task-valid');
    });

    it('should throw on invalid prefix length when strict', async () => {
      const transformer = new MessageToSkeletonTransformer({ strictValidation: true, normalizePrefixes: false });
      const veryLongMessage = 'x'.repeat(250);
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Delegate', ts: 1000 }),
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code', message: veryLongMessage }), ts: 2000 }
      ];

      // normalizePrefixes=false means the raw message is used as prefix, potentially exceeding 192 chars
      await expect(transformer.transform(messages, 'task-bad')).rejects.toThrow('prefix exceeds 192');
    });
  });

  // --- options ---

  describe('options', () => {
    it('should respect normalizePrefixes=false', async () => {
      const transformer = new MessageToSkeletonTransformer({ normalizePrefixes: false });
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Task', ts: 1000 })
      ];

      const result = await transformer.transform(messages, 'task-no-norm');
      expect(result.skeleton.taskId).toBe('task-no-norm');
    });

    it('should include metadata when includeMetadata=true', async () => {
      const transformer = new MessageToSkeletonTransformer({ includeMetadata: true });
      const messages: UIMessage[] = [
        makeMessage({ type: 'ask', text: 'Task', ts: 1000 })
      ];

      const result = await transformer.transform(messages, 'task-meta');
      expect(result.metadata).toBeDefined();
      expect(result.metadata.messageCount).toBe(1);
    });
  });
});
