/**
 * Tests unitaires pour ConsensusService - Système de consensus multi-agent
 *
 * Tests pour les fonctionnalités de consensus:
 * - Proposition de changements
 * - Résolution de conflits
 * - Approbation et rejet
 * - Nettoyage des propositions expirées
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsensusService, ConsensusServiceError } from '../ConsensusService.js';

describe('ConsensusService - Système de Consensus', () => {
  let consensusService: ConsensusService;
  let mockConfig: any;
  let mockHeartbeatService: any;
  let mockCommitLogService: any;
  let mockLockManager: any;

  beforeEach(() => {
    mockConfig = {
      machineId: 'test-machine-01',
      sharedPath: '/tmp/test-consensus',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };

    // Mock HeartbeatService
    mockHeartbeatService = {
      isMachineAlive: vi.fn().mockResolvedValue(true),
      getAliveMachines: vi.fn().mockResolvedValue(['machine-01', 'machine-02'])
    };

    // Mock CommitLogService
    mockCommitLogService = {
      logAction: vi.fn().mockResolvedValue('commit-123')
    };

    // Mock FileLockManager
    mockLockManager = {
      updateJsonWithLock: vi.fn().mockImplementation(async (filePath: string, updateFn: Function) => {
        const existingData = { proposals: {}, lastUpdated: new Date().toISOString(), version: '1.0.0', stats: { totalProposals: 0, pendingProposals: 0, approvedProposals: 0, rejectedProposals: 0, expiredProposals: 0 } };
        const updatedData = updateFn(existingData);
        return { success: true, data: updatedData };
      }),
      withLock: vi.fn().mockImplementation(async (filePath: string, fn: Function) => {
        await fn();
        return { success: true };
      })
    };

    consensusService = new ConsensusService(
      mockConfig,
      mockHeartbeatService,
      mockCommitLogService,
      mockLockManager
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('proposeChange', () => {
    it('devrait créer une proposition avec succès', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      const hasConsensus = await consensusService.proposeChange(change);

      expect(hasConsensus).toBe(true);
      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
      expect(mockCommitLogService.logAction).toHaveBeenCalled();
    });

    it('devrait rejeter un machineId invalide', async () => {
      const change = {
        machineId: '',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      await expect(
        consensusService.proposeChange(change)
      ).rejects.toThrow(ConsensusServiceError);
    });

    it('devrait rejeter une description vide', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: ''
      };

      await expect(
        consensusService.proposeChange(change)
      ).rejects.toThrow(ConsensusServiceError);
    });

    it('devrait rejeter des données null', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: null,
        description: 'Test change proposal'
      };

      await expect(
        consensusService.proposeChange(change)
      ).rejects.toThrow(ConsensusServiceError);
    });
  });

  describe('resolveConflict', () => {
    it('devrait résoudre par timestamp (le plus récent gagne)', async () => {
      const local = {
        machineId: 'machine-01',
        timestamp: Date.now() - 1000,
        data: 'local data'
      };

      const remote = {
        machineId: 'machine-02',
        timestamp: Date.now(),
        data: 'remote data'
      };

      const result = await consensusService.resolveConflict(local, remote);

      expect(result.strategy).toBe('timestamp');
      expect(result.resolved).toEqual(remote);
      expect(result.winningTimestamp).toBe(remote.timestamp);
      expect(result.winningMachineId).toBe('machine-02');
    });

    it('devrait utiliser la stratégie locale', async () => {
      const local = { data: 'local data' };
      const remote = { data: 'remote data' };

      const result = await consensusService.resolveConflict(local, remote, { strategy: 'local' });

      expect(result.strategy).toBe('local');
      expect(result.resolved).toEqual(local);
    });

    it('devrait utiliser la stratégie distante', async () => {
      const local = { data: 'local data' };
      const remote = { data: 'remote data' };

      const result = await consensusService.resolveConflict(local, remote, { strategy: 'remote' });

      expect(result.strategy).toBe('remote');
      expect(result.resolved).toEqual(remote);
    });

    it('devrait fusionner les objets', async () => {
      const local = {
        field1: 'value1',
        field2: 'value2'
      };

      const remote = {
        field2: 'value2-updated',
        field3: 'value3'
      };

      const result = await consensusService.resolveConflict(local, remote, { strategy: 'merge' });

      expect(result.strategy).toBe('merge');
      expect(result.resolved.field1).toBe('value1');
      expect(result.resolved.field2).toBe('value2'); // Priorité locale
      expect(result.resolved.field3).toBe('value3');
    });

    it('devrait fusionner les tableaux', async () => {
      const local = { items: ['item1', 'item2'] };
      const remote = { items: ['item3', 'item4'] };

      const result = await consensusService.resolveConflict(local, remote, { strategy: 'merge' });

      expect(result.strategy).toBe('merge');
      expect(result.resolved.items).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    it('devrait retourner null pour la stratégie manuelle', async () => {
      const local = { data: 'local data' };
      const remote = { data: 'remote data' };

      const result = await consensusService.resolveConflict(local, remote, { strategy: 'manual' });

      expect(result.strategy).toBe('manual');
      expect(result.resolved).toBeNull();
    });
  });

  describe('approveProposal', () => {
    it('devrait approuver une proposition', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      const proposalId = await consensusService.proposeChange(change);

      const hasConsensus = await consensusService.approveProposal(proposalId, 'machine-02');

      expect(hasConsensus).toBe(true);
      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
    });
  });

  describe('rejectProposal', () => {
    it('devrait rejeter une proposition', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      const proposalId = await consensusService.proposeChange(change);

      await consensusService.rejectProposal(proposalId, 'machine-02');

      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
    });
  });

  describe('getConsensusState', () => {
    it('devrait retourner l\'état du consensus', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      await consensusService.proposeChange(change);

      const state = await consensusService.getConsensusState();

      expect(state).toBeDefined();
      expect(state.proposals).toBeDefined();
      expect(state.stats).toBeDefined();
      expect(state.stats.totalProposals).toBeGreaterThan(0);
    });
  });

  describe('getProposalById', () => {
    it('devrait retourner une proposition par son ID', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      const proposalId = await consensusService.proposeChange(change);

      const proposal = await consensusService.getProposalById(proposalId);

      expect(proposal).not.toBeNull();
      expect(proposal?.id).toBe(proposalId);
    });

    it('devrait retourner null pour un ID inconnu', async () => {
      const proposal = await consensusService.getProposalById('unknown-proposal-id');

      expect(proposal).toBeNull();
    });
  });

  describe('getPendingProposals', () => {
    it('devrait retourner les propositions en attente', async () => {
      const change = {
        machineId: 'test-machine-01',
        changeType: 'baseline_update' as const,
        data: { test: 'data' },
        description: 'Test change proposal'
      };

      await consensusService.proposeChange(change);

      const pendingProposals = await consensusService.getPendingProposals();

      expect(pendingProposals).toHaveLength(1);
      expect(pendingProposals[0].status).toBe('pending');
    });
  });

  describe('cleanupExpiredProposals', () => {
    it('devrait nettoyer les propositions expirées', async () => {
      const now = Date.now();
      const oldTimestamp = now - 10 * 60 * 1000; // 10 minutes

      // Simuler une vieille proposition
      vi.spyOn(consensusService as any, 'loadConsensusState').mockResolvedValue({
        proposals: {
          'old-proposal': {
            id: 'old-proposal',
            machineId: 'test-machine-01',
            changeType: 'baseline_update',
            data: { test: 'data' },
            timestamp: oldTimestamp,
            description: 'Old proposal',
            status: 'pending',
            approvals: [],
            rejections: [],
            expiresAt: oldTimestamp + 5 * 60 * 1000
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0',
        stats: { totalProposals: 1, pendingProposals: 1, approvedProposals: 0, rejectedProposals: 0, expiredProposals: 0 }
      });

      const result = await consensusService.cleanupExpiredProposals();

      expect(result.cleaned).toBeGreaterThan(0);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });
});
