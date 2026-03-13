/**
 * Tests pour list-conversations.tool.ts
 * Module de listing des conversations Roo et Claude Code
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Grounding conversationnel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock hoisted functions - must be declared before vi.mock
const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn(() => '/Users/test')
}));

// Mock os module BEFORE any imports
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return {
		...actual,
		default: { ...actual, homedir: mockHomedir },
		homedir: mockHomedir
	};
});

// Mock fs/promises with importActual to preserve all exports
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		access: vi.fn()
	};
});

// Mock disk-scanner to avoid scanning actual disk
vi.mock('../task/disk-scanner.js', () => ({
	scanDiskForNewTasks: vi.fn(() => Promise.resolve([]))
}));

// Mock claude-storage-detector
vi.mock('../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: vi.fn(() => Promise.resolve([])),
		analyzeConversation: vi.fn()
	}
}));

// Mock roo-storage-detector
vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: vi.fn(() => Promise.resolve([]))
	}
}));

import * as fs from 'fs/promises';
const mockedFs = vi.mocked(fs);

// Import du module après les mocks
import { listConversationsTool } from '../list-conversations.tool.js';

describe('list-conversations', () => {
  const mockConversationCache = new Map();

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock homedir returns default value from hoisted mock
    mockHomedir.mockReturnValue('/Users/test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(listConversationsTool.definition.name).toBe('list_conversations');
    });

    it('should have description', () => {
      expect(listConversationsTool.definition.description).toBeDefined();
      expect(listConversationsTool.definition.description.length).toBeGreaterThan(0);
    });

    it('should have all expected input parameters', () => {
      const schema = listConversationsTool.definition.inputSchema;
      expect(schema.properties).toHaveProperty('limit');
      expect(schema.properties).toHaveProperty('sortBy');
      expect(schema.properties).toHaveProperty('sortOrder');
      expect(schema.properties).toHaveProperty('workspace');
      expect(schema.properties).toHaveProperty('pendingSubtaskOnly');
      expect(schema.properties).toHaveProperty('contentPattern');
    });

    it('should have sortBy enum values', () => {
      const schema = listConversationsTool.definition.inputSchema;
      expect(schema.properties.sortBy.enum).toEqual(['lastActivity', 'messageCount', 'totalSize']);
    });

    it('should have sortOrder enum values', () => {
      const schema = listConversationsTool.definition.inputSchema;
      expect(schema.properties.sortOrder.enum).toEqual(['asc', 'desc']);
    });
  });

  describe('handler - basic functionality', () => {
    it('should return empty array when cache is empty', async () => {
      const result = await listConversationsTool.handler({}, mockConversationCache);
      const text = result.content[0].text as string;

      expect(text).toBeDefined();
      const _response = JSON.parse(text);
      const parsed = _response.conversations ?? _response;
      expect(parsed).toEqual([]);
    });

    it('should return valid JSON structure', async () => {
      const result = await listConversationsTool.handler({}, mockConversationCache);
      const text = result.content[0].text as string;

      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('should return array structure', async () => {
      const result = await listConversationsTool.handler({}, mockConversationCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('handler - workspace filter', () => {
    it('should filter conversations by workspace', async () => {
      // Create mock skeletons with different workspaces
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000,
            workspace: 'workspace-a'
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000,
            workspace: 'workspace-b'
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { workspace: 'workspace-a' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toHaveLength(1);
    });

    it('should return empty array for non-existent workspace', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000,
            workspace: 'other-workspace'
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { workspace: 'non-existent-workspace' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toEqual([]);
    });
  });

  describe('handler - sortBy parameter', () => {
    it('should sort by lastActivity when specified', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-03T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task3', {
          taskId: 'task3',
          metadata: {
            lastActivity: '2025-01-02T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { sortBy: 'lastActivity' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      // Default sortOrder is desc, so task1 (latest) should be first
      expect(parsed[0].taskId).toBe('task1');
      expect(parsed[1].taskId).toBe('task3');
      expect(parsed[2].taskId).toBe('task2');
    });

    it('should sort by messageCount when specified', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 5,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task3', {
          taskId: 'task3',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 15,
            actionCount: 5,
            totalSize: 1000
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { sortBy: 'messageCount', sortOrder: 'asc' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('task2'); // 5 messages
      expect(parsed[1].taskId).toBe('task1'); // 10 messages
      expect(parsed[2].taskId).toBe('task3'); // 15 messages
    });

    it('should sort by totalSize when specified', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 500
          }
        }],
        ['task3', {
          taskId: 'task3',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 2000
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { sortBy: 'totalSize', sortOrder: 'desc' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('task3'); // 2000 bytes
      expect(parsed[1].taskId).toBe('task1'); // 1000 bytes
      expect(parsed[2].taskId).toBe('task2'); // 500 bytes
    });
  });

  describe('handler - sortOrder parameter', () => {
    it('should sort in descending order by default', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-03T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }]
      ]);

      const result = await listConversationsTool.handler({}, mockCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('task2'); // Latest first
    });

    it('should sort in ascending order when specified', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }],
        ['task2', {
          taskId: 'task2',
          metadata: {
            lastActivity: '2025-01-03T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        }]
      ]);

      const result = await listConversationsTool.handler(
        { sortOrder: 'asc' },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('task1'); // Oldest first
    });
  });

  describe('handler - limit parameter', () => {
    it('should limit number of results', async () => {
      const mockCache = new Map<string, any>();
      for (let i = 0; i < 10; i++) {
        mockCache.set(`task${i}`, {
          taskId: `task${i}`,
          metadata: {
            lastActivity: new Date(Date.now() - i * 3600000).toISOString(),
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        });
      }

      const result = await listConversationsTool.handler(
        { limit: 5 },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toHaveLength(5);
    });

    it('should return all results when limit is not specified', async () => {
      const mockCache = new Map<string, any>();
      for (let i = 0; i < 5; i++) {
        mockCache.set(`task${i}`, {
          taskId: `task${i}`,
          metadata: {
            lastActivity: new Date(Date.now() - i * 3600000).toISOString(),
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000
          }
        });
      }

      const result = await listConversationsTool.handler({}, mockCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toHaveLength(5);
    });
  });

  describe('handler - error handling', () => {
    it('should handle empty cache gracefully', async () => {
      const result = await listConversationsTool.handler({}, mockConversationCache);
      const text = result.content[0].text as string;

      expect(text).toBeDefined();
      // Should return empty array, not error
      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('should handle cache with missing metadata gracefully', async () => {
      const mockCache = new Map<string, any>([
        ['task1', {
          taskId: 'task1',
          metadata: null // Missing metadata
        }]
      ]);

      const result = await listConversationsTool.handler({}, mockCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      // Should handle gracefully
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('result structure validation', () => {
    it('should return valid JSON structure', async () => {
      const result = await listConversationsTool.handler({}, mockConversationCache);
      const text = result.content[0].text as string;

      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('should return array of conversation summaries', async () => {
      const mockCache = new Map<string, any>([
        ['20250101-120000-test-task', {
          taskId: '20250101-120000-test-task',
          metadata: {
            lastActivity: '2025-01-01T12:00:00.000Z',
            createdAt: '2025-01-01T12:00:00.000Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000,
            workspace: 'test-workspace'
          }
        }]
      ]);

      const result = await listConversationsTool.handler({}, mockCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(Array.isArray(parsed)).toBe(true);
      if (parsed.length > 0) {
        expect(parsed[0]).toMatchObject({
          taskId: expect.any(String),
          metadata: {
            lastActivity: expect.any(String),
            messageCount: expect.any(Number),
            totalSize: expect.any(Number)
          }
        });
      }
    });
  });
});
