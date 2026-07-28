/**
 * Outil MCP : roosync_baseline
 *
 * Gestion des baselines RooSync (update, version, restore, export).
 *
 * @module tools/roosync/baseline
 * @version 2.3.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { InventoryCollector } from '../../services/InventoryCollector.js';
import { DiffDetector } from '../../services/DiffDetector.js';
import { execSync } from 'child_process';

/** Timeout for git operations in baseline management */
const GIT_TIMEOUT_MS = 60_000;
const GIT_QUICK_TIMEOUT_MS = 10_000; // For rev-parse, tag -l

/**
 * Workspace root for git operations. The MCP server process runs with cwd set
 * to its own submodule dir (mcps/internal/servers/roo-state-manager), so bare
 * `execSync('git ...')` resolves against the submodule (which has no baseline-v*
 * tags) instead of the parent workspace repo where baselines actually live.
 * WORKSPACE_PATH is injected by the host (Claude Code / VS Code `${workspaceFolder}`) —
 * verified empirically: dashboard workspace basename is "roo-extensions" while
 * process.cwd() basename is "roo-state-manager". Falls back to process.cwd() if
 * WORKSPACE_PATH is unset (no regression vs current behavior). Refs #2962.
 */
const WORKSPACE_ROOT = process.env.WORKSPACE_PATH || process.cwd();
import type { BaselineConfig } from '../../types/baseline.js';
import { BaselineServiceError, BaselineServiceErrorCode, StateManagerError } from '../../types/errors.js';
import { readJSONFileSyncWithoutBOM } from '../../utils/encoding-helpers.js';

let loggerInstance: Logger | null = null;

/**
 * Get or create the logger instance lazily.
 * This defers logger initialization until first use, preventing startup failures.
 */
function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger('BaselineTool');
  }
  return loggerInstance;
}

/**
 * Schema de validation pour roosync_baseline
 */
export const BaselineArgsSchema = z.object({
  action: z.enum(['update', 'version', 'restore', 'export', 'list_versions', 'current_version'])
    .describe('Action à effectuer sur la baseline'),

  // Paramètres pour action: update
  machineId: z.string().optional()
    .describe('[update] ID de la machine ou nom du profil (requis pour update)'),
  mode: z.enum(['standard', 'profile']).optional()
    .describe('[update] Mode de mise à jour: standard (machine) ou profile (agrégation)'),
  aggregationConfig: z.object({
    sources: z.array(z.any()).optional(),
    categoryRules: z.record(z.any()).optional(),
    thresholds: z.record(z.any()).optional()
  }).optional()
    .describe('[update] Configuration d\'agrégation (uniquement pour mode=profile)'),

  // Paramètres communs pour update, version, restore
  version: z.string().optional()
    .describe('[update/version] Version de la baseline (format: X.Y.Z pour version, auto-généré pour update)'),
  createBackup: z.boolean().optional()
    .describe('[update/restore] Créer une sauvegarde de l\'état actuel (défaut: true)'),
  updateReason: z.string().optional()
    .describe('[update/restore] Raison de la modification (pour documentation)'),
  updatedBy: z.string().optional()
    .describe('[update] Auteur de la mise à jour (défaut: machine actuelle)'),

  // Paramètres pour action: version
  message: z.string().optional()
    .describe('[version] Message du tag Git (défaut: auto-généré)'),
  pushTags: z.boolean().optional()
    .describe('[version] Pousser les tags vers le dépôt distant (défaut: true)'),
  createChangelog: z.boolean().optional()
    .describe('[version] Mettre à jour le CHANGELOG-baseline.md (défaut: true)'),

  // Paramètres pour action: restore
  source: z.string().optional()
    .describe('[restore] Source de la restauration (chemin de sauvegarde sync-config.ref.backup.*, requis pour restore)'),
  targetVersion: z.string().optional()
    .describe('[restore] Version cible pour la restauration (optionnel)'),
  restoredBy: z.string().optional()
    .describe('[restore] Auteur de la restauration (défaut: machine actuelle)'),

  // Paramètres pour action: export
  format: z.enum(['json', 'yaml', 'csv']).optional()
    .describe('[export] Format d\'exportation (requis pour export)'),
  outputPath: z.string().optional()
    .describe('[export] Chemin de sortie pour le fichier exporté (optionnel, auto-généré)'),
  includeHistory: z.boolean().optional()
    .describe('[export] Inclure l\'historique des modifications (défaut: false)'),
  includeMetadata: z.boolean().optional()
    .describe('[export] Inclure les métadonnées complètes (défaut: true)'),
  prettyPrint: z.boolean().optional()
    .describe('[export] Formater la sortie pour une meilleure lisibilité (défaut: true)')
});

export type BaselineArgs = z.infer<typeof BaselineArgsSchema>;

/**
 * Schema de retour pour roosync_baseline
 */
