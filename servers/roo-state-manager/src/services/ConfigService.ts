/**
 * ConfigService - Service de gestion de la configuration
 * 
 * Service responsable de la gestion des configurations RooSync,
 * y compris les chemins, les paramètres et la configuration du service.
 * 
 * @module ConfigService
 * @version 2.1.0
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { IConfigService, BaselineServiceConfig } from '../types/baseline.js';

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
   */
  public async loadConfig(): Promise<any> {
    try {
      if (!existsSync(this.configPath)) {
        return {};
      }
      
      const content = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Erreur lors du chargement de la configuration:', error);
      return {};
    }
  }

  /**
   * Sauvegarde la configuration dans un fichier
   */
  public async saveConfig(config: any): Promise<boolean> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
      return true;
    } catch (error) {
      console.error('Erreur lors de la sauvegarde de la configuration:', error);
      return false;
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
      'C:/dev/roo-extensions/roo-config'
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
    return join(possiblePaths[3], 'settings.json');
  }

  /**
   * Trouve le chemin du répertoire d'état partagé
   */
  private findSharedStatePath(): string {
    // Chercher dans plusieurs emplacements possibles
    const possiblePaths = [
      process.env.SHARED_STATE_PATH,
      join(process.env.USERPROFILE || '', '.roo', '.shared-state'),
      join(process.cwd(), '.shared-state'),
      join(_dirname, '../../../../.shared-state'),
      'g:/Mon Drive/Synchronisation/RooSync/.shared-state'
    ].filter(Boolean);

    for (const path of possiblePaths) {
      try {
        if (existsSync(path as string)) {
          return path as string;
        }
      } catch {
        continue;
      }
    }

    // Retourner le chemin par défaut
    return possiblePaths[0] as string;
  }
}