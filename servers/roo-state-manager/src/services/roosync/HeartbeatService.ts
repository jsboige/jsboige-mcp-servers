/**
 * Service de Heartbeat pour RooSync
 * 
 * Responsable de la gestion des heartbeats entre agents,
 * la détection des machines offline et la synchronisation automatique.
 * 
 * @module HeartbeatService
 * @version 3.0.0
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HeartbeatService');

/**
 * Configuration du heartbeat
 */
export interface HeartbeatConfig {
  /** Intervalle de heartbeat en millisecondes (défaut: 30s) */
  heartbeatInterval: number;
  
  /** Timeout avant de considérer une machine offline en millisecondes (défaut: 2min) */
  offlineTimeout: number;
  
  /** Nombre de heartbeats manqués avant alerte */
  missedHeartbeatThreshold: number;
  
  /** Activer la synchronisation automatique */
  autoSyncEnabled: boolean;
  
  /** Intervalle de synchronisation automatique en millisecondes */
  autoSyncInterval: number;
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
 */
export class HeartbeatService {
  private heartbeatPath: string;
  private state: HeartbeatServiceState;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private autoSyncInterval: NodeJS.Timeout | null = null;
  private heartbeatCheckerInterval: NodeJS.Timeout | null = null;
  private config: HeartbeatConfig;
  private onOfflineDetectedCallback?: (machineId: string) => void;
  private onOnlineRestoredCallback?: (machineId: string) => void;
  
  constructor(
    private sharedPath: string,
    config?: Partial<HeartbeatConfig>
  ) {
    this.heartbeatPath = join(sharedPath, 'heartbeat.json');
    
    // Configuration par défaut
    this.config = {
      heartbeatInterval: 30000, // 30 secondes
      offlineTimeout: 120000, // 2 minutes
      missedHeartbeatThreshold: 4, // 4 heartbeats manqués
      autoSyncEnabled: true,
      autoSyncInterval: 60000, // 1 minute
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
   * Charge l'état du service depuis le disque (synchrone)
   */
  private loadState(): void {
    try {
      if (existsSync(this.heartbeatPath)) {
        const content = readFileSync(this.heartbeatPath, 'utf-8');
        const data = JSON.parse(content);
        
        // Reconstruire la Map depuis les données JSON
        this.state.heartbeats = new Map(
          Object.entries(data.heartbeats || {})
        );
        
        // Recalculer les listes de machines à partir des données de heartbeat
        // Cela permet aux tests de modifier directement le fichier heartbeat.json
        // et d'avoir les listes correctement mises à jour
        this.updateMachineStatus();
        
        // Mettre à jour les statistiques
        this.state.statistics = data.statistics || this.state.statistics;
        
        logger.info('État du service chargé', {
          totalMachines: this.state.heartbeats.size,
          online: this.state.onlineMachines.length,
          offline: this.state.offlineMachines.length,
          warning: this.state.warningMachines.length
        });
      }
    } catch (error) {
      logger.error('Erreur chargement état', error);
      // Continuer avec un état vide
      this.state.heartbeats = new Map();
      this.updateMachineStatus();
    }
  }
  
  /**
   * Sauvegarde l'état du service sur le disque
   */
  private async saveState(): Promise<void> {
    try {
      const data = {
        heartbeats: Object.fromEntries(this.state.heartbeats),
        onlineMachines: this.state.onlineMachines,
        offlineMachines: this.state.offlineMachines,
        warningMachines: this.state.warningMachines,
        statistics: this.state.statistics
      };
      
      await fs.writeFile(this.heartbeatPath, JSON.stringify(data, null, 2));
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
    const now = new Date().toISOString();
    
    let heartbeatData = this.state.heartbeats.get(machineId);
    
    if (!heartbeatData) {
      // Nouvelle machine
      heartbeatData = {
        machineId,
        lastHeartbeat: now,
        status: 'online',
        missedHeartbeats: 0,
        metadata: {
          firstSeen: now,
          lastUpdated: now,
          version: '3.0.0'
        }
      };
      
      logger.info(`Nouvelle machine enregistrée: ${machineId}`);
    } else {
      // Mise à jour heartbeat existant
      heartbeatData.lastHeartbeat = now;
      heartbeatData.status = 'online';
      heartbeatData.missedHeartbeats = 0;
      heartbeatData.offlineSince = undefined;
      heartbeatData.metadata.lastUpdated = now;
      
      // Si la machine était offline, logger le retour online
      if (heartbeatData.offlineSince) {
        logger.info(`Machine redevenue online: ${machineId}`, {
          offlineDuration: Date.now() - new Date(heartbeatData.offlineSince).getTime()
        });
      }
    }
    
    this.state.heartbeats.set(machineId, heartbeatData);
    this.updateMachineStatus();
    await this.saveState();
  }
  
  /**
   * Vérifie les heartbeats et détecte les machines offline
   */
  public async checkHeartbeats(): Promise<HeartbeatCheckResult> {
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
    await this.saveState();
    
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
      
      // Ici, on pourrait implémenter la logique de synchronisation
      // avec les services RooSync existants
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
    return this.state.heartbeats.get(machineId);
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
    this.state.heartbeats.delete(machineId);
    this.updateMachineStatus();
    await this.saveState();
    
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
      await this.saveState();
    }
    
    return removedMachines.length;
  }
}
