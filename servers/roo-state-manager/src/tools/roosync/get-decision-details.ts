/**
 * Outil MCP : roosync_get_decision_details
 * 
 * Obtient les détails complets d'une décision de synchronisation.
 * 
 * @module tools/roosync/get-decision-details
 * @version 2.0.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema de validation pour roosync_get_decision_details
 */
export const GetDecisionDetailsArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à consulter'),
  includeHistory: z.boolean().optional()
    .describe('Inclure l\'historique complet (défaut: true)'),
  includeLogs: z.boolean().optional()
    .describe('Inclure les logs d\'exécution (défaut: true)')
});

export type GetDecisionDetailsArgs = z.infer<typeof GetDecisionDetailsArgsSchema>;

/**
 * Schema de retour pour roosync_get_decision_details
 */
export const GetDecisionDetailsResultSchema = z.object({
  decision: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    type: z.string(),
    path: z.string().optional(),
    sourceMachine: z.string(),
    targetMachines: z.array(z.string()),
    created: z.string(),
    description: z.string().optional(),
    diff: z.string().optional()
  }).describe('Objet décision complet'),
  history: z.object({
    created: z.object({
      at: z.string(),
      by: z.string()
    }),
    approved: z.object({
      at: z.string(),
      by: z.string(),
      comment: z.string().optional()
    }).optional(),
    rejected: z.object({
      at: z.string(),
      by: z.string(),
      reason: z.string()
    }).optional(),
    applied: z.object({
      at: z.string(),
      by: z.string(),
      changes: z.object({
        filesModified: z.array(z.string()),
        filesCreated: z.array(z.string()),
        filesDeleted: z.array(z.string())
      })
    }).optional(),
    rolledBack: z.object({
      at: z.string(),
      by: z.string(),
      reason: z.string()
    }).optional()
  }).optional().describe('Historique des actions'),
  executionLogs: z.array(z.string()).optional().describe('Logs d\'exécution'),
  rollbackPoint: z.object({
    available: z.boolean(),
    createdAt: z.string().optional(),
    filesBackup: z.array(z.string()).optional()
  }).optional().describe('Point de rollback')
});

export type GetDecisionDetailsResult = z.infer<typeof GetDecisionDetailsResultSchema>;

/**
 * Parse l'historique depuis le bloc de décision
 */
function parseDecisionHistory(blockContent: string): GetDecisionDetailsResult['history'] {
  const history: GetDecisionDetailsResult['history'] = {
    created: {
      at: '',
      by: ''
    }
  };
  
  // Parse created
  const createdMatch = blockContent.match(/\*\*Créé:\*\*\s*(.+)$/m);
  if (createdMatch) {
    history.created.at = createdMatch[1].trim();
  }
  
  const sourceMachineMatch = blockContent.match(/\*\*Machine Source:\*\*\s*(.+)$/m);
  if (sourceMachineMatch) {
    history.created.by = sourceMachineMatch[1].trim();
  }
  
  // Parse approved
  const approvedAtMatch = blockContent.match(/\*\*Approuvé le:\*\*\s*(.+)$/m);
  const approvedByMatch = blockContent.match(/\*\*Approuvé par:\*\*\s*(.+)$/m);
  if (approvedAtMatch && approvedByMatch) {
    history.approved = {
      at: approvedAtMatch[1].trim(),
      by: approvedByMatch[1].trim()
    };
    
    const commentMatch = blockContent.match(/\*\*Commentaire:\*\*\s*(.+)$/m);
    if (commentMatch) {
      history.approved.comment = commentMatch[1].trim();
    }
  }
  
  // Parse rejected
  const rejectedAtMatch = blockContent.match(/\*\*Rejeté le:\*\*\s*(.+)$/m);
  const rejectedByMatch = blockContent.match(/\*\*Rejeté par:\*\*\s*(.+)$/m);
  const reasonMatch = blockContent.match(/\*\*Motif:\*\*\s*(.+)$/m);
  if (rejectedAtMatch && rejectedByMatch && reasonMatch) {
    history.rejected = {
      at: rejectedAtMatch[1].trim(),
      by: rejectedByMatch[1].trim(),
      reason: reasonMatch[1].trim()
    };
  }
  
  // Parse applied
  const appliedAtMatch = blockContent.match(/\*\*Appliqué le:\*\*\s*(.+)$/m);
  const appliedByMatch = blockContent.match(/\*\*Appliqué par:\*\*\s*(.+)$/m);
  if (appliedAtMatch && appliedByMatch) {
    history.applied = {
      at: appliedAtMatch[1].trim(),
      by: appliedByMatch[1].trim(),
      changes: {
        filesModified: [],
        filesCreated: [],
        filesDeleted: []
      }
    };
  }
  
  // Parse rolled back
  const rollbackAtMatch = blockContent.match(/\*\*Rollback le:\*\*\s*(.+)$/m);
  const rollbackByMatch = blockContent.match(/\*\*Rollback par:\*\*\s*(.+)$/m);
  const rollbackReasonMatch = blockContent.match(/\*\*Raison:\*\*\s*(.+)$/m);
  if (rollbackAtMatch && rollbackByMatch && rollbackReasonMatch) {
    history.rolledBack = {
      at: rollbackAtMatch[1].trim(),
      by: rollbackByMatch[1].trim(),
      reason: rollbackReasonMatch[1].trim()
    };
  }
  
  return history;
}

