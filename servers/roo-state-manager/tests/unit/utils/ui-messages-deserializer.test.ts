import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';

vi.unmock('../../../src/utils/ui-messages-deserializer.js');
import { UIMessagesDeserializer } from '../../../src/utils/ui-messages-deserializer';
import { UIMessage } from '../../../src/utils/message-types';

describe('UIMessagesDeserializer', () => {
  const testDir = join(process.cwd(), 'test-temp-ui-messages');
  let deserializer: UIMessagesDeserializer;

  beforeEach(() => {
    deserializer = new UIMessagesDeserializer();
  });

  // --- safeJsonParse ---

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(deserializer.safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
    });

    it('should return defaultValue for null input', () => {
      expect(deserializer.safeJsonParse(null, 'fallback')).toBe('fallback');
    });

    it('should return defaultValue for undefined input', () => {
      expect(deserializer.safeJsonParse(undefined, 42)).toBe(42);
    });

    it('should return defaultValue for empty string', () => {
      expect(deserializer.safeJsonParse('', 'fallback')).toBe('fallback');
    });

    it('should return undefined for invalid JSON without default', () => {
      expect(deserializer.safeJsonParse('{invalid}')).toBeUndefined();
    });

    it('should return defaultValue for invalid JSON with default', () => {
      expect(deserializer.safeJsonParse('{invalid}', 'default')).toBe('default');
    });

    it('should parse arrays', () => {
      expect(deserializer.safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('should parse primitive values', () => {
      expect(deserializer.safeJsonParse('42')).toBe(42);
      expect(deserializer.safeJsonParse('"hello"')).toBe('hello');
      expect(deserializer.safeJsonParse('true')).toBe(true);
    });
  });

  // --- readTaskMessages ---

  describe('readTaskMessages', () => {
    beforeEach(async () => {
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      try { await fs.rm(testDir, { recursive: true, force: true }); } catch {}
    });

    it('should return empty array for non-existent file', async () => {
      const result = await deserializer.readTaskMessages(join(testDir, 'no-such-file.json'));
      expect(result).toEqual([]);
    });

    it('should read and parse valid messages', async () => {
      const messages = [
        { type: 'ask', ts: 1000, text: 'hello' },
        { type: 'say', ts: 2000, say: 'text', text: 'response' }
      ];
      const filePath = join(testDir, 'ui_messages.json');
      await fs.writeFile(filePath, JSON.stringify(messages));

      const result = await deserializer.readTaskMessages(filePath);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('ask');
      expect(result[1].type).toBe('say');
    });

    it('should return empty array for non-array JSON', async () => {
      const filePath = join(testDir, 'not-array.json');
      await fs.writeFile(filePath, JSON.stringify({ not: 'array' }));

      const result = await deserializer.readTaskMessages(filePath);
      expect(result).toEqual([]);
    });

    it('should return empty array for invalid JSON file', async () => {
      const filePath = join(testDir, 'invalid.json');
      await fs.writeFile(filePath, '{bad json}');

      const result = await deserializer.readTaskMessages(filePath);
      expect(result).toEqual([]);
    });
  });

  // --- extractToolCalls ---

  describe('extractToolCalls', () => {
    it('should extract tool calls from ask:tool messages', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'read_file', mode: 'code', message: 'Read foo.ts' }), ts: 1000 },
        { type: 'say', say: 'text', text: 'response' }
      ];

      const result = deserializer.extractToolCalls(messages);
      expect(result).toHaveLength(1);
      expect(result[0].tool).toBe('read_file');
      expect(result[0].mode).toBe('code');
      expect(result[0].message).toBe('Read foo.ts');
      expect(result[0].timestamp).toBe(1000);
    });

    it('should handle content field as alias for message', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'write_file', content: 'Write bar.ts' }), ts: 2000 }
      ];

      const result = deserializer.extractToolCalls(messages);
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('Write bar.ts');
    });

    it('should skip messages without ask:tool', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'followup', text: 'some text', ts: 1000 },
        { type: 'say', say: 'text', text: 'response' }
      ];

      expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
    });

    it('should skip messages without text', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', ts: 1000 } as UIMessage
      ];

      expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
    });

    it('should skip messages with invalid JSON in text', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: 'not-json', ts: 1000 }
      ];

      expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
    });

    it('should skip messages where parsed JSON has no tool field', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ mode: 'code', message: 'task' }), ts: 1000 }
      ];

      expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
    });

    it('should extract multiple tool calls', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'read_file', mode: 'code' }), ts: 1000 },
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'write_file', mode: 'code' }), ts: 2000 },
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'execute_command', mode: 'code' }), ts: 3000 }
      ];

      const result = deserializer.extractToolCalls(messages);
      expect(result).toHaveLength(3);
    });
  });

  // --- extractApiRequests ---

  describe('extractApiRequests', () => {
    it('should extract API requests from say:api_req_started messages', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'api_req_started', text: JSON.stringify({ request: 'prompt', cost: 0.05 }), ts: 1000 },
        { type: 'say', say: 'text', text: 'response' }
      ];

      const result = deserializer.extractApiRequests(messages);
      expect(result).toHaveLength(1);
      expect(result[0].request).toBe('prompt');
      expect(result[0].cost).toBe(0.05);
    });

    it('should include undefined parse results (code checks !== null, not != null)', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'api_req_started', text: 'invalid-json', ts: 1000 }
      ];

      const result = deserializer.extractApiRequests(messages);
      // safeJsonParse returns undefined for invalid JSON, but filter checks !== null
      // so undefined passes through — known behavior
      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });

    it('should handle cancelReason field', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'api_req_started', text: JSON.stringify({ cancelReason: 'user_cancelled' }), ts: 1000 }
      ];

      const result = deserializer.extractApiRequests(messages);
      expect(result).toHaveLength(1);
      expect(result[0].cancelReason).toBe('user_cancelled');
    });
  });

  // --- extractNewTasks ---

  describe('extractNewTasks', () => {
    it('should extract new_task tool calls with mode and message', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code-simple', message: 'Fix bug in auth' }), ts: 1000 }
      ];

      const result = deserializer.extractNewTasks(messages);
      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe('code-simple');
      expect(result[0].message).toBe('Fix bug in auth');
    });

    it('should also handle newTask (camelCase) tool name', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'newTask', mode: 'code', message: 'Do work' }), ts: 1000 }
      ];

      const result = deserializer.extractNewTasks(messages);
      expect(result).toHaveLength(1);
    });

    it('should skip new_task without mode or message', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code' }), ts: 1000 }
      ];

      expect(deserializer.extractNewTasks(messages)).toHaveLength(0);
    });

    it('should skip non-new_task tools', () => {
      const messages: UIMessage[] = [
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'read_file', mode: 'code', message: 'Read file' }), ts: 1000 }
      ];

      expect(deserializer.extractNewTasks(messages)).toHaveLength(0);
    });
  });

  // --- extractUserMessages ---

  describe('extractUserMessages', () => {
    it('should extract messages with type=ask and no ask field', () => {
      const messages: UIMessage[] = [
        { type: 'ask', text: 'Initial instruction', ts: 1000 },
        { type: 'ask', ask: 'tool', text: 'tool call', ts: 2000 },
        { type: 'say', say: 'text', text: 'response', ts: 3000 }
      ];

      const result = deserializer.extractUserMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Initial instruction');
    });

    it('should return empty array when no user messages', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'text', text: 'response' },
        { type: 'ask', ask: 'tool', text: 'tool call', ts: 1000 }
      ];

      expect(deserializer.extractUserMessages(messages)).toHaveLength(0);
    });
  });

  // --- extractErrors ---

  describe('extractErrors', () => {
    it('should extract error messages', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'error', text: 'Something went wrong', ts: 1000 },
        { type: 'say', say: 'text', text: 'normal response' },
        { type: 'say', say: 'error', text: 'Another error', ts: 2000 }
      ];

      const result = deserializer.extractErrors(messages);
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no errors', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'text', text: 'ok' }
      ];

      expect(deserializer.extractErrors(messages)).toHaveLength(0);
    });
  });

  // --- getInitialInstruction ---

  describe('getInitialInstruction', () => {
    it('should return text of first user message', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'text', text: 'greeting' },
        { type: 'ask', text: 'Fix the login bug', ts: 1000 },
        { type: 'ask', text: 'Also check auth', ts: 2000 }
      ];

      expect(deserializer.getInitialInstruction(messages)).toBe('Fix the login bug');
    });

    it('should return undefined when no user messages', () => {
      const messages: UIMessage[] = [
        { type: 'say', say: 'text', text: 'response' }
      ];

      expect(deserializer.getInitialInstruction(messages)).toBeUndefined();
    });

    it('should return undefined for empty array', () => {
      expect(deserializer.getInitialInstruction([])).toBeUndefined();
    });
  });

  // --- getMessageStats ---

  describe('getMessageStats', () => {
    it('should count all message types correctly', () => {
      const messages: UIMessage[] = [
        { type: 'ask', text: 'instruction', ts: 1000 },
        { type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'new_task', mode: 'code', message: 'task' }), ts: 2000 },
        { type: 'say', say: 'api_req_started', text: JSON.stringify({ request: 'prompt', cost: 0.05 }), ts: 3000 },
        { type: 'say', say: 'text', text: 'response' },
        { type: 'say', say: 'error', text: 'error msg' },
        { type: 'say', say: 'text', text: 'response 2' }
      ];

      const stats = deserializer.getMessageStats(messages);

      expect(stats.total).toBe(6);
      expect(stats.askMessages).toBe(2);
      expect(stats.sayMessages).toBe(4);
      expect(stats.toolCalls).toBe(1);
      expect(stats.apiRequests).toBe(1);
      expect(stats.newTasks).toBe(1);
      expect(stats.errors).toBe(1);
    });

    it('should return all zeros for empty array', () => {
      const stats = deserializer.getMessageStats([]);

      expect(stats.total).toBe(0);
      expect(stats.askMessages).toBe(0);
      expect(stats.sayMessages).toBe(0);
      expect(stats.toolCalls).toBe(0);
      expect(stats.apiRequests).toBe(0);
      expect(stats.newTasks).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });
});
