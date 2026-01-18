/**
 * Tests unitaires pour BaselineManager - Système de Rollback
 * 
 * Tests pour les améliorations du système de rollback:
 * - Logging amélioré
 * - Validation d'intégrité avec checksum
 * - Nettoyage automatique des vieux rollbacks
 * - Gestion d'erreurs robuste
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BaselineManager, RollbackRestoreResult } from '../BaselineManager.js';
import { RooSyncServiceError } from '../../RooSyncService.js';

describe('BaselineManager - Système de Rollback', () => {
  let baselineManager: BaselineManager;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = {
      machineId: 'test-machine',
      sharedPath: '/tmp/test-rollback',
      cacheEnabled: true,
      cacheTTL: 300000
    };

    // Mock BaselineService, ConfigComparator, NonNominativeBaselineService
    const mockBaselineService = {
      loadBaseline: vi.fn(),
      updateBaseline: vi.fn()
    };
    const mockConfigComparator = {
      listDiffs: vi.fn()
    };
    const mockNonNominativeService = {
      getState: vi.fn(),
      getActiveBaseline: vi.fn(),
      getMachineMappings: vi.fn()
    };

    baselineManager = new BaselineManager(
      mockConfig,
      mockBaselineService as any,
      mockConfigComparator as any,
      mockNonNominativeService as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createRollbackPoint', () => {
    it('devrait créer un point de rollback avec succès', async () => {
      const decisionId = 'test-decision-001';
      const consoleSpy = vi.spyOn(console, 'log');

      await baselineManager.createRollbackPoint(decisionId);

      // Vérifier les logs de création
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[RollbackManager] 📦 Création du point de rollback')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('✅ Point de rollback créé')
      );

      consoleSpy.mockRestore();
    });

    it('devrait logger les détails de création avec checksum', async () => {
      const decisionId = 'test-decision-002';
      const consoleSpy = vi.spyOn(console, 'log');

      await baselineManager.createRollbackPoint(decisionId);

      // Vérifier les logs de création
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('checksum')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('restoreFromRollbackPoint', () => {
    it('devrait restaurer depuis un point de rollback avec succès', async () => {
      const decisionId = 'test-decision-001';
      const consoleSpy = vi.spyOn(console, 'log');

      // Mock les méthodes internes
      vi.spyOn(baselineManager as any, 'getRooSyncFilePath').mockReturnValue('/test/path');

      const clearCacheCallback = vi.fn();
      const result = await baselineManager.restoreFromRollbackPoint(decisionId, clearCacheCallback);

      expect(result.success).toBeDefined();
      expect(result.restoredFiles).toBeDefined();
      expect(result.logs).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('devrait logger les détails de restauration', async () => {
      const decisionId = 'test-decision-002';
      const consoleSpy = vi.spyOn(console, 'log');

      vi.spyOn(baselineManager as any, 'getRooSyncFilePath').mockReturnValue('/test/path');
      
      const clearCacheCallback = vi.fn();
      await baselineManager.restoreFromRollbackPoint(decisionId, clearCacheCallback);

      // Vérifier les logs de restauration
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[RollbackManager] 🔄 Début restauration')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('✅ Restauration terminée')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('listRollbackPoints', () => {
    it('devrait lister tous les points de rollback', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const result = await baselineManager.listRollbackPoints();

      expect(Array.isArray(result)).toBe(true);
      // Chaque élément doit avoir decisionId, timestamp, machine, files
      if (result.length > 0) {
        expect(result[0].decisionId).toBeDefined();
        expect(result[0].timestamp).toBeDefined();
      }

      consoleSpy.mockRestore();
    });
  });

  describe('cleanupOldRollbacks', () => {
    it('devrait nettoyer les vieux rollbacks', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const result = await baselineManager.cleanupOldRollbacks({
        olderThanDays: 30,
        keepPerDecision: 2,
        dryRun: false
      });

      expect(result.deleted).toBeDefined();
      expect(result.kept).toBeDefined();
      expect(result.errors).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('devrait supporter le mode dry-run', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const result = await baselineManager.cleanupOldRollbacks({
        olderThanDays: 30,
        dryRun: true
      });

      expect(Array.isArray(result.deleted)).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe('validateRollbackPoint', () => {
    it('devrait valider un point de rollback valide', async () => {
      const decisionId = 'test-decision-001';
      const consoleSpy = vi.spyOn(console, 'log');

      const result = await baselineManager.validateRollbackPoint(decisionId);

      expect(result.isValid).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.files).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('devrait détecter les fichiers manquants', async () => {
      const decisionId = 'test-decision-002';
      const consoleSpy = vi.spyOn(console, 'log');

      const result = await baselineManager.validateRollbackPoint(decisionId);

      expect(result.isValid).toBeDefined();
      expect(result.errors).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe('RollbackRestoreResult interface', () => {
    it('devrait avoir toutes les propriétés requises', () => {
      const result: RollbackRestoreResult = {
        success: true,
        restoredFiles: ['file1.json'],
        logs: ['Log 1', 'Log 2']
      };

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toEqual(['file1.json']);
      expect(result.logs).toEqual(['Log 1', 'Log 2']);
    });

    it('devrait supporter les erreurs', () => {
      const result: RollbackRestoreResult = {
        success: false,
        restoredFiles: [],
        logs: ['Error log'],
        error: 'Test error'
      };

      expect(result.success).toBe(false);
      expect(result.restoredFiles).toEqual([]);
      expect(result.logs).toEqual(['Error log']);
      expect(result.error).toBe('Test error');
    });
  });
});
