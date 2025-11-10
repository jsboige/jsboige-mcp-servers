/**
 * Outil MCP : roosync_restore_baseline
 * 
 * Restaure une baseline précédente depuis un tag Git ou une sauvegarde.
 * 
 * @module tools/roosync/restore-baseline
 * @version 2.1.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { execSync } from 'child_process';
import type { BaselineConfig } from '../../types/baseline.js';

// Logger instance for restore baseline tool
const logger: Logger = createLogger('RestoreBaselineTool');

/**
 * Schema de validation pour roosync_restore_baseline
 */
export const RestoreBaselineArgsSchema = z.object({
  source: z.string()
    .describe('Source de la restauration (tag Git ou chemin de sauvegarde)'),
  targetVersion: z.string().optional()
    .describe('Version cible pour la restauration (optionnel)'),
  createBackup: z.boolean().optional()
    .describe('Créer une sauvegarde de l\'état actuel (défaut: true)'),
  updateReason: z.string().optional()
    .describe('Raison de la restauration (pour documentation)'),
  restoredBy: z.string().optional()
    .describe('Auteur de la restauration (défaut: machine actuelle)')
});

export type RestoreBaselineArgs = z.infer<typeof RestoreBaselineArgsSchema>;

/**
 * Schema de retour pour roosync_restore_baseline
 */
export const RestoreBaselineResultSchema = z.object({
  success: z.boolean().describe('Succès de la restauration'),
  sourceType: z.string().describe('Type de source (tag|backup)'),
  source: z.string().describe('Source utilisée pour la restauration'),
  previousBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string().optional()
  }).optional().describe('Baseline précédente (état actuel)'),
  restoredBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string()
  }).describe('Baseline restaurée'),
  backupCreated: z.boolean().describe('Si une sauvegarde a été créée'),
  backupPath: z.string().optional().describe('Chemin de la sauvegarde si créée'),
  message: z.string().describe('Message de résultat')
});

export type RestoreBaselineResult = z.infer<typeof RestoreBaselineResultSchema>;

/**
 * Liste les sauvegardes de baseline disponibles
 */
function listAvailableBackups(backupDir: string): string[] {
  try {
    if (!existsSync(backupDir)) {
      return [];
    }
    
    const files = readdirSync(backupDir);
    return files
      .filter(file => file.startsWith('sync-config.ref.backup.') && file.endsWith('.json'))
      .sort()
      .reverse(); // Plus récent en premier
  } catch (error) {
    logger.warn('Erreur lors de la lecture des sauvegardes', { error: (error as Error).message });
    return [];
  }
}

/**
 * Liste les tags Git de baseline disponibles
 */
function listAvailableBaselineTags(): string[] {
  try {
    const result = execSync('git tag -l "baseline-v*" --sort=-version:refname', { encoding: 'utf8' });
    return result
      .split('\n')
      .filter(tag => tag.trim() !== '')
      .sort()
      .reverse(); // Plus récent en premier
  } catch (error) {
    logger.warn('Erreur lors de la lecture des tags Git', { error: (error as Error).message });
    return [];
  }
}

/**
 * Restaure depuis un tag Git
 */
async function restoreFromGitTag(tagName: string): Promise<BaselineConfig> {
  try {
    logger.info('Restauration depuis le tag Git', { tagName });
    
    // Récupérer le contenu du tag
    const baselineContent = execSync(`git show ${tagName}:sync-config.ref.json`, { encoding: 'utf8' });
    const baseline = JSON.parse(baselineContent) as BaselineConfig;
    
    // Valider la baseline
    if (!baseline.machineId || !baseline.version) {
      throw new Error('Baseline invalide: champs requis manquants');
    }
    
    logger.info('Baseline récupérée depuis le tag', { 
      machineId: baseline.machineId, 
      version: baseline.version 
    });
    
    return baseline;
  } catch (error) {
    throw new Error(`Erreur lors de la restauration depuis le tag ${tagName}: ${(error as Error).message}`);
  }
}

/**
 * Restaure depuis un fichier de sauvegarde
 */
async function restoreFromBackup(backupPath: string): Promise<BaselineConfig> {
  try {
    logger.info('Restauration depuis la sauvegarde', { backupPath });
    
    if (!existsSync(backupPath)) {
      throw new Error(`Fichier de sauvegarde non trouvé: ${backupPath}`);
    }
    
    const backupContent = readFileSync(backupPath, 'utf-8');
    const baseline = JSON.parse(backupContent) as BaselineConfig;
    
    // Valider la baseline
    if (!baseline.machineId || !baseline.version) {
      throw new Error('Baseline invalide: champs requis manquants');
    }
    
    logger.info('Baseline récupérée depuis la sauvegarde', { 
      machineId: baseline.machineId, 
      version: baseline.version 
    });
    
    return baseline;
  } catch (error) {
    throw new Error(`Erreur lors de la restauration depuis la sauvegarde: ${(error as Error).message}`);
  }
}

