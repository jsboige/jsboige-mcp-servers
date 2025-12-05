import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import {
  IConfigSharingService,
  CollectConfigOptions,
  CollectConfigResult,
  PublishConfigOptions,
  PublishConfigResult,
  ApplyConfigOptions,
  ApplyConfigResult,
  ConfigManifest,
  ConfigManifestFile
} from '../types/config-sharing.js';
import { IInventoryCollector, IConfigService } from '../types/baseline.js';
import { createLogger, Logger } from '../utils/logger.js';

export class ConfigSharingService implements IConfigSharingService {
  private logger: Logger;

  constructor(
    private configService: IConfigService,
    private inventoryCollector: IInventoryCollector
  ) {
    this.logger = createLogger('ConfigSharingService');
  }

  /**
   * Collecte la configuration locale
   */
  public async collectConfig(options: CollectConfigOptions): Promise<CollectConfigResult> {
    this.logger.info('Début de la collecte de configuration', options);

    const tempDir = join(process.cwd(), 'temp', `config-collect-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const manifest: ConfigManifest = {
      version: '0.0.0', // Sera défini lors de la publication
      timestamp: new Date().toISOString(),
      author: process.env.COMPUTERNAME || 'unknown',
      description: options.description || 'Collecte automatique',
      files: []
    };

    let totalSize = 0;

    // Collecte des modes
    if (options.targets.includes('modes')) {
      const modesFiles = await this.collectModes(tempDir);
      manifest.files.push(...modesFiles);
    }

    // Collecte des MCPs
    if (options.targets.includes('mcp')) {
      const mcpFiles = await this.collectMcpSettings(tempDir);
      manifest.files.push(...mcpFiles);
    }

    // Collecte des profils
    if (options.targets.includes('profiles')) {
      const profileFiles = await this.collectProfiles(tempDir);
      manifest.files.push(...profileFiles);
    }

    // Calcul de la taille totale
    for (const file of manifest.files) {
      totalSize += file.size;
    }

    // Écriture du manifeste temporaire
    await fs.writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    this.logger.info('Collecte terminée', { filesCount: manifest.files.length, totalSize });

    return {
      packagePath: tempDir,
      manifest,
      filesCount: manifest.files.length,
      totalSize
    };
  }

  /**
   * Publie la configuration vers le shared state
   */
  public async publishConfig(options: PublishConfigOptions): Promise<PublishConfigResult> {
    this.logger.info('Publication de la configuration', options);

    const sharedStatePath = this.configService.getSharedStatePath();
    const configsDir = join(sharedStatePath, 'configs');
    const versionDir = join(configsDir, `baseline-v${options.version}`);

    if (existsSync(versionDir)) {
      this.logger.warn(`La version ${options.version} existe déjà, elle sera écrasée.`);
    }

    await fs.mkdir(versionDir, { recursive: true });

    // Copie des fichiers depuis le package temporaire
    await this.copyRecursive(options.packagePath, versionDir);

    // Mise à jour du manifeste avec la version finale
    const manifestPath = join(versionDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest: ConfigManifest = JSON.parse(manifestContent);
    
    manifest.version = options.version;
    manifest.description = options.description;
    
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    this.logger.info('Publication terminée', { path: versionDir });

    return {
      success: true,
      version: options.version,
      path: versionDir
    };
  }

  /**
   * Applique une configuration depuis le shared state
   */
  public async applyConfig(options: ApplyConfigOptions): Promise<ApplyConfigResult> {
    this.logger.info('Application de la configuration', options);
    
    // TODO: Implémenter la logique d'application
    // 1. Localiser la version source
    // 2. Créer un backup
    // 3. Appliquer les fichiers
    
    return {
      success: false,
      filesApplied: 0,
      errors: ['Not implemented yet']
    };
  }

  // Méthodes privées de collecte

  private async collectModes(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const modesDir = join(tempDir, 'roo-modes');
    await fs.mkdir(modesDir, { recursive: true });

    // Récupérer l'inventaire pour trouver les chemins
    const inventory = await this.inventoryCollector.collectInventory(process.env.COMPUTERNAME || 'localhost') as any;
    
    // Essayer de trouver le chemin des modes
    let rooModesPath = join(process.cwd(), 'roo-modes');
    
    if (inventory?.paths?.rooExtensions) {
      rooModesPath = join(inventory.paths.rooExtensions, 'roo-modes');
    }

    this.logger.info(`Collecte des modes depuis: ${rooModesPath}`);

    if (existsSync(rooModesPath)) {
      const entries = await fs.readdir(rooModesPath);
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          const srcPath = join(rooModesPath, entry);
          const destPath = join(modesDir, entry);
          
          await fs.copyFile(srcPath, destPath);
          const hash = await this.calculateHash(destPath);
          const stats = await fs.stat(destPath);
          
          files.push({
            path: `roo-modes/${entry}`,
            hash,
            type: 'mode_definition',
            size: stats.size
          });
        }
      }
    } else {
        this.logger.warn(`Répertoire roo-modes non trouvé: ${rooModesPath}`);
    }

    return files;
  }

  private async collectMcpSettings(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const mcpDir = join(tempDir, 'mcp-settings');
    await fs.mkdir(mcpDir, { recursive: true });

    // Récupérer l'inventaire pour trouver les chemins
    const inventory = await this.inventoryCollector.collectInventory(process.env.COMPUTERNAME || 'localhost') as any;
    
    let mcpSettingsPath = join(process.cwd(), 'config', 'mcp_settings.json');
    
    if (inventory?.paths?.mcpSettings) {
      mcpSettingsPath = inventory.paths.mcpSettings;
    }

    this.logger.info(`Collecte des settings MCP depuis: ${mcpSettingsPath}`);

    if (existsSync(mcpSettingsPath)) {
      const destPath = join(mcpDir, 'mcp_settings.json');
      await fs.copyFile(mcpSettingsPath, destPath);
      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);
      
      files.push({
        path: 'mcp-settings/mcp_settings.json',
        hash,
        type: 'mcp_config',
        size: stats.size
      });
    } else {
        this.logger.warn(`Fichier mcp_settings.json non trouvé: ${mcpSettingsPath}`);
    }

    return files;
  }

  private async collectProfiles(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const profilesDir = join(tempDir, 'profiles');
    await fs.mkdir(profilesDir, { recursive: true });

    // TODO: Implémenter la collecte Profils (structure à définir)
    return files;
  }

  // Utilitaires

  private async copyRecursive(src: string, dest: string) {
    const stats = await fs.stat(src);
    if (stats.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      const entries = await fs.readdir(src);
      for (const entry of entries) {
        await this.copyRecursive(join(src, entry), join(dest, entry));
      }
    } else {
      await fs.copyFile(src, dest);
    }
  }

  private async calculateHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }
}