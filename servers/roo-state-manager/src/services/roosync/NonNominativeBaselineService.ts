/**
 * Service de gestion des baselines non-nominatives - RooSync v2.2
 *
 * Ce service gère le nouveau système de baseline qui ne dépend plus
 * des identités de machines nominatives, mais utilise des catégories
 * de configuration et des profils anonymisés.
 *
 * @module NonNominativeBaselineService
 * @version 2.2.0
 */

import { promises as fs, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('NonNominativeBaselineService');
import {
  NonNominativeBaseline,
  ConfigurationProfile,
  ConfigurationCategory,
  MachineConfigurationMapping,
  NonNominativeComparisonReport,
  BaselineVersion,
  AggregationConfig,
  NonNominativeBaselineState,
  MigrationOptions,
  MigrationResult,
  MachineInventory
} from '../../types/non-nominative-baseline.js';
import { MachineInventory as LegacyMachineInventory, BaselineConfig, BaselineFileConfig } from '../../types/baseline.js';
import { BaselineServiceError, BaselineServiceErrorCode } from '../../types/baseline.js';
import { readJSONFileWithoutBOM } from '../../utils/encoding-helpers.js';

/**
 * Service pour la gestion des baselines non-nominatives
 */
export class NonNominativeBaselineService {
  private baselinePath: string;
  private profilesPath: string;
  private mappingsPath: string;
  private state: NonNominativeBaselineState;
  private cache: Map<string, any> = new Map();

  constructor(private sharedPath: string) {
    this.baselinePath = join(sharedPath, 'non-nominative-baseline.json');
    this.profilesPath = join(sharedPath, 'configuration-profiles.json');
    this.mappingsPath = join(sharedPath, 'machine-mappings.json');

    this.state = {
      activeBaseline: undefined,
      machineMappings: [],
      statistics: {
        totalBaselines: 0,
        totalProfiles: 0,
        totalMachines: 0,
        averageCompliance: 0,
        lastUpdated: new Date().toISOString()
      }
    };

    this.initializeService();
  }

  /**
   * Initialise le service et charge les données existantes
   */
  private async initializeService(): Promise<void> {
    try {
      await this.loadState();
      logger.info('Service initialisé avec succès');
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation', error);
    }
  }

  /**
   * Génère un hash anonymisé pour un machineId
   */
  public generateMachineHash(machineId: string): string {
    return createHash('sha256')
      .update(machineId + 'roosync-salt-2024')
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Crée une nouvelle baseline non-nominative
   */
  public async createBaseline(
    name: string,
    description: string,
    profiles: ConfigurationProfile[]
  ): Promise<NonNominativeBaseline> {
    const baselineId = `baseline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const baseline: NonNominativeBaseline = {
      baselineId,
      version: '1.0.0',
      name,
      description,
      profiles,
      aggregationRules: {
        defaultPriority: 100,
        conflictResolution: 'highest_priority',
        autoMergeCategories: ['roo-core', 'software-powershell', 'software-node', 'software-python']
      },
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: 'system',
        lastModifiedBy: 'system',
        tags: ['auto-generated'],
        status: 'active'
      }
    };

    // Valider la baseline
    this.validateBaseline(baseline);

    // Sauvegarder la baseline
    await this.saveBaseline(baseline);

    // Mettre à jour l'état
    this.state.activeBaseline = baseline;
    this.state.statistics.totalBaselines++;
    this.state.statistics.lastUpdated = new Date().toISOString();
    await this.saveState();

    logger.info(`Baseline créée: ${baselineId}`);
    return baseline;
  }

  /**
   * Agrège automatiquement une baseline à partir des configurations existantes
   */
  public async aggregateBaseline(
    machineInventories: MachineInventory[],
    config: AggregationConfig
  ): Promise<NonNominativeBaseline> {
    logger.info('Début de l\'agrégation automatique');

    const profiles: ConfigurationProfile[] = [];
    const categoryData: Map<ConfigurationCategory, any[]> = new Map();

    // Collecter les données par catégorie
    for (const inventory of machineInventories) {
      this.extractCategoryData(inventory, categoryData);
    }

    // Générer les profils par catégorie
    for (const [category, data] of categoryData.entries()) {
      const profile = await this.generateProfileForCategory(category, data, config);
      if (profile) {
        profiles.push(profile);
      }
    }

    // Créer la baseline
    const baseline = await this.createBaseline(
      'Baseline agrégée automatiquement',
      'Baseline générée par agrégation des configurations existantes',
      profiles
    );

    logger.info(`Baseline agrégée créée: ${baseline.baselineId}`);
    return baseline;
  }

  /**
   * Extrait les données par catégorie depuis un inventaire
   */
  private extractCategoryData(
    inventory: MachineInventory,
    categoryData: Map<ConfigurationCategory, any[]>
  ): void {
    // Configuration Roo
    if (inventory.config.roo) {
      if (!categoryData.has('roo-core')) {
        categoryData.set('roo-core', []);
      }
      if (!categoryData.has('roo-advanced')) {
        categoryData.set('roo-advanced', []);
      }

      categoryData.get('roo-core')!.push({
        modes: inventory.config.roo.modes,
        mcpSettings: inventory.config.roo.mcpSettings
      });

      categoryData.get('roo-advanced')!.push({
        userSettings: inventory.config.roo.userSettings
      });
    }

    // Hardware
    if (inventory.config.hardware) {
      if (!categoryData.has('hardware-cpu')) {
        categoryData.set('hardware-cpu', []);
      }
      if (!categoryData.has('hardware-memory')) {
        categoryData.set('hardware-memory', []);
      }
      if (!categoryData.has('hardware-storage')) {
        categoryData.set('hardware-storage', []);
      }

      categoryData.get('hardware-cpu')!.push(inventory.config.hardware.cpu);
      categoryData.get('hardware-memory')!.push(inventory.config.hardware.memory);
      categoryData.get('hardware-storage')!.push(inventory.config.hardware.disks);
    }

    // Software
    if (inventory.config.software) {
      if (!categoryData.has('software-powershell')) {
        categoryData.set('software-powershell', []);
      }
      if (!categoryData.has('software-node')) {
        categoryData.set('software-node', []);
      }
      if (!categoryData.has('software-python')) {
        categoryData.set('software-python', []);
      }

      categoryData.get('software-powershell')!.push({ version: inventory.config.software.powershell });
      categoryData.get('software-node')!.push({ version: inventory.config.software.node });
      categoryData.get('software-python')!.push({ version: inventory.config.software.python });
    }

    // System
    if (inventory.config.system) {
      if (!categoryData.has('system-os')) {
        categoryData.set('system-os', []);
      }
      if (!categoryData.has('system-architecture')) {
        categoryData.set('system-architecture', []);
      }

      categoryData.get('system-os')!.push({ os: inventory.config.system.os });
      categoryData.get('system-architecture')!.push({ arch: inventory.config.system.architecture });
    }
  }

  /**
   * Génère un profil pour une catégorie spécifique
   */
  private async generateProfileForCategory(
    category: ConfigurationCategory,
    data: any[],
    config: AggregationConfig
  ): Promise<ConfigurationProfile | null> {
    if (data.length === 0) return null;

    const categoryRule = config.categoryRules[category];
    if (!categoryRule) return null;

    let configuration: any = {};

    // Appliquer la stratégie d'agrégation
    switch (categoryRule.strategy) {
      case 'majority':
        configuration = this.aggregateByMajority(data);
        break;
      case 'latest':
        configuration = data[data.length - 1];
        break;
      case 'weighted_average':
        configuration = this.aggregateByWeightedAverage(data);
        break;
      default:
        configuration = data[0];
    }

    const profileId = `profile-${category}-${Date.now()}`;
    const profile: ConfigurationProfile = {
      profileId,
      category,
      name: `Profil ${category} agrégé`,
      description: `Profil généré automatiquement pour la catégorie ${category}`,
      configuration,
      priority: 100,
      compatibility: {
        requiredProfiles: [],
        conflictingProfiles: [],
        optionalProfiles: []
      },
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: '1.0.0',
        tags: ['auto-generated', 'aggregated'],
        stability: 'stable'
      }
    };

    return profile;
  }

  /**
   * Agrège par majorité (valeur la plus fréquente)
   */
  private aggregateByMajority(data: any[]): any {
    // Implémentation simplifiée - à améliorer selon les types de données
    return data[0]; // Pour l'instant, prend la première valeur
  }

  /**
   * Agrège par moyenne pondérée
   */
  private aggregateByWeightedAverage(data: any[]): any {
    // Implémentation simplifiée - à améliorer selon les types de données
    return data[0]; // Pour l'instant, prend la première valeur
  }

  /**
   * Mappe une machine à la baseline non-nominative
   */
  public async mapMachineToBaseline(
    machineId: string,
    inventory: MachineInventory,
    baselineId?: string
  ): Promise<MachineConfigurationMapping> {
    const machineHash = this.generateMachineHash(machineId);
    const activeBaseline = baselineId ? 
      await this.loadBaseline(baselineId) : 
      this.state.activeBaseline;

    if (!activeBaseline) {
      throw new BaselineServiceError(
        'Aucune baseline active disponible',
        BaselineServiceErrorCode.BASELINE_NOT_FOUND
      );
    }

    const mappingId = `mapping-${machineHash}-${Date.now()}`;
    const appliedProfiles = this.determineAppliedProfiles(inventory, activeBaseline);
    const deviations = this.detectDeviations(inventory, activeBaseline, appliedProfiles);

    const mapping: MachineConfigurationMapping = {
      mappingId,
      machineHash,
      baselineId: activeBaseline.baselineId,
      appliedProfiles,
      deviations,
      metadata: {
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        confidence: this.calculateConfidence(deviations)
      }
    };

    // Sauvegarder le mapping
    await this.saveMachineMapping(mapping);

    // Mettre à jour l'état
    this.state.machineMappings.push(mapping);
    this.state.statistics.totalMachines = this.state.machineMappings.length;
    this.state.statistics.lastUpdated = new Date().toISOString();
    await this.saveState();

    logger.info(`Machine mappée: ${machineHash}`);
    return mapping;
  }

  /**
   * Détermine les profils applicables pour une machine
   */
  private determineAppliedProfiles(
    inventory: MachineInventory,
    baseline: NonNominativeBaseline
  ): Array<{
    profileId: string;
    category: ConfigurationCategory;
    appliedAt: string;
    source: 'auto' | 'manual' | 'inherited';
  }> {
    const appliedProfiles: Array<{
      profileId: string;
      category: ConfigurationCategory;
      appliedAt: string;
      source: 'auto' | 'manual' | 'inherited';
    }> = [];

    for (const profile of baseline.profiles) {
      if (this.isProfileApplicable(profile, inventory)) {
        appliedProfiles.push({
          profileId: profile.profileId,
          category: profile.category,
          appliedAt: new Date().toISOString(),
          source: 'auto'
        });
      }
    }

    return appliedProfiles;
  }

  /**
   * Vérifie si un profil est applicable à une machine
   */
  private isProfileApplicable(profile: ConfigurationProfile, inventory: MachineInventory): boolean {
    // Implémentation simplifiée - à améliorer avec des règles plus complexes
    return true;
  }

  /**
   * Détecte les déviations par rapport à la baseline
   */
  private detectDeviations(
    inventory: MachineInventory,
    baseline: NonNominativeBaseline,
    appliedProfiles: Array<{ profileId: string; category: ConfigurationCategory }>
  ): Array<{
    category: ConfigurationCategory;
    expectedValue: any;
    actualValue: any;
    severity: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
    detectedAt: string;
  }> {
    const deviations: Array<{
      category: ConfigurationCategory;
      expectedValue: any;
      actualValue: any;
      severity: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
      detectedAt: string;
    }> = [];

    for (const appliedProfile of appliedProfiles) {
      const profile = baseline.profiles.find(p => p.profileId === appliedProfile.profileId);
      if (!profile) continue;

      const actualValue = this.extractActualValue(inventory, profile.category);
      const expectedValue = profile.configuration;

      if (!this.areValuesEqual(actualValue, expectedValue)) {
        deviations.push({
          category: profile.category,
          expectedValue,
          actualValue,
          severity: this.calculateDeviationSeverity(profile.category, actualValue, expectedValue),
          detectedAt: new Date().toISOString()
        });
      }
    }

    return deviations;
  }

  /**
   * Extrait la valeur réelle pour une catégorie
   */
  private extractActualValue(inventory: MachineInventory, category: ConfigurationCategory): any {
    switch (category) {
      case 'roo-core':
        return {
          modes: inventory.config.roo?.modes,
          mcpSettings: inventory.config.roo?.mcpSettings
        };
      case 'roo-advanced':
        return {
          userSettings: inventory.config.roo?.userSettings
        };
      case 'hardware-cpu':
        return inventory.config.hardware?.cpu;
      case 'hardware-memory':
        return inventory.config.hardware?.memory;
      case 'software-powershell':
        return { version: inventory.config.software?.powershell };
      case 'software-node':
        return { version: inventory.config.software?.node };
      case 'software-python':
        return { version: inventory.config.software?.python };
      case 'system-os':
        return { os: inventory.config.system?.os };
      case 'system-architecture':
        return { arch: inventory.config.system?.architecture };
      default:
        return null;
    }
  }

  /**
   * Compare deux valeurs pour déterminer si elles sont égales
   */
  private areValuesEqual(actual: any, expected: any): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  /**
   * Calcule la sévérité d'une déviation
   */
  private calculateDeviationSeverity(
    category: ConfigurationCategory,
    actual: any,
    expected: any
  ): 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO' {
    // Implémentation simplifiée - à améliorer selon les catégories
    if (category.startsWith('roo-')) {
      return 'IMPORTANT';
    } else if (category.startsWith('hardware-')) {
      return 'WARNING';
    } else {
      return 'INFO';
    }
  }

  /**
   * Calcule le score de confiance du mapping
   */
  private calculateConfidence(deviations: any[]): number {
    if (deviations.length === 0) return 1.0;
    
    const criticalDeviations = deviations.filter(d => d.severity === 'CRITICAL').length;
    const importantDeviations = deviations.filter(d => d.severity === 'IMPORTANT').length;
    
    // Plus il y a de déviations critiques/importantes, moins la confiance est élevée
    const penalty = (criticalDeviations * 0.3) + (importantDeviations * 0.1);
    return Math.max(0, 1.0 - penalty);
  }

  /**
   * Compare plusieurs machines avec la baseline non-nominative
   */
  public async compareMachines(
    machineHashes: string[]
  ): Promise<NonNominativeComparisonReport> {
    if (!this.state.activeBaseline) {
      throw new BaselineServiceError(
        'Aucune baseline active disponible',
        BaselineServiceErrorCode.BASELINE_NOT_FOUND
      );
    }

    const reportId = `comparison-${Date.now()}`;
    const differencesByCategory: Record<ConfigurationCategory, any[]> = {} as any;
    let totalDifferences = 0;

    // Analyser chaque machine
    for (const machineHash of machineHashes) {
      const mapping = this.state.machineMappings.find(m => m.machineHash === machineHash);
      if (!mapping) continue;

      for (const deviation of mapping.deviations) {
        if (!differencesByCategory[deviation.category]) {
          differencesByCategory[deviation.category] = [];
        }

        differencesByCategory[deviation.category].push({
          machineHash,
          profileId: mapping.appliedProfiles.find(p => p.category === deviation.category)?.profileId || 'unknown',
          field: deviation.category,
          expectedValue: deviation.expectedValue,
          actualValue: deviation.actualValue,
          severity: deviation.severity,
          description: `Déviation détectée pour ${deviation.category}`
        });

        totalDifferences++;
      }
    }

    // Calculer les statistiques
    const differencesBySeverity = {
      CRITICAL: 0,
      IMPORTANT: 0,
      WARNING: 0,
      INFO: 0
    };

    Object.values(differencesByCategory).flat().forEach(diff => {
      (differencesBySeverity as any)[diff.severity]++;
    });

    const differencesByCategoryCount: Record<ConfigurationCategory, number> = {} as any;
    Object.keys(differencesByCategory).forEach(category => {
      differencesByCategoryCount[category as ConfigurationCategory] = differencesByCategory[category as ConfigurationCategory].length;
    });

    const complianceRate = machineHashes.length > 0 ? 
      1.0 - (totalDifferences / (machineHashes.length * this.state.activeBaseline.profiles.length)) : 0;

    const report: NonNominativeComparisonReport = {
      reportId,
      baselineId: this.state.activeBaseline.baselineId,
      machineHashes,
      differencesByCategory,
      statistics: {
        totalMachines: machineHashes.length,
        totalDifferences,
        differencesBySeverity,
        differencesByCategory: differencesByCategoryCount,
        complianceRate
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        generatedBy: 'system',
        version: '2.2.0'
      }
    };

    this.state.lastComparison = report;
    await this.saveState();

    return report;
  }

  /**
   * Migre depuis l'ancien système de baseline
   */
  public async migrateFromLegacy(
    legacyBaseline: BaselineConfig | BaselineFileConfig,
    options: MigrationOptions
  ): Promise<MigrationResult> {
    logger.info('Début de la migration depuis l\'ancien système');
    const startTime = Date.now();

    try {
      // Créer un backup si demandé
      if (options.createBackup) {
        await this.createLegacyBackup(legacyBaseline);
      }

      // Extraire les profils depuis la baseline legacy
      const profiles = await this.extractProfilesFromLegacy(legacyBaseline, options);

      // Créer la nouvelle baseline
      const newBaseline = await this.createBaseline(
        'Baseline migrée depuis système legacy',
        'Baseline générée par migration depuis l\'ancien système nominatif',
        profiles
      );

      // Mapper les machines existantes
      const migratedMachines: string[] = [];
      const errors: Array<{ type: string; message: string; details?: any }> = [];

      // Si la baseline legacy contient des machines, les migrer
      if ('machines' in legacyBaseline && legacyBaseline.machines) {
        for (const machine of legacyBaseline.machines) {
          try {
            const machineHash = this.generateMachineHash(machine.id);
            await this.mapMachineToBaseline(machine.id, this.convertLegacyToMachineInventory(machine), newBaseline.baselineId);
            migratedMachines.push(machineHash);
          } catch (error) {
            errors.push({
              type: 'MIGRATION_ERROR',
              message: `Erreur lors de la migration de la machine ${machine.id}`,
              details: error
            });
          }
        }
      }

      const duration = Date.now() - startTime;
      const result: MigrationResult = {
        success: errors.length === 0,
        newBaseline,
        migratedMachines,
        errors,
        statistics: {
          totalMachines: ('machines' in legacyBaseline && legacyBaseline.machines) ? legacyBaseline.machines.length : 1,
          successfulMigrations: migratedMachines.length,
          failedMigrations: errors.length,
          profilesCreated: profiles.length,
          deviationsDetected: 0 // À calculer
        },
        metadata: {
          migratedAt: new Date().toISOString(),
          migratedBy: 'system',
          duration
        }
      };

      logger.info(`Migration terminée en ${duration}ms`);
      return result;

    } catch (error) {
      throw new BaselineServiceError(
        `Échec de la migration: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_INVALID,
        error
      );
    }
  }

  /**
   * Extrait les profils depuis une baseline legacy
   */
  private async extractProfilesFromLegacy(
    legacyBaseline: BaselineConfig | BaselineFileConfig,
    options: MigrationOptions
  ): Promise<ConfigurationProfile[]> {
    const profiles: ConfigurationProfile[] = [];

    // Extraire depuis BaselineConfig (ancien format)
    if ('config' in legacyBaseline) {
      const config = legacyBaseline as BaselineConfig;
      
      // Profil Roo Core
      profiles.push({
        profileId: `profile-roo-core-${Date.now()}`,
        category: 'roo-core',
        name: 'Profil Roo Core (migré)',
        description: 'Profil Roo de base migré depuis l\'ancien système',
        configuration: {
          modes: config.config.roo.modes,
          mcpSettings: config.config.roo.mcpSettings
        },
        priority: 100,
        compatibility: {
          requiredProfiles: [],
          conflictingProfiles: [],
          optionalProfiles: []
        },
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: '1.0.0',
          tags: ['migrated', 'legacy'],
          stability: 'stable'
        }
      });

      // Profils Hardware
      profiles.push({
        profileId: `profile-hardware-cpu-${Date.now()}`,
        category: 'hardware-cpu',
        name: 'Profil CPU (migré)',
        description: 'Profil CPU migré depuis l\'ancien système',
        configuration: config.config.hardware.cpu,
        priority: 100,
        compatibility: {
          requiredProfiles: [],
          conflictingProfiles: [],
          optionalProfiles: []
        },
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: '1.0.0',
          tags: ['migrated', 'legacy'],
          stability: 'stable'
        }
      });

      // Ajouter d'autres profils selon les besoins...
    }

    return profiles;
  }

  /**
   * Convertit une machine legacy en MachineInventory
   */
  private convertLegacyToMachineInventory(legacyMachine: any): MachineInventory {
    // Implémentation à compléter selon le format exact des machines legacy
    return {
      machineId: legacyMachine.id,
      timestamp: new Date().toISOString(),
      config: {
        roo: {
          modes: legacyMachine.roo?.modes || [],
          mcpSettings: legacyMachine.roo?.mcpSettings || {},
          userSettings: legacyMachine.roo?.userSettings || {}
        },
        hardware: {
          cpu: legacyMachine.hardware?.cpu || { model: 'Unknown', cores: 0, threads: 0 },
          memory: legacyMachine.hardware?.memory || { total: 0 },
          disks: legacyMachine.hardware?.disks || [],
          gpu: legacyMachine.hardware?.gpu
        },
        software: {
          powershell: legacyMachine.software?.powershell || 'Unknown',
          node: legacyMachine.software?.node || 'Unknown',
          python: legacyMachine.software?.python || 'Unknown'
        },
        system: {
          os: legacyMachine.system?.os || 'Unknown',
          architecture: legacyMachine.system?.architecture || 'Unknown'
        }
      },
      metadata: {
        collectionDuration: 0,
        source: 'legacy',
        collectorVersion: '2.1.0'
      }
    };
  }

  /**
   * Crée un backup de la baseline legacy
   */
  private async createLegacyBackup(legacyBaseline: BaselineConfig | BaselineFileConfig): Promise<void> {
    const backupPath = join(this.sharedPath, `legacy-backup-${Date.now()}.json`);
    await fs.writeFile(backupPath, JSON.stringify(legacyBaseline, null, 2));
    logger.info(`Backup legacy créé: ${backupPath}`);
  }

  /**
   * Valide une baseline
   */
  private validateBaseline(baseline: NonNominativeBaseline): void {
    if (!baseline.baselineId || !baseline.name || !baseline.profiles) {
      throw new BaselineServiceError(
        'Baseline invalide: champs requis manquants',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }

    if (baseline.profiles.length === 0) {
      throw new BaselineServiceError(
        'Baseline invalide: aucun profil défini',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }

    // Valider chaque profil
    for (const profile of baseline.profiles) {
      if (!profile.profileId || !profile.category || !profile.configuration) {
        throw new BaselineServiceError(
          'Profil invalide: champs requis manquants',
          BaselineServiceErrorCode.BASELINE_INVALID
        );
      }
    }
  }

  /**
   * Charge une baseline depuis le disque
   */
  private async loadBaseline(baselineId?: string): Promise<NonNominativeBaseline | null> {
    try {
      if (baselineId) {
        // Charger une baseline spécifique
        const baselinePath = join(this.sharedPath, `baseline-${baselineId}.json`);
        if (existsSync(baselinePath)) {
          return await readJSONFileWithoutBOM<NonNominativeBaseline>(baselinePath);
        }
      } else {
        // Charger la baseline active
        if (existsSync(this.baselinePath)) {
          return await readJSONFileWithoutBOM<NonNominativeBaseline>(this.baselinePath);
        }
      }
      return null;
    } catch (error) {
      throw new BaselineServiceError(
        `Erreur chargement baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_NOT_FOUND,
        error
      );
    }
  }

  /**
   * Sauvegarde une baseline sur le disque
   */
  private async saveBaseline(baseline: NonNominativeBaseline): Promise<void> {
    try {
      await fs.writeFile(this.baselinePath, JSON.stringify(baseline, null, 2));
    } catch (error) {
      throw new BaselineServiceError(
        `Erreur sauvegarde baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_INVALID,
        error
      );
    }
  }

  /**
   * Sauvegarde un mapping de machine
   */
  private async saveMachineMapping(mapping: MachineConfigurationMapping): Promise<void> {
    try {
      let mappings: MachineConfigurationMapping[] = [];
      
      if (existsSync(this.mappingsPath)) {
        const content = await fs.readFile(this.mappingsPath, 'utf-8');
        if (content && content.trim() !== '') {
          mappings = await readJSONFileWithoutBOM<MachineConfigurationMapping[]>(this.mappingsPath);
        }
      }

      // Remplacer ou ajouter le mapping
      const existingIndex = mappings.findIndex(m => m.machineHash === mapping.machineHash);
      if (existingIndex >= 0) {
        mappings[existingIndex] = mapping;
      } else {
        mappings.push(mapping);
      }

      await fs.writeFile(this.mappingsPath, JSON.stringify(mappings, null, 2));
    } catch (error) {
      throw new BaselineServiceError(
        `Erreur sauvegarde mapping: ${(error as Error).message}`,
        BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED,
        error
      );
    }
  }

  /**
   * Charge l'état du service
   */
  private async loadState(): Promise<void> {
    try {
      const statePath = join(this.sharedPath, 'non-nominative-state.json');
      if (existsSync(statePath)) {
        this.state = await readJSONFileWithoutBOM<NonNominativeBaselineState>(statePath);
      }
    } catch (error) {
      logger.error('Erreur chargement état', error);
    }
  }

  /**
   * Sauvegarde l'état du service
   */
  private async saveState(): Promise<void> {
    try {
      const statePath = join(this.sharedPath, 'non-nominative-state.json');
      await fs.writeFile(statePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      logger.error('Erreur sauvegarde état', error);
    }
  }

  /**
   * Retourne l'état actuel du service
   */
  public getState(): NonNominativeBaselineState {
    return { ...this.state };
  }

  /**
   * Retourne la baseline active
   */
  public getActiveBaseline(): NonNominativeBaseline | undefined {
    return this.state.activeBaseline;
  }

  /**
   * Retourne tous les mappings de machines
   */
  public getMachineMappings(): MachineConfigurationMapping[] {
    return [...this.state.machineMappings];
  }
}