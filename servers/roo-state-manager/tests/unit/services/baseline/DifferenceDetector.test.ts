import { describe, it, expect, beforeEach } from 'vitest';
import { DifferenceDetector } from '../../../../src/services/baseline/DifferenceDetector.js';
import { BaselineDifference, BaselineComparisonReport } from '../../../../src/types/baseline.js';

describe('DifferenceDetector', () => {
  let detector: DifferenceDetector;

  beforeEach(() => {
    detector = new DifferenceDetector();
  });

  describe('calculateSummary', () => {
    it('should calculate summary correctly', () => {
      const differences: BaselineDifference[] = [
        { category: 'config', path: 'p1', baselineValue: 'a', actualValue: 'b', severity: 'CRITICAL', description: 'd1', recommendedAction: 'sync_to_baseline' },
        { category: 'config', path: 'p2', baselineValue: 'a', actualValue: 'b', severity: 'IMPORTANT', description: 'd2', recommendedAction: 'manual_review' },
        { category: 'config', path: 'p3', baselineValue: 'a', actualValue: 'b', severity: 'WARNING', description: 'd3', recommendedAction: 'manual_review' },
        { category: 'config', path: 'p4', baselineValue: 'a', actualValue: 'b', severity: 'INFO', description: 'd4', recommendedAction: 'manual_review' },
        { category: 'config', path: 'p5', baselineValue: 'a', actualValue: 'b', severity: 'CRITICAL', description: 'd5', recommendedAction: 'sync_to_baseline' }
      ];

      const summary = detector.calculateSummary(differences);

      expect(summary.total).toBe(5);
      expect(summary.critical).toBe(2);
      expect(summary.important).toBe(1);
      expect(summary.warning).toBe(1);
      expect(summary.info).toBe(1);
    });

    it('should handle empty differences', () => {
      const summary = detector.calculateSummary([]);

      expect(summary.total).toBe(0);
      expect(summary.critical).toBe(0);
    });
  });

  describe('createSyncDecisions', () => {
    const mockReport: BaselineComparisonReport = {
      targetMachine: 'target-1',
      baselineMachine: 'base-1',
      baselineVersion: '1.0.0',
      generatedAt: '2023-01-01T00:00:00Z',
      differences: [
        { category: 'config', path: 'roo.modes', baselineValue: 'a', actualValue: 'b', severity: 'CRITICAL', description: 'd1', recommendedAction: 'sync_to_baseline' },
        { category: 'hardware', path: 'cpu.cores', baselineValue: 4, actualValue: 8, severity: 'IMPORTANT', description: 'd2', recommendedAction: 'keep_target' },
        { category: 'software', path: 'node', baselineValue: '18', actualValue: '20', severity: 'WARNING', description: 'd3', recommendedAction: 'manual_review' },
        { category: 'system', path: 'os', baselineValue: 'win', actualValue: 'linux', severity: 'INFO', description: 'd4', recommendedAction: 'manual_review' }
      ],
      summary: { total: 4, critical: 1, important: 1, warning: 1, info: 1 }
    };

    it('should create decisions for all differences with default threshold (IMPORTANT)', () => {
      const decisions = detector.createSyncDecisions(mockReport);

      expect(decisions).toHaveLength(2); // CRITICAL and IMPORTANT
      expect(decisions[0].severity).toBe('CRITICAL');
      expect(decisions[1].severity).toBe('IMPORTANT');
    });

    it('should filter decisions based on severity threshold', () => {
      const decisions = detector.createSyncDecisions(mockReport, 'WARNING');

      expect(decisions).toHaveLength(3); // CRITICAL, IMPORTANT, WARNING
    });

    it('should recommend actions correctly', () => {
      const decisions = detector.createSyncDecisions(mockReport, 'INFO');

      // CRITICAL -> sync_to_baseline
      expect(decisions.find(d => d.severity === 'CRITICAL')?.action).toBe('sync_to_baseline');
      
      // Config -> sync_to_baseline (mockReport has config as CRITICAL, let's check logic)
      // The logic is: CRITICAL -> sync, config -> sync, hardware -> keep, else manual
      
      // Hardware (IMPORTANT) -> keep_target
      expect(decisions.find(d => d.category === 'hardware')?.action).toBe('keep_target');

      // Software (WARNING) -> manual_review
      expect(decisions.find(d => d.category === 'software')?.action).toBe('manual_review');
    });

    it('should generate unique IDs for decisions', () => {
      const decisions = detector.createSyncDecisions(mockReport, 'INFO');
      const ids = decisions.map(d => d.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});