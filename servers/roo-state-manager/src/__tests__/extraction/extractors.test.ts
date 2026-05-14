/**
 * Tests for the extraction module (#1392)
 * — RooTaskExtractor, ClaudeTaskExtractor, UnifiedTaskExtractor
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock storage detectors before importing extractors
vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    buildHierarchicalSkeletons: vi.fn(),
    findConversationById: vi.fn(),
  },
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: vi.fn(),
    listProjects: vi.fn(),
    analyzeConversation: vi.fn(),
    findConversationById: vi.fn(),
  },
}));

import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { RooTaskExtractor } from '../../services/extraction/roo-task-extractor.js';
import { ClaudeTaskExtractor } from '../../services/extraction/claude-task-extractor.js';
import { UnifiedTaskExtractor } from '../../services/extraction/unified-task-extractor.js';
import type { UnifiedTask } from '../../types/unified-task.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockRooSkeleton = {
  taskId: 'task-roo-001',
  parentTaskId: 'parent-001',
  truncatedInstruction: 'Fix the authentication bug',
  isCompleted: false,
  metadata: {
    title: 'Fix auth bug',
    lastActivity: '2026-05-10T11:30:00Z',
    createdAt: '2026-05-10T10:00:00Z',
    mode: 'code-simple',
    messageCount: 25,
    actionCount: 8,
    totalSize: 5000,
    workspace: '/dev/project',
    source: 'roo' as const,
  },
};

const mockRooSummary = {
  taskId: 'task-roo-001',
  lastActivity: '2026-05-10T11:30:00Z',
  size: 5000,
  messageCount: 25,
  metadata: {
    title: 'Fix auth bug',
    workspace: '/dev/project',
  },
};

const mockClaudeLocation = {
  path: '/home/user/.claude/projects',
  projectPath: '/home/user/.claude/projects/project-hash',
};

const mockClaudeSkeleton = {
  taskId: 'claude-project-hash',
  metadata: {
    title: 'Claude session',
    lastActivity: '2026-05-11T08:05:00Z',
    createdAt: '2026-05-11T08:00:00Z',
    messageCount: 10,
    actionCount: 3,
    totalSize: 4096,
    workspace: '/dev/roo-extensions',
  },
};

// ─── RooTaskExtractor ─────────────────────────────────────────────────────────

describe('RooTaskExtractor', () => {
  let extractor: RooTaskExtractor;

  beforeEach(() => {
    extractor = new RooTaskExtractor();
    vi.clearAllMocks();
  });

  test('sourceName is "roo"', () => {
    expect(extractor.sourceName).toBe('roo');
  });

  test('isAvailable returns true when storage locations exist', async () => {
    vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/path/to/storage']);
    expect(await extractor.isAvailable()).toBe(true);
  });

  test('isAvailable returns false when no storage locations', async () => {
    vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([]);
    expect(await extractor.isAvailable()).toBe(false);
  });

  test('isAvailable returns false on error', async () => {
    vi.mocked(RooStorageDetector.detectStorageLocations).mockRejectedValue(new Error('disk error'));
    expect(await extractor.isAvailable()).toBe(false);
  });

  test('extractAll converts skeletons to UnifiedTasks', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      mockRooSkeleton,
    ] as any);

    const result = await extractor.extractAll();
    expect(result.source).toBe('roo');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('task-roo-001');
    expect(result.tasks[0].source).toBe('roo');
    expect(result.tasks[0].title).toBe('Fix auth bug');
    expect(result.tasks[0].messageCount).toBe(25);
    expect(result.errors).toHaveLength(0);
  });

  test('extractAll returns empty tasks when no skeletons', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([]);
    const result = await extractor.extractAll();
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('extractAll collects errors for bad skeletons', async () => {
    const badSkeleton = { taskId: 'bad-task' }; // Missing required metadata
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      badSkeleton as any,
    ]);

    const result = await extractor.extractAll();
    // Should handle gracefully — toUnifiedTask uses defaults for missing fields
    expect(result.tasks.length + result.errors.length).toBeGreaterThanOrEqual(1);
  });

  test('extractAll handles top-level extraction failure', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockRejectedValue(
      new Error('storage corrupted'),
    );
    const result = await extractor.extractAll();
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('storage corrupted');
  });

  test('extractById returns task when found', async () => {
    vi.mocked(RooStorageDetector.findConversationById).mockResolvedValue(
      mockRooSummary as any,
    );
    const task = await extractor.extractById('task-roo-001');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('task-roo-001');
    expect(task!.source).toBe('roo');
  });

  test('extractById returns null when not found', async () => {
    vi.mocked(RooStorageDetector.findConversationById).mockResolvedValue(null);
    const task = await extractor.extractById('nonexistent');
    expect(task).toBeNull();
  });

  test('extractById returns null on error', async () => {
    vi.mocked(RooStorageDetector.findConversationById).mockRejectedValue(new Error('io error'));
    const task = await extractor.extractById('task-roo-001');
    expect(task).toBeNull();
  });

  test('extractAll with includeComputedFields adds storageTier', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      mockRooSkeleton,
    ] as any);

    const result = await extractor.extractAll({ includeComputedFields: true });
    expect(result.tasks[0].storageTier).toBeDefined();
  });

  test('extractAll with machineId override', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      mockRooSkeleton,
    ] as any);

    const result = await extractor.extractAll({ machineId: 'myia-custom' });
    expect(result.tasks[0].machineId).toBe('myia-custom');
  });
});

// ─── ClaudeTaskExtractor ──────────────────────────────────────────────────────

describe('ClaudeTaskExtractor', () => {
  let extractor: ClaudeTaskExtractor;

  beforeEach(() => {
    extractor = new ClaudeTaskExtractor();
    vi.clearAllMocks();
  });

  test('sourceName is "claude-code"', () => {
    expect(extractor.sourceName).toBe('claude-code');
  });

  test('isAvailable returns true when locations exist', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    expect(await extractor.isAvailable()).toBe(true);
  });

  test('isAvailable returns false when no locations', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);
    expect(await extractor.isAvailable()).toBe(false);
  });

  test('extractAll converts Claude sessions to UnifiedTasks', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    const result = await extractor.extractAll();
    expect(result.source).toBe('claude-code');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('claude-project-hash');
    expect(result.tasks[0].source).toBe('claude-code');
    expect(result.errors).toHaveLength(0);
  });

  test('extractAll skips null skeletons', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(null);

    const result = await extractor.extractAll();
    expect(result.tasks).toHaveLength(0);
  });

  test('extractAll collects per-project errors', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockRejectedValue(
      new Error('parse error'),
    );

    const result = await extractor.extractAll();
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe('claude-project-hash');
  });

  test('extractAll handles top-level failure', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockRejectedValue(
      new Error('no storage'),
    );
    const result = await extractor.extractAll();
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('no storage');
  });

  test('extractById returns task when found', async () => {
    vi.mocked(ClaudeStorageDetector.findConversationById).mockResolvedValue(
      mockClaudeSkeleton as any,
    );
    const task = await extractor.extractById('claude-project-hash');
    expect(task).not.toBeNull();
    expect(task!.source).toBe('claude-code');
  });

  test('extractById returns null when not found', async () => {
    vi.mocked(ClaudeStorageDetector.findConversationById).mockResolvedValue(null);
    const task = await extractor.extractById('nonexistent');
    expect(task).toBeNull();
  });

  test('extractAll with includeComputedFields adds storageTier', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    const result = await extractor.extractAll({ includeComputedFields: true });
    expect(result.tasks[0].storageTier).toBeDefined();
  });

  test('extractAll with machineId override', async () => {
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    const result = await extractor.extractAll({ machineId: 'myia-custom' });
    expect(result.tasks[0].machineId).toBe('myia-custom');
  });
});

// ─── UnifiedTaskExtractor ─────────────────────────────────────────────────────

describe('UnifiedTaskExtractor', () => {
  let extractor: UnifiedTaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses default extractors when none provided', () => {
    extractor = new UnifiedTaskExtractor();
    // Should not throw
    expect(extractor).toBeDefined();
  });

  test('extractAll merges tasks from both sources', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      mockRooSkeleton,
    ] as any);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    extractor = new UnifiedTaskExtractor();
    const result = await extractor.extractAll();

    expect(result.tasks).toHaveLength(2);
    expect(result.totalErrors).toBe(0);
    expect(result.bySource.roo.tasks).toHaveLength(1);
    expect(result.bySource['claude-code'].tasks).toHaveLength(1);
  });

  test('extractAll works with Roo only', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([
      mockRooSkeleton,
    ] as any);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);

    extractor = new UnifiedTaskExtractor();
    const result = await extractor.extractAll();

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].source).toBe('roo');
    expect(result.bySource['claude-code'].tasks).toHaveLength(0);
  });

  test('extractAll works with Claude only', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([]);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);
    vi.mocked(ClaudeStorageDetector.listProjects).mockResolvedValue(['project-hash']);
    vi.mocked(ClaudeStorageDetector.analyzeConversation).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    extractor = new UnifiedTaskExtractor();
    const result = await extractor.extractAll();

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].source).toBe('claude-code');
    expect(result.bySource.roo.tasks).toHaveLength(0);
  });

  test('extractAll aggregates errors from both sources', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockRejectedValue(
      new Error('roo error'),
    );
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockRejectedValue(
      new Error('claude error'),
    );

    extractor = new UnifiedTaskExtractor();
    const result = await extractor.extractAll();

    expect(result.totalErrors).toBe(2);
    expect(result.tasks).toHaveLength(0);
  });

  test('extractAll with empty sources returns empty tasks', async () => {
    vi.mocked(RooStorageDetector.buildHierarchicalSkeletons).mockResolvedValue([]);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);

    extractor = new UnifiedTaskExtractor();
    const result = await extractor.extractAll();

    expect(result.tasks).toHaveLength(0);
    expect(result.totalErrors).toBe(0);
  });

  test('extractById routes to Claude extractor for claude- prefixed IDs', async () => {
    vi.mocked(ClaudeStorageDetector.findConversationById).mockResolvedValue(
      mockClaudeSkeleton as any,
    );

    extractor = new UnifiedTaskExtractor();
    const task = await extractor.extractById('claude-project-hash');

    expect(ClaudeStorageDetector.findConversationById).toHaveBeenCalledWith('claude-project-hash');
    expect(RooStorageDetector.findConversationById).not.toHaveBeenCalled();
  });

  test('extractById routes to Roo extractor for UUID-format IDs', async () => {
    vi.mocked(RooStorageDetector.findConversationById).mockResolvedValue(
      mockRooSummary as any,
    );

    extractor = new UnifiedTaskExtractor();
    const task = await extractor.extractById('abc123-def456');

    expect(RooStorageDetector.findConversationById).toHaveBeenCalledWith('abc123-def456');
    expect(ClaudeStorageDetector.findConversationById).not.toHaveBeenCalled();
  });

  test('getAvailableSources returns available extractors', async () => {
    vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/path']);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
      mockClaudeLocation as any,
    ]);

    extractor = new UnifiedTaskExtractor();
    const sources = await extractor.getAvailableSources();

    expect(sources).toContain('roo');
    expect(sources).toContain('claude-code');
    expect(sources).toHaveLength(2);
  });

  test('getAvailableSources returns only available ones', async () => {
    vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/path']);
    vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);

    extractor = new UnifiedTaskExtractor();
    const sources = await extractor.getAvailableSources();

    expect(sources).toContain('roo');
    expect(sources).not.toContain('claude-code');
  });

  test('accepts custom extractors via constructor', async () => {
    const mockExtractor = {
      sourceName: 'roo' as const,
      extractAll: vi.fn().mockResolvedValue({
        tasks: [{ id: 'custom-1', source: 'roo' } as UnifiedTask],
        source: 'roo',
        errors: [],
      }),
      extractById: vi.fn().mockResolvedValue(null),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    const unified = new UnifiedTaskExtractor([mockExtractor, mockExtractor]);
    const result = await unified.extractAll();

    expect(result.tasks).toHaveLength(2);
    expect(mockExtractor.extractAll).toHaveBeenCalledTimes(2);
  });
});
