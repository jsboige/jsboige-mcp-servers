/**
 * Tests unitaires pour hierarchy-inference
 *
 * Couvre :
 * - extractTaskIdFromText : extraction UUID v4, patterns contextuels
 * - extractParentFromApiHistory : lecture api_conversation_history.json
 * - extractParentFromUiMessages : lecture ui_messages.json
 * - inferParentTaskIdFromContent : chaîne d'inférence complète
 * - Cas limites (vide, null, sans UUID, fichiers invalides)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs/promises before importing the module under test
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  default: { readFile: mockReadFile },
}));

import {
  extractTaskIdFromText,
  extractParentFromApiHistory,
  extractParentFromUiMessages,
  inferParentTaskIdFromContent,
} from '../hierarchy-inference.js';

describe('extractTaskIdFromText', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // === UUID v4 extraction ===

  describe('UUID v4 extraction', () => {
    it('should extract a standard UUID v4', () => {
      const text = 'Task ID: 550e8400-e29b-41d4-a716-446655440000';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should extract UUID from longer text', () => {
      const text = 'Continuing work on task 123e4567-e89b-42d3-a456-556642440000 which was started earlier';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('123e4567-e89b-42d3-a456-556642440000');
    });

    it('should extract first UUID when multiple present', () => {
      const text = 'Tasks: 11111111-1111-4111-8111-111111111111 and 22222222-2222-4222-8222-222222222222';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('should handle uppercase UUIDs', () => {
      const text = 'ID: 550E8400-E29B-41D4-A716-446655440000';
      const result = extractTaskIdFromText(text);
      expect(result?.toLowerCase()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
  });

  // === Contextual patterns ===

  describe('contextual patterns', () => {
    it('should extract from CONTEXTE HÉRITÉ pattern', () => {
      const text = 'CONTEXTE HÉRITÉ de la tâche 550e8400-e29b-41d4-a716-446655440000 qui contenait les résultats';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should extract from ORCHESTRATEUR pattern', () => {
      const text = 'ORCHESTRATEUR principal 12345678-1234-4234-8234-123456789abc gère le workflow';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('12345678-1234-4234-8234-123456789abc');
    });

    it('should extract from tâche parent pattern', () => {
      const text = 'Référence à la tâche parent abcdef01-2345-4678-9abc-def012345678 pour le contexte';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('abcdef01-2345-4678-9abc-def012345678');
    });
  });

  // === Edge cases ===

  describe('edge cases', () => {
    it('should return undefined for empty string', () => {
      expect(extractTaskIdFromText('')).toBeUndefined();
    });

    it('should return undefined for null', () => {
      expect(extractTaskIdFromText(null as any)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(extractTaskIdFromText(undefined as any)).toBeUndefined();
    });

    it('should return undefined for text without UUID', () => {
      expect(extractTaskIdFromText('Just some regular text without any identifiers')).toBeUndefined();
    });

    it('should not match non-v4 UUIDs (wrong version digit)', () => {
      // UUID v4 has '4' as the 13th character
      const text = 'Not v4: 550e8400-e29b-31d4-a716-446655440000'; // version 3
      const result = extractTaskIdFromText(text);
      // Should not match because v4 requires '4' in position 15
      expect(result).toBeUndefined();
    });

    it('should not match UUIDs with wrong variant', () => {
      // UUID v4 has [89ab] as the 17th character
      const text = 'Wrong variant: 550e8400-e29b-41d4-0716-446655440000'; // variant 0
      const result = extractTaskIdFromText(text);
      expect(result).toBeUndefined();
    });
  });
});

// ============================================================
// extractParentFromApiHistory
// ============================================================
describe('extractParentFromApiHistory', () => {
  const testUuid = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('should extract parent UUID from array-format api history', async () => {
    const apiHistory = [
      {
        role: 'user',
        content: `CONTEXTE HÉRITÉ de la tâche ${testUuid} qui contenait les résultats`
      },
      { role: 'assistant', content: 'OK' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path/api_conversation_history.json');
    expect(result).toBe(testUuid);
  });

  it('should extract from content array format', async () => {
    const apiHistory = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Working on task ${testUuid} now` }
        ]
      }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBe(testUuid);
  });

  it('should extract from object-with-messages format', async () => {
    const apiHistory = {
      messages: [
        { role: 'user', content: `Task parent ${testUuid} reference` },
        { role: 'assistant', content: 'Got it' }
      ]
    };
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBe(testUuid);
  });

  it('should return undefined when no user message found', async () => {
    const apiHistory = [
      { role: 'assistant', content: 'Hello' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBeUndefined();
  });

  it('should return undefined when user message has no content', async () => {
    const apiHistory = [{ role: 'user' }];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBeUndefined();
  });

  it('should return undefined when no UUID in content', async () => {
    const apiHistory = [
      { role: 'user', content: 'No UUID here, just regular text' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBeUndefined();
  });

  it('should return undefined on file read error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await extractParentFromApiHistory('/nonexistent/path');
    expect(result).toBeUndefined();
  });

  it('should return undefined on invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not valid json{{{');

    const result = await extractParentFromApiHistory('/fake/path');
    expect(result).toBeUndefined();
  });
});

// ============================================================
// extractParentFromUiMessages
// ============================================================
describe('extractParentFromUiMessages', () => {
  const testUuid = 'abcdef01-2345-4678-9abc-def012345678';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('should extract parent UUID from ui_messages with type=user', async () => {
    const uiMessages = [
      { type: 'user', content: `Continue task ${testUuid}` },
      { type: 'assistant', content: 'Working on it' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

    const result = await extractParentFromUiMessages('/fake/ui_messages.json');
    expect(result).toBe(testUuid);
  });

  it('should extract from role=user format', async () => {
    const uiMessages = [
      { role: 'user', content: `ORCHESTRATEUR ${testUuid} active` }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

    const result = await extractParentFromUiMessages('/fake/path');
    expect(result).toBe(testUuid);
  });

  it('should extract from object-with-messages format', async () => {
    const uiMessages = {
      messages: [
        { type: 'user', content: `Ref: ${testUuid}` }
      ]
    };
    mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

    const result = await extractParentFromUiMessages('/fake/path');
    expect(result).toBe(testUuid);
  });

  it('should return undefined when no user message found', async () => {
    const uiMessages = [
      { type: 'assistant', content: 'Response only' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

    const result = await extractParentFromUiMessages('/fake/path');
    expect(result).toBeUndefined();
  });

  it('should return undefined on file error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await extractParentFromUiMessages('/nonexistent');
    expect(result).toBeUndefined();
  });
});

// ============================================================
// inferParentTaskIdFromContent
// ============================================================
describe('inferParentTaskIdFromContent', () => {
  const testUuid1 = '11111111-1111-4111-8111-111111111111';
  const testUuid2 = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('should return parent from api history when found there', async () => {
    const apiHistory = [
      { role: 'user', content: `Task ${testUuid1} context` }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

    const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
    expect(result).toBe(testUuid1);
  });

  it('should fall back to ui messages when api history has no UUID', async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify([{ role: 'user', content: 'No UUID here' }]))
      .mockResolvedValueOnce(JSON.stringify([{ type: 'user', content: `Parent ${testUuid2}` }]));

    const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
    expect(result).toBe(testUuid2);
  });

  it('should return undefined when neither source has UUID', async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify([{ role: 'user', content: 'Nothing' }]))
      .mockResolvedValueOnce(JSON.stringify([{ type: 'user', content: 'Also nothing' }]));

    const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
    expect(result).toBeUndefined();
  });

  it('should handle api history read error and fall back to ui messages', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(JSON.stringify([{ type: 'user', content: `Task ${testUuid2}` }]));

    const result = await inferParentTaskIdFromContent('/missing/api', '/ui/path', {});
    expect(result).toBe(testUuid2);
  });

  it('should return undefined when both files fail', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await inferParentTaskIdFromContent('/missing1', '/missing2', {});
    expect(result).toBeUndefined();
  });
});
