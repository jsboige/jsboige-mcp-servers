/**
 * Types canoniques pour le système de baseline unifié - RooSync v3.0+
 * 
 * Ce fichier définit les structures de données canoniques pour le système
 * de baseline unifié. Il remplace les définitions dupliquées dans:
 * - baseline.ts (legacy v2.1 - nominatif)
 * - non-nominative-baseline.ts (v2.2 - intermédiaire)
 * 
 * Les types de ce fichier sont la source de vérité unique pour l'architecture
 * de baseline non-nominative v3.0, choisie comme modèle unique pour RooSync.
 * 
 * @version 3.0.0
 * @canonical Ce fichier est la source de vérité pour les types de baseline
 * @see docs/suivi/RooSync/T3_9_ANALYSE_BASELINE_UNIQUE.md pour la justification
 */

/**
 * Catégories de configuration pour la baseline non-nominative
 * 
 * Ces 11 catégories permettent une granularité fine pour la synchronisation
 * sélective des configurations entre machines.
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
 * Profil de configuration pour une catégorie donnée
 * 
 * Un profil représente une configuration réutilisable pour une catégorie
 * spécifique. Les profils peuvent être partagés entre plusieurs machines.
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
  
  /** Métadonnées du profil */
  metadata: {
    createdAt: string;
    updatedAt: string;
    version: string;
    tags: string[];
    stability: 'stable' | 'beta' | 'experimental';
  };
}

/**
 * Baseline non-nominative complète
 * 
 * Une baseline est une collection de profils de configuration qui définit
 * l'état de référence pour un ensemble de machines.
 */
export interface Baseline {
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
  
  /** Règles d'agrégation */
  aggregationRules: {
    defaultPriority: number;
    conflictResolution: 'highest_priority' | 'most_recent';
    autoMergeCategories: ConfigurationCategory[];
  };
  
  /** Métadonnées de la baseline */
  metadata: {
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    lastModifiedBy: string;
    tags: string[];
    status: 'draft' | 'active' | 'deprecated' | 'archived';
    
    /** Historique des versions */
    versionHistory?: Array<{
      version: string;
      releasedAt: string;
      releasedBy: string;
      releaseNotes: string;
    }>;
  };
}

/**
 * Inventaire de machine pour l'agrégation de baseline
 * 
 * Représente l'état complet de la configuration d'une machine à un instant T.
 * Utilisé pour créer des profils ou comparer avec une baseline existante.
 */
export interface MachineInventory {
  /** Identifiant de la machine (hash anonymisé) */
  machineId: string;
  
  /** Timestamp de la collecte */
  timestamp?: string;
  
  /** Configuration de la machine */
  config: {
    /** Configuration Roo */
    roo?: {
      modes?: string[];
      mcpSettings?: Record<string, any>;
      userSettings?: Record<string, any>;
    };
    
    /** Configuration matérielle */
    hardware?: {
      cpu?: any;
      memory?: any;
      disks?: any;
      gpu?: any;
    };
    
    /** Configuration logicielle */
    software?: {
      powershell?: string;
      node?: string;
      python?: string;
    };
    
    /** Configuration système */
    system?: {
      os?: string;
      architecture?: string;
    };
  };
  
  /** Métadonnées de l'inventaire */
  metadata: {
    lastSeen?: string;
    version?: string;
    source?: string;
    collectionDuration?: number;
    collectorVersion?: string;
  };
}

/**
 * Configuration de machine mappée à la baseline
 * 
 * Associe une machine à une baseline et aux profils qui lui sont appliqués.
 */
export interface MachineConfigurationMapping {
  /** Identifiant unique du mapping */
  mappingId: string;
  
  /** Identifiant de la machine (hash anonymisé) */
  machineHash: string;
  
  /** Baseline de référence */
  baselineId: string;
  
  /** Profils appliqués pour cette machine */
  appliedProfiles: Array<{
    profileId: string;
    category: ConfigurationCategory;
    appliedAt: string;
  }>;
  
  /** Déviations détectées */
  deviations: Array<{
    category: ConfigurationCategory;
    expectedValue: any;
    actualValue: any;
    detectedAt: string;
  }>;
  
  /** Métadonnées du mapping */
  metadata: {
    firstSeen: string;
    lastSeen: string;
    lastUpdated: string;
  };
}

/**
 * Rapport de comparaison de baseline
 * 
 * Résultat de la comparaison entre une baseline et une ou plusieurs machines.
 */
export interface ComparisonReport {
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
 * Configuration d'agrégation automatique
 * 
 * Définit comment agréger les configurations de plusieurs machines
 * pour créer une baseline.
 */
export interface AggregationConfig {
  /** Sources de données pour l'agrégation */
  sources: Array<{
    type: 'machine_inventory' | 'existing_baseline' | 'manual_input';
    weight: number; // Poids dans l'agrégation
    enabled: boolean;
  }>;
  
  /** Règles d'agrégation par catégorie */
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
 * État du système de baseline
 * 
 * État global du système de baseline à un instant T.
 */
export interface BaselineState {
  /** Baseline actuellement active */
  activeBaseline?: Baseline;
  
  /** Machines mappées */
  machineMappings: MachineConfigurationMapping[];
  
  /** Dernière comparaison */
  lastComparison?: ComparisonReport;
  
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
 * Options de migration depuis l'ancien système
 * 
 * Configuration pour migrer depuis le système v2.1 (nominatif) vers v3.0.
 */
export interface MigrationOptions {
  /** Créer un backup avant migration */
  createBackup: boolean;
  
  /** Catégories à migrer en priorité */
  priorityCategories: ConfigurationCategory[];
}

/**
 * Résultat de migration
 * 
 * Résultat d'une opération de migration depuis le système legacy.
 */
export interface MigrationResult {
  /** Succès de la migration */
  success: boolean;
  
  /** Baseline créée */
  newBaseline?: Baseline;
  
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

/**
 * Stratégies d'agrégation disponibles
 */
export type AggregationStrategy = 'majority' | 'latest' | 'weighted_average';

/**
 * Résolution de conflits
 */
export type ConflictResolution = 'highest_priority' | 'most_recent' | 'manual';

/**
 * Statut d'une baseline
 */
export type BaselineStatus = 'draft' | 'active' | 'deprecated' | 'archived';

/**
 * Stabilité d'un profil
 */
export type ProfileStability = 'stable' | 'beta' | 'experimental';

/**
 * Type de source de données
 */
export type DataSourceType = 'machine_inventory' | 'existing_baseline' | 'manual_input';

/**
 * Réexport des types pour compatibilité
 * 
 * Ces alias permettent une transition progressive vers les types canoniques.
 * @deprecated Utiliser les types canoniques directement
 */
export type NonNominativeBaseline = Baseline;
export type NonNominativeComparisonReport = ComparisonReport;
export type NonNominativeBaselineState = BaselineState;
