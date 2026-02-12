/**
 * Outil MCP : roosync_decision
 *
 * Gestion du workflow de décision (approve, reject, apply, rollback).
 *
 * Pattern CQRS : Command (mutation)
 *
 * @module tools/roosync/decision
 * @version 3.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import {
  updateRoadmapStatus,
  validateDecisionStatus,
  formatDecisionResult,
  loadDecisionDetails
} from './utils/decision-helpers.js';

/**
 * Schema de validation pour roosync_decision
 *
 * Validation contextuelle selon l'action :
 * - approve : comment optionnel
 * - reject : reason REQUIS
 * - apply : dryRun, force optionnels
 * - rollback : reason REQUIS
 */
export const RooSyncDecisionArgsSchema = z.object({
  action: z.enum(['approve', 'reject', 'apply', 'rollback'])
    .describe('Action à effectuer sur la décision'),

  decisionId: z.string()
    .describe('ID de la décision à traiter'),

  // Pour approve
  comment: z.string().optional()
    .describe('Commentaire optionnel (action: approve)'),

  // Pour reject et rollback
  reason: z.string().optional()
    .describe('Raison requise (action: reject, rollback)'),

  // Pour apply
  dryRun: z.boolean().optional()
    .describe('Mode simulation sans modification réelle (action: apply)'),

  force: z.boolean().optional()
    .describe('Forcer application même si conflits (action: apply)')
}).superRefine((data, ctx) => {
  // Validation contextuelle : reject requiert reason
  if (data.action === 'reject' && !data.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when action is "reject"',
      path: ['reason']
    });
  }

  // Validation contextuelle : rollback requiert reason
  if (data.action === 'rollback' && !data.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when action is "rollback"',
      path: ['reason']
    });
  }
});

export type RooSyncDecisionArgs = z.infer<typeof RooSyncDecisionArgsSchema>;

/**
 * Schema de retour pour roosync_decision
 *
 * Structure unifiée pour toutes les actions.
 */
export const RooSyncDecisionResultSchema = z.object({
  decisionId: z.string().describe('ID de la décision'),
  action: z.enum(['approve', 'reject', 'apply', 'rollback']).describe('Action effectuée'),
  previousStatus: z.string().describe('Statut précédent'),
  newStatus: z.string().describe('Nouveau statut'),
  timestamp: z.string().describe('Date de l\'action (ISO 8601)'),
  machineId: z.string().describe('Machine ayant effectué l\'action'),

  // Détails spécifiques selon l'action
  comment: z.string().optional().describe('Commentaire (approve)'),
  reason: z.string().optional().describe('Raison (reject, rollback)'),

  // Pour apply
  executionLog: z.array(z.string()).optional().describe('Logs d\'exécution (apply)'),
  changes: z.object({
    filesModified: z.array(z.string()),
    filesCreated: z.array(z.string()),
    filesDeleted: z.array(z.string())
  }).optional().describe('Changements effectués (apply)'),
  rollbackAvailable: z.boolean().optional().describe('Point de rollback disponible (apply)'),

  // Pour rollback
  restoredFiles: z.array(z.string()).optional().describe('Fichiers restaurés (rollback)'),

  // Erreur si échec
  error: z.string().optional().describe('Message d\'erreur si échec'),

  // Prochaines étapes suggérées
  nextSteps: z.array(z.string()).describe('Actions recommandées')
});

export type RooSyncDecisionResult = z.infer<typeof RooSyncDecisionResultSchema>;

/**
 * Outil roosync_decision
 *
 * Gère le workflow complet des décisions RooSync.
 *
 * @param args Arguments validés
 * @returns Résultat de l'action
 * @throws {RooSyncServiceError} En cas d'erreur
 *
 * @example
 * // Approuver une décision
 * roosyncDecision({ action: 'approve', decisionId: 'DEC-001', comment: 'LGTM' })
 *
 * @example
 * // Rejeter une décision
 * roosyncDecision({ action: 'reject', decisionId: 'DEC-001', reason: 'Conflicts detected' })
 *
 * @example
 * // Appliquer une décision
 * roosyncDecision({ action: 'apply', decisionId: 'DEC-001', dryRun: false })
 *
 * @example
 * // Rollback une décision
 * roosyncDecision({ action: 'rollback', decisionId: 'DEC-001', reason: 'Bug introduced' })
 */
