/**
 * DifferenceDetector - Module de détection des différences
 *
 * Ce module est responsable de la comparaison entre la baseline et l'inventaire,
 * ainsi que de la création des décisions de synchronisation.
 */

import {
  BaselineDifference,
  BaselineComparisonReport,
  SyncDecision,
  BaselineServiceError,
  BaselineServiceErrorCode
} from '../../types/baseline.js';

export class DifferenceDetector {
  /**
   * Calcule le résumé des différences
   */
  public calculateSummary(differences: BaselineDifference[]) {
    return differences.reduce((acc, diff) => {
      acc.total++;
      const severity = diff.severity.toLowerCase() as keyof typeof acc;
      if (severity in acc) {
        acc[severity]++;
      }
      return acc;
    }, { total: 0, critical: 0, important: 0, warning: 0, info: 0 });
  }

  /**
   * Crée des décisions de synchronisation à partir des différences détectées
   */
  public createSyncDecisions(
    report: BaselineComparisonReport,
    severityThreshold: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO' = 'IMPORTANT'
  ): SyncDecision[] {
    try {
      // Filtrer les différences selon le seuil de sévérité
      const filteredDifferences = report.differences.filter(diff =>
        this.isSeverityAtLeast(diff.severity, severityThreshold)
      );

      const decisions: SyncDecision[] = filteredDifferences.map((diff, index) => ({
        id: `decision-${Date.now()}-${index}`,
        machineId: report.targetMachine,
        differenceId: `${diff.category}-${diff.path}`,
        category: diff.category,
        description: diff.description,
        baselineValue: diff.baselineValue,
        targetValue: diff.actualValue,
        action: this.recommendAction(diff),
        severity: diff.severity,
        status: 'pending',
        createdAt: new Date().toISOString()
      }));

      return decisions;
    } catch (error) {
      throw new BaselineServiceError(
        `Erreur création décisions: ${(error as Error).message}`,
        BaselineServiceErrorCode.COMPARISON_FAILED,
        error
      );
    }
  }

  /**
   * Vérifie si la sévérité est au moins au niveau requis
   */
  private isSeverityAtLeast(
    severity: string,
    threshold: string
  ): boolean {
    const levels: Record<string, number> = { 'CRITICAL': 4, 'IMPORTANT': 3, 'WARNING': 2, 'INFO': 1 };
    return (levels[severity] || 0) >= (levels[threshold] || 0);
  }

  /**
   * Recommande une action basée sur la différence
   */
  private recommendAction(
    diff: BaselineDifference
  ): 'sync_to_baseline' | 'keep_target' | 'manual_review' {
    if (diff.severity === 'CRITICAL') return 'sync_to_baseline';
    if (diff.category === 'config') return 'sync_to_baseline';
    if (diff.category === 'hardware') return 'keep_target';
    return 'manual_review';
  }
}