export const BaselineResultSchema = z.object({
  action: z.string().describe('Action effectuée'),
  success: z.boolean().describe('Succès de l\'opération'),
  version: z.string().describe('Version de la baseline'),
  message: z.string().describe('Message de résultat détaillé'),
  timestamp: z.string().describe('Timestamp de l\'opération'),
  machineId: z.string().describe('ID de la machine'),

  // Champs spécifiques selon l'action
  previousBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string().optional()
  }).optional().describe('[update] Ancienne baseline'),
  newBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string()
  }).optional().describe('[update] Nouvelle baseline'),
  backupCreated: z.boolean().optional().describe('[update/restore] Si une sauvegarde a été créée'),
  backupPath: z.string().optional().describe('[update/restore] Chemin de la sauvegarde si créée'),
  tag: z.string().optional().describe('[version] Nom du tag Git créé'),

  // Champs spécifiques pour export
  format: z.string().optional().describe('[export] Format d\'export'),
  outputPath: z.string().optional().describe('[export] Chemin du fichier exporté'),
  size: z.number().optional().describe('[export] Taille du fichier en octets'),
  includeHistory: z.boolean().optional().describe('[export] Inclusion de l\'historique'),
  includeMetadata: z.boolean().optional().describe('[export] Inclusion des métadonnées'),

  // Champs spécifiques pour list_versions
  data: z.any().optional().describe('[list_versions] Données de réponse structurées')
});

export type BaselineResult = z.infer<typeof BaselineResultSchema>;

/**
 * Outil roosync_baseline consolidé
 *
 * Remplace les 3 outils :
 * - roosync_update_baseline → action: 'update'
 * - roosync_manage_baseline (version/restore) → action: 'version' | 'restore'
 * - roosync_export_baseline → action: 'export'
 *
 * @param args Arguments validés avec action spécifique
 * @returns Résultat de l'opération
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosync_baseline(args: BaselineArgs): Promise<BaselineResult> {
  try {
    const timestamp = new Date().toISOString();

    getLogger().info('🔧 Baseline operation started', {
      action: args.action,
      machineId: args.machineId,
      version: args.version
    });

    // Router vers le handler approprié
    switch (args.action) {
      case 'update':
        return await handleUpdateAction(args, timestamp);
      case 'version':
        return await handleVersionAction(args, timestamp);
      case 'restore':
        return await handleRestoreAction(args, timestamp);
      case 'export':
        return await handleExportAction(args, timestamp);
      case 'list_versions':
        return await handleListVersionsAction(args, timestamp);
      case 'current_version':
        return await handleCurrentVersionAction(args, timestamp);
      default:
        throw new RooSyncServiceError(
          `Action non supportée: ${args.action}`,
          'INVALID_ACTION'
        );
    }
  } catch (error) {
    getLogger().error('❌ Baseline operation failed', {
      action: args.action,
      error: (error as Error).message
    });

    if (error instanceof RooSyncServiceError || error instanceof StateManagerError) {
      throw error;
    }

    throw new RooSyncServiceError(
      `Erreur lors de l'opération baseline: ${(error as Error).message}`,
      'BASELINE_OPERATION_ERROR'
    );
  }
}

/**
 * Handler pour action: update
 * Remplace roosync_update_baseline
 */
