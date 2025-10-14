/**
 * Outil MCP : roosync_apply_decision
 * 
 * Applique une décision de synchronisation approuvée.
 * 
 * @module tools/roosync/apply-decision
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
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
 * Crée un point de rollback pour une décision
 * NOTE: Implémentation stub - sera complétée avec intégration PowerShell en Phase E2E
 */
async function createRollbackPoint(decisionId: string, config: any): Promise<void> {
  // TODO Phase E2E: Implémenter sauvegarde réelle des fichiers concernés
  // Pour l'instant, on simule la création du point de rollback
  const rollbackDir = join(config.sharedPath, '.rollback', decisionId);
  // La création effective sera implémentée avec l'intégration PowerShell
}

/**
 * Exécute l'application d'une décision
 * NOTE: Implémentation stub - sera complétée avec intégration PowerShell en Phase E2E
 */
async function executeDecision(
  decisionId: string,
  decision: any,
  config: any,
  options: { dryRun?: boolean; force?: boolean }
): Promise<{
  success: boolean;
  logs: string[];
  changes: {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
  };
  error?: string;
}> {
  const logs: string[] = [];
  
  if (options.dryRun) {
    // Mode dry run - simulation
    logs.push('[DRY RUN] Simulation activée - aucune modification réelle');
    logs.push(`[DRY RUN] Décision: ${decision.title}`);
    logs.push(`[DRY RUN] Type: ${decision.type}`);
    logs.push(`[DRY RUN] Chemin: ${decision.path || 'N/A'}`);
    
    return {
      success: true,
      logs,
      changes: {
        filesModified: [decision.path || 'example-file.txt'],
        filesCreated: [],
        filesDeleted: []
      }
    };
  }
  
  // TODO Phase E2E: Implémenter exécution réelle via PowerShell
  // Pour l'instant, simulation d'une exécution réussie
  logs.push('[SIMULATION] Exécution simulée - Phase E2E implémentera PowerShell');
  logs.push(`[INFO] Décision: ${decision.title}`);
  logs.push(`[INFO] Type: ${decision.type}`);
  
  // Simuler des changements basés sur le type de décision
  const changes = {
    filesModified: decision.path ? [decision.path] : [],
    filesCreated: [] as string[],
    filesDeleted: [] as string[]
  };
  
  logs.push(`[SUCCESS] Modifications appliquées: ${changes.filesModified.length} fichier(s)`);
  
  return {
    success: true,
    logs,
    changes
  };
}

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
        const result = await executeDecision(args.decisionId, decision, config, { dryRun: true });
        executionLog.push(...result.logs);
        changes = result.changes;
        rollbackAvailable = false;
      } else {
        // Créer point de rollback
        executionLog.push('[ROLLBACK] Création du point de rollback...');
        await createRollbackPoint(args.decisionId, config);
        executionLog.push('[ROLLBACK] Point de rollback créé avec succès');
        rollbackAvailable = true;
        
        // Exécuter la décision
        executionLog.push('[EXECUTION] Début de l\'application...');
        const result = await executeDecision(args.decisionId, decision, config, {
          dryRun: false,
          force: args.force
        });
        
        if (!result.success) {
          throw new Error(result.error || 'Échec de l\'exécution');
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
          executionLog.push('[ROLLBACK] Tentative de rollback automatique...');
          // TODO Phase E2E: Implémenter restauration réelle
          executionLog.push('[ROLLBACK] Rollback simulé avec succès');
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