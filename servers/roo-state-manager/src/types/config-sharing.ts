/**
 * Types pour le service de configuration partagée (ConfigSharingService)
 */

export interface ConfigManifestFile {
  path: string;
  hash: string;
  type: 'mode_definition' | 'mcp_config' | 'profile_settings' | 'roomodes_config' | 'model_config' | 'rules_config' | 'roo_settings' | 'other';
  size: number;
}

export interface ConfigManifest {
  version: string;
  timestamp: string;
  author: string;
  description: string;
  files: ConfigManifestFile[];
}

export interface CollectConfigOptions {
  targets: ('modes' | 'mcp' | 'profiles' | 'roomodes' | 'model-configs' | 'rules' | 'settings' | `mcp:${string}`)[];
  dryRun?: boolean;
  description?: string;
}

export interface CollectConfigResult {
  packagePath: string;
  manifest: ConfigManifest;
  filesCount: number;
  totalSize: number;
}

export interface PublishConfigOptions {
  packagePath: string;
  version: string;
  description: string;
  machineId?: string; // CORRECTION SDDD : Optionnel, utilise ROOSYNC_MACHINE_ID par défaut
}

export interface PublishConfigResult {
  success: boolean;
  version: string;
  path: string;
  machineId?: string; // CORRECTION SDDD : Retourne le machineId utilisé
}

export interface ApplyConfigOptions {
  version?: string; // Défaut: latest
  machineId?: string; // CORRECTION SDDD : Optionnel, utilise ROOSYNC_MACHINE_ID par défaut
  targets?: ('modes' | 'mcp' | 'profiles' | 'roomodes' | 'model-configs' | 'rules' | 'settings' | `mcp:${string}`)[];
  backup?: boolean; // Défaut: true
  dryRun?: boolean;
}

export interface ApplyConfigResult {
  success: boolean;
  filesApplied: number;
  backupPath?: string;
  errors?: string[];
}

/**
 * Options pour appliquer un profil de modèle depuis model-configs.json
 * #498 Phase 2: apply_profile action
 */
export interface ApplyProfileOptions {
  /** Nom du profil à appliquer (doit exister dans model-configs.json) */
  profileName: string;
  /** ID de la machine source (optionnel, défaut: locale). Charge model-configs.json depuis la config publiée de cette machine */
  sourceMachineId?: string;
  /** Créer un backup avant modification (défaut: true) */
  backup?: boolean;
  /** Simulation sans modification (défaut: false) */
  dryRun?: boolean;
  /** Régénérer .roomodes après application du profil (défaut: true). Appelle generate-modes.js --profile --deploy */
  generateModes?: boolean;
}

export interface ApplyProfileResult {
  success: boolean;
  /** Nom du profil appliqué */
  profileName: string;
  /** Nombre de modes configurés par le profil */
  modesConfigured: number;
  /** Nombre de configs API définies */
  apiConfigsCount: number;
  /** Chemin du backup créé */
  backupPath?: string;
  /** Indique si .roomodes a été généré et déployé */
  roomodesGenerated?: boolean;
  /** Détails des changements */
  changes?: {
    modeApiConfigs: Record<string, string>;
    profileThresholds: Record<string, number>;
  };
  errors?: string[];
}

export interface ConfigChange {
  id: string;
  path: string[];
  type: 'add' | 'modify' | 'delete';
  oldValue?: any;
  newValue?: any;
  severity: 'info' | 'warning' | 'critical';
}

export interface DiffResult {
  timestamp: string;
  sourceVersion: string;
  targetVersion: string;
  changes: ConfigChange[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    conflicts: number;
  };
}

export interface IConfigSharingService {
  collectConfig(options: CollectConfigOptions): Promise<CollectConfigResult>;
  publishConfig(options: PublishConfigOptions): Promise<PublishConfigResult>;
  applyConfig(options: ApplyConfigOptions): Promise<ApplyConfigResult>;
  applyProfile(options: ApplyProfileOptions): Promise<ApplyProfileResult>;
  compareWithBaseline(config: any): Promise<DiffResult>;
}