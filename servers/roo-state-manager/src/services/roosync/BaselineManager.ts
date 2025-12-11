/**
 * Gestionnaire de Baseline RooSync
 *
 * Responsable de la gestion des baselines et du dashboard :
 * - Chargement/Calcul du dashboard
 * - Gestion des rollbacks
 * - État de synchronisation
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../RooSyncService.js';
import { RooSyncDashboard } from '../../utils/roosync-parsers.js';
import { BaselineService } from '../BaselineService.js';
import { ConfigComparator } from './ConfigComparator.js';
import { NonNominativeBaselineService } from './NonNominativeBaselineService.js';
import { NonNominativeBaseline, MachineConfigurationMapping, NonNominativeComparisonReport, AggregationConfig, MigrationOptions } from '../../types/non-nominative-baseline.js';

/**
 * Registre central des machines pour éviter les conflits d'identité
 */
interface MachineRegistry {
  /** Map des machineId vers leurs métadonnées */
  machines: Map<string, {
    machineId: string;
    firstSeen: string;
    lastSeen: string;
    source: 'dashboard' | 'presence' | 'baseline' | 'config';
    status: 'online' | 'offline' | 'conflict';
  }>;
  
  /** Fichier de sauvegarde du registre */
  registryPath: string;
}

/**
 * État de validation d'unicité
 */
interface UniquenessValidationResult {
  isValid: boolean;
  conflictDetected: boolean;
  conflictingMachineId?: string;
  conflictSource?: string;
  warningMessage?: string;
}

/**
 * Résultat de restauration rollback
 */
export interface RollbackRestoreResult {
  /** Succès de la restauration */
  success: boolean;

  /** Fichiers restaurés */
  restoredFiles: string[];

  /** Logs de restauration */
  logs: string[];

  /** Message d'erreur si échec */
  error?: string;
}

export class BaselineManager {
  private machineRegistry: MachineRegistry;

  constructor(
    private config: RooSyncConfig,
    private baselineService: BaselineService,
    private configComparator: ConfigComparator,
    private nonNominativeService?: NonNominativeBaselineService
  ) {
    // Initialiser le registre central des machines
    this.machineRegistry = {
      machines: new Map(),
      registryPath: join(this.config.sharedPath, '.machine-registry.json')
    };
    
    // Initialiser le service non-nominatif si non fourni
    if (!this.nonNominativeService) {
      this.nonNominativeService = new NonNominativeBaselineService(this.config.sharedPath);
    }
    
    // Charger le registre existant s'il y en a un
    this.loadMachineRegistry();
  }

  /**
   * Charger le registre des machines depuis le disque
   */
  private loadMachineRegistry(): void {
    try {
      if (existsSync(this.machineRegistry.registryPath)) {
        const registryContent = readFileSync(this.machineRegistry.registryPath, 'utf-8');
        const registryData = JSON.parse(registryContent);
        
        // Reconstruire la Map depuis les données JSON
        this.machineRegistry.machines = new Map(
          Object.entries(registryData.machines || {})
        );
        
        console.log(`[BaselineManager] Registre des machines chargé: ${this.machineRegistry.machines.size} machines`);
      }
    } catch (error) {
      console.warn('[BaselineManager] Erreur chargement registre des machines:', error);
      // Continuer avec un registre vide
      this.machineRegistry.machines = new Map();
    }
  }

  /**
   * Sauvegarder le registre des machines sur le disque
   */
  private async saveMachineRegistry(): Promise<void> {
    try {
      const registryData = {
        machines: Object.fromEntries(this.machineRegistry.machines),
        lastUpdated: new Date().toISOString()
      };
      
      await fs.writeFile(
        this.machineRegistry.registryPath,
        JSON.stringify(registryData, null, 2),
        'utf-8'
      );
      
      console.log('[BaselineManager] Registre des machines sauvegardé');
    } catch (error) {
      console.error('[BaselineManager] Erreur sauvegarde registre des machines:', error);
    }
  }

  /**
   * Valider l'unicité d'un machineId avant ajout
   */
  private validateMachineUniqueness(machineId: string, source: string): UniquenessValidationResult {
    const existingMachine = this.machineRegistry.machines.get(machineId);
    
    if (!existingMachine) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Vérifier si c'est la même source (mise à jour normale)
    if (existingMachine.source === source) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Conflit détecté : même machineId depuis des sources différentes
    const warningMessage = `⚠️ CONFLIT D'IDENTITÉ DÉTECTÉ: MachineId "${machineId}" déjà utilisé par la source "${existingMachine.source}" (première vue: ${existingMachine.firstSeen}). Tentative d'ajout depuis la source "${source}".`;
    
    console.warn(warningMessage);
    
    return {
      isValid: false,
      conflictDetected: true,
      conflictingMachineId: machineId,
      conflictSource: existingMachine.source,
      warningMessage
    };
  }