/**
 * Outil roosync_get_decision_details
 * 
 * Récupère les détails complets d'une décision avec son historique.
 * 
 * @param args Arguments validés
 * @returns Détails de la décision
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncGetDecisionDetails(args: GetDecisionDetailsArgs): Promise<GetDecisionDetailsResult> {
  try {
    const service = getRooSyncService();
    const config = service.getConfig();
    
    // Options par défaut
    const includeHistory = args.includeHistory ?? true;
    const includeLogs = args.includeLogs ?? true;
    
    // Charger la décision
    const decision = await service.getDecision(args.decisionId);
    
    if (!decision) {
      throw new RooSyncServiceError(
        `Décision '${args.decisionId}' introuvable`,
        'DECISION_NOT_FOUND'
      );
    }
    
    // Construire l'objet décision
    const result: GetDecisionDetailsResult = {
      decision: {
        id: decision.id,
        title: decision.title,
        status: decision.status,
        type: decision.type,
        path: decision.path,
        sourceMachine: decision.sourceMachine,
        targetMachines: decision.targetMachines,
        created: decision.createdAt,
        description: decision.details,
        diff: decision.details
      }
    };
    
    // Ajouter l'historique si demandé
    if (includeHistory) {
      // Lire le fichier roadmap pour parser l'historique complet
      const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
      const content = readFileSync(roadmapPath, 'utf-8');
      
      const blockRegex = new RegExp(
        `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${args.decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
        'g'
      );
      
      const match = blockRegex.exec(content);
      if (match) {
        result.history = parseDecisionHistory(match[1]);
      }
    }
    
    // Ajouter les logs d'exécution si demandés (simulation pour l'instant)
    if (includeLogs && (decision.status === 'applied' || decision.status === 'rolled_back')) {
      result.executionLogs = [
        '[INFO] Logs d\'exécution disponibles après implémentation PowerShell',
        `[INFO] Statut: ${decision.status}`,
        `[INFO] Machine: ${config.machineId}`
      ];
    }
    
    // Ajouter info rollback si applicable
    if (decision.status === 'applied') {
      result.rollbackPoint = {
        available: true,
        createdAt: result.history?.applied?.at,
        filesBackup: decision.path ? [decision.path] : []
      };
    } else {
      result.rollbackPoint = {
        available: false
      };
    }
    
    return result;
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la récupération des détails: ${(error as Error).message}`,
      'ROOSYNC_GET_DETAILS_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const getDecisionDetailsToolMetadata = {
  name: 'roosync_get_decision_details',
  description: 'Obtenir les détails complets d\'une décision de synchronisation',
  inputSchema: GetDecisionDetailsArgsSchema,
  outputSchema: GetDecisionDetailsResultSchema
};