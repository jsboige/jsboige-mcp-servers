/**
 * Service de heartbeat pour RooSync
 *
 * Responsable de la gestion des heartbeats entre machines pour détecter
 * les machines actives et inactives dans le système multi-agent.
 *
 * @module HeartbeatService
 * @version 1.0.0
 */

import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { getFileLockManager, LockOptions } from './FileLockManager.simple.js';

const logger = createLogger('HeartbeatService');

/**
 * Données de heartbeat pour une machine
 */
export interface HeartbeatData {
  /** Identifiant de la machine */
  machineId: string;
  /** Timestamp du dernier heartbeat (epoch en ms) */
  lastHeartbeat: number;
  /** Timestamp du premier heartbeat (epoch en ms) */
  firstSeen: number;
  /** Nombre total de heartbeats */
  heartbeatCount: number;
  /** Statut de la machine */
  status: 'online' | 'offline' | 'unknown';
  /** Métadonnées optionnelles */
  metadata?: {
    version?: string;
    mode?: string;
    source?: string;
  };
}

/**
 * État global des heartbeats
 */
export interface HeartbeatState {
  /** Map des heartbeats par machineId */
  heartbeats: Record<string, HeartbeatData>;
  /** Timestamp de la dernière mise à jour */
  lastUpdated: string;
  /** Version du format */
  version: string;
}

/**
 * Options de configuration pour le heartbeat
 */
export interface HeartbeatOptions {
  /** Timeout en ms pour considérer une machine comme offline (défaut: 5 minutes) */
  timeout?: number;
  /** Métadonnées optionnelles à inclure */
  metadata?: {
    version?: string;
    mode?: string;
    source?: string;
  };
}

/**
 * Codes d'erreur pour HeartbeatService
 */
export enum HeartbeatServiceErrorCode {
  HEARTBEAT_REGISTER_FAILED = 'HEARTBEAT_REGISTER_FAILED',
  HEARTBEAT_LOAD_FAILED = 'HEARTBEAT_LOAD_FAILED',
  HEARTBEAT_SAVE_FAILED = 'HEARTBEAT_SAVE_FAILED',
  HEARTBEAT_CLEANUP_FAILED = 'HEARTBEAT_CLEANUP_FAILED',
  INVALID_MACHINE_ID = 'INVALID_MACHINE_ID'
}

/**
 * Erreur spécifique pour HeartbeatService
 */
export class HeartbeatServiceError extends Error {
  constructor(
    message: string,
    public readonly code: HeartbeatServiceErrorCode,
    public readonly details?: any
  ) {
    super(`[HeartbeatService] ${message}`);
    this.name = 'HeartbeatServiceError';
  }
}

/**
 * Service de gestion des heartbeats
 */
export class HeartbeatService {
  private readonly DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly HEARTBEAT_FILE = 'heartbeats.json';

  constructor(
    private config: RooSyncConfig,
    private lockManager = getFileLockManager()
  ) {}

