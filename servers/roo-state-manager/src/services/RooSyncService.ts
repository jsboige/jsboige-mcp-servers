/**
 * Service RooSync pour roo-state-manager
 *
 * Service Singleton qui gère l'interaction avec les fichiers RooSync,
 * le cache, et fournit une API unifiée pour les outils MCP.
 *
 * @module RooSyncService
 * @version 2.0.0
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadRooSyncConfig, RooSyncConfig } from '../config/roosync-config.js';
import {
  type RooSyncDecision,
  type RooSyncDashboard
} from '../utils/roosync-parsers.js';
import { PowerShellExecutor } from './PowerShellExecutor.js';
import { InventoryCollector, type MachineInventory } from './InventoryCollector.js';
import { DiffDetector } from './DiffDetector.js';
import { BaselineService } from './BaselineService.js';
import { ConfigService } from './ConfigService.js';
import { InventoryCollectorWrapper } from './InventoryCollectorWrapper.js';
import { ConfigSharingService } from './ConfigSharingService.js';

// Nouveaux modules
import { SyncDecisionManager, DecisionExecutionResult } from './roosync/SyncDecisionManager.js';
import { ConfigComparator } from './roosync/ConfigComparator.js';
import { BaselineManager, RollbackRestoreResult } from './roosync/BaselineManager.js';
import { MessageHandler } from './roosync/MessageHandler.js';

// Re-export des types pour compatibilité
export type { DecisionExecutionResult, RollbackRestoreResult };

/**
 * Options de cache pour RooSyncService
 */
export interface CacheOptions {
  /** Durée de vie du cache en millisecondes (défaut: 30000 = 30s) */
  ttl?: number;

  /** Activer/désactiver le cache */
  enabled?: boolean;
}

/**
 * Entrée de cache
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Erreur du service RooSync
 */
