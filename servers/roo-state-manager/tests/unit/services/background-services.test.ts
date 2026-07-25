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
  isPermanentIndexingError,
  registerDeadLetter,
  shouldRequeueForRefresh,
} from '../../../src/services/background-services.js';
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
import type { ConversationSkeleton, SkeletonHeader, SkeletonMetadata } from '../../../src/types/conversation.js';
// #2766 S2+: ServerState is a structural type used by registerDeadLetter() —
// we import the type for type-checking the test stub's shape below.
import type { ServerState } from '../../../src/services/state-manager.service.js';

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
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);

    const writtenPath = mockFs.writeFile.mock.calls[0]?.[0] as string;
    const writtenContent = mockFs.writeFile.mock.calls[0]?.[1] as string;
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
// classifyIndexingError — #2766 S2+ signature change: returns { isPermanent, errorClass }
// instead of a bare boolean. The legacy boolean-only path is exposed via
// isPermanentIndexingError() for backward compatibility.
// ===================================================================
describe('classifyIndexingError', () => {
  it('should classify permanent errors with their errorClass', () => {
    // Each permanent pattern maps to a SPECIFIC error class (not the
    // generic 'unknown') so the dead-letter UI can group by root cause.
    const cases: Array<{ message: string; expectedClass: string }> = [
      { message: 'file not found', expectedClass: 'file_not_found' },
      { message: 'Claude Code session abc123 not found', expectedClass: 'claude_session_not_found' },
      { message: 'access denied for user', expectedClass: 'access_denied' },
      { message: 'permission denied: readonly', expectedClass: 'permission_denied' },
      { message: 'invalid format detected', expectedClass: 'invalid_format' },
      { message: 'corrupted data stream', expectedClass: 'corrupted_data' },
      { message: 'authentication failed for API', expectedClass: 'auth_failed' },
      { message: 'quota exceeded permanently', expectedClass: 'quota_exceeded' },
      // 401 / 503 patterns from the S1 typed classifier (#882) cross-reference.
      { message: '401 Unauthorized', expectedClass: 'auth_failed' },
      { message: 'invalid api key', expectedClass: 'auth_failed' },
    ];

    for (const { message, expectedClass } of cases) {
      const result = classifyIndexingError(new Error(message));
      expect(result.isPermanent).toBe(true);
      expect(result.errorClass).toBe(expectedClass);
    }
  });

  it('should classify temporary errors with their errorClass', () => {
    // Transient errors must NEVER be marked permanent so they retry.
    const cases: Array<{ message: string; expectedClass: string }> = [
      { message: 'network error during fetch', expectedClass: 'network_timeout' },
      { message: 'connection timeout after 30s', expectedClass: 'network_timeout' },
      { message: 'rate limit hit', expectedClass: 'rate_limit' },
      { message: 'service unavailable (503)', expectedClass: 'service_503' },
      { message: '429 Too Many Requests', expectedClass: 'rate_limit' },
      { message: '502 Bad Gateway', expectedClass: 'service_503' },
      { message: 'Indexing timeout for task-123 after 300000ms', expectedClass: 'embedding_timeout' },
      { message: 'ECONNRESET by peer', expectedClass: 'connection_reset' },
      { message: 'ENOTFOUND dns failure', expectedClass: 'dns_failure' },
    ];

    for (const { message, expectedClass } of cases) {
      const result = classifyIndexingError(new Error(message));
      expect(result.isPermanent).toBe(false);
      expect(result.errorClass).toBe(expectedClass);
    }
  });

  it('should default to { isPermanent: false, errorClass: "unknown" } for unrecognized errors', () => {
    const unknown = classifyIndexingError(new Error('something unexpected'));
    expect(unknown.isPermanent).toBe(false);
    expect(unknown.errorClass).toBe('unknown');

    // Empty message also unknown, NOT a true classification.
    expect(classifyIndexingError(new Error(''))).toEqual({ isPermanent: false, errorClass: 'unknown' });
  });

  it('should handle errors without message property', () => {
    expect(classifyIndexingError({})).toEqual({ isPermanent: false, errorClass: 'unknown' });
    expect(classifyIndexingError({ message: null })).toEqual({ isPermanent: false, errorClass: 'unknown' });
    expect(classifyIndexingError({ message: undefined })).toEqual({ isPermanent: false, errorClass: 'unknown' });
  });

  it('should be case-insensitive', () => {
    expect(classifyIndexingError(new Error('FILE NOT FOUND'))).toEqual({ isPermanent: true, errorClass: 'file_not_found' });
    expect(classifyIndexingError(new Error('Access Denied'))).toEqual({ isPermanent: true, errorClass: 'access_denied' });
    expect(classifyIndexingError(new Error('Network Error'))).toEqual({ isPermanent: false, errorClass: 'network_timeout' });
    // Bare 'TIMEOUT' is ambiguous (could be network or embedding) and falls
    // through to 'unknown' under the strict-classification policy. The
    // status tool surfaces 'unknown' so operators can add a matching pattern
    // if they see it spiking.
    expect(classifyIndexingError(new Error('TIMEOUT'))).toEqual({ isPermanent: false, errorClass: 'unknown' });
  });

  // #2766 S2+ regression: 'Claude Code session ... not found' must match
  // the SPECIFIC claude_session_not_found class, NOT the generic file_not_found.
  // Without ordering by pattern specificity, the generic 'not found' catch-all
  // would mask the real root cause ("session archived/deleted" vs "file missing").
  it('should match claude_session_not_found BEFORE the generic file_not_found pattern', () => {
    const result = classifyIndexingError(new Error('Claude Code session task-xyz not found in any storage location'));
    expect(result.isPermanent).toBe(true);
    expect(result.errorClass).toBe('claude_session_not_found');
  });

  it('should match auth_failed BEFORE service_503 (401 must not look like 503)', () => {
    const result = classifyIndexingError(new Error('HTTP 401 from upstream — invalid api key'));
    expect(result.isPermanent).toBe(true);
    expect(result.errorClass).toBe('auth_failed');
  });

  it('should match rate_limit BEFORE service_503 (429 must not look like 503)', () => {
    const result = classifyIndexingError(new Error('429 Too Many Requests from embedding service'));
    expect(result.isPermanent).toBe(false);
    expect(result.errorClass).toBe('rate_limit');
  });
});

