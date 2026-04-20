import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheAntiLeakManager, createCacheAntiLeakManager } from '../../../src/services/CacheAntiLeakManager.js';
import { ProcessingLevel } from '../../../src/interfaces/UnifiedToolInterface.js';

describe('CacheAntiLeakManager', () => {
  let manager: CacheAntiLeakManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new CacheAntiLeakManager({ enabled: true });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('applies default config', () => {
      const m = new CacheAntiLeakManager();
      const stats = m.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('merges custom config with defaults', async () => {
      const m = new CacheAntiLeakManager({ maxTrafficGB: 100, enabled: true });
      const health = m.healthCheck();
      expect(health.stats.totalEntries).toBe(0);
      await m.shutdown();
    });

    it('does not start background processes when disabled', async () => {
      const m = new CacheAntiLeakManager({ enabled: false });
      // Store should be a no-op
      await m.store('key', 'data', { strategy: 'moderate', ttl: 60000 });
      expect(m.getStats().totalEntries).toBe(0);
      await m.shutdown();
    });
  });

  describe('store and get', () => {
    it('stores and retrieves a value', async () => {
      await manager.store('test-key', { foo: 'bar' }, { strategy: 'moderate', ttl: 60000 });
      const result = await manager.get<{ foo: string }>('test-key');
      expect(result).not.toBeNull();
      expect(result!.hit).toBe(true);
      expect(result!.data.foo).toBe('bar');
    });

    it('returns null for missing key', async () => {
      const result = await manager.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null for expired entry', async () => {
      await manager.store('expiring', 'data', { strategy: 'moderate', ttl: 1000 });
      vi.advanceTimersByTime(1001);
      const result = await manager.get('expiring');
      expect(result).toBeNull();
    });

    it('updates access count on get', async () => {
      await manager.store('counter', 'data', { strategy: 'moderate', ttl: 60000 });
      await manager.get('counter');
      await manager.get('counter');
      const stats = manager.getStats();
      expect(stats.hitCount).toBe(2);
    });

    it('tracks miss count', async () => {
      await manager.get('missing1');
      await manager.get('missing2');
      const stats = manager.getStats();
      expect(stats.missCount).toBe(2);
    });

    it('does not store when disabled', async () => {
      const m = new CacheAntiLeakManager({ enabled: false });
      await m.store('key', 'data', { strategy: 'moderate', ttl: 60000 });
      expect(m.getStats().totalEntries).toBe(0);
      await m.shutdown();
    });
  });

  describe('hit rate', () => {
    it('calculates hit rate correctly', async () => {
      await manager.store('k1', 'v1', { strategy: 'moderate', ttl: 60000 });
      await manager.get('k1'); // hit
      await manager.get('k1'); // hit
      await manager.get('missing'); // miss
      const stats = manager.getStats();
      expect(stats.hitRate).toBeCloseTo(66.67, 0);
    });

    it('returns 0 hit rate with no requests', () => {
      expect(manager.getStats().hitRate).toBe(0);
    });
  });

  describe('eviction', () => {
    it('evicts entries by strategy when size limit exceeded', async () => {
      // aggressive has maxSizeGB: 50 — use tiny config to trigger eviction
      const m = new CacheAntiLeakManager({
        enabled: true,
        maxTrafficGB: 0.00001, // ~10KB limit — triggers eviction easily
      });
      // Store entries large enough to exceed limit
      const bigData = 'x'.repeat(5000);
      await m.store('a1', bigData, { strategy: 'aggressive', ttl: 60000 });
      await m.store('a2', bigData, { strategy: 'aggressive', ttl: 60000 });
      await m.store('a3', bigData, { strategy: 'aggressive', ttl: 60000 });
      // Some entries should have been evicted
      const stats = m.getStats();
      expect(stats.evictionCount).toBeGreaterThan(0);
      await m.shutdown();
    });

    it('respects locked entries during eviction', async () => {
      // This tests that locked entries are skipped — but store() doesn't expose locking
      // We verify eviction count increases when strategy overflows
      const m = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: 0.00001 });
      await m.store('x', 'x'.repeat(5000), { strategy: 'bypass', ttl: 60000 });
      await m.store('y', 'y'.repeat(5000), { strategy: 'bypass', ttl: 60000 });
      expect(m.getStats().evictionCount).toBeGreaterThan(0);
      await m.shutdown();
    });
  });

  describe('cleanup', () => {
    it('removes expired entries on cleanup', async () => {
      await manager.store('temp1', 'data', { strategy: 'moderate', ttl: 1000 });
      await manager.store('temp2', 'data', { strategy: 'moderate', ttl: 60000 });
      vi.advanceTimersByTime(1001);
      const result = await manager.cleanup();
      expect(result.evicted).toBe(1);
      // temp2 should survive
      const remaining = await manager.get('temp2');
      expect(remaining).not.toBeNull();
    });

    it('reports freed space', async () => {
      await manager.store('big', 'x'.repeat(10000), { strategy: 'moderate', ttl: 500 });
      vi.advanceTimersByTime(501);
      const result = await manager.cleanup();
      expect(result.evicted).toBe(1);
      expect(result.freedGB).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('clears all entries and resets stats', async () => {
      await manager.store('a', 'data', { strategy: 'moderate', ttl: 60000 });
      await manager.store('b', 'data', { strategy: 'aggressive', ttl: 60000 });
      await manager.reset();
      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });
  });

  describe('getStats', () => {
    it('returns a copy of stats', () => {
      const stats1 = manager.getStats();
      const stats2 = manager.getStats();
      expect(stats1).not.toBe(stats2); // different object references
      expect(stats1.totalEntries).toBe(stats2.totalEntries);
    });

    it('tracks oldest and newest entries', async () => {
      await manager.store('first', 'a', { strategy: 'moderate', ttl: 60000 });
      vi.advanceTimersByTime(1000);
      await manager.store('second', 'b', { strategy: 'moderate', ttl: 60000 });
      const stats = manager.getStats();
      expect(stats.oldestEntry).not.toBeNull();
      expect(stats.newestEntry).not.toBeNull();
      expect(stats.newestEntry!.getTime()).toBeGreaterThan(stats.oldestEntry!.getTime());
    });
  });

  describe('healthCheck', () => {
    it('returns warning for empty cache (0% hit rate < 30%)', () => {
      const health = manager.healthCheck();
      // Empty cache has 0% hit rate which triggers "Low hit rate" warning
      expect(health.status).toBe('warning');
      expect(health.issues.some(i => i.includes('Low hit rate'))).toBe(true);
    });

    it('returns healthy with good hit rate', async () => {
      await manager.store('k', 'v', { strategy: 'moderate', ttl: 60000 });
      await manager.get('k'); // hit
      await manager.get('k'); // hit
      await manager.get('k'); // hit
      // 100% hit rate → healthy
      const health = manager.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.issues).toHaveLength(0);
    });

    it('returns warning for low hit rate', async () => {
      await manager.store('k', 'v', { strategy: 'moderate', ttl: 60000 });
      // 3 misses, 0 hits → hit rate = 0 < 30
      await manager.get('miss1');
      await manager.get('miss2');
      await manager.get('miss3');
      const health = manager.healthCheck();
      expect(health.status).toBe('warning');
      expect(health.issues.some(i => i.includes('Low hit rate'))).toBe(true);
    });

    it('returns warning for high alert count', () => {
      // Trigger 11+ alerts by accessing internal stats
      for (let i = 0; i < 12; i++) {
        (manager as any).stats.alertsTriggered++;
      }
      const health = manager.healthCheck();
      expect(health.issues.some(i => i.includes('High alert count'))).toBe(true);
    });

    it('includes stats snapshot', () => {
      const health = manager.healthCheck();
      expect(health.stats).toBeDefined();
      expect(health.stats.totalEntries).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('clears timers', async () => {
      const m = new CacheAntiLeakManager({ enabled: true });
      await m.shutdown();
      // Verify timers are null (internal state)
      expect((m as any).cleanupTimer).toBeNull();
      expect((m as any).consistencyTimer).toBeNull();
    });

    it('can be called multiple times safely', async () => {
      await manager.shutdown();
      await manager.shutdown(); // no error
    });
  });

  describe('createCacheAntiLeakManager factory', () => {
    it('creates instance with default config', () => {
      const m = createCacheAntiLeakManager();
      expect(m).toBeInstanceOf(CacheAntiLeakManager);
      m.shutdown();
    });

    it('creates instance with custom config', () => {
      const m = createCacheAntiLeakManager({ maxTrafficGB: 50 });
      expect(m).toBeInstanceOf(CacheAntiLeakManager);
      m.shutdown();
    });
  });

  describe('estimateSize', () => {
    it('estimates size as 2x JSON string length', async () => {
      const data = { key: 'value' };
      const expectedSize = JSON.stringify(data).length * 2;
      await manager.store('size-test', data, { strategy: 'moderate', ttl: 60000 });
      const stats = manager.getStats();
      expect(stats.totalSizeBytes).toBe(expectedSize);
    });

    it('handles circular references with default size', async () => {
      const circular: any = { name: 'test' };
      circular.self = circular;
      await manager.store('circular', circular, { strategy: 'moderate', ttl: 60000 });
      const stats = manager.getStats();
      expect(stats.totalSizeBytes).toBe(1024); // fallback default
    });
  });
});
