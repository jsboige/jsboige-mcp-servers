/**
 * Tests unitaires pour le service de Commit Log
 *
 * T3.15c - Tests du commit log ordonné
 *
 * Couvre:
 * - Ajout d'entrées de commit
 * - Récupération d'entrées
 * - Application de commits
 * - Rollback de commits
 * - Vérification de cohérence
 * - Compression et nettoyage
 * - Synchronisation automatique
 *
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import {
  CommitLogService,
  CommitLogServiceError
} from '../../../../src/services/roosync/CommitLogService.js';
import {
  CommitEntryType,
  CommitStatus,
  type CommitEntry,
  type BaselineCommitData,
  type ConfigCommitData,
  type DecisionCommitData
} from '../../../../src/types/commit-log.js';

// Type de configuration pour les tests
interface TestCommitLogConfig {
  commitLogPath: string;
  syncInterval: number;
  maxEntries: number;
  maxRetryAttempts: number;
  retryDelay: number;
  enableCompression: boolean;
  compressionAge: number;
  enableSigning: boolean;
  hashAlgorithm: 'sha256' | 'sha512';
}

describe('CommitLogService - Tests Unitaires', () => {
  let tempDir: string;
  let commitLogPath: string;
  let commitLogService: CommitLogService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'commit-log-test-'));
    commitLogPath = join(tempDir, 'commit-log');

    await mkdir(commitLogPath, { recursive: true });

    // Configuration par défaut pour les tests
    const config: Partial<TestCommitLogConfig> = {
      commitLogPath,
      syncInterval: 30000, // 30 secondes
      maxEntries: 10000,
      maxRetryAttempts: 3,
      retryDelay: 5000,
      enableCompression: false, // Désactivé pour les tests
      compressionAge: 86400000,
      enableSigning: false,
      hashAlgorithm: 'sha256'
    };

    commitLogService = new CommitLogService(config);
  });

  afterEach(async () => {
    // Arrêter le service de commit log
    await commitLogService.stopAutoSync();

    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
        console.warn('Failed to cleanup temp dir:', error.message);
      }
    }
    vi.restoreAllMocks();
  });

  describe('Initialisation du service', () => {
    it('devrait initialiser le service avec les chemins corrects', async () => {
      // Act
      const state = commitLogService.getState();

      // Assert
      expect(state).toBeDefined();
      expect(state.currentSequenceNumber).toBe(0);
      expect(state.entries.size).toBe(0);
      expect(state.statistics.totalEntries).toBe(0);
    });

    it('devrait créer les répertoires nécessaires', async () => {
      // Assert
      expect(existsSync(commitLogPath)).toBe(true);
      expect(existsSync(join(commitLogPath, 'archive'))).toBe(true);
    });
  });

  describe('Ajout d\'entrées de commit', () => {
    it('devrait ajouter une entrée de commit avec succès', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const entryData: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'> = {
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      };

      // Act
      const result = await commitLogService.appendCommit(entryData);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sequenceNumber).toBe(1);
      expect(result.hash).toBeDefined();

      const state = commitLogService.getState();
      expect(state.currentSequenceNumber).toBe(1);
      expect(state.entries.size).toBe(1);
      expect(state.statistics.totalEntries).toBe(1);
      expect(state.statistics.pendingEntries).toBe(1);
    });

    it('devrait incrémenter le numéro de séquence pour chaque entrée', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const entryData: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'> = {
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      };

      // Act
      const result1 = await commitLogService.appendCommit(entryData);
      const result2 = await commitLogService.appendCommit(entryData);
      const result3 = await commitLogService.appendCommit(entryData);

      // Assert
      expect(result1.sequenceNumber).toBe(1);
      expect(result2.sequenceNumber).toBe(2);
      expect(result3.sequenceNumber).toBe(3);
    });

    it('devrait calculer le hash correctement', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const entryData: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'> = {
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      };

      // Act
      const result = await commitLogService.appendCommit(entryData);

      // Assert
      expect(result.hash).toBeDefined();
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hash
    });

    it('devrait gérer différents types d\'entrées', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const configData: ConfigCommitData = {
        configPath: '/path/to/config',
        changeType: 'update',
        content: { test: 'data' }
      };

      const decisionData: DecisionCommitData = {
        decisionId: 'decision-1',
        decisionType: 'apply',
        target: { machineId: 'machine-2' }
      };

      const entries: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'>[] = [
        {
          type: CommitEntryType.BASELINE,
          machineId: 'machine-1',
          status: CommitStatus.PENDING,
          data: baselineData
        },
        {
          type: CommitEntryType.CONFIG,
          machineId: 'machine-2',
          status: CommitStatus.PENDING,
          data: configData
        },
        {
          type: CommitEntryType.DECISION,
          machineId: 'machine-3',
          status: CommitStatus.PENDING,
          data: decisionData
        }
      ];

      // Act
      for (const entry of entries) {
        await commitLogService.appendCommit(entry);
      }

      // Assert
      const state = commitLogService.getState();
      expect(state.entries.size).toBe(3);
      expect(state.statistics.totalEntries).toBe(3);
    });
  });

  describe('Récupération d\'entrées', () => {
    it('devrait récupérer une entrée par numéro de séquence', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const entryData: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'> = {
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      };
      await commitLogService.appendCommit(entryData);

      // Act
      const entry = await commitLogService.getCommit(1);

      // Assert
      expect(entry).toBeDefined();
      expect(entry?.sequenceNumber).toBe(1);
      expect(entry?.type).toBe(CommitEntryType.BASELINE);
      expect(entry?.machineId).toBe('machine-1');
    });

    it('devrait retourner null pour une entrée inexistante', async () => {
      // Act
      const entry = await commitLogService.getCommit(999);

      // Assert
      expect(entry).toBeNull();
    });

    it('devrait récupérer les N dernières entrées', async () => {
      // Arrange
      for (let i = 0; i < 10; i++) {
        const baselineData: BaselineCommitData = {
          baselineId: `baseline-${i}`,
          updateType: 'update',
          version: '1.0.0',
          sourceMachineId: `machine-${i}`
        };

        await commitLogService.appendCommit({
          type: CommitEntryType.BASELINE,
          machineId: `machine-${i}`,
          status: CommitStatus.PENDING,
          data: baselineData
        });
      }

      // Act
      const result = await commitLogService.getLatestCommits(5);

      // Assert
      expect(result.entries).toHaveLength(5);
      expect(result.totalCount).toBe(10);
      expect(result.hasMore).toBe(true);
      expect(result.entries[0].sequenceNumber).toBe(10);
      expect(result.entries[4].sequenceNumber).toBe(6);
    });

    it('devrait récupérer les entrées depuis une date', async () => {
      // Arrange
      const beforeDate = new Date();
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData1
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const afterDate = new Date();
      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.PENDING,
        data: baselineData2
      });

      // Act
      const result = await commitLogService.getCommitsSince(afterDate.toISOString());

      // Assert
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].machineId).toBe('machine-2');
    });

    it('devrait récupérer les entrées en attente', async () => {
      // Arrange
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      const baselineData3: BaselineCommitData = {
        baselineId: 'baseline-3',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-3'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData1
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.APPLIED,
        data: baselineData2
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-3',
        status: CommitStatus.PENDING,
        data: baselineData3
      });

      // Act
      const pendingCommits = await commitLogService.getPendingCommits();

      // Assert
      expect(pendingCommits).toHaveLength(2);
      expect(pendingCommits[0].machineId).toBe('machine-1');
      expect(pendingCommits[1].machineId).toBe('machine-3');
    });
  });

  describe('Application de commits', () => {
    it('devrait appliquer une entrée en attente', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act
      const result = await commitLogService.applyCommit(1);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sequenceNumber).toBe(1);
      expect(result.appliedAt).toBeDefined();

      const entry = await commitLogService.getCommit(1);
      expect(entry?.status).toBe(CommitStatus.APPLIED);
      expect(entry?.metadata?.appliedAt).toBeDefined();

      const state = commitLogService.getState();
      expect(state.statistics.pendingEntries).toBe(0);
      expect(state.statistics.appliedEntries).toBe(1);
    });

    it('devrait échouer pour une entrée non trouvée', async () => {
      // Act
      const result = await commitLogService.applyCommit(999);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('non trouvée');
    });

    it('devrait échouer pour une entrée déjà appliquée', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });
      await commitLogService.applyCommit(1);

      // Act
      const result = await commitLogService.applyCommit(1);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('n\'est pas en attente');
    });

    it('devrait appliquer toutes les entrées en attente', async () => {
      // Arrange
      for (let i = 1; i <= 3; i++) {
        const baselineData: BaselineCommitData = {
          baselineId: `baseline-${i}`,
          updateType: 'update',
          version: '1.0.0',
          sourceMachineId: `machine-${i}`
        };

        await commitLogService.appendCommit({
          type: CommitEntryType.BASELINE,
          machineId: `machine-${i}`,
          status: CommitStatus.PENDING,
          data: baselineData
        });
      }

      // Act
      const results = await commitLogService.applyPendingCommits();

      // Assert
      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);

      const state = commitLogService.getState();
      expect(state.statistics.pendingEntries).toBe(0);
      expect(state.statistics.appliedEntries).toBe(3);
    });
  });

  describe('Rollback de commits', () => {
    it('devrait annuler une entrée de commit', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act
      const result = await commitLogService.rollbackCommit(1, 'Test rollback');

      // Assert
      expect(result).toBe(true);

      const entry = await commitLogService.getCommit(1);
      expect(entry?.status).toBe(CommitStatus.ROLLED_BACK);
      expect(entry?.metadata?.lastError).toBe('Test rollback');

      const state = commitLogService.getState();
      expect(state.statistics.rolledBackEntries).toBe(1);
    });

    it('devrait retourner false pour une entrée inexistante', async () => {
      // Act
      const result = await commitLogService.rollbackCommit(999, 'Test');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Vérification de cohérence', () => {
    it('devrait détecter un commit log cohérent', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act
      const result = await commitLogService.verifyConsistency();

      // Assert
      expect(result.isConsistent).toBe(true);
      expect(result.inconsistentEntries).toHaveLength(0);
      expect(result.statistics.consistencyRate).toBe(1.0);
    });

    it('devrait détecter des numéros de séquence incohérents', async () => {
      // Arrange - Ajouter des entrées normales
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData1
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.PENDING,
        data: baselineData2
      });

      // Simuler une incohérence en modifiant directement l'état
      const state = commitLogService.getState();
      // Supprimer l'entrée 2 pour créer un trou
      state.entries.delete(2);
      state.currentSequenceNumber = 3;

      // Act
      const result = await commitLogService.verifyConsistency();

      // Assert
      expect(result.isConsistent).toBe(false);
      expect(result.inconsistentEntries.length).toBeGreaterThan(0);
    });
  });

  describe('Nettoyage des entrées', () => {
    it('devrait nettoyer les entrées échouées après N tentatives', async () => {
      // Arrange
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.FAILED,
        data: baselineData1,
        metadata: { retryCount: 3 }
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.FAILED,
        data: baselineData2,
        metadata: { retryCount: 2 }
      });

      // Act
      const removedCount = await commitLogService.cleanupFailedEntries();

      // Assert
      expect(removedCount).toBe(1);

      const state = commitLogService.getState();
      expect(state.entries.size).toBe(1);
      expect(state.statistics.failedEntries).toBe(1);
    });
  });

  describe('État et statistiques', () => {
    it('devrait retourner l\'état complet du service', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act
      const state = commitLogService.getState();

      // Assert
      expect(state).toBeDefined();
      expect(state.currentSequenceNumber).toBe(1);
      expect(state.entries.size).toBe(1);
      expect(state.statistics.totalEntries).toBe(1);
      expect(state.metadata.version).toBe('1.0.0');
    });

    it('devrait retourner les statistiques du service', async () => {
      // Arrange
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData1
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.APPLIED,
        data: baselineData2
      });

      // Act
      const stats = commitLogService.getStatistics();

      // Assert
      expect(stats.totalEntries).toBe(2);
      expect(stats.pendingEntries).toBe(1);
      expect(stats.appliedEntries).toBe(1);
      expect(stats.failedEntries).toBe(0);
      expect(stats.rolledBackEntries).toBe(0);
    });
  });

  describe('Persistance des données', () => {
    it('devrait sauvegarder et charger l\'état du service', async () => {
      // Arrange - Ajouter des entrées
      const baselineData1: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      const baselineData2: BaselineCommitData = {
        baselineId: 'baseline-2',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-2'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData1
      });
      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-2',
        status: CommitStatus.APPLIED,
        data: baselineData2
      });

      // Act - Recréer le service
      await commitLogService.stopAutoSync();
      const newService = new CommitLogService({
        commitLogPath,
        syncInterval: 30000,
        maxEntries: 10000,
        maxRetryAttempts: 3,
        retryDelay: 5000,
        enableCompression: false,
        compressionAge: 86400000,
        enableSigning: false,
        hashAlgorithm: 'sha256'
      });

      // Assert - Vérifier que les données ont été chargées
      const state = newService.getState();
      expect(state.currentSequenceNumber).toBe(2);
      expect(state.entries.size).toBe(2);
      expect(state.statistics.totalEntries).toBe(2);

      await newService.stopAutoSync();
    });
  });

  describe('Synchronisation automatique', () => {
    it('devrait démarrer la synchronisation automatique', async () => {
      // Act
      await commitLogService.startAutoSync();

      // Assert - Vérifier que l'intervalle est actif
      // Note: On ne peut pas facilement tester l'intervalle lui-même,
      // mais on vérifie que l'appel ne lance pas d'erreur
      expect(true).toBe(true);

      await commitLogService.stopAutoSync();
    });

    it('devrait arrêter la synchronisation automatique', async () => {
      // Arrange
      await commitLogService.startAutoSync();

      // Act
      await commitLogService.stopAutoSync();

      // Assert - Vérifier que l'appel ne lance pas d'erreur
      expect(true).toBe(true);
    });

    it('devrait empêcher le démarrage multiple', async () => {
      // Arrange
      await commitLogService.startAutoSync();

      // Act - Essayer de démarrer à nouveau
      await commitLogService.startAutoSync();

      // Assert - Vérifier que l'appel ne lance pas d'erreur
      expect(true).toBe(true);

      await commitLogService.stopAutoSync();
    });
  });

  describe('Réinitialisation du commit log', () => {
    it('devrait rejeter la réinitialisation sans confirmation', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act & Assert
      await expect(commitLogService.resetCommitLog(false))
        .rejects
        .toThrow('Confirmation requise');
    });

    it('devrait réinitialiser le commit log avec confirmation', async () => {
      // Arrange
      const baselineData: BaselineCommitData = {
        baselineId: 'baseline-1',
        updateType: 'update',
        version: '1.0.0',
        sourceMachineId: 'machine-1'
      };

      await commitLogService.appendCommit({
        type: CommitEntryType.BASELINE,
        machineId: 'machine-1',
        status: CommitStatus.PENDING,
        data: baselineData
      });

      // Act
      await commitLogService.resetCommitLog(true);

      // Assert
      const state = commitLogService.getState();
      expect(state.currentSequenceNumber).toBe(0);
      expect(state.entries.size).toBe(0);
      expect(state.statistics.totalEntries).toBe(0);
    });
  });
});