async function handleUpdateAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  if (!args.machineId) {
    throw new RooSyncServiceError(
      'machineId est requis pour l\'action update',
      'MISSING_MACHINE_ID'
    );
  }

  getLogger().info('🔄 Starting baseline update', {
    machineId: args.machineId,
    mode: args.mode || 'standard',
    version: args.version
  });

  const service = await getRooSyncService();
  const config = service.getConfig();

  // Initialiser les services
  const configService = new ConfigService(config.sharedPath);
  const inventoryCollector = new InventoryCollector();
  const diffDetector = new DiffDetector();
  const baselineService = new BaselineService(configService, inventoryCollector as any, diffDetector);

  // Charger l'ancienne baseline
  const oldBaseline = await baselineService.loadBaseline(args.machineId);
  let previousBaseline = null;
  let backupPath = undefined;

  if (oldBaseline) {
    previousBaseline = {
      machineId: oldBaseline.machineId,
      version: oldBaseline.version,
      lastUpdated: oldBaseline.lastUpdated || ''
    };

    // Créer une sauvegarde si demandé
    if (args.createBackup !== false) {
      // #571: Utiliser le fichier baseline de la machine spécifique, pas sync-config.ref.json
      const machineBaselinePath = join(config.sharedPath, 'baselines', `${args.machineId}.json`);
      const legacyBaselinePath = join(config.sharedPath, 'sync-config.ref.json');

      // Préférer le fichier machine, fallback vers legacy
      const baselinePath = existsSync(machineBaselinePath) ? machineBaselinePath :
                           existsSync(legacyBaselinePath) ? legacyBaselinePath : null;

      if (baselinePath) {
        const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = join(config.sharedPath, '.rollback', `baseline.${args.machineId}.backup.${backupTimestamp}.json`);

        try {
          // S'assurer que le répertoire .rollback existe
          const rollbackDir = join(config.sharedPath, '.rollback');
          if (!existsSync(rollbackDir)) {
            mkdirSync(rollbackDir, { recursive: true });
          }
          copyFileSync(baselinePath, backupPath);
          getLogger().info('✅ Baseline backup created', { backupPath, sourcePath: baselinePath });
        } catch (backupError) {
          getLogger().warn('⚠️ Could not create backup', { error: backupError });
        }
      } else {
        getLogger().info('ℹ️ No existing baseline to backup, skipping backup', { machineId: args.machineId });
      }
    }
  }

  let newBaseline: any;
  const version = args.version || generateBaselineVersion();

  // Créer la nouvelle baseline selon le mode
  if (args.mode === 'profile') {
    getLogger().info('📊 Creating non-nominative baseline', { name: args.machineId });

    const nonNominativeBaseline = await service.createNonNominativeBaseline(
      args.machineId,
      args.updateReason || 'Baseline créée par agrégation',
      args.aggregationConfig
    );

    // #570: Profile mode also needs v2.x format with machines array
    const profileTimestamp = new Date().toISOString();
    newBaseline = {
      version: nonNominativeBaseline.version,
      baselineId: nonNominativeBaseline.baselineId,
      timestamp: profileTimestamp,
      lastUpdated: profileTimestamp,
      machineId: `profile:${nonNominativeBaseline.baselineId}`,
      autoSync: true,
      conflictStrategy: 'merge',
      logLevel: 'info',
      sharedStatePath: '',
      isNonNominative: true,
      profiles: nonNominativeBaseline.profiles,
      machines: [{
        id: `profile:${nonNominativeBaseline.baselineId}`,
        name: `Profile: ${nonNominativeBaseline.baselineId}`,
        hostname: 'profile',
        os: 'Profile',
        architecture: 'N/A',
        lastSeen: profileTimestamp,
        roo: { modes: [], mcpServers: [], sdddSpecs: [], rules: [] },
        hardware: {
          cpu: { model: 'Profile', cores: 0, threads: 0 },
          memory: { total: 0 },
          disks: [],
          gpu: 'N/A'
        },
        software: { powershell: 'N/A', node: 'N/A', python: 'N/A' }
      }]
    };
  } else {
    // Mode standard (machine)
    getLogger().info('📊 Collecting inventory for target machine', { machineId: args.machineId });
    const inventory = await inventoryCollector.collectInventory(args.machineId, true);

    if (!inventory) {
      throw new RooSyncServiceError(
        `Impossible de collecter l'inventaire pour la machine ${args.machineId}`,
        'INVENTORY_COLLECTION_FAILED'
      );
    }

    newBaseline = createBaselineFromInventory(args.machineId, inventory, version);
  }

  // Mettre à jour la baseline via le service
  const updateSuccess = await baselineService.updateBaseline(newBaseline, {
    createBackup: false, // Déjà géré manuellement
    updateReason: args.updateReason || `Baseline mise à jour (${args.mode || 'standard'})`,
    updatedBy: args.updatedBy || config.machineId
  });

  if (!updateSuccess) {
    throw new RooSyncServiceError(
      'Échec de la mise à jour de la baseline',
      'BASELINE_UPDATE_FAILED'
    );
  }

  // Mettre à jour le dashboard
  updateDashboard(config, args.machineId, version, previousBaseline);

  // Ajouter une entrée dans le roadmap
  updateRoadmap(config, args.machineId, version, previousBaseline, args.updateReason, args.updatedBy, backupPath);

  // Message de résultat
  let message = `Baseline mise à jour avec succès vers la machine '${args.machineId}' (v${version})`;
  if (previousBaseline) {
    message += `\nAncienne baseline : ${previousBaseline.machineId} (v${previousBaseline.version})`;
  }
  if (backupPath) {
    message += `\nSauvegarde créée : ${backupPath}`;
  }
  if (args.updateReason) {
    message += `\nRaison : ${args.updateReason}`;
  }

  getLogger().info('✅ Baseline update completed successfully', {
    newMachineId: args.machineId,
    newVersion: version,
    previousMachineId: previousBaseline?.machineId
  });

  return {
    action: 'update',
    success: true,
    version: newBaseline.version,
    message,
    timestamp,
    machineId: config.machineId,
    previousBaseline: previousBaseline || undefined,
    newBaseline: {
      machineId: newBaseline.machineId,
      version: newBaseline.version,
      lastUpdated: newBaseline.lastUpdated
    },
    backupCreated: !!backupPath,
    backupPath
  };
}

/**
 * Handler pour action: version
 * Remplace roosync_manage_baseline (action: version)
 */
