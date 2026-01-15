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
import { loadRooSyncConfig, RooSyncConfig, validateMachineIdUniqueness, registerMachineId } from '../config/roosync-config.js';
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
import { PresenceManager } from './roosync/PresenceManager.js';
import { IdentityManager } from './roosync/IdentityManager.js';
import { NonNominativeBaselineService } from './roosync/NonNominativeBaselineService.js';

// Re-export des types pour compatibilité
export type { DecisionExecutionResult, RollbackRestoreResult };

/**
 * Options de cache pour RooSyncService
 */
export interface CacheOptions {
  /** Durée de vie du cache en millisecondes (défaut: 300000 = 5min) */
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
  private presenceManager: PresenceManager;
  private identityManager: IdentityManager;
  private nonNominativeBaselineService: NonNominativeBaselineService;

  /**
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
 
       // Validation d'unicité au démarrage du service (non bloquant)
       this.validateServiceStartup().catch(error => {
         console.error('[RooSyncService] Erreur validation démarrage (non bloquant):', error);
       });
      this.cache = new Map();
      this.cacheOptions = {
        ttl: cacheOptions?.ttl ?? 300000, // 5 minutes par défaut (T2.6)
        enabled: cacheOptions?.enabled ?? true
      };
      this.powershellExecutor = new PowerShellExecutor({
        roosyncBasePath: process.env.ROOSYNC_SHARED_PATH
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
      this.presenceManager = new PresenceManager(this.config);
      this.identityManager = new IdentityManager(this.config, this.presenceManager);
      this.nonNominativeBaselineService = new NonNominativeBaselineService(this.config.sharedPath);

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
   * Validation d'unicité au démarrage du service RooSync
   */
  private async validateServiceStartup(): Promise<void> {
    try {
      console.log(`[RooSyncService] Validation d'unicité pour machineId: ${this.config.machineId}`);
      
      // Valider l'unicité du machineId
      const uniquenessValidation = await validateMachineIdUniqueness(
        this.config.machineId,
        this.config.sharedPath
      );
      
      if (uniquenessValidation.conflictDetected) {
        console.error(`[RooSyncService] ⚠️ CONFLIT D'IDENTITÉ DÉTECTÉ AU DÉMARRAGE:`);
        console.error(`[RooSyncService] MachineId: ${this.config.machineId}`);
        console.error(`[RooSyncService] Conflit avec: ${uniquenessValidation.existingEntry?.source} (première vue: ${uniquenessValidation.existingEntry?.firstSeen})`);
        console.error(`[RooSyncService] ${uniquenessValidation.warningMessage}`);
        
        // Ne pas bloquer le démarrage mais logger clairement le conflit
        console.warn(`[RooSyncService] Le service continue avec un conflit d'identité potentiel. Veuillez résoudre ce conflit manuellement.`);
      } else {
        console.log(`[RooSyncService] ✅ MachineId ${this.config.machineId} validé comme unique`);
        
        // Enregistrer la machine dans le registre
        const registrationSuccess = await registerMachineId(
          this.config.machineId,
          this.config.sharedPath,
          'service'
        );
        
        if (registrationSuccess) {
          console.log(`[RooSyncService] MachineId ${this.config.machineId} enregistré avec succès au démarrage`);
        } else {
          console.warn(`[RooSyncService] Échec d'enregistrement du machineId ${this.config.machineId} au démarrage`);
        }
      }
      
      // Validation supplémentaire des fichiers de présence avec PresenceManager
      await this.validatePresenceFiles();
      
      // Mettre à jour la présence de la machine courante
      const presenceUpdate = await this.presenceManager.updateCurrentPresence('online', 'code');
      if (!presenceUpdate.success) {
        console.warn(`[RooSyncService] Échec mise à jour présence: ${presenceUpdate.warningMessage}`);
        if (presenceUpdate.conflictDetected) {
          console.error(`[RooSyncService] Conflit de présence détecté: ${presenceUpdate.warningMessage}`);
        }
      }

      // Synchroniser le registre d'identité central
      try {
        await this.identityManager.syncIdentityRegistry();
      } catch (error) {
        console.warn('[RooSyncService] Erreur synchronisation registre d\'identité (non bloquant):', error);
      }
      
    } catch (error) {
      console.error('[RooSyncService] Erreur lors validation démarrage:', error);
      // Continuer le démarrage même en cas d'erreur de validation
    }
  }