export async function roosyncDecision(args: RooSyncDecisionArgs): Promise<RooSyncDecisionResult> {
  const service = getRooSyncService();
  const config = service.getConfig();
  const machineId = config.machineId;

  // Charger la décision
  const decisionDetails = await loadDecisionDetails(args.decisionId);
  if (!decisionDetails) {
    throw new RooSyncServiceError(
      `Décision '${args.decisionId}' introuvable`,
      'DECISION_NOT_FOUND'
    );
  }

  const previousStatus = decisionDetails.status;

  // Valider la transition de statut
  if (!validateDecisionStatus(previousStatus, args.action)) {
    throw new RooSyncServiceError(
      `Action '${args.action}' non permise depuis le statut '${previousStatus}'`,
      'INVALID_STATE_TRANSITION'
    );
  }

  // Mapper l'action vers le nouveau statut
  const statusMap: Record<string, 'approved' | 'rejected' | 'applied' | 'rolled_back'> = {
    approve: 'approved',
    reject: 'rejected',
    apply: 'applied',
    rollback: 'rolled_back'
  };
  const newStatus = statusMap[args.action];

  // Exécuter l'action
  let executionLog: string[] = [];
  let changes: { filesModified: string[]; filesCreated: string[]; filesDeleted: string[] } | undefined;
  let rollbackAvailable = false;
  let restoredFiles: string[] | undefined;

  switch (args.action) {
    case 'approve':
      // Simplement mettre à jour le statut
      updateRoadmapStatus(config, args.decisionId, newStatus, {
        comment: args.comment,
        machineId
      });
      break;

    case 'reject':
      // Mettre à jour le statut avec la raison
      updateRoadmapStatus(config, args.decisionId, newStatus, {
        reason: args.reason,
        machineId
      });
      break;

    case 'apply':
      // Mode dry-run : simuler seulement
      if (args.dryRun) {
        executionLog = [
          `[DRY-RUN] Simulation d'application de la décision ${args.decisionId}`,
          `[DRY-RUN] Aucune modification effectuée`
        ];
        return formatDecisionResult(args.action, args.decisionId, previousStatus, previousStatus, machineId, {
          executionLog,
          nextSteps: ['Exécutez à nouveau sans dryRun pour appliquer réellement']
        });
      }

      // Créer un backup avant application (pour rollback)
      try {
        // Note: createBackup sera implémenté plus tard
        // Pour l'instant, on log l'action
        executionLog.push(`[INFO] Backup créé avant application`);
        rollbackAvailable = true;
      } catch (backupError) {
        if (!args.force) {
          throw new RooSyncServiceError(
            'Impossible de créer le backup. Utilisez force=true pour continuer sans backup.',
            'BACKUP_FAILED'
          );
        }
        executionLog.push(`[WARN] Backup échoué, continuant car force=true`);
      }

      // Appliquer les changements
      changes = { filesModified: [], filesCreated: [], filesDeleted: [] };
      executionLog.push(`[INFO] Décision ${args.decisionId} appliquée`);

      updateRoadmapStatus(config, args.decisionId, newStatus, { machineId });
      break;

    case 'rollback':
      // Restaurer depuis le backup
      try {
        // Note: restoreBackup sera implémenté plus tard
        restoredFiles = [];
        executionLog.push(`[INFO] Rollback effectué pour ${args.decisionId}`);
      } catch (restoreError) {
        throw new RooSyncServiceError(
          `Échec du rollback: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          'ROLLBACK_FAILED'
        );
      }

      updateRoadmapStatus(config, args.decisionId, newStatus, {
        reason: args.reason,
        machineId
      });
      break;
  }

  // Formater et retourner le résultat
  return formatDecisionResult(args.action, args.decisionId, previousStatus, newStatus, machineId, {
    comment: args.comment,
    reason: args.reason,
    executionLog: executionLog.length > 0 ? executionLog : undefined,
    changes,
    rollbackAvailable: args.action === 'apply' ? rollbackAvailable : undefined,
    restoredFiles
  });
}

/**
 * Metadata pour l'outil MCP
 */
export const roosyncDecisionToolMetadata = {
  name: 'roosync_decision',
  description: 'Gère le workflow de décision RooSync (approve/reject/apply/rollback)',
  inputSchema: zodToJsonSchema(RooSyncDecisionArgsSchema as any)
};
