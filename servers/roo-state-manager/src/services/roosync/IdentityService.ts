import * as fs from 'fs/promises';
import * as path from 'path';

export interface IdentityValidationResult {
  machineId: string;
  sharedPath: string;
  checks: {
    registryFile: boolean;
    identityRegistry: boolean;
    presenceFiles: boolean;
    dashboardFile: boolean;
    configFiles: boolean;
  };
  details: {
    registry?: any;
    identities?: any;
    conflicts?: string[];
    presence?: any[];
    dashboard?: any;
  };
  logs: string[];
}

export class IdentityService {
  private static instance: IdentityService;

  private constructor() {}

  public static getInstance(): IdentityService {
    if (!IdentityService.instance) {
      IdentityService.instance = new IdentityService();
    }
    return IdentityService.instance;
  }

  public async validateIdentityProtection(sharedPath: string, machineId: string): Promise<IdentityValidationResult> {
    const logs: string[] = [];
    const log = (msg: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
      logs.push(`[${type.toUpperCase()}] ${msg}`);
    };

    const result: IdentityValidationResult = {
      machineId,
      sharedPath,
      checks: {
        registryFile: false,
        identityRegistry: false,
        presenceFiles: false,
        dashboardFile: false,
        configFiles: false
      },
      details: {},
      logs
    };

    try {
      if (!await this.fileExists(sharedPath)) {
        log(`Shared path does not exist: ${sharedPath}`, 'error');
        return result;
      }

      // 1. Registry File
      const registryFile = path.join(sharedPath, '.machine-registry.json');
      if (await this.fileExists(registryFile)) {
        result.checks.registryFile = true;
        try {
          const content = JSON.parse(await fs.readFile(registryFile, 'utf-8'));
          result.details.registry = content;
          log(`Machine registry found with ${Object.keys(content.machines || {}).length} machines`, 'success');
        } catch (e: any) {
          log(`Error reading machine registry: ${e.message}`, 'error');
        }
      } else {
        log('Machine registry not found', 'warn');
      }

      // 2. Identity Registry
      const identityFile = path.join(sharedPath, '.identity-registry.json');
      if (await this.fileExists(identityFile)) {
        result.checks.identityRegistry = true;
        try {
          const content = JSON.parse(await fs.readFile(identityFile, 'utf-8'));
          result.details.identities = content;
          
          const conflicts: string[] = [];
          if (content.identities) {
            for (const [mid, identity] of Object.entries(content.identities) as [string, any][]) {
              if (identity.status === 'conflict') {
                conflicts.push(mid);
              }
            }
          }
          result.details.conflicts = conflicts;
          
          if (conflicts.length > 0) {
            log(`Identity conflicts detected: ${conflicts.join(', ')}`, 'warn');
          } else {
            log('No identity conflicts detected', 'success');
          }
        } catch (e: any) {
          log(`Error reading identity registry: ${e.message}`, 'error');
        }
      } else {
        log('Identity registry not found', 'warn');
      }

      // 3. Presence Files
      const presenceDir = path.join(sharedPath, 'presence');
      if (await this.fileExists(presenceDir)) {
        result.checks.presenceFiles = true;
        try {
          const files = await fs.readdir(presenceDir);
          const presenceFiles = files.filter(f => f.endsWith('.json'));
          
          const machineIds: string[] = [];
          const presenceData: any[] = [];
          
          for (const file of presenceFiles) {
            try {
              const content = JSON.parse(await fs.readFile(path.join(presenceDir, file), 'utf-8'));
              machineIds.push(content.id);
              presenceData.push({ file, ...content });
            } catch (e: any) {
              log(`Error reading presence file ${file}: ${e.message}`, 'error');
            }
          }
          
          result.details.presence = presenceData;
          log(`${presenceFiles.length} presence files found`, 'success');

          // Check uniqueness
          const uniqueIds = new Set(machineIds);
          if (uniqueIds.size !== machineIds.length) {
            log('Duplicate machine IDs found in presence files', 'warn');
          }
        } catch (e: any) {
          log(`Error scanning presence directory: ${e.message}`, 'error');
        }
      } else {
        log('Presence directory not found', 'warn');
      }

      // 4. Dashboard File
      const dashboardFile = path.join(sharedPath, 'sync-dashboard.json');
      if (await this.fileExists(dashboardFile)) {
        result.checks.dashboardFile = true;
        try {
          const content = JSON.parse(await fs.readFile(dashboardFile, 'utf-8'));
          result.details.dashboard = content;
          log('Dashboard file found and valid', 'success');
        } catch (e: any) {
          log(`Error reading dashboard file: ${e.message}`, 'error');
        }
      } else {
        log('Dashboard file not found', 'warn');
      }

      // 5. Configuration Files
      const syncConfigFile = path.join(sharedPath, 'sync-config.json');
      if (await this.fileExists(syncConfigFile)) {
        result.checks.configFiles = true;
        try {
          const content = JSON.parse(await fs.readFile(syncConfigFile, 'utf-8'));
          if (content.machineId === machineId) {
             log('sync-config.json matches machine ID', 'success');
          } else {
             log(`sync-config.json mismatch: expected ${machineId}, got ${content.machineId}`, 'warn');
          }
        } catch (e: any) {
          log(`Error reading sync-config.json: ${e.message}`, 'error');
        }
      }

    } catch (e: any) {
      log(`Unexpected error during validation: ${e.message}`, 'error');
    }

    return result;
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}