  /**
   * Validation des fichiers de présence pour détecter les conflits avec PresenceManager
   */
  private async validatePresenceFiles(): Promise<void> {
    try {
      console.log(`[RooSyncService] Validation des fichiers de présence avec PresenceManager`);
      
      // Valider l'unicité des fichiers de présence
      const uniquenessValidation = await this.presenceManager.validatePresenceUniqueness();
      
      if (!uniquenessValidation.isValid) {
        console.error(`[RooSyncService] ⚠️ CONFLITS DE PRÉSENCE DÉTECTÉS:`);
        for (const conflict of uniquenessValidation.conflicts) {
          console.error(`[RooSyncService] ${conflict.warningMessage}`);
        }
        console.warn(`[RooSyncService] Des conflits de présence ont été détectés. Veuillez résoudre ces conflits manuellement.`);
      } else {
        console.log(`[RooSyncService] ✅ Aucun conflit de présence détecté`);
      }
      
      // Vérifier le fichier de présence de la machine courante
      const currentPresence = await this.presenceManager.readPresence(this.config.machineId);
      if (currentPresence) {
        if (currentPresence.id !== this.config.machineId) {
          console.warn(`[RooSyncService] ⚠️ INCOHÉRENCE DÉTECTÉE: Le fichier de présence contient l'ID ${currentPresence.id} mais le service utilise ${this.config.machineId}`);
        } else {
          console.log(`[RooSyncService] ✅ Fichier de présence cohérent pour ${this.config.machineId}`);
        }
      } else {
        console.log(`[RooSyncService] Aucun fichier de présence trouvé pour ${this.config.machineId}, création prévue`);
      }
      
    } catch (error) {
      console.warn('[RooSyncService] Erreur validation fichiers de présence:', error);
    }
  }

  /**
   * Obtenir le gestionnaire de présence
   */
  public getPresenceManager(): PresenceManager {
    return this.presenceManager;
  }

  /**
   * Obtenir le gestionnaire d'identité
   */
  public getIdentityManager(): IdentityManager {
    return this.identityManager;
  }

  /**
   * Valider toutes les identités du système
   */
  public async validateAllIdentities(): Promise<{
    isValid: boolean;
    conflicts: Array<{
      machineId: string;
      sources: string[];
      warningMessage: string;
    }>;
    recommendations: string[];
  }> {
    try {
      const validation = await this.identityManager.validateIdentities();
      
      if (!validation.isValid) {
        console.error('[RooSyncService] ⚠️ VALIDATION IDENTITÉS - PROBLÈMES DÉTECTÉS:');
        for (const conflict of validation.conflicts) {
          console.error(`[RooSyncService] ${conflict.warningMessage}`);
        }
        for (const recommendation of validation.recommendations) {
          console.info(`[RooSyncService] 💡 ${recommendation}`);
        }
      } else {
        console.log('[RooSyncService] ✅ VALIDATION IDENTITÉS - Aucun problème détecté');
      }
      
      return validation;
    } catch (error) {
      console.error('[RooSyncService] Erreur validation identités:', error);
      return {
        isValid: false,
        conflicts: [],
        recommendations: ['Erreur lors de la validation des identités']
      };
    }
  }

