/**
 * Outil MCP : roosync_decision (CONS-5)
 *
 * Outil consolidé pour la gestion du workflow de décision.
 * Fusionne : approve_decision, reject_decision, apply_decision, rollback_decision
 *
 * Pattern CQRS : Command (mutation)
 *
 * @module tools/roosync/decision
 * @version 3.0.0 (CONS-5)
 * @status SKELETON - En attente CONS-1 stabilisation
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

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
  // TODO: Implémenter après CONS-1 stabilisé
  throw new RooSyncServiceError(
    'CONS-5 not yet implemented - waiting for CONS-1 stabilization',
    'NOT_IMPLEMENTED'
  );
}

/**
 * Metadata pour l'outil MCP
 */
export const roosyncDecisionToolMetadata = {
  name: 'roosync_decision',
  description: 'Gère le workflow de décision RooSync (approve/reject/apply/rollback)',
  inputSchema: zodToJsonSchema(RooSyncDecisionArgsSchema as any)
};
