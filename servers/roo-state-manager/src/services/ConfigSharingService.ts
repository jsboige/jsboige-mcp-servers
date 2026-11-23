import { promises as fs } from 'fs';
import { join, dirname, basename, relative, isAbsolute, resolve as resolvePath, sep, parse as parsePath } from 'path';
import { existsSync, mkdirSync, constants as fsConstants } from 'fs';
import { createHash } from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { homedir } from 'os';
import { ensureStoreSubdir } from '../utils/shared-state-path.js';
import { ConfigNormalizationService } from './ConfigNormalizationService.js';
import { ConfigDiffService } from './ConfigDiffService.js';
import { JsonMerger } from '../utils/JsonMerger.js';
import { RooSettingsService } from './RooSettingsService.js';
import { getSettingsPath as getExtensionSettingsPath } from '../utils/extension-paths.js';
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
   DiffResult,
   ConfigTarget, // #3111 — rollbackWorkspaceTemplateConfig options
   ClaudeCodeScope // #601: Import ClaudeCodeScope type
} from '../types/config-sharing.js';
import { IInventoryCollector, IConfigService } from '../types/baseline.js';
import { createLogger, Logger } from '../utils/logger.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../types/errors.js';
import { InventoryService } from './roosync/InventoryService.js';
import { readJSONFileWithoutBOM, readFileWithoutBOM } from '../utils/encoding-helpers.js';
import { RollbackManager } from './RollbackManager.js';
import { ConfigHealthCheckService, type ConfigType as HealthCheckConfigType } from './ConfigHealthCheckService.js';
import { ServicesConfigService } from './ServicesConfigService.js';
import {
  ClaudeSettingsService,
  validateCanon,
  applyCanonToFile,
  buildSnapshot,
  CanonPayload,
} from './ClaudeSettingsService.js';
import yaml from 'js-yaml';
import { SchtasksConfigService, type SchtaskConfig } from './SchtasksConfigService.js';

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
      // #601: Pass scope parameter to collectMcpSettings
      const mcpFiles = await this.collectMcpSettings(tempDir, mcpServerNames, options.scope);
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

    // Collecte de ~/.claude.json (Claude Code MCP configuration) - #603 B2.1
    if (options.targets.includes('claude-config')) {
      const claudeConfigFiles = await this.collectClaudeConfig(tempDir);
      manifest.files.push(...claudeConfigFiles);
    }

    // #3545 — Collecte de ~/.claude/settings.json (picker Claude Code) en snapshot
    // masqué (comparaison) — ce n'est PAS un payload d'apply.
    if (options.targets.includes('claude-settings')) {
      const claudeSettingsFiles = await this.collectClaudeSettings(tempDir);
      manifest.files.push(...claudeSettingsFiles);
    }

    // Collecte de custom_modes.yaml (modes globaux Roo) - #603 B2.1
    if (options.targets.includes('modes-yaml')) {
      const modesYamlFiles = await this.collectModesYaml(tempDir);
      manifest.files.push(...modesYamlFiles);
    }

    // #2409 — Collecte des services Windows (services:<name>)
    const servicesTargets = options.targets.filter(t => typeof t === 'string' && t.startsWith('services:'));
    if (servicesTargets.length > 0) {
      const servicesFiles = await this.collectServices(tempDir, servicesTargets);
      manifest.files.push(...servicesFiles);
    }

    // Collecte des schtasks (tâches planifiées Windows) - #2408 VibeSync Phase 2
    if (options.targets.includes('schtasks')) {
      const schtasksFiles = await this.collectSchtasks(tempDir);
      manifest.files.push(...schtasksFiles);
    }

    // #2411 — Collecte des schedules Roo (.roo/schedules.json)
    if (options.targets.includes('schedules')) {
      const schedulesFiles = await this.collectSchedules(tempDir);
      manifest.files.push(...schedulesFiles);
    }

    // #3111 — Collecte du modèle de workspace (.claude/configs/workspace-template)
    if (options.targets.includes('workspace-template')) {
      const workspaceTemplateFiles = await this.collectWorkspaceTemplate(tempDir);
      manifest.files.push(...workspaceTemplateFiles);
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

    // #4010 : un `version` préfixée par « v » produisait un dossier « vv… » qui
    // déclassait lexicalement tous les paquets semver suivants. Le préfixe est
    // ajouté ICI — la version fournie doit être nue.
    const version = options.version.replace(/^v+/, '');

    // Créer un sous-répertoire versionné pour l'historique
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const versionDir = join(machineConfigDir, `v${version}-${timestamp}`);

    // #4695 : dryRun au niveau SERVICE. ms#1746 avait corrigé la couche outil
    // seulement — tout autre appelant de publishConfig (script, futur outil)
    // publiait réellement avec un dryRun silencieusement ignoré. En simulation :
    // rien de créé, copié, écrit ni purgé ; on rend le dossier cible et la
    // version qui auraient été publiés. Placé avant le warning « sera écrasée »
    // pour ne pas annoncer un écrasement qui n'aura pas lieu.
    if (options.dryRun) {
      this.logger.info('Publication simulée (dryRun) — rien n\'a été écrit', { machineId, version, path: versionDir });
      return {
        success: true,
        version,
        path: versionDir,
        machineId
      };
    }

    if (existsSync(versionDir)) {
      this.logger.warn(`La version ${version} existe déjà pour ${machineId}, elle sera écrasée.`);
    }

    // #3459 (b): création sous la racine du store via le helper sanctionné
    ensureStoreSubdir(sharedStatePath, 'configs', machineId, `v${version}-${timestamp}`);

    // Copie des fichiers depuis le package temporaire
    await this.copyRecursive(options.packagePath, versionDir);

    // Mise à jour du manifeste avec la version finale et le machineId
    const manifestPath = join(versionDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest: ConfigManifest = JSON.parse(manifestContent);

    manifest.version = version;
    manifest.description = options.description;
    manifest.author = machineId; // CORRECTION SDDD : Utiliser machineId explicite

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // CORRECTION SDDD : Créer un lien symbolique ou fichier latest pour accès facile
    const latestPath = join(machineConfigDir, 'latest.json');
    await fs.writeFile(latestPath, JSON.stringify({
      version,
      timestamp,
      path: versionDir,
      manifest
    }, null, 2));

    this.logger.info('Publication terminée', { machineId, version, path: versionDir });

    // #2121: Cap versioned snapshots to 3 most recent per machine
    try {
      const entries = await fs.readdir(machineConfigDir);
      const versionDirs = entries
        .filter(e => e.startsWith('v') && !e.includes('.'))
        .sort()
        .reverse(); // newest first
      if (versionDirs.length > 3) {
        for (const old of versionDirs.slice(3)) {
          await fs.rm(join(machineConfigDir, old), { recursive: true, force: true });
        }
        this.logger.info(`#2121: Pruned ${versionDirs.length - 3} old config snapshots for ${machineId}`);
      }
    } catch (err) {
      this.logger.debug('#2121: Config snapshot cap failed', { error: String(err) });
    }

    return {
      success: true,
      version,
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
    const rollback = new RollbackManager(this.logger);
    const appliedFilePaths: Array<{ path: string; type: string }> = []; // For post-apply health check
    // #3998 — dryRun+validate : validations du contenu PRÉVU (en mémoire). Le disque
    // porte l'état courant, pas l'état prévu : une validation disque en dryRun
    // échouerait à tort sur un create (fichier absent). On round-trip le contenu
    // qui SERAIT écrit — check de santé du package avant l'apply réel.
    const plannedValidations: Array<{ target: string; success: boolean; details?: any }> = [];
    // #3111 — résumé de la cible workspace-template, remonté dans ApplyConfigResult
    let workspaceTemplateResult: ApplyConfigResult['workspaceTemplate'];

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
      const hasClaudeConfigTarget = options.targets?.includes('claude-config') || false;
      const hasModesYamlTarget = options.targets?.includes('modes-yaml') || false;
      const hasSchedulesTarget = options.targets?.includes('schedules') || false;

      // #2409 — Services targets (live management, not file copy)
      const servicesTargets = options.targets?.filter(t => typeof t === 'string' && t.startsWith('services:')) as string[] || [];
      if (servicesTargets.length > 0) {
        const serviceNames = servicesTargets.map(t => (t as string).slice(9));
        const servicesStatePath = join(configDir, 'services', 'services-state.json');
        if (existsSync(servicesStatePath)) {
          this.logger.info(`Applying services targets: ${serviceNames.join(', ')}`);
          try {
            const servicesConfig = new ServicesConfigService();
            const packageStateRaw = await fs.readFile(servicesStatePath, 'utf-8');
            const packageState = JSON.parse(packageStateRaw) as { services: Array<{ name: string; status: string }> };

            // Collect current local state
            const localState = await servicesConfig.collect(serviceNames);

            // Determine operations needed: start services that are stopped in the package state but running in the target
            const toStart: string[] = [];
            for (const pkgService of packageState.services) {
              if (!serviceNames.includes(pkgService.name)) continue;
              const local = localState.services.find(s => s.name === pkgService.name);
              if (local && local.status !== pkgService.status) {
                // If package says Running and local says Stopped → start
                if (pkgService.status === 'Running' && (local.status === 'Stopped' || local.status === 'NotFound')) {
                  toStart.push(pkgService.name);
                }
              }
            }

            if (toStart.length > 0) {
              this.logger.info(`Services to reconcile: ${toStart.join(', ')}`);
              if (!options.dryRun) {
                const applyResult = await servicesConfig.apply(toStart, 'start', options.dryRun);
                if (!applyResult.success) {
                  errors.push(...(applyResult.errors || []));
                }
                filesApplied += toStart.length;
              }
            }
          } catch (svcErr) {
            errors.push(`Services apply failed: ${svcErr instanceof Error ? svcErr.message : String(svcErr)}`);
          }
        } else {
          this.logger.warn('Services state file not found in package', { servicesStatePath });
        }
      }

      // Si aucun target n'est spécifié, tout appliquer par défaut
      const applyAll = options.targets === undefined || options.targets.length === 0;

      // #2408 — Schtasks target apply (inventory file → Set-ScheduledTask)
      const hasSchtasksTarget = options.targets?.includes('schtasks') || false;
      if (hasSchtasksTarget || applyAll) {
        const schtasksStatePath = join(configDir, 'schtasks', 'schtasks-inventory.json');
        if (existsSync(schtasksStatePath)) {
          this.logger.info('Applying schtasks target');
          try {
            const schtasksService = new SchtasksConfigService();
            const inventoryRaw = await fs.readFile(schtasksStatePath, 'utf-8');
            const inventory = JSON.parse(inventoryRaw) as { tasks: SchtaskConfig[] };
            if (inventory.tasks && Array.isArray(inventory.tasks) && inventory.tasks.length > 0) {
              const applyResult = await schtasksService.apply(inventory.tasks, options.dryRun);
              filesApplied += applyResult.modified + applyResult.created;
              this.logger.info(`Schtasks applied: ${applyResult.modified} modified, ${applyResult.created} created, ${applyResult.skipped} skipped, ${applyResult.missing.length} missing`);
              if (applyResult.errors.length > 0) {
                errors.push(...applyResult.errors);
              }
              // #2406 P1-a — no silent success: tasks absent from this machine
              // are named and fail the apply (creation from scratch = P1-b
              // installers). Applies to dry-run too — the real apply would fail.
              if (applyResult.missing.length > 0) {
                errors.push(`Schtasks: ${applyResult.missing.length} task(s) missing on this machine, creation not supported yet (P1-b): ${applyResult.missing.join(', ')}`);
              }
            } else {
              this.logger.info('Schtasks inventory empty, nothing to apply');
            }
          } catch (schtasksErr) {
            errors.push(`Schtasks apply failed: ${schtasksErr instanceof Error ? schtasksErr.message : String(schtasksErr)}`);
          }
        }
      }

      // #2411 — Schedules target apply (ID-based merge into .roo/schedules.json)
      if (hasSchedulesTarget || applyAll) {
        const schedulesStatePath = join(configDir, 'schedules', 'schedules.json');
        if (existsSync(schedulesStatePath)) {
          this.logger.info('Applying schedules target');
          try {
            const inventory2 = await this.inventoryService.getMachineInventory() as any;
            if (inventory2?.paths?.rooExtensions) {
              const localSchedulesPath = join(inventory2.paths.rooExtensions, '.roo', 'schedules.json');
              const packageRaw = await fs.readFile(schedulesStatePath, 'utf-8');
              const packageData = JSON.parse(packageRaw) as { schedules: any[] };

              // ID-based merge
              let localSchedules: any[] = [];
              if (existsSync(localSchedulesPath)) {
                const localRaw = await fs.readFile(localSchedulesPath, 'utf-8');
                const localData = JSON.parse(localRaw) as { schedules: any[] };
                localSchedules = localData.schedules || [];
              }

              const merged = this.mergeSchedulesById(packageData.schedules || [], localSchedules);

              if (!options.dryRun) {
                // Backup
                if (options.backup !== false && existsSync(localSchedulesPath)) {
                  const ts = new Date().toISOString().replace(/[:.]/g, '-');
                  const backupSchedPath = `${localSchedulesPath}.backup_${ts}`;
                  await fs.copyFile(localSchedulesPath, backupSchedPath);
                  this.logger.info(`Schedules backup: ${backupSchedPath}`);
                }
                await fs.mkdir(dirname(localSchedulesPath), { recursive: true });
                await fs.writeFile(localSchedulesPath, JSON.stringify({ schedules: merged }, null, 2), 'utf-8');
                filesApplied++;
                this.logger.info(`Schedules applied: ${merged.length} schedules (merged from ${packageData.schedules?.length || 0} package + ${localSchedules.length} local)`);
              }
            }
          } catch (schedErr) {
            errors.push(`Schedules apply failed: ${schedErr instanceof Error ? schedErr.message : String(schedErr)}`);
          }
        }
      }

      // #3545 — claude-settings target : apply UNIQUEMENT d'un canon explicite.
      // Un snapshot de comparaison (claude-settings.json) n'est JAMAIS un payload
      // d'apply : rejet explicite. Jamais appliqué implicitement via applyAll.
      const hasClaudeSettingsTarget = options.targets?.includes('claude-settings') || false;
      if (hasClaudeSettingsTarget) {
        const canonPath = join(configDir, 'claude-settings', 'canon.json');
        const snapshotPath = join(configDir, 'claude-settings', 'claude-settings.json');
        try {
          if (existsSync(canonPath)) {
            const canonRaw = await readJSONFileWithoutBOM<CanonPayload>(canonPath);
            const validation = validateCanon(canonRaw);
            if (!validation.valid) {
              errors.push(`claude-settings: canon.json invalide — ${validation.problems.join(' ; ')}`);
            } else {
              const service = new ClaudeSettingsService();
              const result = await applyCanonToFile(service.getPath(), canonRaw, {
                dryRun: options.dryRun,
                backup: options.backup !== false,
              });
              if (!options.dryRun) {
                filesApplied++;
              }
              this.logger.info(
                `Claude settings canon appliqué (${canonRaw.mode}): ${result.changes.filter(c => c.action === 'set').length} posées, ${result.skipped.length} ignorées`
              );
            }
          } else if (existsSync(snapshotPath)) {
            errors.push(
              'claude-settings: le paquet ne contient qu’un SNAPSHOT de comparaison (claude-settings.json) — un apply exige claude-settings/canon.json (clés explicites allow-listées). Un snapshot n’est pas un payload d’apply (#3545).'
            );
          } else {
            errors.push('claude-settings: aucun fichier claude-settings dans le paquet source.');
          }
        } catch (csErr) {
          errors.push(`Claude settings apply failed: ${csErr instanceof Error ? csErr.message : String(csErr)}`);
        }
      }

      // #3111 — workspace-template target : copie CREATE-ONLY de modèles dans un
      // workspace. Opt-in uniquement (jamais appliqué implicitement via applyAll) ;
      // dryRun par défaut = TRUE pour cette cible (seul dryRun:false écrit).
      const hasWorkspaceTemplateTarget = options.targets?.includes('workspace-template') || false;
      if (hasWorkspaceTemplateTarget) {
        try {
          const wt = await this.applyWorkspaceTemplate(configDir, options, errors);
          const simulate = options.dryRun !== false;
          if (!simulate) {
            filesApplied += wt.created.length;
          }
          workspaceTemplateResult = {
            simulate,
            created: wt.created,
            skippedExisting: wt.skippedExisting,
            journalPath: wt.journalPath,
          };
          this.logger.info(
            `workspace-template ${simulate ? '(dry-run)' : 'appliqué'}: ${wt.created.length} créé(s), ${wt.skippedExisting.length} existant(s) ignoré(s)` +
            (wt.journalPath ? ` — journal ${wt.journalPath}` : '')
          );
        } catch (wtErr) {
          errors.push(`workspace-template apply failed: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`);
        }
      }

      this.logger.info('Targets de configuration', {
        applyAll,
        hasMcpTarget,
        hasModesTarget,
        hasProfilesTarget,
        hasRoomodesTarget,
        hasModelConfigsTarget,
        hasRulesTarget,
        hasSettingsTarget,
        hasClaudeSettingsTarget,
        hasSchedulesTarget,
        mcpServerNames
      });

      // 2. Itérer sur les fichiers
      for (const file of manifest.files) {
        try {
          // Issue #349: Filtrage basé sur les targets
          let shouldProcess = false;
          
          if (applyAll) {
            // #3545 — claude-settings n'est JAMAIS appliqué implicitement :
            // apply sélectif explicite uniquement (canon.json validé).
            // #3111 — workspace-template est opt-in (workspacePath requis).
            shouldProcess = !file.path.startsWith('claude-settings/') && !file.path.startsWith('workspace-template/');
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
          } else if (file.path.startsWith('claude-config/')) {
            shouldProcess = hasClaudeConfigTarget;
          } else if (file.path.startsWith('modes-yaml/')) {
            shouldProcess = hasModesYamlTarget;
          } else if (file.path.startsWith('claude-settings/')) {
            // #3545 — géré par le bloc dédié ci-dessus (canon uniquement), pas de copy
            shouldProcess = false;
          } else if (file.path.startsWith('workspace-template/')) {
            // #3111 — géré par le bloc dédié (create-only + journal), pas de copy
            shouldProcess = false;
          } else if (file.path.startsWith('schedules/')) {
            shouldProcess = hasSchedulesTarget;
          } else if (file.path.startsWith('mcp-settings/')) {
            // #601: Handle all MCP settings files (mcp_settings.json, mcp_user.json, mcp_project.json)
            shouldProcess = hasMcpTarget || hasMcpTargets;
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
          } else if (file.path === 'mcp-settings/mcp_user.json') {
            // #601: User scope - ~/.claude.json (mcpServers section)
            if (!inventory.paths.claudeJson) {
              this.logger.warn('Chemin ~/.claude.json non disponible dans l\'inventaire');
              continue;
            }
            destPath = inventory.paths.claudeJson;
          } else if (file.path === 'mcp-settings/mcp_project.json') {
            // #601: Project scope - .mcp.json (project root)
            if (!inventory.paths.projectMcpJson) {
              this.logger.warn('Chemin .mcp.json non disponible dans l\'inventaire');
              continue;
            }
            destPath = inventory.paths.projectMcpJson;
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
          } else if (file.path.startsWith('claude-config/')) {
            // claude-config/.claude.json -> ~/.claude.json
            destPath = join(homedir(), '.claude.json');
          } else if (file.path.startsWith('modes-yaml/')) {
            // modes-yaml/custom_modes.yaml -> %APPDATA%/.../custom_modes.yaml
            destPath = join(getExtensionSettingsPath(), 'custom_modes.yaml');
          } else if (file.path.startsWith('schedules/')) {
            // #2411 — schedules/schedules.json -> .roo/schedules.json (skip, handled by merge above)
            continue;
          } else {
            this.logger.warn(`Type de fichier non supporté ou chemin inconnu: ${file.path}`);
            continue;
          }

          if (!destPath) continue;

          // Traitement spécial pour les settings Roo (state.vscdb SQLite) - Issue #509, #547
          const isSettingsFile = file.type === 'roo_settings';
          if (isSettingsFile) {
            // Use BOM-safe read (issue #664)
            const rawContent = await readJSONFileWithoutBOM<any>(sourcePath);
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
              // Backup via RollbackManager (#537 Phase 2)
              if (!options.dryRun) {
                await rollback.createAndTrack(destPath);
              }
            }

            details.push({
              file: file.path,
              dest: destPath,
              action,
              size: rawContent.length
            });
            // #3998 — fichier texte (rules) : pas de check JSON, miroir du skip de validateConfigApplication
            if (options.dryRun && options.validate) {
              plannedValidations.push({ target: destPath, success: true, details: { skipped: 'text file' } });
            }

            if (!options.dryRun) {
              await fs.mkdir(dirname(destPath), { recursive: true });
              await fs.writeFile(destPath, rawContent, 'utf-8');
              filesApplied++;
              appliedFilePaths.push({ path: destPath, type: file.type || 'rules_config' });
            }
            continue;
          }

          // Lecture du contenu source (JSON) - Use BOM-safe read (issue #664)
          const sourceContent = await readJSONFileWithoutBOM<any>(sourcePath);

          // Fix #759: Denormalize content before applying (restore paths and secrets)
          const configType = (file.type || 'mcp_config') as import('./ConfigNormalizationService.js').ConfigType;
          const denormalizedContent = await this.normalizationService.denormalize(sourceContent, configType);

          // Issue #349: Filtrage granulaire des serveurs MCP si targets mcp:xxx sont spécifiés
          let finalContent = denormalizedContent;
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
              // Use BOM-safe read (issue #664)
              const localContent = await readJSONFileWithoutBOM<any>(destPath);
              finalContent = JsonMerger.merge(finalContent, localContent, { arrayStrategy: 'replace' });
            }

            // Backup via RollbackManager (#537 Phase 2)
            if (!options.dryRun) {
                await rollback.createAndTrack(destPath);
            }
          }

          details.push({
            file: file.path,
            dest: destPath,
            action,
            size: JSON.stringify(finalContent).length
          });
          // #3998 — dryRun+validate : round-trip du contenu prévu (catch les
          // packages dont la fusion/denormalisation produit du JSON non sérialisable).
          if (options.dryRun && options.validate) {
            try {
              JSON.parse(JSON.stringify(finalContent));
              plannedValidations.push({ target: destPath, success: true });
            } catch (planErr: any) {
              plannedValidations.push({
                target: destPath,
                success: false,
                details: { error: planErr instanceof Error ? planErr.message : String(planErr) }
              });
            }
          }

          // Écriture ou simulation
          if (!options.dryRun) {
            // S'assurer que le répertoire parent existe
            await fs.mkdir(dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, JSON.stringify(finalContent, null, 2));
            filesApplied++;
            appliedFilePaths.push({ path: destPath, type: file.type || 'mcp_config' });
          }

        } catch (err: any) {
          const errorMsg = `Erreur lors du traitement de ${file.path}: ${err.message}`;
          this.logger.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // 3. Post-apply health check (#537 Phase 2)
      if (!options.dryRun && appliedFilePaths.length > 0 && errors.length === 0) {
        const healthChecker = new ConfigHealthCheckService(this.logger);
        const healthErrors: string[] = [];

        for (const { path: filePath, type } of appliedFilePaths) {
          // Map file type to health check ConfigType
          const configTypeMap: Record<string, HealthCheckConfigType> = {
            'mcp_config': 'mcp_config',
            'mode_definition': 'mode_definition',
            'roomodes_config': 'roomodes_config',
            'model_config': 'model_config',
            'rules_config': 'rules_config',
            'profile_settings': 'profile_settings',
            'settings_config': 'settings_config'
          };
          const healthConfigType = configTypeMap[type] || 'mcp_config';

          // Only check JSON files (rules are text, skip them)
          if (type === 'rules_config') continue;

          try {
            const result = await healthChecker.checkHealth(filePath, healthConfigType, {
              checks: ['file_readable', 'json_valid']
            });

            if (!result.healthy) {
              const msg = `Health check FAILED for ${filePath}: ${result.errors.join('; ')}`;
              this.logger.error(msg);
              healthErrors.push(msg);
            }
          } catch (err: any) {
            this.logger.warn(`Health check error for ${filePath}: ${err.message}`);
          }
        }

        // If health checks failed, rollback all changes
        if (healthErrors.length > 0) {
          this.logger.warn(`Rolling back ${rollback.size} files due to health check failures`);
          const rollbackResult = await rollback.restoreAll(true);
          if (!rollbackResult.success) {
            errors.push(`Rollback partially failed: ${rollbackResult.failedFiles.length} files could not be restored`);
          }
          errors.push(...healthErrors);
          filesApplied = 0; // All changes rolled back
        } else {
          // All checks passed, release backups (keep for history)
          await rollback.release(false);
          this.logger.info(`Post-apply health check passed for ${appliedFilePaths.length} files`);
        }
      }

    } catch (err: any) {
      const errorMsg = `Erreur globale applyConfig: ${err.message}`;
      this.logger.error(errorMsg);
      errors.push(errorMsg);

      // Rollback tracked backups on global failure (#537 Phase 2)
      if (rollback.size > 0) {
        this.logger.warn(`Rolling back ${rollback.size} files due to global error`);
        try {
          const rollbackResult = await rollback.restoreAll(true);
          if (!rollbackResult.success) {
            errors.push(`Rollback partially failed: ${rollbackResult.failedFiles.length} files could not be restored`);
          }
        } catch (rollbackErr: any) {
          errors.push(`Rollback failed: ${rollbackErr.message}`);
        }
      }
    }

    if (options.dryRun) {
        this.logger.info('DryRun terminé', { details });
        // #3998 — la validation ne doit plus être court-circuitée par le dryRun :
        // apply(dryRun=true, validate=true) répond désormais avec un champ
        // `validation` réel (contenu prévu, en mémoire), au lieu d'un succès
        // silencieux sans vérification.
        let dryRunValidation: ApplyConfigResult['validation'] = undefined;
        if (options.validate && plannedValidations.length > 0 && errors.length === 0) {
            dryRunValidation = {
                performed: true,
                success: plannedValidations.every((pv) => pv.success),
                targetValidations: plannedValidations
            };
            if (!dryRunValidation.success) {
                this.logger.warn('Validation dryRun: contenu prévu invalide (package à corriger avant apply réel)');
            }
        }
        return {
            success: errors.length === 0,
            filesApplied: 0, // 0 car rien n'a été écrit
            errors,
            dryRunDetails: details, // Champ hypothétique ajouté au résultat pour le rapport
            validation: dryRunValidation,
            workspaceTemplate: workspaceTemplateResult
        } as any;
    }

    // #2413 — Validation post-apply optionnelle pour applyConfig
    let validation: ApplyConfigResult['validation'] = undefined;
    if (options.validate && errors.length === 0 && appliedFilePaths.length > 0) {
      validation = await this.validateConfigApplication(appliedFilePaths);
      if (!validation.success) {
        this.logger.warn(`Validation post-apply applyConfig: drift détecté`);
      }
    }

    return {
      success: errors.length === 0,
      filesApplied,
      errors,
      validation,
      workspaceTemplate: workspaceTemplateResult
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

        // Use BOM-safe read (issue #664)
        const latestData = await readJSONFileWithoutBOM<{path: string}>(latestPath);
        const modelConfigPath = join(latestData.path, 'model-configs', 'model-configs.json');

        if (!existsSync(modelConfigPath)) {
          throw new ConfigSharingServiceError(
            `model-configs.json non trouvé dans la config publiée de '${options.sourceMachineId}'. La machine doit publier avec targets=['model-configs']`,
            ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
            { sourceMachineId: options.sourceMachineId, modelConfigPath }
          );
        }

        // Use BOM-safe read (issue #664)
        modelConfigs = await readJSONFileWithoutBOM<any>(modelConfigPath);
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

        // Use BOM-safe read (issue #664)
        modelConfigs = await readJSONFileWithoutBOM<any>(localModelConfigPath);
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
        ? await readJSONFileWithoutBOM<any>(localModelConfigPath) // Use BOM-safe read (issue #664)
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
          // #4149 (famille ms#1630) : profile.name vient du fichier profils
          // GDrive — un `"` dans le nom séparait l'argument dans la forme
          // interpolée. argv sans shell : la valeur devient un littéral.
          // process.execPath spawne node.exe directement : pas un .cmd, donc
          // pas de spawn EINVAL (CVE-2024-27980).
          const argv = [generateModesPath, '--profile', profile.name, '--deploy'];
          this.logger.info(`Génération .roomodes: ${process.execPath} ${argv.join(' ')}`);
          try {
            const output = execFileSync(process.execPath, argv, {
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

      // 6. #2411 — Apply schedules overrides from profile (if present)
      let schedulesApplied = 0;
      const schedulesMerged: string[] = [];
      if (profile.schedulesOverrides && !options.dryRun) {
        try {
          const localSchedulesPath = join(inventory.paths.rooExtensions, '.roo', 'schedules.json');

          // Read current local schedules
          let localSchedules: any[] = [];
          if (existsSync(localSchedulesPath)) {
            const localRaw = await fs.readFile(localSchedulesPath, 'utf-8');
            const localData = JSON.parse(localRaw) as { schedules: any[] };
            localSchedules = localData.schedules || [];
          }

          // Merge: profile overrides are the source, local schedules are the base
          const overridesArray = Array.isArray(profile.schedulesOverrides)
            ? profile.schedulesOverrides
            : Object.values(profile.schedulesOverrides);
          const merged = this.mergeSchedulesById(overridesArray, localSchedules);

          // Track which schedule IDs were affected
          for (const override of overridesArray) {
            if (override.id) {
              schedulesMerged.push(override.id);
            }
          }
          schedulesApplied = overridesArray.length;

          // Backup before write
          if (options.backup !== false && existsSync(localSchedulesPath)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            await fs.copyFile(localSchedulesPath, `${localSchedulesPath}.backup_${ts}`);
          }

          await fs.mkdir(dirname(localSchedulesPath), { recursive: true });
          await fs.writeFile(localSchedulesPath, JSON.stringify({ schedules: merged }, null, 2), 'utf-8');
          this.logger.info(`Schedules overrides applied: ${schedulesApplied} schedules merged`);
        } catch (schedErr: any) {
          errors.push(`Schedules overrides failed: ${schedErr.message}`);
        }
      }

      // 7. #2411 — Apply rules overrides from profile (if present)
      let rulesApplied = 0;
      const rulesSynced: string[] = [];
      if (profile.rulesOverrides && !options.dryRun) {
        try {
          const rulesDir = join(inventory.paths.rooExtensions, '.roo', 'rules');
          await fs.mkdir(rulesDir, { recursive: true });

          // Rules source: from roo-config/rules-global/ or inline in profile
          const rulesSourceDir = join(inventory.paths.rooExtensions, 'roo-config', 'rules-global');

          for (const ruleSpec of profile.rulesOverrides as string[]) {
            if (ruleSpec.startsWith('+')) {
              // Add/copy rule
              const ruleName = ruleSpec.slice(1);
              const srcPath = join(rulesSourceDir, ruleName);
              const destPath = join(rulesDir, ruleName);
              if (existsSync(srcPath)) {
                await fs.copyFile(srcPath, destPath);
                rulesApplied++;
                rulesSynced.push(ruleName);
              } else {
                errors.push(`Rule source not found: ${ruleName}`);
              }
            } else if (ruleSpec.startsWith('-')) {
              // Remove rule (preserve *-local.md files)
              const ruleName = ruleSpec.slice(1);
              if (ruleName.endsWith('-local.md')) {
                this.logger.warn(`Skipping removal of local rule: ${ruleName}`);
                continue;
              }
              const destPath = join(rulesDir, ruleName);
              if (existsSync(destPath)) {
                await fs.unlink(destPath);
                rulesApplied++;
                rulesSynced.push(ruleName);
              }
            } else {
              // Plain name = copy (backward compat)
              const srcPath = join(rulesSourceDir, ruleSpec);
              const destPath = join(rulesDir, ruleSpec);
              if (existsSync(srcPath)) {
                await fs.copyFile(srcPath, destPath);
                rulesApplied++;
                rulesSynced.push(ruleSpec);
              }
            }
          }
          this.logger.info(`Rules overrides applied: ${rulesApplied} rules synced`);
        } catch (ruleErr: any) {
          errors.push(`Rules overrides failed: ${ruleErr.message}`);
        }
      }

      // 8. Validation post-apply (#2413) — vérifie que le profil est effectivement déployé
      let validation: ApplyProfileResult['validation'] = undefined;
      if (options.validate && !options.dryRun) {
        const roomodesPath = join(inventory.paths.rooExtensions, '.roomodes');
        validation = await this.validateProfileApplication(profile, newModeApiConfigs, roomodesPath);
        if (!validation.success) {
          this.logger.warn(`Validation post-apply: drift détecté (${validation.drift?.length || 0} entrées)`);
        } else {
          this.logger.info('Validation post-apply: OK');
        }
      }

      // 9. #2543 Phase 1(b) — Write listApiConfigMeta + currentApiConfigName to vscdb
      let vscdbWritten = false;
      if (!options.dryRun && modelConfigs.apiConfigs) {
        try {
          const { RooSettingsService } = await import('./RooSettingsService.js');
          const settingsService = new RooSettingsService({
            targetExtension: options.targetExtension || 'roo'
          });

          if (settingsService.isAvailable()) {
            // Build listApiConfigMeta from apiConfigs
            const listApiConfigMeta = Object.entries(modelConfigs.apiConfigs).map(
              ([id, config]: [string, any]) => ({
                id,
                name: config.name || id,
                apiProvider: config.apiProvider,
                ...(config.modelId && { modelId: config.modelId }),
                ...(config.openAiModelId && { openAiModelId: config.openAiModelId }),
              })
            );

            // Determine default config name
            const defaultConfigName = profile.defaultApiConfig || 'default';

            const settingsToInject: Record<string, unknown> = {
              listApiConfigMeta,
              currentApiConfigName: defaultConfigName,
              modeApiConfigs: newModeApiConfigs,
            };

            const injectResult = await settingsService.injectSettings(settingsToInject, {
              keys: ['listApiConfigMeta', 'currentApiConfigName', 'modeApiConfigs'],
            });

            vscdbWritten = true;
            this.logger.info(`vscdb updated (${options.targetExtension || 'roo'}): ${listApiConfigMeta.length} configs written, default="${defaultConfigName}", applied=${injectResult.applied}`);
          } else {
            this.logger.warn('state.vscdb not available for listApiConfigMeta write (non-fatal)');
          }
        } catch (vscdbErr: any) {
          // Non-fatal — apply_profile succeeds even if vscdb write fails
          const errMsg = `vscdb listApiConfigMeta write failed: ${vscdbErr.message}`;
          this.logger.warn(errMsg);
          errors.push(errMsg);
        }
      }

      return {
        success: true,
        profileName: profile.name,
        modesConfigured: Object.keys(newModeApiConfigs).length,
        apiConfigsCount: Object.keys(modelConfigs.apiConfigs || {}).length,
        backupPath,
        roomodesGenerated,
        schedulesApplied: schedulesApplied > 0 ? schedulesApplied : undefined,
        rulesApplied: rulesApplied > 0 ? rulesApplied : undefined,
        vscdbWritten,
        changes: {
          modeApiConfigs: newModeApiConfigs,
          profileThresholds: newThresholds,
          schedulesMerged: schedulesMerged.length > 0 ? schedulesMerged : undefined,
          rulesSynced: rulesSynced.length > 0 ? rulesSynced : undefined
        },
        errors: errors.length > 0 ? errors : undefined,
        validation
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
   * #2413 — Valide qu'un profil de modèle est effectivement appliqué après applyProfile().
   *
   * Vérifie deux niveaux :
   *  1. `.roomodes` déployé : chaque mode listé dans `expectedModeApiConfigs` doit avoir
   *     l'`apiConfigId` attendu dans `customModes[]`. Supporte les formats YAML et JSON.
   *  2. `state.vscdb` (via RooSettingsService) : lit `currentApiConfigName` pour signaler
   *     un éventuel désalignement si VS Code n'a pas été redémarré.
   *
   * NOTE : Drift sur `state.vscdb` n'est PAS toujours un échec — c'est attendu tant que
   * Roo Code/VS Code n'a pas été relancé. C'est exposé comme information, non comme erreur.
   *
   * @param profile - Profil source (avec `modeOverrides`, `defaultApiConfig` optionnel)
   * @param expectedModeApiConfigs - Mode → apiConfigId attendu, déjà fusionné avec defaults
   * @param roomodesPath - Chemin absolu vers `.roomodes`
   */
  private async validateProfileApplication(
    profile: any,
    expectedModeApiConfigs: Record<string, string>,
    roomodesPath: string,
  ): Promise<NonNullable<ApplyProfileResult['validation']>> {
    const drift: Array<{ field: string; expected: any; actual: any }> = [];

    // 1. Lire et parser .roomodes (format YAML par défaut sur disque, JSON aussi supporté)
    let deployedModes: any = null;
    if (!existsSync(roomodesPath)) {
      drift.push({ field: '.roomodes', expected: 'existing file', actual: 'missing' });
    } else {
      try {
        const content = await fs.readFile(roomodesPath, 'utf-8');
        // Try JSON first (generate-modes.js default format), then YAML
        try {
          deployedModes = JSON.parse(content);
        } catch {
          deployedModes = yaml.load(content);
        }
      } catch (e: any) {
        drift.push({ field: '.roomodes', expected: 'parseable content', actual: `parse error: ${e.message}` });
      }
    }

    // 2. Comparer chaque mode du profile.modeOverrides vs .roomodes
    if (deployedModes && Array.isArray(deployedModes.customModes)) {
      // Vérifier uniquement les modes explicitement dans modeOverrides du profil
      // (pas les modes "default" injectés artificiellement par applyProfile)
      const explicitOverrides = profile?.modeOverrides || {};
      for (const [modeSlug, expectedApiConfigId] of Object.entries(explicitOverrides)) {
        const deployedMode = deployedModes.customModes.find((m: any) => m && m.slug === modeSlug);
        if (!deployedMode) {
          drift.push({
            field: `customModes.${modeSlug}`,
            expected: 'present',
            actual: 'missing',
          });
          continue;
        }
        if (deployedMode.apiConfigId !== expectedApiConfigId) {
          drift.push({
            field: `customModes.${modeSlug}.apiConfigId`,
            expected: expectedApiConfigId,
            actual: deployedMode.apiConfigId ?? null,
          });
        }
      }
    } else if (deployedModes !== null) {
      drift.push({
        field: '.roomodes.customModes',
        expected: 'array',
        actual: typeof deployedModes.customModes,
      });
    }

    // 3. Lire state.vscdb pour currentApiConfigName via RooSettingsService
    let activeApiConfigName: string | undefined;
    let activeApiConfigInSync: boolean | undefined;
    try {
      const rooSettings = new RooSettingsService();
      if (rooSettings.isAvailable()) {
        const value = await rooSettings.getSetting('currentApiConfigName');
        activeApiConfigName = typeof value === 'string' ? value : undefined;
        // Si le profil spécifie un defaultApiConfig, drift si state.vscdb ne le reflète pas.
        // Sinon (cas courant : profil-by-mode-only), on rapporte juste activeApiConfigName.
        if (profile?.defaultApiConfig && activeApiConfigName) {
          if (activeApiConfigName !== profile.defaultApiConfig) {
            activeApiConfigInSync = false;
            // state.vscdb drift est INFORMATIF — pas un fail strict (VS Code restart needed)
            // On le pousse dans drift pour visibilité mais on ne le compte pas comme échec critique.
            drift.push({
              field: 'state.vscdb.currentApiConfigName',
              expected: profile.defaultApiConfig,
              actual: activeApiConfigName,
            });
          } else {
            activeApiConfigInSync = true;
          }
        }
      } else {
        // state.vscdb non disponible — non-fatal
        activeApiConfigInSync = undefined;
      }
    } catch (e: any) {
      this.logger.warn(`Validation: lecture state.vscdb échouée (non-fatal): ${e.message}`);
      activeApiConfigInSync = undefined;
    }

    return {
      performed: true,
      success: drift.length === 0,
      drift: drift.length > 0 ? drift : undefined,
      activeApiConfigName,
      activeApiConfigInSync,
    };
  }

  /**
   * #2413 — Validation post-apply pour `applyConfig`. Pour chaque target appliqué,
   * exécute un check basique (`json_valid` / `file_readable`) via `ConfigHealthCheckService`.
   * Cette version est intentionnellement minimaliste — l'objectif principal de #2413 est
   * la validation profile/modes (cf. `validateProfileApplication`).
   */
  private async validateConfigApplication(
    appliedFiles: Array<{ path: string; type: string }>,
  ): Promise<NonNullable<ApplyConfigResult['validation']>> {
    const healthChecker = new ConfigHealthCheckService(this.logger);
    const targetValidations: Array<{ target: string; success: boolean; details?: any }> = [];

    for (const { path: filePath, type } of appliedFiles) {
      // Skip rules (text files, no JSON check)
      if (type === 'rules_config') {
        targetValidations.push({ target: filePath, success: true, details: { skipped: 'text file' } });
        continue;
      }

      const configTypeMap: Record<string, HealthCheckConfigType> = {
        'mcp_config': 'mcp_config',
        'mode_definition': 'mode_definition',
        'roomodes_config': 'roomodes_config',
        'model_config': 'model_config',
        'profile_settings': 'profile_settings',
        'settings_config': 'settings_config',
      };
      const healthConfigType = configTypeMap[type] || 'mcp_config';

      try {
        const result = await healthChecker.checkHealth(filePath, healthConfigType, {
          checks: ['file_readable', 'json_valid'],
        });
        targetValidations.push({
          target: filePath,
          success: result.healthy,
          details: result.healthy ? undefined : { errors: result.errors },
        });
      } catch (err: any) {
        targetValidations.push({
          target: filePath,
          success: false,
          details: { error: err.message },
        });
      }
    }

    const allSuccess = targetValidations.every((tv) => tv.success);
    return {
      performed: true,
      success: allSuccess,
      targetValidations,
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

          // Lecture et normalisation (BOM-safe #664)
          const content = await readJSONFileWithoutBOM<any>(srcPath);
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

  /**
   * Collecte les settings MCP selon le scope Claude Code
   * #601: Support scopes officiels Claude Code (user/project/settings)
   *
   * @param tempDir - Répertoire temporaire pour la collecte
   * @param mcpServerNames - Optionnel, noms des serveurs MCP spécifiques à collecter
   * @param scope - Scope Claude Code: 'user' (~/.claude.json), 'project' (.mcp.json), 'settings' (skip)
   */
  private async collectMcpSettings(tempDir: string, mcpServerNames?: string[], scope?: ClaudeCodeScope): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const mcpDir = join(tempDir, 'mcp-settings');
    await fs.mkdir(mcpDir, { recursive: true });

    // #601: Pour scope 'settings', skip la collecte MCP (settings.json n'a pas de mcpServers)
    if (scope === 'settings') {
      this.logger.info('Scope=settings: Skipping MCP collection (settings.json does not contain MCPs)');
      return files;
    }

    // Récupérer l'inventaire pour trouver les chemins
    const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'localhost';
    const inventory = await this.inventoryService.getMachineInventory() as any;

    // #601: Déterminer le chemin selon le scope
    let mcpSettingsPath: string;
    let destFileName: string;
    let sourceDescription: string;

    if (scope === 'project') {
      // Project scope: .mcp.json (projet local)
      if (!inventory?.paths?.projectMcpJson) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.projectMcpJson non disponible. Impossible de collecter les settings MCP.',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { machineId, missingPath: 'projectMcpJson', scope }
        );
      }
      mcpSettingsPath = inventory.paths.projectMcpJson;
      destFileName = 'mcp_project.json';
      sourceDescription = '.mcp.json (project scope)';
    } else if (scope === 'user') {
      // User scope: ~/.claude.json (mcpServers section)
      if (!inventory?.paths?.claudeJson) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.claudeJson non disponible. Impossible de collecter les settings MCP.',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { machineId, missingPath: 'claudeJson', scope }
        );
      }
      mcpSettingsPath = inventory.paths.claudeJson;
      destFileName = 'mcp_user.json';
      sourceDescription = '~/.claude.json (user scope)';
    } else {
      // Défaut: VS Code extension settings (rétrocompatibilité)
      if (!inventory?.paths?.mcpSettings) {
        throw new ConfigSharingServiceError(
          'Inventaire incomplet: paths.mcpSettings non disponible. Impossible de collecter les settings MCP.',
          ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
          { machineId, missingPath: 'mcpSettings', scope }
        );
      }
      mcpSettingsPath = inventory.paths.mcpSettings;
      destFileName = 'mcp_settings.json';
      sourceDescription = 'mcp_settings.json (VS Code extension)';
    }

    this.logger.info(`Collecte des settings MCP depuis: ${mcpSettingsPath} (${sourceDescription})`);

    if (existsSync(mcpSettingsPath)) {
      const destPath = join(mcpDir, destFileName);

      // Lecture et normalisation (avec gestion BOM)
      const content = await readJSONFileWithoutBOM(mcpSettingsPath);

      // #601: Pour ~/.claude.json, extraire uniquement la section mcpServers
      let mcpContent = content;
      if (scope === 'user') {
        if (!content.mcpServers) {
          this.logger.warn('Aucun serveur MCP trouvé dans ~/.claude.json (section mcpServers)');
          return files;
        }
        mcpContent = { mcpServers: content.mcpServers };
      } else if (scope === 'project') {
        // .mcp.json contient directement mcpServers
        if (!content.mcpServers) {
          this.logger.warn('Aucun serveur MCP trouvé dans .mcp.json');
          return files;
        }
      }

      // Filtrage des serveurs MCP spécifiques si demandé
      if (mcpServerNames && mcpServerNames.length > 0) {
        if (!mcpContent.mcpServers) {
          this.logger.warn('Aucun serveur MCP trouvé dans la configuration');
          return files;
        }

        const filteredServers: any = {};
        for (const serverName of mcpServerNames) {
          if (mcpContent.mcpServers[serverName]) {
            filteredServers[serverName] = mcpContent.mcpServers[serverName];
          } else {
            this.logger.warn(`Serveur MCP non trouvé: ${serverName}`);
          }
        }

        if (Object.keys(filteredServers).length === 0) {
          this.logger.warn('Aucun serveur MCP correspondant trouvé');
          return files;
        }

        mcpContent.mcpServers = filteredServers;
      }

      const normalized = await this.normalizationService.normalize(mcpContent, 'mcp_config');

      // Écriture du fichier normalisé
      await fs.writeFile(destPath, JSON.stringify(normalized, null, 2));

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: `mcp-settings/${destFileName}`,
        hash,
        type: 'mcp_config',
        size: stats.size
      });
    } else {
        this.logger.warn(`Fichier MCP non trouvé: ${mcpSettingsPath}`);
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

        // Lecture du fichier de profils (BOM-safe #664)
        const content = await readJSONFileWithoutBOM<any>(profilesSourcePath);

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

        // Lecture BOM-safe #664
        const content = await readJSONFileWithoutBOM<any>(mappingsSourcePath);
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

        // Lecture BOM-safe #664
        const content = await readJSONFileWithoutBOM<any>(baselineSourcePath);
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

      // .roomodes peut être YAML (generate-modes.js --format yaml, canonical fleet post-#596)
      // ou JSON - parser défensivement, comme validateProfileApplication (#2810). BOM-safe #664.
      const raw = await readFileWithoutBOM(roomodesPath);
      let content: any;
      try {
        content = JSON.parse(raw); // JSON d'abord (format par défaut de generate-modes.js)
      } catch {
        content = yaml.load(raw); // Fallback YAML (format canonique flotte)
      }
      // #2810 follow-up: yaml.load est permissif — un .roomodes corrompu (ex. 'not valid json {{{')
      // résout vers un scalar (string/number/null/array) au lieu de throw, et serait collecté
      // silencieusement comme garbage dans le package shared-state (puis appliqué cassé sur les
      // autres machines). Un .roomodes valide (JSON ou YAML) doit résoudre vers un plain object.
      if (content === null || typeof content !== 'object' || Array.isArray(content)) {
        const contentType = Array.isArray(content) ? 'array' : (content === null ? 'null' : typeof content);
        throw new ConfigSharingServiceError(
          `.roomodes invalide à ${roomodesPath}: le contenu n'est pas un objet roomodes valide (type=${contentType}).`,
          ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
          { roomodesPath, contentType }
        );
      }
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

      // Lecture BOM-safe #664
      const content = await readJSONFileWithoutBOM<any>(modelConfigPath);
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
  /**
   * Collecte ~/.claude.json (Claude Code MCP configuration)
   * #603 B2.1
   */
  private async collectClaudeConfig(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const claudeDir = join(tempDir, 'claude-config');
    await fs.mkdir(claudeDir, { recursive: true });

    const claudeJsonPath = join(homedir(), '.claude.json');

    if (!existsSync(claudeJsonPath)) {
      this.logger.warn(`Fichier ~/.claude.json non trouvé: ${claudeJsonPath}`);
      return files;
    }

    try {
      const destPath = join(claudeDir, '.claude.json');
      await fs.copyFile(claudeJsonPath, destPath);
      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'claude-config/.claude.json',
        hash,
        type: 'claude_config',
        size: stats.size
      });

      this.logger.info(`Claude Code config collectée depuis: ${claudeJsonPath}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte de ~/.claude.json: ${error}`);
    }

    return files;
  }

  /**
   * #3545 — Collecte ~/.claude/settings.json en snapshot de COMPARAISON.
   *
   * Le snapshot embarque : état du fichier (missing/empty/invalid/ok),
   * projection harmonisation (allow-list uniquement), digests des clés env
   * sensibles, NOMS des autres clés top-level (permissions/hooks : présence
   * seulement). Aucune valeur sensible n'y figure jamais.
   *
   * Un snapshot n'est pas un apply payload : applyConfig n'accepte que
   * claude-settings/canon.json (clés explicites validées).
   */
  private async collectClaudeSettings(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const settingsDir = join(tempDir, 'claude-settings');
    await fs.mkdir(settingsDir, { recursive: true });

    try {
      const service = new ClaudeSettingsService();
      const read = await service.read();
      const machineId = process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown';
      const snapshot = buildSnapshot(read, machineId, new Date().toISOString());

      const destPath = join(settingsDir, 'claude-settings.json');
      await fs.writeFile(destPath, JSON.stringify(snapshot, null, 2), 'utf-8');

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'claude-settings/claude-settings.json',
        hash,
        type: 'claude_settings',
        size: stats.size,
      });

      this.logger.info(`Claude settings snapshot collecté (${read.state}): ${service.getPath()}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte de ~/.claude/settings.json: ${error}`);
    }

    return files;
  }

  /**
   * Collecte custom_modes.yaml (modes globaux Roo)
   * #603 B2.1
   */
  private async collectModesYaml(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const modesYamlDir = join(tempDir, 'modes-yaml');
    await fs.mkdir(modesYamlDir, { recursive: true });

    const rooSettingsDir = getExtensionSettingsPath();
    const yamlPath = join(rooSettingsDir, 'custom_modes.yaml');

    if (!existsSync(yamlPath)) {
      this.logger.warn(`Fichier custom_modes.yaml non trouvé: ${yamlPath}`);
      return files;
    }

    try {
      const destPath = join(modesYamlDir, 'custom_modes.yaml');
      await fs.copyFile(yamlPath, destPath);
      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'modes-yaml/custom_modes.yaml',
        hash,
        type: 'modes_yaml',
        size: stats.size
      });

      this.logger.info(`Modes YAML collectés depuis: ${yamlPath}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte de custom_modes.yaml: ${error}`);
    }

    return files;
  }

  /**
   * #2409 — Collecte l'état des services Windows
   */
  private async collectServices(tempDir: string, serviceTargets: string[]): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const servicesDir = join(tempDir, 'services');
    await fs.mkdir(servicesDir, { recursive: true });

    try {
      const serviceNames = serviceTargets.map(t => {
        const name = (t as string).slice(9); // strip 'services:' prefix
        if (!ServicesConfigService.isValidServiceName(name)) {
          this.logger.warn(`Service inconnu dans le registry: ${name}`);
        }
        return name;
      });

      const servicesConfig = new ServicesConfigService();
      const result = await servicesConfig.collect(serviceNames);

      const destPath = join(servicesDir, 'services-state.json');
      const content = JSON.stringify(result, null, 2);
      await fs.writeFile(destPath, content);

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'services/services-state.json',
        hash,
        type: 'other',
        size: stats.size,
      });

      this.logger.info(`Services collectés: ${result.services.length} entrées`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte des services: ${error}`);
    }

    return files;
  }

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

  /**
   * Collecte les tâches planifiées Windows via SchtasksConfigService
   * #2408 VibeSync Phase 2
   */
  private async collectSchtasks(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const schtasksDir = join(tempDir, 'schtasks');
    await fs.mkdir(schtasksDir, { recursive: true });

    try {
      const schtasksService = new SchtasksConfigService();
      const collectResult = await schtasksService.collect();

      const destPath = join(schtasksDir, 'schtasks-inventory.json');
      const content = JSON.stringify(collectResult, null, 2);
      await fs.writeFile(destPath, content, 'utf-8');

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'schtasks/schtasks-inventory.json',
        hash,
        type: 'other',
        size: stats.size,
      });

      this.logger.info(`Schtasks collectés: ${collectResult.count} tâches`);
    } catch (error) {
      this.logger.warn(`Erreur lors de la collecte des schtasks: ${error}`);
      // Ne pas faire échouer toute la collecte si les schtasks ne sont pas disponibles
    }

    return files;
  }

  /**
   * #2411 — Collecte les schedules Roo (.roo/schedules.json)
   */
  private async collectSchedules(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const schedulesDir = join(tempDir, 'schedules');
    await fs.mkdir(schedulesDir, { recursive: true });

    const inventory = await this.inventoryService.getMachineInventory() as any;
    if (!inventory?.paths?.rooExtensions) {
      this.logger.warn('Inventaire incomplet: paths.rooExtensions non disponible pour collecter schedules');
      return files;
    }

    const schedulesPath = join(inventory.paths.rooExtensions, '.roo', 'schedules.json');

    if (!existsSync(schedulesPath)) {
      this.logger.warn(`schedules.json non trouvé: ${schedulesPath}`);
      return files;
    }

    try {
      const destPath = join(schedulesDir, 'schedules.json');
      await fs.copyFile(schedulesPath, destPath);

      const hash = await this.calculateHash(destPath);
      const stats = await fs.stat(destPath);

      files.push({
        path: 'schedules/schedules.json',
        hash,
        type: 'schedules_config',
        size: stats.size,
      });

      this.logger.info(`Schedules collectées depuis: ${schedulesPath}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la collecte des schedules: ${error}`);
    }

    return files;
  }

  /**
   * #3111 — Résout le répertoire source des modèles de workspace.
   * `ROOSYNC_WORKSPACE_TEMPLATE_DIR` s'il est posé (autoritaire), sinon remontée
   * depuis process.cwd() (≤ 8 niveaux) jusqu'à un dossier contenant
   * `.claude/configs/workspace-template`.
   */
  private resolveWorkspaceTemplateSource(): string | null {
    const explicit = process.env.ROOSYNC_WORKSPACE_TEMPLATE_DIR;
    if (explicit) {
      return explicit;
    }
    let current = process.cwd();
    for (let i = 0; i <= 8; i++) {
      const candidate = join(current, '.claude', 'configs', 'workspace-template');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  /**
   * #3111 — Collecte le modèle de workspace dans le paquet, layout préservé.
   * Les entrées du manifeste portent `workspace-template/<relative>`.
   */
  private async collectWorkspaceTemplate(tempDir: string): Promise<ConfigManifestFile[]> {
    const files: ConfigManifestFile[] = [];
    const destRoot = join(tempDir, 'workspace-template');

    const srcDir = this.resolveWorkspaceTemplateSource();
    if (!srcDir || !existsSync(srcDir)) {
      throw new ConfigSharingServiceError(
        'workspace-template: source template not found (set ROOSYNC_WORKSPACE_TEMPLATE_DIR)',
        ConfigSharingServiceErrorCode.COLLECTION_FAILED,
        { srcDir: srcDir ?? null }
      );
    }

    await this.copyRecursive(srcDir, destRoot);

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          const rel = relative(destRoot, abs).split(sep).join('/');
          const hash = await this.calculateHash(abs);
          const stats = await fs.stat(abs);
          files.push({
            path: `workspace-template/${rel}`,
            hash,
            type: 'other',
            size: stats.size,
          });
        }
      }
    };
    await walk(destRoot);

    this.logger.info(`${files.length} fichiers workspace-template collectés depuis: ${srcDir}`);
    return files;
  }

  /**
   * #2411 — Merge schedules by ID (source overrides target where IDs match)
   *
   * Strategy:
   *  - If a schedule in `source` has the same `id` as one in `target`, the source wins (fields override)
   *  - Schedules in `source` without matching IDs are added
   *  - Schedules in `target` without matching source IDs are preserved
   */
  private mergeSchedulesById(source: any[], target: any[]): any[] {
    const result = [...target.map(s => ({ ...s }))];
    const targetIdMap = new Map(result.map((s, i) => [s.id, i]));

    for (const sourceSchedule of source) {
      if (!sourceSchedule.id) {
        // Schedule without ID — always add
        result.push({ ...sourceSchedule });
        continue;
      }

      const existingIdx = targetIdMap.get(sourceSchedule.id);
      if (existingIdx !== undefined) {
        // ID match — merge: source overrides target fields
        result[existingIdx] = { ...result[existingIdx], ...sourceSchedule };
      } else {
        // New schedule — add
        result.push({ ...sourceSchedule });
        targetIdMap.set(sourceSchedule.id, result.length - 1);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // #3111 — Cible `workspace-template` : apply CREATE-ONLY + journal de rollback.
  // -------------------------------------------------------------------------

  /**
   * #3111 — Chemin du journal pour un workspace (un fichier par workspace, clé
   * = sha256(realpath(workspacePath))[:16]).
   */
  private workspaceTemplateJournalPath(workspacePath: string): string {
    const journalDir = process.env.ROOSYNC_WORKSPACE_TEMPLATE_JOURNAL_DIR
      || join(homedir(), '.roo-state-manager', 'workspace-template-journal');
    const key = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
    return join(journalDir, `${key}.json`);
  }

  /** realpath best-effort : retombe sur resolve() si le chemin n'existe pas encore. */
  private async resolveRealPathSafe(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch {
      return resolvePath(p);
    }
  }

  /** Garde-catastrophe : refuse une racine de disque ou le répertoire personnel. */
  private isCatastrophicWorkspacePath(p: string): boolean {
    const norm = (s: string) => {
      const r = resolvePath(s);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const resolved = resolvePath(p);
    const driveRoot = parsePath(resolved).root;
    if (driveRoot && norm(resolved) === norm(driveRoot)) {
      return true;
    }
    const home = homedir();
    if (home && norm(resolved) === norm(home)) {
      return true;
    }
    return false;
  }

  /** #3111 — `child` est-il `parent` ou l'un de ses descendants (comparaison normalisée) ? */
  private isPathWithin(child: string, parent: string): boolean {
    const norm = (s: string) => {
      const r = resolvePath(s);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
  }

  /** #3111 — Égalité de deux chemins après normalisation (realpath déjà appliqué en amont). */
  private isSamePath(a: string, b: string): boolean {
    return this.isPathWithin(a, b) && this.isPathWithin(b, a);
  }

  /**
   * #3111 — Le fichier journalisé est-il encore EXACTEMENT ce que l'apply a écrit ?
   * Journal ancien sans empreinte : traité comme intact (compatibilité).
   * Illisible : traité comme modifié (fail-closed — on ne supprime pas ce qu'on
   * ne peut pas prouver intact).
   */
  private async isTemplateFileUnchanged(file: string, expectedHash?: string): Promise<boolean> {
    if (!expectedHash) return true;
    try {
      const current = await fs.readFile(file);
      return createHash('sha256').update(current).digest('hex') === expectedHash;
    } catch {
      return false;
    }
  }

  /**
   * Crée `dir` en pistant les répertoires RÉELLEMENT créés (shallow-first).
   *
   * #3111 (revue po-2028, 23/11) — création NIVEAU PAR NIVEAU, chaque répertoire
   * étant enregistré DÈS qu'il existe. L'ancienne forme `mkdir({recursive:true})`
   * puis remplissage du Set ne laissait aucune trace d'un `mkdir` partiellement
   * réussi : un ENOSPC au milieu de l'arborescence créait des ancêtres orphelins
   * hors journal, que le create-only rendait ensuite non réparables.
   */
  private async ensureDirsTracked(dir: string, createdDirsSet: Set<string>): Promise<void> {
    const missing: string[] = [];
    let current = dir;
    while (!existsSync(current)) {
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (missing.length === 0) return;
    // `missing` est deepest-first : on l'inverse pour créer parent avant enfant.
    for (const d of missing.reverse()) {
      try {
        await fs.mkdir(d);
      } catch (mkdirErr) {
        // Course bénigne : un autre acteur a créé le répertoire entre-temps.
        // Il n'est alors PAS de notre fait : ne pas l'enregistrer comme créé.
        if ((mkdirErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw mkdirErr;
      }
      createdDirsSet.add(d);
    }
  }

  private async writeWorkspaceTemplateJournal(
    journalPath: string,
    workspacePath: string,
    files: string[],
    createdDirs: string[],
    fileHashes: Record<string, string>
  ): Promise<void> {
    await fs.mkdir(dirname(journalPath), { recursive: true });
    const payload = {
      workspacePath,
      appliedAt: new Date().toISOString(),
      files,
      fileHashes,
      createdDirs,
    };
    // #3111 — écriture atomique du journal aussi : une coupure pendant sa
    // réécriture ne tronque pas un journal existant (le précédent reste lisible).
    const tmp = `${journalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      await fs.rename(tmp, journalPath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* tmp jamais créé / déjà retiré */ }
      throw err;
    }
  }

  /**
   * #3111 — Applique les modèles `workspace-template/<rel>` du paquet dans
   * `options.workspacePath`. Create-only : jamais d'écrasement. dryRun par
   * défaut = TRUE (`options.dryRun !== false` simule). Écrit un journal des
   * fichiers créés pour un rollback ultérieur.
   */
  private async applyWorkspaceTemplate(
    configDir: string,
    options: ApplyConfigOptions,
    errors: string[]
  ): Promise<{ created: string[]; skippedExisting: string[]; journalPath: string | null }> {
    const created: string[] = [];
    const skippedExisting: string[] = [];
    const createdDirsSet = new Set<string>();
    // #3111 — empreinte du contenu ÉCRIT : le rollback n'efface que ce qui est
    // encore intact (un fichier modifié depuis l'apply est épargné et signalé).
    const fileHashes: Record<string, string> = {};
    // dryRun DEFAULT = TRUE pour cette cible : seul `false` explicite écrit.
    const simulate = options.dryRun !== false;

    // 1. Valider le workspace destination
    const workspacePathRaw = options.workspacePath;
    if (!workspacePathRaw) {
      errors.push('workspace-template: workspacePath est requis pour apply (chemin absolu).');
      return { created, skippedExisting, journalPath: null };
    }
    if (!isAbsolute(workspacePathRaw)) {
      errors.push(`workspace-template: workspacePath doit être ABSOLU: ${workspacePathRaw}`);
      return { created, skippedExisting, journalPath: null };
    }
    const workspacePath = await this.resolveRealPathSafe(workspacePathRaw);
    if (this.isCatastrophicWorkspacePath(workspacePath)) {
      errors.push(`workspace-template: workspacePath refusé (racine de disque ou répertoire personnel): ${workspacePath}`);
      return { created, skippedExisting, journalPath: null };
    }

    // 2. Lire le manifeste du paquet, ne garder que workspace-template/
    const manifestPath = join(configDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      errors.push(`workspace-template: manifest introuvable dans le paquet: ${manifestPath}`);
      return { created, skippedExisting, journalPath: null };
    }
    const manifest = await readJSONFileWithoutBOM<ConfigManifest>(manifestPath);
    const entries = (manifest.files || []).filter(
      f => typeof f.path === 'string' && f.path.startsWith('workspace-template/')
    );

    // #3111 (revue po-2028, 23/11 ; 2ᵉ passe) — journal DURABLE, écrit AVANT
    // publication : l'INTENTION (chemin + empreinte) est journalisée, PUIS le
    // fichier est publié atomiquement SANS écrasement. Un kill/ENOSPC à
    // n'importe quel instant laisse donc un journal ⊇ ce qui est sur disque ;
    // le rollback ignore les entrées absentes (jamais créées) et ne supprime
    // jamais rien sans preuve (create-only ne rend plus l'orphelin invisible).
    const journalPathForWs = simulate ? null : this.workspaceTemplateJournalPath(workspacePath);
    const journalFiles = new Set<string>();
    // Lu UNE fois par apply (avant le premier flush), pas à chaque fichier.
    let journalPrev: { files: string[]; dirs: string[]; hashes: Record<string, string> } | null = null;
    const flushJournal = async (): Promise<void> => {
      if (!journalPathForWs) return;
      // Les ancêtres créés AU-DESSUS du workspace ne sont pas journalisés : la
      // cohérence fail-closed du rollback exige tout DANS le workspace, et les
      // laisser vides est inoffensif — c'est ce qui rend un apply sur workspace
      // neuf (chemin encore inexistant) réellement réparable.
      const dirsInWorkspace = Array.from(createdDirsSet).filter(d => this.isPathWithin(d, workspacePath));
      if (journalFiles.size === 0 && dirsInWorkspace.length === 0) return;
      if (journalPrev === null) {
        journalPrev = { files: [], dirs: [], hashes: {} };
        if (existsSync(journalPathForWs)) {
          try {
            const prev = await readJSONFileWithoutBOM<{ files?: string[]; createdDirs?: string[]; fileHashes?: Record<string, string> }>(journalPathForWs);
            journalPrev = { files: prev.files || [], dirs: prev.createdDirs || [], hashes: prev.fileHashes || {} };
          } catch (mergeErr) {
            errors.push(`workspace-template: journal existant illisible, réécrit: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
          }
        }
      }
      const unionFiles = Array.from(new Set<string>([...journalPrev.files, ...journalFiles]));
      const unionDirs = Array.from(new Set<string>([...journalPrev.dirs, ...dirsInWorkspace]));
      const unionHashes = { ...journalPrev.hashes, ...fileHashes };
      await this.writeWorkspaceTemplateJournal(journalPathForWs, workspacePath, unionFiles, unionDirs, unionHashes);
    };
    /** Solde le journal ; rend false si la durabilité n'est plus garantie. */
    const safeFlush = async (): Promise<boolean> => {
      try {
        await flushJournal();
        return true;
      } catch (jErr) {
        errors.push(`workspace-template: journal non réécrit: ${jErr instanceof Error ? jErr.message : String(jErr)}`);
        return false;
      }
    };

    for (const entry of entries) {
      const relRaw = entry.path.slice('workspace-template/'.length);
      const segs = relRaw.split(/[\\/]+/);
      // Refuser tout segment `..`/vide, un chemin absolu, ou une sortie du workspace.
      if (!relRaw || isAbsolute(relRaw) || segs.some(s => s === '..' || s === '' || s === '.')) {
        errors.push(`workspace-template: chemin invalide (segment interdit): ${entry.path}`);
        continue;
      }
      const dest = resolvePath(workspacePath, relRaw);
      if (dest !== workspacePath && !dest.startsWith(workspacePath + sep)) {
        errors.push(`workspace-template: chemin hors workspace refusé: ${entry.path}`);
        continue;
      }
      const sourcePath = join(configDir, 'workspace-template', ...segs);
      if (!existsSync(sourcePath)) {
        errors.push(`workspace-template: fichier source absent du paquet: ${entry.path}`);
        continue;
      }
      if (existsSync(dest)) {
        // Create-only : jamais d'écrasement.
        skippedExisting.push(segs.join('/'));
        continue;
      }
      if (simulate) {
        created.push(dest);
        continue;
      }
      try {
        await this.ensureDirsTracked(dirname(dest), createdDirsSet);
        const buffer = await fs.readFile(sourcePath);
        const hash = createHash('sha256').update(buffer).digest('hex');
        // 1) INTENTION journalisée AVANT toute écriture. Si ce flush échoue, on
        //    n'écrit RIEN : jamais de fichier sur disque absent du journal.
        fileHashes[dest] = hash;
        journalFiles.add(dest);
        if (!(await safeFlush())) break;
        // 2) Tmp complet puis publication ATOMIQUE SANS ÉCRASEMENT.
        const tmp = `${dest}.roosync-wt-tmp-${process.pid}-${Date.now()}`;
        try {
          await fs.writeFile(tmp, buffer);
          // `link` publie SANS remplacer : EEXIST si la destination est apparue.
          // `rename` REMPLACERAIT silencieusement (MOVEFILE_REPLACE_EXISTING sur
          // Windows, mesuré par la vérification indépendante du 23/11) — il
          // violerait le create-only dans la fenêtre de course.
          let published = false;
          try {
            await fs.link(tmp, dest);
            published = true;
          } catch (linkErr) {
            if ((linkErr as NodeJS.ErrnoException).code !== 'EEXIST') {
              // FS sans liens durs (FAT/exFAT) : repli copyFile EXCL, qui refuse
              // aussi une destination existante.
              try {
                await fs.copyFile(tmp, dest, fsConstants.COPYFILE_EXCL);
                published = true;
              } catch (cfErr) {
                if ((cfErr as NodeJS.ErrnoException).code !== 'EEXIST') throw cfErr;
              }
            }
          }
          if (!published) {
            // Course create-only : le fichier n'est PAS de notre fait — on le
            // retire du journal (l'intention n'a jamais été réalisée) et on
            // l'annonce comme existant.
            journalFiles.delete(dest);
            delete fileHashes[dest];
            await safeFlush();
            skippedExisting.push(segs.join('/'));
            continue;
          }
        } finally {
          try { await fs.unlink(tmp); } catch { /* jamais créé / déjà retiré */ }
        }
        created.push(dest);
      } catch (fileErr) {
        errors.push(`workspace-template: écriture échouée pour ${segs.join('/')}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`);
        // Solde l'intention AVANT de rendre la main (les entrées non réalisées
        // sont inoffensives : le rollback ignore les fichiers absents). Puis on
        // s'arrête — un disque plein ne se répare pas en réessayant le suivant.
        await safeFlush();
        break;
      }
    }

    // 3. Journal : s'il existe (créations, no-op sur journal antérieur, ou solde
    // après échec), on le rend au caller ; sinon null.
    const journalPath: string | null =
      !simulate && journalPathForWs && existsSync(journalPathForWs) ? journalPathForWs : null;

    return { created, skippedExisting, journalPath };
  }

  /**
   * #3111 — Rollback de la cible workspace-template. Supprime UNIQUEMENT les
   * fichiers listés dans le journal, élague les répertoires créés (deepest
   * first, ENOTEMPTY ignoré), puis supprime le journal. `dryRun:true` simule.
   */
  public async rollbackWorkspaceTemplateConfig(options: {
    targets?: ConfigTarget[];
    workspacePath?: string;
    dryRun?: boolean;
  }): Promise<{
    success: boolean;
    filesRemoved: number;
    filesSkippedModified: number;
    dirsRemoved: number;
    journalPath: string | null;
    errors: string[];
    dryRun: boolean;
  }> {
    const errors: string[] = [];
    const result = await this.rollbackWorkspaceTemplate(options, errors);
    return { ...result, errors };
  }

  private async rollbackWorkspaceTemplate(
    options: { targets?: ConfigTarget[]; workspacePath?: string; dryRun?: boolean },
    errors: string[]
  ): Promise<{
    success: boolean;
    filesRemoved: number;
    filesSkippedModified: number;
    dirsRemoved: number;
    journalPath: string | null;
    dryRun: boolean;
  }> {
    const simulate = options.dryRun === true;

    if (!options.targets || !options.targets.includes('workspace-template')) {
      errors.push('workspace-template: rollback exige targets contenant "workspace-template".');
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath: null, dryRun: simulate };
    }

    const workspacePathRaw = options.workspacePath;
    if (!workspacePathRaw || !isAbsolute(workspacePathRaw)) {
      errors.push(`workspace-template: workspacePath ABSOLU requis pour rollback: ${workspacePathRaw ?? '(absent)'}`);
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath: null, dryRun: simulate };
    }

    const workspacePath = await this.resolveRealPathSafe(workspacePathRaw);
    if (this.isCatastrophicWorkspacePath(workspacePath)) {
      errors.push(`workspace-template: workspacePath refusé (racine de disque ou répertoire personnel): ${workspacePath}`);
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath: null, dryRun: simulate };
    }

    // #3111 (revue po-2028, 23/11) — deux clés possibles : `realpath` (le workspace
    // existe aujourd'hui) et `resolve` (apply fait quand il n'existait pas encore).
    // Le repli couvre les différences d'ÉCRITURE (casse, nom court 8.3) ; un alias
    // STRUCTUREL (jonction/symlink) reste refusé par la cohérence fail-closed
    // ci-dessous — jamais de suppression sur un workspace déclaré différent.
    const primaryJournal = this.workspaceTemplateJournalPath(workspacePath);
    const altJournal = this.workspaceTemplateJournalPath(resolvePath(workspacePathRaw));
    const journalPath = existsSync(primaryJournal)
      ? primaryJournal
      : (altJournal !== primaryJournal && existsSync(altJournal) ? altJournal : primaryJournal);
    if (!existsSync(journalPath)) {
      errors.push(`workspace-template: no journal for ${workspacePathRaw} (nothing to roll back)`);
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath: null, dryRun: simulate };
    }

    let journal: { workspacePath?: string; files?: string[]; fileHashes?: Record<string, string>; createdDirs?: string[] };
    try {
      journal = await readJSONFileWithoutBOM<{ workspacePath?: string; files?: string[]; fileHashes?: Record<string, string>; createdDirs?: string[] }>(journalPath);
    } catch (err) {
      errors.push(`workspace-template: journal illisible ${journalPath}: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath, dryRun: simulate };
    }

    const files = journal.files || [];
    const createdDirs = journal.createdDirs || [];
    const fileHashes = journal.fileHashes || {};

    // #3111 — Fail-closed : le journal ne décrit QUE des cibles créées DANS le
    // workspace. Un journal corrompu ou édité (entrée hors workspace, workspace
    // déclaré différent) annule TOUT le rollback — jamais de suppression sur la
    // foi d'une liste non vérifiée.
    const journalCoherent =
      (journal.workspacePath === undefined || this.isSamePath(journal.workspacePath, workspacePath)) &&
      files.every(f => typeof f === 'string' && this.isPathWithin(f, workspacePath)) &&
      createdDirs.every(d => typeof d === 'string' && this.isPathWithin(d, workspacePath)) &&
      Object.keys(fileHashes).every(k => this.isPathWithin(k, workspacePath));
    if (!journalCoherent) {
      errors.push(`workspace-template: journal refusé (entrée hors workspace ou workspace déclaré différent): ${journalPath}`);
      return { success: false, filesRemoved: 0, filesSkippedModified: 0, dirsRemoved: 0, journalPath, dryRun: simulate };
    }

    if (simulate) {
      let intact = 0;
      let modified = 0;
      for (const f of files) {
        if (!existsSync(f)) continue;
        if (await this.isTemplateFileUnchanged(f, fileHashes[f])) intact++;
        else modified++;
      }
      return { success: true, filesRemoved: intact, filesSkippedModified: modified, dirsRemoved: 0, journalPath, dryRun: true };
    }

    // 1. Supprimer UNIQUEMENT les fichiers listés ET encore intacts. Un fichier
    //    modifié depuis l'apply n'est PAS une sortie de ce service : il est
    //    épargné, signalé, et reste au journal (pas de suppression sans preuve).
    let filesRemoved = 0;
    const skippedModified: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      if (!(await this.isTemplateFileUnchanged(f, fileHashes[f]))) {
        skippedModified.push(f);
        continue;
      }
      try {
        await fs.unlink(f);
        filesRemoved++;
      } catch (err) {
        errors.push(`workspace-template: suppression impossible ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Élaguer les répertoires créés, du plus profond au moins profond.
    let dirsRemoved = 0;
    const sortedDirs = [...createdDirs].sort((a, b) => b.length - a.length);
    for (const d of sortedDirs) {
      if (!existsSync(d)) continue;
      try {
        await fs.rmdir(d);
        dirsRemoved++;
      } catch (err: any) {
        if (err && (err.code === 'ENOTEMPTY' || err.code === 'ENOENT' || err.code === 'EEXIST')) {
          continue; // non vide ou déjà absent : attendu, on continue
        }
        errors.push(`workspace-template: rmdir impossible ${d}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Journal : retiré quand tout est soldé ; sinon réécrit avec les seuls
    //    fichiers épargnés (modifiés) pour qu'un rollback ultérieur les retrouve.
    if (skippedModified.length === 0) {
      try {
        await fs.unlink(journalPath);
      } catch (err) {
        errors.push(`workspace-template: suppression du journal impossible ${journalPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      try {
        const keptHashes: Record<string, string> = {};
        for (const f of skippedModified) {
          if (fileHashes[f]) keptHashes[f] = fileHashes[f];
        }
        await this.writeWorkspaceTemplateJournal(journalPath, workspacePath, skippedModified, createdDirs, keptHashes);
      } catch (err) {
        errors.push(`workspace-template: réécriture du journal impossible ${journalPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { success: errors.length === 0, filesRemoved, filesSkippedModified: skippedModified.length, dirsRemoved, journalPath, dryRun: false };
  }
}
