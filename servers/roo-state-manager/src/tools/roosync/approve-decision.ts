/**
 * Outil MCP : roosync_approve_decision
 * 
 * Approuve une décision de synchronisation.
 * 
 * @module tools/roosync/approve-decision
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema de validation pour roosync_approve_decision
 */
export const ApproveDecisionArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à approuver'),
  comment: z.string().optional()
    .describe('Commentaire d\'approbation (optionnel)')
});

export type ApproveDecisionArgs = z.infer<typeof ApproveDecisionArgsSchema>;

/**
 * Schema de retour pour roosync_approve_decision
 */
export const ApproveDecisionResultSchema = z.object({
  decisionId: z.string().describe('ID de la décision'),
  previousStatus: z.string().describe('Statut précédent'),
  newStatus: z.literal('approved').describe('Nouveau statut (toujours "approved")'),
  approvedAt: z.string().describe('Date d\'approbation (ISO 8601)'),
  approvedBy: z.string().describe('Machine ayant approuvé'),
  comment: z.string().optional().describe('Commentaire d\'approbation'),
  nextSteps: z.array(z.string()).describe('Prochaines actions à effectuer')
});

export type ApproveDecisionResult = z.infer<typeof ApproveDecisionResultSchema>;

/**
 * Outil roosync_approve_decision
 * 
 * Approuve une décision en mettant à jour son statut dans sync-roadmap.md.
 * 
 * @param args Arguments validés
 * @returns Résultat de l'approbation
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncApproveDecision(args: ApproveDecisionArgs): Promise<ApproveDecisionResult> {
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
      `**Statut:** approved`
    );
    
    // Ajouter les métadonnées d'approbation
    const approvalMetadata = `\n**Approuvé le:** ${now}\n**Approuvé par:** ${config.machineId}`;
    const commentMetadata = args.comment ? `\n**Commentaire:** ${args.comment}` : '';
    
    updatedBlock += approvalMetadata + commentMetadata;
    
    // Remplacer dans le contenu
    content = content.replace(
      match[0],
      `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
    );
    
    // Sauvegarder
    writeFileSync(roadmapPath, content, 'utf-8');
    
    // Déterminer les prochaines étapes
    const nextSteps = [
      'Utiliser roosync_apply_decision pour appliquer les changements',
      'Notifier les machines cibles de l\'approbation',
      'Vérifier l\'état de synchronisation avec roosync_get_status'
    ];
    
    return {
      decisionId: args.decisionId,
      previousStatus: decision.status,
      newStatus: 'approved',
      approvedAt: now,
      approvedBy: config.machineId,
      comment: args.comment,
      nextSteps
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de l'approbation: ${(error as Error).message}`,
      'ROOSYNC_APPROVE_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const approveDecisionToolMetadata = {
  name: 'roosync_approve_decision',
  description: 'Approuver une décision de synchronisation',
  inputSchema: {
    type: 'object' as const,
    properties: {
      decisionId: {
        type: 'string',
        description: 'ID de la décision à approuver'
      },
      comment: {
        type: 'string',
        description: 'Commentaire d\'approbation (optionnel)'
      }
    },
    required: ['decisionId'],
    additionalProperties: false
  }
};