import { describe, it, expect, beforeEach } from 'vitest';

describe('tool-call-metrics', () => {
  let recordToolCall: typeof import('../tool-call-metrics.js')['recordToolCall'];
  let getToolUsageSnapshot: typeof import('../tool-call-metrics.js')['getToolUsageSnapshot'];
  let resetMetrics: typeof import('../tool-call-metrics.js')['resetMetrics'];

  beforeEach(async () => {
    const mod = await import('../tool-call-metrics.js');
    recordToolCall = mod.recordToolCall;
    getToolUsageSnapshot = mod.getToolUsageSnapshot;
    resetMetrics = mod.resetMetrics;
    resetMetrics();
  });

  it('should start with empty metrics', () => {
    const snapshot = getToolUsageSnapshot();
    expect(snapshot.totalCalls).toBe(0);
    expect(snapshot.uniqueTools).toBe(0);
    expect(snapshot.topTools).toHaveLength(0);
    expect(snapshot.bottomTools).toHaveLength(0);
  });

  it('should record a single tool call', () => {
    recordToolCall('roosync_read', 150, false);
    const snapshot = getToolUsageSnapshot();
    expect(snapshot.totalCalls).toBe(1);
    expect(snapshot.uniqueTools).toBe(1);
    expect(snapshot.topTools[0].name).toBe('roosync_read');
    expect(snapshot.topTools[0].count).toBe(1);
    expect(snapshot.topTools[0].avgMs).toBe(150);
  });

  it('should accumulate calls for same tool', () => {
    recordToolCall('roosync_read', 100, false);
    recordToolCall('roosync_read', 200, false);
    recordToolCall('roosync_read', 300, false);
    const snapshot = getToolUsageSnapshot();
    expect(snapshot.totalCalls).toBe(3);
    expect(snapshot.uniqueTools).toBe(1);
    expect(snapshot.topTools[0].count).toBe(3);
    expect(snapshot.topTools[0].avgMs).toBe(200);
  });

  it('should track multiple tools and rank by count', () => {
    recordToolCall('roosync_dashboard', 50, false);
    recordToolCall('roosync_dashboard', 60, false);
    recordToolCall('roosync_dashboard', 70, false);
    recordToolCall('roosync_read', 100, false);
    recordToolCall('roosync_read', 200, false);
    recordToolCall('conversation_browser', 500, false);

    const snapshot = getToolUsageSnapshot();
    expect(snapshot.totalCalls).toBe(6);
    expect(snapshot.uniqueTools).toBe(3);
    expect(snapshot.topTools[0].name).toBe('roosync_dashboard');
    expect(snapshot.topTools[0].count).toBe(3);
    expect(snapshot.bottomTools[0].name).toBe('conversation_browser');
    expect(snapshot.bottomTools[0].count).toBe(1);
  });

  it('should track error counts', () => {
    recordToolCall('roosync_send', 100, false);
    recordToolCall('roosync_send', 200, true);
    recordToolCall('roosync_send', 50, true);

    const snapshot = getToolUsageSnapshot();
    expect(snapshot.errorTools).toHaveLength(1);
    expect(snapshot.errorTools[0].name).toBe('roosync_send');
    expect(snapshot.errorTools[0].errorCount).toBe(2);
  });

  it('should reset metrics', () => {
    recordToolCall('roosync_read', 100, false);
    resetMetrics();
    const snapshot = getToolUsageSnapshot();
    expect(snapshot.totalCalls).toBe(0);
    expect(snapshot.uniqueTools).toBe(0);
  });

  it('should return top 5 and bottom 5 by default', () => {
    for (let i = 1; i <= 8; i++) {
      for (let j = 0; j < i; j++) {
        recordToolCall(`tool_${i}`, 10, false);
      }
    }
    const snapshot = getToolUsageSnapshot(5, 5);
    expect(snapshot.topTools).toHaveLength(5);
    expect(snapshot.bottomTools).toHaveLength(5);
    expect(snapshot.topTools[0].name).toBe('tool_8');
    expect(snapshot.bottomTools[0].name).toBe('tool_1');
  });
});
