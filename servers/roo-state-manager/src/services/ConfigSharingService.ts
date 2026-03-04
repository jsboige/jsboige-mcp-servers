import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { ConfigNormalizationService } from './ConfigNormalizationService.js';
import { ConfigDiffService } from './ConfigDiffService.js';
import { JsonMerger } from '../utils/JsonMerger.js';
import { RooSettingsService } from './RooSettingsService.js';
import { IConfigSharingService,
   CollectConfigOptions,
   CollectConfigResult,
   PublishConfigOptions,
   PublishConfigResult,
   ApplyConfigOptions,
   ApplyConfigResult,
   ApplyProfileOptions,
   ApplyProfileResult,
   ConfigManifest,
   ConfigManifestFile,
   DiffResult
} from '../types/config-sharing.js';
import { IInventoryCollector, IConfigService } from '../types/baseline.js';
import { createLogger, Logger } from '../utils/logger.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../types/errors.js';
import { InventoryService } from './roosync/InventoryService.js';
import { readJSONFileWithoutBOM } from '../utils/encoding-helpers.js';

export class ConfigSharingService implements IConfigSharingService {
  private logger: Logger;
  private normalizationService: ConfigNormalizationService;
  private diffService: ConfigDiffService;
  private inventoryService: InventoryService;

