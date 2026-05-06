/**
 * Tests for #2017: ROOSYNC_SHARED_PATH resilience
 *
 * Tests the static retry/recovery logic on RooSyncService by directly
 * manipulating the internal state, without constructing real service instances.
 *
 * @module services/__tests__/shared-path-resilience.test
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Bypass the broad mock from jest.setup.js — we need the REAL class with new static methods
vi.unmock('../RooSyncService.js');
vi.unmock('../../src/services/RooSyncService.js');

import { RooSyncService } from '../RooSyncService.js';

beforeEach(() => {
  // Reset static state between tests
  RooSyncService.resetInstance();
});

describe('#2017 Shared Path Resilience', () => {

  describe('Static state management', () => {
    test('isDegraded() returns false after resetInstance()', () => {
      expect(RooSyncService.isDegraded()).toBe(false);
    });

    test('getInitError() returns null after resetInstance()', () => {
      expect(RooSyncService.getInitError()).toBeNull();
    });

    test('isDegraded() returns true when instance is null and _initError is set', () => {
      // Directly set the internal state to simulate a failed init
      (RooSyncService as any).instance = null;
      (RooSyncService as any)._initError = new Error('Shared path not found');
      (RooSyncService as any)._lastInitAttempt = Date.now();

      expect(RooSyncService.isDegraded()).toBe(true);
    });

    test('getInitError() returns the cached error', () => {
      const error = new Error('ROOSYNC_SHARED_PATH n\'existe pas');
      (RooSyncService as any)._initError = error;

      expect(RooSyncService.getInitError()).toBe(error);
    });

    test('resetInstance() clears all degraded state', () => {
      (RooSyncService as any)._initError = new Error('test');
      (RooSyncService as any)._lastInitAttempt = Date.now();
      (RooSyncService as any).instance = null;

      RooSyncService.resetInstance();

      expect(RooSyncService.isDegraded()).toBe(false);
      expect(RooSyncService.getInitError()).toBeNull();
      expect((RooSyncService as any)._lastInitAttempt).toBe(0);
      expect((RooSyncService as any).instance).toBeNull();
    });
  });

  describe('getInstance() retry logic', () => {
    test('getInstance() with degraded state and recent _lastInitAttempt throws backoff error', () => {
      // Simulate a recent failed init (5 seconds ago)
      (RooSyncService as any).instance = null;
      (RooSyncService as any)._initError = new Error('Shared path absent');
      (RooSyncService as any)._lastInitAttempt = Date.now() - 5_000;

      // Should throw with backoff message (not retry yet)
      try {
        RooSyncService.getInstance();
        expect.unreachable('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('réessai automatique dans');
        // Verify it didn't retry — _lastInitAttempt should still be ~5s ago
        const savedAttempt = (RooSyncService as any)._lastInitAttempt;
        expect(savedAttempt).toBeGreaterThan(Date.now() - 6_000);
        expect(savedAttempt).toBeLessThan(Date.now() - 4_000);
      }
    });

    test('getInstance() with degraded state and expired backoff attempts reinit', () => {
      // Simulate a failed init 31 seconds ago (past the 30s backoff)
      (RooSyncService as any).instance = null;
      (RooSyncService as any)._initError = new Error('Shared path absent');
      (RooSyncService as any)._lastInitAttempt = Date.now() - 31_000;

      // Will attempt to construct (which will fail because no real config),
      // then update the _lastInitAttempt timestamp
      try {
        RooSyncService.getInstance();
      } catch (e: any) {
        // The retry happened — _lastInitAttempt should be updated
        expect((RooSyncService as any)._lastInitAttempt).toBeGreaterThan(Date.now() - 5_000);
      }
    });
  });

  describe('INIT_RETRY_INTERVAL_MS constant', () => {
    test('backoff interval is 30 seconds', () => {
      expect((RooSyncService as any).INIT_RETRY_INTERVAL_MS).toBe(30_000);
    });
  });
});
