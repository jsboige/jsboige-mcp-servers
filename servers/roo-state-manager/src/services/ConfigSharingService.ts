import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { ConfigNormalizationService } from './ConfigNormalizationService.js';
import { ConfigDiffService } from './ConfigDiffService.js';
import { JsonMerger } from '../utils/JsonMerger.js';
import {
  IConfigSharingService,
  CollectConfigOptions,
  CollectConfigResult,
  PublishConfigOptions,
  PublishConfigResult,
  ApplyConfigOptions,
  ApplyConfigResult,
  ConfigManifest,
  ConfigManifestFile,
  DiffResult
} from '../types/config-sharing.js';
import { IInventoryCollector, IConfigService } from '../types/baseline.js';
import { createLogger, Logger } from '../utils/logger.js';

export class ConfigSharingService implements IConfigSharingService {
  private logger: Logger;
  private normalizationService: ConfigNormalizationService;
  private diffService: ConfigDiffService;

  constructor(
    private configService: IConfigService,
    private inventoryCollector: IInventoryCollector
  ) {
    this.logger = createLogger('ConfigSharingService');
    this.normalizationService = new ConfigNormalizationService();
    this.diffService = new ConfigDiffService();
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
    
    const errors: string[] = [];
    let filesApplied = 0;
    const details: any[] = []; // Pour stocker les détails des changements

    try {
      // 1. Localiser la version source
      if (!options.version) {
        throw new Error('La version de configuration est requise');
      }

      const sharedStatePath = this.configService.getSharedStatePath();
      const configDir = join(sharedStatePath, 'configs', `baseline-v${options.version}`);
      const manifestPath = join(configDir, 'manifest.json');

      if (!existsSync(manifestPath)) {
        throw new Error(`Configuration non trouvée: ${options.version}`);
      }

      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest: ConfigManifest = JSON.parse(manifestContent);

      this.logger.info(`Configuration chargée: ${manifest.description} (v${manifest.version})`);

      // Récupérer l'inventaire pour résoudre les chemins locaux
      const inventory = await this.inventoryCollector.collectInventory(process.env.COMPUTERNAME || 'localhost') as any;

      // 2. Itérer sur les fichiers
      for (const file of manifest.files) {
        try {
          // Résolution du chemin source et destination
          const sourcePath = join(configDir, file.path);
          let destPath: string | null = null;

          if (file.path.startsWith('roo-modes/')) {
            const fileName = basename(file.path);
            const rooModesPath = inventory?.paths?.rooExtensions
              ? join(inventory.paths.rooExtensions, 'roo-modes')
              : join(process.cwd(), 'roo-modes');
            destPath = join(rooModesPath, fileName);
          } else if (file.path === 'mcp-settings/mcp_settings.json') {
            destPath = inventory?.paths?.mcpSettings || join(process.cwd(), 'config', 'mcp_settings.json');
          } else {
            this.logger.warn(`Type de fichier non supporté ou chemin inconnu: ${file.path}`);
            continue;
          }

          if (!destPath) continue;

          // Lecture du contenu source
          const sourceContent = JSON.parse(await fs.readFile(sourcePath, 'utf-8'));

          // Gestion du contenu local existant
          let finalContent = sourceContent;
          let action = 'create';

          if (existsSync(destPath)) {
            action = 'update';
            const localContent = JSON.parse(await fs.readFile(destPath, 'utf-8'));
            
            // Fusion
            finalContent = JsonMerger.merge(sourceContent, localContent, { arrayStrategy: 'replace' });

            // Backup si non dryRun
            if (!options.dryRun) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = `${destPath}.backup_${timestamp}`;
                await fs.copyFile(destPath, backupPath);
                this.logger.info(`Backup créé: ${backupPath}`);
            }
          }

          details.push({
            file: file.path,
            dest: destPath,
            action,
            size: JSON.stringify(finalContent).length
          });

          // Écriture ou simulation
          if (!options.dryRun) {
            // S'assurer que le répertoire parent existe
            await fs.mkdir(dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, JSON.stringify(finalContent, null, 2));
            filesApplied++;
          }

        } catch (err: any) {
          const errorMsg = `Erreur lors du traitement de ${file.path}: ${err.message}`;
          this.logger.error(errorMsg);
          errors.push(errorMsg);
        }
      }

    } catch (err: any) {
      const errorMsg = `Erreur globale applyConfig: ${err.message}`;
      this.logger.error(errorMsg);
      errors.push(errorMsg);
    }

    if (options.dryRun) {
        this.logger.info('DryRun terminé', { details });
        return {
            success: errors.length === 0,
            filesApplied: 0, // 0 car rien n'a été écrit
            errors,
            dryRunDetails: details // Champ hypothétique ajouté au résultat pour le rapport
        } as any;
    }

    return {
      success: errors.length === 0,
      filesApplied,
      errors
    };
  }

  /**
   * Compare la configuration locale avec une baseline
   */
  public async compareWithBaseline(config: any): Promise<DiffResult> {
    this.logger.info('Comparaison avec la baseline');

    // 1. Charger la baseline (si elle existe)
    // Pour l'instant, on simule une baseline vide ou on pourrait la charger depuis le shared state
    // Dans une implémentation réelle, on récupérerait la dernière baseline publiée
    const baseline = {};

    // 2. Normaliser la config locale
    // On suppose que 'config' est déjà un objet de configuration (ex: mcp_settings)
    // Il faudrait idéalement savoir quel type de config on compare pour appliquer la bonne normalisation
    // Pour simplifier ici, on normalise comme 'mcp_config' par défaut si structure correspond, sinon générique
    
    let normalizedConfig = config;
    if (config.mcpServers) {
        normalizedConfig = await this.normalizationService.normalize(config, 'mcp_config');
    }

    // 3. Appeler ConfigDiffService.compare
    return this.diffService.compare(baseline, normalizedConfig);
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
          
          // Lecture et normalisation
          const content = JSON.parse(await fs.readFile(srcPath, 'utf-8'));
          const normalized = await this.normalizationService.normalize(content, 'mode_definition');
          
          // Écriture du fichier normalisé
          await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));
          
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
      
      // Lecture et normalisation
      const content = JSON.parse(await fs.readFile(mcpSettingsPath, 'utf-8'));
      const normalized = await this.normalizationService.normalize(content, 'mcp_config');
      
      // Écriture du fichier normalisé
      await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

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