/**
 * Restaure une baseline précédente
 */
export async function restoreBaseline(args: RestoreBaselineArgs): Promise<RestoreBaselineResult> {
  try {
    logger.info('🔄 Starting baseline restore', { 
      source: args.source,
      createBackup: args.createBackup
    });

    // 1. Initialiser les services
    const configService = new ConfigService();
    const sharedPath = configService.getSharedStatePath();
    const baselineService = new BaselineService(configService, {} as any, {} as any);
    
    // 2. Récupérer la baseline actuelle pour sauvegarde
    let currentBaseline: BaselineConfig | null = null;
    try {
      currentBaseline = await baselineService.loadBaseline();
    } catch (error) {
      logger.warn('Impossible de charger la baseline actuelle', { error: (error as Error).message });
    }
    
    // 3. Créer une sauvegarde de l'état actuel si demandé
    let backupCreated = false;
    let backupPath: string | undefined;
    if (args.createBackup !== false && currentBaseline) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = join(sharedPath, '.rollback', `sync-config.ref.backup.${timestamp}.json`);
        
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
    
    // 4. Déterminer le type de source et restaurer
    let sourceType: 'tag' | 'backup';
    let restoredBaseline: BaselineConfig;
    
    if (args.source.startsWith('baseline-v')) {
      // Restauration depuis un tag Git
      sourceType = 'tag';
      restoredBaseline = await restoreFromGitTag(args.source);
    } else if (args.source.includes('sync-config.ref.backup.')) {
      // Restauration depuis un fichier de sauvegarde
      sourceType = 'backup';
      restoredBaseline = await restoreFromBackup(args.source);
    } else {
      throw new Error(`Source de restauration non reconnue: ${args.source}. Utilisez un tag Git (baseline-vX.Y.Z) ou un chemin de sauvegarde.`);
    }
    
    // 5. Appliquer la baseline restaurée
    try {
      await baselineService.updateBaseline(restoredBaseline, {
        createBackup: false, // Déjà géré manuellement
        updateReason: args.updateReason || `Restauration depuis ${sourceType}: ${args.source}`,
        updatedBy: args.restoredBy || 'roosync_restore_baseline'
      });
      
      logger.info('✅ Baseline restaurée avec succès', {
        machineId: restoredBaseline.machineId,
        version: restoredBaseline.version,
        sourceType,
        source: args.source
      });
    } catch (error) {
      throw new Error(`Erreur lors de l'application de la baseline restaurée: ${(error as Error).message}`);
    }
    
    // 6. Préparer le message de résultat
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
      success: true,
      sourceType,
      source: args.source,
      previousBaseline: currentBaseline ? {
        machineId: currentBaseline.machineId,
        version: currentBaseline.version,
        lastUpdated: currentBaseline.lastUpdated || ''
      } : undefined,
      restoredBaseline: {
        machineId: restoredBaseline.machineId,
        version: restoredBaseline.version,
        lastUpdated: restoredBaseline.lastUpdated || ''
      },
      backupCreated,
      backupPath,
      message
    };
    
  } catch (error) {
    logger.error('❌ Baseline restore failed', error);
    
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la restauration de la baseline: ${(error as Error).message}`,
      'BASELINE_RESTORE_ERROR'
    );
  }
}

/**
 * Liste les sources de restauration disponibles
 */
export async function listRestoreSources(): Promise<{ tags: string[], backups: string[] }> {
  try {
    const configService = new ConfigService();
    const sharedPath = configService.getSharedStatePath();
    const backupDir = join(sharedPath, '.rollback');
    
    const tags = listAvailableBaselineTags();
    const backups = listAvailableBackups(backupDir);
    
    return { tags, backups };
  } catch (error) {
    logger.error('Erreur lors de la liste des sources de restauration', error);
    throw new RooSyncServiceError(
      `Erreur liste sources restauration: ${(error as Error).message}`,
      'LIST_RESTORE_SOURCES_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const restoreBaselineToolMetadata = {
  name: 'roosync_restore_baseline',
  description: 'Restaure une baseline précédente depuis un tag Git ou une sauvegarde',
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        description: 'Source de la restauration (tag Git ou chemin de sauvegarde)'
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
    required: ['source']
  }
};

/**
 * Point d'entrée principal pour l'outil MCP
 */
export async function handleRestoreBaselineCall(args: unknown): Promise<RestoreBaselineResult> {
  const parsedArgs = RestoreBaselineArgsSchema.parse(args);
  return await restoreBaseline(parsedArgs);
}