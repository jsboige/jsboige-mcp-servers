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
// NOTE (#2642): the SUT list-conversations.tool.ts (in src/tools/conversation/) imports these via
// '../task/disk-scanner.js' and '../../utils/*-storage-detector.js' — resolved from ITS dir. From this
// test's dir (src/tools/conversation/__tests__/) the same absolute modules are one level deeper:
// '../../task/disk-scanner.js' and '../../../utils/*-storage-detector.js'. The previous same-literal
// mocks resolved to src/tools/conversation/{task,utils}/ (non-existent) → no-op silently.
vi.mock('../../task/disk-scanner.js', () => ({
	scanDiskForNewTasks: vi.fn(() => Promise.resolve([]))
}));

// Mock claude-storage-detector
vi.mock('../../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: vi.fn(() => Promise.resolve([])),
		analyzeConversation: vi.fn()
	}
}));

// Mock roo-storage-detector
vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: vi.fn(() => Promise.resolve([]))
	}
}));

// Mock SkeletonCacheService (needed for includeArchives / Bug #3 / #1752)
// Both functions hoisted so vi.restoreAllMocks() in afterEach can be safely reset.
const { mockGetCache, mockGetInstance } = vi.hoisted(() => {
	const cacheFn = vi.fn(() => Promise.resolve(new Map()));
	return {
		mockGetCache: cacheFn,
		mockGetInstance: vi.fn(() => ({ getCache: cacheFn }))
	};
});

vi.mock('../../../services/skeleton-cache.service.js', () => ({
	SkeletonCacheService: {
		getInstance: mockGetInstance
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
    it('should honor limit when above the floor (#1245: clamped to [10, 100])', async () => {
      // Create 20 tasks, ask for 15 → returns 15
      const mockCache = new Map<string, any>();
      for (let i = 0; i < 20; i++) {
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
        { limit: 15 },
        mockCache
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toHaveLength(15);
    });

    it('should respect limit as hard cap (#1410: floor only applies to per_page)', async () => {
      // Create 12 tasks, ask for 5 → returns 5 (limit is a hard cap, not page size)
      const mockCache = new Map<string, any>();
      for (let i = 0; i < 12; i++) {
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

  // #1752 Bug #3 — includeArchives loads GDrive cross-machine archives (Tier 3)
  describe('handler - includeArchives parameter (#1752 Bug #3)', () => {
    beforeEach(() => {
      // Re-wire after vi.restoreAllMocks() in afterEach may have cleared implementations.
      mockGetCache.mockResolvedValue(new Map());
      mockGetInstance.mockReturnValue({ getCache: mockGetCache });
    });

    it('should not load archives when includeArchives is false (default)', async () => {
      const result = await listConversationsTool.handler({ includeArchives: false }, new Map());
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toEqual([]);
      expect(mockGetInstance).not.toHaveBeenCalled();
    });

    it('should include gdrive-archive skeletons when includeArchives is true', async () => {
      const archiveSkeleton = {
        taskId: 'archive-task-1',
        metadata: {
          lastActivity: '2025-06-01T10:00:00.000Z',
          createdAt: '2025-06-01T09:00:00.000Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 500,
          dataSource: 'gdrive-archive',
          workspace: 'remote-machine:my-project'
        }
      };

      mockGetCache.mockResolvedValue(new Map([['archive-task-1', archiveSkeleton]]));

      const result = await listConversationsTool.handler(
        { includeArchives: true },
        new Map() // local cache is empty
      );
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBeGreaterThanOrEqual(1);
      const found = parsed.find((c: any) => c.taskId === 'archive-task-1');
      expect(found).toBeDefined();
    });

    it('should exclude gdrive-archive tasks already present in local cache', async () => {
      const localSkeleton = {
        taskId: 'shared-task',
        metadata: {
          lastActivity: '2025-06-01T10:00:00.000Z',
          createdAt: '2025-06-01T09:00:00.000Z',
          messageCount: 8,
          actionCount: 3,
          totalSize: 800,
          workspace: 'my-workspace'
        }
      };
      const archiveSkeleton = {
        taskId: 'shared-task', // same taskId as local
        metadata: {
          lastActivity: '2025-06-01T10:00:00.000Z',
          createdAt: '2025-06-01T09:00:00.000Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 500,
          dataSource: 'gdrive-archive',
          workspace: 'remote-machine:my-project'
        }
      };

      mockGetCache.mockResolvedValue(new Map([['shared-task', archiveSkeleton]]));

      const localCache = new Map([['shared-task', localSkeleton]]);
      const result = await listConversationsTool.handler({ includeArchives: true }, localCache);
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      // Should appear only once (from local cache, not duplicated from archive)
      const matches = parsed.filter((c: any) => c.taskId === 'shared-task');
      expect(matches).toHaveLength(1);
    });

    it('should skip non-gdrive-archive entries from SkeletonCacheService', async () => {
      const localTierSkeleton = {
        taskId: 'local-tier-task',
        metadata: {
          lastActivity: '2025-06-01T10:00:00.000Z',
          createdAt: '2025-06-01T09:00:00.000Z',
          messageCount: 3,
          actionCount: 1,
          totalSize: 300,
          dataSource: 'roo-local', // NOT gdrive-archive
          workspace: 'my-workspace'
        }
      };

      mockGetCache.mockResolvedValue(new Map([['local-tier-task', localTierSkeleton]]));

      const result = await listConversationsTool.handler({ includeArchives: true }, new Map());
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

      // roo-local tasks should not be surfaced via the archive path
      const found = parsed.find((c: any) => c.taskId === 'local-tier-task');
      expect(found).toBeUndefined();
    });

    it('should continue gracefully when SkeletonCacheService throws', async () => {
      mockGetCache.mockRejectedValue(new Error('GDrive unavailable'));

      // Should not throw; just returns local results
      const result = await listConversationsTool.handler({ includeArchives: true }, new Map());
      const _response = JSON.parse(result.content[0].text as string);
      const parsed = _response.conversations ?? _response;

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