async function handleVersionAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  if (!args.version) {
    throw new RooSyncServiceError(
      'version est requise pour l\'action version (format attendu: X.Y.Z, ex: 2.3.15)',
      'MISSING_VERSION'
    );
  }

  if (!validateSemanticVersion(args.version)) {
    throw new RooSyncServiceError(
      `Format de version invalide: ${args.version}. Attendu: X.Y.Z`,
      'INVALID_VERSION_FORMAT'
    );
  }

  getLogger().info('🏷️ Starting baseline versioning', {
    version: args.version,
    pushTags: args.pushTags,
    createChangelog: args.createChangelog
  });

  const service = await getRooSyncService();
  const config = service.getConfig();
  const sharedPath = getSharedStatePath();
  const configService = new ConfigService(sharedPath);
  const baselineService = new BaselineService(configService, {} as any, {} as any);

  // Charger la baseline actuelle
  const currentBaseline = await baselineService.loadBaseline(config.machineId);
  if (!currentBaseline) {
    throw new RooSyncServiceError(
      'Aucune baseline trouvée. Créez une baseline avant de la versionner.',
      'NO_BASELINE_FOUND'
    );
  }

  // Préparer le tag Git
  const tagName = `baseline-v${args.version}`;
  const tagMessage = args.message || `Baseline version ${args.version} - Machine: ${currentBaseline.machineId}`;

  getLogger().info('Creating Git tag', { tagName, message: tagMessage });

  // Vérifier si le tag existe déjà
  let tagExists = false;
  try {
    execSync(`git rev-parse --verify refs/tags/${tagName}`, { stdio: 'pipe', cwd: WORKSPACE_ROOT, timeout: GIT_QUICK_TIMEOUT_MS });
    tagExists = true;
  } catch (error) {
    // Le tag n'existe pas, c'est normal
  }

  if (tagExists) {
    throw new RooSyncServiceError(
      `Le tag ${tagName} existe déjà. Utilisez une autre version.`,
      'TAG_ALREADY_EXISTS'
    );
  }

  // The baseline JSON (sync-config.ref.json) lives in GDrive (sharedState), NOT in
  // git — the repo's absolute rule n°1: "RooSync = GDrive ONLY (never git)". An
  // earlier version attempted `git add` + `git commit` here, but the commit was a
  // no-op (baselinePath is outside any repo) whose harmlessness relied entirely on
  // `git add` failing first; under a different ROOSYNC_SHARED_PATH it would have
  // committed the MCP process's entire cwd with no pathspec. Removed per #2967.
  // The git tag below marks the repo state at baseline-cut time; the baseline
  // content itself is tracked on GDrive, not version-controlled here.

  // Créer le tag Git — cwd = WORKSPACE_ROOT (parent repo) so the tag lands where
  // list_versions reads it (#2962 read/write coherence). Without cwd the tag was
  // created in the submodule, diverging from the read path fixed above.
  try {
    execSync(`git tag -a ${tagName} -m "${tagMessage}"`, { stdio: 'pipe', cwd: WORKSPACE_ROOT, timeout: GIT_TIMEOUT_MS });
    getLogger().info('✅ Git tag created successfully', { tagName });
  } catch (error) {
    throw new RooSyncServiceError(
      `Erreur lors de la création du tag Git: ${(error as Error).message}`,
      'GIT_TAG_CREATE_FAILED'
    );
  }

  // Pousser le tag si demandé — same cwd = WORKSPACE_ROOT so push targets the
  // parent repo remote (where baseline-v* tags are tracked).
  let tagPushed = false;
  if (args.pushTags !== false) {
    try {
      execSync('git push --tags', { stdio: 'pipe', cwd: WORKSPACE_ROOT, timeout: GIT_TIMEOUT_MS });
      tagPushed = true;
      getLogger().info('✅ Git tag pushed successfully');
    } catch (error) {
      getLogger().warn('⚠️ Could not push Git tag', { error: (error as Error).message });
    }
  }

  // Mettre à jour le CHANGELOG si demandé
  let changelogUpdated = false;
  if (args.createChangelog !== false) {
    try {
      const changelogPath = join(sharedPath, 'CHANGELOG-baseline.md');
      let changelogContent = '';

      if (existsSync(changelogPath)) {
        changelogContent = readFileSync(changelogPath, 'utf-8');
      } else {
        changelogContent = `# CHANGELOG Baseline RooSync\n\nToutes les modifications notables de la baseline.\n\n`;
      }

      const versionEntry = `
## [${args.version}] - ${new Date().toISOString().split('T')[0]}

### Machine Baseline
- **Machine**: ${currentBaseline.machineId}
- **Version**: ${args.version}
- **Dernière mise à jour**: ${currentBaseline.lastUpdated || 'Inconnue'}

### Modifications
- ${tagMessage}

### Tag Git
- \`${tagName}\`

---

`;

      const headerEndIndex = changelogContent.indexOf('\n\n');
      if (headerEndIndex !== -1) {
        changelogContent = changelogContent.substring(0, headerEndIndex + 2) +
                        versionEntry +
                        changelogContent.substring(headerEndIndex + 2);
      } else {
        changelogContent += versionEntry;
      }

      writeFileSync(changelogPath, changelogContent, 'utf-8');
      changelogUpdated = true;
      getLogger().info('✅ CHANGELOG updated successfully');
    } catch (error) {
      getLogger().warn('⚠️ Could not update CHANGELOG', { error: (error as Error).message });
    }
  }

  // Mettre à jour la version dans la baseline
  try {
    const updatedBaseline: BaselineConfig = {
      ...currentBaseline,
      version: args.version,
      lastUpdated: new Date().toISOString()
    };

    await baselineService.updateBaseline(updatedBaseline, {
      createBackup: true,
      updateReason: `Versioning baseline v${args.version}`,
      updatedBy: 'roosync_baseline'
    });

    getLogger().info('✅ Baseline version updated', { version: args.version });
  } catch (error) {
    getLogger().warn('⚠️ Could not update baseline version', { error: (error as Error).message });
  }

  // Message de résultat
  let message = `Baseline versionnée avec succès en v${args.version}`;
  message += `\nMachine baseline: ${currentBaseline.machineId}`;
  message += `\nTag Git: ${tagName}`;
  if (tagPushed) {
    message += `\nTag poussé vers le dépôt distant`;
  }
  if (changelogUpdated) {
    message += `\nCHANGELOG mis à jour`;
  }

  getLogger().info('✅ Baseline versioning completed successfully', {
    version: args.version,
    tagName,
    baselineMachine: currentBaseline.machineId
  });

  return {
    action: 'version',
    success: true,
    version: args.version,
    tag: tagName,
    message,
    timestamp,
    machineId: config.machineId
  };
}

/**
 * Handler pour action: restore
 * Remplace roosync_manage_baseline (action: restore)
 */
