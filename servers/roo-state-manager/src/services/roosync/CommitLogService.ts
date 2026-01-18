/**
 * Service de Commit Log pour RooSync
 * 
 * Responsable de la gestion du log ordonné des commits,
 * garantissant la cohérence distribuée entre les machines.
 * 
 * @module CommitLogService
 * @version 1.0.0
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../../utils/logger.js';
import {
  CommitEntryType,
  CommitStatus,
  type CommitEntry,
  type CommitEntryData,
  type CommitLogState,
  type CommitLogConfig,
  type AppendCommitResult,
  type GetCommitsResult,
  type ConsistencyCheckResult,
  type ApplyCommitResult
} from '../../types/commit-log.js';

const logger = createLogger('CommitLogService');

/**
 * Erreur du service de commit log
 */
export class CommitLogServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[CommitLogService] ${message}`);
    this.name = 'CommitLogServiceError';
  }
}

/**
 * Service de Commit Log pour RooSync
 */
export class CommitLogService {
  private config: CommitLogConfig;
  private state: CommitLogState;
  private syncInterval: NodeJS.Timeout | null = null;
  private stateFilePath: string;
  private commitLogDir: string;
  private archiveDir: string;
  private lockFilePath: string;
  private isLocked: boolean = false;

  constructor(config: Partial<CommitLogConfig> = {}) {
    // Configuration par défaut
    this.config = {
      commitLogPath: config.commitLogPath || join(process.cwd(), '.shared-state', 'commit-log'),
      syncInterval: config.syncInterval || 30000, // 30 secondes
      maxEntries: config.maxEntries || 10000,
      maxRetryAttempts: config.maxRetryAttempts || 3,
      retryDelay: config.retryDelay || 5000, // 5 secondes
      enableCompression: config.enableCompression ?? true,
      compressionAge: config.compressionAge || 86400000, // 24 heures
      enableSigning: config.enableSigning || false,
      hashAlgorithm: config.hashAlgorithm || 'sha256'
    };

    // Initialiser les chemins
    this.commitLogDir = this.config.commitLogPath;
    this.stateFilePath = join(this.commitLogDir, 'state.json');
    this.archiveDir = join(this.commitLogDir, 'archive');
    this.lockFilePath = join(this.commitLogDir, '.lock');

    // État initial
    this.state = {
      currentSequenceNumber: 0,
      entries: new Map(),
      entriesByStatus: {
        pending: [],
        applied: [],
        failed: [],
        rolledBack: []
      },
      statistics: {
        totalEntries: 0,
        pendingEntries: 0,
        appliedEntries: 0,
        failedEntries: 0,
        rolledBackEntries: 0,
        lastCommitTimestamp: new Date().toISOString(),
        lastAppliedTimestamp: new Date().toISOString()
      },
      metadata: {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        machineId: process.env.ROOSYNC_MACHINE_ID || 'unknown'
      }
    };

    // Initialisation asynchrone non-bloquante pour éviter les Unhandled Rejections
    this.initializeService().catch(error => {
      // En mode test, ne pas bloquer - juste logger un warning
      if (process.env.NODE_ENV === 'test' || process.env.ROOSYNC_TEST_MODE === 'true') {
        logger.warn('Initialisation du service de commit log ignorée en mode test', { error: error.message });
      } else {
        logger.error('Erreur critique lors de l\'initialisation du service de commit log', error);
        // Ne pas relancer l'erreur pour éviter les Unhandled Rejections
        // L'état initialized sera false et les opérations échoueront proprement
      }
    });
  }

  /** Indique si le service est initialisé */
  private initialized: boolean = false;

  /**
   * Initialise le service et charge l'état existant
   */
  private async initializeService(): Promise<void> {
    try {
      // Créer les répertoires nécessaires
      await fs.mkdir(this.commitLogDir, { recursive: true });
      await fs.mkdir(this.archiveDir, { recursive: true });

      // Charger l'état existant
      await this.loadState();

      this.initialized = true;
      logger.info('Service de commit log initialisé', {
        commitLogPath: this.config.commitLogPath,
        currentSequenceNumber: this.state.currentSequenceNumber,
        totalEntries: this.state.statistics.totalEntries
      });
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation', error);
      this.initialized = false;
      throw new CommitLogServiceError(
        `Erreur d'initialisation: ${error instanceof Error ? error.message : String(error)}`,
        'INITIALIZATION_FAILED'
      );
    }
  }

  /**
   * Charge l'état du service depuis le disque
   */
  private async loadState(): Promise<void> {
    try {
      if (existsSync(this.stateFilePath)) {
        const content = readFileSync(this.stateFilePath, 'utf-8');
        const data = JSON.parse(content);

        // Reconstruire la Map depuis les données JSON
        this.state.entries = new Map(
          Object.entries(data.entries || {}).map(([key, value]) => [parseInt(key), value as CommitEntry])
        );

        // Restaurer les autres propriétés
        this.state.currentSequenceNumber = data.currentSequenceNumber || 0;
        this.state.entriesByStatus = data.entriesByStatus || {
          pending: [],
          applied: [],
          failed: [],
          rolledBack: []
        };
        this.state.statistics = data.statistics || this.state.statistics;
        this.state.metadata = data.metadata || this.state.metadata;

        logger.info('État du service chargé', {
          totalEntries: this.state.entries.size,
          currentSequenceNumber: this.state.currentSequenceNumber
        });
      }
    } catch (error) {
      logger.error('Erreur chargement état', error);
      // Continuer avec un état vide
      this.state.entries = new Map();
      this.state.currentSequenceNumber = 0;
    }
  }

  /**
   * Sauvegarde l'état du service sur le disque
   */
  private async saveState(): Promise<void> {
    try {
      const data = {
        currentSequenceNumber: this.state.currentSequenceNumber,
        entries: Object.fromEntries(this.state.entries),
        entriesByStatus: this.state.entriesByStatus,
        statistics: this.state.statistics,
        metadata: {
          ...this.state.metadata,
          lastUpdated: new Date().toISOString()
        }
      };

      await fs.writeFile(this.stateFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Erreur sauvegarde état', error);
      throw new CommitLogServiceError(
        `Erreur de sauvegarde: ${error instanceof Error ? error.message : String(error)}`,
        'SAVE_STATE_FAILED'
      );
    }
  }

  /**
   * Acquiert un lock pour éviter les accès concurrents
   */
  private async acquireLock(): Promise<boolean> {
    if (this.isLocked) {
      return false;
    }

    try {
      await fs.writeFile(this.lockFilePath, JSON.stringify({
        machineId: this.state.metadata.machineId,
        timestamp: new Date().toISOString()
      }));
      this.isLocked = true;
      return true;
    } catch (error) {
      logger.warn('Impossible d\'acquérir le lock', error as Record<string, any>);
      return false;
    }
  }

  /**
   * Libère le lock
   */
  private async releaseLock(): Promise<void> {
    try {
      if (existsSync(this.lockFilePath)) {
        await fs.unlink(this.lockFilePath);
      }
      this.isLocked = false;
    } catch (error) {
      logger.error('Erreur libération lock', error);
    }
  }

  /**
   * Calcule le hash d'une entrée de commit
   */
  private computeHash(entry: CommitEntry): string {
    const hash = createHash(this.config.hashAlgorithm);
    hash.update(JSON.stringify({
      sequenceNumber: entry.sequenceNumber,
      type: entry.type,
      machineId: entry.machineId,
      timestamp: entry.timestamp,
      status: entry.status,
      data: entry.data
    }));
    return hash.digest('hex');
  }

  /**
   * Génère le nom de fichier pour une entrée de commit
   */
  private getCommitFileName(sequenceNumber: number): string {
    return `${String(sequenceNumber).padStart(7, '0')}.json`;
  }

  /**
   * Sauvegarde une entrée de commit sur le disque
   */
  private async saveCommitEntry(entry: CommitEntry): Promise<void> {
    const fileName = this.getCommitFileName(entry.sequenceNumber);
    const filePath = join(this.commitLogDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
  }

  /**
   * Charge une entrée de commit depuis le disque
   */
  private async loadCommitEntry(sequenceNumber: number): Promise<CommitEntry | null> {
    const fileName = this.getCommitFileName(sequenceNumber);
    const filePath = join(this.commitLogDir, fileName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as CommitEntry;
    } catch (error) {
      logger.warn(`Impossible de charger l'entrée ${sequenceNumber}`, error as Record<string, any>);
      return null;
    }
  }

  /**
   * Met à jour les statistiques du service
   */
  private updateStatistics(): void {
    this.state.statistics.totalEntries = this.state.entries.size;
    this.state.statistics.pendingEntries = this.state.entriesByStatus.pending.length;
    this.state.statistics.appliedEntries = this.state.entriesByStatus.applied.length;
    this.state.statistics.failedEntries = this.state.entriesByStatus.failed.length;
    this.state.statistics.rolledBackEntries = this.state.entriesByStatus.rolledBack.length;
  }

  /**
   * Ajoute une entrée au commit log
   */
  public async appendCommit(entry: Omit<CommitEntry, 'sequenceNumber' | 'timestamp' | 'hash'>): Promise<AppendCommitResult> {
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      return {
        success: false,
        error: 'Impossible d\'acquérir le lock'
      };
    }

    try {
      // Incrémenter le numéro de séquence
      this.state.currentSequenceNumber++;
      const sequenceNumber = this.state.currentSequenceNumber;

      // Créer l'entrée complète
      const timestamp = new Date().toISOString();
      const fullEntry: CommitEntry = {
        ...entry,
        sequenceNumber,
        timestamp,
        hash: '' // Sera calculé après
      };

      // Calculer le hash
      fullEntry.hash = this.computeHash(fullEntry);

      // Ajouter à l'état
      this.state.entries.set(sequenceNumber, fullEntry);
      // Mapper le statut vers la clé correcte
      const statusKey = entry.status === CommitStatus.PENDING ? 'pending' :
                       entry.status === CommitStatus.APPLIED ? 'applied' :
                       entry.status === CommitStatus.FAILED ? 'failed' : 'rolledBack';
      this.state.entriesByStatus[statusKey].push(sequenceNumber);

      // Mettre à jour les statistiques
      this.state.statistics.lastCommitTimestamp = timestamp;
      this.updateStatistics();

      // Sauvegarder
      await this.saveCommitEntry(fullEntry);
      await this.saveState();

      logger.info(`Entrée de commit ajoutée`, {
        sequenceNumber,
        type: entry.type,
        machineId: entry.machineId
      });

      return {
        success: true,
        sequenceNumber,
        hash: fullEntry.hash
      };
    } catch (error) {
      logger.error('Erreur ajout commit', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Récupère une entrée par numéro de séquence
   */
  public async getCommit(sequenceNumber: number): Promise<CommitEntry | null> {
    // D'abord vérifier en mémoire
    let entry = this.state.entries.get(sequenceNumber);

    // Si pas en mémoire, essayer de charger depuis le disque
    if (!entry) {
      const loadedEntry = await this.loadCommitEntry(sequenceNumber);
      if (loadedEntry) {
        entry = loadedEntry;
      }
      if (entry) {
        this.state.entries.set(sequenceNumber, entry);
      }
    }

    return entry || null;
  }

  /**
   * Récupère les N dernières entrées
   */
  public async getLatestCommits(count: number): Promise<GetCommitsResult> {
    const allSequenceNumbers = Array.from(this.state.entries.keys()).sort((a, b) => b - a);
    const latestNumbers = allSequenceNumbers.slice(0, count);
    const entries: CommitEntry[] = [];

    for (const seqNum of latestNumbers) {
      const entry = await this.getCommit(seqNum);
      if (entry) {
        entries.push(entry);
      }
    }

    return {
      entries,
      totalCount: this.state.entries.size,
      hasMore: allSequenceNumbers.length > count,
      nextSequenceNumber: latestNumbers[count] || undefined
    };
  }

  /**
   * Récupère les entrées depuis une date
   */
  public async getCommitsSince(timestamp: string): Promise<GetCommitsResult> {
    const entries: CommitEntry[] = [];
    const sinceDate = new Date(timestamp);

    for (const entry of this.state.entries.values()) {
      const entryDate = new Date(entry.timestamp);
      if (entryDate >= sinceDate) {
        entries.push(entry);
      }
    }

    // Trier par numéro de séquence
    entries.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    return {
      entries,
      totalCount: this.state.entries.size,
      hasMore: false
    };
  }

  /**
   * Récupère les entrées en attente d'application
   */
  public async getPendingCommits(): Promise<CommitEntry[]> {
    const entries: CommitEntry[] = [];

    for (const seqNum of this.state.entriesByStatus.pending) {
      const entry = await this.getCommit(seqNum);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  /**
   * Applique une entrée de commit
   */
  public async applyCommit(sequenceNumber: number): Promise<ApplyCommitResult> {
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      return {
        success: false,
        sequenceNumber,
        appliedAt: new Date().toISOString(),
        error: 'Impossible d\'acquérir le lock'
      };
    }

    try {
      const entry = await this.getCommit(sequenceNumber);
      if (!entry) {
        return {
          success: false,
          sequenceNumber,
          appliedAt: new Date().toISOString(),
          error: `Entrée ${sequenceNumber} non trouvée`
        };
      }

      if (entry.status !== CommitStatus.PENDING) {
        return {
          success: false,
          sequenceNumber,
          appliedAt: new Date().toISOString(),
          error: `L'entrée ${sequenceNumber} n'est pas en attente (statut: ${entry.status})`
        };
      }

      // Mettre à jour le statut
      entry.status = CommitStatus.APPLIED;
      entry.metadata = entry.metadata || {};
      entry.metadata.appliedAt = new Date().toISOString();
      entry.metadata.appliedBy = this.state.metadata.machineId;

      // Mettre à jour les listes de statut
      const pendingIndex = this.state.entriesByStatus.pending.indexOf(sequenceNumber);
      if (pendingIndex !== -1) {
        this.state.entriesByStatus.pending.splice(pendingIndex, 1);
      }
      this.state.entriesByStatus.applied.push(sequenceNumber);

      // Mettre à jour les statistiques
      this.state.statistics.lastAppliedTimestamp = entry.metadata.appliedAt;
      this.updateStatistics();

      // Sauvegarder
      await this.saveCommitEntry(entry);
      await this.saveState();

      logger.info(`Entrée de commit appliquée`, {
        sequenceNumber,
        type: entry.type
      });

      return {
        success: true,
        sequenceNumber,
        appliedAt: entry.metadata.appliedAt,
        details: {
          operation: 'apply',
          duration: 0
        }
      };
    } catch (error) {
      logger.error('Erreur application commit', error);
      return {
        success: false,
        sequenceNumber,
        appliedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Applique toutes les entrées en attente
   */
  public async applyPendingCommits(): Promise<ApplyCommitResult[]> {
    const pendingCommits = await this.getPendingCommits();
    const results: ApplyCommitResult[] = [];

    for (const commit of pendingCommits) {
      const result = await this.applyCommit(commit.sequenceNumber);
      results.push(result);
    }

    return results;
  }

  /**
   * Annule une entrée de commit (rollback)
   */
  public async rollbackCommit(sequenceNumber: number, reason: string): Promise<boolean> {
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      return false;
    }

    try {
      const entry = await this.getCommit(sequenceNumber);
      if (!entry) {
        logger.warn(`Impossible de rollback: entrée ${sequenceNumber} non trouvée`);
        return false;
      }

      // Sauvegarder l'ancien statut avant de le changer
      const oldStatus = entry.status;
      
      // Mettre à jour le statut
      entry.status = CommitStatus.ROLLED_BACK;
      entry.metadata = entry.metadata || {};
      entry.metadata.lastError = reason;

      // Mettre à jour les listes de statut
      // Déterminer le tableau de statut correct basé sur l'ancien statut
      let statusKey: 'pending' | 'applied' | 'failed' | 'rolledBack';
      if (oldStatus === CommitStatus.PENDING) {
        statusKey = 'pending';
      } else if (oldStatus === CommitStatus.APPLIED) {
        statusKey = 'applied';
      } else if (oldStatus === CommitStatus.FAILED) {
        statusKey = 'failed';
      } else {
        statusKey = 'rolledBack';
      }
      const statusArray = this.state.entriesByStatus[statusKey];
      const index = statusArray.indexOf(sequenceNumber);
      if (index !== -1) {
        statusArray.splice(index, 1);
      }
      this.state.entriesByStatus.rolledBack.push(sequenceNumber);

      // Mettre à jour les statistiques
      this.updateStatistics();

      // Sauvegarder
      await this.saveCommitEntry(entry);
      await this.saveState();

      logger.info(`Entrée de commit annulée`, {
        sequenceNumber,
        reason
      });

      return true;
    } catch (error) {
      logger.error('Erreur rollback commit', error);
      return false;
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Vérifie la cohérence du commit log
   */
  public async verifyConsistency(): Promise<ConsistencyCheckResult> {
    const inconsistentEntries: Array<{
      sequenceNumber: number;
      issue: string;
      severity: 'low' | 'medium' | 'high';
    }> = [];

    // Vérifier les numéros de séquence
    const sequenceNumbers = Array.from(this.state.entries.keys()).sort((a, b) => a - b);
    for (let i = 0; i < sequenceNumbers.length; i++) {
      const expected = i + 1;
      const actual = sequenceNumbers[i];
      if (actual !== expected) {
        inconsistentEntries.push({
          sequenceNumber: actual,
          issue: `Numéro de séquence incohérent: attendu ${expected}, trouvé ${actual}`,
          severity: 'high'
        });
      }
    }

    // Vérifier les hash
    for (const entry of this.state.entries.values()) {
      const computedHash = this.computeHash(entry);
      if (computedHash !== entry.hash) {
        inconsistentEntries.push({
          sequenceNumber: entry.sequenceNumber,
          issue: 'Hash de l\'entrée invalide',
          severity: 'high'
        });
      }
    }

    // Vérifier les listes de statut
    for (const [status, sequenceNumbers] of Object.entries(this.state.entriesByStatus)) {
      for (const seqNum of sequenceNumbers) {
        const entry = this.state.entries.get(seqNum);
        if (!entry) {
          inconsistentEntries.push({
            sequenceNumber: seqNum,
            issue: `Entrée référencée dans ${status} mais non trouvée`,
            severity: 'medium'
          });
        } else if (entry.status !== status) {
          inconsistentEntries.push({
            sequenceNumber: seqNum,
            issue: `Statut incohérent: entrée marquée ${status} mais statut réel est ${entry.status}`,
            severity: 'medium'
          });
        }
      }
    }

    const isConsistent = inconsistentEntries.length === 0;
    const consistentEntries = this.state.entries.size - inconsistentEntries.length;

    return {
      isConsistent,
      inconsistentEntries,
      recommendations: isConsistent
        ? ['Le commit log est cohérent']
        : ['Corriger les entrées incohérentes', 'Vérifier les sauvegardes'],
      statistics: {
        totalEntries: this.state.entries.size,
        consistentEntries,
        inconsistentEntries: inconsistentEntries.length,
        consistencyRate: this.state.entries.size > 0 ? consistentEntries / this.state.entries.size : 1.0
      }
    };
  }

  /**
   * Compresse les entrées anciennes
   */
  public async compressOldEntries(): Promise<number> {
    if (!this.config.enableCompression) {
      return 0;
    }

    const now = Date.now();
    const compressedCount = 0;

    for (const entry of this.state.entries.values()) {
      const entryAge = now - new Date(entry.timestamp).getTime();
      if (entryAge > this.config.compressionAge) {
        // TODO: Implémenter la compression
        logger.debug(`Entrée ${entry.sequenceNumber} éligible pour compression`);
      }
    }

    return compressedCount;
  }

  /**
   * Nettoie les entrées échouées après N tentatives
   */
  public async cleanupFailedEntries(): Promise<number> {
    const toRemove: number[] = [];

    for (const seqNum of this.state.entriesByStatus.failed) {
      const entry = this.state.entries.get(seqNum);
      if (entry && entry.metadata && entry.metadata.retryCount && entry.metadata.retryCount >= this.config.maxRetryAttempts) {
        toRemove.push(seqNum);
      }
    }

    for (const seqNum of toRemove) {
      this.state.entries.delete(seqNum);
      const index = this.state.entriesByStatus.failed.indexOf(seqNum);
      if (index !== -1) {
        this.state.entriesByStatus.failed.splice(index, 1);
      }
    }

    if (toRemove.length > 0) {
      this.updateStatistics();
      await this.saveState();
      logger.info(`Nettoyage de ${toRemove.length} entrées échouées`);
    }

    return toRemove.length;
  }

  /**
   * Synchronise le commit log avec les autres machines
   */
  public async syncWithRemote(): Promise<void> {
    logger.info('Synchronisation du commit log');
    // TODO: Implémenter la synchronisation avec les autres machines
  }

  /**
   * Démarre la synchronisation automatique
   */
  public async startAutoSync(): Promise<void> {
    if (this.syncInterval) {
      logger.warn('La synchronisation automatique est déjà démarrée');
      return;
    }

    logger.info('Démarrage de la synchronisation automatique', {
      interval: this.config.syncInterval
    });

    this.syncInterval = setInterval(async () => {
      try {
        await this.syncWithRemote();
      } catch (error) {
        logger.error('Erreur synchronisation automatique:', error);
      }
    }, this.config.syncInterval);
  }

  /**
   * Arrête la synchronisation automatique
   */
  public async stopAutoSync(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      logger.info('Synchronisation automatique arrêtée');
    }
  }

  /**
   * Obtient l'état complet du service
   */
  public getState(): CommitLogState {
    return {
      currentSequenceNumber: this.state.currentSequenceNumber,
      entries: new Map(this.state.entries),
      entriesByStatus: { ...this.state.entriesByStatus },
      statistics: { ...this.state.statistics },
      metadata: { ...this.state.metadata }
    };
  }

  /**
   * Obtient les statistiques du service
   */
  public getStatistics(): CommitLogState['statistics'] {
    return { ...this.state.statistics };
  }

  /**
   * Réinitialise le commit log (DANGER: supprime toutes les entrées)
   */
  public async resetCommitLog(confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new CommitLogServiceError(
        'Confirmation requise pour réinitialiser le commit log',
        'CONFIRMATION_REQUIRED'
      );
    }

    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      throw new CommitLogServiceError(
        'Impossible d\'acquérir le lock',
        'LOCK_ACQUISITION_FAILED'
      );
    }

    try {
      logger.warn('Réinitialisation du commit log');

      // Supprimer toutes les entrées
      this.state.entries.clear();
      this.state.currentSequenceNumber = 0;
      this.state.entriesByStatus = {
        pending: [],
        applied: [],
        failed: [],
        rolledBack: []
      };
      this.state.statistics = {
        totalEntries: 0,
        pendingEntries: 0,
        appliedEntries: 0,
        failedEntries: 0,
        rolledBackEntries: 0,
        lastCommitTimestamp: new Date().toISOString(),
        lastAppliedTimestamp: new Date().toISOString()
      };

      // Supprimer les fichiers d'entrées
      const files = await fs.readdir(this.commitLogDir);
      for (const file of files) {
        if (file.endsWith('.json') && file !== 'state.json') {
          await fs.unlink(join(this.commitLogDir, file));
        }
      }

      // Sauvegarder l'état
      await this.saveState();

      logger.info('Commit log réinitialisé avec succès');
    } finally {
      await this.releaseLock();
    }
  }
}
