import { homedir } from 'os';
import { join, sep, isAbsolute, normalize } from 'path';

export type ConfigType = 'mcp_config' | 'mode_definition' | 'profile_settings' | 'roomodes_config' | 'model_config' | 'rules_config';

export interface MachineContext {
  os: 'windows' | 'linux' | 'darwin';
  homeDir: string;
  rooRoot: string;
  envVars?: Record<string, string>;
}

export interface INormalizationService {
  normalize(content: any, type: ConfigType): Promise<any>;
  denormalize(content: any, type: ConfigType, context: MachineContext): Promise<any>;
}

export class ConfigNormalizationService implements INormalizationService {
  private readonly SENSITIVE_KEYS = ['apiKey', 'token', 'password', 'secret', 'key', 'auth'];
  private readonly HOME_PLACEHOLDER = '%USERPROFILE%'; // Standardisé pour Windows/Linux dans le JSON
  private readonly ROOT_PLACEHOLDER = '%ROO_ROOT%';
  private readonly contextOverride?: MachineContext;

  constructor(contextOverride?: MachineContext) {
    this.contextOverride = contextOverride;
  }

  /**
   * Normalise une configuration pour le partage
   */
  public async normalize(content: any, type: ConfigType): Promise<any> {
    const context = this.contextOverride || this.getCurrentContext();
    return this.processObject(content, context, 'normalize');
  }

  /**
   * Dénormalise une configuration pour l'application locale
   */
  public async denormalize(content: any, type: ConfigType, context: MachineContext): Promise<any> {
    return this.processObject(content, context, 'denormalize');
  }

  private getCurrentContext(): MachineContext {
    return {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
      homeDir: homedir(),
      rooRoot: process.cwd(), // Supposé être la racine de l'extension ou du workspace
      envVars: process.env as Record<string, string>
    };
  }

  private processObject(obj: any, context: MachineContext, mode: 'normalize' | 'denormalize'): any {
    if (obj === null || typeof obj !== 'object') {
      return this.processValue(obj, context, mode);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.processObject(item, context, mode));
    }

    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Gestion des secrets
      if (this.isSensitiveKey(key)) {
        if (mode === 'normalize') {
          // Si la valeur est déjà un placeholder de secret, on la laisse telle quelle
          if (typeof value === 'string' && value.startsWith('{{SECRET:') && value.endsWith('}}')) {
             result[key] = value;
          } else {
             result[key] = `{{SECRET:${key}}}`;
          }
        } else {
          // En mode dénormalisation, on garde le placeholder si on n'a pas de valeur de remplacement
          // TODO: Implémenter la récupération depuis une config locale existante si nécessaire
          result[key] = value; 
        }
        continue;
      }

      result[key] = this.processObject(value, context, mode);
    }
    return result;
  }

  private processValue(value: any, context: MachineContext, mode: 'normalize' | 'denormalize'): any {
    if (typeof value !== 'string') {
      return value;
    }

    if (mode === 'normalize') {
      return this.normalizePath(value, context);
    } else {
      return this.denormalizePath(value, context);
    }
  }

  private normalizePath(value: string, context: MachineContext): string {
    // Helper: convertir tous les backslashes en forward slashes (indépendant de la plateforme)
    const toForwardSlash = (s: string) => s.replace(/\\/g, '/');

    // 1. Préservation des variables d'environnement existantes (ex: %APPDATA%)
    // On ne touche pas si ça ressemble déjà à une variable d'env Windows ou Unix
    if (/%[A-Z_]+%/.test(value) || /\$[A-Z_]+/.test(value)) {
        // On normalise juste les slashes
        return toForwardSlash(value);
    }

    // 2. Normalisation des séparateurs vers '/'
    let normalized = toForwardSlash(value);

    // 3. Normalisation du Home Directory
    const homeDir = toForwardSlash(context.homeDir);
    // Regex insensible à la casse pour Windows
    const homeRegex = new RegExp('^' + this.escapeRegExp(homeDir), context.os === 'windows' ? 'i' : '');

    if (homeRegex.test(normalized)) {
      normalized = normalized.replace(homeRegex, this.HOME_PLACEHOLDER);
    }

    // 4. Normalisation du Roo Root
    const rooRoot = toForwardSlash(context.rooRoot);
    const rootRegex = new RegExp('^' + this.escapeRegExp(rooRoot), context.os === 'windows' ? 'i' : '');

    if (rootRegex.test(normalized)) {
      normalized = normalized.replace(rootRegex, this.ROOT_PLACEHOLDER);
    }

    return normalized;
  }

  private denormalizePath(value: string, context: MachineContext): string {
    let denormalized = value;

    // 1. Remplacement des placeholders (toujours convertir backslashes pour cohérence)
    if (denormalized.includes(this.HOME_PLACEHOLDER)) {
      const homeDir = context.homeDir.replace(/\\/g, '/');
      denormalized = denormalized.replace(this.HOME_PLACEHOLDER, homeDir);
    }

    if (denormalized.includes(this.ROOT_PLACEHOLDER)) {
      const rooRoot = context.rooRoot.replace(/\\/g, '/');
      denormalized = denormalized.replace(this.ROOT_PLACEHOLDER, rooRoot);
    }

    // 2. Adaptation des séparateurs à l'OS cible
    if (context.os === 'windows') {
      denormalized = denormalized.split('/').join('\\');
    } else {
      denormalized = denormalized.split('\\').join('/');
    }

    return denormalized;
  }

  private isSensitiveKey(key: string): boolean {
    return this.SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k.toLowerCase()));
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}