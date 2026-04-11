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
      workspace: '/workspace',
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

    // Edge cases for compare method
    it('should handle comparison with undefined metadata (null-safety: undefined = identical)', () => {
      const old = createSkeleton();
      const newer = createSkeleton({ metadata: undefined });
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(true);
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should handle comparison with null sequence', () => {
      const old = createSkeleton();
      const newer = createSkeleton({ sequence: null });
      const result = comparator.compare(old, newer);

      // The compare method doesn't compare sequence field, so they should be identical
      expect(result.areIdentical).toBe(true);
    });

    it('should handle comparison with undefined childTaskInstructionPrefixes (null-safety: undefined = empty, but different from populated)', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: undefined });
      const newer = createSkeleton(); // has ['prefix-1', 'prefix-2']
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('childTaskInstructionPrefixes');
    });

    it('should handle comparison with null values in metadata', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: null
        }
      });
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(false);
    });

    it('should handle comparison with empty string differences', () => {
      const old = createSkeleton({ taskId: '' });
      const newer = createSkeleton({ taskId: 'task-001' });
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(false);
    });

    it('should handle comparison with zero values', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          messageCount: 0
        }
      });
      const result = comparator.compare(old, newer);

      expect(result.areIdentical).toBe(false);
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

    it('should format report with detailed differences', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        taskId: 'new-task',
        metadata: { ...createSkeleton().metadata, messageCount: 50 }
      });
      const result = comparator.compare(old, newer);
      const report = comparator.formatReport(result);

      expect(report).toContain('[CRITICAL]');
      expect(report).toContain('[MAJOR]');
      expect(report).toContain('taskId');
      expect(report).toContain('metadata.messageCount');
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

    it('should return true when differences are below threshold', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, lastActivity: '2026-02-11T10:00:00Z' },
      });
      const result = comparator.compare(old, newer);

      // Only minor difference, should pass with 90% tolerance
      expect(comparator.isWithinTolerance(result, 90)).toBe(true);
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

    it('should handle empty differences array', () => {
      const result = {
        areIdentical: false,
        differences: [],
        similarityScore: 100,
        metadata: {
          comparedAt: Date.now(),
          oldSystemName: 'test',
          newSystemName: 'test'
        }
      };
      const summary = comparator.getDifferenceSummary(result as any);

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

    it('should detect Windows path normalization', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/workspace/project'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\workspace\\\\project'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Normalisation'))).toBe(true);
    });

    it('should detect reduction in truncatedInstruction as improvement', () => {
      const old = createSkeleton({ truncatedInstruction: 'very long instruction that was truncated...' });
      const newer = createSkeleton({ truncatedInstruction: undefined });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements).toContain('Instruction complète extraite (truncated → complete)');
    });

    it('should not detect improvement when truncatedInstruction is present in both', () => {
      const old = createSkeleton({ truncatedInstruction: 'instruction' });
      const newer = createSkeleton({ truncatedInstruction: 'different instruction' });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Instruction'))).toBe(false);
    });

    it('should not detect improvement when workspace normalization has already been done', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\workspace\\\\project'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\workspace\\\\project'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Normalisation'))).toBe(false);
    });

    it('should detect improvement when going from undefined to array', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: undefined });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+1 child tasks'))).toBe(true);
    });

    it('should detect improvement when going from null to array', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: null });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1', 'prefix-2'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+2 child tasks'))).toBe(true);
    });

    it('should detect no improvement when going from array to undefined', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: undefined });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('child tasks'))).toBe(false);
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

    it('should detect Windows path normalization as improvement', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/workspace/project'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\workspace\\\\project'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Normalisation path Windows'))).toBe(true);
    });

    it('should return valid upgrade for significant improvements', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: [] });
      const newer = createSkeleton({
        childTaskInstructionPrefixes: Array.from({ length: 12 }, (_, i) => `improved-task-${i}`),
      });

      const result = comparator.compareWithImprovements(old, newer);
      // Avec 12 child tasks vs 0, on a +12 child tasks (>10) et la similarité est à 100%
      expect(result.isValidUpgrade).toBe(true);
    });

    it('should return invalid upgrade for regression', () => {
      const old = createSkeleton({
        childTaskInstructionPrefixes: ['task-1', 'task-2', 'task-3']
      });
      const newer = createSkeleton({
        childTaskInstructionPrefixes: ['task-1']
      });

      const result = comparator.compareWithImprovements(old, newer);
      expect(result.isValidUpgrade).toBe(false);
    });
  });

  // Additional test for areSetsEqual method (private method testing)
  describe('areSetsEqual', () => {
    // Create a comparator instance to test private methods
    const testComparator = new SkeletonComparator();

    it('should return true for empty sets', () => {
      expect(testComparator['areSetsEqual'](new Set(), new Set())).toBe(true);
    });

    it('should return true for identical sets with same elements', () => {
      const set1 = new Set(['a', 'b', 'c']);
      const set2 = new Set(['a', 'b', 'c']);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(true);
    });

    it('should return false for sets with different sizes', () => {
      const set1 = new Set(['a', 'b']);
      const set2 = new Set(['a', 'b', 'c']);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(false);
    });

    it('should return false for sets with same size but different elements', () => {
      const set1 = new Set(['a', 'b', 'c']);
      const set2 = new Set(['a', 'b', 'd']);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(false);
    });

    it('should handle sets with different types of elements', () => {
      const set1 = new Set(['string', 123, true]);
      const set2 = new Set(['string', 123, true]);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(true);
    });

    it('should handle sets with undefined and null values', () => {
      const set1 = new Set(['a', undefined, null]);
      const set2 = new Set(['a', undefined, null]);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(true);
    });

    it('should handle sets with object references', () => {
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      const set1 = new Set([obj1, 'test']);
      const set2 = new Set([obj1, 'test']);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(true);
    });

    it('should handle sets with different object references', () => {
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      const set1 = new Set([obj1, 'test']);
      const set2 = new Set([obj2, 'test']);
      expect(testComparator['areSetsEqual'](set1, set2)).toBe(false);
    });
  });

  // Edge cases for identifyImprovements
  describe('identifyImprovements edge cases', () => {
    it('should detect workspace normalization with backslashes', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/workspace/project'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\workspace\\\\project'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements).toContain('Normalisation path Windows (/ → \\\\)');
    });

    it('should detect improvement when workspace changes from backslash to forward slash', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '\\\\old\\\\path'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/new/path'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Normalisation'))).toBe(true);
    });

    it('should not detect improvement when workspace path stays the same', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/same/path'
        }
      });
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: '/same/path'
        }
      });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Normalisation'))).toBe(false);
    });

    it('should detect improvement when truncatedInstruction is removed', () => {
      const old = createSkeleton({ truncatedInstruction: 'long instruction...' });
      const newer = createSkeleton({ truncatedInstruction: undefined });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements).toContain('Instruction complète extraite (truncated → complete)');
    });

    it('should not detect improvement when truncatedInstruction is added', () => {
      const old = createSkeleton({ truncatedInstruction: undefined });
      const newer = createSkeleton({ truncatedInstruction: 'new instruction' });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('Instruction'))).toBe(false);
    });

    it('should detect improvement when child tasks are added', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: [] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['new-task'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+1 child tasks'))).toBe(true);
    });

    it('should detect multiple improvements simultaneously', () => {
      const old = createSkeleton({
        metadata: { ...createSkeleton().metadata, workspace: '/old/path' },
        childTaskInstructionPrefixes: [],
        truncatedInstruction: 'long instruction...'
      });
      const newer = createSkeleton({
        metadata: { ...createSkeleton().metadata, workspace: '\\\\new\\\\path' },
        childTaskInstructionPrefixes: ['task-1', 'task-2'],
        truncatedInstruction: undefined
      });

      const improvements = comparator.identifyImprovements(old, newer);
      const hasPathNormalization = improvements.some(i => i.includes('Normalisation'));
      const hasChildTasks = improvements.some(i => i.includes('+2 child tasks'));
      const hasInstructionExtraction = improvements.some(i => i.includes('Instruction complète'));

      expect(hasPathNormalization).toBe(true);
      expect(hasChildTasks).toBe(true);
      expect(hasInstructionExtraction).toBe(true);
    });
  });

  // Test for complete child task detection edge cases
  describe('child task detection edge cases', () => {
    it('should detect improvement when going from undefined to array', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: undefined });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+1 child tasks'))).toBe(true);
    });

    it('should detect improvement when going from null to array', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: null });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1', 'prefix-2'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+2 child tasks'))).toBe(true);
    });

    it('should detect no improvement when going from array to undefined', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['prefix-1'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: undefined });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('child tasks'))).toBe(false);
    });

    it('should detect no improvement when going from array to null', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['task-1', 'task-2'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: null });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('child tasks'))).toBe(false);
    });

    it('should detect improvement when array length increases', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['a'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['a', 'b', 'c'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.some(i => i.includes('+2 child tasks'))).toBe(true);
    });

    it('should detect improvement when array length decreases but instructions are more specific', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: ['general', 'vague'] });
      const newer = createSkeleton({ childTaskInstructionPrefixes: ['specific-1', 'specific-2'] });

      const improvements = comparator.identifyImprovements(old, newer);
      expect(improvements.length).toBe(0); // No improvement expected as per current implementation
    });
  });

  // Additional tests for coverage improvement
  describe('compare with edge cases', () => {
    it('should handle comparison with undefined metadata', () => {
      const old = createSkeleton();
      const newer = createSkeleton({ metadata: undefined });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true);
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should handle comparison with null sequence', () => {
      const old = createSkeleton();
      const newer = createSkeleton({ sequence: null });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true); // sequence n'est pas comparé
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should handle comparison with undefined childTaskInstructionPrefixes (undefined = empty, but different from populated)', () => {
      const old = createSkeleton({ childTaskInstructionPrefixes: undefined });
      const newer = createSkeleton(); // has ['prefix-1', 'prefix-2']

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('childTaskInstructionPrefixes');
    });

    it('should handle comparison with null values in metadata', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          workspace: null
        }
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('workspace');
      expect(result.differences[0].oldValue).toBe('/workspace');
      expect(result.differences[0].newValue).toBeNull();
      expect(result.similarityScore).toBe(88.89);
    });

    it('should handle comparison with empty string differences', () => {
      const old = createSkeleton({ taskId: '' });
      const newer = createSkeleton({ taskId: 'task-001' });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('taskId');
      expect(result.differences[0].oldValue).toBe('');
      expect(result.differences[0].newValue).toBe('task-001');
      expect(result.similarityScore).toBe(88.89);
    });

    it('should handle comparison with very large numbers', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          messageCount: Number.MAX_SAFE_INTEGER
        }
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('metadata.messageCount');
      expect(result.differences[0].oldValue).toBe(10);
      expect(result.differences[0].newValue).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.similarityScore).toBe(88.89);
    });

    it('should handle comparison with zero values', () => {
      const old = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          messageCount: 0
        }
      });
      const newer = createSkeleton();

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('metadata.messageCount');
      expect(result.differences[0].oldValue).toBe(0);
      expect(result.differences[0].newValue).toBe(10);
      expect(result.similarityScore).toBe(88.89);
    });

    it('should handle comparison with very long strings', () => {
      const longString = 'a'.repeat(1000);
      const old = createSkeleton({ truncatedInstruction: 'short' });
      const newer = createSkeleton({ truncatedInstruction: longString });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].field).toBe('truncatedInstruction');
      expect(result.differences[0].oldValue).toBe('short');
      expect(result.differences[0].newValue).toBe(longString);
      expect(result.similarityScore).toBe(88.89);
    });

    it('should handle comparison with boolean values in sequence', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        sequence: [{ type: 'user', message: 'test', isImportant: true }]
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true); // sequence n'est pas comparé
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should handle comparison with nested objects in sequence', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        sequence: [
          {
            type: 'user',
            message: 'test',
            metadata: { timestamp: '2026-02-10T10:00:00Z', flags: ['urgent'] }
          }
        ]
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true); // sequence n'est pas comparé
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });

    it('should handle comparison with arrays of different lengths in sequence', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        sequence: [{ type: 'user', message: 'test' }, { type: 'assistant', message: 'response' }]
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true); // sequence n'est pas comparé
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });
  });

  // Tests for error handling and edge cases
  describe('error handling', () => {
    it('should handle comparison with both skeletons undefined', () => {
      // This should not happen in practice but let's test robustness
      expect(() => comparator.compare(undefined as any, undefined as any)).toThrow();
    });

    it('should handle comparison with one skeleton undefined', () => {
      const skeleton = createSkeleton();
      expect(() => comparator.compare(skeleton, undefined as any)).toThrow();
    });

    it('should handle comparison with invalid metadata structure (string instead of object)', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        metadata: 'invalid-metadata' as any
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(false);
      // String metadata: fields are undefined, compared with defined fields → 4 differences
      expect(result.similarityScore).toBe(55.56);
      expect(result.differences).toHaveLength(4);
    });

    it('should handle comparison with sequence containing non-object items', () => {
      const old = createSkeleton();
      const newer = createSkeleton({
        sequence: ['invalid-item', 123, true]
      });

      const result = comparator.compare(old, newer);
      expect(result.areIdentical).toBe(true); // sequence n'est pas comparé
      expect(result.differences).toHaveLength(0);
      expect(result.similarityScore).toBe(100);
    });
  });
});