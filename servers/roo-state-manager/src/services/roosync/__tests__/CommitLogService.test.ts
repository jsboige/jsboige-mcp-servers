/**
 * Tests unitaires pour CommitLogService - Système de traçabilité
 *
 * Tests pour les fonctionnalités de commit log:
 * - Enregistrement d'actions
 * - Récupération de l'historique
 * - Nettoyage des vieux commits
 * - Statistiques
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommitLogService, CommitLogServiceError } from '../CommitLogService.js';

describe('CommitLogService - Système de Traçabilité', () => {
  let commitLogService: CommitLogService;
  let mockConfig: any;
  let mockLockManager: any;

  beforeEach(() => {
    mockConfig = {
      machineId: 'test-machine-01',
      sharedPath: '/tmp/test-commit-log',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };

    // Mock FileLockManager
    mockLockManager = {
      updateJsonWithLock: vi.fn().mockImplementation(async (filePath: string, updateFn: Function) => {
        const existingData = { commits: [], lastUpdated: new Date().toISOString(), version: '1.0.0', machineIndex: {} };
        const updatedData = updateFn(existingData);
        return { success: true, data: updatedData };
      }),
      withLock: vi.fn().mockImplementation(async (filePath: string, fn: Function) => {
        await fn();
        return { success: true };
      })
    };

    commitLogService = new CommitLogService(mockConfig, mockLockManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('logAction', () => {
    it('devrait enregistrer une action avec succès', async () => {
      const action = {
        machineId: 'test-machine-01',
        actionType: 'baseline_update' as const,
        description: 'Test action',
        data: { test: 'data' },
        status: 'success' as const
      };

      const commitId = await commitLogService.logAction(action);

      expect(commitId).toBeDefined();
      expect(commitId).toMatch(/^commit-/);
      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
    });

    it('devrait rejeter un machineId invalide', async () => {
      const action = {
        machineId: '',
        actionType: 'baseline_update',
        description: 'Test action'
      };

      await expect(
        commitLogService.logAction(action)
      ).rejects.toThrow(CommitLogServiceError);
    });

    it('devrait rejeter une description vide', async () => {
      const action = {
        machineId: 'test-machine-01',
        actionType: 'baseline_update',
        description: ''
      };

      await expect(
        commitLogService.logAction(action)
      ).rejects.toThrow(CommitLogServiceError);
    });

    it('devrait inclure les métadonnées optionnelles', async () => {
      const action = {
        machineId: 'test-machine-01',
        actionType: 'config_apply' as const,
        description: 'Test action with metadata',
        metadata: {
          version: '1.0.0',
          source: 'test'
        }
      };

      const commitId = await commitLogService.logAction(action);

      expect(commitId).toBeDefined();
    });
  });

  describe('getCommitHistory', () => {
    it('devrait retourner l\'historique des commits', async () => {
      const action = {
        machineId: 'test-machine-01',
        actionType: 'baseline_update' as const,
        description: 'Test action'
      };

      await commitLogService.logAction(action);

      const history = await commitLogService.getCommitHistory();

      expect(history).toHaveLength(1);
      expect(history[0].machineId).toBe('test-machine-01');
    });

    it('devrait filtrer par machineId', async () => {
      await commitLogService.logAction({
        machineId: 'machine-01',
        actionType: 'baseline_update' as const,
        description: 'Action 1'
      });

      await commitLogService.logAction({
        machineId: 'machine-02',
        actionType: 'config_apply' as const,
        description: 'Action 2'
      });

      const history = await commitLogService.getCommitHistory({ machineId: 'machine-01' });

      expect(history).toHaveLength(1);
      expect(history[0].machineId).toBe('machine-01');
    });

    it('devrait limiter le nombre de résultats', async () => {
      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'baseline_update',
        description: 'Action 1'
      });

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'config_apply',
        description: 'Action 2'
      });

      const history = await commitLogService.getCommitHistory({ limit: 1 });

      expect(history).toHaveLength(1);
    });

    it('devrait filtrer par type d\'action', async () => {
      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'baseline_update' as const,
        description: 'Baseline action'
      });

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'config_apply' as const,
        description: 'Config action'
      });

      const history = await commitLogService.getCommitHistory({ actionType: 'baseline_update' });

      expect(history).toHaveLength(1);
      expect(history[0].actionType).toBe('baseline_update');
    });

    it('devrait filtrer par statut', async () => {
      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'baseline_update' as const,
        description: 'Success action',
        status: 'success' as const
      });

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'config_apply' as const,
        description: 'Error action',
        status: 'error' as const,
        errorMessage: 'Test error'
      });

      const history = await commitLogService.getCommitHistory({ status: 'success' });

      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('success');
    });
  });

  describe('getLatestCommit', () => {
    it('devrait retourner le dernier commit d\'une machine', async () => {
      const machineId = 'test-machine-01';
      const now = Date.now();

      await commitLogService.logAction({
        machineId,
        actionType: 'baseline_update' as const,
        description: 'First action'
      });

      await commitLogService.logAction({
        machineId,
        actionType: 'config_apply' as const,
        description: 'Second action'
      });

      const latestCommit = await commitLogService.getLatestCommit(machineId);

      expect(latestCommit).not.toBeNull();
      expect(latestCommit?.description).toBe('Second action');
    });

    it('devrait retourner null pour une machine sans commits', async () => {
      const latestCommit = await commitLogService.getLatestCommit('unknown-machine');

      expect(latestCommit).toBeNull();
    });
  });

  describe('getCommitById', () => {
    it('devrait retourner un commit par son ID', async () => {
      const action = {
        machineId: 'test-machine-01',
        actionType: 'baseline_update',
        description: 'Test action'
      };

      const commitId = await commitLogService.logAction(action);

      const commit = await commitLogService.getCommitById(commitId);

      expect(commit).not.toBeNull();
      expect(commit?.id).toBe(commitId);
    });

    it('devrait retourner null pour un ID inconnu', async () => {
      const commit = await commitLogService.getCommitById('unknown-commit-id');

      expect(commit).toBeNull();
    });
  });

  describe('getCommitStats', () => {
    it('devrait retourner les statistiques des commits', async () => {
      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'baseline_update' as const,
        description: 'Baseline action'
      });

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'config_apply' as const,
        description: 'Config action'
      });

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'config_apply' as const,
        description: 'Error action',
        status: 'error' as const
      });

      const stats = await commitLogService.getCommitStats();

      expect(stats.total).toBe(3);
      expect(stats.byType['baseline_update']).toBe(1);
      expect(stats.byType['config_apply']).toBe(2);
      expect(stats.byStatus['success']).toBe(2);
      expect(stats.byStatus['error']).toBe(1);
    });

    it('devrait retourner des statistiques vides si aucun commit', async () => {
      const stats = await commitLogService.getCommitStats();

      expect(stats.total).toBe(0);
      expect(Object.keys(stats.byType)).toHaveLength(0);
      expect(Object.keys(stats.byStatus)).toHaveLength(0);
    });
  });

  describe('cleanupOldCommits', () => {
    it('devrait nettoyer les vieux commits', async () => {
      const now = Date.now();
      const oldTimestamp = now - 30 * 24 * 60 * 60 * 1000; // 30 jours

      await commitLogService.logAction({
        machineId: 'test-machine-01',
        actionType: 'baseline_update',
        description: 'Old action'
      });

      // Simuler un vieux commit
      vi.spyOn(commitLogService as any, 'loadCommitLogState').mockResolvedValue({
        commits: [{
          id: 'old-commit',
          machineId: 'test-machine-01',
          actionType: 'baseline_update',
          timestamp: oldTimestamp,
          description: 'Old action',
          status: 'success'
        }],
        lastUpdated: new Date().toISOString(),
        version: '1.0.0',
        machineIndex: {}
      });

      const result = await commitLogService.cleanupOldCommits(now - 7 * 24 * 60 * 60 * 1000); // 7 jours

      expect(result.removed).toBeGreaterThan(0);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });
});