async function handleRestoreAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  if (!args.source) {
    throw new RooSyncServiceError(
      'source est requise pour l\'action restore',
      'MISSING_SOURCE'
    );
  }

  getLogger().info('🔄 Starting baseline restore', {
    source: args.source,
    createBackup: args.createBackup
  });

  const service = await getRooSyncService();
  const config = service.getConfig();
  const sharedPath = getSharedStatePath();
  const configService = new ConfigService(sharedPath);
  const baselineService = new BaselineService(configService, {} as any, {} as any);

  // Récupérer la baseline actuelle pour sauvegarde
  let currentBaseline: BaselineConfig | null = null;
  try {
    currentBaseline = await baselineService.loadBaseline(config.machineId);
  } catch (error) {
    getLogger().warn('Impossible de charger la baseline actuelle', { error: (error as Error).message });
  }

  // Créer une sauvegarde si demandé
  let backupCreated = false;
  let backupPath: string | undefined;
  if (args.createBackup !== false && currentBaseline) {
    try {
      const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = join(sharedPath, '.rollback', `sync-config.ref.backup.${backupTimestamp}.json`);

      const backupDir = join(sharedPath, '.rollback');
      if (!existsSync(backupDir)) {
        // #2962 follow-up (ai-01 deep-file item 2): `execSync('mkdir -p ...')` goes through
        // cmd.exe on Windows, where `-p` is not a flag → the mkdir fails, caught by the
        // surrounding catch (warn-only) → backup dir silently not created before the
        // writeFileSync below. Use the cross-platform node API instead (mkdirSync recursive
        // == `mkdir -p` semantics). backupDir is absolute (sharedPath-derived), so no cwd.
        mkdirSync(backupDir, { recursive: true });
      }

      writeFileSync(backupPath, JSON.stringify(currentBaseline, null, 2), 'utf-8');
      backupCreated = true;
      getLogger().info('✅ Sauvegarde créée', { backupPath });
    } catch (error) {
      getLogger().warn('⚠️ Impossible de créer la sauvegarde', { error: (error as Error).message });
    }
  }

  // Restaurer selon le type de source
  let sourceType: 'backup';
  let restoredBaseline: BaselineConfig;

  if (args.source.startsWith('baseline-v')) {
    // Restore-from-tag was removed (#2983): baseline content lives on GDrive
    // (sharedState), NOT in git tags. The version action creates a tag that only
    // marks the repo STATE at baseline-cut time — it never commits the baseline JSON
    // (rule n°1 "RooSync = GDrive ONLY", reaffirmed by #909). The repo's checked-in
    // roo-config/sync-config.ref.json is a generic SyncConfig TEMPLATE (placeholder
    // "local-machine", 2025-12-04), not a BaselineConfig: it has no top-level
    // `machineId`, so even with the read path fixed to roo-config/ it failed the
    // validation one line later. Per #571 (machine-specific baselines on GDrive),
    // tag restore is architecturally impossible. Point users at backup files.
    // Prior-question (ai-01 #2983) answered firsthand: the roo-config file is an
    // inherited template, not the tool's baseline → option (b), not (a).
    throw new RooSyncServiceError(
      `Restore-from-tag n'est pas supporté : le contenu baseline vit sur GDrive (sharedState), pas dans les tags Git. Le tag "${args.source}" ne marque que l'état du repo au moment de la coupe. Utilisez un chemin de sauvegarde (sync-config.ref.backup.* sous .rollback/) ou repartez de la baseline courante (action update).`,
      'TAG_RESTORE_UNSUPPORTED'
    );
  } else if (args.source.includes('sync-config.ref.backup.')) {
    // Restauration depuis un fichier de sauvegarde
    sourceType = 'backup';
    try {
      getLogger().info('Restauration depuis la sauvegarde', { backupPath: args.source });

      if (!existsSync(args.source)) {
        throw new BaselineServiceError(`Fichier de sauvegarde non trouvé: ${args.source}`, BaselineServiceErrorCode.BASELINE_NOT_FOUND);
      }

      const backupContent = readFileSync(args.source, 'utf-8');
      restoredBaseline = JSON.parse(backupContent) as BaselineConfig;

      if (!restoredBaseline.machineId || !restoredBaseline.version) {
        throw new BaselineServiceError('Baseline invalide: champs requis manquants', BaselineServiceErrorCode.BASELINE_INVALID);
      }

      getLogger().info('Baseline récupérée depuis la sauvegarde', {
        machineId: restoredBaseline.machineId,
        version: restoredBaseline.version
      });
    } catch (error) {
      throw new RooSyncServiceError(
        `Erreur lors de la restauration depuis la sauvegarde: ${(error as Error).message}`,
        'RESTORE_FROM_BACKUP_ERROR'
      );
    }
  } else {
    throw new RooSyncServiceError(
      `Source de restauration non reconnue: ${args.source}. Utilisez un chemin de sauvegarde (sync-config.ref.backup.* sous .rollback/).`,
      'INVALID_SOURCE'
    );
  }

  // Appliquer la baseline restaurée
  try {
    await baselineService.updateBaseline(restoredBaseline, {
      createBackup: false,
      updateReason: args.updateReason || `Restauration depuis ${sourceType}: ${args.source}`,
      updatedBy: args.restoredBy || 'roosync_baseline'
    });

    getLogger().info('✅ Baseline restaurée avec succès', {
      machineId: restoredBaseline.machineId,
      version: restoredBaseline.version
    });
  } catch (error) {
    throw new RooSyncServiceError(
      `Erreur lors de l'application de la baseline restaurée: ${(error as Error).message}`,
      'APPLY_RESTORED_BASELINE_ERROR'
    );
  }

  // Message de résultat
  let message = `Baseline restaurée avec succès depuis ${args.source}`;
  message += `\nMachine: ${restoredBaseline.machineId}`;
  message += `\nVersion: ${restoredBaseline.version}`;
  message += `\nSource: ${sourceType}`;
  if (backupCreated && backupPath) {
    message += `\nSauvegarde créée: ${backupPath}`;
  }

  getLogger().info('✅ Baseline restore completed successfully', {
    sourceType,
    source: args.source,
    restoredMachineId: restoredBaseline.machineId,
    restoredVersion: restoredBaseline.version,
    backupCreated
  });

  return {
    action: 'restore',
    success: true,
    version: restoredBaseline.version,
    message,
    timestamp,
    machineId: config.machineId,
    backupCreated,
    backupPath
  };
}

