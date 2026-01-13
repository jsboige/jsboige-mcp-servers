/**
 * Types et interfaces pour le système de baseline non-nominatif - RooSync v2.3 (Simplifié)
 * 
 * Ce fichier définit les structures de données simplifiées pour le système
 * de baseline qui ne dépend plus des identités de machines nominatives.
 * 
 * @version 3.0.0
 * @simplification Réduction du nombre d'interfaces et de l'imbrication
 */

/**
 * Catégories de configuration pour la baseline non-nominative
 */
export type ConfigurationCategory =
  | 'roo-core'           // Configuration Roo de base (modes, MCPs)
  | 'roo-advanced'       // Configuration Roo avancée (SDDD, settings)
  | 'hardware-cpu'       // Configuration CPU
  | 'hardware-memory'    // Configuration mémoire
  | 'hardware-storage'   // Configuration stockage
  | 'hardware-gpu'       // Configuration GPU (optionnelle)
  | 'software-powershell' // Version PowerShell
  | 'software-node'       // Version Node.js
  | 'software-python'     // Version Python
  | 'system-os'          // Système d'exploitation
  | 'system-architecture'; // Architecture système

/**
 * Profil de configuration pour une catégorie donnée (Simplifié)
 */
export interface ConfigurationProfile {
  /** Identifiant unique du profil (non-nominatif) */
  profileId: string;
  
  /** Catégorie de configuration */
  category: ConfigurationCategory;
  
  /** Nom descriptif du profil */
  name: string;
  
  /** Description du profil */
  description: string;
  
  /** Valeurs de configuration pour ce profil */
  configuration: Record<string, any>;
  
  /** Priorité du profil (plus élevé = plus prioritaire) */
  priority: number;
  
  /** Métadonnées simplifiées */
  metadata: {
    createdAt: string;
    updatedAt: string;
    version: string;
    tags: string[];
    stability: 'stable' | 'beta' | 'experimental';
  };
}

/**
 * Baseline non-nominative complète (Simplifiée)
 */
export interface NonNominativeBaseline {
  /** Identifiant unique de la baseline */
  baselineId: string;
  
  /** Version de la baseline */
  version: string;
  
  /** Nom de la baseline */
  name: string;
  
  /** Description de la baseline */
  description: string;
  
  /** Profils de configuration composant la baseline */
  profiles: ConfigurationProfile[];
  
  /** Règles d'agrégation simplifiées */
  aggregationRules: {
    defaultPriority: number;
    conflictResolution: 'highest_priority' | 'most_recent';
    autoMergeCategories: ConfigurationCategory[];
  };
  
  /** Métadonnées de la baseline (inclut les informations de version) */
  metadata: {
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    lastModifiedBy: string;
    tags: string[];
    status: 'draft' | 'active' | 'deprecated' | 'archived';
    
    // Informations de version (fusionnées depuis BaselineVersion)
    versionHistory?: Array<{
      version: string;
      releasedAt: string;
      releasedBy: string;
      releaseNotes: string;
    }>;
  };
}

/**
 * Inventaire de machine pour l'agrégation de baseline (Simplifié)
 */
export interface MachineInventory {
  machineId: string;
  timestamp?: string;
  config: {
    roo?: {
      modes?: string[];
      mcpSettings?: Record<string, any>;
      userSettings?: Record<string, any>;
    };
    hardware?: {
      cpu?: any;
      memory?: any;
      disks?: any;
      gpu?: any;
    };
    software?: {
      powershell?: string;
      node?: string;
      python?: string;
    };
    system?: {
      os?: string;
      architecture?: string;
    };
  };
  metadata: {
    lastSeen?: string;
    version?: string;
    source?: string;
    collectionDuration?: number;
    collectorVersion?: string;
  };
}

/**
 * Configuration de machine mappée à la baseline non-nominative (Simplifiée)
 */
export interface MachineConfigurationMapping {
  /** Identifiant unique du mapping */
  mappingId: string;
  