// ===================================================================
// isPermanentIndexingError — backward-compat shim
// ===================================================================
describe('isPermanentIndexingError', () => {
  it('should return the boolean verdict for permanent errors', () => {
    expect(isPermanentIndexingError(new Error('authentication failed'))).toBe(true);
    expect(isPermanentIndexingError(new Error('permission denied'))).toBe(true);
  });

  it('should return false for transient errors', () => {
    expect(isPermanentIndexingError(new Error('rate limit'))).toBe(false);
    expect(isPermanentIndexingError(new Error('ECONNRESET'))).toBe(false);
  });

  it('should default to false on empty/unknown errors', () => {
    expect(isPermanentIndexingError(new Error(''))).toBe(false);
    expect(isPermanentIndexingError({})).toBe(false);
  });
});

// ===================================================================
// registerDeadLetter — #2766 S2+ Dead-letter isolation
// ===================================================================
describe('registerDeadLetter', () => {
  let state: ServerState;
  let skeleton: SkeletonHeader;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should add a task to deadLetterQueue and deadLetterDetails with errorClass', () => {
    state = makeStateWithQueue();
    skeleton = makeHeader({
      taskId: 'task-perm-fail',
      metadata: makeMetadata({
        indexingState: {
          indexStatus: 'failed',
          indexError: 'Claude Code session not found',
          indexRetryCount: 3,
          lastIndexAttempt: '2026-07-24T10:00:00Z',
          errorClass: 'claude_session_not_found',
        },
      }),
    });

    registerDeadLetter(state, 'task-perm-fail', skeleton, 'Claude Code session not found', 'claude_session_not_found');

    expect(state.deadLetterQueue.has('task-perm-fail')).toBe(true);
    expect(state.deadLetterDetails.size).toBe(1);
    const entry = state.deadLetterDetails.get('task-perm-fail');
    expect(entry).toBeDefined();
    expect(entry?.taskId).toBe('task-perm-fail');
    expect(entry?.errorClass).toBe('claude_session_not_found');
    expect(entry?.retryCount).toBe(3);
    expect(entry?.lastAttempt).toBe('2026-07-24T10:00:00Z');
    expect(entry?.movedAt).toBeDefined();
  });

  it('should be idempotent — repeated calls do NOT overwrite the first entry', () => {
    state = makeStateWithQueue();
    skeleton = makeHeader({
      taskId: 'task-dup',
      metadata: makeMetadata({
        indexingState: { indexStatus: 'failed', errorClass: 'auth_failed', indexRetryCount: 1 },
      }),
    });

    registerDeadLetter(state, 'task-dup', skeleton, 'first failure', 'auth_failed');
    const firstEntry = state.deadLetterDetails.get('task-dup');

    registerDeadLetter(state, 'task-dup', skeleton, 'second failure (would overwrite)', 'auth_failed');

    // Same entry — first-failure snapshot preserved.
    expect(state.deadLetterDetails.get('task-dup')).toEqual(firstEntry);
    expect(state.deadLetterQueue.size).toBe(1);
  });

  it('should default errorClass to "unknown" when skeleton has no errorClass set', () => {
    state = makeStateWithQueue();
    skeleton = makeHeader({
      taskId: 'task-no-class',
      metadata: makeMetadata({
        indexingState: { indexStatus: 'failed', indexError: 'mystery' },
      }),
    });

    registerDeadLetter(state, 'task-no-class', skeleton, 'mystery');

    const entry = state.deadLetterDetails.get('task-no-class');
    expect(entry?.errorClass).toBe('unknown');
  });

  it('should use explicitErrorClass when provided (catch block path)', () => {
    state = makeStateWithQueue();
    skeleton = makeHeader({
      taskId: 'task-explicit',
      metadata: makeMetadata({
        indexingState: { indexStatus: 'failed', errorClass: 'unknown' },
      }),
    });

    // Catch block classifies synchronously and passes the classification directly.
    registerDeadLetter(state, 'task-explicit', skeleton, 'connection reset by peer', 'connection_reset');

    expect(state.deadLetterDetails.get('task-explicit')?.errorClass).toBe('connection_reset');
  });
});

