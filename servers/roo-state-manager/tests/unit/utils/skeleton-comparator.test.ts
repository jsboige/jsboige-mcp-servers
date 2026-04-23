/**
 * Tests for SkeletonComparator
 *
 * Validates comparison of ConversationSkeleton objects including field-level
 * diff detection, severity classification, tolerance checks, improvement
 * identification, and the combined compareWithImprovements flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkeletonComparator } from '../../../src/utils/skeleton-comparator.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId: 'task-001',
    metadata: {
      workspace: 'test-workspace',
      createdAt: '2026-01-01T00:00:00Z',
      lastActivity: '2026-01-01T12:00:00Z',
      messageCount: 10,
      actionCount: 0,
      totalSize: 1024,
    },
    truncatedInstruction: 'Do something',
    childTaskInstructionPrefixes: ['child-1', 'child-2'],
    isCompleted: false,
    sequence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkeletonComparator', () => {
  let comparator: SkeletonComparator;

  beforeEach(() => {
    comparator = new SkeletonComparator();
  });

  // =========================================================================
  // compare — identical skeletons
  // =========================================================================
  describe('compare', () => {
    it('returns areIdentical=true and score=100 for identical skeletons', () => {
      const skeleton = makeSkeleton();
      const result = comparator.compare(skeleton, makeSkeleton());

      expect(result.areIdentical).toBe(true);
      expect(result.similarityScore).toBe(100);
      expect(result.differences).toHaveLength(0);
    });

    // =========================================================================
    // compare — taskId (critical)
    // =========================================================================
    it('detects critical difference when taskId differs', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({ taskId: 'task-999' });
      const result = comparator.compare(oldSk, newSk);

      expect(result.areIdentical).toBe(false);
      const diff = result.differences.find(d => d.field === 'taskId');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('critical');
      expect(diff!.oldValue).toBe('task-001');
      expect(diff!.newValue).toBe('task-999');
    });

    // =========================================================================
    // compare — metadata.workspace (major)
    // =========================================================================
    it('detects major difference when workspace differs', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({
        metadata: { ...oldSk.metadata!, workspace: 'other-workspace' },
      });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'workspace');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
      expect(diff!.oldValue).toBe('test-workspace');
      expect(diff!.newValue).toBe('other-workspace');
    });

    // =========================================================================
    // compare — metadata.createdAt (minor)
    // =========================================================================
    it('detects minor difference when createdAt differs', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({
        metadata: { ...oldSk.metadata!, createdAt: '2026-06-15T00:00:00Z' },
      });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'metadata.createdAt');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('minor');
    });

    // =========================================================================
    // compare — metadata.lastActivity (minor)
    // =========================================================================
    it('detects minor difference when lastActivity differs', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({
        metadata: { ...oldSk.metadata!, lastActivity: '2026-06-15T12:00:00Z' },
      });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'metadata.lastActivity');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('minor');
    });

    // =========================================================================
    // compare — metadata.messageCount (major)
    // =========================================================================
    it('detects major difference when messageCount differs', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({
        metadata: { ...oldSk.metadata!, messageCount: 42 },
      });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'metadata.messageCount');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
      expect(diff!.oldValue).toBe(10);
      expect(diff!.newValue).toBe(42);
    });

    // =========================================================================
    // compare — truncatedInstruction (major)
    // =========================================================================
    it('detects major difference when truncatedInstruction differs', () => {
      const oldSk = makeSkeleton({ truncatedInstruction: 'Do something' });
      const newSk = makeSkeleton({ truncatedInstruction: 'Do something else' });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'truncatedInstruction');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
    });

    // =========================================================================
    // compare — childTaskInstructionPrefixes (set comparison)
    // =========================================================================
    it('detects major difference when childTaskInstructionPrefixes differ', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['a', 'b'] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: ['a', 'c'] });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
    });

    it('considers same prefixes in different order as identical (set comparison)', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['child-1', 'child-2'] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: ['child-2', 'child-1'] });
      const result = comparator.compare(oldSk, newSk);

      const prefixDiff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(prefixDiff).toBeUndefined();
    });

    // =========================================================================
    // compare — isCompleted (major, undefined defaults to false)
    // =========================================================================
    it('detects major difference when isCompleted changes', () => {
      const oldSk = makeSkeleton({ isCompleted: false });
      const newSk = makeSkeleton({ isCompleted: true });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'isCompleted');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
      expect(diff!.oldValue).toBe(false);
      expect(diff!.newValue).toBe(true);
    });

    it('treats undefined isCompleted as false (no difference)', () => {
      const oldSk = makeSkeleton({ isCompleted: undefined });
      const newSk = makeSkeleton({ isCompleted: false });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'isCompleted');
      expect(diff).toBeUndefined();
    });

    // =========================================================================
    // compare — null / undefined equivalence
    // =========================================================================
    it('treats null and undefined metadata fields as equivalent', () => {
      const oldSk = makeSkeleton({
        metadata: {
          workspace: null as any,
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const newSk = makeSkeleton({
        metadata: {
          workspace: undefined,
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const result = comparator.compare(oldSk, newSk);

      const wsDiff = result.differences.find(d => d.field === 'workspace');
      expect(wsDiff).toBeUndefined();
    });

    it('treats null and null metadata fields as equivalent', () => {
      const oldSk = makeSkeleton({
        metadata: {
          createdAt: null as any,
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const newSk = makeSkeleton({
        metadata: {
          createdAt: null as any,
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'metadata.createdAt');
      expect(diff).toBeUndefined();
    });

    // =========================================================================
    // compare — undefined metadata (one or both)
    // =========================================================================
    it('skips metadata comparison when both metadata are undefined', () => {
      const oldSk = makeSkeleton({ metadata: undefined });
      const newSk = makeSkeleton({ metadata: undefined });
      const result = comparator.compare(oldSk, newSk);

      const metaDiffs = result.differences.filter(d =>
        d.field.startsWith('metadata.') || d.field === 'workspace'
      );
      expect(metaDiffs).toHaveLength(0);
    });

    it('skips metadata comparison when one metadata is defined and the other is not', () => {
      const oldSk = makeSkeleton({ metadata: undefined });
      const newSk = makeSkeleton();
      const result = comparator.compare(oldSk, newSk);

      // taskId is always compared, so we filter for metadata-only fields
      const metaDiffs = result.differences.filter(d =>
        d.field === 'workspace' ||
        d.field === 'metadata.createdAt' ||
        d.field === 'metadata.lastActivity' ||
        d.field === 'metadata.messageCount'
      );
      expect(metaDiffs).toHaveLength(0);
    });

    // =========================================================================
    // compare — similarityScore calculation
    // =========================================================================
    it('calculates similarityScore correctly with one difference out of 9', () => {
      const oldSk = makeSkeleton();
      const newSk = makeSkeleton({ taskId: 'different-id' });
      const result = comparator.compare(oldSk, newSk);

      // 1 diff out of 9 fields = (9-1)/9 * 100 = 88.89
      expect(result.similarityScore).toBeCloseTo(88.89, 1);
    });

    it('calculates similarityScore correctly when most fields differ', () => {
      const oldSk: ConversationSkeleton = {
        taskId: 'old-task',
        metadata: {
          workspace: 'old-ws',
          createdAt: '2020-01-01T00:00:00Z',
          lastActivity: '2020-01-01T12:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 0,
        },
        truncatedInstruction: 'old instruction',
        childTaskInstructionPrefixes: ['a'],
        isCompleted: false,
        sequence: [],
      };
      const newSk: ConversationSkeleton = {
        taskId: 'new-task',
        metadata: {
          workspace: 'new-ws',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 99,
          actionCount: 0,
          totalSize: 0,
        },
        truncatedInstruction: 'new instruction',
        childTaskInstructionPrefixes: ['b'],
        isCompleted: true,
        sequence: [],
      };
      const result = comparator.compare(oldSk, newSk);

      // Source uses totalFields=9 but only compares 8 fields:
      // taskId, workspace, createdAt, lastActivity, messageCount,
      // truncatedInstruction, childTaskInstructionPrefixes, isCompleted
      expect(result.differences).toHaveLength(8);
      // (9 - 8) / 9 * 100 = 11.11
      expect(result.similarityScore).toBeCloseTo(11.11, 1);
    });

    // =========================================================================
    // compare — result metadata
    // =========================================================================
    it('includes metadata with comparedAt timestamp, oldSystemName and newSystemName', () => {
      const before = Date.now();
      const result = comparator.compare(makeSkeleton(), makeSkeleton());
      const after = Date.now();

      expect(result.metadata.comparedAt).toBeGreaterThanOrEqual(before);
      expect(result.metadata.comparedAt).toBeLessThanOrEqual(after);
      expect(result.metadata.oldSystemName).toBe('regex-based');
      expect(result.metadata.newSystemName).toBe('json-parsing');
    });
  });

  // ===========================================================================
  // formatReport
  // ===========================================================================
  describe('formatReport', () => {
    it('formats report correctly with differences', () => {
      const result = comparator.compare(
        makeSkeleton({ taskId: 'old' }),
        makeSkeleton({ taskId: 'new' })
      );
      const report = comparator.formatReport(result);

      expect(report).toContain('=== Skeleton Comparison Report ===');
      expect(report).toContain('Similarity Score:');
      expect(report).toContain('Identical: NO');
      expect(report).toContain('Differences:');
      expect(report).toContain('[CRITICAL] taskId:');
      expect(report).toContain('"old"');
      expect(report).toContain('"new"');
    });

    it('formats report with "No differences detected" when identical', () => {
      const result = comparator.compare(makeSkeleton(), makeSkeleton());
      const report = comparator.formatReport(result);

      expect(report).toContain('Identical: YES');
      expect(report).toContain('No differences detected.');
      expect(report).not.toContain('Differences:');
    });
  });

  // ===========================================================================
  // isWithinTolerance
  // ===========================================================================
  describe('isWithinTolerance', () => {
    it('returns false when a critical difference exists regardless of tolerance', () => {
      const result = comparator.compare(
        makeSkeleton({ taskId: 'a' }),
        makeSkeleton({ taskId: 'b' })
      );
      // Even with 100% tolerance, critical diffs block
      expect(comparator.isWithinTolerance(result, 100)).toBe(false);
    });

    it('returns true when no critical diff and similarity >= threshold', () => {
      const result = comparator.compare(
        makeSkeleton({ truncatedInstruction: 'abc' }),
        makeSkeleton({ truncatedInstruction: 'xyz' })
      );
      // 1 major diff out of 9 = 88.89% similarity
      // tolerance 15 → threshold = 85 → 88.89 >= 85 → true
      expect(comparator.isWithinTolerance(result, 15)).toBe(true);
    });

    it('returns false when similarity is below the tolerance threshold', () => {
      const result = comparator.compare(
        makeSkeleton({ truncatedInstruction: 'abc' }),
        makeSkeleton({ truncatedInstruction: 'xyz' })
      );
      // 1 major diff out of 9 = 88.89% similarity
      // tolerance 5 → threshold = 95 → 88.89 < 95 → false
      expect(comparator.isWithinTolerance(result, 5)).toBe(false);
    });

    it('returns true for identical skeletons at tolerance 0', () => {
      const result = comparator.compare(makeSkeleton(), makeSkeleton());
      expect(comparator.isWithinTolerance(result, 0)).toBe(true);
    });
  });

  // ===========================================================================
  // getDifferenceSummary
  // ===========================================================================
  describe('getDifferenceSummary', () => {
    it('returns zero counts for identical skeletons', () => {
      const result = comparator.compare(makeSkeleton(), makeSkeleton());
      const summary = comparator.getDifferenceSummary(result);

      expect(summary.critical).toBe(0);
      expect(summary.major).toBe(0);
      expect(summary.minor).toBe(0);
      expect(summary.total).toBe(0);
    });

    it('counts differences by severity correctly', () => {
      const oldSk = makeSkeleton({
        taskId: 'old-task',
        metadata: {
          workspace: 'old-ws',
          createdAt: '2020-01-01T00:00:00Z',
          lastActivity: '2020-06-01T00:00:00Z',
          messageCount: 5,
          actionCount: 0,
          totalSize: 0,
        },
      });
      const newSk = makeSkeleton({
        taskId: 'new-task',
        metadata: {
          workspace: 'new-ws',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-06-01T00:00:00Z',
          messageCount: 50,
          actionCount: 0,
          totalSize: 0,
        },
      });
      const result = comparator.compare(oldSk, newSk);
      const summary = comparator.getDifferenceSummary(result);

      // taskId = critical (1)
      // workspace, messageCount = major (2)
      // createdAt, lastActivity = minor (2)
      expect(summary.critical).toBe(1);
      expect(summary.major).toBe(2);
      expect(summary.minor).toBe(2);
      expect(summary.total).toBe(5);
    });
  });

  // ===========================================================================
  // identifyImprovements
  // ===========================================================================
  describe('identifyImprovements', () => {
    it('detects more child tasks as improvement', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c'] });
      const improvements = comparator.identifyImprovements(oldSk, newSk);

      expect(improvements).toContain('+2 child tasks détectés (1 → 3)');
    });

    it('does not report improvement when child tasks decrease', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c'] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const improvements = comparator.identifyImprovements(oldSk, newSk);

      const childTaskImprovement = improvements.find(i => i.includes('child tasks'));
      expect(childTaskImprovement).toBeUndefined();
    });

    it('detects Windows path normalization (forward slash to backslash)', () => {
      const oldSk = makeSkeleton({
        metadata: {
          workspace: 'C:/dev/project',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      // The source checks for '\\\\' in the JS string = literal '\\' in the runtime string.
      // A path like 'C:\\dev\\project' contains '\\' which matches includes('\\\\').
      const newSk = makeSkeleton({
        metadata: {
          workspace: 'C:\\\\dev\\\\project',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const improvements = comparator.identifyImprovements(oldSk, newSk);

      // Source pushes: 'Normalisation path Windows (/ → \\\\)' which at runtime is:
      // 'Normalisation path Windows (/ → \\)'
      expect(improvements).toContain('Normalisation path Windows (/ → \\\\)');
    });

    it('detects Windows path normalization (backslash to forward slash)', () => {
      const oldSk = makeSkeleton({
        metadata: {
          workspace: 'C:\\\\dev\\\\project',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const newSk = makeSkeleton({
        metadata: {
          workspace: 'C:/dev/project',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 1024,
        },
      });
      const improvements = comparator.identifyImprovements(oldSk, newSk);

      // Source pushes: 'Normalisation path Windows (\\\\ → /)' which at runtime is:
      // 'Normalisation path Windows (\\ → /)'
      expect(improvements).toContain('Normalisation path Windows (\\\\ → /)');
    });

    it('detects instruction extraction improvement (truncated to complete)', () => {
      const oldSk = makeSkeleton({ truncatedInstruction: 'Some truncated...' });
      const newSk = makeSkeleton({ truncatedInstruction: undefined });
      const improvements = comparator.identifyImprovements(oldSk, newSk);

      expect(improvements).toContain('Instruction complète extraite (truncated → complete)');
    });

    it('returns empty array when no improvements detected', () => {
      const sk = makeSkeleton();
      const improvements = comparator.identifyImprovements(sk, makeSkeleton());

      expect(improvements).toEqual([]);
    });
  });

  // ===========================================================================
  // compareWithImprovements
  // ===========================================================================
  describe('compareWithImprovements', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('combines compare result with improvements and validation', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] });

      // We need to control the parsing config for deterministic validation.
      // The default config requires similarityThreshold=44, minChildTasksImprovement=10, validateImprovements=true.
      // With 11 more child tasks and identical other fields, validation should pass.
      // But we also need at least 1 improvement documented.

      const result = comparator.compareWithImprovements(oldSk, newSk);

      expect(result).toHaveProperty('areIdentical');
      expect(result).toHaveProperty('differences');
      expect(result).toHaveProperty('similarityScore');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('improvements');
      expect(result).toHaveProperty('isValidUpgrade');
      expect(result).toHaveProperty('validationReason');
    });

    it('includes improvements from identifyImprovements', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const newSk = makeSkeleton({
        childTaskInstructionPrefixes: ['a', 'b', 'c'],
        truncatedInstruction: undefined,
      });

      const result = comparator.compareWithImprovements(oldSk, newSk);

      expect(result.improvements.length).toBeGreaterThan(0);
      // Should include child task improvement
      const childTaskImprovement = result.improvements.find(i => i.includes('child tasks'));
      expect(childTaskImprovement).toBeDefined();
    });

    it('preserves base comparison fields', () => {
      const oldSk = makeSkeleton({ taskId: 'task-A' });
      const newSk = makeSkeleton({ taskId: 'task-B' });

      const result = comparator.compareWithImprovements(oldSk, newSk);

      // Base comparison fields present
      expect(result.areIdentical).toBe(false);
      expect(result.similarityScore).toBeLessThan(100);
      const taskIdDiff = result.differences.find(d => d.field === 'taskId');
      expect(taskIdDiff).toBeDefined();
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================
  describe('edge cases', () => {
    it('handles null truncatedInstruction on both sides as identical', () => {
      const oldSk = makeSkeleton({ truncatedInstruction: null });
      const newSk = makeSkeleton({ truncatedInstruction: null });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'truncatedInstruction');
      expect(diff).toBeUndefined();
    });

    it('handles null vs undefined truncatedInstruction as a difference', () => {
      const oldSk = makeSkeleton({ truncatedInstruction: null });
      const newSk = makeSkeleton({ truncatedInstruction: undefined });
      const result = comparator.compare(oldSk, newSk);

      // null and undefined are NOT treated as equivalent for truncatedInstruction
      const diff = result.differences.find(d => d.field === 'truncatedInstruction');
      expect(diff).toBeDefined();
    });

    it('handles empty childTaskInstructionPrefixes arrays as identical', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: [] });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: [] });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(diff).toBeUndefined();
    });

    it('handles undefined childTaskInstructionPrefixes on both sides as identical', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: undefined });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: undefined });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(diff).toBeUndefined();
    });

    it('handles undefined vs empty array childTaskInstructionPrefixes as identical', () => {
      const oldSk = makeSkeleton({ childTaskInstructionPrefixes: undefined });
      const newSk = makeSkeleton({ childTaskInstructionPrefixes: [] });
      const result = comparator.compare(oldSk, newSk);

      const diff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(diff).toBeUndefined();
    });

    it('handles multiple differences simultaneously with correct score', () => {
      const oldSk: ConversationSkeleton = {
        taskId: 'task-001',
        metadata: {
          workspace: 'ws-1',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-01T12:00:00Z',
          messageCount: 10,
          actionCount: 0,
          totalSize: 0,
        },
        truncatedInstruction: 'instruction-A',
        childTaskInstructionPrefixes: ['a'],
        isCompleted: false,
        sequence: [],
      };
      const newSk: ConversationSkeleton = {
        taskId: 'task-001',  // same
        metadata: {
          workspace: 'ws-2',  // different
          createdAt: '2026-01-01T00:00:00Z',  // same
          lastActivity: '2026-02-01T12:00:00Z',  // different
          messageCount: 10,  // same
          actionCount: 0,
          totalSize: 0,
        },
        truncatedInstruction: 'instruction-A',  // same
        childTaskInstructionPrefixes: ['a', 'b'],  // different
        isCompleted: true,  // different
        sequence: [],
      };
      const result = comparator.compare(oldSk, newSk);

      // 4 differences: workspace, lastActivity, childTaskInstructionPrefixes, isCompleted
      expect(result.differences).toHaveLength(4);
      // (9 - 4) / 9 * 100 = 55.56
      expect(result.similarityScore).toBeCloseTo(55.56, 1);
    });
  });
});