  /**
   * Ajouter une machine au registre avec validation d'unicité
   */
  private async addMachineToRegistry(
    machineId: string,
    source: 'dashboard' | 'presence' | 'baseline' | 'config',
    status: 'online' | 'offline' | 'conflict' = 'online'
  ): Promise<UniquenessValidationResult> {
    const validation = this.validateMachineUniqueness(machineId, source);
    
    if (!validation.isValid) {
      // Ne pas ajouter la machine en conflit, mais logger l'avertissement
      console.error(`[BaselineManager] REFUS D'AJOUT: ${validation.warningMessage}`);
      return validation;
    }

    const now = new Date().toISOString();
    const existingMachine = this.machineRegistry.machines.get(machineId);
    
    if (existingMachine) {
      // Mise à jour d'une machine existante
      existingMachine.lastSeen = now;
      existingMachine.status = status;
      console.log(`[BaselineManager] Machine ${machineId} mise à jour dans le registre`);
    } else {
      // Nouvelle machine
      this.machineRegistry.machines.set(machineId, {
        machineId,
        firstSeen: now,
        lastSeen: now,
        source,
        status
      });
      console.log(`[BaselineManager] Nouvelle machine ${machineId} ajoutée au registre depuis la source ${source}`);
    }

    // Sauvegarder le registre
    await this.saveMachineRegistry();
    
    return validation;
  }

  /**
   * Vérifier si une machine existe dans le registre
   */
  private machineExistsInRegistry(machineId: string): boolean {
    return this.machineRegistry.machines.has(machineId);
  }