  /**
   * Obtenir le chemin du fichier de heartbeats
   */
  private getHeartbeatFilePath(): string {
    return join(this.config.sharedPath, '.shared-state', this.HEARTBEAT_FILE);
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
      throw new HeartbeatServiceError(
        `Impossible de créer le répertoire .shared-state: ${sharedStateDir}`,
        HeartbeatServiceErrorCode.HEARTBEAT_REGISTER_FAILED,
        { sharedStateDir, error }
      );
    }
  }

  /**
   * Charger l'état des heartbeats depuis le disque
   */
  private async loadHeartbeatState(): Promise<HeartbeatState> {
    const heartbeatFile = this.getHeartbeatFilePath();

    try {
      if (!existsSync(heartbeatFile)) {
        // Retourner un état vide si le fichier n'existe pas
        return {
          heartbeats: {},
          lastUpdated: new Date().toISOString(),
          version: '1.0.0'
        };
      }

      const content = await fs.readFile(heartbeatFile, 'utf-8');
      const data = JSON.parse(content);

      // Valider la structure
      if (!data.heartbeats || typeof data.heartbeats !== 'object') {
        logger.warn('[HeartbeatService] Structure de fichier invalide, réinitialisation');
        return {
          heartbeats: {},
          lastUpdated: new Date().toISOString(),
          version: '1.0.0'
        };
      }

      return data as HeartbeatState;
    } catch (error) {
      logger.error('[HeartbeatService] Erreur chargement état heartbeats:', error);
      throw new HeartbeatServiceError(
        `Erreur lors du chargement des heartbeats: ${error instanceof Error ? error.message : String(error)}`,
        HeartbeatServiceErrorCode.HEARTBEAT_LOAD_FAILED,
        { heartbeatFile, error }
      );
    }
  }

  /**
   * Sauvegarder l'état des heartbeats sur le disque
   */
  private async saveHeartbeatState(state: HeartbeatState): Promise<void> {
    const heartbeatFile = this.getHeartbeatFilePath();

    try {
      await this.ensureSharedStateDir();

      const data = {
        ...state,
        lastUpdated: new Date().toISOString()
      };

      await fs.writeFile(
        heartbeatFile,
        JSON.stringify(data, null, 2),
        'utf-8'
      );

      logger.debug(`[HeartbeatService] État heartbeats sauvegardé: ${Object.keys(state.heartbeats).length} machines`);
    } catch (error) {
      logger.error('[HeartbeatService] Erreur sauvegarde état heartbeats:', error);
      throw new HeartbeatServiceError(
        `Erreur lors de la sauvegarde des heartbeats: ${error instanceof Error ? error.message : String(error)}`,
        HeartbeatServiceErrorCode.HEARTBEAT_SAVE_FAILED,
        { heartbeatFile, error }
      );
    }
  }

  /**
   * Enregistrer un heartbeat pour une machine
   *
   * @param machineId - Identifiant de la machine
   * @param timestamp - Timestamp du heartbeat (epoch en ms, défaut: maintenant)
   * @param options - Options de configuration
   * @returns {Promise<void>}
   */
  public async registerHeartbeat(
    machineId: string,
    timestamp?: number,
    options?: HeartbeatOptions
  ): Promise<void> {
    try {
      // Valider machineId
      if (!machineId || typeof machineId !== 'string' || machineId.trim().length === 0) {
        throw new HeartbeatServiceError(
          'machineId invalide',
          HeartbeatServiceErrorCode.INVALID_MACHINE_ID,
          { machineId }
        );
      }

      const now = timestamp || Date.now();
      const heartbeatFile = this.getHeartbeatFilePath();

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      // Utiliser le verrouillage pour la mise à jour
      const result = await this.lockManager.updateJsonWithLock<HeartbeatState>(
        heartbeatFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: HeartbeatState = existingState || {
            heartbeats: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0'
          };

          // Créer ou mettre à jour le heartbeat
          const existingHeartbeat = state.heartbeats[machineId];
          const heartbeatData: HeartbeatData = existingHeartbeat ? {
            ...existingHeartbeat,
            lastHeartbeat: now,
            heartbeatCount: existingHeartbeat.heartbeatCount + 1,
            status: 'online',
            metadata: options?.metadata || existingHeartbeat.metadata
          } : {
            machineId,
            lastHeartbeat: now,
            firstSeen: now,
            heartbeatCount: 1,
            status: 'online',
            metadata: options?.metadata
          };

          state.heartbeats[machineId] = heartbeatData;
          state.lastUpdated = new Date().toISOString();

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new HeartbeatServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          HeartbeatServiceErrorCode.HEARTBEAT_REGISTER_FAILED,
          { machineId, error: result.error }
        );
      }

      logger.debug(`[HeartbeatService] Heartbeat enregistré pour ${machineId} (${new Date(now).toISOString()})`);
    } catch (error) {
      if (error instanceof HeartbeatServiceError) {
        throw error;
      }

      logger.error(`[HeartbeatService] Erreur enregistrement heartbeat pour ${machineId}:`, error);
      throw new HeartbeatServiceError(
        `Erreur lors de l'enregistrement du heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        HeartbeatServiceErrorCode.HEARTBEAT_REGISTER_FAILED,
        { machineId, error }
      );
    }
  }

  /**
   * Vérifier si une machine est en ligne
   *
   * @param machineId - Identifiant de la machine
   * @param timeout - Timeout en ms (défaut: 5 minutes)
   * @returns {Promise<boolean>} true si la machine est en ligne
   */
  public async isMachineAlive(
    machineId: string,
    timeout?: number
  ): Promise<boolean> {
    try {
      const state = await this.loadHeartbeatState();
      const heartbeat = state.heartbeats[machineId];

      if (!heartbeat) {
        return false;
      }

      const now = Date.now();
      const effectiveTimeout = timeout || this.DEFAULT_TIMEOUT;
      const timeSinceLastHeartbeat = now - heartbeat.lastHeartbeat;

      const isAlive = timeSinceLastHeartbeat < effectiveTimeout;

      logger.debug(
        `[HeartbeatService] Machine ${machineId}: ${isAlive ? 'en ligne' : 'hors ligne'} ` +
        `(dernier heartbeat: ${new Date(heartbeat.lastHeartbeat).toISOString()}, ` +
        `il y a ${Math.round(timeSinceLastHeartbeat / 1000)}s)`
      );

      return isAlive;
    } catch (error) {
      logger.error(`[HeartbeatService] Erreur vérification statut ${machineId}:`, error);
      return false;
    }
  }

  /**
   * Obtenir la liste des machines en ligne
   *
   * @param timeout - Timeout en ms (défaut: 5 minutes)
   * @returns {Promise<string[]>} Liste des machineIds en ligne
   */
  public async getAliveMachines(timeout?: number): Promise<string[]> {
    try {
      const state = await this.loadHeartbeatState();
      const now = Date.now();
      const effectiveTimeout = timeout || this.DEFAULT_TIMEOUT;

      const aliveMachines: string[] = [];

      for (const [machineId, heartbeat] of Object.entries(state.heartbeats)) {
        const timeSinceLastHeartbeat = now - heartbeat.lastHeartbeat;
        if (timeSinceLastHeartbeat < effectiveTimeout) {
          aliveMachines.push(machineId);
        }
      }

      logger.debug(`[HeartbeatService] ${aliveMachines.length} machines en ligne: ${aliveMachines.join(', ')}`);

      return aliveMachines;
    } catch (error) {
      logger.error('[HeartbeatService] Erreur récupération machines en ligne:', error);
      return [];
    }
  }

  /**
   * Nettoyer les heartbeats obsolètes
   *
   * @param timeout - Timeout en ms (défaut: 5 minutes)
   * @returns {Promise<{cleaned: number, remaining: number}>} Statistiques du nettoyage
   */
  public async cleanupStaleMachines(
    timeout?: number
  ): Promise<{ cleaned: number; remaining: number }> {
    try {
      const heartbeatFile = this.getHeartbeatFilePath();
      const now = Date.now();
      const effectiveTimeout = timeout || this.DEFAULT_TIMEOUT;

      // Options de verrouillage
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };

      const result = await this.lockManager.updateJsonWithLock<HeartbeatState>(
        heartbeatFile,
        (existingState) => {
          // Initialiser l'état si nécessaire
          const state: HeartbeatState = existingState || {
            heartbeats: {},
            lastUpdated: new Date().toISOString(),
            version: '1.0.0'
          };

          const initialCount = Object.keys(state.heartbeats).length;
          const cleanedMachines: string[] = [];

          // Marquer les machines obsolètes comme offline
          for (const [machineId, heartbeat] of Object.entries(state.heartbeats)) {
            const timeSinceLastHeartbeat = now - heartbeat.lastHeartbeat;
            if (timeSinceLastHeartbeat >= effectiveTimeout) {
              state.heartbeats[machineId].status = 'offline';
              cleanedMachines.push(machineId);
            }
          }

          const finalCount = Object.keys(state.heartbeats).length;
          const cleanedCount = cleanedMachines.length;

          state.lastUpdated = new Date().toISOString();

          logger.info(
            `[HeartbeatService] Nettoyage terminé: ${cleanedCount} machines marquées offline, ` +
            `${finalCount} machines restantes`
          );

          return state;
        },
        lockOptions
      );

      if (!result.success) {
        throw new HeartbeatServiceError(
          `Échec du verrouillage: ${result.error?.message || 'Erreur inconnue'}`,
          HeartbeatServiceErrorCode.HEARTBEAT_CLEANUP_FAILED,
          { error: result.error }
        );
      }

      // Compter les machines restantes
      const state = await this.loadHeartbeatState();
      const remainingCount = Object.keys(state.heartbeats).length;
      const cleanedCount = Object.values(state.heartbeats).filter(h => h.status === 'offline').length;

      return { cleaned: cleanedCount, remaining: remainingCount };
    } catch (error) {
      if (error instanceof HeartbeatServiceError) {
        throw error;
      }

      logger.error('[HeartbeatService] Erreur nettoyage heartbeats:', error);
      throw new HeartbeatServiceError(
        `Erreur lors du nettoyage des heartbeats: ${error instanceof Error ? error.message : String(error)}`,
        HeartbeatServiceErrorCode.HEARTBEAT_CLEANUP_FAILED,
        { error }
      );
    }
  }

  /**
   * Obtenir les données de heartbeat pour une machine
   *
   * @param machineId - Identifiant de la machine
   * @returns {Promise<HeartbeatData | null>} Données de heartbeat ou null
   */
  public async getHeartbeatData(machineId: string): Promise<HeartbeatData | null> {
    try {
      const state = await this.loadHeartbeatState();
      return state.heartbeats[machineId] || null;
    } catch (error) {
      logger.error(`[HeartbeatService] Erreur récupération heartbeat ${machineId}:`, error);
      return null;
    }
  }

  /**
   * Obtenir toutes les données de heartbeat
   *
   * @returns {Promise<HeartbeatData[]>} Liste de toutes les données de heartbeat
   */
  public async getAllHeartbeats(): Promise<HeartbeatData[]> {
    try {
      const state = await this.loadHeartbeatState();
      return Object.values(state.heartbeats);
    } catch (error) {
      logger.error('[HeartbeatService] Erreur récupération tous heartbeats:', error);
      return [];
    }
  }

  /**
   * Obtenir des statistiques sur les heartbeats
   *
   * @returns {Promise<{total: number, online: number, offline: number, unknown: number}>}
   */
  public async getHeartbeatStats(): Promise<{
    total: number;
    online: number;
    offline: number;
    unknown: number;
  }> {
    try {
      const heartbeats = await this.getAllHeartbeats();

      const stats = {
        total: heartbeats.length,
        online: heartbeats.filter(h => h.status === 'online').length,
        offline: heartbeats.filter(h => h.status === 'offline').length,
        unknown: heartbeats.filter(h => h.status === 'unknown').length
      };

      logger.debug(`[HeartbeatService] Statistiques: ${JSON.stringify(stats)}`);

      return stats;
    } catch (error) {
      logger.error('[HeartbeatService] Erreur récupération statistiques:', error);
      return { total: 0, online: 0, offline: 0, unknown: 0 };
    }
  }
}
