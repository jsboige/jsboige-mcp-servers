/**
 * Cluster E coverage — file 2/3 — DEEP branch assertions for ClusterSummaryService.
 *
 * The existing ClusterSummaryService.test.ts (630 lines, 30+ tests) is BROAD but
 * SHALLOW: nearly every test asserts only `result.success === true`. Three
 * families of genuinely non-covered branches are added here (scepticism #815,
 * anchored on the real source contract — never fabricated):
 *
 *  1. Pure formatting utilities (formatBytes / formatDuration / sanitizeId) —
 *     private deterministic functions with multiple format branches that had
 *     ZERO direct assertions. Accessed via a typed cast (no `any`, lint-clean;
 *     mirrors the existing `as unknown as` idiom in the sibling test).
 *  2. Sort-comparator ORDER — the sibling test calls every clusterSortBy mode
 *     but never checks order; it only asserts success. `buildClusterResult`
 *     builds taskIndex from `organizedTasks.sortedTasks`, so taskIndex order
 *     is the observable proxy for the comparator (chronology ASC, size DESC,
 *     activity DESC, alphabetical ASC, default=chronology).
 *  3. Statistics VALUES — the sibling test asserts only `statistics !==
 *     undefined`. This asserts the actual computed values (clusterDepth 1-vs-2,
 *     taskDistribution.bySize small/medium/large branches, averageTaskSize,
 *     totalTasks) — the real computation, not a shape check.
 *
 * Tests-only, 0 source runtime touched.
 */
import { describe, it, expect } from 'vitest';
import { ClusterSummaryService } from '../ClusterSummaryService.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';

// Typed view onto the private pure-utility methods under test (avoids `any`).
interface ClusterSummaryServiceInternals {
  formatBytes(bytes: number): string;
  formatDuration(hours: number): string;
  sanitizeId(id: string): string;
}

// Minimal mock-task builder (kept local; the sibling test's helper is not exported).
function task(
  id: string,
  opts: { parent?: string; title?: string; size?: number; createdAt?: string; lastActivity?: string; mode?: string } = {}
): ConversationSkeleton {
  const now = opts.createdAt ?? new Date('2026-07-01T10:00:00Z').toISOString();
  return {
    taskId: id,
    parentTaskId: opts.parent,
    metadata: {
      title: opts.title ?? id,
      lastActivity: opts.lastActivity ?? now,
      createdAt: opts.createdAt ?? now,
      mode: opts.mode ?? 'code',
      messageCount: 5,
      actionCount: 1,
      totalSize: opts.size ?? 1000,
    },
    sequence: [] as MessageSkeleton[],
    isCompleted: true,
    truncatedInstruction: `Instruction ${id}`,
  };
}

describe('ClusterSummaryService — formatBytes (4 branches)', () => {
  const fmt = (b: number) => (new ClusterSummaryService() as unknown as ClusterSummaryServiceInternals).formatBytes(b);

  it('< 1024 → "<n> B"', () => {
    expect(fmt(0)).toBe('0 B');
    expect(fmt(1)).toBe('1 B');
    expect(fmt(1023)).toBe('1023 B');
  });

  it('KB range (1024 ≤ b < 1MB)', () => {
    expect(fmt(1024)).toBe('1 KB');
    expect(fmt(2048)).toBe('2 KB');
  });

  it('MB range (1MB ≤ b < 1GB)', () => {
    expect(fmt(1024 * 1024)).toBe('1 MB');
    expect(fmt(1024 * 1024 * 5)).toBe('5 MB');
  });

  it('GB range (b ≥ 1GB)', () => {
    expect(fmt(1024 * 1024 * 1024)).toBe('1 GB');
    expect(fmt(1024 * 1024 * 1024 * 3)).toBe('3 GB');
  });
});

describe('ClusterSummaryService — formatDuration (3 branches)', () => {
  const fmt = (h: number) => (new ClusterSummaryService() as unknown as ClusterSummaryServiceInternals).formatDuration(h);

  it('< 1 hour → "<m> minutes"', () => {
    expect(fmt(0.5)).toBe('30 minutes');
    expect(fmt(0.25)).toBe('15 minutes');
  });

  it('1 ≤ h < 24 → "<n> heures" (no singular/plural handling)', () => {
    // NOTE: source has no plural logic — 1 hour renders as "1 heures".
    expect(fmt(1)).toBe('1 heures');
    expect(fmt(2.5)).toBe('2.5 heures');
  });

  it('h ≥ 24 → "<d>j <rh>h"', () => {
    expect(fmt(24)).toBe('1j 0h');
    expect(fmt(26)).toBe('1j 2h');
    expect(fmt(48)).toBe('2j 0h');
  });
});

describe('ClusterSummaryService — sanitizeId (regex transforms)', () => {
  const s = (id: string) => (new ClusterSummaryService() as unknown as ClusterSummaryServiceInternals).sanitizeId(id);

  it('lowercases uppercase letters', () => {
    expect(s('UPPER')).toBe('upper');
  });

  it('replaces non [a-z0-9-_] chars (space, slash, dot) with a dash', () => {
    expect(s('Task A_B/C')).toBe('task-a_b-c'); // underscore preserved, space+slash → dash
    expect(s('a..b')).toBe('a-b'); // dots → dashes
  });

  it('collapses consecutive dashes and trims leading/trailing dashes', () => {
    expect(s('---weird---')).toBe('weird');
    expect(s('  spaces  ')).toBe('spaces');
  });
});

