/**
 * Tests for UnifiedTaskExtractor — #1392
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { TaskExtractor, ExtractionResult } from '../task-extractor.js';
import type { UnifiedTask } from '../../../types/unified-task.js';

// ─── Mock extractors ──────────────────────────────────────────────────────────

function makeMockExtractor(
  sourceName: 'roo' | 'claude-code',
  tasks: UnifiedTask[] = [],
): TaskExtractor {
  return {
    sourceName,
    isAvailable: vi.fn().mockResolvedValue(true),
    extractAll: vi.fn().mockResolvedValue({
      tasks,
      source: sourceName,
      errors: [],
    } satisfies ExtractionResult),
    extractById: vi.fn().mockImplementation(async (id: string) =>
      tasks.find(t => t.id === id) ?? null,
    ),
  };
}

const sampleRooTask: UnifiedTask = {
  id: 'roo-001',
  source: 'roo',
  title: 'Roo task',
  createdAt: '2026-05-10T10:00:00Z',
  lastActivity: '2026-05-10T11:00:00Z',
  messageCount: 10,
  actionCount: 3,
  totalSizeBytes: 4096,
  status: 'active',
};

const sampleClaudeTask: UnifiedTask = {
  id: 'claude-proj1',
  source: 'claude-code',
  title: 'Claude session',
  createdAt: '2026-05-10T12:00:00Z',
  lastActivity: '2026-05-10T13:00:00Z',
  messageCount: 5,
  actionCount: 1,
  totalSizeBytes: 2048,
  status: 'active',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UnifiedTaskExtractor', () => {
  let rooExtractor: TaskExtractor;
  let claudeExtractor: TaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    rooExtractor = makeMockExtractor('roo', [sampleRooTask]);
    claudeExtractor = makeMockExtractor('claude-code', [sampleClaudeTask]);
  });

  test('extractAll merges tasks from all sources', async () => {
    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const result = await unified.extractAll();
    expect(result.tasks).toHaveLength(2);
    expect(result.bySource.roo.tasks).toHaveLength(1);
    expect(result.bySource['claude-code'].tasks).toHaveLength(1);
    expect(result.totalErrors).toBe(0);
  });

  test('extractAll aggregates errors', async () => {
    const errorRoo = makeMockExtractor('roo');
    (errorRoo.extractAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      tasks: [],
      source: 'roo',
      errors: [{ taskId: 'x', message: 'fail 1' }, { message: 'fail 2' }],
    });
    const errorClaude = makeMockExtractor('claude-code');
    (errorClaude.extractAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      tasks: [],
      source: 'claude-code',
      errors: [{ message: 'fail 3' }],
    });

    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [errorRoo, errorClaude],
    );
    const result = await unified.extractAll();
    expect(result.totalErrors).toBe(3);
  });

  test('extractById routes claude- prefixed IDs to claude extractor', async () => {
    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const task = await unified.extractById('claude-proj1');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('claude-proj1');
    expect(claudeExtractor.extractById).toHaveBeenCalledWith('claude-proj1', undefined);
    expect(rooExtractor.extractById).not.toHaveBeenCalled();
  });

  test('extractById routes non-claude IDs to roo extractor', async () => {
    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const task = await unified.extractById('roo-001');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('roo-001');
    expect(rooExtractor.extractById).toHaveBeenCalledWith('roo-001', undefined);
    expect(claudeExtractor.extractById).not.toHaveBeenCalled();
  });

  test('getAvailableSources returns only available ones', async () => {
    (rooExtractor.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (claudeExtractor.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const sources = await unified.getAvailableSources();
    expect(sources).toEqual(['roo']);
  });

  test('getAvailableSources returns both when both available', async () => {
    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const sources = await unified.getAvailableSources();
    expect(sources).toEqual(['roo', 'claude-code']);
  });

  test('passes options through to extractors', async () => {
    const unified = new (await import('../unified-task-extractor.js')).UnifiedTaskExtractor(
      [rooExtractor, claudeExtractor],
    );

    const opts = { machineId: 'test', includeComputedFields: true };
    await unified.extractAll(opts);
    expect(rooExtractor.extractAll).toHaveBeenCalledWith(opts);
    expect(claudeExtractor.extractAll).toHaveBeenCalledWith(opts);
  });
});