  constructor(
    private configService: IConfigService,
    private inventoryCollector: IInventoryCollector
  ) {
    this.logger = createLogger('ConfigSharingService');
    this.normalizationService = new ConfigNormalizationService();
    this.diffService = new ConfigDiffService();
    this.inventoryService = InventoryService.getInstance();
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
    const mcpTargets = options.targets.filter(t => t.startsWith('mcp:'));
    if (options.targets.includes('mcp') || mcpTargets.length > 0) {
      const mcpServerNames = mcpTargets.map(t => t.slice(4));
      const mcpFiles = await this.collectMcpSettings(tempDir, mcpServerNames);
      manifest.files.push(...mcpFiles);
    }

    // Collecte des profils
    if (options.targets.includes('profiles')) {
      const profileFiles = await this.collectProfiles(tempDir);
      manifest.files.push(...profileFiles);
    }

    // Collecte du .roomodes (workspace root)
    if (options.targets.includes('roomodes')) {
      const roomodesFiles = await this.collectRoomodes(tempDir);
      manifest.files.push(...roomodesFiles);
    }

    // Collecte du model-configs.json
    if (options.targets.includes('model-configs')) {
      const modelConfigFiles = await this.collectModelConfigs(tempDir);
      manifest.files.push(...modelConfigFiles);
    }

    // Collecte des rules globales
    if (options.targets.includes('rules')) {
      const rulesFiles = await this.collectRules(tempDir);
      manifest.files.push(...rulesFiles);
    }

    // Collecte des settings Roo (condensation, etc.) - Issue #509
    if (options.targets.includes('settings')) {
      const settingsFiles = await this.collectSettings(tempDir);
      manifest.files.push(...settingsFiles);
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
   * CORRECTION SDDD : Stocke les configs par machineId pour éviter les écrasements
   */
  public async publishConfig(options: PublishConfigOptions): Promise<PublishConfigResult> {
    this.logger.info('Publication de la configuration', options);

    const sharedStatePath = this.configService.getSharedStatePath();
    const configsDir = join(sharedStatePath, 'configs');

    // CORRECTION SDDD : Utiliser machineId au lieu de version pour le répertoire
    const machineId = options.machineId || process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown';
    const machineConfigDir = join(configsDir, machineId);

    // Créer un sous-répertoire versionné pour l'historique
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const versionDir = join(machineConfigDir, `v${options.version}-${timestamp}`);

    if (existsSync(versionDir)) {
      this.logger.warn(`La version ${options.version} existe déjà pour ${machineId}, elle sera écrasée.`);
    }

    await fs.mkdir(versionDir, { recursive: true });

    // Copie des fichiers depuis le package temporaire
    await this.copyRecursive(options.packagePath, versionDir);

    // Mise à jour du manifeste avec la version finale et le machineId
    const manifestPath = join(versionDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest: ConfigManifest = JSON.parse(manifestContent);

    manifest.version = options.version;
    manifest.description = options.description;
    manifest.author = machineId; // CORRECTION SDDD : Utiliser machineId explicite

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // CORRECTION SDDD : Créer un lien symbolique ou fichier latest pour accès facile
    const latestPath = join(machineConfigDir, 'latest.json');
    await fs.writeFile(latestPath, JSON.stringify({
      version: options.version,
      timestamp,
      path: versionDir,
      manifest
    }, null, 2));

    this.logger.info('Publication terminée', { machineId, version: options.version, path: versionDir });

    return {
      success: true,
      version: options.version,
      path: versionDir,
      machineId // CORRECTION SDDD : Retourner le machineId utilisé
    };
  }

  /**
   * Applique une configuration depuis le shared state
   * CORRECTION SDDD : Supporte les configs par machineId
   */
  public async applyConfig(options: ApplyConfigOptions): Promise<ApplyConfigResult> {
    this.logger.info('Application de la configuration', options);

    const errors: string[] = [];
    let filesApplied = 0;
    const details: any[] = []; // Pour stocker les détails des changements

    try {
      // 1. Localiser la version source
      // Fix Bug #296: Utiliser "latest" par défaut si version non spécifiée
      const version = options.version || 'latest';
      options = { ...options, version };

      const sharedStatePath = this.configService.getSharedStatePath();
      const configsDir = join(sharedStatePath, 'configs');

      // CORRECTION SDDD : Supporter le format {machineId}/v{version}-{timestamp}
      let configDir: string | null = null;
      let manifestPath: string | null = null;

      // Essayer d'abord le nouveau format par machineId
      const machineId = options.machineId || process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown';
      const machineConfigDir = join(configsDir, machineId);

      if (existsSync(machineConfigDir)) {
        // Chercher le fichier latest.json
        const latestPath = join(machineConfigDir, 'latest.json');
        if (existsSync(latestPath) && options.version === 'latest') {
          const latestContent = await fs.readFile(latestPath, 'utf-8');
          const latestData = JSON.parse(latestContent);
          configDir = latestData.path;
          manifestPath = join(latestData.path, 'manifest.json');
        } else {
          // Chercher la version spécifique
          const entries = await fs.readdir(machineConfigDir);
          const versionEntry = entries.find(e => e.startsWith(`v${options.version}-`));
          if (versionEntry) {
            configDir = join(machineConfigDir, versionEntry);
            manifestPath = join(configDir, 'manifest.json');
          }
        }
      }

      // Fallback vers l'ancien format baseline-v{version}
      if (!configDir || !manifestPath) {
        const legacyDir = join(configsDir, `baseline-v${options.version}`);
        if (existsSync(legacyDir)) {
          configDir = legacyDir;
          manifestPath = join(configDir, 'manifest.json');
        }
      }

      if (!configDir || !manifestPath) {
        throw new ConfigSharingServiceError(
          `Configuration non trouvée: ${options.version} (machineId: ${machineId})`,
          ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
          { version: options.version, machineId }
        );
      }

      if (!existsSync(manifestPath)) {
        throw new ConfigSharingServiceError(
          `Manifeste non trouvé: ${manifestPath}`,
          ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
          { manifestPath, version: options.version }
        );
      }

      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest: ConfigManifest = JSON.parse(manifestContent);

      this.logger.info(`Configuration chargée: ${manifest.description} (v${manifest.version}, machineId: ${manifest.author})`);

      // Récupérer l'inventaire pour résoudre les chemins locaux
      // CORRECTION SDDD : Utiliser InventoryService pour charger l'inventaire depuis le fichier JSON
      // CORRECTION T2.16 : Utiliser ROOSYNC_MACHINE_ID au lieu de COMPUTERNAME
      // CORRECTION Bug collect_config : Appeler sans argument pour forcer collecte locale
      const localMachineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
      const inventory = await this.inventoryService.getMachineInventory() as any;

      // CORRECTION T2.16 : Vérifier que les chemins requis sont disponibles (harmonisation avec collectModes/collectMcpSettings)
      if (!inventory?.paths?.rooExtensions) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.rooExtensions non disponible. Impossible d\'appliquer la configuration.',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { machineId: localMachineId, missingPath: 'rooExtensions' }
        );
      }

      if (!inventory?.paths?.mcpSettings) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.mcpSettings non disponible. Impossible d\'appliquer la configuration.',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { machineId: localMachineId, missingPath: 'mcpSettings' }
        );
      }

      // Issue #349: Extraire les targets de type mcp:xxx pour le filtrage granulaire
      const mcpTargets = options.targets?.filter(t => t.startsWith('mcp:')) || [];
      const mcpServerNames = mcpTargets.map(t => t.slice(4));
      const hasMcpTargets = mcpServerNames.length > 0;
      const hasMcpTarget = options.targets?.includes('mcp') || false;
      const hasModesTarget = options.targets?.includes('modes') || false;
      const hasProfilesTarget = options.targets?.includes('profiles') || false;
      const hasRoomodesTarget = options.targets?.includes('roomodes') || false;
      const hasModelConfigsTarget = options.targets?.includes('model-configs') || false;
      const hasRulesTarget = options.targets?.includes('rules') || false;
      const hasSettingsTarget = options.targets?.includes('settings') || false;

      // Si aucun target n'est spécifié, tout appliquer par défaut
      const applyAll = options.targets === undefined || options.targets.length === 0;

      this.logger.info('Targets de configuration', {
        applyAll,
        hasMcpTarget,
        hasModesTarget,
        hasProfilesTarget,
        hasRoomodesTarget,
        hasModelConfigsTarget,
        hasRulesTarget,
        hasSettingsTarget,
        mcpServerNames
      });

      // 2. Itérer sur les fichiers
      for (const file of manifest.files) {
        try {
          // Issue #349: Filtrage basé sur les targets
          let shouldProcess = false;
          
          if (applyAll) {
            shouldProcess = true;
          } else if (file.path.startsWith('roo-modes/')) {
            shouldProcess = hasModesTarget;
          } else if (file.path === 'mcp-settings/mcp_settings.json') {
            shouldProcess = hasMcpTarget || hasMcpTargets;
          } else if (file.path.startsWith('profiles/')) {
            shouldProcess = hasProfilesTarget;
          } else if (file.path.startsWith('roomodes/')) {
            shouldProcess = hasRoomodesTarget;
          } else if (file.path.startsWith('model-configs/')) {
            shouldProcess = hasModelConfigsTarget;
          } else if (file.path.startsWith('rules/')) {
            shouldProcess = hasRulesTarget;
          } else if (file.path.startsWith('roo-settings/')) {
            shouldProcess = hasSettingsTarget;
          }

          if (!shouldProcess) {
            this.logger.debug(`Fichier ignoré (ne correspond pas aux targets): ${file.path}`);
            continue;
          }

          // Résolution du chemin source et destination
          const sourcePath = join(configDir, file.path);
          let destPath: string | null = null;

          // CORRECTION T2.16 : Utiliser uniquement les chemins de l'inventaire (pas de fallback process.cwd())
          if (file.path.startsWith('roo-modes/')) {
            const fileName = basename(file.path);
            const rooModesPath = join(inventory.paths.rooExtensions, 'roo-modes');
            destPath = join(rooModesPath, fileName);
          } else if (file.path === 'mcp-settings/mcp_settings.json') {
            // Vérifier si on doit traiter ce fichier MCP
            // Si on a des targets mcp:<nomServeur> mais pas de target 'mcp', on filtre
            if (hasMcpTargets && !hasMcpTarget) {
              // On ne traite que les serveurs spécifiés
              this.logger.info(`Filtrage des serveurs MCP: ${mcpServerNames.join(', ')}`);
            } else if (!hasMcpTarget && !hasMcpTargets) {
              // Pas de target MCP, on saute ce fichier
              this.logger.info('Pas de target MCP, fichier mcp_settings.json ignoré');
              continue;
            }
            destPath = inventory.paths.mcpSettings;
          } else if (file.path.startsWith('roomodes/')) {
            // .roomodes -> workspace root
            destPath = join(inventory.paths.rooExtensions, '.roomodes');
          } else if (file.path.startsWith('model-configs/')) {
            // model-configs.json -> roo-config/model-configs.json
            destPath = join(inventory.paths.rooExtensions, 'roo-config', 'model-configs.json');
          } else if (file.path.startsWith('rules/')) {
            // rules/*.md -> ~/.roo/rules/{filename}
            const fileName = basename(file.path);
            const rulesDir = join(homedir(), '.roo', 'rules');
            destPath = join(rulesDir, fileName);
          } else if (file.path.startsWith('roo-settings/')) {
            // roo-settings/*.json -> state.vscdb (SQLite)
            // Special handling: destPath is the state.vscdb file
            destPath = join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb');
          } else {
            this.logger.warn(`Type de fichier non supporté ou chemin inconnu: ${file.path}`);
            continue;
          }

          if (!destPath) continue;

          // Traitement spécial pour les settings Roo (state.vscdb SQLite) - Issue #509, #547
          const isSettingsFile = file.type === 'roo_settings';
          if (isSettingsFile) {
            const rawContent = JSON.parse(await fs.readFile(sourcePath, 'utf-8'));
            // Support both wrapped format { metadata, settings } and raw dict
            const settingsToInject = rawContent.settings ?? rawContent;

            const settingsService = new RooSettingsService();
            try {
              const result = await settingsService.injectSettings(settingsToInject, {
                dryRun: options.dryRun,
              });

              if (!options.dryRun) {
                filesApplied++;
              }
              details.push({
                file: file.path,
                dest: destPath,
                action: options.dryRun ? 'would_update_sqlite' : 'update_sqlite',
                settingsApplied: result.applied,
                settingsChanges: result.changes.length,
              });
              this.logger.info(`Settings Roo appliqués: ${result.applied} changements`);
            } catch (error) {
              errors.push(`Erreur application settings ${file.path}: ${error}`);
              this.logger.error(`Erreur application settings: ${error}`);
            }
            continue;
          }

          // Traitement spécial pour les fichiers non-JSON (rules = markdown)
          const isTextFile = file.type === 'rules_config';
          if (isTextFile) {
            const rawContent = await fs.readFile(sourcePath, 'utf-8');
            let action = 'create';

            if (existsSync(destPath)) {
              action = 'update';
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
              size: rawContent.length
            });

            if (!options.dryRun) {
              await fs.mkdir(dirname(destPath), { recursive: true });
              await fs.writeFile(destPath, rawContent, 'utf-8');
              filesApplied++;
            }
            continue;
          }

          // Lecture du contenu source (JSON)
          const sourceContent = JSON.parse(await fs.readFile(sourcePath, 'utf-8'));

          // Issue #349: Filtrage granulaire des serveurs MCP si targets mcp:xxx sont spécifiés
          let finalContent = sourceContent;
          if (file.path === 'mcp-settings/mcp_settings.json' && hasMcpTargets && !hasMcpTarget) {
            if (!sourceContent.mcpServers) {
              this.logger.warn('Aucun serveur MCP trouvé dans la configuration source');
              continue;
            }

            const filteredServers: any = {};
            for (const serverName of mcpServerNames) {
              if (sourceContent.mcpServers[serverName]) {
                filteredServers[serverName] = sourceContent.mcpServers[serverName];
              } else {
                this.logger.warn(`Serveur MCP non trouvé dans la source: ${serverName}`);
              }
            }

            if (Object.keys(filteredServers).length === 0) {
              this.logger.warn('Aucun serveur MCP correspondant trouvé dans la source');
              continue;
            }

            finalContent = { ...sourceContent, mcpServers: filteredServers };
            this.logger.info(`Filtrage appliqué: ${Object.keys(filteredServers).length} serveur(s) MCP`);
          }

          // Gestion du contenu local existant
          let action = 'create';

          if (existsSync(destPath)) {
            action = 'update';

            // Pour roomodes et model-configs : remplacement complet (pas de merge)
            // Pour modes/mcp/profiles : fusion JSON
            const isReplacementTarget = file.type === 'roomodes_config' || file.type === 'model_config';
            if (!isReplacementTarget) {
              const localContent = JSON.parse(await fs.readFile(destPath, 'utf-8'));
              finalContent = JsonMerger.merge(finalContent, localContent, { arrayStrategy: 'replace' });
            }

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
   * Applique un profil de modèle depuis model-configs.json
   * #498 Phase 2: Déploie un profil nommé (modeApiConfigs, apiConfigs, thresholds)
   *
   * @param options - Options avec profileName, sourceMachineId optionnel, backup, dryRun
   * @returns Résultat avec les changements appliqués
   */
  public async applyProfile(options: ApplyProfileOptions): Promise<ApplyProfileResult> {
    this.logger.info('Application du profil de modèle', options);

    const errors: string[] = [];

    try {
      // 1. Charger model-configs.json depuis la source
      let modelConfigs: any;

      if (options.sourceMachineId) {
        // Charger depuis la config publiée d'une autre machine
        const sharedStatePath = this.configService.getSharedStatePath();
        const machineConfigDir = join(sharedStatePath, 'configs', options.sourceMachineId);
        const latestPath = join(machineConfigDir, 'latest.json');

        if (!existsSync(latestPath)) {
          throw new ConfigSharingServiceError(
            `Aucune configuration publiée trouvée pour la machine '${options.sourceMachineId}'`,
            ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
            { sourceMachineId: options.sourceMachineId, latestPath }
          );
        }

        const latestData = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
        const modelConfigPath = join(latestData.path, 'model-configs', 'model-configs.json');

        if (!existsSync(modelConfigPath)) {
          throw new ConfigSharingServiceError(
            `model-configs.json non trouvé dans la config publiée de '${options.sourceMachineId}'. La machine doit publier avec targets=['model-configs']`,
            ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
            { sourceMachineId: options.sourceMachineId, modelConfigPath }
          );
        }

        modelConfigs = JSON.parse(await fs.readFile(modelConfigPath, 'utf-8'));
        this.logger.info(`model-configs.json chargé depuis ${options.sourceMachineId}`);
      } else {
        // Charger depuis le fichier local
        const inventory = await this.inventoryService.getMachineInventory() as any;
        if (!inventory?.paths?.rooExtensions) {
          throw new ConfigSharingServiceError(
            'Inventaire incomplet: paths.rooExtensions non disponible',
            ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
            { missingPath: 'rooExtensions' }
          );
        }

        const localModelConfigPath = join(inventory.paths.rooExtensions, 'roo-config', 'model-configs.json');
        if (!existsSync(localModelConfigPath)) {
          throw new ConfigSharingServiceError(
            `model-configs.json non trouvé localement: ${localModelConfigPath}`,
            ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
            { localModelConfigPath }
          );
        }

        modelConfigs = JSON.parse(await fs.readFile(localModelConfigPath, 'utf-8'));
        this.logger.info('model-configs.json chargé depuis fichier local');
      }

      // 2. Trouver le profil demandé
      if (!modelConfigs.profiles || !Array.isArray(modelConfigs.profiles)) {
        throw new ConfigSharingServiceError(
          'model-configs.json ne contient pas de section "profiles" valide',
          ConfigSharingServiceErrorCode.COLLECTION_FAILED,
          { keys: Object.keys(modelConfigs) }
        );
      }

      const profile = modelConfigs.profiles.find(
        (p: any) => p.name === options.profileName
      );

      if (!profile) {
        const availableNames = modelConfigs.profiles.map((p: any) => p.name);
        throw new ConfigSharingServiceError(
          `Profil '${options.profileName}' non trouvé. Profils disponibles: ${availableNames.join(', ')}`,
          ConfigSharingServiceErrorCode.COLLECTION_FAILED,
          { profileName: options.profileName, availableProfiles: availableNames }
        );
      }

      this.logger.info(`Profil trouvé: ${profile.name} - ${profile.description || ''}`);

      // 3. Construire la nouvelle configuration
      const newModeApiConfigs: Record<string, string> = { ...profile.modeOverrides };

      // Ajouter les modes base (sans suffixe) pointant vers "default"
      const baseModes = ['code', 'architect', 'ask', 'debug', 'orchestrator'];
      for (const mode of baseModes) {
        if (!newModeApiConfigs[mode]) {
          newModeApiConfigs[mode] = 'default';
        }
      }

      // Extraire les profileThresholds depuis modelConfigs (ou defaults)
      const newThresholds: Record<string, number> = modelConfigs.profileThresholds || { simple: 80, default: 80 };

      // 4. Appliquer au fichier local
      const inventory = await this.inventoryService.getMachineInventory() as any;
      if (!inventory?.paths?.rooExtensions) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.rooExtensions non disponible',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { missingPath: 'rooExtensions' }
        );
      }

      const localModelConfigPath = join(inventory.paths.rooExtensions, 'roo-config', 'model-configs.json');

      // Backup si demandé
      let backupPath: string | undefined;
      if (options.backup !== false && existsSync(localModelConfigPath) && !options.dryRun) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${localModelConfigPath}.backup_${timestamp}`;
        await fs.copyFile(localModelConfigPath, backupPath);
        this.logger.info(`Backup créé: ${backupPath}`);
      }

      // Construire le nouveau model-configs.json complet
      const currentConfig = existsSync(localModelConfigPath)
        ? JSON.parse(await fs.readFile(localModelConfigPath, 'utf-8'))
        : {};

      const updatedConfig = {
        ...currentConfig,
        profiles: modelConfigs.profiles, // Garder tous les profils
        apiConfigs: modelConfigs.apiConfigs, // Garder les configs API
        modeApiConfigs: newModeApiConfigs,
        profileThresholds: newThresholds,
        notes: [
          ...(modelConfigs.notes || []),
          `Profil '${profile.name}' appliqué le ${new Date().toISOString().split('T')[0]}`
        ]
      };

      // Validation JSON avant écriture
      const jsonString = JSON.stringify(updatedConfig, null, 2);
      try {
        JSON.parse(jsonString); // Validation round-trip
      } catch (parseErr: any) {
        throw new ConfigSharingServiceError(
          `Validation JSON échouée après construction du profil: ${parseErr.message}`,
          ConfigSharingServiceErrorCode.COLLECTION_FAILED,
          { profileName: options.profileName }
        );
      }

      if (!options.dryRun) {
        await fs.mkdir(dirname(localModelConfigPath), { recursive: true });
        await fs.writeFile(localModelConfigPath, jsonString, 'utf-8');
        this.logger.info(`model-configs.json mis à jour avec le profil '${profile.name}'`);
      }

      // 5. Générer et déployer .roomodes avec le profil (sauf si explicitement désactivé)
      let roomodesGenerated = false;
      if (options.generateModes !== false && !options.dryRun) {
        const generateModesPath = join(inventory.paths.rooExtensions, 'roo-config', 'scripts', 'generate-modes.js');
        if (existsSync(generateModesPath)) {
          const command = `node "${generateModesPath}" --profile "${profile.name}" --deploy`;
          this.logger.info(`Génération .roomodes: ${command}`);
          try {
            const output = execSync(command, {
              encoding: 'utf-8',
              cwd: inventory.paths.rooExtensions,
              timeout: 30000
            });
            this.logger.info('.roomodes généré et déployé avec succès');
            this.logger.debug(output);
            roomodesGenerated = true;
          } catch (genErr: any) {
            const errMsg = `Échec génération .roomodes: ${genErr.message}`;
            this.logger.warn(errMsg);
            errors.push(errMsg);
          }
        } else {
          this.logger.warn(`Script generate-modes.js non trouvé: ${generateModesPath}`);
          errors.push(`Script generate-modes.js non trouvé`);
        }
      }

      return {
        success: true,
        profileName: profile.name,
        modesConfigured: Object.keys(newModeApiConfigs).length,
        apiConfigsCount: Object.keys(modelConfigs.apiConfigs || {}).length,
        backupPath,
        roomodesGenerated,
        changes: {
          modeApiConfigs: newModeApiConfigs,
          profileThresholds: newThresholds
        },
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (err: any) {
      if (err instanceof ConfigSharingServiceError) throw err;

      const errorMsg = `Erreur applyProfile: ${err.message}`;
      this.logger.error(errorMsg);
      errors.push(errorMsg);

      return {
        success: false,
        profileName: options.profileName,
        modesConfigured: 0,
        apiConfigsCount: 0,
        errors
      };
    }
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
    // CORRECTION SDDD : Utiliser InventoryService pour charger l'inventaire depuis le fichier JSON
    // CORRECTION SDDD : Utiliser ROOSYNC_MACHINE_ID au lieu de COMPUTERNAME
    // CORRECTION Bug collect_config : Appeler sans argument pour forcer collecte locale
    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    // CORRECTION SDDD : Utiliser uniquement l'inventaire, pas de fallback process.cwd()
    if (!inventory?.paths?.rooExtensions) {
      throw new ConfigSharingServiceError(
        'Inventaire incomplet: paths.rooExtensions non disponible. Impossible de collecter les modes.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId, missingPath: 'rooExtensions' }
      );
    }

    const rooModesPath = join(inventory.paths.rooExtensions, 'roo-modes');

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

  private async collectMcpSettings(tempDir: string, mcpServerNames?: string[]): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const mcpDir = join(tempDir, 'mcp-settings');
    await fs.mkdir(mcpDir, { recursive: true });

    // Récupérer l'inventaire pour trouver les chemins
    // CORRECTION SDDD : Utiliser InventoryService pour charger l'inventaire depuis le fichier JSON
    // CORRECTION SDDD : Utiliser ROOSYNC_MACHINE_ID au lieu de COMPUTERNAME
    // CORRECTION Bug collect_config : Appeler sans argument pour forcer collecte locale
    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    // CORRECTION SDDD : Utiliser uniquement l'inventaire, pas de fallback process.cwd()
    if (!inventory?.paths?.mcpSettings) {
      throw new ConfigSharingServiceError(
        'Inventaire incomplet: paths.mcpSettings non disponible. Impossible de collecter les settings MCP.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId, missingPath: 'mcpSettings' }
      );
    }

    const mcpSettingsPath = inventory.paths.mcpSettings;

    this.logger.info(`Collecte des settings MCP depuis: ${mcpSettingsPath}`);

    if (existsSync(mcpSettingsPath)) {
      const destPath = join(mcpDir, 'mcp_settings.json');

      // Lecture et normalisation (avec gestion BOM)
      const content = await readJSONFileWithoutBOM(mcpSettingsPath);
      
      // Filtrage des serveurs MCP spécifiques si demandé
      if (mcpServerNames && mcpServerNames.length > 0) {
        if (!content.mcpServers) {
          this.logger.warn('Aucun serveur MCP trouvé dans la configuration');
          return files;
        }
        
        const filteredServers: any = {};
        for (const serverName of mcpServerNames) {
          if (content.mcpServers[serverName]) {
            filteredServers[serverName] = content.mcpServers[serverName];
          } else {
            this.logger.warn(`Serveur MCP non trouvé: ${serverName}`);
          }
        }
        
        if (Object.keys(filteredServers).length === 0) {
          this.logger.warn('Aucun serveur MCP correspondant trouvé');
          return files;
        }
        
        content.mcpServers = filteredServers;
      }
      
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

    // T3.8: Implémenter la collecte des profils de configuration
    // Les profils sont stockés dans le shared state path
    const sharedStatePath = this.configService.getSharedStatePath();
    const profilesSourcePath = join(sharedStatePath, 'configuration-profiles.json');

    this.logger.info(`Collecte des profils depuis: ${profilesSourcePath}`);

    // Collecter le fichier principal des profils s'il existe
    if (existsSync(profilesSourcePath)) {
      try {
        const destPath = join(profilesDir, 'configuration-profiles.json');

        // Lecture du fichier de profils
        const content = JSON.parse(await fs.readFile(profilesSourcePath, 'utf-8'));

        // Normalisation des profils
        const normalized = await this.normalizationService.normalize(content, 'profile_settings');

        // Écriture du fichier normalisé
        await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

        const hash = await this.calculateHash(destPath);
        const stats = await fs.stat(destPath);

        files.push({
          path: 'profiles/configuration-profiles.json',
          hash,
          type: 'profile_settings',
          size: stats.size
        });

        this.logger.info(`Profils collectés: ${stats.size} bytes`);
      } catch (error) {
        this.logger.warn(`Erreur lors de la lecture des profils: ${error}`);
      }
    } else {
      this.logger.info('Aucun fichier de profils trouvé (configuration-profiles.json)');
    }

    // Collecter également les mappings machine si présents
    const mappingsSourcePath = join(sharedStatePath, 'machine-mappings.json');
    if (existsSync(mappingsSourcePath)) {
      try {
        const destPath = join(profilesDir, 'machine-mappings.json');

        const content = JSON.parse(await fs.readFile(mappingsSourcePath, 'utf-8'));
        const normalized = await this.normalizationService.normalize(content, 'profile_settings');

        await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

        const hash = await this.calculateHash(destPath);
        const stats = await fs.stat(destPath);

        files.push({
          path: 'profiles/machine-mappings.json',
          hash,
          type: 'profile_settings',
          size: stats.size
        });

        this.logger.info(`Mappings machine collectés: ${stats.size} bytes`);
      } catch (error) {
        this.logger.warn(`Erreur lors de la lecture des mappings: ${error}`);
      }
    }

    // Collecter la baseline non-nominative si présente
    const baselineSourcePath = join(sharedStatePath, 'non-nominative-baseline.json');
    if (existsSync(baselineSourcePath)) {
      try {
        const destPath = join(profilesDir, 'non-nominative-baseline.json');

        const content = JSON.parse(await fs.readFile(baselineSourcePath, 'utf-8'));
        const normalized = await this.normalizationService.normalize(content, 'profile_settings');

        await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

        const hash = await this.calculateHash(destPath);
        const stats = await fs.stat(destPath);

        files.push({
          path: 'profiles/non-nominative-baseline.json',
          hash,
          type: 'profile_settings',
          size: stats.size
        });

        this.logger.info(`Baseline non-nominative collectée: ${stats.size} bytes`);
      } catch (error) {
        this.logger.warn(`Erreur lors de la lecture de la baseline: ${error}`);
      }
    }

    return files;
  }

  /**
   * Collecte le fichier .roomodes depuis la racine du workspace
   */
  private async collectRoomodes(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const roomodesDir = join(tempDir, 'roomodes');
    await fs.mkdir(roomodesDir, { recursive: true });

    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    if (!inventory?.paths?.rooExtensions) {
      throw new ConfigSharingServiceError(
        'Inventaire incomplet: paths.rooExtensions non disponible. Impossible de collecter .roomodes.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId, missingPath: 'rooExtensions' }
      );
    }

    const roomodesPath = join(inventory.paths.rooExtensions, '.roomodes');
    this.logger.info(`Collecte de .roomodes depuis: ${roomodesPath}`);

    if (existsSync(roomodesPath)) {
      const destPath = join(roomodesDir, '.roomodes');

      // .roomodes est un fichier JSON - on le lit et normalise
      const content = JSON.parse(await fs.readFile(roomodesPath, 'utf-8'));
      const normalized = await this.normalizationService.normalize(content, 'roomodes_config');
      await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'roomodes/.roomodes',
        hash,
        type: 'roomodes_config',
        size: stats.size
      });

      this.logger.info(`.roomodes collecté: ${stats.size} bytes`);
    } else {
      this.logger.warn(`.roomodes non trouvé: ${roomodesPath}`);
    }

    return files;
  }

  /**
   * Collecte le fichier model-configs.json depuis roo-config/
   */
  private async collectModelConfigs(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const modelDir = join(tempDir, 'model-configs');
    await fs.mkdir(modelDir, { recursive: true });

    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    if (!inventory?.paths?.rooExtensions) {
      throw new ConfigSharingServiceError(
        'Inventaire incomplet: paths.rooExtensions non disponible. Impossible de collecter model-configs.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId, missingPath: 'rooExtensions' }
      );
    }

    const modelConfigPath = join(inventory.paths.rooExtensions, 'roo-config', 'model-configs.json');
    this.logger.info(`Collecte de model-configs.json depuis: ${modelConfigPath}`);

    if (existsSync(modelConfigPath)) {
      const destPath = join(modelDir, 'model-configs.json');

      const content = JSON.parse(await fs.readFile(modelConfigPath, 'utf-8'));
      const normalized = await this.normalizationService.normalize(content, 'model_config');
      await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'model-configs/model-configs.json',
        hash,
        type: 'model_config',
        size: stats.size
      });

      this.logger.info(`model-configs.json collecté: ${stats.size} bytes`);
    } else {
      this.logger.warn(`model-configs.json non trouvé: ${modelConfigPath}`);
    }

    return files;
  }

  /**
   * Collecte les rules globales depuis roo-config/rules-global/
   * Les rules sont des fichiers Markdown (pas du JSON), copies tels quels.
   */
  private async collectRules(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const rulesDir = join(tempDir, 'rules');
    await fs.mkdir(rulesDir, { recursive: true });

    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    if (!inventory?.paths?.rooExtensions) {
      throw new ConfigSharingServiceError(
        'Inventaire incomplet: paths.rooExtensions non disponible. Impossible de collecter les rules.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId, missingPath: 'rooExtensions' }
      );
    }

    const rulesGlobalPath = join(inventory.paths.rooExtensions, 'roo-config', 'rules-global');
    this.logger.info(`Collecte des rules depuis: ${rulesGlobalPath}`);

    if (existsSync(rulesGlobalPath)) {
      const entries = await fs.readdir(rulesGlobalPath);
      for (const entry of entries) {
        if (entry.endsWith('.md')) {
          const srcPath = join(rulesGlobalPath, entry);
          const destPath = join(rulesDir, entry);

          // Les rules sont des fichiers texte - copie brute sans normalisation JSON
          await fs.copyFile(srcPath, destPath);

          const hash = await this.calculateHash(destPath);
          const stats = await fs.stat(destPath);

          files.push({
            path: `rules/${entry}`,
            hash,
            type: 'rules_config',
            size: stats.size
          });
        }
      }
      this.logger.info(`${files.length} rules collectées depuis rules-global/`);
    } else {
      this.logger.warn(`Répertoire rules-global non trouvé: ${rulesGlobalPath}`);
    }

    return files;
  }

  /**
   * Collecte les settings Roo depuis state.vscdb
   * Issue #509, #547: Extraction complète des 80+ settings sync-safe
   */
  private async collectSettings(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const settingsDir = join(tempDir, 'roo-settings');
    await fs.mkdir(settingsDir, { recursive: true });

    const settingsService = new RooSettingsService();

    if (!settingsService.isAvailable()) {
      this.logger.warn(`state.vscdb non trouvé: ${settingsService.getStateDbPath()}`);
      return files;
    }

    try {
      const extract = await settingsService.extractSettings('safe');

      const destPath = join(settingsDir, 'roo-settings.json');
      await fs.writeFile(destPath, JSON.stringify(extract, null, 2));

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'roo-settings/roo-settings.json',
        hash,
        type: 'roo_settings',
        size: stats.size
      });

      this.logger.info(`Settings Roo collectés: ${extract.metadata.keysCount} clés sync-safe (sur ${extract.metadata.totalKeys} totales)`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte des settings Roo: ${error}`);
      // Ne pas faire échouer toute la collecte si les settings ne sont pas disponibles
    }

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
