/**
 * Types pour le service de configuration partagée (ConfigSharingService)
 */

export interface ConfigManifestFile {
  path: string;
  hash: string;
  type: 'mode_definition' | 'mcp_config' | 'profile_settings' | 'other';
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
  targets: ('modes' | 'mcp' | 'profiles')[];
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
}

export interface PublishConfigResult {
  success: boolean;
  version: string;
  path: string;
}

export interface ApplyConfigOptions {
  version?: string; // Défaut: latest
  targets?: ('modes' | 'mcp' | 'profiles')[];
  backup?: boolean; // Défaut: true
  dryRun?: boolean;
}

export interface ApplyConfigResult {
  success: boolean;
  filesApplied: number;
  backupPath?: string;
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
  compareWithBaseline(config: any): Promise<DiffResult>;
}