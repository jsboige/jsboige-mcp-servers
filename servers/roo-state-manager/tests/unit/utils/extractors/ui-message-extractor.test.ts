/**
 * Tests unitaires pour ui-message-extractor.ts
 * Couverture des 5 extracteurs + helper extractTextFromMessage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mock functions are available when vi.mock factory is hoisted
const { mockCreateInstruction, mockExtractTimestamp } = vi.hoisted(() => ({
  mockCreateInstruction: vi.fn(),
  mockExtractTimestamp: vi.fn(),
}));

vi.mock('../../../../src/utils/message-pattern-extractors.js', () => ({
  createInstruction: mockCreateInstruction,
  extractTimestamp: mockExtractTimestamp,
  PatternExtractor: class {}, // interface, not used at runtime
}));

import {
  UiAskToolExtractor,
  UiObjectExtractor,
  UiXmlPatternExtractor,
  UiSimpleTaskExtractor,
  UiLegacyExtractor,
} from '../../../../src/utils/extractors/ui-message-extractor.js';

// Re-import the module to access extractTextFromMessage indirectly
// Since extractTextFromMessage is not exported, we test it via the extractors that use it.

const FAKE_TIMESTAMP = 1700000000000;

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractTimestamp.mockReturnValue(FAKE_TIMESTAMP);
});

// ============================================================
// Helper: extractTextFromMessage (tested indirectly via extractors)
// ============================================================

describe('extractTextFromMessage (via UiXmlPatternExtractor)', () => {
  let extractor: UiXmlPatternExtractor;

  beforeEach(() => {
    extractor = new UiXmlPatternExtractor();
    mockCreateInstruction.mockReturnValue({
      timestamp: FAKE_TIMESTAMP,
      mode: 'code',
      message: 'A valid task message content here',
    });
  });

  it('extracts text from message.text (string)', () => {
    const msg = {
      type: 'say',
      text: '<new_task><mode>code</mode><message>A valid task message content here</message></new_task>',
    };
    expect(extractor.canHandle(msg)).toBe(true);
    const result = extractor.extract(msg);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts text from message.content (string)', () => {
    const msg = {
      type: 'say',
      content: '<new_task><mode>code</mode><message>A valid task message content here</message></new_task>',
    };
    expect(extractor.canHandle(msg)).toBe(true);
    const result = extractor.extract(msg);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts text from message.content (OpenAI array format)', () => {
    const msg = {
      type: 'say',
      content: [
        { type: 'text', text: '<new_task><mode>code</mode><message>A valid task message content here</message></new_task>' },
      ],
    };
    expect(extractor.canHandle(msg)).toBe(true);
    const result = extractor.extract(msg);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when no text can be extracted', () => {
    const msg = { type: 'say' };
    expect(extractor.canHandle(msg)).toBe(false);
  });
});

// ============================================================
// UiAskToolExtractor
// ============================================================

describe('UiAskToolExtractor', () => {
  let extractor: UiAskToolExtractor;

  beforeEach(() => {
    extractor = new UiAskToolExtractor();
  });

  describe('getPatternName', () => {
    it('returns correct pattern name', () => {
      expect(extractor.getPatternName()).toBe('UI Ask/Tool Extractor');
    });
  });

  describe('canHandle', () => {
    it('returns true for type=ask, ask=tool with string text', () => {
      expect(extractor.canHandle({ type: 'ask', ask: 'tool', text: '{}' })).toBe(true);
    });

    it('returns false when type is not ask', () => {
      expect(extractor.canHandle({ type: 'say', ask: 'tool', text: '{}' })).toBe(false);
    });

    it('returns false when ask is not tool', () => {
      expect(extractor.canHandle({ type: 'ask', ask: 'followup', text: '{}' })).toBe(false);
    });

    it('returns false when text is not a string', () => {
      expect(extractor.canHandle({ type: 'ask', ask: 'tool', text: 42 })).toBe(false);
    });

    it('returns false when text is missing', () => {
      expect(extractor.canHandle({ type: 'ask', ask: 'tool' })).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts instruction from valid newTask JSON', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'Do something meaningful' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        type: 'ask',
        ask: 'tool',
        text: JSON.stringify({ tool: 'newTask', mode: 'code', content: 'Do something meaningful' }),
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(fakeInstruction);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'code', 'Do something meaningful', 20);
    });

    it('returns empty array when tool is not newTask', () => {
      const msg = {
        type: 'ask',
        ask: 'tool',
        text: JSON.stringify({ tool: 'otherTool', content: 'something' }),
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });

    it('returns empty array when JSON.parse fails', () => {
      const msg = {
        type: 'ask',
        ask: 'tool',
        text: 'not valid json {{{',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });

    it('returns empty array when createInstruction returns null', () => {
      mockCreateInstruction.mockReturnValue(null);

      const msg = {
        type: 'ask',
        ask: 'tool',
        text: JSON.stringify({ tool: 'newTask', content: 'short' }),
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('uses default mode "task" when mode is not in JSON', () => {
      mockCreateInstruction.mockReturnValue({ timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'content' });

      const msg = {
        type: 'ask',
        ask: 'tool',
        text: JSON.stringify({ tool: 'newTask', content: 'content with enough length here' }),
      };

      extractor.extract(msg);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'task', 'content with enough length here', 20);
    });
  });
});

// ============================================================
// UiObjectExtractor
// ============================================================

describe('UiObjectExtractor', () => {
  let extractor: UiObjectExtractor;

  beforeEach(() => {
    extractor = new UiObjectExtractor();
  });

  describe('getPatternName', () => {
    it('returns correct pattern name', () => {
      expect(extractor.getPatternName()).toBe('UI Object Extractor');
    });
  });

  describe('canHandle', () => {
    it('returns true when text is an object', () => {
      expect(extractor.canHandle({ type: 'say', text: { tool: 'newTask' } })).toBe(true);
    });

    it('returns true when content is an object', () => {
      expect(extractor.canHandle({ type: 'say', content: { tool: 'newTask' } })).toBe(true);
    });

    it('returns true when content is an array with text items', () => {
      expect(extractor.canHandle({ type: 'say', content: [{ type: 'text', text: 'hello' }] })).toBe(true);
    });

    it('returns false when text is a string', () => {
      expect(extractor.canHandle({ type: 'say', text: 'plain string' })).toBe(false);
    });

    it('returns false when content is a string', () => {
      expect(extractor.canHandle({ type: 'say', content: 'plain string' })).toBe(false);
    });

    it('returns true for array with non-text items (typeof [] is object)', () => {
      // Arrays are typeof 'object', so the first condition catches them regardless of content
      expect(extractor.canHandle({ type: 'say', content: [{ type: 'image', url: 'x' }] })).toBe(true);
    });

    it('returns false for empty object', () => {
      expect(extractor.canHandle({})).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts from array content with <task> tags', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'This is a task that is long enough' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        content: [
          { type: 'text', text: '<task>This is a task that is long enough to pass validation checks</task>' },
        ],
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(fakeInstruction);
    });

    it('skips <task> content shorter than 20 chars', () => {
      const msg = {
        content: [
          { type: 'text', text: '<task>short</task>' },
        ],
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });

    it('extracts multiple <task> tags from array content', () => {
      mockCreateInstruction
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'First task long enough' })
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'Second task long enough' });

      const msg = {
        content: [
          { type: 'text', text: '<task>First task that is definitely long enough to pass</task><task>Second task that is definitely long enough to pass</task>' },
        ],
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(2);
    });

    it('extracts from object text with tool=newTask', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'Task content here' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        text: { tool: 'newTask', mode: 'code', content: 'Task content here with enough length' },
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'code', 'Task content here with enough length', 20);
    });

    it('extracts from object content with tool=newTask', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'Content here' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        content: { tool: 'newTask', content: 'Content here with enough length to be valid' },
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
    });

    it('returns empty when object has no tool=newTask', () => {
      const msg = {
        text: { tool: 'otherTool', content: 'something' },
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('returns empty when text and content objects are both null', () => {
      const msg = { text: null, content: null };
      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });
  });
});

// ============================================================
// UiXmlPatternExtractor
// ============================================================

describe('UiXmlPatternExtractor', () => {
  let extractor: UiXmlPatternExtractor;

  beforeEach(() => {
    extractor = new UiXmlPatternExtractor();
  });

  describe('getPatternName', () => {
    it('returns correct pattern name', () => {
      expect(extractor.getPatternName()).toBe('UI XML Pattern Extractor');
    });
  });

  describe('canHandle', () => {
    it('returns true for type=tool_result with string content', () => {
      expect(extractor.canHandle({ type: 'tool_result', content: 'some text' })).toBe(true);
    });

    it('returns true for type=say with string text', () => {
      expect(extractor.canHandle({ type: 'say', text: 'some text' })).toBe(true);
    });

    it('returns true for role=user with string text', () => {
      expect(extractor.canHandle({ role: 'user', text: 'some text' })).toBe(true);
    });

    it('returns true for role=assistant with string content', () => {
      expect(extractor.canHandle({ role: 'assistant', content: 'some text' })).toBe(true);
    });

    it('returns true for role=user with array content', () => {
      expect(extractor.canHandle({ role: 'user', content: [{ type: 'text', text: 'x' }] })).toBe(true);
    });

    it('returns false for type=tool_result with non-string content', () => {
      expect(extractor.canHandle({ type: 'tool_result', content: 42 })).toBe(false);
    });

    it('returns false for unrecognized type and role', () => {
      expect(extractor.canHandle({ type: 'other', text: 'some text' })).toBe(false);
    });

    it('returns false when no text or content', () => {
      expect(extractor.canHandle({ type: 'say' })).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts from closed <new_task> XML tags', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'Do something' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        type: 'say',
        text: '<new_task><mode>code</mode><message>Do something meaningful with the codebase</message></new_task>',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'code', 'Do something meaningful with the codebase', 10);
    });

    it('extracts from unclosed <new_task> XML tags (legacy)', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'debug', message: 'Debug this' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      // Unclosed: no </new_task> closing tag
      const msg = {
        type: 'tool_result',
        content: '<new_task><mode>debug</mode><message>Debug this issue with the current implementation</message>',
      };

      const result = extractor.extract(msg);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts multiple <new_task> patterns', () => {
      mockCreateInstruction
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'First' })
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'debug', message: 'Second' });

      const msg = {
        type: 'say',
        text: '<new_task><mode>code</mode><message>First task with enough content</message></new_task><new_task><mode>debug</mode><message>Second task with enough content</message></new_task>',
      };

      const result = extractor.extract(msg);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array when no XML patterns match', () => {
      const msg = {
        type: 'say',
        text: 'Just a plain message without any XML tags',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });

    it('returns empty when text extraction yields null', () => {
      const msg = { type: 'say' }; // canHandle returns false, but extract should still be safe
      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('handles OpenAI array content format', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'architect', message: 'Design this' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        role: 'assistant',
        content: [
          { type: 'text', text: '<new_task><mode>architect</mode><message>Design this system architecture properly</message></new_task>' },
        ],
      };

      const result = extractor.extract(msg);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================
// UiSimpleTaskExtractor
// ============================================================

describe('UiSimpleTaskExtractor', () => {
  let extractor: UiSimpleTaskExtractor;

  beforeEach(() => {
    extractor = new UiSimpleTaskExtractor();
  });

  describe('getPatternName', () => {
    it('returns correct pattern name', () => {
      expect(extractor.getPatternName()).toBe('UI Simple Task Extractor');
    });
  });

  describe('canHandle', () => {
    it('returns true for type=say with string text', () => {
      expect(extractor.canHandle({ type: 'say', text: 'hello' })).toBe(true);
    });

    it('returns true for role=user with string content', () => {
      expect(extractor.canHandle({ role: 'user', content: 'hello' })).toBe(true);
    });

    it('returns true for role=assistant with array content', () => {
      expect(extractor.canHandle({ role: 'assistant', content: [{ type: 'text', text: 'x' }] })).toBe(true);
    });

    it('returns false for type=tool_result', () => {
      expect(extractor.canHandle({ type: 'tool_result', text: 'hello' })).toBe(false);
    });

    it('returns false when no recognized type or role', () => {
      expect(extractor.canHandle({ type: 'ask', text: 'hello' })).toBe(false);
    });

    it('returns false when no text or content fields', () => {
      expect(extractor.canHandle({ type: 'say' })).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts from <task> tags with sufficient length', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'A task' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        type: 'say',
        text: '<task>This is a task description that is long enough to pass the minimum threshold</task>',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      const taskContent = 'This is a task description that is long enough to pass the minimum threshold';
      // Content is truncated to 200 chars in the extractor
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'task', taskContent.substring(0, 200), 20);
    });

    it('skips <task> content shorter than 20 characters', () => {
      const msg = {
        type: 'say',
        text: '<task>short content</task>',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });

    it('extracts multiple <task> tags', () => {
      mockCreateInstruction
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'First' })
        .mockReturnValueOnce({ timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'Second' });

      const msg = {
        role: 'user',
        text: '<task>First task description long enough for validation</task><task>Second task description long enough for validation</task>',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(2);
    });

    it('returns empty when no <task> tags present', () => {
      const msg = {
        type: 'say',
        text: 'Just a plain message without task tags',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('returns empty when extracted text is null', () => {
      const msg = { type: 'say' };
      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('truncates content to 200 characters', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'long' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const longContent = 'A'.repeat(300);
      const msg = {
        type: 'say',
        text: `<task>${longContent}</task>`,
      };

      extractor.extract(msg);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'task', 'A'.repeat(200), 20);
    });

    it('extracts from string content field', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'task', message: 'Content' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        role: 'assistant',
        content: '<task>Content extracted from the content field with enough length</task>',
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
    });
  });
});

// ============================================================
// UiLegacyExtractor
// ============================================================

describe('UiLegacyExtractor', () => {
  let extractor: UiLegacyExtractor;

  beforeEach(() => {
    extractor = new UiLegacyExtractor();
  });

  describe('getPatternName', () => {
    it('returns correct pattern name', () => {
      expect(extractor.getPatternName()).toBe('UI Legacy Extractor');
    });
  });

  describe('canHandle', () => {
    it('returns true for type=tool_call with content.tool=new_task', () => {
      expect(extractor.canHandle({ type: 'tool_call', content: { tool: 'new_task' } })).toBe(true);
    });

    it('returns false when type is not tool_call', () => {
      expect(extractor.canHandle({ type: 'say', content: { tool: 'new_task' } })).toBe(false);
    });

    it('returns false when content.tool is not new_task', () => {
      expect(extractor.canHandle({ type: 'tool_call', content: { tool: 'other' } })).toBe(false);
    });

    it('returns falsy when content is missing', () => {
      expect(extractor.canHandle({ type: 'tool_call' })).toBeFalsy();
    });

    it('returns falsy when content is null', () => {
      expect(extractor.canHandle({ type: 'tool_call', content: null })).toBeFalsy();
    });
  });

  describe('extract', () => {
    it('extracts instruction from legacy tool_call', () => {
      const fakeInstruction = { timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'Legacy task' };
      mockCreateInstruction.mockReturnValue(fakeInstruction);

      const msg = {
        type: 'tool_call',
        content: { tool: 'new_task', mode: 'code', message: 'Legacy task content here' },
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(fakeInstruction);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'code', 'Legacy task content here', 1);
    });

    it('uses default mode "legacy" when mode is not specified', () => {
      mockCreateInstruction.mockReturnValue({ timestamp: FAKE_TIMESTAMP, mode: 'legacy', message: 'content' });

      const msg = {
        type: 'tool_call',
        content: { tool: 'new_task', message: 'Some legacy message content' },
      };

      extractor.extract(msg);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'legacy', 'Some legacy message content', 1);
    });

    it('uses empty string when message is not in content', () => {
      mockCreateInstruction.mockReturnValue(null); // empty string is too short even with minLength=1

      const msg = {
        type: 'tool_call',
        content: { tool: 'new_task' },
      };

      const result = extractor.extract(msg);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'legacy', '', 1);
    });

    it('returns empty array when createInstruction returns null', () => {
      mockCreateInstruction.mockReturnValue(null);

      const msg = {
        type: 'tool_call',
        content: { tool: 'new_task', mode: 'code', message: '' },
      };

      const result = extractor.extract(msg);
      expect(result).toHaveLength(0);
    });

    it('uses minimum length of 1 (lowest threshold)', () => {
      mockCreateInstruction.mockReturnValue({ timestamp: FAKE_TIMESTAMP, mode: 'code', message: 'x' });

      const msg = {
        type: 'tool_call',
        content: { tool: 'new_task', mode: 'code', message: 'x' },
      };

      const result = extractor.extract(msg);
      expect(mockCreateInstruction).toHaveBeenCalledWith(FAKE_TIMESTAMP, 'code', 'x', 1);
      expect(result).toHaveLength(1);
    });
  });
});
