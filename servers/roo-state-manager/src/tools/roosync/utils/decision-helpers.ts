/**
 * Helpers partagés pour les outils de décision (CONS-5)
 *
 * Centralise le code dupliqué des 5 anciens outils de décision.
 *
 * @module tools/roosync/utils/decision-helpers
 * @version 3.0.0 (CONS-5)
 * @status SKELETON - En attente CONS-1 stabilisation
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RooSyncConfig } from '../../../config/roosync-config.js';
import { parseRoadmapMarkdown, findDecisionById, type RooSyncDecision } from '../../../utils/roosync-parsers.js';

/**
 * Met à jour le statut d'une décision dans sync-roadmap.md
 *
 * Cette fonction centralise la logique de mise à jour du roadmap
 * qui était dupliquée dans approve_decision, reject_decision,
 * apply_decision, et rollback_decision.
 *
 * @param config Configuration RooSync
 * @param decisionId ID de la décision
 * @param newStatus Nouveau statut
 * @param additionalInfo Informations additionnelles (commentaire, raison, etc.)
 * @returns true si mise à jour réussie
 *
 * @example
 * updateRoadmapStatus(config, 'DEC-001', 'approved', { comment: 'LGTM' })
 *
 * @example
 * updateRoadmapStatus(config, 'DEC-001', 'rejected', { reason: 'Conflicts' })
 */
