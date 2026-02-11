/**
 * Tests unitaires pour SkeletonComparator
 *
 * Couvre :
 * - compare : comparaison champ par champ
 * - formatReport : rendu texte du rapport
 * - isWithinTolerance : validation des seuils
 * - getDifferenceSummary : résumé par sévérité
 * - identifyImprovements : détection d'améliorations
 * - compareWithImprovements : comparaison enrichie
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SkeletonComparator, type SkeletonComparisonResult } from '../skeleton-comparator.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function createSkeleton(overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
  return {
    taskId: 'task-001',
    metadata: {
      title: 'Test task',
      lastActivity: '2026-02-10T10:00:00Z',
      createdAt: '2026-02-10T09:00:00Z',
      messageCount: 10,
      actionCount: 5,
      totalSize: 2048,
      workspace: '/workspace/project',
    },
    sequence: [],
    childTaskInstructionPrefixes: ['prefix-1', 'prefix-2'],
    isCompleted: true,
    truncatedInstruction: 'Do something',
    ...overrides,
  };
}

describe('SkeletonComparator', () => {
  let comparator: SkeletonComparator;

  beforeEach(() => {
    comparator = new SkeletonComparator();
  });

  // === compare ===

  describe('compare', () => {
    it('should return identical for same skeletons', () => {
      const skeleton = createSkeleton();
      const result = comparator.compare(skeleton, skeleton);

      expect(result.areIdentical).toBe(true);
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should detect taskId difference as critical', () => {
      const old = createSkeleton({ taskId: 'task-old' });
      const newer = createSkeleton({ taskId: 'task-new' });
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(false);
      const taskIdDiff = result.differences.find(d => d.field === 'taskId');
      expect(taskIdDiff).toBeDefined();
      expect(taskIdDiff!.severity).toBe('critical');
    });

    it('should detect workspace difference as major', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, workspace: '/other/workspace' },
      });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'workspace');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
    });

    it('should detect messageCount difference as major', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, messageCount: 20 },
      });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'metadata.messageCount');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
    });

    it('should detect lastActivity difference as minor', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, lastActivity: '2026-02-11T10:00:00Z' },
      });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'metadata.lastActivity');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('minor');
    });

    it('should detect childTaskInstructionPrefixes difference', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['a', 'b'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['a', 'c'] });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'childTaskInstructionPrefixes');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('major');
    });

    it('should detect isCompleted difference', () => {
      const old = createSkeleton({ isCompleted: true });
      const newer = createSkeleton({ isCompleted: false });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'isCompleted');
      expect(diff).toBeDefined();
    });

    it('should detect truncatedInstruction difference', () => {
      const old = createSkeleton({ truncatedInstruction: 'old instruction' });
      const newer = createSkeleton({ truncatedInstruction: 'new instruction' });
      const result = comparator.compare(old, newer);

      const diff = result.differences.find(d => d.field === 'truncatedInstruction');
      expect(diff).toBeDefined();
    });

    it('should calculate similarity score correctly', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, messageCount: 99 },
      });
      const result = comparator.compare(old, newer);

      // 1 difference out of 9 fields = 8/9 * 100 ≈ 88.89%
      expect(result.similarityScore).toBeCloseTo(88.89, 0);
    });

    it('should include metadata in result', () => {
      const result = comparator.compare(createSkeleton(), createSkeleton());

      expect(result.metadata.comparedAt).toBeGreaterThan(0);
      expect(result.metadata.oldSystemName).toBe('regex-based');
      expect(result.metadata.newSystemName).toBe('json-parsing');
    });
  });

  // === formatReport ===

  describe('formatReport', () => {
    it('should format identical report', () => {
      const result = comparator.compare(createSkeleton(), createSkeleton());
      const report = comparator.formatReport(result);

      expect(report).toContain('Skeleton Comparison Report');
      expect(report).toContain('Similarity Score: 100.00%');
      expect(report).toContain('Identical: YES');
      expect(report).toContain('No differences detected');
    });

    it('should format report with differences', () => {
      const old = createSkeleton({ taskId: 'old' });
      const newer = createSkeleton({ taskId: 'new' });
      const result = comparator.compare(old, newer);
      const report = comparator.formatReport(result);

      expect(report).toContain('Identical: NO');
      expect(report).toContain('[CRITICAL]');
      expect(report).toContain('taskId');
    });
  });

  // === isWithinTolerance ===

  describe('isWithinTolerance', () => {
    it('should return true for identical skeletons', () => {
      const result = comparator.compare(createSkeleton(), createSkeleton());
      expect(comparator.isWithinTolerance(result, 10)).toBe(true);
    });

    it('should return false for critical differences', () => {
      const old = createSkeleton({ taskId: 'old' });
      const newer = createSkeleton({ taskId: 'new' });
      const result = comparator.compare(old, newer);

      // Even with 100% tolerance, critical diffs are never acceptable
      expect(comparator.isWithinTolerance(result, 100)).toBe(false);
    });

    it('should respect tolerance threshold', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, messageCount: 99, lastActivity: 'different' },
      });
      const result = comparator.compare(old, newer);

      // 2 differences out of 9 = ~77.78% similarity
      expect(comparator.isWithinTolerance(result, 25)).toBe(true); // 77.78 >= 75
      expect(comparator.isWithinTolerance(result, 10)).toBe(false); // 77.78 < 90
    });
  });

  // === getDifferenceSummary ===

  describe('getDifferenceSummary', () => {
    it('should count differences by severity', () => {
      const old = createSkeleton({ taskId: 'old' }); // critical: taskId
      const newer = createSkeleton({
        taskId: 'new',
        metadata: {
          ...createSkeleton().metadata,
          messageCount: 99, // major
          lastActivity: 'different', // minor
        },
      });
      const result = comparator.compare(old, newer);
      const summary = comparator.getDifferenceSummary(result);

      expect(summary.critical).toBe(1);
      expect(summary.major).toBeGreaterThanOrEqual(1);
      expect(summary.total).toBe(result.differences.length);
    });

    it('should return zeros for identical skeletons', () => {
      const result = comparator.compare(createSkeleton(), createSkeleton());
      const summary = comparator.getDifferenceSummary(result);

      expect(summary.critical).toBe(0);
      expect(summary.major).toBe(0);
      expect(summary.minor).toBe(0);
      expect(summary.total).toBe(0);
    });
  });

  // === identifyImprovements ===

  describe('identifyImprovements', () => {
    it('should detect more child tasks as improvement', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c', 'd'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+3 child tasks'))).toBe(true);
    });

    it('should detect no improvements when new has fewer child tasks', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['a'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('child tasks'))).toBe(false);
    });

    it('should detect complete instruction extraction', () => {
      const old = createSkeleton({ truncatedInstruction: 'long instruction...' });
      const newer = createSkeleton({ truncatedInstruction: undefined });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('complete'))).toBe(true);
    });

    it('should return empty for identical skeletons', () => {
      const skeleton = createSkeleton();
      const improvements = comparator.identifyImprovements(skeleton, skeleton);
      expect(improvements).toHaveLength(0);
    });
  });

  // === compareWithImprovements ===

  describe('compareWithImprovements', () => {
    it('should include improvements in result', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: [] });
      const newer = createSkeleton({
        childTaskInstructionPrefixes: Array.from({ length: 15 }, (_, i) => `prefix-${i}`),
      });

      const result = comparator.compareWithImprovements(old, newer);

      expect(result.improvements).toBeDefined();
      expect(result.isValidUpgrade).toBeDefined();
      expect(result.validationReason).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const skeleton = createSkeleton();
      const result = comparator.compareWithImprovements(skeleton, skeleton);

      expect(result.areIdentical).toBeDefined();
      expect(result.differences).toBeDefined();
      expect(result.similarityScore).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
  });
});