export class RooSyncServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[RooSync Service] ${message}`);
    this.name = 'RooSyncServiceError';
  }
}

/**
 * Service Singleton pour gérer RooSync
 */
export class RooSyncService {
  private static instance: RooSyncService | null = null;

  private config: RooSyncConfig;
  private cache: Map<string, CacheEntry<any>>;
  private cacheOptions: Required<CacheOptions>;
  private powershellExecutor: PowerShellExecutor;
  private inventoryCollector: InventoryCollector;
  private diffDetector: DiffDetector;
  private baselineService: BaselineService;
  private configService: ConfigService;
  private configSharingService: ConfigSharingService;

  // Modules délégués
  private syncDecisionManager: SyncDecisionManager;
  private configComparator: ConfigComparator;
  private baselineManager: BaselineManager;
  private messageHandler: MessageHandler;

  /**
   * Constructeur privé (Singleton)
   */
  private constructor(cacheOptions?: CacheOptions, config?: RooSyncConfig) {
    // SDDD Debug: Logging direct dans fichier pour contourner le problème de visibilité
    const debugLog = (message: string, data?: any) => {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ''}\n`;

      // Écrire directement dans un fichier de log
      try {
        const fs = require('fs');
        const logPath = process.env.ROOSYNC_LOG_PATH || join(process.cwd(), 'debug-roosync-compare.log');
        fs.appendFileSync(logPath, logEntry);
      } catch (e) {
        // Ignorer les erreurs de logging
      }
    };

    debugLog('RooSyncService constructeur démarré');

    try {
      this.config = config || loadRooSyncConfig();
      console.log('[DEBUG] RooSyncService config loaded:', this.config);
      debugLog('Config chargée', { configLoaded: !!this.config });

      this.cache = new Map();
      this.cacheOptions = {
        ttl: cacheOptions?.ttl ?? 30000, // 30 secondes par défaut
        enabled: cacheOptions?.enabled ?? true
      };
      this.powershellExecutor = new PowerShellExecutor({
        roosyncBasePath: process.env.ROOSYNC_SHARED_PATH || process.env.SHARED_STATE_PATH || join(process.env.ROO_ROOT || process.cwd(), 'RooSync')
      });
      this.inventoryCollector = new InventoryCollector();
      this.diffDetector = new DiffDetector();
      this.configService = new ConfigService(this.config.sharedPath);

      debugLog('Services créés', {
        configService: !!this.configService,
        inventoryCollector: !!this.inventoryCollector,
        diffDetector: !!this.diffDetector
      });

      // Initialiser le BaselineService avec les wrappers nécessaires
      const inventoryWrapper = new InventoryCollectorWrapper(this.inventoryCollector);
      debugLog('InventoryWrapper créé', { inventoryWrapper: !!inventoryWrapper });

      debugLog('Avant instanciation BaselineService');
      this.baselineService = new BaselineService(
        this.configService,
        inventoryWrapper,
        this.diffDetector
      );
      debugLog('Après instanciation BaselineService', {
        baselineService: !!this.baselineService,
        error: null
      });

      this.configSharingService = new ConfigSharingService(
        this.configService,
        this.inventoryCollector as any
      );

      // Initialisation des nouveaux modules
      this.syncDecisionManager = new SyncDecisionManager(this.config, this.powershellExecutor);
      this.configComparator = new ConfigComparator(this.config, this.baselineService);
      this.baselineManager = new BaselineManager(this.config, this.baselineService, this.configComparator);
      this.messageHandler = new MessageHandler(this.config);

    } catch (error) {
      debugLog('ERREUR dans constructeur RooSyncService', {
        errorType: typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : null,
        errorName: error instanceof Error ? error.name : null
      });

      // S'assurer que l'instance n'est pas créée en cas d'erreur
      RooSyncService.instance = null;

      throw error;
    }
  }

  /**
   * Obtenir l'instance du service (Singleton)
   *
   * @param cacheOptions Options de cache (utilisées seulement à la première création)
   * @param config Configuration optionnelle (pour injection de dépendance/tests)
   * @returns Instance du service
   */
  public static getInstance(cacheOptions?: CacheOptions, config?: RooSyncConfig): RooSyncService {
    console.log('[DEBUG] getInstance() appelé, instance existe:', !!RooSyncService.instance);
    if (!RooSyncService.instance) {
      console.log('[DEBUG] Création nouvelle instance RooSyncService...');
      try {
        RooSyncService.instance = new RooSyncService(cacheOptions, config);
        console.log('[DEBUG] Instance RooSyncService créée avec succès. Config sharedPath:', RooSyncService.instance.config.sharedPath);
      } catch (error) {
        console.error('[DEBUG] Erreur lors création instance RooSyncService:', error);
        throw error;
      }
    }
    return RooSyncService.instance;
  }

  /**
   * Réinitialiser l'instance (utile pour les tests)
   */
  public static resetInstance(): void {
    RooSyncService.instance = null;
  }

  /**
   * Obtenir la configuration RooSync
   */
  public getConfig(): RooSyncConfig {
    return this.config;
  }

  /**
   * Obtenir le service de configuration
   */
  public getConfigService(): ConfigService {
    return this.configService;
  }

  /**
   * Obtenir le collecteur d'inventaire
   */
  public getInventoryCollector(): InventoryCollector {
    return this.inventoryCollector;
  }

  /**
   * Obtenir le service de partage de configuration
   */
  public getConfigSharingService(): ConfigSharingService {
    return this.configSharingService;
  }

  /**
   * Vider le cache
   */
  public clearCache(): void {
    console.log('[RooSyncService] clearCache - Vidage du cache interne');
    this.cache.clear();

    // Réinitialiser complètement les services pour forcer la relecture
    console.log('[RooSyncService] clearCache - Réinitialisation des services dépendants');

    // Recréer le BaselineService pour éviter les caches persistants
    const inventoryWrapper = new InventoryCollectorWrapper(this.inventoryCollector);
    console.log('[DEBUG] RooSyncService: Avant instanciation BaselineService (ligne 181)');
    console.log('[DEBUG] configService disponible:', !!this.configService);
    console.log('[DEBUG] inventoryWrapper disponible:', !!inventoryWrapper);
    console.log('[DEBUG] diffDetector disponible:', !!this.diffDetector);
    this.baselineService = new BaselineService(
      this.configService,
      inventoryWrapper,
      this.diffDetector
    );

    // Mettre à jour les références dans les modules
    this.configComparator = new ConfigComparator(this.config, this.baselineService);
    this.baselineManager = new BaselineManager(this.config, this.baselineService, this.configComparator);

    // Vider le cache de l'InventoryCollector aussi
    this.inventoryCollector.clearCache();

    console.log('[RooSyncService] clearCache - Services réinitialisés avec succès');
  }

  /**
   * Récupérer depuis le cache ou exécuter la fonction
   */
  private async getOrCache<T>(
    key: string,
    fetchFn: () => T | Promise<T>
  ): Promise<T> {
    if (!this.cacheOptions.enabled) {
      return fetchFn();
    }

    // Vérifier le cache
    const cached = this.cache.get(key);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.cacheOptions.ttl) {
        return cached.data as T;
      }
      // Cache expiré
      this.cache.delete(key);
    }

    // Fetch et mise en cache
    const data = await fetchFn();
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    return data;
  }

  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }

  /**
   * Vérifier si un fichier RooSync existe
   */
  private checkFileExists(filename: string): void {
    const filePath = this.getRooSyncFilePath(filename);
    if (!existsSync(filePath)) {
      throw new RooSyncServiceError(
        `Fichier RooSync introuvable: ${filename}`,
        'FILE_NOT_FOUND'
      );
    }
  }

  /**
   * Charger le dashboard RooSync
   */
  public async loadDashboard(): Promise<RooSyncDashboard> {
    return this.baselineManager.loadDashboard(this.getOrCache.bind(this));
  }

  /**
   * Charger toutes les décisions de la roadmap
   */
  public async loadDecisions(): Promise<RooSyncDecision[]> {
    return this.getOrCache('decisions', () => this.syncDecisionManager.loadDecisions());
  }

  /**
   * Charger les décisions en attente pour cette machine
   */
  public async loadPendingDecisions(): Promise<RooSyncDecision[]> {
    return this.syncDecisionManager.loadPendingDecisions();
  }

  /**
   * Obtenir une décision par ID
   */
  public async getDecision(id: string): Promise<RooSyncDecision | null> {
    return this.syncDecisionManager.getDecision(id);
  }

  /**
   * Obtenir l'état de synchronisation global
   */
  public async getStatus(): Promise<{
    machineId: string;
    overallStatus: string;
    lastSync: string | null;
    pendingDecisions: number;
    diffsCount: number;
  }> {
    return this.baselineManager.getStatus(() => this.loadDashboard());
  }

  /**
   * Comparer la configuration avec une autre machine
   */
  public async compareConfig(targetMachineId?: string): Promise<{
    localMachine: string;
    targetMachine: string;
    differences: {
      field: string;
      localValue: any;
      targetValue: any;
    }[];
  }> {
    return this.configComparator.compareConfig(() => this.loadDashboard(), targetMachineId);
  }

  /**
   * Lister les différences détectées
   */
  public async listDiffs(filterByType?: 'all' | 'config' | 'files' | 'settings'): Promise<{
    totalDiffs: number;
    diffs: {
      type: string;
      path: string;
      description: string;
      machines: string[];
    }[];
  }> {
    return this.configComparator.listDiffs(filterByType);
  }

  /**
   * Exécute une décision de synchronisation via PowerShell
   */
  public async executeDecision(
    decisionId: string,
    options?: { dryRun?: boolean; force?: boolean }
  ): Promise<DecisionExecutionResult> {
    const result = await this.syncDecisionManager.executeDecision(decisionId, options);
    if (result.success) {
      this.clearCache();
    }
    return result;
  }

  /**
   * Crée un point de rollback pour une décision
   */
  public async createRollbackPoint(decisionId: string): Promise<void> {
    return this.baselineManager.createRollbackPoint(decisionId);
  }

  /**
   * Restaure depuis un point de rollback
   */
  public async restoreFromRollbackPoint(decisionId: string): Promise<RollbackRestoreResult> {
    return this.baselineManager.restoreFromRollbackPoint(decisionId, () => this.clearCache());
  }

  /**
   * Collecte l'inventaire d'une machine
   */
  async getInventory(machineId: string, forceRefresh = false): Promise<MachineInventory | null> {
    return this.inventoryCollector.collectInventory(machineId, forceRefresh);
  }

  /**
   * Compare 2 machines et génère un rapport de différences réelles
   */
  async compareRealConfigurations(
    sourceMachineId: string,
    targetMachineId: string,
    forceRefresh = false
  ): Promise<any | null> {
    return this.configComparator.compareRealConfigurations(sourceMachineId, targetMachineId, forceRefresh);
  }

  /**
   * Génère des décisions RooSync depuis un rapport de comparaison
   */
  async generateDecisionsFromReport(report: any): Promise<number> {
    return this.syncDecisionManager.generateDecisionsFromReport(report);
  }
}

/**
 * Helper pour obtenir l'instance du service
 */
export function getRooSyncService(): RooSyncService {
  return RooSyncService.getInstance();
}