  /**
   * Nettoyer les identités orphelines ou en conflit
   */
  public async cleanupIdentities(options: {
    removeOrphaned?: boolean;
    resolveConflicts?: boolean;
    dryRun?: boolean;
  } = {}): Promise<{
    removed: string[];
    resolved: string[];
    errors: string[];
  }> {
    try {
      console.log('[RooSyncService] Nettoyage des identités avec options:', options);
      
      const result = await this.identityManager.cleanupIdentities(options);
      
      if (result.removed.length > 0) {
        console.log(`[RooSyncService] ${options.dryRun ? '[DRY RUN] ' : ''}Identités orphelines supprimées: ${result.removed.join(', ')}`);
      }
      
      if (result.resolved.length > 0) {
        console.log(`[RooSyncService] ${options.dryRun ? '[DRY RUN] ' : ''}Conflits d'identité résolus: ${result.resolved.join(', ')}`);
      }
      
      if (result.errors.length > 0) {
        console.error('[RooSyncService] Erreurs lors du nettoyage:', result.errors);
      }
      
      return result;
    } catch (error) {
      console.error('[RooSyncService] Erreur nettoyage identités:', error);
      return {
        removed: [],
        resolved: [],
        errors: [`Erreur nettoyage: ${error instanceof Error ? error.message : String(error)}`]
      };
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
    this.baselineManager = new BaselineManager(this.config, this.baselineService, this.configComparator, this.nonNominativeBaselineService);

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
   * Comparer la configuration avec une autre machine ou la baseline active
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
    // Vérifier si une baseline non-nominative est active
    const activeBaseline = this.nonNominativeBaselineService.getActiveBaseline();
    
    if (activeBaseline && !targetMachineId) {
      console.log('[RooSyncService] Baseline non-nominative détectée, utilisation du mode profils');
      
      // Utiliser le comparateur de profils
      const machineId = this.config.machineId;
      const machineHash = this.nonNominativeBaselineService.generateMachineHash(machineId);
      
      // S'assurer que la machine est mappée
      let mapping = this.nonNominativeBaselineService.getMachineMappings().find(m => m.machineHash === machineHash);
      if (!mapping) {
        // Collecter l'inventaire et mapper si nécessaire
        const inventory = await this.inventoryCollector.collectInventory(machineId);
        if (inventory) {
          // Conversion explicite du type InventoryCollector.MachineInventory vers non-nominative-baseline.MachineInventory
          // Les structures sont compatibles mais les types TypeScript diffèrent légèrement
          const compatibleInventory: any = inventory;
          mapping = await this.nonNominativeBaselineService.mapMachineToBaseline(machineId, compatibleInventory);
        }
      }
      
      if (mapping) {
        // Convertir les déviations en format de différences standard
        const differences = mapping.deviations.map(dev => ({
          field: dev.category,
          localValue: dev.actualValue,
          targetValue: dev.expectedValue,
          description: `Déviation détectée pour ${dev.category} (Sévérité: ${dev.severity})`
        }));
        
        return {
          localMachine: machineId,
          targetMachine: 'Baseline (Profils)',
          differences
        };
      }
    }
    
    // Fallback sur le comparateur legacy
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

  /**
   * Obtient le service de baseline non-nominatif
   */
  public getNonNominativeBaselineService(): NonNominativeBaselineService {
    return this.nonNominativeBaselineService;
  }

  /**
   * Crée une baseline non-nominative par agrégation
   */
  public async createNonNominativeBaseline(
    name: string,
    description: string,
    aggregationConfig?: any
  ): Promise<any> {
    const baseline = await this.baselineManager.createNonNominativeBaseline(name, description, aggregationConfig);
    // Rafraîchir l'état local après création
    this.nonNominativeBaselineService.getState();
    return baseline;
  }

  /**
   * Mappe une machine à la baseline non-nominative
   */
  public async mapMachineToNonNominativeBaseline(machineId: string): Promise<any> {
    const mapping = await this.baselineManager.mapMachineToNonNominativeBaseline(machineId);
    // Rafraîchir l'état local après mapping
    this.nonNominativeBaselineService.getState();
    return mapping;
  }

  /**
   * Mise à jour de la baseline avec support du mode 'profile'
   */
  public async updateBaseline(
    machineId: string,
    options: {
      mode?: 'profile' | 'legacy';
      version?: string;
      createBackup?: boolean;
      updateReason?: string;
      updatedBy?: string;
    } = {}
  ): Promise<boolean> {
    const mode = options.mode || 'profile';

    if (mode === 'profile') {
      console.log(`[RooSyncService] Mise à jour baseline en mode 'profile' depuis ${machineId}`);
      
      // Collecter l'inventaire
      const inventory = await this.inventoryCollector.collectInventory(machineId, true);
      if (!inventory) {
        throw new RooSyncServiceError('Impossible de collecter l\'inventaire', 'INVENTORY_FAILED');
      }

      // Utiliser l'agrégation pour mettre à jour les profils
      // Note: Dans une implémentation complète, on fusionnerait intelligemment
      // Pour l'instant, on recrée une baseline agrégée basée sur cette machine (et potentiellement d'autres)
      const compatibleInventory: any = inventory;
      
      // Récupérer les autres inventaires disponibles pour une meilleure agrégation
      const inventories = [compatibleInventory];
      
      // Créer la baseline via le BaselineManager
      await this.baselineManager.createNonNominativeBaseline(
        `Baseline ${options.version || 'Auto'}`,
        options.updateReason || `Mise à jour depuis ${machineId}`,
        undefined // Config par défaut
      );
      
      return true;
    } else {
      // Mode legacy : délégation au service existant (via ConfigService/BaselineService qui n'est pas exposé directement ici pour update)
      // On doit utiliser BaselineService.updateBaseline
      console.log(`[RooSyncService] Mise à jour baseline en mode 'legacy' depuis ${machineId}`);
      
      const inventory = await this.inventoryCollector.collectInventory(machineId, true);
      if (!inventory) {
        throw new RooSyncServiceError('Impossible de collecter l\'inventaire', 'INVENTORY_FAILED');
      }

      // Créer la structure baseline legacy
      // Conversion explicite pour accéder à la config
      const legacyInventory: any = inventory;
      
      const newBaseline = {
        machineId,
        version: options.version || '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
            roo: legacyInventory.roo || {},
            hardware: legacyInventory.hardware || {},
            software: legacyInventory.software || {},
            system: legacyInventory.system || {}
        }
      };

      return await this.baselineService.updateBaseline(newBaseline as any, {
        createBackup: options.createBackup,
        updateReason: options.updateReason,
        updatedBy: options.updatedBy
      });
    }
  }

  /**
   * Compare plusieurs machines avec la baseline non-nominative
   */
  public async compareMachinesNonNominative(machineIds: string[]): Promise<any> {
    return await this.baselineManager.compareMachinesNonNominative(machineIds);
  }

  /**
   * Migre vers le système non-nominatif
   */
  public async migrateToNonNominative(options?: any): Promise<any> {
    const result = await this.baselineManager.migrateToNonNominative(options);
    // Rafraîchir l'état local après migration
    this.nonNominativeBaselineService.getState();
    return result;
  }

  /**
   * Obtient l'état du système non-nominatif
   */
  public getNonNominativeState(): any {
    return this.baselineManager.getNonNominativeState();
  }

  /**
   * Obtient la baseline non-nominative active
   */
  public getActiveNonNominativeBaseline(): any {
    return this.baselineManager.getActiveNonNominativeBaseline();
  }

  /**
   * Obtient tous les mappings de machines non-nominatives
   */
  public getNonNominativeMachineMappings(): any[] {
    return this.baselineManager.getNonNominativeMachineMappings();
  }
}

/**
 * Helper pour obtenir l'instance du service
 */
export function getRooSyncService(): RooSyncService {
  return RooSyncService.getInstance();
}