// ===================================================================
// Helpers for dead-letter tests — minimal ServerState stub. Keep this at the
// bottom of the file so it doesn't pollute the describe block flow above.
// ===================================================================
type ServerState = any;

function makeStateWithQueue(): any {
  return {
    qdrantIndexQueue: new Set<string>(),
    deadLetterQueue: new Set<string>(),
    deadLetterDetails: new Map<string, any>(),
    indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 },
    isQdrantIndexingEnabled: true,
    qdrantIndexInterval: null,
    machineId: 'test',
    fleetRoster: null,
    isIndexLeader: false,
    conversationCache: new Map(),
    indexingDecisionService: null,
  };
}

// ===================================================================
// shouldRequeueForRefresh — #2766 S2+ refresh-worker decision helper
// ===================================================================
describe('shouldRequeueForRefresh', () => {
  // Base case: a fresh task with no lastIndexedAt should re-queue.
  it('should re-queue a never-indexed task (no lastIndexed)', () => {
    const state = makeStateWithQueue();
    const result = shouldRequeueForRefresh({
      taskId: 'task-fresh',
      state,
      indexStatus: undefined,
      lastIndexed: undefined,
      fileMtimeMs: 1000,
      lastActivityMs: 1500,
      forceRescan: false,
    });
    expect(result).toBe(true);
  });

  it('should re-queue when content changed since last indexation', () => {
    const state = makeStateWithQueue();
    const result = shouldRequeueForRefresh({
      taskId: 'task-changed',
      state,
      indexStatus: 'success',
      lastIndexed: '2026-07-20T10:00:00Z',
      fileMtimeMs: 1000,
      lastActivityMs: new Date('2026-07-24T12:00:00Z').getTime(),
      forceRescan: false,
    });
    expect(result).toBe(true);
  });

  // #2766 S2+ core regression test: a perm-failed task MUST NOT be re-queued.
  // This is the bug that produced the queue-stuck-at-21 livelock.
  it('should NOT re-queue perm-failed tasks (indexStatus="failed") — core #2766 S2+ fix', () => {
    const state = makeStateWithQueue();
    const result = shouldRequeueForRefresh({
      taskId: 'task-perm-fail',
      state,
      indexStatus: 'failed',
      lastIndexed: undefined, // never succeeded
      fileMtimeMs: 1000,
      lastActivityMs: 2000, // activity still fresh
      forceRescan: false,
    });
    expect(result).toBe(false);
  });

  it('should NOT re-queue a task already in the dead-letter', () => {
    const state = makeStateWithQueue();
    state.deadLetterQueue.add('task-already-dead');
    const result = shouldRequeueForRefresh({
      taskId: 'task-already-dead',
      state,
      indexStatus: undefined,
      lastIndexed: undefined,
      fileMtimeMs: 1000,
      lastActivityMs: 2000,
      forceRescan: false,
    });
    expect(result).toBe(false);
  });

  // FORCE-mode guard preserved from #2227.
  it('should NOT re-queue in FORCE mode when content is unchanged (avoid #2227 cycle)', () => {
    const state = makeStateWithQueue();
    const lastIndexed = '2026-07-24T10:00:00Z';
    const lastIndexedMs = new Date(lastIndexed).getTime();
    const result = shouldRequeueForRefresh({
      taskId: 'task-success-unchanged',
      state,
      indexStatus: 'success',
      lastIndexed,
      // fileMtimeMs BEFORE lastIndexed → not changed since indexation
      fileMtimeMs: lastIndexedMs - 1000,
      lastActivityMs: lastIndexedMs - 1000,
      forceRescan: true,
    });
    expect(result).toBe(false);
  });

  it('SHOULD re-queue in FORCE mode when content changed after last indexation', () => {
    const state = makeStateWithQueue();
    const lastIndexed = '2026-07-24T10:00:00Z';
    const lastIndexedMs = new Date(lastIndexed).getTime();
    const result = shouldRequeueForRefresh({
      taskId: 'task-success-changed',
      state,
      indexStatus: 'success',
      lastIndexed,
      fileMtimeMs: lastIndexedMs + 1000, // mtime AFTER lastIndexed
      lastActivityMs: lastIndexedMs + 1000,
      forceRescan: true,
    });
    expect(result).toBe(true);
  });

  it('should NOT re-queue content-unchanged tasks (success + no activity since index)', () => {
    const state = makeStateWithQueue();
    const lastIndexed = '2026-07-24T10:00:00Z';
    const lastIndexedMs = new Date(lastIndexed).getTime();
    const result = shouldRequeueForRefresh({
      taskId: 'task-stable-success',
      state,
      indexStatus: 'success',
      lastIndexed,
      fileMtimeMs: lastIndexedMs - 500,
      lastActivityMs: lastIndexedMs - 500,
      forceRescan: false,
    });
    expect(result).toBe(false);
  });
});
