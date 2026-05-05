/**
 * Unit tests for background-services.ts
 *
 * Covers:
 * - toHeader: pure function extracting SkeletonHeader from ConversationSkeleton
 * - loadSkeletonsFromDisk: loads skeleton index from _skeleton_index.json
 *   (exercises the private loadSkeletonsFromIndex internally)
 * - saveSkeletonIndex: writes index from cache to disk
 * - loadFullSkeleton: loads a single full skeleton on demand
 * - classifyIndexingError: error classification for Qdrant indexing
 *
 * Issue: #1110 (startup speed)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      access: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});

// Mock RooStorageDetector
vi.mock('../../../src/utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    analyzeConversation: vi.fn(),
    findConversationById: vi.fn(),
  },
}));

// Mock TaskArchiver (dynamically imported)
vi.mock('../../../src/services/task-archiver/index.js', () => ({
  TaskArchiver: {
    archiveTask: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock TaskIndexer
vi.mock('../../../src/services/task-indexer.js', () => {
  const indexTaskSpy = vi.fn().mockResolvedValue([]);
  const countPointsByHostOsSpy = vi.fn().mockResolvedValue(0);

  class MockTaskIndexer {
    async indexTask(taskId: string, source: 'roo' | 'claude-code') {
      return indexTaskSpy(taskId, source);
    }
    async countPointsByHostOs(hostOs: string) {
      return countPointsByHostOsSpy(hostOs);
    }
  }

  (MockTaskIndexer as any).indexTaskSpy = indexTaskSpy;
  (MockTaskIndexer as any).countPointsByHostOsSpy = countPointsByHostOsSpy;

  return {
    TaskIndexer: MockTaskIndexer,
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
  };
});

import {
  toHeader,
  loadSkeletonsFromDisk,
  saveSkeletonIndex,
  loadFullSkeleton,
  classifyIndexingError,
} from '../../../src/services/background-services.js';
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
import type { ConversationSkeleton, SkeletonHeader, SkeletonMetadata } from '../../../src/types/conversation.js';

// Typed mock accessors
const mockFs = fs as unknown as {
  readdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
};

const mockDetector = RooStorageDetector as unknown as {
  detectStorageLocations: ReturnType<typeof vi.fn>;
  analyzeConversation: ReturnType<typeof vi.fn>;
  findConversationById: ReturnType<typeof vi.fn>;
};

// === Helpers ===

function makeMetadata(overrides?: Partial<SkeletonMetadata>): SkeletonMetadata {
  return {
    title: 'Test Task',
    lastActivity: '2026-04-25T12:00:00Z',
    createdAt: '2026-04-25T10:00:00Z',
    messageCount: 5,
    actionCount: 2,
    totalSize: 2048,
    ...overrides,
  };
}

function makeSkeleton(taskId: string, overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
  return {
    taskId,
    parentTaskId: undefined,
    metadata: makeMetadata(),
    isCompleted: false,
    truncatedInstruction: 'Do something useful',
    childTaskInstructionPrefixes: ['prefix-1', 'prefix-2'],
    sequence: [
      { role: 'user', content: 'Hello', timestamp: '2026-04-25T10:00:00Z', isTruncated: false },
      { role: 'assistant', content: 'Hi there', timestamp: '2026-04-25T10:01:00Z', isTruncated: false },
    ],
    ...overrides,
  };
}

function makeHeader(entry: { taskId: string; parentTaskId?: string; metadata?: SkeletonMetadata }): SkeletonHeader {
  return {
    taskId: entry.taskId,
    parentTaskId: entry.parentTaskId,
    metadata: entry.metadata ?? makeMetadata(),
    isCompleted: false,
  };
}

function makeIndex(entries: SkeletonHeader[]) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

// ===================================================================
// toHeader - pure function, no mocking needed
// ===================================================================
describe('toHeader', () => {
  it('should extract all header fields from a full skeleton', () => {
    const skeleton = makeSkeleton('task-001');

    const header = toHeader(skeleton);

    expect(header.taskId).toBe('task-001');
    expect(header.parentTaskId).toBeUndefined();
    expect(header.metadata).toBe(skeleton.metadata);
    expect(header.isCompleted).toBe(false);
    expect(header.truncatedInstruction).toBe('Do something useful');
    expect(header.childTaskInstructionPrefixes).toEqual(['prefix-1', 'prefix-2']);
  });

  it('should NOT include sequence data in the header', () => {
    const skeleton = makeSkeleton('task-002');

    const header = toHeader(skeleton);

    expect((header as any).sequence).toBeUndefined();
  });

  it('should preserve parentTaskId when present', () => {
    const skeleton = makeSkeleton('task-child', { parentTaskId: 'task-parent' });

    const header = toHeader(skeleton);

    expect(header.parentTaskId).toBe('task-parent');
  });

  it('should preserve isCompleted=true', () => {
    const skeleton = makeSkeleton('task-done', { isCompleted: true });

    const header = toHeader(skeleton);

    expect(header.isCompleted).toBe(true);
  });

  it('should handle missing optional fields', () => {
    const skeleton: ConversationSkeleton = {
      taskId: 'task-minimal',
      metadata: makeMetadata(),
      isCompleted: false,
      sequence: [],
    };

    const header = toHeader(skeleton);

    expect(header.taskId).toBe('task-minimal');
    expect(header.truncatedInstruction).toBeUndefined();
    expect(header.childTaskInstructionPrefixes).toBeUndefined();
    expect(header.parentTaskId).toBeUndefined();
  });

  it('should handle empty childTaskInstructionPrefixes array', () => {
    const skeleton = makeSkeleton('task-003', { childTaskInstructionPrefixes: [] });

    const header = toHeader(skeleton);

    expect(header.childTaskInstructionPrefixes).toEqual([]);
  });

  it('should preserve metadata reference (not deep clone)', () => {
    const skeleton = makeSkeleton('task-ref');

    const header = toHeader(skeleton);

    // Same reference - toHeader does not clone metadata
    expect(header.metadata).toBe(skeleton.metadata);
  });

  it('should handle complex metadata with indexingState', () => {
    const metadata = makeMetadata({
      indexingState: {
        indexStatus: 'indexed',
        lastIndexedAt: '2026-04-25T11:00:00Z',
        indexVersion: 3,
        indexAttempts: 1,
        skipReason: undefined,
      },
      dataSource: 'roo',
      source: 'roo',
      qdrantIndexedAt: '2026-04-25T11:00:00Z',
    });
    const skeleton = makeSkeleton('task-complex', { metadata });

    const header = toHeader(skeleton);

    expect(header.metadata.indexingState?.indexStatus).toBe('indexed');
    expect(header.metadata.dataSource).toBe('roo');
  });

  it('should produce an object with no sequence property', () => {
    const skeleton = makeSkeleton('task-no-seq-check');
    const header = toHeader(skeleton);

    const keys = Object.keys(header);
    expect(keys).not.toContain('sequence');
  });
});

// ===================================================================
// loadSkeletonsFromDisk - exercises loadSkeletonsFromIndex internally
// ===================================================================
describe('loadSkeletonsFromDisk', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should populate cache from a valid index file', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const headers = [
      makeHeader({ taskId: 'task-a' }),
      makeHeader({ taskId: 'task-b', parentTaskId: 'task-a' }),
    ];

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex(headers)));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(2);
    expect(cache.get('task-a')?.taskId).toBe('task-a');
    expect(cache.get('task-b')?.parentTaskId).toBe('task-a');
  });

  it('should load entries that have no parentTaskId', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const header = makeHeader({ taskId: 'task-orphan' });

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex([header])));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(1);
    expect(cache.get('task-orphan')?.parentTaskId).toBeUndefined();
  });

  it('should handle no storage locations gracefully', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue([]);

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(0);
  });

  it('should handle missing index file (ENOENT) gracefully', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockRejectedValue(new Error('ENOENT: no such file'));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(0);
  });

  it('should handle corrupted index (invalid JSON) gracefully', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue('not valid json {{{');

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(0);
  });

  it('should handle index with missing entries array', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, generatedAt: '2026-04-25', count: 0 }));

    await loadSkeletonsFromDisk(cache);

    // entries is missing, treated as invalid format
    expect(cache.size).toBe(0);
  });

  it('should handle index with entries that is not an array', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, entries: 'not-array' }));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(0);
  });

  it('should skip entries with no taskId', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const headers = [
      { metadata: makeMetadata() }, // no taskId
      makeHeader({ taskId: 'task-valid' }),
    ];

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex(headers as any)));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(1);
    expect(cache.has('task-valid')).toBe(true);
  });

  it('should handle BOM-prefixed UTF-8 index file', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const headers = [makeHeader({ taskId: 'task-bom' })];
    const indexContent = '﻿' + JSON.stringify(makeIndex(headers));

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(indexContent);

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(1);
    expect(cache.get('task-bom')?.taskId).toBe('task-bom');
  });

  it('should handle detectStorageLocations throwing an error', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockRejectedValue(new Error('Permission denied'));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(0);
  });

  it('should handle empty entries array', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex([])));

    await loadSkeletonsFromDisk(cache);

    // Empty entries means size stays 0
    expect(cache.size).toBe(0);
  });

  it('should overwrite existing cache entries with same taskId', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const oldHeader = makeHeader({ taskId: 'task-dup' });
    oldHeader.metadata.title = 'Old Title';
    cache.set('task-dup', oldHeader);

    const newHeader = makeHeader({ taskId: 'task-dup' });
    newHeader.metadata.title = 'New Title';

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex([newHeader])));

    await loadSkeletonsFromDisk(cache);

    expect(cache.size).toBe(1);
    expect(cache.get('task-dup')?.metadata.title).toBe('New Title');
  });

  it('should use the first storage location for index path', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/first', '/second']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIndex([makeHeader({ taskId: 't1' })])));

    await loadSkeletonsFromDisk(cache);

    const readPath = mockFs.readFile.mock.calls[0]?.[0] as string;
    // path.join uses backslashes on Windows, forward slashes on Unix
    expect(readPath).toContain('first');
    expect(readPath).toContain('_skeleton_index.json');
  });
});

// ===================================================================
// saveSkeletonIndex
// ===================================================================
describe('saveSkeletonIndex', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should write index file from cache entries', async () => {
    const cache = new Map<string, SkeletonHeader>();
    cache.set('t1', makeHeader({ taskId: 't1' }));
    cache.set('t2', makeHeader({ taskId: 't2' }));

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    await saveSkeletonIndex(cache);

    expect(mockFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('.skeletons'),
      { recursive: true },
    );

    // #1984: FileLockManager writes a .lock file before the actual index write
    // Find the call that writes to _skeleton_index.json (not .lock)
    const indexWriteCall = mockFs.writeFile.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('_skeleton_index.json') && !call[0].endsWith('.lock')
    );
    expect(indexWriteCall).toBeDefined();

    const writtenPath = indexWriteCall?.[0] as string;
    const writtenContent = indexWriteCall?.[1] as string;
    expect(writtenPath).toContain('_skeleton_index.json');

    const parsed = JSON.parse(writtenContent);
    expect(parsed.version).toBe(1);
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.generatedAt).toBeDefined();
  });

  it('should handle no storage locations', async () => {
    const cache = new Map<string, SkeletonHeader>();
    cache.set('t1', makeHeader({ taskId: 't1' }));

    mockDetector.detectStorageLocations.mockResolvedValue([]);

    await saveSkeletonIndex(cache);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('should handle write errors gracefully', async () => {
    const cache = new Map<string, SkeletonHeader>();
    cache.set('t1', makeHeader({ taskId: 't1' }));

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

    // Should not throw - errors are caught internally
    await expect(saveSkeletonIndex(cache)).resolves.not.toThrow();
  });

  it('should produce valid JSON without BOM', async () => {
    const cache = new Map<string, SkeletonHeader>();
    cache.set('t1', makeHeader({ taskId: 't1' }));

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    await saveSkeletonIndex(cache);

    const writtenContent = mockFs.writeFile.mock.calls[0]?.[1] as string;
    // First char should not be BOM
    expect(writtenContent.charCodeAt(0)).not.toBe(0xFEFF);
    // Should be parseable JSON
    expect(() => JSON.parse(writtenContent)).not.toThrow();
  });
});

// ===================================================================
// loadFullSkeleton
// ===================================================================
describe('loadFullSkeleton', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load and return a full skeleton with sequence', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const skeleton = makeSkeleton('task-full');

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(skeleton));

    const result = await loadFullSkeleton('task-full', cache);

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe('task-full');
    expect(result?.sequence).toHaveLength(2);
    // Cache should be updated with the header
    expect(cache.get('task-full')?.taskId).toBe('task-full');
    // Cache entry should NOT have sequence
    expect((cache.get('task-full') as any)?.sequence).toBeUndefined();
  });

  it('should return null for skeleton without sequence', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const headerOnly = makeSkeleton('task-header-only', { sequence: [] });

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(headerOnly));

    const result = await loadFullSkeleton('task-header-only', cache);

    expect(result).toBeNull();
  });

  it('should return null when no storage locations', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue([]);

    const result = await loadFullSkeleton('task-x', cache);

    expect(result).toBeNull();
  });

  it('should return null when file not found', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadFullSkeleton('task-missing', cache);

    expect(result).toBeNull();
  });

  it('should handle BOM in skeleton file', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const skeleton = makeSkeleton('task-bom');

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue('﻿' + JSON.stringify(skeleton));

    const result = await loadFullSkeleton('task-bom', cache);

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe('task-bom');
  });

  it('should return null for invalid JSON in skeleton file', async () => {
    const cache = new Map<string, SkeletonHeader>();

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue('{{invalid json}}');

    const result = await loadFullSkeleton('task-bad', cache);

    expect(result).toBeNull();
  });

  it('should update cache with header even for newly loaded skeletons', async () => {
    const cache = new Map<string, SkeletonHeader>();
    const skeleton = makeSkeleton('task-new', {
      metadata: makeMetadata({ title: 'Loaded' }),
    });

    mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
    mockFs.readFile.mockResolvedValue(JSON.stringify(skeleton));

    await loadFullSkeleton('task-new', cache);

    const cached = cache.get('task-new');
    expect(cached).toBeDefined();
    expect(cached?.metadata.title).toBe('Loaded');
    // Cached entry must not have sequence
    expect((cached as any)?.sequence).toBeUndefined();
  });
});

// ===================================================================
// classifyIndexingError
// ===================================================================
describe('classifyIndexingError', () => {
  it('should classify permanent errors as true', () => {
    const errors = [
      new Error('file not found'),
      new Error('not found in storage'),
      new Error('access denied for user'),
      new Error('permission denied: readonly'),
      new Error('invalid format detected'),
      new Error('corrupted data stream'),
      new Error('authentication failed for API'),
      new Error('quota exceeded permanently'),
    ];

    for (const error of errors) {
      expect(classifyIndexingError(error)).toBe(true);
    }
  });

  it('should classify temporary errors as false', () => {
    const errors = [
      new Error('network error during fetch'),
      new Error('connection timeout after 30s'),
      new Error('rate limit hit'),
      new Error('service unavailable (503)'),
      new Error('timeout waiting for response'),
      new Error('ECONNRESET by peer'),
      new Error('ENOTFOUND dns failure'),
    ];

    for (const error of errors) {
      expect(classifyIndexingError(error)).toBe(false);
    }
  });

  it('should default to false for unrecognized errors', () => {
    expect(classifyIndexingError(new Error('something unexpected'))).toBe(false);
    expect(classifyIndexingError(new Error(''))).toBe(false);
  });

  it('should handle errors without message property', () => {
    expect(classifyIndexingError({})).toBe(false);
    expect(classifyIndexingError({ message: null })).toBe(false);
    expect(classifyIndexingError({ message: undefined })).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(classifyIndexingError(new Error('FILE NOT FOUND'))).toBe(true);
    expect(classifyIndexingError(new Error('Access Denied'))).toBe(true);
    expect(classifyIndexingError(new Error('Network Error'))).toBe(false);
    expect(classifyIndexingError(new Error('TIMEOUT'))).toBe(false);
  });
});
