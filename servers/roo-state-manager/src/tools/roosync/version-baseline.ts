/**
 * Outil MCP : roosync_version_baseline
 * 
 * Crée un tag Git pour versionner la baseline actuelle.
 * 
 * @module tools/roosync/version-baseline
 * @version 2.1.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { execSync } from 'child_process';
import type { BaselineConfig } from '../../types/baseline.js';

// Logger instance for version baseline tool
const logger: Logger = createLogger('VersionBaselineTool');

/**
 * Schema de validation pour roosync_version_baseline
 */
export const VersionBaselineArgsSchema = z.object({
  version: z.string()
    .describe('Version de la baseline (format: X.Y.Z)'),
  message: z.string().optional()
    .describe('Message du tag Git (défaut: auto-généré)'),
  pushTags: z.boolean().optional()
    .describe('Pousser les tags vers le dépôt distant (défaut: true)'),
  createChangelog: z.boolean().optional()
    .describe('Mettre à jour le CHANGELOG-baseline.md (défaut: true)')
});

export type VersionBaselineArgs = z.infer<typeof VersionBaselineArgsSchema>;

/**
 * Schema de retour pour roosync_version_baseline
 */
export const VersionBaselineResultSchema = z.object({
  success: z.boolean().describe('Succès du versioning'),
  version: z.string().describe('Version créée'),
  tagName: z.string().describe('Nom du tag créé'),
  tagCreated: z.boolean().describe('Si le tag a été créé'),
  tagPushed: z.boolean().describe('Si le tag a été poussé'),
  changelogUpdated: z.boolean().describe('Si le CHANGELOG a été mis à jour'),
  baselineMachine: z.string().describe('Machine baseline versionnée'),
  message: z.string().describe('Message de résultat')
});

export type VersionBaselineResult = z.infer<typeof VersionBaselineResultSchema>;

/**
 * Valide le format de version sémantique
 */
function validateSemanticVersion(version: string): boolean {
  const semanticVersionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
  return semanticVersionRegex.test(version);
}

/**
 * Crée un tag Git pour la baseline
 */
export async function versionBaseline(args: VersionBaselineArgs): Promise<VersionBaselineResult> {
  try {
    logger.info('🏷️ Starting baseline versioning', { 
      version: args.version,
      pushTags: args.pushTags,
      createChangelog: args.createChangelog
    });

    // 1. Valider le format de version
    if (!validateSemanticVersion(args.version)) {
      throw new RooSyncServiceError(
        `Format de version invalide: ${args.version}. Attendu: X.Y.Z`,
        'INVALID_VERSION_FORMAT'
      );
    }

    // 2. Initialiser les services
    const configService = new ConfigService();
    const sharedPath = configService.getSharedStatePath();
    const baselineService = new BaselineService(configService, {} as any, {} as any);
    
    // 3. Charger la baseline actuelle
    const currentBaseline = await baselineService.loadBaseline();
    if (!currentBaseline) {
      throw new RooSyncServiceError(
        'Aucune baseline trouvée. Créez une baseline avant de la versionner.',
        'NO_BASELINE_FOUND'
      );
    }

    // 4. Préparer le tag Git
    const tagName = `baseline-v${args.version}`;
    const tagMessage = args.message || `Baseline version ${args.version} - Machine: ${currentBaseline.machineId}`;
    
    logger.info('Creating Git tag', { tagName, message: tagMessage });

    // 5. Vérifier si le tag existe déjà
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

    // 6. Créer le tag Git
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

    // 7. Pousser le tag si demandé
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

    // 8. Mettre à jour le CHANGELOG si demandé
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

    // 9. Mettre à jour la version dans la baseline
    try {
      const updatedBaseline: BaselineConfig = {
        ...currentBaseline,
        version: args.version,
        lastUpdated: new Date().toISOString()
      };
      
      await baselineService.updateBaseline(updatedBaseline, {
        createBackup: true,
        updateReason: `Versioning baseline v${args.version}`,
        updatedBy: 'roosync_version_baseline'
      });
      
      logger.info('✅ Baseline version updated', { version: args.version });
    } catch (error) {
      logger.warn('⚠️ Could not update baseline version', { error: (error as Error).message });
      // Continuer sans bloquer
    }

    // 10. Préparer le message de résultat
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
      success: true,
      version: args.version,
      tagName,
      tagCreated,
      tagPushed,
      changelogUpdated,
      baselineMachine: currentBaseline.machineId,
      message
    };
    
  } catch (error) {
    logger.error('❌ Baseline versioning failed', error);
    
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors du versioning de la baseline: ${(error as Error).message}`,
      'BASELINE_VERSIONING_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const versionBaselineToolMetadata = {
  name: 'roosync_version_baseline',
  description: 'Crée un tag Git pour versionner la baseline actuelle',
  inputSchema: {
    type: 'object' as const,
    properties: {
      version: {
        type: 'string',
        description: 'Version de la baseline (format: X.Y.Z)'
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
      }
    },
    required: ['version']
  }
};

/**
 * Point d'entrée principal pour l'outil MCP
 */
export async function handleVersionBaselineCall(args: unknown): Promise<VersionBaselineResult> {
  const parsedArgs = VersionBaselineArgsSchema.parse(args);
  return await versionBaseline(parsedArgs);
}