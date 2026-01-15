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
import { writeFileSync, readFileSync, existsSync } from 'fs';
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
  const startTime = Date.now();
  const executionLog: string[] = [];

  try {
    executionLog.push(`[ROLLBACK_DECISION] Début du rollback pour décision ${args.decisionId}`);
    executionLog.push(`[ROLLBACK_DECISION] Raison: ${args.reason}`);

    const service = getRooSyncService();
    const config = service.getConfig();

    executionLog.push(`[ROLLBACK_DECISION] Machine: ${config.machineId}`);
    executionLog.push(`[ROLLBACK_DECISION] Shared path: ${config.sharedPath}`);

    // Charger la décision
    executionLog.push(`[ROLLBACK_DECISION] Chargement de la décision...`);
    const decision = await service.getDecision(args.decisionId);

    if (!decision) {
      executionLog.push(`[ROLLBACK_DECISION] ❌ Décision '${args.decisionId}' introuvable`);
      throw new RooSyncServiceError(
        `Décision '${args.decisionId}' introuvable`,
        'DECISION_NOT_FOUND'
      );
    }

    executionLog.push(`[ROLLBACK_DECISION] ✅ Décision trouvée, statut actuel: ${decision.status}`);

    // Vérifier le statut
    if (decision.status !== 'applied') {
      executionLog.push(`[ROLLBACK_DECISION] ❌ Décision pas encore appliquée (statut: ${decision.status})`);
      throw new RooSyncServiceError(
        `Décision pas encore appliquée (statut: ${decision.status})`,
        'DECISION_NOT_APPLIED'
      );
    }

    const now = new Date().toISOString();
    let restoredFiles: string[] = [];

    try {
      // ✅ Connected to RooSyncService real methods
      // Restaurer depuis le point de rollback
      executionLog.push(`[ROLLBACK_DECISION] Début de la restauration depuis le point de rollback...`);
      const result = await service.restoreFromRollbackPoint(args.decisionId);

      if (!result.success) {
        executionLog.push(`[ROLLBACK_DECISION] ❌ Échec de la restauration: ${result.error}`);
        throw new RooSyncServiceError(
          `Échec de la restauration: ${result.error || 'Erreur inconnue'}`,
          'ROLLBACK_FAILED'
        );
      }

      executionLog.push(`[ROLLBACK_DECISION] ✅ Restauration réussie`);
      executionLog.push(...result.logs);
      restoredFiles = result.restoredFiles;
      executionLog.push(`[ROLLBACK_DECISION] Fichiers restaurés: ${restoredFiles.length}`);
    } catch (rollbackError) {
      const errorMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const errorStack = rollbackError instanceof Error ? rollbackError.stack : undefined;

      executionLog.push(`[ROLLBACK_DECISION] ❌ Erreur lors de la restauration: ${errorMsg}`);
      if (errorStack) {
        executionLog.push(`[ROLLBACK_DECISION] Stack trace: ${errorStack}`);
      }

      throw new RooSyncServiceError(
        `Échec du rollback: ${errorMsg}`,
        'ROLLBACK_FAILED'
      );
    }

    // Mettre à jour la décision dans sync-roadmap.md
    executionLog.push(`[ROLLBACK_DECISION] Mise à jour de sync-roadmap.md...`);
    const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');

    // Vérifier que le fichier existe
    if (!existsSync(roadmapPath)) {
      executionLog.push(`[ROLLBACK_DECISION] ❌ Fichier sync-roadmap.md introuvable: ${roadmapPath}`);
      throw new RooSyncServiceError(
        `Fichier sync-roadmap.md introuvable: ${roadmapPath}`,
        'ROOSYNC_FILE_ERROR'
      );
    }

    let content = readFileSync(roadmapPath, 'utf-8');

    const blockRegex = new RegExp(
      `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${args.decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
      'g'
    );

    const match = blockRegex.exec(content);
    if (!match) {
      executionLog.push(`[ROLLBACK_DECISION] ❌ Bloc de décision '${args.decisionId}' introuvable dans sync-roadmap.md`);
      throw new RooSyncServiceError(
        `Bloc de décision '${args.decisionId}' introuvable dans sync-roadmap.md`,
        'ROOSYNC_FILE_ERROR'
      );
    }

    executionLog.push(`[ROLLBACK_DECISION] ✅ Bloc de décision trouvé`);

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

    // Écrire le fichier mis à jour
    writeFileSync(roadmapPath, content, 'utf-8');
    executionLog.push(`[ROLLBACK_DECISION] ✅ sync-roadmap.md mis à jour`);

    // Vider le cache pour forcer le rechargement
    try {
      service.clearCache();
      executionLog.push(`[ROLLBACK_DECISION] ✅ Cache invalidé`);
    } catch (cacheError) {
      executionLog.push(`[ROLLBACK_DECISION] ⚠️ Erreur invalidation cache: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
    }

    const duration = Date.now() - startTime;
    executionLog.push(`[ROLLBACK_DECISION] ✅ Rollback terminé avec succès en ${duration}ms`);

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
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    executionLog.push(`[ROLLBACK_DECISION] ❌ Erreur critique: ${errorMsg}`);
    if (errorStack) {
      executionLog.push(`[ROLLBACK_DECISION] Stack trace: ${errorStack}`);
    }

    if (error instanceof RooSyncServiceError) {
      throw error;
    }

    throw new RooSyncServiceError(
      `Erreur lors du rollback: ${errorMsg}`,
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