/**
 * Handler pour action: list_versions
 * Découvre les versions de baseline disponibles (tags Git baseline-v*)
 *
 * #2963 (rule #1): On distingue explicitement :
 *   - "git a répondu, 0 tags trouvés" (success: true, totalVersions: 0)
 *   - "git n'a pas répondu / pas de repo / cwd invalide" (success: false, error motivé)
 * Précédemment les deux cas étaient rendus `success: true` avec versions: [],
 * ce qui masquait les erreurs de cwd (#2962) derrière un "aucune version trouvée"
 * plausible — agent consommateur n'avait aucun moyen de douter.
 */
async function handleListVersionsAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  interface VersionInfo {
    tag: string;
    date: string;
    message: string;
  }

  let allTags: string;
  try {
    allTags = execSync('git tag -l "baseline-v*"', {
      encoding: 'utf8',
      cwd: WORKSPACE_ROOT,
      timeout: GIT_QUICK_TIMEOUT_MS,
    });
  } catch (error) {
    // git a échoué (pas un repo, binaire absent, cwd invalide, etc.).
    // Rendu comme "non mesurable" — pas comme un zéro mesuré.
    const errMsg = (error as Error).message?.split('\n')[0] || (error as Error).message;
    return {
      success: false,
      action: 'list_versions',
      timestamp,
      version: '',
      machineId: '',
      message: `Impossible de lister les tags baseline-v*: ${errMsg}. Aucun tag n'a pu être lu — le résultat "0 versions" ne reflète pas une absence réelle. (cwd actuel: ${process.cwd()})`,
      data: {
        versions: [],
        totalVersions: 0,
        measurementError: errMsg,
        measured: false,
      }
    };
  }

  const tags = allTags.split('\n').filter(t => t.trim());

  if (tags.length === 0) {
    // git a répondu mais aucun tag baseline-v* n'existe — c'est un vrai zéro mesuré.
    return {
      success: true,
      action: 'list_versions',
      timestamp,
      version: '',
      machineId: '',
      message: 'Aucune version de baseline trouvée (pas de tags baseline-v*)',
      data: {
        versions: [],
        totalVersions: 0,
        measured: true,
      }
    };
  }

  const versions: VersionInfo[] = [];
  for (const tag of tags) {
    let date = '';
    let message = '';
    try {
      date = execSync(`git log -1 --format=%ai ${tag}`, {
        encoding: 'utf8',
        cwd: WORKSPACE_ROOT,
        timeout: GIT_QUICK_TIMEOUT_MS,
      }).trim();
    } catch { /* skip */ }
    try {
      message = execSync(`git log -1 --format=%s ${tag}`, {
        encoding: 'utf8',
        cwd: WORKSPACE_ROOT,
        timeout: GIT_QUICK_TIMEOUT_MS,
      }).trim();
    } catch { /* skip */ }
    versions.push({ tag, date, message });
  }

  // Sort by date descending (newest first)
  versions.sort((a, b) => b.date.localeCompare(a.date));

  return {
    success: true,
    action: 'list_versions',
    timestamp,
    version: versions[0]?.tag || '',
    machineId: '',
    message: `${versions.length} versions de baseline trouvées`,
    data: {
      versions,
      totalVersions: versions.length,
      latest: versions[0]?.tag || null,
      measured: true,
    }
  };
}

/**
 * Handler pour action: current_version
 * Reads the current baseline version from the file without creating tags
 * #1410: Version discovery — allows agents to check baseline status
 */
async function handleCurrentVersionAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  const service = await getRooSyncService();
  const config = service.getConfig();
  const machineId = args.machineId || config.machineId;

  const configService = new ConfigService(config.sharedPath);
  const baselineService = new BaselineService(configService, null as any, null as any);

  try {
    const baseline = await baselineService.loadBaseline(machineId);

    if (!baseline) {
      return {
        success: true,
        action: 'current_version',
        timestamp,
        version: '',
        machineId,
        message: `Aucune baseline trouvée pour ${machineId}`,
        data: {
          exists: false,
          machineId
        }
      };
    }

    return {
      success: true,
      action: 'current_version',
      timestamp,
      version: baseline.version || '',
      machineId: baseline.machineId,
      message: `Baseline actuelle: ${baseline.version || 'non-versionnée'} (${machineId})`,
      data: {
        exists: true,
        machineId: baseline.machineId,
        version: baseline.version || '',
        lastUpdated: baseline.lastUpdated || '',
        baselineId: (baseline as any).baselineId || ''
      }
    };
  } catch (error) {
    // #2967 Défaut B: surface the underlying failure mode so the operator can
    // distinguish "GDrive non monté" (sharedPath inaccessible) from "JSON invalide"
    // (parse failure on a corrupt/0-byte file) from a generic load error — the bare
    // `(error as Error).message` alone left these indistinguishable.
    const err = error as Error & { code?: string; details?: { baselinePath?: string } };
    const sharedPathAccessible = existsSync(config.sharedPath);
    const baselinePath = err.details?.baselinePath;
    let hint: string;
    if (!sharedPathAccessible) {
      hint = `GDrive/sharedPath inaccessible`;
    } else if (err.code === 'BASELINE_PARSE_FAILED') {
      hint = `JSON invalide — fichier baseline corrompu`;
    } else if (err.code === 'BASELINE_LOAD_FAILED') {
      hint = `Échec chargement baseline`;
    } else {
      hint = err.code || err.name || 'erreur inconnue';
    }
    return {
      success: false,
      action: 'current_version',
      timestamp,
      version: '',
      machineId,
      message: `Erreur lors de la lecture de la baseline: ${err.message}`,
      data: {
        exists: false,
        machineId,
        errorCode: err.code || null,
        baselinePath: baselinePath || null,
        sharedPath: config.sharedPath,
        sharedPathAccessible,
        hint
      }
    };
  }
}

