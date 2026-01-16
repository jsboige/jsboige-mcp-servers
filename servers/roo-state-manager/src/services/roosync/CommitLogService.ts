/**
 * Service de commit log pour RooSync
 *
 * Responsable de la traçabilité des actions de synchronisation
 * avec un historique complet des commits pour audit et rollback.
 *
 * @module CommitLogService
 * @version 1.0.0
 */

import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { getFileLockManager, LockOptions } from './FileLockManager.simple.js';

const logger = createLogger('CommitLogService');

/**
 * Types d'actions de commit
 */
export type CommitActionType =
  | 'baseline_update'
  | 'config_apply'
  | 'config_publish'
  | 'decision_approve'
  | 'decision_reject'
  | 'decision_apply'
  | 'decision_rollback'
  | 'message_send'
  | 'message_read'
  | 'message_archive'
  | 'heartbeat_register'
  | 'presence_update'
  | 'identity_register'
  | 'conflict_resolve'
  | 'unknown';

/**
 * Action de commit
 */
export interface CommitAction {
  /** Identifiant unique du commit (UUID) */
  id: string;
  /** Identifiant de la machine qui a effectué l'action */
  machineId: string;
  /** Type d'action */
  actionType: CommitActionType;
  /** Timestamp de l'action (epoch en ms) */
  timestamp: number;
  /** Description de l'action */
  description: string;
  /** Données associées à l'action (optionnel) */
  data?: any;
  /** Résultat de l'action (success/error) */
  status: 'success' | 'error' | 'pending';
  /** Message d'erreur si status = 'error' */
  errorMessage?: string;
  /** Métadonnées additionnelles */
  metadata?: {
    source?: string;
    version?: string;
    relatedCommitId?: string;
    [key: string]: any;
  };
}

/**
 * État global du commit log
 */
export interface CommitLogState {
  /** Liste des actions de commit */
  commits: CommitAction[];
  /** Timestamp de la dernière mise à jour */
  lastUpdated: string;
  /** Version du format */
  version: string;
  /** Index des commits par machineId */
  machineIndex: Record<string, string[]>;
}

/**
 * Options de filtrage pour l'historique
 */
export interface CommitHistoryOptions {
  /** Filtrer par machineId */
  machineId?: string;
  /** Limiter le nombre de résultats */
  limit?: number;
  /** Filtrer par type d'action */
  actionType?: CommitActionType;
  /** Filtrer par statut */
  status?: 'success' | 'error' | 'pending';
  /** Timestamp minimum (epoch en ms) */
  since?: number;
  /** Timestamp maximum (epoch en ms) */
  until?: number;
}

/**
 * Codes d'erreur pour CommitLogService
 */
export enum CommitLogServiceErrorCode {
  COMMIT_LOG_FAILED = 'COMMIT_LOG_FAILED',
  COMMIT_LOAD_FAILED = 'COMMIT_LOAD_FAILED',
  COMMIT_SAVE_FAILED = 'COMMIT_SAVE_FAILED',
  INVALID_COMMIT_ACTION = 'INVALID_COMMIT_ACTION',
  INVALID_MACHINE_ID = 'INVALID_MACHINE_ID',
  COMMIT_NOT_FOUND = 'COMMIT_NOT_FOUND'
}

/**
 * Erreur spécifique pour CommitLogService
 */
export class CommitLogServiceError extends Error {
  constructor(
    message: string,
    public readonly code: CommitLogServiceErrorCode,
    public readonly details?: any
  ) {
    super(`[CommitLogService] ${message}`);
    this.name = 'CommitLogServiceError';
  }
}

/**
 * Service de gestion du commit log
 */
export class CommitLogService {
  private readonly COMMIT_LOG_FILE = 'commit-log.json';
  private readonly MAX_COMMITS = 10000; // Limite pour éviter les fichiers trop volumineux

  constructor(
    private config: RooSyncConfig,
    private lockManager = getFileLockManager()
  ) {}

