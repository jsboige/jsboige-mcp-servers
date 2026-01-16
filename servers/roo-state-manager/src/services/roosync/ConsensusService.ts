/**
 * Service de consensus pour RooSync
 *
 * Responsable de la résolution des conflits et de la coordination
 * entre les machines dans le système multi-agent.
 *
 * @module ConsensusService
 * @version 1.0.0
 */

import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { getFileLockManager, LockOptions } from './FileLockManager.simple.js';
import { HeartbeatService } from './HeartbeatService.js';
import { CommitLogService, CommitActionType } from './CommitLogService.js';

const logger = createLogger('ConsensusService');

/**
 * Changement proposé pour consensus
 */
export interface ProposedChange {
  /** Identifiant unique de la proposition */
  id: string;
  /** Identifiant de la machine qui propose le changement */
  machineId: string;
  /** Type de changement */
  changeType: 'baseline_update' | 'config_apply' | 'config_publish' | 'decision' | 'other';
  /** Données du changement */
  data: any;
  /** Timestamp de la proposition (epoch en ms) */
  timestamp: number;
  /** Description du changement */
  description: string;
  /** Métadonnées optionnelles */
  metadata?: {
    version?: string;
    relatedChangeId?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    [key: string]: any;
  };
}

/**
 * État d'une proposition de changement
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'applied';

/**
 * Proposition de changement avec statut
 */
export interface ChangeProposal extends ProposedChange {
  /** Statut de la proposition */
  status: ProposalStatus;
  /** Liste des machines qui ont approuvé */
  approvals: string[];
  /** Liste des machines qui ont rejeté */
  rejections: string[];
  /** Timestamp de l'expiration (epoch en ms) */
  expiresAt: number;
  /** Identifiant du commit associé */
  commitId?: string;
}

/**
 * État global du consensus
 */
export interface ConsensusState {
  /** Liste des propositions de changement */
  proposals: Record<string, ChangeProposal>;
  /** Timestamp de la dernière mise à jour */
  lastUpdated: string;
  /** Version du format */
  version: string;
  /** Statistiques */
  stats: {
    totalProposals: number;
    pendingProposals: number;
    approvedProposals: number;
    rejectedProposals: number;
    expiredProposals: number;
  };
}

/**
 * Résultat de résolution de conflit
 */
export interface ConflictResolutionResult {
  /** Données résolues */
  resolved: any;
  /** Stratégie utilisée */
  strategy: 'timestamp' | 'local' | 'remote' | 'merge' | 'manual';
  /** Timestamp de la version gagnante */
  winningTimestamp?: number;
  /** MachineId de la version gagnante */
  winningMachineId?: string;
  /** Détails de la résolution */
  details?: string;
}

/**
 * Options de résolution de conflit
 */
export interface ConflictResolutionOptions {
  /** Stratégie de résolution (défaut: timestamp) */
  strategy?: 'timestamp' | 'local' | 'remote' | 'merge' | 'manual';
  /** Timeout pour le consensus en ms (défaut: 5 minutes) */
  consensusTimeout?: number;
  /** Nombre minimum d'approbations requises (défaut: 1) */
  minApprovals?: number;
}

/**
 * Codes d'erreur pour ConsensusService
 */
export enum ConsensusServiceErrorCode {
  PROPOSAL_FAILED = 'PROPOSAL_FAILED',
  PROPOSAL_LOAD_FAILED = 'PROPOSAL_LOAD_FAILED',
  PROPOSAL_SAVE_FAILED = 'PROPOSAL_SAVE_FAILED',
  CONSENSUS_FAILED = 'CONSENSUS_FAILED',
  INVALID_PROPOSAL = 'INVALID_PROPOSAL',
  PROPOSAL_NOT_FOUND = 'PROPOSAL_NOT_FOUND',
  CONFLICT_RESOLUTION_FAILED = 'CONFLICT_RESOLUTION_FAILED',
  INVALID_MACHINE_ID = 'INVALID_MACHINE_ID'
}