/**
 * Handler pour action: export
 * Remplace roosync_export_baseline
 */
async function handleExportAction(args: BaselineArgs, timestamp: string): Promise<BaselineResult> {
  if (!args.format) {
    throw new RooSyncServiceError(
      'format est requis pour l\'action export',
      'MISSING_FORMAT'
    );
  }

  getLogger().info('📤 Starting baseline export', {
    format: args.format,
    machineId: args.machineId
  });

  const sharedPath = getSharedStatePath();
  const configService = new ConfigService(sharedPath);
  const inventoryCollector = new InventoryCollector();
  const diffDetector = new DiffDetector();
  const baselineService = new BaselineService(configService, inventoryCollector as any, diffDetector);

  // Récupérer la baseline
  const baseline = await baselineService.loadBaseline(args.machineId);
  if (!baseline) {
    throw new StateManagerError(
      `Baseline non trouvée pour machineId: ${args.machineId || 'actuelle'}`,
      'BASELINE_NOT_FOUND',
      'BaselineTool',
      { machineId: args.machineId || 'actuelle' }
    );
  }

  // Préparer les données d'export
  const exportData: any = {
    exportInfo: {
      timestamp: new Date().toISOString(),
      format: args.format,
      exportedBy: 'roosync_baseline',
      version: '2.3.0'
    }
  };

  if (args.includeMetadata !== false) {
    exportData.metadata = {
      machineId: baseline.machineId,
      version: baseline.version,
      lastUpdated: baseline.lastUpdated
    };
  }

  exportData.configuration = baseline.config || {};

  if (args.includeHistory) {
    exportData.history = [];
  }

  exportData.statistics = {
    totalParameters: countParameters(baseline.config),
    lastModified: baseline.lastUpdated,
    exportTimestamp: new Date().toISOString()
  };

  // Générer le contenu selon le format
  let content: string;
  let extension: string;

  switch (args.format) {
    case 'json':
      content = generateJsonExport(exportData, args.prettyPrint !== false);
      extension = '.json';
      break;
    case 'yaml':
      content = await generateYamlExport(exportData);
      extension = '.yaml';
      break;
    case 'csv':
      content = generateCsvExport(exportData);
      extension = '.csv';
      break;
    default:
      throw new StateManagerError(
        `Format non supporté: ${args.format}`,
        'UNSUPPORTED_FORMAT',
        'BaselineTool',
        { format: args.format }
      );
  }

  // Déterminer le chemin de sortie
  let outputPath = args.outputPath;
  if (!outputPath) {
    const exportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `baseline-export-${baseline.machineId}-${exportTimestamp}${extension}`;
    outputPath = join(process.cwd(), 'exports', filename);
  }

  // Créer le répertoire de sortie si nécessaire
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Écrire le fichier
  writeFileSync(outputPath, content, 'utf-8');

  getLogger().info('✅ Baseline exported successfully', {
    machineId: baseline.machineId,
    format: args.format,
    outputPath,
    size: content.length
  });

  // Message de résultat
  let message = `Baseline exportée avec succès au format ${args.format.toUpperCase()}`;
  message += `\nMachine: ${baseline.machineId}`;
  message += `\nVersion: ${baseline.version}`;
  message += `\nFichier: ${outputPath}`;
  message += `\nTaille: ${content.length} octets`;

  return {
    action: 'export',
    success: true,
    version: baseline.version,
    message,
    timestamp,
    machineId: baseline.machineId,
    format: args.format,
    outputPath,
    size: content.length,
    includeHistory: args.includeHistory || false,
    includeMetadata: args.includeMetadata !== false
  };
}

/**
 * Fonctions utilitaires
 */