  /**
   * Obtenir le chemin du fichier de commit log
   */
  private getCommitLogFilePath(): string {
    return join(this.config.sharedPath, '.shared-state', this.COMMIT_LOG_FILE);
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
      throw new CommitLogServiceError(
        `Impossible de créer le répertoire .shared-state: ${sharedStateDir}`,
        CommitLogServiceErrorCode.COMMIT_SAVE_FAILED,
        { sharedStateDir, error }
      );
    }
  }

  /**
   * Générer un identifiant unique pour un commit
   */
  private generateCommitId(): string {
    return `commit-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Charger l'état du commit log depuis le disque
   */
  private async loadCommitLogState(): Promise<CommitLogState> {
    const commitLogFile = this.getCommitLogFilePath();

    try {
      if (!existsSync(commitLogFile)) {
        // Retourner un état vide si le fichier n'existe pas
        return {
          commits: [],
          lastUpdated: new Date().toISOString(),
          version: '1.0.0',
          machineIndex: {}
        };
      }

      const content = await fs.readFile(commitLogFile, 'utf-8');
      const data = JSON.parse(content);

      // Valider la structure
      if (!data.commits || !Array.isArray(data.commits)) {
        logger.warn('[CommitLogService] Structure de fichier invalide, réinitialisation');
        return {
          commits: [],
          lastUpdated: new Date().toISOString(),
          version: '1.0.0',
          machineIndex: {}
        };
      }

      // Reconstruire l'index si nécessaire
      if (!data.machineIndex || typeof data.machineIndex !== 'object') {
        data.machineIndex = this.buildMachineIndex(data.commits);
      }

      return data as CommitLogState;
    } catch (error) {
      logger.error('[CommitLogService] Erreur chargement état commit log:', error);
      throw new CommitLogServiceError(
        `Erreur lors du chargement du commit log: ${error instanceof Error ? error.message : String(error)}`,
        CommitLogServiceErrorCode.COMMIT_LOAD_FAILED,
        { commitLogFile, error }
      );
    }
  }

  /**
   * Construire l'index des commits par machineId
   */
  private buildMachineIndex(commits: CommitAction[]): Record<string, string[]> {
    const index: Record<string, string[]> = {};

    for (const commit of commits) {
      if (!index[commit.machineId]) {
        index[commit.machineId] = [];
      }
      index[commit.machineId].push(commit.id);
    }

    return index;
  }

  /**
   * Sauvegarder l'état du commit log sur le disque
   */
  private async saveCommitLogState(state: CommitLogState): Promise<void> {
    const commitLogFile = this.getCommitLogFilePath();

    try {
      await this.ensureSharedStateDir();

      // Nettoyer les vieux commits si nécessaire
      if (state.commits.length > this.MAX_COMMITS) {
        const toRemove = state.commits.length - this.MAX_COMMITS;
        const removedCommits = state.commits.splice(0, toRemove);

        // Mettre à jour l'index
        for (const commit of removedCommits) {
          const machineCommits = state.machineIndex[commit.machineId];
          if (machineCommits) {
            const index = machineCommits.indexOf(commit.id);
            if (index !== -1) {
              machineCommits.splice(index, 1);
            }
          }
        }

        logger.info(`[CommitLogService] Nettoyage: ${toRemove} vieux commits supprimés`);
      }

      const data = {
        ...state,
        lastUpdated: new Date().toISOString()
      };

      await fs.writeFile(
        commitLogFile,
        JSON.stringify(data, null, 2),
        'utf-8'
      );

      logger.debug(`[CommitLogService] État commit log sauvegardé: ${state.commits.length} commits`);
    } catch (error) {
      logger.error('[CommitLogService] Erreur sauvegarde état commit log:', error);
      throw new CommitLogServiceError(
        `Erreur lors de la sauvegarde du commit log: ${error instanceof Error ? error.message : String(error)}`,
        CommitLogServiceErrorCode.COMMIT_SAVE_FAILED,
        { commitLogFile, error }
      );
    }
  }

  /**
   * Valider une action de commit
   */
  private validateCommitAction(action: Partial<CommitAction>): void {
    if (!action.machineId || typeof action.machineId !== 'string' || action.machineId.trim().length === 0) {
      throw new CommitLogServiceError(
        'machineId invalide',
        CommitLogServiceErrorCode.INVALID_MACHINE_ID,
        { action }
      );
    }

    if (!action.actionType || typeof action.actionType !== 'string') {
      throw new CommitLogServiceError(
        'actionType invalide',
        CommitLogServiceErrorCode.INVALID_COMMIT_ACTION,
        { action }
      );
    }

    if (!action.description || typeof action.description !== 'string' || action.description.trim().length === 0) {
      throw new CommitLogServiceError(
        'description invalide',
        CommitLogServiceErrorCode.INVALID_COMMIT_ACTION,
        { action }
      );
    }
  }

  /**
   * Logger une action de commit
   *
   * @param action - Action de commit à logger
   * @returns {Promise<string>} Identifiant du commit créé
   */
  public async logAction(action: Partial<CommitAction>): Promise<string> {
    try {
      // Valider l'action
      this.validateCommitAction(action);

      const commitLogFile = this.getCommitLogFilePath();
      const now = Date.now();

      // Créer l'action de commit complète
      const commitAction: CommitAction = {
        id: this.generateCommitId(),
        machineId: action.machineId!,
        actionType: action.actionType!,
        timestamp: now,
        description: action.description!,
        data: action.data,
        status: action.status || 'success',
        errorMessage: action.errorMessage,
        metadata: action.metadata
      };

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      // Utiliser le verrouillage pour la mise à jour
      const result = await this.lockManager.updateJsonWithLock<CommitLogState>(
        commitLogFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: CommitLogState = existingState || {
            commits: [],
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            machineIndex: {}
          };

          // Ajouter le commit
          state.commits.push(commitAction);

          // Mettre à jour l'index
          if (!state.machineIndex[commitAction.machineId]) {
            state.machineIndex[commitAction.machineId] = [];
          }
          state.machineIndex[commitAction.machineId].push(commitAction.id);

          state.lastUpdated = new Date().toISOString();

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new CommitLogServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          CommitLogServiceErrorCode.COMMIT_LOG_FAILED,
          { action, error: result.error }
        );
      }

      logger.info(
        `[CommitLogService] Commit enregistré: ${commitAction.id} ` +
        `(${commitAction.actionType} par ${commitAction.machineId})`
      );

      return commitAction.id;
    } catch (error) {
      if (error instanceof CommitLogServiceError) {
        throw error;
      }

      logger.error('[CommitLogService] Erreur enregistrement action:', error);
      throw new CommitLogServiceError(
        `Erreur lors de l'enregistrement de l'action: ${error instanceof Error ? error.message : String(error)}`,
        CommitLogServiceErrorCode.COMMIT_LOG_FAILED,
        { action, error }
      );
    }
  }

  /**
   * Obtenir l'historique des commits
   *
   * @param options - Options de filtrage
   * @returns {Promise<CommitAction[]>} Liste des actions de commit
   */
  public async getCommitHistory(options?: CommitHistoryOptions): Promise<CommitAction[]> {
    try {
      const state = await this.loadCommitLogState();
      let commits = [...state.commits];

      // Filtrer par machineId
      if (options?.machineId) {
        const commitIds = state.machineIndex[options.machineId] || [];
        commits = commits.filter(c => commitIds.includes(c.id));
      }

      // Filtrer par type d'action
      if (options?.actionType) {
        commits = commits.filter(c => c.actionType === options.actionType);
      }

      // Filtrer par statut
      if (options?.status) {
        commits = commits.filter(c => c.status === options.status);
      }

      // Filtrer par timestamp
      if (options?.since) {
        commits = commits.filter(c => c.timestamp >= options.since!);
      }

      if (options?.until) {
        commits = commits.filter(c => c.timestamp <= options.until!);
      }

      // Trier par timestamp décroissant (plus récent en premier)
      commits.sort((a, b) => b.timestamp - a.timestamp);

      // Limiter le nombre de résultats
      if (options?.limit && options.limit > 0) {
        commits = commits.slice(0, options.limit);
      }

      logger.debug(`[CommitLogService] Historique récupéré: ${commits.length} commits`);

      return commits;
    } catch (error) {
      logger.error('[CommitLogService] Erreur récupération historique:', error);
      return [];
    }
  }

  /**
   * Obtenir le dernier commit d'une machine
   *
   * @param machineId - Identifiant de la machine
   * @returns {Promise<CommitAction | null>} Dernier commit ou null
   */
  public async getLatestCommit(machineId: string): Promise<CommitAction | null> {
    try {
      const commits = await this.getCommitHistory({
        machineId,
        limit: 1
      });

      return commits.length > 0 ? commits[0] : null;
    } catch (error) {
      logger.error(`[CommitLogService] Erreur récupération dernier commit ${machineId}:`, error);
      return null;
    }
  }

  /**
   * Obtenir un commit par son identifiant
   *
   * @param commitId - Identifiant du commit
   * @returns {Promise<CommitAction | null>} Commit ou null
   */
  public async getCommitById(commitId: string): Promise<CommitAction | null> {
    try {
      const state = await this.loadCommitLogState();
      return state.commits.find(c => c.id === commitId) || null;
    } catch (error) {
      logger.error(`[CommitLogService] Erreur récupération commit ${commitId}:`, error);
      return null;
    }
  }

  /**
   * Obtenir des statistiques sur les commits
   *
   * @param options - Options de filtrage
   * @returns {Promise<{total: number, byType: Record<string, number>, byStatus: Record<string, number>}>}
   */
  public async getCommitStats(options?: CommitHistoryOptions): Promise<{
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    try {
      const commits = await this.getCommitHistory(options);

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};

      for (const commit of commits) {
        // Compter par type
        byType[commit.actionType] = (byType[commit.actionType] || 0) + 1;

        // Compter par statut
        byStatus[commit.status] = (byStatus[commit.status] || 0) + 1;
      }

      const stats = {
        total: commits.length,
        byType,
        byStatus
      };

      logger.debug(`[CommitLogService] Statistiques: ${JSON.stringify(stats)}`);

      return stats;
    } catch (error) {
      logger.error('[CommitLogService] Erreur récupération statistiques:', error);
      return { total: 0, byType: {}, byStatus: {} };
    }
  }

  /**
   * Nettoyer les vieux commits
   *
   * @param olderThan - Timestamp limite (epoch en ms), les commits plus anciens seront supprimés
   * @returns {Promise<{removed: number, remaining: number}>} Statistiques du nettoyage
   */
  public async cleanupOldCommits(olderThan: number): Promise<{ removed: number; remaining: number }> {
    try {
      const commitLogFile = this.getCommitLogFilePath();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      // Charger l'état avant pour compter les commits supprimés
      const stateBefore = await this.loadCommitLogState();
      const initialCount = stateBefore.commits.length;

      const result = await this.lockManager.updateJsonWithLock<CommitLogState>(
        commitLogFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: CommitLogState = existingState || {
            commits: [],
            lastUpdated: new Date().toISOString(),
            version: '1.0.0',
            machineIndex: {}
          };

          // Filtrer les commits récents
          state.commits = state.commits.filter(c => c.timestamp >= olderThan);

          // Reconstruire l'index
          state.machineIndex = this.buildMachineIndex(state.commits);

          const removedCount = initialCount - state.commits.length;
          state.lastUpdated = new Date().toISOString();

          logger.info(
            `[CommitLogService] Nettoyage terminé: ${removedCount} vieux commits supprimés, ` +
            `${state.commits.length} commits restants`
          );

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new CommitLogServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          CommitLogServiceErrorCode.COMMIT_SAVE_FAILED,
          { error: result.error }
        );
      }

      // Compter les commits restants
      const state = await this.loadCommitLogState();
      const removedCount = initialCount - state.commits.length;

      return { removed: removedCount, remaining: state.commits.length };
    } catch (error) {
      if (error instanceof CommitLogServiceError) {
        throw error;
      }

      logger.error('[CommitLogService] Erreur nettoyage vieux commits:', error);
      throw new CommitLogServiceError(
        `Erreur lors du nettoyage des vieux commits: ${error instanceof Error ? error.message : String(error)}`,
        CommitLogServiceErrorCode.COMMIT_SAVE_FAILED,
        { error }
      );
    }
  }
}