  /** Identifiant de la machine (hash anonymisé) */
  machineHash: string;
  
  /** Baseline de référence */
  baselineId: string;
  
  /** Profils appliqués pour cette machine (simplifié - sans source) */
  appliedProfiles: Array<{
    profileId: string;
    category: ConfigurationCategory;
    appliedAt: string;
  }>;
  
  /** Déviations détectées (simplifié - sans sévérité) */
  deviations: Array<{
    category: ConfigurationCategory;
    expectedValue: any;
    actualValue: any;
    detectedAt: string;
  }>;
  
  /** Métadonnées simplifiées (sans score de confiance) */
  metadata: {
    firstSeen: string;
    lastSeen: string;
    lastUpdated: string;
  };
}

/**
 * Rapport de comparaison non-nominatif (Simplifié)
 */
export interface NonNominativeComparisonReport {
  /** Identifiant du rapport */
  reportId: string;
  
  /** Baseline de référence */
  baselineId: string;
  
  /** Machines comparées (hash anonymisés) */
  machineHashes: string[];
  
  /** Différences par catégorie */
  differencesByCategory: Record<ConfigurationCategory, Array<{
    machineHash: string;
    profileId: string;
    field: string;
    expectedValue: any;
    actualValue: any;
    description: string;
  }>>;
  
  /** Statistiques */
  statistics: {
    totalMachines: number;
    totalDifferences: number;
    differencesByCategory: Record<ConfigurationCategory, number>;
    complianceRate: number; // 0-1
  };
  
  /** Métadonnées */
  metadata: {
    generatedAt: string;
    generatedBy: string;
    version: string;
  };
}

/**
 * Configuration d'agrégation automatique (Simplifiée)
 */
export interface AggregationConfig {
  /** Sources de données pour l'agrégation */
  sources: Array<{
    type: 'machine_inventory' | 'existing_baseline' | 'manual_input';
    weight: number; // Poids dans l'agrégation
    enabled: boolean;
  }>;
  
  /** Règles d'agrégation par catégorie (simplifiées - 2 stratégies) */
  categoryRules: Record<ConfigurationCategory, {
    strategy: 'majority' | 'latest';
    autoApply: boolean;
  }>;
  
  /** Seuils de détection */
  thresholds: {
    deviationThreshold: number; // 0-1
    complianceThreshold: number; // 0-1
  };
}

/**
 * État du système de baseline non-nominatif (Simplifié)
 */
export interface NonNominativeBaselineState {
  /** Baseline actuellement active */
  activeBaseline?: NonNominativeBaseline;
  
  /** Machines mappées */
  machineMappings: MachineConfigurationMapping[];
  
  /** Dernière comparaison */
  lastComparison?: NonNominativeComparisonReport;
  
  /** Statistiques */
  statistics: {
    totalBaselines: number;
    totalProfiles: number;
    totalMachines: number;
    averageCompliance: number;
    lastUpdated: string;
  };
}

/**
 * Options de migration depuis l'ancien système (Simplifiées)
 */
export interface MigrationOptions {
  /** Créer un backup avant migration */
  createBackup: boolean;
  
  /** Catégories à migrer en priorité */
  priorityCategories: ConfigurationCategory[];
}

/**
 * Résultat de migration (Simplifié)
 */
export interface MigrationResult {
  /** Succès de la migration */
  success: boolean;
  
  /** Baseline créée */
  newBaseline?: NonNominativeBaseline;
  
  /** Machines migrées */
  migratedMachines: string[];
  
  /** Erreurs rencontrées */
  errors: Array<{
    type: string;
    message: string;
    details?: any;
  }>;
  
  /** Statistiques */
  statistics: {
    totalMachines: number;
    successfulMigrations: number;
    failedMigrations: number;
    profilesCreated: number;
  };
  
  /** Métadonnées */
  metadata: {
    migratedAt: string;
    migratedBy: string;
    duration: number; // en millisecondes
  };
}