export function updateRoadmapStatus(
  config: RooSyncConfig,
  decisionId: string,
  newStatus: 'approved' | 'rejected' | 'applied' | 'rolled_back',
  additionalInfo?: {
    comment?: string;
    reason?: string;
    timestamp?: string;
    machineId?: string;
  }
): boolean {
  try {
    const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
    let content = readFileSync(roadmapPath, 'utf-8');

    // Trouver et remplacer le bloc de décision
    const blockRegex = new RegExp(
      `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
      'g'
    );

    const match = blockRegex.exec(content);
    if (!match) {
      throw new Error(`Bloc de décision '${decisionId}' introuvable dans sync-roadmap.md`);
    }

    // Construire le bloc mis à jour
    const now = additionalInfo?.timestamp || new Date().toISOString();
    const machineId = additionalInfo?.machineId || config.machineId;
    let updatedBlock = match[1];

    // Remplacer le statut
    updatedBlock = updatedBlock.replace(
      /\*\*Statut:\*\*\s*.+$/m,
      `**Statut:** ${newStatus}`
    );

    // Ajouter les métadonnées selon le statut
    let metadata = '';
    if (newStatus === 'approved') {
      metadata = `\n**Approuvé le:** ${now}\n**Approuvé par:** ${machineId}`;
    } else if (newStatus === 'rejected') {
      metadata = `\n**Rejeté le:** ${now}\n**Rejeté par:** ${machineId}`;
    } else if (newStatus === 'applied') {
      metadata = `\n**Appliqué le:** ${now}\n**Appliqué par:** ${machineId}`;
    } else if (newStatus === 'rolled_back') {
      metadata = `\n**Annulé le:** ${now}\n**Annulé par:** ${machineId}`;
    }

    // Ajouter commentaire ou raison si fourni
    if (additionalInfo?.comment) {
      metadata += `\n**Commentaire:** ${additionalInfo.comment}`;
    } else if (additionalInfo?.reason) {
      metadata += `\n**Raison:** ${additionalInfo.reason}`;
    }

    updatedBlock += metadata;

    // Remplacer dans le contenu
    content = content.replace(
      match[0],
      `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
    );

    // Sauvegarder
    writeFileSync(roadmapPath, content, 'utf-8');

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Erreur lors de la mise à jour du statut: ${errorMessage}`);
    return false;
  }
}

/**
 * Valide qu'une décision est dans le bon statut pour une action donnée
 *
 * @param currentStatus Statut actuel de la décision
 * @param action Action à effectuer
 * @returns true si valide, false sinon
 *
 * @example
 * validateDecisionStatus('pending', 'approve') // true
 * validateDecisionStatus('approved', 'approve') // false (déjà approuvée)
 * validateDecisionStatus('approved', 'apply') // true
 */
export function validateDecisionStatus(
  currentStatus: string,
  action: 'approve' | 'reject' | 'apply' | 'rollback'
): boolean {
  const validTransitions: Record<string, string[]> = {
    approve: ['pending'],
    reject: ['pending'],
    apply: ['approved'],
    rollback: ['applied']
  };

  return validTransitions[action]?.includes(currentStatus) ?? false;
}

/**
 * Formate le résultat d'une action de décision de manière uniforme
 *
 * @param action Action effectuée
 * @param decisionId ID de la décision
 * @param previousStatus Statut précédent
 * @param newStatus Nouveau statut
 * @param machineId Machine ayant effectué l'action
 * @param additionalData Données additionnelles selon l'action
 * @returns Résultat formaté
 */
export function formatDecisionResult(
  action: 'approve' | 'reject' | 'apply' | 'rollback',
  decisionId: string,
  previousStatus: string,
  newStatus: string,
  machineId: string,
  additionalData?: Record<string, any>
): any {
  const baseResult = {
    decisionId,
    action,
    previousStatus,
    newStatus,
    timestamp: new Date().toISOString(),
    machineId,
    nextSteps: generateNextStepsByStatus(action, newStatus)
  };

  return { ...baseResult, ...additionalData };
}

/**
 * Génère les prochaines étapes suggérées selon l'action et le statut
 *
 * @param action Action effectuée
 * @param newStatus Nouveau statut
 * @returns Liste des prochaines étapes recommandées
 */
function generateNextStepsByStatus(
  action: 'approve' | 'reject' | 'apply' | 'rollback',
  newStatus: string
): string[] {
  const stepsMap: Record<string, string[]> = {
    approved: [
      'Utilisez roosync_decision avec action=apply pour appliquer cette décision',
      'Vérifiez les conflits potentiels avec roosync_decision_info',
      'Utilisez dryRun=true pour simuler l\'application'
    ],
    rejected: [
      'La décision a été rejetée et ne peut plus être modifiée',
      'Créez une nouvelle décision si nécessaire'
    ],
    applied: [
      'La décision a été appliquée avec succès',
      'Utilisez roosync_decision_info pour voir les changements',
      'Un point de rollback est disponible si nécessaire'
    ],
    rolled_back: [
      'La décision a été annulée',
      'Les fichiers ont été restaurés à leur état précédent',
      'Créez une nouvelle décision si nécessaire'
    ]
  };

  return stepsMap[newStatus] ?? ['Consultez roosync_decision_info pour plus de détails'];
}

/**
 * Met à jour le statut d'une décision dans sync-roadmap.md (version async)
 *
 * @param decisionId ID de la décision
 * @param status Nouveau statut
 * @param machineId ID de la machine effectuant la modification
 * @returns Promise<void>
 */
export async function updateRoadmapStatusAsync(
  decisionId: string,
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'rolled_back',
  machineId: string
): Promise<void> {
  try {
    const roadmapPath = join(process.cwd(), 'sync-roadmap.md');
    let content = readFileSync(roadmapPath, 'utf-8');

    // Trouver et remplacer le bloc de décision
    const blockRegex = new RegExp(
      `<!-- DECISION_BLOCK_START -->([\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
      'g'
    );

    const match = blockRegex.exec(content);
    if (!match) {
      throw new Error(`Bloc de décision '${decisionId}' introuvable dans sync-roadmap.md`);
    }

    // Construire le bloc mis à jour
    const now = new Date().toISOString();
    let updatedBlock = match[1];

    // Remplacer le statut
    updatedBlock = updatedBlock.replace(
      /\*\*Statut:\*\*\s*.+$/m,
      `**Statut:** ${status}`
    );

    // Ajouter les métadonnées selon le statut
    let metadata = '';
    if (status === 'approved') {
      metadata = `\n**Approuvé le:** ${now}\n**Approuvé par:** ${machineId}`;
    } else if (status === 'rejected') {
      metadata = `\n**Rejeté le:** ${now}\n**Rejeté par:** ${machineId}`;
    } else if (status === 'applied') {
      metadata = `\n**Appliqué le:** ${now}\n**Appliqué par:** ${machineId}`;
    } else if (status === 'rolled_back') {
      metadata = `\n**Annulé le:** ${now}\n**Annulé par:** ${machineId}`;
    }

    updatedBlock += metadata;

    // Remplacer dans le contenu
    content = content.replace(
      match[0],
      `<!-- DECISION_BLOCK_START -->${updatedBlock}\n<!-- DECISION_BLOCK_END -->`
    );

    // Sauvegarder
    writeFileSync(roadmapPath, content, 'utf-8');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Erreur lors de la mise à jour du statut: ${errorMessage}`);
  }
}

/**
 * Charge les détails d'une décision depuis sync-roadmap.md
 *
 * @param decisionId ID de la décision
 * @returns Promise<{ title: string; description: string; status: string; history: any[] } | null>
 */
export async function loadDecisionDetails(
  decisionId: string
): Promise<{ title: string; description: string; status: string; history: any[] } | null> {
  try {
    const roadmapPath = join(process.cwd(), 'sync-roadmap.md');
    const decisions = parseRoadmapMarkdown(roadmapPath);
    const decision = findDecisionById(decisions, decisionId);

    if (!decision) {
      return null;
    }

    // Construire l'historique à partir des métadonnées
    const history: any[] = [];
    history.push({
      event: 'created',
      timestamp: decision.createdAt,
      machineId: decision.createdBy || decision.sourceMachine
    });

    // Ajouter les événements de statut si présents
    if (decision.updatedAt) {
      history.push({
        event: 'updated',
        timestamp: decision.updatedAt
      });
    }

    return {
      title: decision.title,
      description: decision.details || '',
      status: decision.status,
      history
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Erreur lors du chargement des détails de la décision: ${errorMessage}`);
    return null;
  }
}

