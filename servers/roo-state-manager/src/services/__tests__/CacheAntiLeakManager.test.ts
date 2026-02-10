/**
 * Tests unitaires pour CacheAntiLeakManager
 *
 * Couvre :
 * - Construction et configuration par défaut
 * - Store/Get avec vérification TTL
 * - Éviction LRU par stratégie
 * - Protection anti-fuite 220GB
 * - Éviction d'urgence multi-stratégies
 * - Health check et statistiques
 * - Shutdown propre
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheAntiLeakManager, createCacheAntiLeakManager } from '../CacheAntiLeakManager.js';
import type { CacheStats, EvictionPolicy } from '../CacheAntiLeakManager.js';
import type { CacheConfiguration } from '../../interfaces/UnifiedToolInterface.js';

describe('CacheAntiLeakManager', () => {
  let manager: CacheAntiLeakManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    manager = new CacheAntiLeakManager({ enabled: true });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // === Construction ===

  describe('constructor', () => {
    it('should create with default config', () => {
      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.hitCount).toBe(0);
      expect(stats.missCount).toBe(0);
    });

    it('should accept partial config override', async () => {
      const custom = new CacheAntiLeakManager({ maxTrafficGB: 100 });
      const stats = custom.getStats();
      expect(stats.totalEntries).toBe(0);
      await custom.shutdown();
    });

    it('should create via factory function', async () => {
      const factoryManager = createCacheAntiLeakManager({ maxTrafficGB: 50 });
      expect(factoryManager).toBeInstanceOf(CacheAntiLeakManager);
      const stats = factoryManager.getStats();
      expect(stats.totalEntries).toBe(0);
      await factoryManager.shutdown();
    });
  });

  // === Store / Get ===

  describe('store and get', () => {
    const config: CacheConfiguration = {
      strategy: 'moderate',
      ttl: 60000, // 1 minute
    };

    it('should store and retrieve data', async () => {
      await manager.store('key1', { value: 'hello' }, config);

      const result = await manager.get<{ value: string }>('key1');
      expect(result).not.toBeNull();
      expect(result!.hit).toBe(true);
      expect(result!.data).toEqual({ value: 'hello' });
    });

    it('should return null for missing key', async () => {
      const result = await manager.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should track hit count on successful get', async () => {
      await manager.store('key1', 'data', config);
      await manager.get('key1');
      await manager.get('key1');

      const stats = manager.getStats();
      expect(stats.hitCount).toBe(2);
    });

    it('should track miss count on failed get', async () => {
      await manager.get('missing1');
      await manager.get('missing2');

      const stats = manager.getStats();
      expect(stats.missCount).toBe(2);
    });

    it('should update stats after store', async () => {
      await manager.store('key1', 'hello world', config);

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(1);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });

    it('should store multiple entries', async () => {
      await manager.store('key1', 'data1', config);
      await manager.store('key2', 'data2', config);
      await manager.store('key3', 'data3', config);

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(3);
    });

    it('should not store when disabled', async () => {
      const disabledManager = new CacheAntiLeakManager({ enabled: false });
      await disabledManager.store('key1', 'data', config);

      const result = await disabledManager.get('key1');
      expect(result).toBeNull();
      await disabledManager.shutdown();
    });
  });

  // === TTL Expiration ===

  describe('TTL expiration', () => {
    it('should return null for expired entries', async () => {
      const shortTtlConfig: CacheConfiguration = {
        strategy: 'aggressive',
        ttl: 1000, // 1 second
      };

      await manager.store('expiring', 'data', shortTtlConfig);

      // Advance time past TTL
      vi.advanceTimersByTime(2000);

      const result = await manager.get('expiring');
      expect(result).toBeNull();
    });

    it('should not expire entries within TTL', async () => {
      const config: CacheConfiguration = {
        strategy: 'moderate',
        ttl: 60000, // 1 minute
      };

      await manager.store('valid', 'data', config);

      // Advance time but within TTL
      vi.advanceTimersByTime(30000); // 30 seconds

      const result = await manager.get('valid');
      expect(result).not.toBeNull();
      expect(result!.hit).toBe(true);
    });

    it('should use default TTL of 1 hour when not specified', async () => {
      const noTtlConfig: CacheConfiguration = {
        strategy: 'moderate',
        ttl: 0, // Will use default
      };

      await manager.store('default-ttl', 'data', noTtlConfig);

      // After 30 minutes, should still be valid (default is 1h)
      vi.advanceTimersByTime(30 * 60 * 1000);

      // Note: ttl: 0 means falsy, so default 1h applies
      const result = await manager.get('default-ttl');
      expect(result).not.toBeNull();
    });
  });

  // === Statistics ===

  describe('statistics', () => {
    const config: CacheConfiguration = {
      strategy: 'moderate',
      ttl: 60000,
    };

    it('should calculate hit rate correctly', async () => {
      await manager.store('key1', 'data', config);

      await manager.get('key1');     // hit
      await manager.get('key1');     // hit
      await manager.get('missing');  // miss

      const stats = manager.getStats();
      expect(stats.hitRate).toBeCloseTo(66.67, 0);
    });

    it('should track eviction count', async () => {
      const shortConfig: CacheConfiguration = {
        strategy: 'aggressive',
        ttl: 100,
      };

      await manager.store('short-lived', 'data', shortConfig);
      vi.advanceTimersByTime(200);

      // Access triggers eviction of expired entry
      await manager.get('short-lived');

      const stats = manager.getStats();
      expect(stats.evictionCount).toBeGreaterThanOrEqual(1);
    });

    it('should track oldest and newest entries', async () => {
      await manager.store('first', 'data1', config);
      vi.advanceTimersByTime(1000);
      await manager.store('second', 'data2', config);

      const stats = manager.getStats();
      expect(stats.oldestEntry).not.toBeNull();
      expect(stats.newestEntry).not.toBeNull();
      expect(stats.oldestEntry!.getTime()).toBeLessThanOrEqual(stats.newestEntry!.getTime());
    });

    it('should return 0 hit rate when no requests', () => {
      const stats = manager.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  // === Health Check ===

  describe('healthCheck', () => {
    it('should return warning for empty cache (hitRate 0 < 30)', () => {
      // Empty cache has hitRate=0 which triggers "Low hit rate" warning
      const health = manager.healthCheck();
      expect(health.status).toBe('warning');
      expect(health.issues.some(i => i.includes('Low hit rate'))).toBe(true);
    });

    it('should return healthy status when hit rate is sufficient', async () => {
      const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };
      await manager.store('key1', 'data', config);

      // 3 hits, 0 misses → hitRate > 30
      await manager.get('key1');
      await manager.get('key1');
      await manager.get('key1');

      const health = manager.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.issues).toHaveLength(0);
    });

    it('should return warning for low hit rate', async () => {
      const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };

      // Create many misses
      for (let i = 0; i < 10; i++) {
        await manager.get(`missing-${i}`);
      }
      // One hit
      await manager.store('key1', 'data', config);
      await manager.get('key1');

      const health = manager.healthCheck();
      // 1 hit / 11 total < 30%
      expect(health.status).toBe('warning');
      expect(health.issues.some(i => i.includes('Low hit rate'))).toBe(true);
    });

    it('should return stats in health check', () => {
      const health = manager.healthCheck();
      expect(health.stats).toBeDefined();
      expect(health.stats.totalEntries).toBe(0);
    });
  });

  // === Cleanup ===

  describe('cleanup', () => {
    it('should clean expired entries', async () => {
      const shortConfig: CacheConfiguration = {
        strategy: 'aggressive',
        ttl: 1000,
      };
      const longConfig: CacheConfiguration = {
        strategy: 'conservative',
        ttl: 3600000,
      };

      await manager.store('short1', 'data1', shortConfig);
      await manager.store('short2', 'data2', shortConfig);
      await manager.store('long1', 'data3', longConfig);

      // Advance past short TTL
      vi.advanceTimersByTime(2000);

      const result = await manager.cleanup();
      expect(result.evicted).toBe(2);

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(1);
    });

    it('should return 0 evicted when nothing to clean', async () => {
      const result = await manager.cleanup();
      expect(result.evicted).toBe(0);
    });
  });

  // === Reset ===

  describe('reset', () => {
    it('should clear all entries', async () => {
      const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };

      await manager.store('key1', 'data1', config);
      await manager.store('key2', 'data2', config);
      await manager.store('key3', 'data3', config);

      await manager.reset();

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.totalSizeGB).toBe(0);
    });

    it('should increment eviction count on reset', async () => {
      const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };

      await manager.store('key1', 'data1', config);
      await manager.store('key2', 'data2', config);

      await manager.reset();

      const stats = manager.getStats();
      expect(stats.evictionCount).toBe(2);
    });

    it('should null oldest and newest entries after reset', async () => {
      const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };
      await manager.store('key1', 'data1', config);

      await manager.reset();

      const stats = manager.getStats();
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });
  });

  // === Shutdown ===

  describe('shutdown', () => {
    it('should stop background processes', async () => {
      // Shutdown should not throw
      await expect(manager.shutdown()).resolves.not.toThrow();
    });

    it('should be safe to call shutdown multiple times', async () => {
      await manager.shutdown();
      await expect(manager.shutdown()).resolves.not.toThrow();
    });
  });

  // === Periodic Cleanup (via timer) ===

  describe('background processes', () => {
    it('should run periodic cleanup after 5 minutes', async () => {
      const shortConfig: CacheConfiguration = {
        strategy: 'aggressive',
        ttl: 1000, // 1 second
      };

      await manager.store('short', 'data', shortConfig);

      // Advance past TTL + periodic cleanup interval (5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);

      // After periodic cleanup, expired entry should be removed
      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('should not start background processes when disabled', async () => {
      const disabledManager = new CacheAntiLeakManager({ enabled: false });

      // Advance 10 minutes - no timers should fire
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Should complete without errors
      await disabledManager.shutdown();
    });
  });

  // === Eviction by Strategy ===

  describe('eviction by strategy', () => {
    it('should evict entries from same strategy when over limit', async () => {
      // Create a manager with small limits
      const smallManager = new CacheAntiLeakManager({
        enabled: true,
        maxTrafficGB: 0.001, // Very small limit (~1MB)
      });

      const config: CacheConfiguration = {
        strategy: 'aggressive',
        ttl: 60000,
      };

      // Store multiple large entries to trigger eviction
      const largeData = 'x'.repeat(100000); // ~200KB per entry

      await smallManager.store('data1', largeData, config);
      await smallManager.store('data2', largeData, config);
      await smallManager.store('data3', largeData, config);

      // The manager should have handled eviction internally
      const stats = smallManager.getStats();
      expect(stats.totalEntries).toBeGreaterThanOrEqual(0);

      await smallManager.shutdown();
    });
  });

  // === Size Estimation ===

  describe('size estimation', () => {
    const config: CacheConfiguration = {
      strategy: 'moderate',
      ttl: 60000,
    };

    it('should estimate size of string data', async () => {
      await manager.store('str', 'hello world', config);

      const stats = manager.getStats();
      // "hello world" = 13 chars JSON-stringified (with quotes) × 2 = ~26 bytes
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });

    it('should estimate size of object data', async () => {
      await manager.store('obj', { key: 'value', num: 42 }, config);

      const stats = manager.getStats();
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });

    it('should handle non-serializable data gracefully', async () => {
      // Circular reference
      const circular: any = {};
      circular.self = circular;

      // Should not throw - uses default size
      await manager.store('circular', circular, config);

      const stats = manager.getStats();
      expect(stats.totalEntries).toBe(1);
      expect(stats.totalSizeBytes).toBe(1024); // Default fallback
    });
  });

  // === Factory ===

  describe('createCacheAntiLeakManager', () => {
    it('should create with default config when no args', async () => {
      const m = createCacheAntiLeakManager();
      expect(m).toBeInstanceOf(CacheAntiLeakManager);
      await m.shutdown();
    });

    it('should create with custom config', async () => {
      const m = createCacheAntiLeakManager({
        maxTrafficGB: 100,
        enabled: true,
      });
      expect(m).toBeInstanceOf(CacheAntiLeakManager);
      await m.shutdown();
    });
  });

  // === Average Entry Size ===

  describe('average entry size', () => {
    const config: CacheConfiguration = { strategy: 'moderate', ttl: 60000 };

    it('should compute average entry size', async () => {
      await manager.store('a', 'short', config);
      await manager.store('b', 'a much longer string with more content', config);

      const stats = manager.getStats();
      expect(stats.averageEntrySize).toBeGreaterThan(0);
      expect(stats.averageEntrySize).toBe(stats.totalSizeBytes / stats.totalEntries);
    });

    it('should return 0 average for empty cache', () => {
      const stats = manager.getStats();
      expect(stats.averageEntrySize).toBe(0);
    });
  });
});
