/**
 * Outil MCP : roosync_baseline
 *
 * Outil consolidé regroupant les 3 outils Baseline :
 * - roosync_update_baseline → action: 'update'
 * - roosync_manage_baseline (version) → action: 'version'
 * - roosync_manage_baseline (restore) → action: 'restore'
 * - roosync_export_baseline → action: 'export'
 *
 * @module tools/roosync/baseline
 * @version 2.3.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { InventoryCollector } from '../../services/InventoryCollector.js';
import { DiffDetector } from '../../services/DiffDetector.js';
import { execSync } from 'child_process';
import type { BaselineConfig } from '../../types/baseline.js';
import { BaselineServiceError, BaselineServiceErrorCode, StateManagerError } from '../../types/errors.js';

const logger: Logger = createLogger('BaselineTool');

/**
 * Schema de validation pour roosync_baseline
 */
export const BaselineArgsSchema = z.object({
  action: z.enum(['update', 'version', 'restore', 'export'])
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
    .describe('[restore] Source de la restauration (tag Git ou chemin de sauvegarde, requis pour restore)'),
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
  includeMetadata: z.boolean().optional().describe('[export] Inclusion des métadonnées')
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

    logger.info('🔧 Baseline operation started', {
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
      default:
        throw new RooSyncServiceError(
          `Action non supportée: ${args.action}`,
          'INVALID_ACTION'
        );
    }
  } catch (error) {
    logger.error('❌ Baseline operation failed', {
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

  logger.info('🔄 Starting baseline update', {
    machineId: args.machineId,
    mode: args.mode || 'standard',
    version: args.version
  });

  const service = getRooSyncService();
  const config = service.getConfig();

  // Initialiser les services
  const configService = new ConfigService();
  const inventoryCollector = new InventoryCollector();
  const diffDetector = new DiffDetector();
  const baselineService = new BaselineService(configService, inventoryCollector as any, diffDetector);

  // Charger l'ancienne baseline
  const oldBaseline = await baselineService.loadBaseline();
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
      const baselinePath = join(config.sharedPath, 'sync-config.ref.json');
      const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = join(config.sharedPath, '.rollback', `sync-config.ref.backup.${backupTimestamp}.json`);

      try {
        copyFileSync(baselinePath, backupPath);
        logger.info('✅ Baseline backup created', { backupPath });
      } catch (backupError) {
        logger.warn('⚠️ Could not create backup', { error: backupError });
      }
    }
  }

  let newBaseline: any;
  const version = args.version || generateBaselineVersion();

  // Créer la nouvelle baseline selon le mode
  if (args.mode === 'profile') {
    logger.info('📊 Creating non-nominative baseline', { name: args.machineId });

    const nonNominativeBaseline = await service.createNonNominativeBaseline(
      args.machineId,
      args.updateReason || 'Baseline créée par agrégation',
      args.aggregationConfig
    );

    newBaseline = {
      machineId: `profile:${nonNominativeBaseline.baselineId}`,
      version: nonNominativeBaseline.version,
      lastUpdated: new Date().toISOString(),
      config: {
        roo: { modes: [], mcpSettings: {}, userSettings: {} },
        hardware: { cpu: 'Profile', ram: 'Profile', disks: [] },
        software: { powershell: 'N/A', node: 'N/A', python: 'N/A' },
        system: { os: 'Profile', architecture: 'N/A' }
      },
      isNonNominative: true,
      profiles: nonNominativeBaseline.profiles
    };
  } else {
    // Mode standard (machine)
    logger.info('📊 Collecting inventory for target machine', { machineId: args.machineId });
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

  logger.info('✅ Baseline update completed successfully', {
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
      'version est requise pour l\'action version',
      'MISSING_VERSION'
    );
  }

  if (!validateSemanticVersion(args.version)) {
    throw new RooSyncServiceError(
      `Format de version invalide: ${args.version}. Attendu: X.Y.Z`,
      'INVALID_VERSION_FORMAT'
    );
  }

  logger.info('🏷️ Starting baseline versioning', {
    version: args.version,
    pushTags: args.pushTags,
    createChangelog: args.createChangelog
  });

  const service = getRooSyncService();
  const config = service.getConfig();
  const configService = new ConfigService();
  const sharedPath = configService.getSharedStatePath();
  const baselineService = new BaselineService(configService, {} as any, {} as any);

  // Charger la baseline actuelle
  const currentBaseline = await baselineService.loadBaseline();
  if (!currentBaseline) {
    throw new RooSyncServiceError(
      'Aucune baseline trouvée. Créez une baseline avant de la versionner.',
      'NO_BASELINE_FOUND'
    );
  }

  // Préparer le tag Git
  const tagName = `baseline-v${args.version}`;
  const tagMessage = args.message || `Baseline version ${args.version} - Machine: ${currentBaseline.machineId}`;

  logger.info('Creating Git tag', { tagName, message: tagMessage });

  // Vérifier si le tag existe déjà
  let tagExists = false;
  try {
    execSync(`git rev-parse --verify refs/tags/${tagName}`, { stdio: 'pipe' });
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

  // Committer le fichier de baseline
  try {
    const baselinePath = join(sharedPath, 'sync-config.ref.json');
    execSync(`git add "${baselinePath}"`, { stdio: 'pipe' });
    execSync(`git commit -m "chore: baseline version ${args.version}"`, { stdio: 'pipe' });
    logger.info('✅ Baseline committed successfully');
  } catch (error) {
    logger.warn('⚠️ Could not commit baseline file', { error: (error as Error).message });
  }

  // Créer le tag Git
  try {
    execSync(`git tag -a ${tagName} -m "${tagMessage}"`, { stdio: 'pipe' });
    logger.info('✅ Git tag created successfully', { tagName });
  } catch (error) {
    throw new RooSyncServiceError(
      `Erreur lors de la création du tag Git: ${(error as Error).message}`,
      'GIT_TAG_CREATE_FAILED'
    );
  }

  // Pousser le tag si demandé
  let tagPushed = false;
  if (args.pushTags !== false) {
    try {
      execSync('git push --tags', { stdio: 'pipe' });
      tagPushed = true;
      logger.info('✅ Git tag pushed successfully');
    } catch (error) {
      logger.warn('⚠️ Could not push Git tag', { error: (error as Error).message });
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
      logger.info('✅ CHANGELOG updated successfully');
    } catch (error) {
      logger.warn('⚠️ Could not update CHANGELOG', { error: (error as Error).message });
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

    logger.info('✅ Baseline version updated', { version: args.version });
  } catch (error) {
    logger.warn('⚠️ Could not update baseline version', { error: (error as Error).message });
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

  logger.info('✅ Baseline versioning completed successfully', {
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

  logger.info('🔄 Starting baseline restore', {
    source: args.source,
    createBackup: args.createBackup
  });

  const service = getRooSyncService();
  const config = service.getConfig();
  const configService = new ConfigService();
  const sharedPath = configService.getSharedStatePath();
  const baselineService = new BaselineService(configService, {} as any, {} as any);

  // Récupérer la baseline actuelle pour sauvegarde
  let currentBaseline: BaselineConfig | null = null;
  try {
    currentBaseline = await baselineService.loadBaseline();
  } catch (error) {
    logger.warn('Impossible de charger la baseline actuelle', { error: (error as Error).message });
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
        execSync(`mkdir -p "${backupDir}"`, { stdio: 'pipe' });
      }

      writeFileSync(backupPath, JSON.stringify(currentBaseline, null, 2), 'utf-8');
      backupCreated = true;
      logger.info('✅ Sauvegarde créée', { backupPath });
    } catch (error) {
      logger.warn('⚠️ Impossible de créer la sauvegarde', { error: (error as Error).message });
    }
  }

  // Restaurer selon le type de source
  let sourceType: 'tag' | 'backup';
  let restoredBaseline: BaselineConfig;

  if (args.source.startsWith('baseline-v')) {
    // Restauration depuis un tag Git
    sourceType = 'tag';
    try {
      logger.info('Restauration depuis le tag Git', { tagName: args.source });

      // Vérifier si le tag existe
      try {
        execSync(`git rev-parse --verify ${args.source}^{commit}`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (tagError) {
        // Récupérer les tags disponibles
        let availableTags = '';
        try {
          const allTags = execSync('git tag -l', { encoding: 'utf8' });
          const baselineTags = allTags.split('\n').filter(tag => tag.startsWith('baseline-v'));
          if (baselineTags.length > 0) {
            availableTags = `\n\nTags baseline disponibles:\n${baselineTags.map(t => `  - ${t}`).join('\n')}`;
          }
        } catch (listError) {
          // Ignorer
        }

        throw new StateManagerError(
          `Le tag Git ${args.source} n'existe pas.${availableTags}\n\nUtilisez un tag existant ou restaurez depuis une sauvegarde.`,
          'TAG_NOT_FOUND',
          'BaselineTool',
          { source: args.source }
        );
      }

      // Récupérer le contenu du tag
      const baselineContent = execSync(`git show ${args.source}:sync-config.ref.json`, { encoding: 'utf8' });
      restoredBaseline = JSON.parse(baselineContent) as BaselineConfig;

      if (!restoredBaseline.machineId || !restoredBaseline.version) {
        throw new BaselineServiceError('Baseline invalide: champs requis manquants', BaselineServiceErrorCode.BASELINE_INVALID);
      }

      logger.info('Baseline récupérée depuis le tag', {
        machineId: restoredBaseline.machineId,
        version: restoredBaseline.version
      });
    } catch (error) {
      throw new RooSyncServiceError(
        `Erreur lors de la restauration depuis le tag ${args.source}: ${(error as Error).message}`,
        'RESTORE_FROM_TAG_ERROR'
      );
    }
  } else if (args.source.includes('sync-config.ref.backup.')) {
    // Restauration depuis un fichier de sauvegarde
    sourceType = 'backup';
    try {
      logger.info('Restauration depuis la sauvegarde', { backupPath: args.source });

      if (!existsSync(args.source)) {
        throw new BaselineServiceError(`Fichier de sauvegarde non trouvé: ${args.source}`, BaselineServiceErrorCode.BASELINE_NOT_FOUND);
      }

      const backupContent = readFileSync(args.source, 'utf-8');
      restoredBaseline = JSON.parse(backupContent) as BaselineConfig;

      if (!restoredBaseline.machineId || !restoredBaseline.version) {
        throw new BaselineServiceError('Baseline invalide: champs requis manquants', BaselineServiceErrorCode.BASELINE_INVALID);
      }

      logger.info('Baseline récupérée depuis la sauvegarde', {
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
      `Source de restauration non reconnue: ${args.source}. Utilisez un tag Git (baseline-vX.Y.Z) ou un chemin de sauvegarde.`,
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

    logger.info('✅ Baseline restaurée avec succès', {
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

  logger.info('✅ Baseline restore completed successfully', {
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

  logger.info('📤 Starting baseline export', {
    format: args.format,
    machineId: args.machineId
  });

  const service = getRooSyncService();
  const config = service.getConfig();
  const configService = new ConfigService();
  const baselineService = new BaselineService(configService, {} as any, {} as any);

  // Récupérer la baseline
  const baseline = await baselineService.loadBaseline();
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
      content = generateYamlExport(exportData);
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
  const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  if (outputDir && !existsSync(outputDir)) {
    require('fs').mkdirSync(outputDir, { recursive: true });
  }

  // Écrire le fichier
  writeFileSync(outputPath, content, 'utf-8');

  logger.info('✅ Baseline exported successfully', {
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
    machineId: config.machineId,
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

function createBaselineFromInventory(machineId: string, inventory: any, version: string): any {
  return {
    machineId,
    version,
    lastUpdated: new Date().toISOString(),
    config: {
      roo: {
        modes: inventory.config?.roo?.modes || [],
        mcpSettings: inventory.config?.roo?.mcpSettings || {},
        userSettings: inventory.config?.roo?.userSettings || {}
      },
      hardware: {
        cpu: inventory.config?.hardware?.cpu || 'Unknown',
        ram: inventory.config?.hardware?.ram || 'Unknown',
        disks: inventory.config?.hardware?.disks || []
      },
      software: {
        powershell: inventory.config?.software?.powershell || 'Unknown',
        node: inventory.config?.software?.node || 'N/A',
        python: inventory.config?.software?.python || 'N/A'
      },
      system: {
        os: inventory.config?.system?.os || 'Unknown',
        architecture: inventory.config?.system?.architecture || 'Unknown'
      }
    }
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
      const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));

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
      logger.info('✅ Dashboard updated');
    } catch (error) {
      logger.warn('⚠️ Could not update dashboard', { error });
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
      logger.info('✅ Roadmap updated');
    } catch (error) {
      logger.warn('⚠️ Could not update roadmap', { error });
    }
  }
}

function generateJsonExport(data: any, prettyPrint: boolean): string {
  return prettyPrint ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

function generateYamlExport(data: any): string {
  try {
    const yaml = require('js-yaml');
    return yaml.dump(data, { indent: 2 });
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

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const baselineToolMetadata = {
  name: 'roosync_baseline',
  description: 'Outil consolidé pour gérer les baselines RooSync (update, version, restore, export)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['update', 'version', 'restore', 'export'],
        description: 'Action à effectuer sur la baseline'
      },
      machineId: {
        type: 'string',
        description: '[update] ID de la machine ou nom du profil'
      },
      mode: {
        type: 'string',
        enum: ['standard', 'profile'],
        description: '[update] Mode de mise à jour'
      },
      aggregationConfig: {
        type: 'object',
        description: '[update] Configuration d\'agrégation (mode profile uniquement)'
      },
      version: {
        type: 'string',
        description: '[update/version] Version de la baseline'
      },
      createBackup: {
        type: 'boolean',
        description: '[update/restore] Créer une sauvegarde (défaut: true)'
      },
      updateReason: {
        type: 'string',
        description: '[update/restore] Raison de la modification'
      },
      updatedBy: {
        type: 'string',
        description: '[update] Auteur de la mise à jour'
      },
      message: {
        type: 'string',
        description: '[version] Message du tag Git'
      },
      pushTags: {
        type: 'boolean',
        description: '[version] Pousser les tags (défaut: true)'
      },
      createChangelog: {
        type: 'boolean',
        description: '[version] Mettre à jour CHANGELOG (défaut: true)'
      },
      source: {
        type: 'string',
        description: '[restore] Source de restauration (tag Git ou chemin sauvegarde)'
      },
      targetVersion: {
        type: 'string',
        description: '[restore] Version cible'
      },
      restoredBy: {
        type: 'string',
        description: '[restore] Auteur de la restauration'
      },
      format: {
        type: 'string',
        enum: ['json', 'yaml', 'csv'],
        description: '[export] Format d\'exportation'
      },
      outputPath: {
        type: 'string',
        description: '[export] Chemin de sortie'
      },
      includeHistory: {
        type: 'boolean',
        description: '[export] Inclure l\'historique (défaut: false)'
      },
      includeMetadata: {
        type: 'boolean',
        description: '[export] Inclure les métadonnées (défaut: true)'
      },
      prettyPrint: {
        type: 'boolean',
        description: '[export] Formater la sortie (défaut: true)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