// ============================================================
// Sort-comparator ORDER (observable via taskIndex, built from sortedTasks)
// ============================================================
describe('ClusterSummaryService — sort order (via taskIndex)', () => {
  it('chronological sorts ASC by createdAt', async () => {
    const service = new ClusterSummaryService();
    const root = task('root', { createdAt: '2026-07-01T10:00:00Z' });
    const children = [
      task('late', { parent: 'root', createdAt: '2026-07-01T12:00:00Z' }),
      task('mid', { parent: 'root', createdAt: '2026-07-01T11:00:00Z' }),
    ];
    const result = await service.generateClusterSummary(root, children, { clusterSortBy: 'chronological' });
    const order = result.taskIndex.map(t => t.taskId);
    expect(order).toEqual(['root', 'mid', 'late']);
  });

  it('size sorts DESC by totalSize', async () => {
    const service = new ClusterSummaryService();
    const root = task('root', { size: 1000 });
    const children = [
      task('huge', { parent: 'root', size: 5000 }),
      task('tiny', { parent: 'root', size: 100 }),
    ];
    const result = await service.generateClusterSummary(root, children, { clusterSortBy: 'size' });
    const order = result.taskIndex.map(t => t.taskId);
    expect(order).toEqual(['huge', 'root', 'tiny']); // 5000, 1000, 100
  });

  it('alphabetical sorts ASC by title (localeCompare)', async () => {
    const service = new ClusterSummaryService();
    const root = task('root', { title: 'Root' });
    const children = [
      task('c-z', { parent: 'root', title: 'Zebra' }),
      task('c-a', { parent: 'root', title: 'Alpha' }),
    ];
    const result = await service.generateClusterSummary(root, children, { clusterSortBy: 'alphabetical' });
    const titles = result.taskIndex.map(t => t.title);
    expect(titles).toEqual(['Alpha', 'Root', 'Zebra']);
  });

  it('activity sorts DESC by lastActivity (most recent first)', async () => {
    const service = new ClusterSummaryService();
    const root = task('root', { lastActivity: '2026-07-01T09:00:00Z' });
    const children = [
      task('c-old', { parent: 'root', lastActivity: '2026-07-01T08:00:00Z' }),
      task('c-new', { parent: 'root', lastActivity: '2026-07-01T11:00:00Z' }),
    ];
    const result = await service.generateClusterSummary(root, children, { clusterSortBy: 'activity' });
    const order = result.taskIndex.map(t => t.taskId);
    // 11:00 > 09:00 > 08:00
    expect(order).toEqual(['c-new', 'root', 'c-old']);
  });

  it('default (no clusterSortBy) falls back to chronological', async () => {
    const service = new ClusterSummaryService();
    const root = task('root', { createdAt: '2026-07-01T10:00:00Z' });
    const children = [task('later', { parent: 'root', createdAt: '2026-07-01T13:00:00Z' })];
    const result = await service.generateClusterSummary(root, children, {});
    const order = result.taskIndex.map(t => t.taskId);
    expect(order).toEqual(['root', 'later']); // chronological ASC, not size/alphabetical
  });
});

// ============================================================
// Statistics VALUES (deeper than the sibling's `!== undefined`)
// ============================================================
describe('ClusterSummaryService — statistics values', () => {
  it('clusterDepth is 1 for a single root, 2 once children exist', async () => {
    const service = new ClusterSummaryService();
    const single = await service.generateClusterSummary(task('solo'), [], {});
    expect(single.statistics.clusterDepth).toBe(1);

    const withChildren = await service.generateClusterSummary(
      task('root'),
      [task('c1', { parent: 'root' }), task('c2', { parent: 'root' })],
      {}
    );
    expect(withChildren.statistics.clusterDepth).toBe(2);
  });

  it('totalTasks counts root + children', async () => {
    const service = new ClusterSummaryService();
    const result = await service.generateClusterSummary(
      task('root'),
      [task('c1', { parent: 'root' }), task('c2', { parent: 'root' }), task('c3', { parent: 'root' })],
      {}
    );
    expect(result.statistics.totalTasks).toBe(4);
  });

  it('taskDistribution.bySize crosses small / medium / large thresholds', async () => {
    const service = new ClusterSummaryService();
    // small < 10000 ; medium < 100000 ; large >= 100000
    const result = await service.generateClusterSummary(
      task('root', { size: 500 }), // small
      [
        task('c-med', { parent: 'root', size: 50000 }), // medium
        task('c-lrg', { parent: 'root', size: 200000 }), // large
      ],
      {}
    );
    expect(result.statistics.taskDistribution.bySize).toEqual({ small: 1, medium: 1, large: 1 });
  });

  it('averageTaskSize = sum(totalSize) / totalTasks', async () => {
    const service = new ClusterSummaryService();
    const result = await service.generateClusterSummary(
      task('root', { size: 500 }),
      [task('c-med', { parent: 'root', size: 50000 }), task('c-lrg', { parent: 'root', size: 200000 })],
      {}
    );
    // (500 + 50000 + 200000) / 3 = 83500
    expect(result.statistics.averageTaskSize).toBe(83500);
  });

  it('clusterTimeSpan.totalDurationHours = (max-min createdAt) in hours', async () => {
    const service = new ClusterSummaryService();
    const result = await service.generateClusterSummary(
      task('root', { createdAt: '2026-07-01T10:00:00Z' }),
      [task('c1', { parent: 'root', createdAt: '2026-07-01T13:00:00Z' })], // +3h
      {}
    );
    expect(result.statistics.clusterTimeSpan.totalDurationHours).toBe(3);
  });
});