/**
 * Erreur spécifique pour ConsensusService
 */
export class ConsensusServiceError extends Error {
  constructor(
    message: string,
    public readonly code: ConsensusServiceErrorCode,
    public readonly details?: any
  ) {
    super(`[ConsensusService] ${message}`);
    this.name = 'ConsensusServiceError';
  }
}

/**
 * Service de gestion du consensus
 */
export class ConsensusService {
  private readonly CONSENSUS_FILE = 'consensus-state.json';
  private readonly DEFAULT_CONSENSUS_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly DEFAULT_MIN_APPROVALS = 1;

  constructor(
    private config: RooSyncConfig,
    private heartbeatService: HeartbeatService,
    private commitLogService: CommitLogService,
    private lockManager = getFileLockManager()
  ) {}

  /**
   * Obtenir le chemin du fichier de consensus
   */
  private getConsensusFilePath(): string {
    return join(this.config.sharedPath, '.shared-state', this.CONSENSUS_FILE);
  }

  /**
   * Obtenir le répertoire .shared-state
   */
  private getSharedStateDir(): string {
    return join(this.config.sharedPath, '.shared-state');
  }

  /**
   * S'assurer que le répertoire .shared-state existe
   */
  private async ensureSharedStateDir(): Promise<void> {
    const sharedStateDir = this.getSharedStateDir();
    try {
      await fs.mkdir(sharedStateDir, { recursive: true });
    } catch (error) {
      throw new ConsensusServiceError(
        `Impossible de créer le répertoire .shared-state: ${sharedStateDir}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { sharedStateDir, error }
      );
    }
  }

  /**
   * Générer un identifiant unique pour une proposition
   */
  private generateProposalId(): string {
    return `proposal-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Charger l'état du consensus depuis le disque
   */
  private async loadConsensusState(): Promise<ConsensusState> {
    const consensusFile = this.getConsensusFilePath();

    try {
      if (!existsSync(consensusFile)) {
        // Retourner un état vide si le fichier n'existe pas
        return {
          proposals: {},
          lastUpdated: new Date().toISOString(),
          version: '1.0.0',
          stats: {
            totalProposals: 0,
            pendingProposals: 0,
            approvedProposals: 0,
            rejectedProposals: 0,
            expiredProposals: 0
          }
        };
      }

      const content = await fs.readFile(consensusFile, 'utf-8');
      const data = JSON.parse(content);

      // Valider la structure
      if (!data.proposals || typeof data.proposals !== 'object') {
        logger.warn('[ConsensusService] Structure de fichier invalide, réinitialisation');
        return {
          proposals: {},
          lastUpdated: new Date().toISOString(),
          version: '1.0.0',
          stats: {
            totalProposals: 0,
            pendingProposals: 0,
            approvedProposals: 0,
            rejectedProposals: 0,
            expiredProposals: 0
          }
        };
      }

      // Recalculer les statistiques si nécessaire
      if (!data.stats) {
        data.stats = this.calculateStats(data.proposals);
      }

      return data as ConsensusState;
    } catch (error) {
      logger.error('[ConsensusService] Erreur chargement état consensus:', error);
      throw new ConsensusServiceError(
        `Erreur lors du chargement de l'état de consensus: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_LOAD_FAILED,
        { consensusFile, error }
      );
    }
  }

  /**
   * Sauvegarder l'état du consensus sur le disque
   */
  private async saveConsensusState(state: ConsensusState): Promise<void> {
    const consensusFile = this.getConsensusFilePath();

    try {
      await this.ensureSharedStateDir();

      // Recalculer les statistiques
      state.stats = this.calculateStats(state.proposals);
      state.lastUpdated = new Date().toISOString();

      await fs.writeFile(
        consensusFile,
        JSON.stringify(state, null, 2),
        'utf-8'
      );

      logger.debug(`[ConsensusService] État consensus sauvegardé: ${Object.keys(state.proposals).length} propositions`);
    } catch (error) {
      logger.error('[ConsensusService] Erreur sauvegarde état consensus:', error);
      throw new ConsensusServiceError(
        `Erreur lors de la sauvegarde de l'état de consensus: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { consensusFile, error }
      );
    }
  }

  /**
   * Calculer les statistiques des propositions
   */
  private calculateStats(proposals: Record<string, ChangeProposal>): ConsensusState['stats'] {
    const stats = {
      totalProposals: Object.keys(proposals).length,
      pendingProposals: 0,
      approvedProposals: 0,
      rejectedProposals: 0,
      expiredProposals: 0
    };

    for (const proposal of Object.values(proposals)) {
      switch (proposal.status) {
        case 'pending':
          stats.pendingProposals++;
          break;
        case 'approved':
          stats.approvedProposals++;
          break;
        case 'rejected':
          stats.rejectedProposals++;
          break;
        case 'expired':
          stats.expiredProposals++;
          break;
      }
    }

    return stats;
  }

  /**
   * Valider une proposition de changement
   */
  private validateProposal(proposal: Partial<ProposedChange>): void {
    if (!proposal.machineId || typeof proposal.machineId !== 'string' || proposal.machineId.trim().length === 0) {
      throw new ConsensusServiceError(
        'machineId invalide',
        ConsensusServiceErrorCode.INVALID_MACHINE_ID,
        { proposal }
      );
    }

    if (!proposal.changeType || typeof proposal.changeType !== 'string') {
      throw new ConsensusServiceError(
        'changeType invalide',
        ConsensusServiceErrorCode.INVALID_PROPOSAL,
        { proposal }
      );
    }

    if (!proposal.description || typeof proposal.description !== 'string' || proposal.description.trim().length === 0) {
      throw new ConsensusServiceError(
        'description invalide',
        ConsensusServiceErrorCode.INVALID_PROPOSAL,
        { proposal }
      );
    }

    if (proposal.data === undefined || proposal.data === null) {
      throw new ConsensusServiceError(
        'data invalide',
        ConsensusServiceErrorCode.INVALID_PROPOSAL,
        { proposal }
      );
    }
  }

  /**
   * Proposer un changement pour consensus
   *
   * @param change - Changement à proposer
   * @param options - Options de consensus
   * @returns {Promise<boolean>} true si le consensus est atteint
   */
  public async proposeChange(
    change: Partial<ProposedChange>,
    options?: ConflictResolutionOptions
  ): Promise<boolean> {
    try {
      // Valider la proposition
      this.validateProposal(change);

      const consensusFile = this.getConsensusFilePath();
      const now = Date.now();
      const consensusTimeout = options?.consensusTimeout || this.DEFAULT_CONSENSUS_TIMEOUT;
      const minApprovals = options?.minApprovals || this.DEFAULT_MIN_APPROVALS;

      // Créer la proposition complète
      const proposal: ChangeProposal = {
        id: this.generateProposalId(),
        machineId: change.machineId!,
        changeType: change.changeType!,
        data: change.data,
        timestamp: now,
        description: change.description!,
        metadata: change.metadata,
        status: 'pending',
        approvals: [],
        rejections: [],
        expiresAt: now + consensusTimeout
      };

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      // Utiliser le verrouillage pour la mise à jour
      const result = await this.lockManager.updateJsonWithLock<ConsensusState>(
        consensusFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: ConsensusState = existingState || {
            proposals: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            stats: {
              totalProposals: 0,
              pendingProposals: 0,
              approvedProposals: 0,
              rejectedProposals: 0,
              expiredProposals: 0
            }
          };

          // Ajouter la proposition
          state.proposals[proposal.id] = proposal;
          state.lastUpdated = new Date().toISOString();

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new ConsensusServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          ConsensusServiceErrorCode.PROPOSAL_FAILED,
          { change, error: result.error }
        );
      }

      logger.info(
        `[ConsensusService] Proposition créée: ${proposal.id} ` +
        `(${proposal.changeType} par ${proposal.machineId})`
      );

      // Logger l'action dans le commit log
      await this.commitLogService.logAction({
        machineId: proposal.machineId,
        actionType: 'decision_approve',
        description: `Proposition de changement: ${proposal.description}`,
        data: { proposalId: proposal.id, changeType: proposal.changeType },
        status: 'success',
        metadata: {
          source: 'consensus',
          relatedCommitId: proposal.id
        }
      });

      // Vérifier si le consensus est atteint immédiatement
      // (auto-approbation par la machine qui propose)
      return await this.checkConsensus(proposal.id, minApprovals);
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error('[ConsensusService] Erreur proposition changement:', error);
      throw new ConsensusServiceError(
        `Erreur lors de la proposition de changement: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_FAILED,
        { change, error }
      );
    }
  }

  /**
   * Vérifier si le consensus est atteint pour une proposition
   *
   * @param proposalId - Identifiant de la proposition
   * @param minApprovals - Nombre minimum d'approbations requises
   * @returns {Promise<boolean>} true si le consensus est atteint
   */
  public async checkConsensus(proposalId: string, minApprovals: number = 1): Promise<boolean> {
    try {
      const state = await this.loadConsensusState();
      const proposal = state.proposals[proposalId];

      if (!proposal) {
        throw new ConsensusServiceError(
          `Proposition non trouvée: ${proposalId}`,
          ConsensusServiceErrorCode.PROPOSAL_NOT_FOUND,
          { proposalId }
        );
      }

      // Vérifier si la proposition est expirée
      const now = Date.now();
      if (now > proposal.expiresAt) {
        await this.updateProposalStatus(proposalId, 'expired');
        return false;
      }

      // Vérifier si le consensus est atteint
      const hasConsensus = proposal.approvals.length >= minApprovals;

      if (hasConsensus && proposal.status === 'pending') {
        await this.updateProposalStatus(proposalId, 'approved');
        logger.info(`[ConsensusService] Consensus atteint pour ${proposalId}`);
      }

      return hasConsensus;
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error(`[ConsensusService] Erreur vérification consensus ${proposalId}:`, error);
      return false;
    }
  }

  /**
   * Mettre à jour le statut d'une proposition
   *
   * @param proposalId - Identifiant de la proposition
   * @param status - Nouveau statut
   * @returns {Promise<void>}
   */
  public async updateProposalStatus(
    proposalId: string,
    status: ProposalStatus
  ): Promise<void> {
    try {
      const consensusFile = this.getConsensusFilePath();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      const result = await this.lockManager.updateJsonWithLock<ConsensusState>(
        consensusFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: ConsensusState = existingState || {
            proposals: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            stats: {
              totalProposals: 0,
              pendingProposals: 0,
              approvedProposals: 0,
              rejectedProposals: 0,
              expiredProposals: 0
            }
          };

          // Mettre à jour le statut
          if (state.proposals[proposalId]) {
            state.proposals[proposalId].status = status;
            state.lastUpdated = new Date().toISOString();
          }

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new ConsensusServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
          { proposalId, status, error: result.error }
        );
      }

      logger.debug(`[ConsensusService] Statut mis à jour: ${proposalId} -> ${status}`);
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error(`[ConsensusService] Erreur mise à jour statut ${proposalId}:`, error);
      throw new ConsensusServiceError(
        `Erreur lors de la mise à jour du statut: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { proposalId, status, error }
      );
    }
  }

  /**
   * Approuver une proposition
   *
   * @param proposalId - Identifiant de la proposition
   * @param machineId - Identifiant de la machine qui approuve
   * @returns {Promise<boolean>} true si le consensus est atteint
   */
  public async approveProposal(proposalId: string, machineId: string): Promise<boolean> {
    try {
      const consensusFile = this.getConsensusFilePath();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      const result = await this.lockManager.updateJsonWithLock<ConsensusState>(
        consensusFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: ConsensusState = existingState || {
            proposals: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            stats: {
              totalProposals: 0,
              pendingProposals: 0,
              approvedProposals: 0,
              rejectedProposals: 0,
              expiredProposals: 0
            }
          };

          // Ajouter l'approbation
          if (state.proposals[proposalId]) {
            const proposal = state.proposals[proposalId];
            if (!proposal.approvals.includes(machineId)) {
              proposal.approvals.push(machineId);
            }
            state.lastUpdated = new Date().toISOString();
          }

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new ConsensusServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
          { proposalId, machineId, error: result.error }
        );
      }

      logger.info(`[ConsensusService] Approbation: ${machineId} -> ${proposalId}`);

      // Vérifier si le consensus est atteint
      return await this.checkConsensus(proposalId);
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error(`[ConsensusService] Erreur approbation ${proposalId}:`, error);
      throw new ConsensusServiceError(
        `Erreur lors de l'approbation: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { proposalId, machineId, error }
      );
    }
  }

  /**
   * Rejeter une proposition
   *
   * @param proposalId - Identifiant de la proposition
   * @param machineId - Identifiant de la machine qui rejette
   * @returns {Promise<void>}
   */
  public async rejectProposal(proposalId: string, machineId: string): Promise<void> {
    try {
      const consensusFile = this.getConsensusFilePath();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      const result = await this.lockManager.updateJsonWithLock<ConsensusState>(
        consensusFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: ConsensusState = existingState || {
            proposals: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            stats: {
              totalProposals: 0,
              pendingProposals: 0,
              approvedProposals: 0,
              rejectedProposals: 0,
              expiredProposals: 0
            }
          };

          // Ajouter le rejet
          if (state.proposals[proposalId]) {
            const proposal = state.proposals[proposalId];
            if (!proposal.rejections.includes(machineId)) {
              proposal.rejections.push(machineId);
            }
            proposal.status = 'rejected';
            state.lastUpdated = new Date().toISOString();
          }

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new ConsensusServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
          { proposalId, machineId, error: result.error }
        );
      }

      logger.info(`[ConsensusService] Rejet: ${machineId} -> ${proposalId}`);
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error(`[ConsensusService] Erreur rejet ${proposalId}:`, error);
      throw new ConsensusServiceError(
        `Erreur lors du rejet: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { proposalId, machineId, error }
      );
    }
  }

  /**
   * Obtenir l'état du consensus
   *
   * @returns {Promise<ConsensusState>} État du consensus
   */
  public async getConsensusState(): Promise<ConsensusState> {
    try {
      const state = await this.loadConsensusState();

      // Nettoyer les propositions expirées
      await this.cleanupExpiredProposals();

      return state;
    } catch (error) {
      logger.error('[ConsensusService] Erreur récupération état consensus:', error);
      throw new ConsensusServiceError(
        `Erreur lors de la récupération de l'état de consensus: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_LOAD_FAILED,
        { error }
      );
    }
  }

  /**
   * Nettoyer les propositions expirées
   *
   * @returns {Promise<{cleaned: number, remaining: number}>} Statistiques du nettoyage
   */
  public async cleanupExpiredProposals(): Promise<{ cleaned: number; remaining: number }> {
    try {
      const consensusFile = this.getConsensusFilePath();
      const now = Date.now();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      const result = await this.lockManager.updateJsonWithLock<ConsensusState>(
        consensusFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: ConsensusState = existingState || {
            proposals: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            stats: {
              totalProposals: 0,
              pendingProposals: 0,
              approvedProposals: 0,
              rejectedProposals: 0,
              expiredProposals: 0
            }
          };

          const initialCount = Object.keys(state.proposals).length;
          const cleanedProposals: string[] = [];

          // Marquer les propositions expirées
          for (const [proposalId, proposal] of Object.entries(state.proposals)) {
            if (now > proposal.expiresAt && proposal.status === 'pending') {
              proposal.status = 'expired';
              cleanedProposals.push(proposalId);
            }
          }

          const finalCount = Object.keys(state.proposals).length;
          const cleanedCount = cleanedProposals.length;

          state.lastUpdated = new Date().toISOString();

          logger.info(
            `[ConsensusService] Nettoyage terminé: ${cleanedCount} propositions expirées, ` +
            `${finalCount} propositions restantes`
          );

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new ConsensusServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
          { error: result.error }
        );
      }

      // Compter les propositions restantes
      const state = await this.loadConsensusState();
      const remainingCount = Object.keys(state.proposals).length;
      const cleanedCount = Object.values(state.proposals).filter(p => p.status === 'expired').length;

      return { cleaned: cleanedCount, remaining: remainingCount };
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error('[ConsensusService] Erreur nettoyage propositions expirées:', error);
      throw new ConsensusServiceError(
        `Erreur lors du nettoyage des propositions expirées: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.PROPOSAL_SAVE_FAILED,
        { error }
      );
    }
  }

  /**
   * Résoudre un conflit entre deux versions
   *
   * @param local - Version locale
   * @param remote - Version distante
   * @param options - Options de résolution
   * @returns {Promise<ConflictResolutionResult>} Résultat de la résolution
   */
  public async resolveConflict(
    local: any,
    remote: any,
    options?: ConflictResolutionOptions
  ): Promise<ConflictResolutionResult> {
    try {
      const strategy = options?.strategy || 'timestamp';

      logger.debug(`[ConsensusService] Résolution de conflit avec stratégie: ${strategy}`);

      switch (strategy) {
        case 'timestamp':
          return this.resolveByTimestamp(local, remote);

        case 'local':
          return {
            resolved: local,
            strategy: 'local',
            details: 'Version locale conservée'
          };

        case 'remote':
          return {
            resolved: remote,
            strategy: 'remote',
            details: 'Version distante conservée'
          };

        case 'merge':
          return this.resolveByMerge(local, remote);

        case 'manual':
          return {
            resolved: null,
            strategy: 'manual',
            details: 'Résolution manuelle requise'
          };

        default:
          throw new ConsensusServiceError(
            `Stratégie de résolution inconnue: ${strategy}`,
            ConsensusServiceErrorCode.CONFLICT_RESOLUTION_FAILED,
            { strategy }
          );
      }
    } catch (error) {
      if (error instanceof ConsensusServiceError) {
        throw error;
      }

      logger.error('[ConsensusService] Erreur résolution conflit:', error);
      throw new ConsensusServiceError(
        `Erreur lors de la résolution du conflit: ${error instanceof Error ? error.message : String(error)}`,
        ConsensusServiceErrorCode.CONFLICT_RESOLUTION_FAILED,
        { local, remote, error }
      );
    }
  }

  /**
   * Résoudre un conflit par timestamp (la version la plus récente gagne)
   */
  private resolveByTimestamp(local: any, remote: any): ConflictResolutionResult {
    const localTimestamp = this.extractTimestamp(local);
    const remoteTimestamp = this.extractTimestamp(remote);

    if (localTimestamp === null && remoteTimestamp === null) {
      // Pas de timestamp disponible, utiliser la version locale par défaut
      return {
        resolved: local,
        strategy: 'timestamp',
        details: 'Pas de timestamp disponible, version locale conservée'
      };
    }

    if (localTimestamp === null) {
      return {
        resolved: remote,
        strategy: 'timestamp',
        winningTimestamp: remoteTimestamp!,
        details: 'Version distante gagne (pas de timestamp local)'
      };
    }

    if (remoteTimestamp === null) {
      return {
        resolved: local,
        strategy: 'timestamp',
        winningTimestamp: localTimestamp,
        details: 'Version locale gagne (pas de timestamp distant)'
      };
    }

    // Comparer les timestamps
    if (localTimestamp >= remoteTimestamp) {
      return {
        resolved: local,
        strategy: 'timestamp',
        winningTimestamp: localTimestamp,
        winningMachineId: local.machineId,
        details: `Version locale gagne (${new Date(localTimestamp).toISOString()})`
      };
    } else {
      return {
        resolved: remote,
        strategy: 'timestamp',
        winningTimestamp: remoteTimestamp,
        winningMachineId: remote.machineId,
        details: `Version distante gagne (${new Date(remoteTimestamp).toISOString()})`
      };
    }
  }

  /**
   * Extraire le timestamp d'un objet
   */
  private extractTimestamp(obj: any): number | null {
    if (!obj || typeof obj !== 'object') {
      return null;
    }

    // Chercher dans les champs communs
    const timestampFields = ['timestamp', 'lastUpdated', 'updatedAt', 'lastSeen', 'date'];
    for (const field of timestampFields) {
      if (obj[field] && typeof obj[field] === 'number') {
        return obj[field];
      }
      if (obj[field] && typeof obj[field] === 'string') {
        const parsed = Date.parse(obj[field]);
        if (!isNaN(parsed)) {
          return parsed;
        }
      }
    }

    return null;
  }

  /**
   * Résoudre un conflit par fusion (merge simple)
   */
  private resolveByMerge(local: any, remote: any): ConflictResolutionResult {
    try {
      // Si ce sont des objets, faire un merge récursif
      if (typeof local === 'object' && typeof remote === 'object' &&
          local !== null && remote !== null &&
          !Array.isArray(local) && !Array.isArray(remote)) {
        const merged = { ...local };

        for (const key of Object.keys(remote)) {
          if (!(key in local)) {
            merged[key] = remote[key];
          } else if (typeof local[key] === 'object' && typeof remote[key] === 'object' &&
                     local[key] !== null && remote[key] !== null) {
            // Merge récursif
            const subResult = this.resolveByMerge(local[key], remote[key]);
            merged[key] = subResult.resolved;
          }
          // Sinon, conserver la valeur locale (priorité locale)
        }

        return {
          resolved: merged,
          strategy: 'merge',
          details: 'Fusion réussie des objets'
        };
      }

      // Si ce sont des tableaux, concaténer
      if (Array.isArray(local) && Array.isArray(remote)) {
        return {
          resolved: [...local, ...remote],
          strategy: 'merge',
          details: 'Fusion réussie des tableaux'
        };
      }

      // Sinon, utiliser la version locale par défaut
      return {
        resolved: local,
        strategy: 'merge',
        details: 'Fusion impossible, version locale conservée'
      };
    } catch (error) {
      logger.error('[ConsensusService] Erreur fusion:', error);
      return {
        resolved: local,
        strategy: 'merge',
        details: `Erreur de fusion: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Obtenir une proposition par son identifiant
   *
   * @param proposalId - Identifiant de la proposition
   * @returns {Promise<ChangeProposal | null>} Proposition ou null
   */
  public async getProposalById(proposalId: string): Promise<ChangeProposal | null> {
    try {
      const state = await this.loadConsensusState();
      return state.proposals[proposalId] || null;
    } catch (error) {
      logger.error(`[ConsensusService] Erreur récupération proposition ${proposalId}:`, error);
      return null;
    }
  }

  /**
   * Obtenir toutes les propositions en attente
   *
   * @returns {Promise<ChangeProposal[]>} Liste des propositions en attente
   */
  public async getPendingProposals(): Promise<ChangeProposal[]> {
    try {
      const state = await this.loadConsensusState();
      return Object.values(state.proposals).filter(p => p.status === 'pending');
    } catch (error) {
      logger.error('[ConsensusService] Erreur récupération propositions en attente:', error);
      return [];
    }
  }
}
