/**
 * Outil MCP : roosync_manage_baseline
 * 
 * Outil consolidé combinant version-baseline et restore-baseline.
 * Permet de versionner et de restaurer des baselines.
 * 
 * @module tools/roosync/manage-baseline
 * @version 2.3.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { execSync } from 'child_process';
import type { BaselineConfig } from '../../types/baseline.js';

// Logger instance for manage baseline tool
const logger: Logger = createLogger('ManageBaselineTool');

/**
 * Schema de validation pour roosync_manage_baseline
 */
export const ManageBaselineArgsSchema = z.object({
  action: z.enum(['version', 'restore'])
    .describe('Action à effectuer: version ou restore'),
  version: z.string().optional()
    .describe('Version de la baseline (format: X.Y.Z) pour action version'),
  message: z.string().optional()
    .describe('Message du tag Git (défaut: auto-généré)'),
  pushTags: z.boolean().optional()
    .describe('Pousser les tags vers le dépôt distant (défaut: true)'),
  createChangelog: z.boolean().optional()
    .describe('Mettre à jour le CHANGELOG-baseline.md (défaut: true)'),
  source: z.string().optional()
    .describe('Source de la restauration (tag Git ou chemin de sauvegarde) pour action restore'),
  targetVersion: z.string().optional()
    .describe('Version cible pour la restauration (optionnel)'),
  createBackup: z.boolean().optional()
    .describe('Créer une sauvegarde de l\'état actuel (défaut: true)'),
  updateReason: z.string().optional()
    .describe('Raison de la restauration (pour documentation)'),
  restoredBy: z.string().optional()
    .describe('Auteur de la restauration (défaut: machine actuelle)')
});

export type ManageBaselineArgs = z.infer<typeof ManageBaselineArgsSchema>;

/**
 * Schema de retour pour roosync_manage_baseline
 */
export const ManageBaselineResultSchema = z.object({
  action: z.string().describe('Action effectuée'),
  success: z.boolean().describe('Succès de l\'opération'),
  version: z.string().describe('Version de la baseline'),
  tag: z.string().optional().describe('Nom du tag créé'),
  message: z.string().describe('Message de résultat'),
  timestamp: z.string().describe('Timestamp de l\'opération'),
  machineId: z.string().describe('ID de la machine'),
  backupCreated: z.boolean().optional().describe('Si une sauvegarde a été créée'),
  backupPath: z.string().optional().describe('Chemin de la sauvegarde si créée')
});

export type ManageBaselineResult = z.infer<typeof ManageBaselineResultSchema>;

/**
 * Valide le format de version sémantique
 */
function validateSemanticVersion(version: string): boolean {
  const semanticVersionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
  return semanticVersionRegex.test(version);
}

/**
 * Outil roosync_manage_baseline
 * 
 * Outil consolidé combinant version-baseline et restore-baseline.
 * 
 * @param args Arguments validés
 * @returns Résultat de l'opération
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosync_manage_baseline(args: ManageBaselineArgs): Promise<ManageBaselineResult> {
  try {
    const timestamp = new Date().toISOString();
    const service = getRooSyncService();
    const config = service.getConfig();

    if (args.action === 'version') {
      return await handleVersionAction(args, timestamp, config);
    } else if (args.action === 'restore') {
      return await handleRestoreAction(args, timestamp, config);
    } else {
      throw new RooSyncServiceError(
        `Action non supportée: ${args.action}`,
        'INVALID_ACTION'
      );
    }
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de l'opération: ${(error as Error).message}`,
      'ROOSYNC_MANAGE_BASELINE_ERROR'
    );
  }
}

/**
 * Gère l'action version
 */
async function handleVersionAction(
  args: ManageBaselineArgs,
  timestamp: string,
  config: any
): Promise<ManageBaselineResult> {
  logger.info('🏷️ Starting baseline versioning', { 
    version: args.version,
    pushTags: args.pushTags,
    createChangelog: args.createChangelog
  });

  // Valider le format de version
  if (!args.version || !validateSemanticVersion(args.version)) {
    throw new RooSyncServiceError(
      `Format de version invalide: ${args.version}. Attendu: X.Y.Z`,
      'INVALID_VERSION_FORMAT'
    );
  }

  // Initialiser les services
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
    logger.warn('Tag already exists', { tagName });
  } catch (error) {
    // Le tag n'existe pas, c'est normal
  }

  if (tagExists) {
    throw new RooSyncServiceError(
      `Le tag ${tagName} existe déjà. Utilisez une autre version.`,
      'TAG_ALREADY_EXISTS'
    );
  }

  // Créer le tag Git
  let tagCreated = false;
  try {
    execSync(`git tag -a ${tagName} -m "${tagMessage}"`, { stdio: 'pipe' });
    tagCreated = true;
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
      logger.info('✅ Git tag pushed successfully', { tagName });
    } catch (error) {
      logger.warn('⚠️ Could not push Git tag', { error: (error as Error).message });
      // Continuer sans bloquer
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
        // Créer l'en-tête du CHANGELOG
        changelogContent = `# CHANGELOG Baseline RooSync\n\nToutes les modifications notables de la baseline.\n\n`;
      }
      
      // Ajouter l'entrée de version
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
      
      // Insérer au début du fichier (après l'en-tête)
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
      logger.info('✅ CHANGELOG updated successfully', { changelogPath });
    } catch (error) {
      logger.warn('⚠️ Could not update CHANGELOG', { error: (error as Error).message });
      // Continuer sans bloquer
    }
  }

  // Mettre à jour la version dans la baseline
  try {
    const updatedBaseline: BaselineConfig = {
      ...currentBaseline,
      version: args.version,
      lastUpdated: new Date().toISOString(),
      config: currentBaseline.config || {
        roo: {
          modes: [],
          mcpSettings: {},
          userSettings: {}
        },
        hardware: {
          cpu: { model: '', cores: 0, threads: 0 },
          memory: { total: 0 },
          disks: []
        },
        software: {
          powershell: '',
          node: '',
          python: ''
        },
        system: {
          os: '',
          architecture: ''
        }
      }
    };
    
    await baselineService.updateBaseline(updatedBaseline, {
      createBackup: true,
      updateReason: `Versioning baseline v${args.version}`,
      updatedBy: 'roosync_manage_baseline'
    });
    
    logger.info('✅ Baseline version updated', { version: args.version });
  } catch (error) {
    logger.warn('⚠️ Could not update baseline version', { error: (error as Error).message });
    // Continuer sans bloquer
  }

  // Préparer le message de résultat
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
    baselineMachine: currentBaseline.machineId,
    tagCreated,
    tagPushed,
    changelogUpdated
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
 * Gère l'action restore
 */