  /**
   * Obtenir les informations d'une machine depuis le registre
   */
  private getMachineFromRegistry(machineId: string) {
    return this.machineRegistry.machines.get(machineId);
  }

  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }

  /**
   * Charger le dashboard RooSync
   */
  public async loadDashboard(
    cacheCallback: (key: string, fetchFn: () => Promise<RooSyncDashboard>) => Promise<RooSyncDashboard>
  ): Promise<RooSyncDashboard> {
    return cacheCallback('dashboard', async () => {
      console.log('[BaselineManager] loadDashboard appelée à', new Date().toISOString());

      // Vérifier d'abord si le dashboard existe déjà
      const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');
      if (existsSync(dashboardPath)) {
        console.log('[BaselineManager] Dashboard existant trouvé, chargement depuis:', dashboardPath);
        try {
          const dashboardContent = readFileSync(dashboardPath, 'utf-8');
          const dashboard = JSON.parse(dashboardContent);
          console.log('[BaselineManager] Dashboard chargé avec succès depuis le fichier existant');

          // S'assurer que le dashboard a bien la propriété machines
          if (!dashboard.machines) {
            console.log('[BaselineManager] Dashboard existant sans propriété machines, ajout de la machine courante');
            dashboard.machines = {};
          }

          // S'assurer que la machine courante existe dans le dashboard avec validation d'unicité
          if (!dashboard.machines[this.config.machineId]) {
            console.log(`[BaselineManager] Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant`);
            
            // Valider l'unicité avant d'ajouter
            const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');
            
            if (validation.isValid) {
              dashboard.machines[this.config.machineId] = {
                lastSync: new Date().toISOString(),
                status: 'online',
                diffsCount: 0,
                pendingDecisions: 0
              };
              console.log(`[BaselineManager] Machine ${this.config.machineId} ajoutée avec succès au dashboard`);
            } else {
              console.error(`[BaselineManager] ÉCHEC AJOUT DASHBOARD: ${validation.warningMessage}`);
              // Ne pas écraser la machine existante, mais logger le conflit
              if (validation.conflictingMachineId && dashboard.machines[validation.conflictingMachineId]) {
                console.warn(`[BaselineManager] Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard`);
              }
            }
          } else {
            // La machine existe déjà, valider que ce n'est pas un conflit
            const existingMachine = this.getMachineFromRegistry(this.config.machineId);
            if (existingMachine && existingMachine.source !== 'dashboard') {
              console.warn(`[BaselineManager] ATTENTION: Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
            }
          }

          return dashboard as RooSyncDashboard;
        } catch (error) {
          console.warn('[BaselineManager] Erreur lecture dashboard existant, recalcule depuis baseline:', error);
        }
      }

      return this.calculateDashboardFromBaseline();
    });
  }

  /**
   * Calcule le dashboard à partir de la baseline
   */
  private async calculateDashboardFromBaseline(): Promise<RooSyncDashboard> {
    console.log('[BaselineManager] calculateDashboardFromBaseline - début de la méthode');
    const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');

    // S'assurer que la baseline est chargée
    await this.baselineService.loadBaseline();

    // Utiliser ConfigComparator pour obtenir les diffs
    const diffsResult = await this.configComparator.listDiffs('all');
    const totalDiffs = diffsResult.totalDiffs;

    // Récupérer la baseline pour les machines
    const baseline = await this.baselineService.loadBaseline();
    const allMachines = new Set<string>();

    if (baseline) {
      if (baseline.machineId) {
        allMachines.add(baseline.machineId);
      }
      if (this.config.machineId && !allMachines.has(this.config.machineId)) {
        allMachines.add(this.config.machineId);
      }
    }

    const now = new Date().toISOString();

    // Si un dashboard existe déjà, l'utiliser et s'assurer que la machine courante est présente
    if (existsSync(dashboardPath)) {
      try {
        const dashboardContent = readFileSync(dashboardPath, 'utf-8');
        const existingDashboard = JSON.parse(dashboardContent);
        console.log('[BaselineManager] Dashboard existant trouvé, vérification de la machine courante');

        if (!existingDashboard.machines) {
          existingDashboard.machines = {};
        }

        if (!existingDashboard.machines[this.config.machineId]) {
          console.log(`[BaselineManager] Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant (calculateDashboardFromBaseline)`);
          
          // Valider l'unicité avant d'ajouter
          const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');
          
          if (validation.isValid) {
            existingDashboard.machines[this.config.machineId] = {
              lastSync: now,
              status: 'online',
              diffsCount: totalDiffs,
              pendingDecisions: 0
            };
            console.log(`[BaselineManager] Machine ${this.config.machineId} ajoutée avec succès au dashboard (calculateDashboardFromBaseline)`);
          } else {
            console.error(`[BaselineManager] ÉCHEC AJOUT DASHBOARD (calculate): ${validation.warningMessage}`);
            // Ne pas écraser la machine existante, mais logger le conflit
            if (validation.conflictingMachineId && existingDashboard.machines[validation.conflictingMachineId]) {
              console.warn(`[BaselineManager] Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard (calculate)`);
            }
          }
        } else {
          // La machine existe déjà, valider que ce n'est pas un conflit
          const existingMachine = this.getMachineFromRegistry(this.config.machineId);
          if (existingMachine && existingMachine.source !== 'dashboard') {
            console.warn(`[BaselineManager] ATTENTION (calculate): Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
          }
        }

        return existingDashboard as RooSyncDashboard;
      } catch (error) {
        console.warn('[BaselineManager] Erreur lecture dashboard existant, fallback sur calcul:', error);
      }
    }

    // Créer le résultat basé sur les données réelles
    const machinesArray = Array.from(allMachines).map(machineId => ({
      id: machineId,
      status: 'online' as const,
      lastSync: now,
      pendingDecisions: 0,
      diffsCount: totalDiffs
    }));

    const summary = {
      totalMachines: allMachines.size,
      onlineMachines: allMachines.size,
      totalDiffs: totalDiffs,
      totalPendingDecisions: 0
    };

    const result = {
      version: '2.1.0',
      lastUpdate: now,
      overallStatus: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      lastSync: now,
      status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      machines: machinesArray.reduce((acc, machine) => {
        acc[machine.id] = {
          lastSync: machine.lastSync,
          status: machine.status,
          diffsCount: machine.diffsCount,
          pendingDecisions: machine.pendingDecisions
        };
        return acc;
      }, {} as Record<string, any>),
      stats: {
        totalDiffs: totalDiffs,
        totalDecisions: totalDiffs,
        appliedDecisions: 0,
        pendingDecisions: 0
      },
      machinesArray,
      summary
    };

    if (!result.machines) {
      result.machines = {};
    }

    return result as RooSyncDashboard;
  }

  /**
   * Obtenir l'état de synchronisation global
   */
  public async getStatus(
    dashboardLoader: () => Promise<RooSyncDashboard>
  ): Promise<{
    machineId: string;
    overallStatus: string;
    lastSync: string | null;
    pendingDecisions: number;
    diffsCount: number;
  }> {
    const dashboard = await dashboardLoader();

    if (!dashboard || !dashboard.machines) {
      throw new RooSyncServiceError(
        `Dashboard invalide ou sans propriété machines`,
        'INVALID_DASHBOARD'
      );
    }

    const machineInfo = dashboard.machines[this.config.machineId];

    if (!machineInfo) {
      throw new RooSyncServiceError(
        `Machine ${this.config.machineId} non trouvée dans le dashboard`,
        'MACHINE_NOT_FOUND'
      );
    }

    return {
      machineId: this.config.machineId,
      overallStatus: dashboard.overallStatus,
      lastSync: machineInfo.lastSync,
      pendingDecisions: machineInfo.pendingDecisions,
      diffsCount: machineInfo.diffsCount
    };
  }

  /**
   * Crée un point de rollback pour une décision
   */
  public async createRollbackPoint(decisionId: string): Promise<void> {
    try {
      const sharedPath = this.config.sharedPath;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rollbackPath = join(sharedPath, '.rollback', `${decisionId}_${timestamp}`);

      // Créer le répertoire rollback
      await fs.mkdir(rollbackPath, { recursive: true });

      // Backup des fichiers critiques
      const filesToBackup = [
        'sync-config.ref.json',
        'sync-roadmap.md'
      ];

      for (const file of filesToBackup) {
        const sourcePath = this.getRooSyncFilePath(file);
        const targetPath = join(rollbackPath, file);

        if (existsSync(sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
        }
      }

      // Créer metadata
      const metadata = {
        decisionId,
        timestamp,
        machine: this.config.machineId,
        files: filesToBackup
      };

      await fs.writeFile(
        join(rollbackPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );
    } catch (error) {
      throw new RooSyncServiceError(
        `Échec création rollback point: ${error instanceof Error ? error.message : String(error)}`,
        'ROLLBACK_CREATION_FAILED'
      );
    }
  }

  /**
   * Restaure depuis un point de rollback
   */
  public async restoreFromRollbackPoint(
    decisionId: string,
    clearCacheCallback: () => void
  ): Promise<RollbackRestoreResult> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      // Vérifier que le répertoire rollback existe
      if (!existsSync(rollbackDir)) {
        return {
          success: false,
          restoredFiles: [],
          logs: [`Aucun répertoire rollback trouvé dans ${rollbackDir}`],
          error: 'No rollback directory found'
        };
      }

      // Lister les rollbacks pour cette décision
      const allBackups = await fs.readdir(rollbackDir);
      const matchingBackups = allBackups
        .filter(name => name.startsWith(decisionId))
        .sort()
        .reverse(); // Plus récent en premier

      if (matchingBackups.length === 0) {
        return {
          success: false,
          restoredFiles: [],
          logs: [`Aucun rollback trouvé pour la décision ${decisionId}`],
          error: `No rollback found for decision ${decisionId}`
        };
      }

      // Restaurer depuis le plus récent
      const backupPath = join(rollbackDir, matchingBackups[0]);
      const restoredFiles: string[] = [];
      const logs: string[] = [];

      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let filesToRestore: string[] = ['sync-config.ref.json', 'sync-roadmap.md'];

      if (existsSync(metadataPath)) {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        filesToRestore = metadata.files || filesToRestore;
        logs.push(`Rollback depuis ${metadata.timestamp}`);
      }

      // Restaurer les fichiers
      for (const file of filesToRestore) {
        const sourcePath = join(backupPath, file);
        const targetPath = this.getRooSyncFilePath(file);

        if (existsSync(sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
          restoredFiles.push(file);
          logs.push(`Restauré: ${file}`);
        }
      }

      // Invalider le cache
      clearCacheCallback();

      return {
        success: true,
        restoredFiles,
        logs,
      };
    } catch (error) {
      return {
        success: false,
        restoredFiles: [],
        logs: [`Erreur restauration: ${error instanceof Error ? error.message : String(error)}`],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Crée une baseline non-nominative par agrégation
   */
  public async createNonNominativeBaseline(
    name: string,
    description: string,
    aggregationConfig?: AggregationConfig
  ): Promise<NonNominativeBaseline> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'Service non-nominatif non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    // Collecter les inventaires de toutes les machines connues
    const machineIds = Array.from(this.machineRegistry.machines.keys());
    const inventories = [];

    for (const machineId of machineIds) {
      try {
        const inventory = await this.baselineService['inventoryCollector'].collectInventory(machineId);
        if (inventory) {
          inventories.push(inventory);
        }
      } catch (error) {
        console.warn(`[BaselineManager] Impossible de collecter l'inventaire pour ${machineId}:`, error);
      }
    }

    // Configuration d'agrégation par défaut
    const defaultAggregationConfig: AggregationConfig = {
      sources: [
        { type: 'machine_inventory', weight: 1.0, enabled: true },
        { type: 'existing_baseline', weight: 0.5, enabled: true }
      ],
      categoryRules: {
        'roo-core': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true },
        'roo-advanced': { strategy: 'majority', confidenceThreshold: 0.6, autoApply: true },
        'hardware-cpu': { strategy: 'latest', confidenceThreshold: 0.8, autoApply: true },
        'hardware-memory': { strategy: 'latest', confidenceThreshold: 0.8, autoApply: true },
        'hardware-storage': { strategy: 'latest', confidenceThreshold: 0.8, autoApply: true },
        'hardware-gpu': { strategy: 'latest', confidenceThreshold: 0.8, autoApply: true },
        'software-powershell': { strategy: 'majority', confidenceThreshold: 0.9, autoApply: true },
        'software-node': { strategy: 'majority', confidenceThreshold: 0.9, autoApply: true },
        'software-python': { strategy: 'majority', confidenceThreshold: 0.9, autoApply: true },
        'system-os': { strategy: 'majority', confidenceThreshold: 0.8, autoApply: true },
        'system-architecture': { strategy: 'majority', confidenceThreshold: 0.9, autoApply: true }
      },
      thresholds: {
        deviationThreshold: 0.3,
        complianceThreshold: 0.8,
        outlierDetection: true
      }
    };

    const config = aggregationConfig || defaultAggregationConfig;
    return await this.nonNominativeService.aggregateBaseline(inventories, config);
  }

  /**
   * Mappe une machine à la baseline non-nominative
   */
  public async mapMachineToNonNominativeBaseline(
    machineId: string
  ): Promise<MachineConfigurationMapping> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'Service non-nominatif non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    // Collecter l'inventaire de la machine
    const inventory = await this.baselineService['inventoryCollector'].collectInventory(machineId);
    if (!inventory) {
      throw new RooSyncServiceError(
        `Impossible de collecter l'inventaire pour ${machineId}`,
        'INVENTORY_COLLECTION_FAILED'
      );
    }

    return await this.nonNominativeService.mapMachineToBaseline(machineId, inventory);
  }

  /**
   * Compare plusieurs machines avec la baseline non-nominative
   */
  public async compareMachinesNonNominative(
    machineIds: string[]
  ): Promise<NonNominativeComparisonReport> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'Service non-nominatif non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    // Convertir les machineIds en hashes
    const machineHashes = machineIds.map(id => this.nonNominativeService!.generateMachineHash(id));
    
    return await this.nonNominativeService.compareMachines(machineHashes);
  }

  /**
   * Migre depuis l'ancien système de baseline
   */
  public async migrateToNonNominative(
    options: MigrationOptions = {
      keepLegacyReferences: true,
      machineMappingStrategy: 'hash',
      autoValidate: true,
      createBackup: true,
      priorityCategories: ['roo-core', 'software-powershell', 'software-node', 'software-python']
    }
  ): Promise<any> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'Service non-nominatif non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    try {
      // Charger la baseline actuelle
      const legacyBaseline = await this.baselineService.readBaselineFile();
      if (!legacyBaseline) {
        throw new RooSyncServiceError(
          'Aucune baseline legacy trouvée pour la migration',
          'BASELINE_NOT_FOUND'
        );
      }

      // Effectuer la migration
      const migrationResult = await this.nonNominativeService.migrateFromLegacy(legacyBaseline, options);

      // Mettre à jour le registre des machines si nécessaire
      if (migrationResult.success && options.keepLegacyReferences) {
        console.log('[BaselineManager] Références legacy préservées lors de la migration');
      }

      return migrationResult;
    } catch (error) {
      throw new RooSyncServiceError(
        `Échec de la migration: ${(error as Error).message}`,
        'MIGRATION_FAILED'
      );
    }
  }

  /**
   * Obtient l'état du système non-nominatif
   */
  public getNonNominativeState(): any {
    if (!this.nonNominativeService) {
      return null;
    }

    return this.nonNominativeService.getState();
  }

  /**
   * Obtient la baseline non-nominative active
   */
  public getActiveNonNominativeBaseline(): NonNominativeBaseline | undefined {
    if (!this.nonNominativeService) {
      return undefined;
    }

    return this.nonNominativeService.getActiveBaseline();
  }

  /**
   * Obtient tous les mappings de machines non-nominatives
   */
  public getNonNominativeMachineMappings(): MachineConfigurationMapping[] {
    if (!this.nonNominativeService) {
      return [];
    }

    return this.nonNominativeService.getMachineMappings();
  }
}