/**
 * Coverage complement for UnifiedTaskExtractor — #833 Sprint C3.
 *
 * Add-only, tests-only. Targets the cold branches that the nominal suite
 * (unified-task-extractor.test.ts) never enters:
 *  - constructor default extractors (no-arg)               (L35-40)
 *  - extractAll with empty extractors list                  (L44-57, flatMap/reduce on [])
 *  - extractAll with three sources incl. zoo-code           (L51-55 bySource mapping)
 *  - extractAll propagates when a sub-extractor throws      (L44 Promise.all rejection)
 *  - extractById routing when claude-code extractor absent  (L86-88 fallback chain)
 *      → sub-case: non-roo fallback selected
 *      → sub-case: only [0] (roo) fallback selected
 *  - extractById routing non-claude when roo extractor absent (L91-92 fallback [0])
 *  - extractById returns null when sub-extractor returns null
 *  - extractById passes options through to chosen extractor
 *  - getAvailableSources empty when none available          (L70-80)
 *  - getAvailableSources includes zoo-code source           (L73-77)
 *
 * Mock strategy: identical to nominal suite — inject hand-built TaskExtractor
 * mocks through the constructor (DI). No module-level vi.mock needed.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { UnifiedTaskExtractor } from '../unified-task-extractor.js';
import type { TaskExtractor, ExtractionResult } from '../task-extractor.js';
import type { UnifiedTask } from '../../../types/unified-task.js';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type SourceName = 'roo' | 'claude-code' | 'zoo-code';

function makeMockExtractor(
  sourceName: SourceName,
  opts: {
    tasks?: UnifiedTask[];
    available?: boolean;
    errors?: ExtractionResult['errors'];
    extractAllThrows?: Error;
  } = {},
): TaskExtractor {
  const { tasks = [], available = true, errors = [], extractAllThrows } = opts;
  return {
    sourceName,
    isAvailable: vi.fn().mockResolvedValue(available),
    extractAll: extractAllThrows
      ? vi.fn().mockRejectedValue(extractAllThrows)
      : vi.fn().mockResolvedValue({ tasks, source: sourceName, errors } satisfies ExtractionResult),
    extractById: vi.fn().mockImplementation(async (id: string) =>
      tasks.find((t) => t.id === id) ?? null,
    ),
  };
}

function makeTask(id: string, source: SourceName): UnifiedTask {
  return {
    id,
    source,
    title: `${source} task ${id}`,
    createdAt: '2026-05-10T10:00:00Z',
    lastActivity: '2026-05-10T11:00:00Z',
    messageCount: 1,
    actionCount: 0,
    totalSizeBytes: 1024,
    status: 'active',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UnifiedTaskExtractor — coverage complement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Constructor default extractors (L35-40) ──

  test('constructor with no arg instantiates default extractors without throwing', () => {
    expect(() => new UnifiedTaskExtractor()).not.toThrow();
    // Instantiates 3 real extractors (Roo, Claude, Zoo); constructor performs no IO.
    // We don't call extractAll/getAvailableSources to avoid touching filesystem detectors.
  });

  // ── extractAll edge cases (L44-57) ──

  test('extractAll over an empty extractors list returns empty aggregation', async () => {
    const unified = new UnifiedTaskExtractor([]);
    const result = await unified.extractAll();

    expect(result.tasks).toEqual([]);
    expect(result.totalErrors).toBe(0);
    // bySource cast as Record, but no keys assigned (loop body never runs)
    expect(Object.keys(result.bySource)).toHaveLength(0);
  });

  test('extractAll maps bySource across all three sources incl. zoo-code', async () => {
    const roo = makeMockExtractor('roo', { tasks: [makeTask('r1', 'roo')] });
    const claude = makeMockExtractor('claude-code', { tasks: [makeTask('c1', 'claude-code')] });
    const zoo = makeMockExtractor('zoo-code', { tasks: [makeTask('z1', 'zoo-code')] });

    const unified = new UnifiedTaskExtractor([roo, claude, zoo]);
    const result = await unified.extractAll();

    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map((t) => t.id).sort()).toEqual(['c1', 'r1', 'z1']);
    expect(result.bySource.roo.tasks).toHaveLength(1);
    expect(result.bySource['claude-code'].tasks).toHaveLength(1);
    expect(result.bySource['zoo-code'].tasks).toHaveLength(1);
  });

  test('extractAll with partial errors counts only the failing source errors', async () => {
    const ok = makeMockExtractor('roo', { tasks: [makeTask('r1', 'roo')] });
    const failing = makeMockExtractor('claude-code', {
      tasks: [makeTask('c1', 'claude-code')],
      errors: [
        { taskId: 'c2', message: 'missing' },
        { message: 'transient' },
      ],
    });

    const unified = new UnifiedTaskExtractor([ok, failing]);
    const result = await unified.extractAll();

    expect(result.totalErrors).toBe(2);
    expect(result.bySource['claude-code'].errors).toHaveLength(2);
    expect(result.bySource.roo.errors).toHaveLength(0);
  });

  test('extractAll propagates rejection when a sub-extractor extractAll throws (L44 Promise.all)', async () => {
    const ok = makeMockExtractor('roo', { tasks: [makeTask('r1', 'roo')] });
    const boom = makeMockExtractor('claude-code', {
      extractAllThrows: new Error('disk read failed'),
    });

    const unified = new UnifiedTaskExtractor([ok, boom]);
    await expect(unified.extractAll()).rejects.toThrow('disk read failed');
  });

  // ── extractById fallback chain (L82-93) ──

  test('extractById with claude- prefix falls back to first non-roo when claude-code absent (L86-88)', async () => {
    const roo = makeMockExtractor('roo', { tasks: [makeTask('r1', 'roo')] });
    const zoo = makeMockExtractor('zoo-code', { tasks: [makeTask('claude-proj', 'zoo-code')] });

    const unified = new UnifiedTaskExtractor([roo, zoo]);
    const task = await unified.extractById('claude-proj');

    expect(task).not.toBeNull();
    expect(task!.id).toBe('claude-proj');
    // routed to zoo (the non-roo fallback), NOT roo
    expect(zoo.extractById).toHaveBeenCalledWith('claude-proj', undefined);
    expect(roo.extractById).not.toHaveBeenCalled();
  });

  test('extractById with claude- prefix falls back to [0] when neither claude-code nor non-roo present (L88)', async () => {
    // Only roo extractor — claude- prefix, no claude-code, no non-roo → falls to [0] = roo
    const roo = makeMockExtractor('roo', { tasks: [makeTask('claude-x', 'roo')] });

    const unified = new UnifiedTaskExtractor([roo]);
    const task = await unified.extractById('claude-x');

    expect(task).not.toBeNull();
    expect(task!.id).toBe('claude-x');
    expect(roo.extractById).toHaveBeenCalledWith('claude-x', undefined);
  });

  test('extractById non-claude falls back to [0] when roo extractor absent (L91-92)', async () => {
    const claude = makeMockExtractor('claude-code', { tasks: [makeTask('abc', 'claude-code')] });
    const zoo = makeMockExtractor('zoo-code');

    // No roo extractor → default branch's `.find(roo)` returns undefined → [0] = claude
    const unified = new UnifiedTaskExtractor([claude, zoo]);
    const task = await unified.extractById('abc');

    expect(task).not.toBeNull();
    expect(task!.id).toBe('abc');
    expect(claude.extractById).toHaveBeenCalledWith('abc', undefined);
    expect(zoo.extractById).not.toHaveBeenCalled();
  });

  test('extractById returns null when chosen sub-extractor returns null', async () => {
    const roo = makeMockExtractor('roo', { tasks: [] }); // empty → extractById returns null
    const unified = new UnifiedTaskExtractor([roo]);

    const task = await unified.extractById('nonexistent');
    expect(task).toBeNull();
  });

  test('extractById passes options through to the chosen extractor', async () => {
    const roo = makeMockExtractor('roo', { tasks: [makeTask('r1', 'roo')] });
    const unified = new UnifiedTaskExtractor([roo]);

    const opts = { machineId: 'myia-po-2026', includeComputedFields: true };
    await unified.extractById('r1', opts);

    expect(roo.extractById).toHaveBeenCalledWith('r1', opts);
  });

  // ── getAvailableSources edge cases (L70-80) ──

  test('getAvailableSources returns empty array when no source is available', async () => {
    const roo = makeMockExtractor('roo', { available: false });
    const claude = makeMockExtractor('claude-code', { available: false });

    const unified = new UnifiedTaskExtractor([roo, claude]);
    const sources = await unified.getAvailableSources();

    expect(sources).toEqual([]);
  });

  test('getAvailableSources includes zoo-code when available and preserves order', async () => {
    const roo = makeMockExtractor('roo', { available: false });
    const zoo = makeMockExtractor('zoo-code', { available: true });
    const claude = makeMockExtractor('claude-code', { available: true });

    const unified = new UnifiedTaskExtractor([roo, zoo, claude]);
    const sources = await unified.getAvailableSources();

    // order reflects extractor array order, skipping unavailable roo
    expect(sources).toEqual(['zoo-code', 'claude-code']);
  });

  test('getAvailableSources calls isAvailable on every extractor exactly once', async () => {
    const roo = makeMockExtractor('roo', { available: true });
    const claude = makeMockExtractor('claude-code', { available: true });

    const unified = new UnifiedTaskExtractor([roo, claude]);
    await unified.getAvailableSources();

    expect(roo.isAvailable).toHaveBeenCalledTimes(1);
    expect(claude.isAvailable).toHaveBeenCalledTimes(1);
  });
});
