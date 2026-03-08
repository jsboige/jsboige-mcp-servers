/**
 * Service de Heartbeat pour RooSync
 *
 * Responsable de la gestion des heartbeats entre agents,
 * la détection des machines offline et la synchronisation automatique.
 *
 * v3.1.0: Per-machine files to avoid GDrive sync conflicts.
 * Each machine writes ONLY its own file in heartbeats/{machineId}.json.
 *
 * @module HeartbeatService
 * @version 3.1.0
 */

import { promises as fs, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HeartbeatService');

/**
 * Configuration du heartbeat
 */
export interface HeartbeatConfig {
  /** Intervalle de heartbeat en millisecondes (défaut: 60s) */
  heartbeatInterval: number;

  /** Timeout avant de considérer une machine offline en millisecondes (défaut: 10min) */
  offlineTimeout: number;

  /** Nombre de heartbeats manqués avant alerte */
  missedHeartbeatThreshold: number;

  /** Activer la synchronisation automatique */
  autoSyncEnabled: boolean;

  /** Intervalle de synchronisation automatique en millisecondes */
  autoSyncInterval: number;

  /**
   * Intervalle minimal entre deux écritures sur disque en millisecondes (défaut: 5min).
   * Réduit les syncs GDrive en n'écrivant que lors de changements de statut
   * ou après ce délai minimum. Fix #607.
   */
  persistenceInterval: number;
}

/**
 * Données de heartbeat d'une machine
 */
export interface HeartbeatData {
  /** Identifiant de la machine */
  machineId: string;

  /** Timestamp du dernier heartbeat */
  lastHeartbeat: string;

  /** Statut de la machine */
  status: 'online' | 'offline' | 'warning';

  /** Nombre de heartbeats manqués consécutifs */
  missedHeartbeats: number;

  /** Timestamp de première détection offline */
  offlineSince?: string;

  /** Métadonnées */
  metadata: {
    firstSeen: string;
    lastUpdated: string;
    version: string;
  };
}

/**
 * État du service de heartbeat
 */
export interface HeartbeatServiceState {
  /** Données de heartbeat par machine */
  heartbeats: Map<string, HeartbeatData>;

  /** Machines actuellement online */
  onlineMachines: string[];

  /** Machines actuellement offline */
  offlineMachines: string[];

  /** Machines en avertissement */
  warningMachines: string[];

  /** Statistiques */
  statistics: {
    totalMachines: number;
    onlineCount: number;
    offlineCount: number;
    warningCount: number;
    lastHeartbeatCheck: string;
  };
}

/**
 * Résultat de vérification de heartbeat
 */
export interface HeartbeatCheckResult {
  /** Succès de la vérification */
  success: boolean;

  /** Machines détectées offline */
  newlyOfflineMachines: string[];

  /** Machines redevenues online */
  newlyOnlineMachines: string[];

  /** Machines en avertissement */
  warningMachines: string[];

  /** Timestamp de la vérification */
  checkedAt: string;
}

/**
 * Erreur du service de heartbeat
 */
export class HeartbeatServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[HeartbeatService] ${message}`);
    this.name = 'HeartbeatServiceError';
  }
}

/**
 * Service de Heartbeat pour RooSync
 *
 * Uses per-machine files in heartbeats/ subdirectory to avoid
 * GDrive sync conflicts from concurrent writes to a single file.
 */
export class HeartbeatService {
  private heartbeatsDir: string;
  private legacyHeartbeatPath: string;
  private state: HeartbeatServiceState;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private autoSyncInterval: NodeJS.Timeout | null = null;
  private heartbeatCheckerInterval: NodeJS.Timeout | null = null;
  private config: HeartbeatConfig;
  private onOfflineDetectedCallback?: (machineId: string) => void;
  private onOnlineRestoredCallback?: (machineId: string) => void;
  /** Tracks last disk write timestamp per machine for dirty-flag optimization (#607) */
  private lastDiskWrite: Map<string, number> = new Map();

  constructor(
    private sharedPath: string,
    config?: Partial<HeartbeatConfig>
  ) {
    this.heartbeatsDir = join(sharedPath, 'heartbeats');
    this.legacyHeartbeatPath = join(sharedPath, 'heartbeat.json');

    // Configuration par défaut (#607 fix: réduit fréquence d'écriture GDrive)
    this.config = {
      heartbeatInterval: 60000,  // 1 minute (réduit de 30s)
      offlineTimeout: 600000,    // 10 minutes (réduit faux positifs avec dirty-flag)
      missedHeartbeatThreshold: 4,
      autoSyncEnabled: true,
      autoSyncInterval: 60000,   // 1 minute
      persistenceInterval: 300000, // 5 minutes entre écritures GDrive (#607)
      ...config
    };

    this.state = {
      heartbeats: new Map(),
      onlineMachines: [],
      offlineMachines: [],
      warningMachines: [],
      statistics: {
        totalMachines: 0,
        onlineCount: 0,
        offlineCount: 0,
        warningCount: 0,
        lastHeartbeatCheck: new Date().toISOString()
      }
    };

    this.initializeService();
  }

  /**
   * Initialise le service et charge les données existantes
   */
  private initializeService(): void {
    try {
      this.loadState();
      logger.info('Service de heartbeat initialisé', {
        heartbeatInterval: this.config.heartbeatInterval,
        offlineTimeout: this.config.offlineTimeout
      });
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation', error);
    }
  }

  /**
   * Returns the file path for a machine's heartbeat file
   */
  private getMachineFilePath(machineId: string): string {
    return join(this.heartbeatsDir, `${machineId.toLowerCase()}.json`);
  }

  /**
   * Ensures the heartbeats/ directory exists
   */
  private ensureHeartbeatsDir(): void {
    try {
      if (!existsSync(this.heartbeatsDir)) {
        mkdirSync(this.heartbeatsDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Erreur création répertoire heartbeats', error);
    }
  }

  /**
   * Charge l'état du service depuis le disque (synchrone)
   * Checks per-machine files first, falls back to legacy single file with migration.
   */
  private loadState(): void {
    try {
      if (existsSync(this.heartbeatsDir)) {
        // New format: per-machine files
        this.loadFromPerMachineFiles();
      } else if (existsSync(this.legacyHeartbeatPath)) {
        // Legacy format: migrate from single file
        this.migrateFromLegacyFile();
      }
      // else: fresh start with empty state

      this.updateMachineStatus();

      logger.info('État du service chargé', {
        totalMachines: this.state.heartbeats.size,
        online: this.state.onlineMachines.length,
        offline: this.state.offlineMachines.length,
        warning: this.state.warningMachines.length
      });
    } catch (error) {
      logger.error('Erreur chargement état', error);
      this.state.heartbeats = new Map();
      this.updateMachineStatus();
    }
  }

  /**
   * Load heartbeat data from per-machine files in heartbeats/ directory
   */
  private loadFromPerMachineFiles(): void {
    try {
      const files = readdirSync(this.heartbeatsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filePath = join(this.heartbeatsDir, file);
          const content = readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content) as HeartbeatData;
          const machineId = data.machineId?.toLowerCase() || file.replace('.json', '').toLowerCase();
          this.state.heartbeats.set(machineId, data);
        } catch (fileError) {
          logger.warn(`Erreur lecture fichier heartbeat ${file}`, { error: String(fileError) });
        }
      }
    } catch (error) {
      logger.error('Erreur lecture répertoire heartbeats', error);
    }
  }

  /**
   * Migrate from legacy single heartbeat.json to per-machine files
   */
  private migrateFromLegacyFile(): void {
    try {
      const content = readFileSync(this.legacyHeartbeatPath, 'utf-8');
      const data = JSON.parse(content);
      const heartbeats = data.heartbeats || {};

      this.ensureHeartbeatsDir();

      for (const [key, value] of Object.entries(heartbeats)) {
        const machineId = key.toLowerCase();
        const heartbeatData = value as HeartbeatData;
        this.state.heartbeats.set(machineId, heartbeatData);

        // Write individual file
        try {
          const filePath = this.getMachineFilePath(machineId);
          writeFileSync(filePath, JSON.stringify(heartbeatData, null, 2));
        } catch (writeError) {
          logger.warn(`Erreur écriture heartbeat ${machineId} pendant migration`, { error: String(writeError) });
        }
      }

      // Remove legacy file
      try {
        unlinkSync(this.legacyHeartbeatPath);
        logger.info('Fichier legacy heartbeat.json migré et supprimé');
      } catch (unlinkError) {
        logger.warn('Impossible de supprimer heartbeat.json après migration', { error: String(unlinkError) });
      }
    } catch (error) {
      logger.error('Erreur migration legacy heartbeat.json', error);
    }
  }

  /**
   * Reload all per-machine files from disk (useful before checkHeartbeats)
   */
  public reloadFromDisk(): void {
    this.state.heartbeats.clear();
    if (existsSync(this.heartbeatsDir)) {
      this.loadFromPerMachineFiles();
    }
    this.updateMachineStatus();
  }

  /**
   * Save a single machine's heartbeat data to its own file
   */
  private async saveMachineHeartbeat(machineId: string): Promise<void> {
    try {
      await fs.mkdir(this.heartbeatsDir, { recursive: true });

      const heartbeatData = this.state.heartbeats.get(machineId.toLowerCase());
      if (!heartbeatData) return;

      const filePath = this.getMachineFilePath(machineId);
      await fs.writeFile(filePath, JSON.stringify(heartbeatData, null, 2));
    } catch (error) {
      logger.error(`Erreur sauvegarde heartbeat pour ${machineId}`, error);
    }
  }

  /**
   * Delete a machine's heartbeat file
   */
  private async removeMachineFile(machineId: string): Promise<void> {
    try {
      const filePath = this.getMachineFilePath(machineId);
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    } catch (error) {
      logger.error(`Erreur suppression fichier heartbeat pour ${machineId}`, error);
    }
  }

  /**
   * Sauvegarde l'état de TOUTES les machines (used at stop/config update)
   */
  private async saveState(): Promise<void> {
    try {
      await fs.mkdir(this.heartbeatsDir, { recursive: true });

      for (const [machineId, heartbeatData] of this.state.heartbeats.entries()) {
        const filePath = this.getMachineFilePath(machineId);
        await fs.writeFile(filePath, JSON.stringify(heartbeatData, null, 2));
      }
    } catch (error) {
      logger.error('Erreur sauvegarde état', error);
    }
  }

  /**
   * Enregistre un heartbeat pour une machine
   */
  public async registerHeartbeat(
    machineId: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    machineId = machineId.toLowerCase();
    const now = new Date().toISOString();
    const nowMs = Date.now();

    let heartbeatData = this.state.heartbeats.get(machineId);
    let isNew = false;
    let statusChanged = false;

    if (!heartbeatData) {
      // Nouvelle machine - toujours écrire sur disque
      isNew = true;
      heartbeatData = {
        machineId,
        lastHeartbeat: now,
        status: 'online',
        missedHeartbeats: 0,
        metadata: {
          firstSeen: now,
          lastUpdated: now,
          version: '3.1.0'
        }
      };

      logger.info(`Nouvelle machine enregistrée: ${machineId}`);
    } else {
      const previousStatus = heartbeatData.status;

      // Si la machine était offline/warning, logger le retour online
      if (heartbeatData.offlineSince) {
        logger.info(`Machine redevenue online: ${machineId}`, {
          offlineDuration: nowMs - new Date(heartbeatData.offlineSince).getTime()
        });
      }

      // Mise à jour heartbeat existant
      heartbeatData.lastHeartbeat = now;
      heartbeatData.status = 'online';
      heartbeatData.missedHeartbeats = 0;
      heartbeatData.offlineSince = undefined;
      heartbeatData.metadata.lastUpdated = now;

      // Détecter si le statut a changé (non-online → online)
      if (previousStatus !== 'online') {
        statusChanged = true;
      }
    }

    this.state.heartbeats.set(machineId, heartbeatData);
    this.updateMachineStatus();

    // Fix #607: Dirty-flag write optimization - évite sync GDrive perpétuelle.
    // N'écrire sur disque que si: nouvelle machine, changement de statut,
    // ou > persistenceInterval depuis dernière écriture.
    const lastWrite = this.lastDiskWrite.get(machineId) ?? 0;
    const timeSinceLastWrite = nowMs - lastWrite;
    const shouldWrite = isNew || statusChanged || timeSinceLastWrite >= this.config.persistenceInterval;

    if (shouldWrite) {
      await this.saveMachineHeartbeat(machineId);
      this.lastDiskWrite.set(machineId, nowMs);
    }
  }

  /**
   * Vérifie les heartbeats et détecte les machines offline
   */
  public async checkHeartbeats(): Promise<HeartbeatCheckResult> {
    // Reload fresh data from per-machine files
    this.reloadFromDisk();

    const now = Date.now();
    const result: HeartbeatCheckResult = {
      success: true,
      newlyOfflineMachines: [],
      newlyOnlineMachines: [],
      warningMachines: [],
      checkedAt: new Date().toISOString()
    };

    for (const [machineId, heartbeatData] of this.state.heartbeats.entries()) {
      const lastHeartbeatTime = new Date(heartbeatData.lastHeartbeat).getTime();
      const timeSinceLastHeartbeat = now - lastHeartbeatTime;

      // Calculer le nombre de heartbeats manqués
      const missedHeartbeats = Math.floor(timeSinceLastHeartbeat / this.config.heartbeatInterval);

      // Vérifier d'abord si la machine est en avertissement (avant offline)
      // Le warning se déclenche à (missedHeartbeatThreshold - 1) * heartbeatInterval
      const warningThreshold = this.config.heartbeatInterval * (this.config.missedHeartbeatThreshold - 1);

      if (timeSinceLastHeartbeat > this.config.offlineTimeout) {
        // Machine offline
        if (heartbeatData.status !== 'offline') {
          heartbeatData.status = 'offline';
          heartbeatData.missedHeartbeats = missedHeartbeats;

          if (!heartbeatData.offlineSince) {
            heartbeatData.offlineSince = new Date().toISOString();
          }

          result.newlyOfflineMachines.push(machineId);
          logger.warn(`Machine détectée offline: ${machineId}`, {
            timeSinceLastHeartbeat,
            offlineSince: heartbeatData.offlineSince
          });
        }
      } else if (timeSinceLastHeartbeat >= warningThreshold) {
        // Machine en avertissement (heartbeats manqués mais pas encore offline)
        if (heartbeatData.status !== 'warning') {
          heartbeatData.status = 'warning';
          heartbeatData.missedHeartbeats = missedHeartbeats;

          result.warningMachines.push(machineId);
          logger.warn(`Machine en avertissement: ${machineId}`, {
            missedHeartbeats: heartbeatData.missedHeartbeats,
            timeSinceLastHeartbeat
          });
        }
      } else {
        // Machine online
        if (heartbeatData.status !== 'online') {
          heartbeatData.status = 'online';
          heartbeatData.missedHeartbeats = 0;
          heartbeatData.offlineSince = undefined;

          result.newlyOnlineMachines.push(machineId);
          logger.info(`Machine redevenue online: ${machineId}`);
        }
      }

      heartbeatData.metadata.lastUpdated = new Date().toISOString();
      this.state.heartbeats.set(machineId, heartbeatData);
    }

    this.updateMachineStatus();
    // Status is computed in-memory, not persisted to other machines' files

    this.state.statistics.lastHeartbeatCheck = new Date().toISOString();

    // Appeler les callbacks stockés pour les changements de statut
    if (this.onOfflineDetectedCallback) {
      for (const machineId of result.newlyOfflineMachines) {
        this.onOfflineDetectedCallback(machineId);
      }
    }

    if (this.onOnlineRestoredCallback) {
      for (const machineId of result.newlyOnlineMachines) {
        this.onOnlineRestoredCallback(machineId);
      }
    }

    return result;
  }

  /**
   * Met à jour les listes de machines par statut
   */
  private updateMachineStatus(): void {
    const onlineMachines: string[] = [];
    const offlineMachines: string[] = [];
    const warningMachines: string[] = [];

    for (const [machineId, heartbeatData] of this.state.heartbeats.entries()) {
      switch (heartbeatData.status) {
        case 'online':
          onlineMachines.push(machineId);
          break;
        case 'offline':
          offlineMachines.push(machineId);
          break;
        case 'warning':
          warningMachines.push(machineId);
          break;
      }
    }

    this.state.onlineMachines = onlineMachines;
    this.state.offlineMachines = offlineMachines;
    this.state.warningMachines = warningMachines;

    this.state.statistics.totalMachines = this.state.heartbeats.size;
    this.state.statistics.onlineCount = onlineMachines.length;
    this.state.statistics.offlineCount = offlineMachines.length;
    this.state.statistics.warningCount = warningMachines.length;
  }

  /**
   * Démarre le service de heartbeat automatique
   */
  public async startHeartbeatService(
    machineId: string,
    onOfflineDetected?: (machineId: string) => void,
    onOnlineRestored?: (machineId: string) => void
  ): Promise<void> {
    machineId = machineId.toLowerCase();
    logger.info(`Démarrage du service heartbeat pour: ${machineId}`);

    // Stocker les callbacks comme propriétés de classe
    this.onOfflineDetectedCallback = onOfflineDetected;
    this.onOnlineRestoredCallback = onOnlineRestored;

    // Enregistrer le heartbeat initial
    await this.registerHeartbeat(machineId);

    // Démarrer l'intervalle de heartbeat
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.registerHeartbeat(machineId);
      } catch (error) {
        logger.error(`Erreur heartbeat pour ${machineId}:`, error);
      }
    }, this.config.heartbeatInterval);

    // Démarrer la vérification des heartbeats
    this.startHeartbeatChecker();

    // Démarrer la synchronisation automatique si activée
    if (this.config.autoSyncEnabled) {
      this.startAutoSync();
    }
  }

  /**
   * Démarre le vérificateur de heartbeat
   */
  private startHeartbeatChecker(): void {
    this.heartbeatCheckerInterval = setInterval(async () => {
      try {
        const result = await this.checkHeartbeats();

        // Notifier les callbacks stockés
        if (this.onOfflineDetectedCallback) {
          for (const machineId of result.newlyOfflineMachines) {
            this.onOfflineDetectedCallback(machineId);
          }
        }

        if (this.onOnlineRestoredCallback) {
          for (const machineId of result.newlyOnlineMachines) {
            this.onOnlineRestoredCallback(machineId);
          }
        }
      } catch (error) {
        logger.error('Erreur vérification heartbeat:', error);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Démarre la synchronisation automatique
   */
  private startAutoSync(): void {
    logger.info('Démarrage de la synchronisation automatique', {
      interval: this.config.autoSyncInterval
    });

    this.autoSyncInterval = setInterval(async () => {
      try {
        await this.performAutoSync();
      } catch (error) {
        logger.error('Erreur synchronisation automatique:', error);
      }
    }, this.config.autoSyncInterval);
  }

  /**
   * Effectue la synchronisation automatique
   */
  private async performAutoSync(): Promise<void> {
    logger.info('Exécution de la synchronisation automatique');

    // Vérifier les machines offline
    if (this.state.offlineMachines.length > 0) {
      logger.warn(`Machines offline détectées: ${this.state.offlineMachines.join(', ')}`);
    }

    // Vérifier les machines en avertissement
    if (this.state.warningMachines.length > 0) {
      logger.warn(`Machines en avertissement: ${this.state.warningMachines.join(', ')}`);
    }
  }

  /**
   * Arrête le service de heartbeat
   */
  public async stopHeartbeatService(): Promise<void> {
    logger.info('Arrêt du service de heartbeat');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.heartbeatCheckerInterval) {
      clearInterval(this.heartbeatCheckerInterval);
      this.heartbeatCheckerInterval = null;
    }

    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }

    await this.saveState();
  }

  /**
   * Obtient les données de heartbeat d'une machine
   */
  public getHeartbeatData(machineId: string): HeartbeatData | undefined {
    return this.state.heartbeats.get(machineId.toLowerCase());
  }

  /**
   * Obtient toutes les machines online
   */
  public getOnlineMachines(): string[] {
    return [...this.state.onlineMachines];
  }

  /**
   * Obtient toutes les machines offline
   */
  public getOfflineMachines(): string[] {
    return [...this.state.offlineMachines];
  }

  /**
   * Obtient toutes les machines en avertissement
   */
  public getWarningMachines(): string[] {
    return [...this.state.warningMachines];
  }

  /**
   * Obtient l'état complet du service
   */
  public getState(): HeartbeatServiceState {
    return {
      heartbeats: new Map(this.state.heartbeats),
      onlineMachines: [...this.state.onlineMachines],
      offlineMachines: [...this.state.offlineMachines],
      warningMachines: [...this.state.warningMachines],
      statistics: { ...this.state.statistics }
    };
  }

  /**
   * Met à jour la configuration du service
   */
  public async updateConfig(config: Partial<HeartbeatConfig>): Promise<void> {
    this.config = { ...this.config, ...config };

    logger.info('Configuration mise à jour', {
      heartbeatInterval: this.config.heartbeatInterval,
      offlineTimeout: this.config.offlineTimeout,
      autoSyncEnabled: this.config.autoSyncEnabled
    });

    // Redémarrer les intervalles si nécessaire
    if (this.heartbeatInterval || this.autoSyncInterval) {
      await this.stopHeartbeatService();
      // Note: Le redémarrage nécessite d'appeler startHeartbeatService
    }

    await this.saveState();
  }

  /**
   * Supprime une machine du service de heartbeat
   */
  public async removeMachine(machineId: string): Promise<void> {
    this.state.heartbeats.delete(machineId.toLowerCase());
    this.updateMachineStatus();
    await this.removeMachineFile(machineId);

    logger.info(`Machine supprimée du service heartbeat: ${machineId}`);
  }

  /**
   * Nettoie les machines offline depuis longtemps
   */
  public async cleanupOldOfflineMachines(maxAge: number = 86400000): Promise<number> {
    // maxAge par défaut: 24 heures
    const now = Date.now();
    const removedMachines: string[] = [];

    for (const [machineId, heartbeatData] of this.state.heartbeats.entries()) {
      if (heartbeatData.offlineSince) {
        const offlineAge = now - new Date(heartbeatData.offlineSince).getTime();

        if (offlineAge > maxAge) {
          this.state.heartbeats.delete(machineId);
          removedMachines.push(machineId);

          logger.info(`Machine offline supprimée: ${machineId}`, {
            offlineAge,
            maxAge
          });
        }
      }
    }

    if (removedMachines.length > 0) {
      this.updateMachineStatus();
      for (const machineId of removedMachines) {
        await this.removeMachineFile(machineId);
      }
    }

    return removedMachines.length;
  }
}
