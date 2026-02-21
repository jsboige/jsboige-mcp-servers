/**
 * Tests unitaires pour roosync_debug_reset
 *
 * Couvre les deux actions :
 * - action: 'debug' : Forcer nouvelle instance + loadDashboard
 * - action: 'reset' : Réinitialiser le singleton + clearCache optionnel
 * - action invalide : throw RooSyncServiceError
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/debug-reset.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mocks de RooSyncService avant import
const mockGetConfig = vi.fn(() => ({ machineId: 'test-machine', sharedPath: '/mock/shared' }));
const mockClearCache = vi.fn();
const mockLoadDashboard = vi.fn(() => Promise.resolve({ machines: [] }));
const mockResetInstance = vi.fn();
const mockGetInstance = vi.fn(() => ({
  getConfig: mockGetConfig,
  clearCache: mockClearCache,
  loadDashboard: mockLoadDashboard
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: mockGetConfig,
    clearCache: mockClearCache,
    loadDashboard: mockLoadDashboard
  })),
  RooSyncService: {
    resetInstance: () => mockResetInstance(),
    getInstance: (opts?: any) => mockGetInstance(opts)
  },
  RooSyncServiceError: class RooSyncServiceError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'RooSyncServiceError';
    }
  }
}));

import { roosync_debug_reset } from '../debug-reset.js';

describe('roosync_debug_reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadDashboard.mockResolvedValue({ machines: [] });
  });

  // ============================================================
  // Action: debug
  // ============================================================

  describe('action: debug', () => {
    test('retourne success=true avec action=debug', async () => {
      const result = await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(result.action).toBe('debug');
      expect(result.success).toBe(true);
    });

    test('inclut machineId dans le résultat', async () => {
      const result = await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(result.machineId).toBe('test-machine');
    });

    test('inclut timestamp ISO dans le résultat', async () => {
      const result = await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('inclut debugInfo avec instanceForced=true', async () => {
      const result = await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(result.debugInfo).toBeDefined();
      expect(result.debugInfo!.instanceForced).toBe(true);
      expect(result.debugInfo!.cacheDisabled).toBe(true);
    });

    test('appelle RooSyncService.resetInstance()', async () => {
      await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(mockResetInstance).toHaveBeenCalled();
    });

    test('appelle RooSyncService.getInstance()', async () => {
      await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(mockGetInstance).toHaveBeenCalled();
    });

    test('appelle loadDashboard()', async () => {
      await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });

      expect(mockLoadDashboard).toHaveBeenCalled();
    });

    test('fonctionne avec verbose=true', async () => {
      const result = await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: true, confirm: false });

      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Action: reset
  // ============================================================

  describe('action: reset', () => {
    test('retourne success=false si confirm=false', async () => {
      const result = await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: false });

      expect(result.action).toBe('reset');
      expect(result.success).toBe(false);
      expect(result.message).toContain('confirmer');
    });

    test('retourne success=true si confirm=true', async () => {
      const result = await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: true });

      expect(result.action).toBe('reset');
      expect(result.success).toBe(true);
    });

    test('appelle resetInstance si confirm=true', async () => {
      await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: true });

      expect(mockResetInstance).toHaveBeenCalled();
    });

    test('n\'appelle pas resetInstance si confirm=false', async () => {
      await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: false });

      expect(mockResetInstance).not.toHaveBeenCalled();
    });

    test('appelle clearCache si clearCache=true et confirm=true', async () => {
      await roosync_debug_reset({ action: 'reset', clearCache: true, verbose: false, confirm: true });

      expect(mockClearCache).toHaveBeenCalled();
    });

    test('ne pas appelle clearCache si clearCache=false', async () => {
      await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: true });

      expect(mockClearCache).not.toHaveBeenCalled();
    });

    test('inclut machineId dans le résultat (confirm=false)', async () => {
      const result = await roosync_debug_reset({ action: 'reset', clearCache: false, verbose: false, confirm: false });

      expect(result.machineId).toBe('test-machine');
    });

    test('inclut debugInfo si confirm=true', async () => {
      const result = await roosync_debug_reset({ action: 'reset', clearCache: true, verbose: false, confirm: true });

      expect(result.debugInfo).toBeDefined();
      expect(result.debugInfo!.instanceForced).toBe(true);
      expect(result.debugInfo!.cacheCleared).toBe(true);
    });
  });

  // ============================================================
  // Gestion des erreurs
  // ============================================================

  describe('gestion des erreurs', () => {
    test('propage RooSyncServiceError depuis loadDashboard', async () => {
      const { RooSyncServiceError } = await import('../../../services/RooSyncService.js');
      mockLoadDashboard.mockRejectedValue(new RooSyncServiceError('Dashboard error', 'LOAD_ERROR'));

      await expect(roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false }))
        .rejects.toThrow('Dashboard error');
    });

    test('encapsule les erreurs génériques en RooSyncServiceError', async () => {
      mockLoadDashboard.mockRejectedValue(new Error('Generic error'));

      try {
        await roosync_debug_reset({ action: 'debug', clearCache: false, verbose: false, confirm: false });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('ROOSYNC_DEBUG_RESET_ERROR');
        expect(err.message).toContain('Generic error');
      }
    });
  });
});