/**
 * Génère les prochaines étapes selon l'action
 *
 * @param action Action effectuée
 * @returns string[] Liste des prochaines étapes
 */
export function generateNextSteps(
  action: 'approve' | 'reject' | 'apply' | 'rollback'
): string[] {
  const stepsMap: Record<string, string[]> = {
    approve: [
      'Prêt pour application avec roosync_decision(action=\'apply\')'
    ],
    reject: [
      'Décision rejetée, créer nouvelle proposition si nécessaire'
    ],
    apply: [
      'Configuration appliquée, valider le fonctionnement'
    ],
    rollback: [
      'Rollback effectué, vérifier l\'état'
    ]
  };

  return stepsMap[action] ?? ['Consultez roosync_decision_info pour plus de détails'];
}

/**
 * Crée un backup des fichiers avant application (pour rollback)
 *
 * @param files Liste des fichiers à sauvegarder
 * @param backupPath Chemin du répertoire de backup
 * @returns Informations sur le backup créé
 */
export function createBackup(
  files: string[],
  backupPath: string
): { timestamp: string; files: string[]; backupDir: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(backupPath, `backup-${timestamp}`);

  try {
    // Créer le répertoire de backup s'il n'existe pas
    const { mkdirSync, copyFileSync, existsSync } = require('fs');
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    const backedUpFiles: string[] = [];

    for (const file of files) {
      if (existsSync(file)) {
        const fileName = file.replace(/[/\\]/g, '_');
        const backupFilePath = join(backupDir, fileName);
        copyFileSync(file, backupFilePath);
        backedUpFiles.push(file);
      }
    }

    return {
      timestamp,
      files: backedUpFiles,
      backupDir
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Échec de la création du backup: ${errorMessage}`);
  }
}

/**
 * Restaure les fichiers depuis un backup (pour rollback)
 *
 * @param backupInfo Informations sur le backup à restaurer
 * @param targetPath Chemin de destination (non utilisé, les fichiers sont restaurés à leur emplacement original)
 * @returns Liste des fichiers restaurés
 */
export function restoreBackup(
  backupInfo: { timestamp: string; files: string[]; backupDir?: string },
  targetPath: string
): string[] {
  try {
    const { copyFileSync, existsSync, readdirSync } = require('fs');

    if (!backupInfo.backupDir || !existsSync(backupInfo.backupDir)) {
      throw new Error('Répertoire de backup introuvable');
    }

    const restoredFiles: string[] = [];
    const backupFiles = readdirSync(backupInfo.backupDir);

    for (const backupFile of backupFiles) {
      // Reconstituer le chemin original depuis le nom du fichier backup
      const originalPath = backupFile.replace(/_/g, '/');
      const backupFilePath = join(backupInfo.backupDir, backupFile);

      if (existsSync(backupFilePath)) {
        copyFileSync(backupFilePath, originalPath);
        restoredFiles.push(originalPath);
      }
    }

    return restoredFiles;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Échec de la restauration du backup: ${errorMessage}`);
  }
}
