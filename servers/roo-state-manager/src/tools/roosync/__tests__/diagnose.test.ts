/**
 * Tests pour roosync_diagnose (CONS-#443 Groupe 5)
 * Consolidation de diagnose_env + debug_reset + minimal_test_tool
 *
 * @module tools/roosync/__tests__/diagnose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { roosyncDiagnose, DiagnoseArgs, DiagnoseResult } from '../diagnose.js';
import { RooSyncService, RooSyncServiceError, getRooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs/promises';

// Mock du module fs
vi.mock('fs/promises');

// Mock du module os
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    hostname: vi.fn(() => 'test-machine'),
    uptime: vi.fn(() => 12345),
    totalmem: vi.fn(() => 16000000000),
    freemem: vi.fn(() => 8000000000),
    tmpdir: vi.fn(() => '/tmp'),
    homedir: vi.fn(() => '/home/test')
  };
});

// Mock de RooSyncService
vi.mock('../../../services/RooSyncService.js', async () => {
  const actual = await vi.importActual('../../../services/RooSyncService.js');
  return {
    ...(actual as object),
    getRooSyncService: vi.fn(),
    RooSyncService: {
      getInstance: vi.fn(),
      resetInstance: vi.fn()
    }
  };
});

describe('roosync_diagnose', () => {
  const mockService = {
    getConfig: vi.fn(),
    loadDashboard: vi.fn(),
    clearCache: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(RooSyncService.getInstance).mockReturnValue(mockService as any);
    mockService.getConfig.mockReturnValue({ machineId: 'test-machine' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // Tests action: 'env'
  // ============================================================

  describe('action: env', () => {
    it('should return environment diagnostics with OK status', async () => {
      // Mock fs.access pour réussir toutes les vérifications
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const args: DiagnoseArgs = {
        action: 'env'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('env');
      expect(result.message).toContain('OK');
      expect(result.data).toBeDefined();
      expect(result.data.system).toBeDefined();
      expect(result.data.system.platform).toBeDefined();
      expect(result.data.directories).toBeDefined();
      expect(result.data.status).toBe('OK');
    });

    it('should return WARNING status when directories are missing', async () => {
      // Mock fs.access pour échouer sur certains répertoires
      vi.mocked(fs.access).mockRejectedValue({ code: 'ENOENT' });

      const args: DiagnoseArgs = {
        action: 'env'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(false);
      expect(result.action).toBe('env');
      expect(result.message).toContain('WARNING');
      expect(result.data.status).toBe('WARNING');
      expect(result.data.directories['.']).toEqual({ exists: false, error: 'ENOENT' });
    });

    it('should check disk space when checkDiskSpace is true', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const args: DiagnoseArgs = {
        action: 'env',
        checkDiskSpace: true
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('env');
      // Note: checkDiskSpace parameter is currently a placeholder
      // Real implementation would require additional logic
    });
  });

  // ============================================================
  // Tests action: 'debug'
  // ============================================================

  describe('action: debug', () => {
    it('should debug dashboard and reset instance', async () => {
      const mockDashboard = { machines: [], lastUpdate: new Date().toISOString() };
      mockService.loadDashboard.mockResolvedValue(mockDashboard);

      const args: DiagnoseArgs = {
        action: 'debug'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('debug');
      expect(result.message).toContain('Dashboard debuggé avec succès');
      expect(RooSyncService.resetInstance).toHaveBeenCalled();
      expect(RooSyncService.getInstance).toHaveBeenCalledWith({ enabled: false });
      expect(mockService.loadDashboard).toHaveBeenCalled();
    });

    it('should include verbose dashboard data when verbose=true', async () => {
      const mockDashboard = { machines: ['machine1', 'machine2'], lastUpdate: new Date().toISOString() };
      mockService.loadDashboard.mockResolvedValue(mockDashboard);

      const args: DiagnoseArgs = {
        action: 'debug',
        verbose: true
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('debug');
      expect(result.data.debugInfo.dashboard).toEqual(mockDashboard);
    });

    it('should hide dashboard data when verbose=false', async () => {
      const mockDashboard = { machines: ['machine1'], lastUpdate: new Date().toISOString() };
      mockService.loadDashboard.mockResolvedValue(mockDashboard);

      const args: DiagnoseArgs = {
        action: 'debug',
        verbose: false
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.data.debugInfo.dashboard).toContain('use verbose: true');
    });
  });

  // ============================================================
  // Tests action: 'reset'
  // ============================================================

  describe('action: reset', () => {
    it('should require confirmation to reset service', async () => {
      const args: DiagnoseArgs = {
        action: 'reset'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(false);
      expect(result.action).toBe('reset');
      expect(result.message).toContain('Veuillez confirmer');
      expect(RooSyncService.resetInstance).not.toHaveBeenCalled();
    });

    it('should reset service when confirm=true', async () => {
      vi.mocked(getRooSyncService).mockReturnValue(mockService as any);

      const args: DiagnoseArgs = {
        action: 'reset',
        confirm: true
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('reset');
      expect(result.message).toContain('réinitialisée avec succès');
      expect(RooSyncService.resetInstance).toHaveBeenCalled();
    });

    it('should clear cache when clearCache=true', async () => {
      vi.mocked(getRooSyncService).mockReturnValue(mockService as any);

      const args: DiagnoseArgs = {
        action: 'reset',
        confirm: true,
        clearCache: true
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.data.debugInfo.cacheCleared).toBe(true);
      expect(mockService.clearCache).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Tests action: 'test'
  // ============================================================

  describe('action: test', () => {
    it('should run minimal test with default message', async () => {
      const args: DiagnoseArgs = {
        action: 'test'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('test');
      expect(result.message).toContain('Test minimal réussi');
      expect(result.data.testMessage).toBe('Test minimal OK');
      expect(result.data.mcpStatus).toBe('OK');
    });

    it('should run minimal test with custom message', async () => {
      const customMessage = 'Mon message de test personnalisé';

      const args: DiagnoseArgs = {
        action: 'test',
        message: customMessage
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('test');
      expect(result.data.testMessage).toBe(customMessage);
    });
  });

  // ============================================================
  // Tests d'erreurs
  // ============================================================

  describe('error handling', () => {
    it('should throw error for unknown action', async () => {
      const args: any = {
        action: 'unknown_action'
      };

      await expect(roosyncDiagnose(args)).rejects.toThrow(RooSyncServiceError);
      await expect(roosyncDiagnose(args)).rejects.toThrow(/Action non reconnue/);
    });

    it('should wrap errors from env action', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Filesystem error'));

      const args: DiagnoseArgs = {
        action: 'env'
      };

      // L'erreur filesystem est gérée gracieusement, pas d'exception lancée
      const result = await roosyncDiagnose(args);
      expect(result.data.status).toBe('WARNING');
    });

    it('should wrap errors from debug action', async () => {
      mockService.loadDashboard.mockRejectedValue(new Error('Dashboard error'));

      const args: DiagnoseArgs = {
        action: 'debug'
      };

      await expect(roosyncDiagnose(args)).rejects.toThrow(RooSyncServiceError);
      await expect(roosyncDiagnose(args)).rejects.toThrow(/Dashboard error/);
    });
  });

  // ============================================================
  // Tests de format de sortie
  // ============================================================

  describe('output format', () => {
    it('should return correct result structure for env', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const args: DiagnoseArgs = {
        action: 'env'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('data');
      expect(typeof result.timestamp).toBe('string');
      expect(result.action).toBe('env');
    });

    it('should return correct result structure for test', async () => {
      const args: DiagnoseArgs = {
        action: 'test',
        message: 'Test structure'
      };

      const result: DiagnoseResult = await roosyncDiagnose(args);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('data');
      expect(result.action).toBe('test');
    });
  });
});
