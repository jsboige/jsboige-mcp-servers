import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordToolCall,
  getToolUsageSnapshot,
  resetMetrics,
} from '../../../src/utils/tool-call-metrics';

describe('tool-call-metrics', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('recordToolCall', () => {
    it('creates entry for new tool', () => {
      recordToolCall('test-tool', 100, false);
      const snap = getToolUsageSnapshot();
      expect(snap.uniqueTools).toBe(1);
      expect(snap.totalCalls).toBe(1);
    });

    it('increments count for existing tool', () => {
      recordToolCall('test-tool', 50, false);
      recordToolCall('test-tool', 150, false);
      const snap = getToolUsageSnapshot();
      expect(snap.totalCalls).toBe(2);
      expect(snap.uniqueTools).toBe(1);
    });

    it('tracks errors', () => {
      recordToolCall('fail-tool', 100, true);
      recordToolCall('fail-tool', 200, false);
      recordToolCall('fail-tool', 300, true);
      const snap = getToolUsageSnapshot();
      expect(snap.errorTools).toEqual([{ name: 'fail-tool', errorCount: 2 }]);
    });

    it('tracks multiple tools', () => {
      recordToolCall('tool-a', 10, false);
      recordToolCall('tool-b', 20, false);
      recordToolCall('tool-a', 30, false);
      const snap = getToolUsageSnapshot();
      expect(snap.uniqueTools).toBe(2);
      expect(snap.totalCalls).toBe(3);
    });
  });

  describe('getToolUsageSnapshot', () => {
    it('returns empty snapshot when no calls', () => {
      const snap = getToolUsageSnapshot();
      expect(snap.totalCalls).toBe(0);
      expect(snap.uniqueTools).toBe(0);
      expect(snap.topTools).toEqual([]);
      expect(snap.bottomTools).toEqual([]);
      expect(snap.errorTools).toEqual([]);
    });

    it('sorts topTools by count descending', () => {
      recordToolCall('rare', 10, false);
      recordToolCall('common', 10, false);
      recordToolCall('common', 10, false);
      recordToolCall('common', 10, false);
      const snap = getToolUsageSnapshot(2);
      expect(snap.topTools[0].name).toBe('common');
      expect(snap.topTools[0].count).toBe(3);
    });

    it('respects topN parameter', () => {
      for (let i = 0; i < 10; i++) {
        recordToolCall(`tool-${i}`, 10, false);
      }
      const snap = getToolUsageSnapshot(3);
      expect(snap.topTools.length).toBe(3);
    });

    it('calculates avgMs correctly', () => {
      recordToolCall('avg-tool', 100, false);
      recordToolCall('avg-tool', 200, false);
      const snap = getToolUsageSnapshot();
      expect(snap.topTools[0].avgMs).toBe(150);
    });

    it('returns sessionStartAt as ISO string', () => {
      const snap = getToolUsageSnapshot();
      expect(snap.sessionStartAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('resetMetrics', () => {
    it('clears all metrics', () => {
      recordToolCall('a', 10, false);
      recordToolCall('b', 20, true);
      resetMetrics();
      const snap = getToolUsageSnapshot();
      expect(snap.totalCalls).toBe(0);
      expect(snap.uniqueTools).toBe(0);
    });
  });
});
