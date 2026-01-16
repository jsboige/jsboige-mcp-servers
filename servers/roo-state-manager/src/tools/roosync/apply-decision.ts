/**
 * Outil MCP : roosync_apply_decision
 * 
 * Applique une décision de synchronisation approuvée.
 * ✅ Connecté aux méthodes réelles de RooSyncService.
 * 
 * @module tools/roosync/apply-decision
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { BaselineServiceError, BaselineServiceErrorCode } from '../../types/errors.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema de validation pour roosync_apply_decision
 */
export const ApplyDecisionArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à appliquer'),
  dryRun: z.boolean().optional()
    .describe('Mode simulation sans modification réelle (défaut: false)'),
  force: z.boolean().optional()
    .describe('Forcer application même si conflits détectés (défaut: false)')
});

export type ApplyDecisionArgs = z.infer<typeof ApplyDecisionArgsSchema>;

/**
 * Schema de retour pour roosync_apply_decision
 */
export const ApplyDecisionResultSchema = z.object({
  decisionId: z.string().describe('ID de la décision'),
  previousStatus: z.string().describe('Statut précédent'),
  newStatus: z.enum(['applied', 'failed']).describe('Nouveau statut'),
  appliedAt: z.string().describe('Date d\'application (ISO 8601)'),
  appliedBy: z.string().describe('Machine ayant appliqué'),
  executionLog: z.array(z.string()).describe('Logs d\'exécution'),
  changes: z.object({
    filesModified: z.array(z.string()),
    filesCreated: z.array(z.string()),
    filesDeleted: z.array(z.string())
  }).describe('Changements effectués'),
  rollbackAvailable: z.boolean().describe('Point de rollback disponible'),
  error: z.string().optional().describe('Message d\'erreur si échec')
});

export type ApplyDecisionResult = z.infer<typeof ApplyDecisionResultSchema>;


/**
 * Outil roosync_apply_decision
 * 
 * Applique une décision approuvée en exécutant les scripts RooSync appropriés.
 * 
 * @param args Arguments validés
 * @returns Résultat de l'application
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncApplyDecision(args: ApplyDecisionArgs): Promise<ApplyDecisionResult> {
  try {
    const service = getRooSyncService();
    const config = service.getConfig();
    
    // Charger la décision
    const decision = await service.getDecision(args.decisionId);
    
    if (!decision) {
      throw new RooSyncServiceError(
        `Décision '${args.decisionId}' introuvable`,
        'DECISION_NOT_FOUND'
      );
    }
    
    // Vérifier le statut
    if (decision.status !== 'approved') {
      throw new RooSyncServiceError(
        `Décision pas encore approuvée (statut: ${decision.status})`,
        'DECISION_NOT_APPROVED'
      );
    }
    
    const now = new Date().toISOString();
    let newStatus: 'applied' | 'failed' = 'applied';
    let executionLog: string[] = [];
    let changes = {
      filesModified: [] as string[],
      filesCreated: [] as string[],
      filesDeleted: [] as string[]
    };
    let rollbackAvailable = false;
    let error: string | undefined;
    
    try {
      // Mode dry run
      if (args.dryRun) {
        executionLog.push('[DRY RUN] Mode simulation - aucun changement réel');
        // ✅ Connected to RooSyncService real methods
        const result = await service.executeDecision(args.decisionId, { dryRun: true });
        executionLog.push(...result.logs);
        changes = result.changes;
        rollbackAvailable = false;
      } else {
        // Créer point de rollback
        // ✅ Connected to RooSyncService real methods
        executionLog.push('[ROLLBACK] Création du point de rollback...');
        await service.createRollbackPoint(args.decisionId);
        executionLog.push('[ROLLBACK] Point de rollback créé avec succès');
        rollbackAvailable = true;
        
        // Exécuter la décision
        executionLog.push('[EXECUTION] Début de l\'application...');
        const result = await service.executeDecision(args.decisionId, {
          dryRun: false,
          force: args.force
        });
        
        if (!result.success) {
          throw new BaselineServiceError(result.error || 'Échec de l\'exécution', BaselineServiceErrorCode.APPLICATION_FAILED);
        }
        
        executionLog.push(...result.logs);
        changes = result.changes;
        executionLog.push('[EXECUTION] Application terminée avec succès');
      }
    } catch (execError) {
      newStatus = 'failed';
      error = (execError as Error).message;
      executionLog.push(`[ERREUR] ${error}`);
      
      // Tentative de rollback automatique si disponible
      if (rollbackAvailable && !args.dryRun) {
        try {
          // ✅ Connected to RooSyncService real methods
          executionLog.push('[ROLLBACK] Tentative de rollback automatique...');
          const rollbackResult = await service.restoreFromRollbackPoint(args.decisionId);
          if (rollbackResult.success) {
            executionLog.push('[ROLLBACK] Rollback automatique réussi.');
            executionLog.push(...rollbackResult.logs);
          } else {
            executionLog.push(`[ROLLBACK ERREUR] Échec du rollback automatique: ${rollbackResult.error}`);
          }
        } catch (rollbackError) {
          executionLog.push(`[ROLLBACK ERREUR] ${(rollbackError as Error).message}`);
        }
      }
    }
    
    // Mettre à jour la décision dans sync-roadmap.md
    if (!args.dryRun) {
      const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
      let content = readFileSync(roadmapPath, 'utf-8');
      
      const blockRegex = new RegExp(
        `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${args.decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
        'g'
      );
      
      const match = blockRegex.exec(content);
      if (match) {
        let updatedBlock = match[1];
        
        // Remplacer le statut
        updatedBlock = updatedBlock.replace(
          /\*\*Statut:\*\*\s*.+$/m,
          `**Statut:** ${newStatus}`
        );
        
        // Ajouter métadonnées d'application
        const applicationMetadata = `\n**Appliqué le:** ${now}\n**Appliqué par:** ${config.machineId}\n**Rollback disponible:** ${rollbackAvailable ? 'Oui' : 'Non'}`;
        if (error) {
          updatedBlock += `\n**Erreur:** ${error}`;
        }
        updatedBlock += applicationMetadata;
        
        content = content.replace(
          match[0],
          `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
        );
        
        writeFileSync(roadmapPath, content, 'utf-8');
        
        // Vider le cache pour forcer le rechargement
        service.clearCache();
      }
    }
    
    return {
      decisionId: args.decisionId,
      previousStatus: decision.status,
      newStatus,
      appliedAt: now,
      appliedBy: config.machineId,
      executionLog,
      changes,
      rollbackAvailable,
      error
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de l'application: ${(error as Error).message}`,
      'ROOSYNC_APPLY_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const applyDecisionToolMetadata = {
  name: 'roosync_apply_decision',
  description: 'Appliquer une décision de synchronisation approuvée',
  inputSchema: {
    type: 'object' as const,
    properties: {
      decisionId: {
        type: 'string',
        description: 'ID de la décision à appliquer'
      },
      dryRun: {
        type: 'boolean',
        description: 'Mode simulation sans modification réelle (défaut: false)'
      },
      force: {
        type: 'boolean',
        description: 'Forcer application même si conflits détectés (défaut: false)'
      }
    },
    required: ['decisionId'],
    additionalProperties: false
  }
};