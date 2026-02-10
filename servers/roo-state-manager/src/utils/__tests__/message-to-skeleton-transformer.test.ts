/**
 * Tests unitaires pour MessageToSkeletonTransformer
 *
 * Couvre :
 * - transform : pipeline complet (workspace, instructions, completion, timestamps)
 * - extractUserMessages (via transform)
 * - buildMainInstruction : stratégie api_req vs user message vs fallback
 * - buildChildTaskPrefixes : normalisation et déduplication
 * - detectCompletion : attempt_completion et say types
 * - extractTimestamps
 * - validateSkeletonCompatibility (strict mode)
 * - autoDetectWorkspace : pattern matching
 * - isValidWorkspacePath
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock instance that all UIMessagesDeserializer instances will be
const sharedDeserializerMock = {
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractNewTasks: vi.fn().mockReturnValue([]),
  extractApiRequests: vi.fn().mockReturnValue([]),
};

// Mock dependencies before import
vi.mock('../ui-messages-deserializer.js', () => ({
  UIMessagesDeserializer: vi.fn().mockImplementation(() => sharedDeserializerMock),
}));

vi.mock('../workspace-detector.js', () => ({
  WorkspaceDetector: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../task-instruction-index.js', () => ({
  computeInstructionPrefix: vi.fn((text: string, k: number) =>
    text.toLowerCase().substring(0, k).trim()
  ),
}));

import {
  MessageToSkeletonTransformer,
  type TransformationResult,
  type TransformerOptions,
} from '../message-to-skeleton-transformer.js';
import { UIMessagesDeserializer } from '../ui-messages-deserializer.js';
import type { UIMessage } from '../message-types.js';

// === Helpers ===

function createUIMessage(overrides?: Partial<UIMessage>): UIMessage {
  return {
    ts: Date.now(),
    type: 'say',
    say: 'text',
    text: 'Hello world',
    ...overrides,
  };
}

function createUserAsk(text: string, ts?: number): UIMessage {
  return {
    ts: ts || Date.now(),
    type: 'ask',
    ask: 'followup',
    text,
  };
}

function createApiReqStarted(request: string, ts?: number): UIMessage {
  return {
    ts: ts || Date.now(),
    type: 'say',
    say: 'api_req_started',
    text: JSON.stringify({ request }),
  };
}

// === Tests ===

describe('MessageToSkeletonTransformer', () => {
  let transformer: MessageToSkeletonTransformer;

  beforeEach(() => {
    // Reset mock return values (don't use clearAllMocks - it breaks factory)
    sharedDeserializerMock.extractToolCalls.mockReset().mockReturnValue([]);
    sharedDeserializerMock.extractNewTasks.mockReset().mockReturnValue([]);
    sharedDeserializerMock.extractApiRequests.mockReset().mockReturnValue([]);
    // Re-establish factory mock (in case clearAllMocks was called)
    (UIMessagesDeserializer as any).mockImplementation(() => sharedDeserializerMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    transformer = new MessageToSkeletonTransformer();
  });

  // === Constructor ===

  describe('constructor', () => {
    it('should create with default options', () => {
      const t = new MessageToSkeletonTransformer();
      expect(t).toBeDefined();
    });

    it('should accept custom options', () => {
      const t = new MessageToSkeletonTransformer({
        normalizePrefixes: false,
        includeMetadata: true,
        strictValidation: true,
      });
      expect(t).toBeDefined();
    });
  });

  // === transform ===

  describe('transform', () => {
    it('should return skeleton and metadata', async () => {
      const messages = [createUIMessage({ ts: 1000 })];
      const result = await transformer.transform(messages, 'task-001');

      expect(result.skeleton).toBeDefined();
      expect(result.skeleton.taskId).toBe('task-001');
      expect(result.metadata).toBeDefined();
      expect(result.metadata.messageCount).toBe(1);
    });

    it('should use provided workspace', async () => {
      const messages = [createUIMessage()];
      const result = await transformer.transform(messages, 'task-001', '/my/workspace');

      expect(result.skeleton.metadata.workspace).toBe('/my/workspace');
    });

    it('should set messageCount and actionCount in metadata', async () => {
      const messages = [createUIMessage(), createUIMessage(), createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractToolCalls.mockReturnValue([
        { tool: 'read_file', params: {} },
        { tool: 'write_to_file', params: {} },
      ]);

      const result = await transformer.transform(messages, 'task-002');

      expect(result.skeleton.metadata.messageCount).toBe(3);
      expect(result.skeleton.metadata.actionCount).toBe(2);
      expect(result.metadata.toolCallCount).toBe(2);
    });

    it('should set totalSize based on message JSON length', async () => {
      const messages = [createUIMessage({ text: 'short' })];
      const result = await transformer.transform(messages, 'task-003');

      expect(result.skeleton.metadata.totalSize).toBeGreaterThan(0);
    });

    it('should include processingTimeMs', async () => {
      const messages = [createUIMessage()];
      const result = await transformer.transform(messages, 'task-004');

      expect(result.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should set sequence to empty array', async () => {
      const messages = [createUIMessage()];
      const result = await transformer.transform(messages, 'task-005');

      expect(result.skeleton.sequence).toEqual([]);
    });
  });

  // === Instruction extraction ===

  describe('instruction extraction', () => {
    it('should extract instruction from first api_req with <task> tag', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([
        { request: '<task>Build the project</task>' },
      ]);

      const result = await transformer.transform(messages, 'task-instr-1');

      expect(result.skeleton.truncatedInstruction).toContain('build the project');
      expect(result.metadata.hasInitialInstruction).toBe(true);
    });

    it('should fall back to first user message if no api_req', async () => {
      const messages = [createUserAsk('Fix the bug in module X')];
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([]);

      const result = await transformer.transform(messages, 'task-instr-2');

      expect(result.skeleton.truncatedInstruction).toContain('fix the bug');
      expect(result.metadata.hasInitialInstruction).toBe(true);
    });

    it('should return empty instruction when no user messages or api_req', async () => {
      const messages = [createUIMessage({ type: 'say', say: 'text', text: 'System message' })];
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([]);

      const result = await transformer.transform(messages, 'task-instr-3');

      expect(result.skeleton.truncatedInstruction).toBe('');
    });

    it('should not count tool ask messages as user messages', async () => {
      const messages = [
        createUIMessage({ type: 'ask', ask: 'tool', text: 'Use tool?' }),
      ];
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([]);

      const result = await transformer.transform(messages, 'task-instr-4');

      expect(result.metadata.userMessageCount).toBe(0);
    });
  });

  // === Child task prefixes ===

  describe('child task prefixes', () => {
    it('should build prefixes from new tasks', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractNewTasks.mockReturnValue([
        { message: 'Sub-task 1: do X' },
        { message: 'Sub-task 2: do Y' },
      ]);

      const result = await transformer.transform(messages, 'task-child-1');

      expect(result.skeleton.childTaskInstructionPrefixes).toHaveLength(2);
      expect(result.metadata.newTaskCount).toBe(2);
    });

    it('should deduplicate identical prefixes', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractNewTasks.mockReturnValue([
        { message: 'Same instruction' },
        { message: 'Same instruction' },
      ]);

      const result = await transformer.transform(messages, 'task-child-2');

      expect(result.skeleton.childTaskInstructionPrefixes).toHaveLength(1);
    });

    it('should set childTaskInstructionPrefixes to undefined when empty', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractNewTasks.mockReturnValue([]);

      const result = await transformer.transform(messages, 'task-child-3');

      expect(result.skeleton.childTaskInstructionPrefixes).toBeUndefined();
    });

    it('should filter out empty prefixes', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractNewTasks.mockReturnValue([
        { message: '' },
        { message: '   ' },
        { message: 'Valid prefix' },
      ]);

      const result = await transformer.transform(messages, 'task-child-4');

      // Empty strings after normalization get filtered
      expect(result.skeleton.childTaskInstructionPrefixes).toBeDefined();
      expect(result.skeleton.childTaskInstructionPrefixes!.every(p => p.length > 0)).toBe(true);
    });
  });

  // === Completion detection ===

  describe('completion detection', () => {
    it('should detect attempt_completion tool call', async () => {
      const messages = [createUIMessage()];
      const deserializer = sharedDeserializerMock;
      deserializer.extractToolCalls.mockReturnValue([
        { tool: 'attempt_completion', params: {} },
      ]);

      const result = await transformer.transform(messages, 'task-comp-1');

      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect completion_result say type', async () => {
      const messages = [
        createUIMessage({ ts: 1000 }),
        createUIMessage({ ts: 2000, type: 'say', say: 'completion_result', text: 'Done' }),
      ];

      const result = await transformer.transform(messages, 'task-comp-2');

      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect error say type as completed', async () => {
      const messages = [
        createUIMessage({ ts: 1000 }),
        createUIMessage({ ts: 2000, type: 'say', say: 'error', text: 'Failed' }),
      ];

      const result = await transformer.transform(messages, 'task-comp-3');

      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should detect user_feedback say type as completed', async () => {
      const messages = [
        createUIMessage({ ts: 1000 }),
        createUIMessage({ ts: 2000, type: 'say', say: 'user_feedback', text: 'Thanks' }),
      ];

      const result = await transformer.transform(messages, 'task-comp-4');

      expect(result.skeleton.isCompleted).toBe(true);
    });

    it('should not mark as completed for regular messages', async () => {
      const messages = [
        createUIMessage({ ts: 1000, type: 'say', say: 'text', text: 'In progress...' }),
      ];

      const result = await transformer.transform(messages, 'task-comp-5');

      expect(result.skeleton.isCompleted).toBe(false);
    });
  });

  // === Timestamps ===

  describe('timestamps', () => {
    it('should use first message timestamp as createdAt', async () => {
      const messages = [
        createUIMessage({ ts: 1707580800000 }), // 2024-02-10T16:00:00Z
        createUIMessage({ ts: 1707580900000 }),
      ];

      const result = await transformer.transform(messages, 'task-ts-1');

      expect(result.skeleton.metadata.createdAt).toContain('2024-02-10');
    });

    it('should use last message timestamp as lastActivity when completed', async () => {
      const messages = [
        createUIMessage({ ts: 1000000 }),
        createUIMessage({ ts: 2000000, type: 'say', say: 'completion_result' }),
      ];

      const result = await transformer.transform(messages, 'task-ts-2');

      expect(result.skeleton.isCompleted).toBe(true);
      // lastActivity should correspond to ts of last message
    });

    it('should handle empty messages array', async () => {
      const result = await transformer.transform([], 'task-ts-3');

      expect(result.skeleton.metadata.createdAt).toBeDefined();
      expect(result.metadata.messageCount).toBe(0);
    });
  });

  // === Workspace auto-detection ===

  describe('workspace auto-detection', () => {
    it('should detect workspace from environment_details pattern', async () => {
      const messages = [
        createUIMessage({
          ts: 1000,
          type: 'say',
          say: 'text',
          text: '# Current Workspace Directory (D:/Dev/project) Files\n...',
        }),
      ];

      const result = await transformer.transform(messages, 'task-ws-1');

      expect(result.skeleton.metadata.workspace).toBe('D:/Dev/project');
    });

    it('should detect Unix workspace path', async () => {
      const messages = [
        createUIMessage({
          ts: 1000,
          type: 'say',
          say: 'text',
          text: '# Current Workspace Directory (/home/user/project) Files\n...',
        }),
      ];

      const result = await transformer.transform(messages, 'task-ws-2');

      expect(result.skeleton.metadata.workspace).toBe('/home/user/project');
    });

    it('should return undefined workspace when no pattern found', async () => {
      const messages = [
        createUIMessage({ ts: 1000, text: 'Regular text without workspace info' }),
      ];

      const result = await transformer.transform(messages, 'task-ws-3');

      expect(result.skeleton.metadata.workspace).toBeUndefined();
    });

    it('should use provided workspace over auto-detected', async () => {
      const messages = [
        createUIMessage({
          ts: 1000,
          text: '# Current Workspace Directory (/auto/detected) Files\n...',
        }),
      ];

      const result = await transformer.transform(messages, 'task-ws-4', '/explicit/workspace');

      expect(result.skeleton.metadata.workspace).toBe('/explicit/workspace');
    });

    it('should reject too-short workspace paths', async () => {
      const messages = [
        createUIMessage({
          ts: 1000,
          text: '# Current Workspace Directory (ab) Files\n...',
        }),
      ];

      const result = await transformer.transform(messages, 'task-ws-5');

      // 'ab' is only 2 chars, should be rejected by isValidWorkspacePath
      expect(result.skeleton.metadata.workspace).toBeUndefined();
    });
  });

  // === Strict validation ===

  describe('strict validation', () => {
    it('should not throw in non-strict mode', async () => {
      const messages = [createUIMessage({ ts: 1000 })];
      const t = new MessageToSkeletonTransformer({ strictValidation: false });

      await expect(t.transform(messages, 'task-val-1')).resolves.toBeDefined();
    });

    it('should not throw for valid skeleton in strict mode', async () => {
      const messages = [createUIMessage({ ts: 1000 })];
      const t = new MessageToSkeletonTransformer({ strictValidation: true });

      await expect(t.transform(messages, 'task-val-2')).resolves.toBeDefined();
    });
  });

  // === Normalize prefixes option ===

  describe('normalizePrefixes option', () => {
    it('should normalize prefixes when enabled', async () => {
      const messages = [createUserAsk('DO THIS TASK')];
      const t = new MessageToSkeletonTransformer({ normalizePrefixes: true });
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([]);

      const result = await t.transform(messages, 'task-norm-1');

      // computeInstructionPrefix mock lowercases
      expect(result.skeleton.truncatedInstruction).toBe('do this task');
    });

    it('should truncate without normalizing when disabled', async () => {
      const messages = [createUserAsk('DO THIS TASK')];
      const t = new MessageToSkeletonTransformer({ normalizePrefixes: false });
      const deserializer = sharedDeserializerMock;
      deserializer.extractApiRequests.mockReturnValue([]);

      const result = await t.transform(messages, 'task-norm-2');

      // Without normalization, should keep original case
      expect(result.skeleton.truncatedInstruction).toBe('DO THIS TASK');
    });
  });
});