async function handleRestoreAction(
  args: ManageBaselineArgs,
  timestamp: string,
  config: any
): Promise<ManageBaselineResult> {
  logger.info('🔄 Starting baseline restore', { 
    source: args.source,
    createBackup: args.createBackup
  });

  // Initialiser les services
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
  
  // Créer une sauvegarde de l'état actuel si demandé
  let backupCreated = false;
  let backupPath: string | undefined;
  if (args.createBackup !== false && currentBaseline) {
    try {
      const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = join(sharedPath, '.rollback', `sync-config.ref.backup.${backupTimestamp}.json`);
      
      // Créer le répertoire de sauvegarde si nécessaire
      const backupDir = join(sharedPath, '.rollback');
      if (!existsSync(backupDir)) {
        execSync(`mkdir -p "${backupDir}"`, { stdio: 'pipe' });
      }
      
      writeFileSync(backupPath, JSON.stringify(currentBaseline, null, 2), 'utf-8');
      backupCreated = true;
      logger.info('✅ Sauvegarde de l\'état actuel créée', { backupPath });
    } catch (error) {
      logger.warn('⚠️ Impossible de créer la sauvegarde', { error: (error as Error).message });
      // Continuer sans bloquer
    }
  }
  
  // Déterminer le type de source et restaurer
  let sourceType: 'tag' | 'backup';
  let restoredBaseline: BaselineConfig;
  
  if (!args.source) {
    throw new RooSyncServiceError(
      'Source de restauration requise',
      'SOURCE_REQUIRED'
    );
  }
  
  if (args.source.startsWith('baseline-v')) {
    // Restauration depuis un tag Git
    sourceType = 'tag';
    try {
      logger.info('Restauration depuis le tag Git', { tagName: args.source });
      
      // Récupérer le contenu du tag
      const baselineContent = execSync(`git show ${args.source}:sync-config.ref.json`, { encoding: 'utf8' });
      restoredBaseline = JSON.parse(baselineContent) as BaselineConfig;
      
      // Valider la baseline
      if (!restoredBaseline.machineId || !restoredBaseline.version) {
        throw new Error('Baseline invalide: champs requis manquants');
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
        throw new Error(`Fichier de sauvegarde non trouvé: ${args.source}`);
      }
      
      const backupContent = readFileSync(args.source, 'utf-8');
      restoredBaseline = JSON.parse(backupContent) as BaselineConfig;
      
      // Valider la baseline
      if (!restoredBaseline.machineId || !restoredBaseline.version) {
        throw new Error('Baseline invalide: champs requis manquants');
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
      createBackup: false, // Déjà géré manuellement
      updateReason: args.updateReason || `Restauration depuis ${sourceType}: ${args.source}`,
      updatedBy: args.restoredBy || 'roosync_manage_baseline'
    });
    
    logger.info('✅ Baseline restaurée avec succès', {
      machineId: restoredBaseline.machineId,
      version: restoredBaseline.version,
      sourceType,
      source: args.source
    });
  } catch (error) {
    throw new RooSyncServiceError(
      `Erreur lors de l'application de la baseline restaurée: ${(error as Error).message}`,
      'APPLY_RESTORED_BASELINE_ERROR'
    );
  }
  
  // Préparer le message de résultat
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
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const manageBaselineToolMetadata = {
  name: 'roosync_manage_baseline',
  description: 'Outil consolidé pour versionner et restaurer des baselines RooSync',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['version', 'restore'],
        description: 'Action à effectuer: version ou restore'
      },
      version: {
        type: 'string',
        description: 'Version de la baseline (format: X.Y.Z) pour action version'
      },
      message: {
        type: 'string',
        description: 'Message du tag Git (défaut: auto-généré)'
      },
      pushTags: {
        type: 'boolean',
        description: 'Pousser les tags vers le dépôt distant (défaut: true)'
      },
      createChangelog: {
        type: 'boolean',
        description: 'Mettre à jour le CHANGELOG-baseline.md (défaut: true)'
      },
      source: {
        type: 'string',
        description: 'Source de la restauration (tag Git ou chemin de sauvegarde) pour action restore'
      },
      targetVersion: {
        type: 'string',
        description: 'Version cible pour la restauration (optionnel)'
      },
      createBackup: {
        type: 'boolean',
        description: 'Créer une sauvegarde de l\'état actuel (défaut: true)'
      },
      updateReason: {
        type: 'string',
        description: 'Raison de la restauration (pour documentation)'
      },
      restoredBy: {
        type: 'string',
        description: 'Auteur de la restauration (défaut: machine actuelle)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