function generateBaselineVersion(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${year}.${month}.${day}-${hours}${minutes}`;
}

/**
 * Crée une baseline au format v2.x avec tableau machines
 * #570: Fix format mismatch - BaselineLoader expects v2.x format with machines array
 */
function createBaselineFromInventory(machineId: string, inventory: any, version: string): any {
  const timestamp = new Date().toISOString();

  return {
    version,
    baselineId: `baseline-${version}`,
    timestamp,
    lastUpdated: timestamp,
    machineId,
    autoSync: true,
    conflictStrategy: 'merge',
    logLevel: 'info',
    sharedStatePath: '',  // Will be set by the caller if needed
    machines: [{
      id: machineId,
      name: machineId,
      hostname: inventory.system?.hostname || machineId,
      os: inventory.system?.os || 'Unknown',
      architecture: inventory.system?.architecture || 'Unknown',
      lastSeen: timestamp,
      roo: {
        modes: inventory.roo?.modes || inventory.config?.roo?.modes || [],
        mcpServers: inventory.roo?.mcpServers || inventory.config?.roo?.mcpServers || [],
        sdddSpecs: inventory.roo?.sdddSpecs || [],
        rules: inventory.roo?.rules || []
      },
      hardware: {
        cpu: {
          model: inventory.hardware?.cpu?.model || inventory.config?.hardware?.cpu || 'Unknown',
          cores: inventory.hardware?.cpu?.cores || 0,
          threads: inventory.hardware?.cpu?.threads || 0
        },
        memory: {
          total: inventory.hardware?.memory?.total || 0
        },
        disks: inventory.hardware?.disks || inventory.config?.hardware?.disks || [],
        gpu: inventory.hardware?.gpu || 'Unknown'
      },
      software: {
        powershell: inventory.software?.powershell || inventory.config?.software?.powershell || 'Unknown',
        node: inventory.software?.node || inventory.config?.software?.node || 'N/A',
        python: inventory.software?.python || inventory.config?.software?.python || 'N/A'
      }
    }]
  };
}

function validateSemanticVersion(version: string): boolean {
  const semanticVersionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
  return semanticVersionRegex.test(version);
}

function updateDashboard(config: any, machineId: string, version: string, previousBaseline: any): void {
  const dashboardPath = join(config.sharedPath, 'sync-dashboard.json');
  if (existsSync(dashboardPath)) {
    try {
      // BOM-safe read #664
      const dashboard = readJSONFileSyncWithoutBOM<any>(dashboardPath);

      dashboard.baselineMachine = machineId;
      dashboard.baselineVersion = version;
      dashboard.lastBaselineUpdate = new Date().toISOString();
      dashboard.lastUpdate = new Date().toISOString();

      if (dashboard.machines[machineId]) {
        dashboard.machines[machineId].isBaseline = true;
        dashboard.machines[machineId].lastBaselineUpdate = new Date().toISOString();
      }

      if (previousBaseline && dashboard.machines[previousBaseline.machineId]) {
        dashboard.machines[previousBaseline.machineId].isBaseline = false;
      }

      writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2), 'utf-8');
      getLogger().info('✅ Dashboard updated');
    } catch (error) {
      getLogger().warn('⚠️ Could not update dashboard', { error });
    }
  }
}

function updateRoadmap(config: any, machineId: string, version: string, previousBaseline: any, updateReason?: string, updatedBy?: string, backupPath?: string): void {
  const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
  if (existsSync(roadmapPath)) {
    try {
      let roadmapContent = readFileSync(roadmapPath, 'utf-8');

      const baselineUpdateEntry = `
## 🔄 Mise à Jour Baseline - ${new Date().toISOString()}

**Machine baseline précédente :** ${previousBaseline ? `${previousBaseline.machineId} (v${previousBaseline.version})` : 'Aucune'}
**Nouvelle machine baseline :** ${machineId} (v${version})
**Raison :** ${updateReason || 'Mise à jour manuelle'}
**Effectuée par :** ${updatedBy || config.machineId}
**Sauvegarde créée :** ${backupPath ? 'Oui' : 'Non'}

---

`;

      roadmapContent += baselineUpdateEntry;
      writeFileSync(roadmapPath, roadmapContent, 'utf-8');
      getLogger().info('✅ Roadmap updated');
    } catch (error) {
      getLogger().warn('⚠️ Could not update roadmap', { error });
    }
  }
}

function generateJsonExport(data: any, prettyPrint: boolean): string {
  return prettyPrint ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

async function generateYamlExport(data: any): Promise<string> {
  try {
    const yaml = await import('js-yaml');
    return (yaml as any).dump(data, { indent: 2 });
  } catch (error) {
    return simpleYamlExport(data);
  }
}

function simpleYamlExport(data: any, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  let yaml = '';

  if (Array.isArray(data)) {
    for (const item of data) {
      yaml += `${spaces}- ${simpleYamlExport(item, indent + 1)}\n`;
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${simpleYamlExport(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${simpleYamlExport(value, indent + 1)}`;
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }
  } else {
    yaml += `${data}\n`;
  }

  return yaml;
}

function generateCsvExport(data: any): string {
  const csvLines: string[] = [];
  csvLines.push('Type,Clé,Valeur,Description');

  const flattenData = (obj: any, prefix: string = ''): void => {
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        flattenData(item, `${prefix}[${index}]`);
      });
    } else if (typeof obj === 'object' && obj !== null) {
      Object.entries(obj).forEach(([key, value]) => {
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          flattenData(value, fullKey);
        } else {
          const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
          csvLines.push(`Data,${fullKey},${csvValue},""`);
        }
      });
    }
  };

  if (data.metadata) {
    Object.entries(data.metadata).forEach(([key, value]) => {
      const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
      csvLines.push(`Metadata,${key},${csvValue},""`);
    });
  }

  if (data.configuration) {
    flattenData(data.configuration, 'configuration');
  }

  if (data.statistics) {
    Object.entries(data.statistics).forEach(([key, value]) => {
      const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
      csvLines.push(`Statistics,${key},${csvValue},""`);
    });
  }

  return csvLines.join('\n');
}

function countParameters(config: any): number {
  let count = 0;

  const countRecursive = (obj: any): void => {
    if (Array.isArray(obj)) {
      obj.forEach(countRecursive);
    } else if (typeof obj === 'object' && obj !== null) {
      Object.values(obj).forEach(countRecursive);
    } else {
      count++;
    }
  };

  countRecursive(config);
  return count;
}
