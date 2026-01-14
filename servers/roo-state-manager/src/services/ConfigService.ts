/**
 * ConfigService - Service de gestion de la configuration
 *
 * Service responsable de la gestion des configurations RooSync,
 * y compris les chemins, les paramètres et la configuration du service.
 *
 * @module ConfigService
 * @version 2.1.0
 */
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config-service');

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { IConfigService, BaselineServiceConfig } from '../types/baseline.js';
import { getSharedStatePath } from '../utils/server-helpers.js';
import { readJSONFileWithoutBOM } from '../utils/encoding-helpers.js';
import {
  ConfigServiceError,
  ConfigServiceErrorCode
} from '../types/errors.js';

// Utiliser une approche compatible avec les tests
// En environnement de test, nous utilisons process.cwd() comme fallback
const _dirname = process.cwd();

/**
 * Implémentation du service de configuration
 */
export class ConfigService implements IConfigService {
  private configPath: string;
  private sharedStatePath: string;
  private baselineServiceConfig: BaselineServiceConfig;

  constructor(configPath?: string) {
    // Déterminer le chemin de configuration
    this.configPath = configPath || this.findConfigPath();
    this.sharedStatePath = this.findSharedStatePath();

    this.baselineServiceConfig = {
      baselinePath: join(this.sharedStatePath, 'sync-config.ref.json'),
      roadmapPath: join(this.sharedStatePath, 'sync-roadmap.md'),
      cacheEnabled: true,
      cacheTTL: 3600000, // 1 heure
      logLevel: 'INFO'
    };
  }

  /**
   * Retourne la configuration du BaselineService
   */
  public getBaselineServiceConfig(): BaselineServiceConfig {
    return { ...this.baselineServiceConfig };
  }

  /**
   * Retourne le chemin du répertoire d'état partagé
   */
  public getSharedStatePath(): string {
    return this.sharedStatePath;
  }

  /**
   * Charge la configuration depuis un fichier
   * @throws {ConfigServiceError} Si le chargement échoue
   */
  public async loadConfig(): Promise<any> {
    try {
      if (!existsSync(this.configPath)) {
        logger.warn('Fichier de configuration non trouvé', { configPath: this.configPath });
        return {};
      }

      return await readJSONFileWithoutBOM<any>(this.configPath);
    } catch (error) {
      logger.error('Erreur lors du chargement de la configuration', error);

      if (error instanceof SyntaxError) {
        throw new ConfigServiceError(
          `Erreur de parsing JSON dans le fichier de configuration: ${error.message}`,
          ConfigServiceErrorCode.CONFIG_INVALID,
          { configPath: this.configPath },
          error
        );
      }

      throw new ConfigServiceError(
        `Erreur lors du chargement de la configuration: ${error instanceof Error ? error.message : String(error)}`,
        ConfigServiceErrorCode.CONFIG_LOAD_FAILED,
        { configPath: this.configPath },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Sauvegarde la configuration dans un fichier
   * @throws {ConfigServiceError} Si la sauvegarde échoue
   */
  public async saveConfig(config: any): Promise<boolean> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
      return true;
    } catch (error) {
      logger.error('Erreur lors de la sauvegarde de la configuration', error);

      throw new ConfigServiceError(
        `Erreur lors de la sauvegarde de la configuration: ${error instanceof Error ? error.message : String(error)}`,
        ConfigServiceErrorCode.CONFIG_SAVE_FAILED,
        { configPath: this.configPath },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Retourne la version de configuration actuelle depuis le fichier sync-config.json
   * @returns La version de configuration ou null si non disponible
   * @throws {ConfigServiceError} Si la lecture échoue
   */
  public async getConfigVersion(): Promise<string | null> {
    const syncConfigPath = join(this.sharedStatePath, 'sync-config.json');

    try {
      if (!existsSync(syncConfigPath)) {
        logger.warn('Fichier sync-config.json non trouvé', { syncConfigPath });
        return null;
      }
      const content = await fs.readFile(syncConfigPath, 'utf-8');
      const config = JSON.parse(content);
      return config.version || null;
    } catch (error) {
      logger.error('Erreur lors de la lecture de la version de configuration', error);

      if (error instanceof SyntaxError) {
        throw new ConfigServiceError(
          `Erreur de parsing JSON dans sync-config.json: ${error.message}`,
          ConfigServiceErrorCode.CONFIG_INVALID,
          { path: syncConfigPath },
          error
        );
      }

      throw new ConfigServiceError(
        `Erreur lors de la lecture de la version de configuration: ${error instanceof Error ? error.message : String(error)}`,
        ConfigServiceErrorCode.CONFIG_VERSION_READ_FAILED,
        { path: syncConfigPath },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Trouve le chemin de configuration Roo
   */
  private findConfigPath(): string {
    // Chercher dans plusieurs emplacements possibles
    const possiblePaths = [
      join(process.env.USERPROFILE || '', '.roo', 'config'),
      join(process.cwd(), 'roo-config'),
      join(_dirname, '../../../../roo-config'),
      process.env.ROO_ROOT ? join(process.env.ROO_ROOT, 'roo-config') : join(process.cwd(), 'roo-config')
    ];

    for (const path of possiblePaths) {
      try {
        if (existsSync(path)) {
          return join(path, 'settings.json');
        }
      } catch {
        continue;
      }
    }

    // Retourner le chemin par défaut
    return join(possiblePaths[1], 'settings.json');
  }

  /**
   * Trouve le chemin du répertoire d'état partagé
   * @throws {ConfigServiceError} Si aucun chemin valide n'est trouvé
   */
  private findSharedStatePath(): string {
    // Essayer d'utiliser la variable d'environnement ROOSYNC_SHARED_PATH
    if (process.env.ROOSYNC_SHARED_PATH) {
      const envPath = process.env.ROOSYNC_SHARED_PATH;
      if (existsSync(envPath)) {
        return envPath;
      }
      logger.warn('ROOSYNC_SHARED_PATH défini mais le répertoire n\'existe pas', { envPath });
    }

    // Fallback : utiliser le chemin par défaut dans le workspace
    const defaultPath = join(process.cwd(), 'roo-config');

    if (!existsSync(defaultPath)) {
      logger.warn('Chemin d\'état partagé par défaut non trouvé', { defaultPath });
      // On retourne quand même le chemin par défaut pour éviter de bloquer l'instanciation
      // Les méthodes qui utilisent ce chemin géreront l'erreur
    }

    return defaultPath;
  }
}