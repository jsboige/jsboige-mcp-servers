/**
 * Types pour le service de configuration partagée (ConfigSharingService)
 * Issue #601 - Support scope Claude Code
 */

/**
 * Claude Code scope pour les configurations MCP
 * Issue #601 - Support scopes officiels Claude Code
 */
export type ClaudeCodeScope = 'user' | 'project' | 'settings';

export interface ConfigManifestFile {
  path: string;
  hash: string;
  type: 'mode_definition' | 'mcp_config' | 'profile_settings' | 'roomodes_config' | 'model_config' | 'rules_config' | 'roo_settings' | 'claude_config' | 'modes_yaml' | 'schedules_config' | 'other';
  size: number;
}

export interface ConfigManifest {
  version: string;
  timestamp: string;
  author: string;
  description: string;
  files: ConfigManifestFile[];
}

export type ConfigTarget = 'modes' | 'mcp' | 'profiles' | 'roomodes' | 'model-configs' | 'rules' | 'settings' | 'claude-config' | 'modes-yaml' | 'schtasks' | 'schedules' | `mcp:${string}` | `services:${string}` | `env:${string}`;

export interface CollectConfigOptions {
  targets: ConfigTarget[];
  dryRun?: boolean;
  description?: string;
  scope?: ClaudeCodeScope; // Issue #601 - Scope Claude Code (user/project/settings)
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
  targets?: ConfigTarget[];
  backup?: boolean; // Défaut: true
  dryRun?: boolean;
  scope?: ClaudeCodeScope; // Issue #601 - Scope Claude Code (user/project/settings)
  /** #2413 — Vérifier que la configuration est effectivement appliquée et opérationnelle après écriture */
  validate?: boolean;
}

export interface ApplyConfigResult {
  success: boolean;
  filesApplied: number;
  backupPath?: string;
  errors?: string[];
  /** #2413 — Résultat de la validation post-apply si validate=true */
  validation?: {
    performed: boolean;
    success: boolean;
    /** Détails par target appliqué */
    targetValidations?: Array<{ target: string; success: boolean; details?: any }>;
  };
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
  /** #2413 — Vérifier que le profil est effectivement appliqué (.roomodes + state.vscdb) après écriture */
  validate?: boolean;
  /** #2543 Phase 1(b) — Target extension for vscdb writes: 'roo' or 'zoo'. Default: 'roo' */
  targetExtension?: 'roo' | 'zoo';
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
  /** #2411 — Nombre de schedules appliquées/mergées */
  schedulesApplied?: number;
  /** #2411 — Nombre de rules synchronisées */
  rulesApplied?: number;
  /** Détails des changements */
  changes?: {
    modeApiConfigs: Record<string, string>;
    profileThresholds: Record<string, number>;
    /** #2411 — Schedule IDs mergées (updated + added) */
    schedulesMerged?: string[];
    /** #2411 — Rules filenames synchronisées */
    rulesSynced?: string[];
  };
  errors?: string[];
  /** #2543 Phase 1(b) — Whether listApiConfigMeta was written to vscdb */
  vscdbWritten?: boolean;
  /**
   * #2413 — Résultat de la validation post-apply si validate=true.
   *  - success=true => .roomodes aligné avec profile.modeOverrides
   *  - success=false => drift détecté (liste détaillée dans drift)
   *  - activeApiConfigInSync indique si state.vscdb.currentApiConfigName correspond
   *    au profil attendu (undefined si state.vscdb non lisible)
   */
  validation?: {
    performed: boolean;
    success: boolean;
    drift?: Array<{ field: string; expected: any; actual: any }>;
    activeApiConfigName?: string;
    activeApiConfigInSync?: boolean;
  };
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