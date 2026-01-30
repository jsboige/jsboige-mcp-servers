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
  // TODO: Implémenter après CONS-1 stabilisé
  throw new Error('CONS-5 not yet implemented - waiting for CONS-1 stabilization');
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
    nextSteps: generateNextSteps(action, newStatus)
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
function generateNextSteps(
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
 * Crée un backup des fichiers avant application (pour rollback)
 *
 * @param files Liste des fichiers à sauvegarder
 * @param backupPath Chemin du répertoire de backup
 * @returns Informations sur le backup créé
 */
export function createBackup(
  files: string[],
  backupPath: string
): { timestamp: string; files: string[] } {
  // TODO: Implémenter après CONS-1 stabilisé
  throw new Error('CONS-5 not yet implemented - waiting for CONS-1 stabilization');
}

/**
 * Restaure les fichiers depuis un backup (pour rollback)
 *
 * @param backupInfo Informations sur le backup à restaurer
 * @param targetPath Chemin de destination
 * @returns Liste des fichiers restaurés
 */
export function restoreBackup(
  backupInfo: { timestamp: string; files: string[] },
  targetPath: string
): string[] {
  // TODO: Implémenter après CONS-1 stabilisé
  throw new Error('CONS-5 not yet implemented - waiting for CONS-1 stabilization');
}
