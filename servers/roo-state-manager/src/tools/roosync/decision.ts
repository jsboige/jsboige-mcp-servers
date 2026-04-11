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

import { z, ZodError } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { join } from 'path';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import {
  updateRoadmapStatus,
  validateDecisionStatus,
  formatDecisionResult,
  loadDecisionDetails,
  moveDecisionFile,
  createBackup,
  restoreBackup
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
  success: z.boolean().describe('Indique si l\'action a réussi'),
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
  try {
    // Validation explicite du schéma (requis pour les tests qui bypassent le MCP SDK)
    // Les erreurs de validation de schéma sont lancées comme exceptions (paramètres invalides)
    // Utilisation de parse() au lieu de safeParse() pour que les erreurs .superRefine() soient lancées
    RooSyncDecisionArgsSchema.parse(args);

    const service = await getRooSyncService();
    const config = service.getConfig();
    const machineId = config.machineId;

    // Charger la décision
    const decisionDetails = await loadDecisionDetails(args.decisionId);
    if (!decisionDetails) {
      return {
        success: false,
        decisionId: args.decisionId,
        action: args.action,
        previousStatus: '',
        newStatus: '',
        timestamp: new Date().toISOString(),
        machineId,
        error: `Décision '${args.decisionId}' introuvable`,
        nextSteps: ['Vérifiez que la décision existe']
      };
    }

    const previousStatus = decisionDetails.status;

    // Valider la transition de statut
    if (!validateDecisionStatus(previousStatus, args.action)) {
      return {
        success: false,
        decisionId: args.decisionId,
        action: args.action,
        previousStatus,
        newStatus: previousStatus,
        timestamp: new Date().toISOString(),
        machineId,
        error: `Action '${args.action}' non permise depuis le statut '${previousStatus}'`,
        nextSteps: ['Vérifiez le statut actuel de la décision']
      };
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
        // Mettre à jour le statut
        updateRoadmapStatus(config, args.decisionId, newStatus, {
          comment: args.comment,
          machineId
        });

        // Déplacer le fichier JSON vers le nouveau répertoire de statut
        moveDecisionFile(config.sharedPath, args.decisionId, previousStatus as any, newStatus);
        break;

      case 'reject':
        // Mettre à jour le statut avec la raison
        updateRoadmapStatus(config, args.decisionId, newStatus, {
          reason: args.reason,
          machineId
        });

        // Déplacer le fichier JSON
        moveDecisionFile(config.sharedPath, args.decisionId, previousStatus as any, newStatus);
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

      // #1268: Real backup before applying decision (replaces stub)
      // Backup the decision JSON file and sync-roadmap.md
      try {
        const decisionJsonPath = join(config.sharedPath, 'decisions', previousStatus, `${args.decisionId}.json`);
        const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
        const filesToBackup: string[] = [];

        // Only backup files that exist
        const { existsSync } = await import('fs');
        if (existsSync(decisionJsonPath)) filesToBackup.push(decisionJsonPath);
        if (existsSync(roadmapPath)) filesToBackup.push(roadmapPath);

        if (filesToBackup.length > 0) {
          const backupDir = join(config.sharedPath, 'decisions', 'backups');
          const backupInfo = createBackup(filesToBackup, backupDir);
          executionLog.push(`[INFO] Backup créé: ${backupInfo.files.length} fichier(s) dans ${backupInfo.backupDir}`);
          rollbackAvailable = true;

          // Persist backup metadata for rollback
          const { writeFileSync: writeMeta } = await import('fs');
          const metaPath = join(config.sharedPath, 'decisions', 'backups', `${args.decisionId}-meta.json`);
          writeMeta(metaPath, JSON.stringify(backupInfo, null, 2));
        } else {
          executionLog.push(`[INFO] Aucun fichier à sauvegarder (décision déjà déplacée ou roadmap absent)`);
          rollbackAvailable = false;
        }
      } catch (backupError) {
        if (!args.force) {
          return {
            success: false,
            decisionId: args.decisionId,
            action: args.action,
            previousStatus,
            newStatus: previousStatus,
            timestamp: new Date().toISOString(),
            machineId,
            error: `Impossible de créer le backup: ${backupError instanceof Error ? backupError.message : String(backupError)}. Utilisez force=true pour continuer sans backup.`,
            nextSteps: ['Utilisez force=true pour continuer sans backup']
          };
        }
        executionLog.push(`[WARN] Backup échoué, continuant car force=true`);
      }

      // Appliquer les changements
      changes = { filesModified: [], filesCreated: [], filesDeleted: [] };
      executionLog.push(`[INFO] Décision ${args.decisionId} appliquée`);

      updateRoadmapStatus(config, args.decisionId, newStatus, { machineId });

      // Déplacer le fichier JSON
      moveDecisionFile(config.sharedPath, args.decisionId, previousStatus as any, newStatus);
      break;

    case 'rollback':
      // #1268: Real rollback using stored backup (replaces stub)
      try {
        const { existsSync: existsMeta, readFileSync: readMeta } = await import('fs');
        const metaPath = join(config.sharedPath, 'decisions', 'backups', `${args.decisionId}-meta.json`);

        if (existsMeta(metaPath)) {
          const backupInfo = JSON.parse(readMeta(metaPath, 'utf-8'));
          restoredFiles = restoreBackup(backupInfo, config.sharedPath);
          executionLog.push(`[INFO] Rollback effectué: ${restoredFiles.length} fichier(s) restauré(s) pour ${args.decisionId}`);
        } else {
          // No backup found — cannot restore files but can still update status
          restoredFiles = [];
          executionLog.push(`[WARN] Aucun backup trouvé pour ${args.decisionId}. Restauration des fichiers impossible, mise à jour statut uniquement.`);
        }
      } catch (restoreError) {
        const errorMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        return {
          success: false,
          decisionId: args.decisionId,
          action: args.action,
          previousStatus,
          newStatus: previousStatus,
          timestamp: new Date().toISOString(),
          machineId,
          error: `Échec du rollback: ${errorMessage}`,
          nextSteps: ['Vérifiez les logs et réessayez']
        };
      }

      updateRoadmapStatus(config, args.decisionId, newStatus, {
        reason: args.reason,
        machineId
      });

      // Déplacer le fichier JSON
      moveDecisionFile(config.sharedPath, args.decisionId, previousStatus as any, newStatus);
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
  } catch (error) {
    // Zod validation errors for 'action' parameter are handled gracefully (legacy behavior)
    // All other Zod errors are thrown (parameter validation tests expect this)
    if (error instanceof ZodError) {
      const isActionError = error.issues.some(issue =>
        issue.path.length === 1 && issue.path[0] === 'action'
      );
      if (!isActionError) {
        throw error;
      }
      // For action errors, return success: false (graceful handling)
    }

    // Other errors are caught and returned with success: false
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      decisionId: args.decisionId || '',
      action: args.action,
      previousStatus: '',
      newStatus: '',
      timestamp: new Date().toISOString(),
      machineId: 'unknown',
      error: errorMessage,
      nextSteps: ['Vérifiez les logs pour plus de détails']
    };
  }
}

/**
 * Metadata pour l'outil MCP
 */
export const roosyncDecisionToolMetadata = {
  name: 'roosync_decision',
  description: 'Gère le workflow de décision RooSync (approve/reject/apply/rollback)',
  inputSchema: zodToJsonSchema(RooSyncDecisionArgsSchema as any)
};
