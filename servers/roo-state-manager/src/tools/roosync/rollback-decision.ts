/**
 * Outil MCP : roosync_rollback_decision
 * 
 * Annule une décision de synchronisation appliquée.
 * ✅ Connecté aux méthodes réelles de RooSyncService.
 * 
 * @module tools/roosync/rollback-decision
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema de validation pour roosync_rollback_decision
 */
export const RollbackDecisionArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à annuler'),
  reason: z.string()
    .describe('Raison du rollback (requis pour traçabilité)')
});

export type RollbackDecisionArgs = z.infer<typeof RollbackDecisionArgsSchema>;

/**
 * Schema de retour pour roosync_rollback_decision
 */
export const RollbackDecisionResultSchema = z.object({
  decisionId: z.string().describe('ID de la décision'),
  previousStatus: z.string().describe('Statut précédent'),
  newStatus: z.literal('rolled_back').describe('Nouveau statut'),
  rolledBackAt: z.string().describe('Date du rollback (ISO 8601)'),
  rolledBackBy: z.string().describe('Machine ayant effectué le rollback'),
  reason: z.string().describe('Raison du rollback'),
  restoredFiles: z.array(z.string()).describe('Fichiers restaurés'),
  executionLog: z.array(z.string()).describe('Logs d\'exécution')
});

export type RollbackDecisionResult = z.infer<typeof RollbackDecisionResultSchema>;


/**
 * Outil roosync_rollback_decision
 * 
 * Annule une décision appliquée en restaurant l'état précédent.
 * 
 * @param args Arguments validés
 * @returns Résultat du rollback
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncRollbackDecision(args: RollbackDecisionArgs): Promise<RollbackDecisionResult> {
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
    if (decision.status !== 'applied') {
      throw new RooSyncServiceError(
        `Décision pas encore appliquée (statut: ${decision.status})`,
        'DECISION_NOT_APPLIED'
      );
    }
    
    const now = new Date().toISOString();
    const executionLog: string[] = [];
    let restoredFiles: string[] = [];
    
    try {
      // ✅ Connected to RooSyncService real methods
      // Restaurer depuis le point de rollback
      executionLog.push('[ROLLBACK] Début de la restauration...');
      const result = await service.restoreFromRollbackPoint(args.decisionId);
      
      if (!result.success) {
        throw new Error(result.error || 'Échec de la restauration');
      }
      
      executionLog.push(...result.logs);
      restoredFiles = result.restoredFiles;
      executionLog.push('[ROLLBACK] Restauration terminée avec succès');
    } catch (rollbackError) {
      const errorMsg = (rollbackError as Error).message;
      executionLog.push(`[ERREUR] ${errorMsg}`);
      
      throw new RooSyncServiceError(
        `Échec du rollback: ${errorMsg}`,
        'ROLLBACK_FAILED'
      );
    }
    
    // Mettre à jour la décision dans sync-roadmap.md
    const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
    let content = readFileSync(roadmapPath, 'utf-8');
    
    const blockRegex = new RegExp(
      `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${args.decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
      'g'
    );
    
    const match = blockRegex.exec(content);
    if (!match) {
      throw new RooSyncServiceError(
        `Bloc de décision '${args.decisionId}' introuvable dans sync-roadmap.md`,
        'ROOSYNC_FILE_ERROR'
      );
    }
    
    // Construire le bloc mis à jour
    let updatedBlock = match[1];
    
    // Remplacer le statut
    updatedBlock = updatedBlock.replace(
      /\*\*Statut:\*\*\s*.+$/m,
      `**Statut:** rolled_back`
    );
    
    // Ajouter métadonnées de rollback
    const rollbackMetadata = `\n**Rollback le:** ${now}\n**Rollback par:** ${config.machineId}\n**Raison:** ${args.reason}\n**Fichiers restaurés:** ${restoredFiles.length}`;
    updatedBlock += rollbackMetadata;
    
    content = content.replace(
      match[0],
      `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
    );
    
    writeFileSync(roadmapPath, content, 'utf-8');
    
    // Vider le cache pour forcer le rechargement
    service.clearCache();
    
    return {
      decisionId: args.decisionId,
      previousStatus: decision.status,
      newStatus: 'rolled_back',
      rolledBackAt: now,
      rolledBackBy: config.machineId,
      reason: args.reason,
      restoredFiles,
      executionLog
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors du rollback: ${(error as Error).message}`,
      'ROOSYNC_ROLLBACK_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const rollbackDecisionToolMetadata = {
  name: 'roosync_rollback_decision',
  description: 'Annuler une décision de synchronisation appliquée',
  inputSchema: {
    type: 'object' as const,
    properties: {
      decisionId: {
        type: 'string',
        description: 'ID de la décision à annuler'
      },
      reason: {
        type: 'string',
        description: 'Raison du rollback (requis pour traçabilité)'
      }
    },
    required: ['decisionId', 'reason'],
    additionalProperties: false
  }
};