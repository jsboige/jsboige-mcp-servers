/**
 * Outil MCP : roosync_decision_info (CONS-5)
 *
 * Outil consolidé pour la consultation des décisions (read-only).
 * Remplace : get_decision_details
 *
 * Pattern CQRS : Query (lecture seule)
 *
 * @module tools/roosync/decision-info
 * @version 3.0.0 (CONS-5)
 * @status SKELETON - En attente CONS-1 stabilisation
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { parseRoadmapMarkdown, findDecisionById } from '../../utils/roosync-parsers.js';
import { join } from 'path';

/**
 * Schema de validation pour roosync_decision_info
 */
export const RooSyncDecisionInfoArgsSchema = z.object({
  decisionId: z.string()
    .describe('ID de la décision à consulter'),

  includeHistory: z.boolean().optional().default(true)
    .describe('Inclure l\'historique complet des actions (défaut: true)'),

  includeLogs: z.boolean().optional().default(true)
    .describe('Inclure les logs d\'exécution (défaut: true)')
});

export type RooSyncDecisionInfoArgs = z.infer<typeof RooSyncDecisionInfoArgsSchema>;

/**
 * Schema de retour pour roosync_decision_info
 */
export const RooSyncDecisionInfoResultSchema = z.object({
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
  }).optional().describe('Informations sur le point de rollback')
});

export type RooSyncDecisionInfoResult = z.infer<typeof RooSyncDecisionInfoResultSchema>;

/**
 * Outil roosync_decision_info
 *
 * Consulte les détails complets d'une décision (read-only).
 *
 * @param args Arguments validés
 * @returns Détails de la décision
 * @throws {RooSyncServiceError} En cas d'erreur
 *
 * @example
 * // Détails complets
 * roosyncDecisionInfo({ decisionId: 'DEC-001' })
 *
 * @example
 * // Détails minimaux (sans historique ni logs)
 * roosyncDecisionInfo({
 *   decisionId: 'DEC-001',
 *   includeHistory: false,
 *   includeLogs: false
 * })
 */
export async function roosyncDecisionInfo(
  args: RooSyncDecisionInfoArgs
): Promise<RooSyncDecisionInfoResult> {
  const service = getRooSyncService();
  const config = service.getConfig();

  // Charger les détails de la décision
  const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
  const decisions = parseRoadmapMarkdown(roadmapPath);
  const decision = findDecisionById(decisions, args.decisionId);

  if (!decision) {
    throw new RooSyncServiceError(
      `Décision '${args.decisionId}' introuvable`,
      'DECISION_NOT_FOUND'
    );
  }

  // Cast pour accéder aux propriétés dynamiques (parsées depuis le markdown)
  const decisionData = decision as any;

  // Construire l'objet décision
  const decisionObj = {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    type: decision.type || 'config',
    path: decision.path,
    sourceMachine: decision.sourceMachine || config.machineId,
    targetMachines: decision.targetMachines || [],
    created: decision.createdAt || new Date().toISOString(),
    description: decisionData.details,
    diff: decisionData.diff
  };

  // Construire l'historique si demandé
  let history: RooSyncDecisionInfoResult['history'];
  if (args.includeHistory !== false) {
    history = {
      created: {
        at: decision.createdAt || new Date().toISOString(),
        by: decision.createdBy || decision.sourceMachine || 'unknown'
      }
    };

    // Ajouter les événements selon le statut (propriétés dynamiques)
    if (decision.status === 'approved' && decisionData.approvedAt) {
      history.approved = {
        at: decisionData.approvedAt,
        by: decisionData.approvedBy || 'unknown',
        comment: decisionData.approvalComment
      };
    }

    if (decision.status === 'rejected' && decisionData.rejectedAt) {
      history.rejected = {
        at: decisionData.rejectedAt,
        by: decisionData.rejectedBy || 'unknown',
        reason: decisionData.rejectionReason || 'No reason provided'
      };
    }

    if (decision.status === 'applied' && decisionData.appliedAt) {
      history.applied = {
        at: decisionData.appliedAt,
        by: decisionData.appliedBy || 'unknown',
        changes: {
          filesModified: decisionData.filesModified || [],
          filesCreated: decisionData.filesCreated || [],
          filesDeleted: decisionData.filesDeleted || []
        }
      };
    }

    if (decision.status === 'rolled_back' && decisionData.rolledBackAt) {
      history.rolledBack = {
        at: decisionData.rolledBackAt,
        by: decisionData.rolledBackBy || 'unknown',
        reason: decisionData.rollbackReason || 'No reason provided'
      };
    }
  }

  // Logs d'exécution si demandés
  let executionLogs: string[] | undefined;
  if (args.includeLogs !== false && decisionData.executionLogs) {
    executionLogs = decisionData.executionLogs;
  }

  // Informations rollback
  const rollbackPoint = {
    available: decision.status === 'applied' && !!decisionData.backupPath,
    createdAt: decisionData.backupCreatedAt,
    filesBackup: decisionData.backupFiles
  };

  return {
    decision: decisionObj,
    history,
    executionLogs,
    rollbackPoint
  };
}

/**
 * Metadata pour l'outil MCP
 */
export const roosyncDecisionInfoToolMetadata = {
  name: 'roosync_decision_info',
  description: 'Consulte les détails d\'une décision RooSync (read-only)',
  inputSchema: zodToJsonSchema(RooSyncDecisionInfoArgsSchema as any)
};
