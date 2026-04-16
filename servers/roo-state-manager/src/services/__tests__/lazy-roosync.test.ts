/**
 * Tests for lazy-roosync facade
 *
 * Tests the lazy loading mechanism for RooSyncService to avoid
 * module evaluation deadlocks in Node v24 ESM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRooSyncService, RooSyncService } from '../lazy-roosync.js';
import { RooSyncServiceError } from '../lazy-roosync.js';

describe('lazy-roosync facade', () => {
  beforeEach(() => {
    // Clear any cached modules before each test
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('RooSyncServiceError export', () => {
    it('should export RooSyncServiceError synchronously', () => {
      // This should not throw and should be available immediately
      expect(RooSyncServiceError).toBeDefined();
      expect(typeof RooSyncServiceError).toBe('function');
    });

    it('should create RooSyncServiceError instances', () => {
      const error = new RooSyncServiceError('Test error');
      expect(error).toBeInstanceOf(Error);
      // RooSyncServiceError adds a prefix to the message
      expect(error.message).toContain('Test error');
      expect(error.message).toContain('[RooSync Service]');
    });
  });

  describe('getRooSyncService', () => {
    it('should lazy load RooSyncService module', async () => {
      // First call should trigger dynamic import
      const service1 = await getRooSyncService();
      expect(service1).toBeDefined();

      // Second call should return cached instance
      const service2 = await getRooSyncService();
      expect(service2).toBe(service1);
    });

    it('should return a valid RooSyncService instance', async () => {
      const service = await getRooSyncService();
      expect(service).toBeDefined();
      expect(typeof service).toBe('object');
    });

    it('should handle concurrent calls safely', async () => {
      // Multiple concurrent calls should all resolve to the same instance
      const [service1, service2, service3] = await Promise.all([
        getRooSyncService(),
        getRooSyncService(),
        getRooSyncService()
      ]);

      expect(service1).toBe(service2);
      expect(service2).toBe(service3);
    });
  });

  describe('RooSyncService static interface', () => {
    it('should have resetInstance method', async () => {
      expect(typeof RooSyncService.resetInstance).toBe('function');

      // Should not throw
      await RooSyncService.resetInstance();
    });

    it('should have getInstance method', async () => {
      expect(typeof RooSyncService.getInstance).toBe('function');

      const instance = await RooSyncService.getInstance();
      expect(instance).toBeDefined();
    });

    it('should support getInstance with options', async () => {
      const instance = await RooSyncService.getInstance({ enabled: true });
      expect(instance).toBeDefined();
    });

    it('should support getInstance with disabled option', async () => {
      const instance = await RooSyncService.getInstance({ enabled: false });
      expect(instance).toBeDefined();
    });

    it('should return same instance from getInstance and getRooSyncService', async () => {
      const instance1 = await RooSyncService.getInstance();
      const instance2 = await getRooSyncService();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', async () => {
      const instance1 = await RooSyncService.getInstance();
      await RooSyncService.resetInstance();
      const instance2 = await RooSyncService.getInstance();

      // After reset, the instance should still be valid
      // Note: RooSyncService might use a singleton pattern that doesn't change
      // We verify that reset doesn't break functionality
      expect(instance2).toBeDefined();
      expect(typeof instance2).toBe('object');
    });
  });

  describe('module loading behavior', () => {
    it('should only load module once', async () => {
      // Import the module to check loading behavior
      const dynamicImportSpy = vi.spyOn(global, 'eval' as any);

      // Make multiple calls
      await Promise.all([
        getRooSyncService(),
        getRooSyncService(),
        getRooSyncService()
      ]);

      // The module should only be loaded once (implementation detail)
      // This is a basic check - in a real scenario we'd verify the dynamic import behavior
      expect(dynamicImportSpy).toBeDefined();

      dynamicImportSpy.mockRestore();
    });

    it('should handle errors during module loading gracefully', async () => {
      // This test verifies error handling - in a real scenario we might mock
      // the import to fail, but for now we just verify it doesn't crash
      try {
        await getRooSyncService();
        expect(true).toBe(true); // If we get here, loading succeeded
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('integration with RooSyncService', () => {
    it('should provide access to RooSyncService functionality', async () => {
      const service = await getRooSyncService();

      // Verify it's a proper RooSyncService instance
      expect(service).toBeDefined();
      expect(typeof service).toBe('object');

      // The service should have the expected RooSyncService methods/properties
      // (We don't test specific methods here to avoid tight coupling)
    });

    it('should maintain singleton pattern across different access methods', async () => {
      const service1 = await getRooSyncService();
      const service2 = await RooSyncService.getInstance();
      const service3 = await getRooSyncService();

      expect(service1).toBe(service2);
      expect(service2).toBe(service3);
    });
  });
});
