/**
 * Outil MCP : roosync_reject_decision
 * 
 * Rejette une décision de synchronisation avec motif.
 * 
 * @module tools/roosync/reject-decision
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema de validation pour roosync_reject_decision
 */
export const RejectDecisionArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à rejeter'),
  reason: z.string()
    .describe('Motif du rejet (requis pour traçabilité)')
});

export type RejectDecisionArgs = z.infer<typeof RejectDecisionArgsSchema>;

/**
 * Schema de retour pour roosync_reject_decision
 */
export const RejectDecisionResultSchema = z.object({
  decisionId: z.string().describe('ID de la décision'),
  previousStatus: z.string().describe('Statut précédent'),
  newStatus: z.literal('rejected').describe('Nouveau statut (toujours "rejected")'),
  rejectedAt: z.string().describe('Date de rejet (ISO 8601)'),
  rejectedBy: z.string().describe('Machine ayant rejeté'),
  reason: z.string().describe('Motif du rejet'),
  nextSteps: z.array(z.string()).describe('Prochaines actions à effectuer')
});

export type RejectDecisionResult = z.infer<typeof RejectDecisionResultSchema>;

/**
 * Outil roosync_reject_decision
 * 
 * Rejette une décision en mettant à jour son statut dans sync-roadmap.md.
 * 
 * @param args Arguments validés
 * @returns Résultat du rejet
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncRejectDecision(args: RejectDecisionArgs): Promise<RejectDecisionResult> {
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
    if (decision.status !== 'pending') {
      throw new RooSyncServiceError(
        `Décision déjà traitée (statut: ${decision.status})`,
        'DECISION_ALREADY_PROCESSED'
      );
    }
    
    // Mettre à jour la décision dans le fichier
    const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
    let content = readFileSync(roadmapPath, 'utf-8');
    
    // Trouver et remplacer le bloc de décision
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
    const now = new Date().toISOString();
    let updatedBlock = match[1];
    
    // Remplacer le statut
    updatedBlock = updatedBlock.replace(
      /\*\*Statut:\*\*\s*.+$/m,
      `**Statut:** rejected`
    );
    
    // Ajouter les métadonnées de rejet
    const rejectionMetadata = `\n**Rejeté le:** ${now}\n**Rejeté par:** ${config.machineId}\n**Motif:** ${args.reason}`;
    
    updatedBlock += rejectionMetadata;
    
    // Remplacer dans le contenu
    content = content.replace(
      match[0],
      `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
    );
    
    // Sauvegarder
    writeFileSync(roadmapPath, content, 'utf-8');
    
    // Déterminer les prochaines étapes
    const nextSteps = [
      'La décision ne sera pas appliquée',
      'Consulter sync-roadmap.md pour l\'historique',
      'Vérifier l\'état de synchronisation avec roosync_get_status'
    ];
    
    return {
      decisionId: args.decisionId,
      previousStatus: decision.status,
      newStatus: 'rejected',
      rejectedAt: now,
      rejectedBy: config.machineId,
      reason: args.reason,
      nextSteps
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors du rejet: ${(error as Error).message}`,
      'ROOSYNC_REJECT_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const rejectDecisionToolMetadata = {
  name: 'roosync_reject_decision',
  description: 'Rejeter une décision de synchronisation avec motif',
  inputSchema: {
    type: 'object' as const,
    properties: {
      decisionId: {
        type: 'string',
        description: 'ID de la décision à rejeter'
      },
      reason: {
        type: 'string',
        description: 'Motif du rejet (requis pour traçabilité)'
      }
    },
    required: ['decisionId', 'reason'],
    additionalProperties: false
  }
};