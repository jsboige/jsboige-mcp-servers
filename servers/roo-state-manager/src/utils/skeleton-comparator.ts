/**
 * Comparateur de skeletons pour valider la migration vers le nouveau système
 * 
 * @module skeleton-comparator
 */

import { ConversationSkeleton } from '../types/conversation.js';
import { validateComparisonResults } from './parsing-config.js';

/**
 * Résultat de comparaison entre deux skeletons
 */
export interface SkeletonComparisonResult {
  /** Les skeletons sont identiques */
  areIdentical: boolean;
  
  /** Différences détectées */
  differences: {
    field: string;
    oldValue: any;
    newValue: any;
    severity: 'minor' | 'major' | 'critical';
  }[];
  
  /** Score de similarité (0-100%) */
  similarityScore: number;
  
  /** Métadonnées de comparaison */
  metadata: {
    comparedAt: number;
    oldSystemName: string;
    newSystemName: string;
  };
}

/**
 * Compare deux skeletons et génère un rapport de différences
 */
export class SkeletonComparator {
  /**
   * Compare deux skeletons
   * @param oldSkeleton Skeleton produit par l'ancien système (regex-based)
   * @param newSkeleton Skeleton produit par le nouveau système (json-parsing)
   * @returns Résultat de comparaison avec différences détaillées
   */
  compare(
    oldSkeleton: ConversationSkeleton,
    newSkeleton: ConversationSkeleton
  ): SkeletonComparisonResult {
    const differences: SkeletonComparisonResult['differences'] = [];
    
    // Comparer taskId
    if (oldSkeleton.taskId !== newSkeleton.taskId) {
      differences.push({
        field: 'taskId',
        oldValue: oldSkeleton.taskId,
        newValue: newSkeleton.taskId,
        severity: 'critical',
      });
    }
    
    // Comparer workspace
    if (oldSkeleton.metadata?.workspace !== newSkeleton.metadata?.workspace) {
      differences.push({
        field: 'workspace',
        oldValue: oldSkeleton.metadata?.workspace,
        newValue: newSkeleton.metadata?.workspace,
        severity: 'major',
      });
    }
    
    // Comparer truncatedInstruction
    if (oldSkeleton.truncatedInstruction !== newSkeleton.truncatedInstruction) {
      differences.push({
        field: 'truncatedInstruction',
        oldValue: oldSkeleton.truncatedInstruction,
        newValue: newSkeleton.truncatedInstruction,
        severity: 'major',
      });
    }
    
    // Comparer childTaskInstructionPrefixes
    const oldPrefixes = new Set(oldSkeleton.childTaskInstructionPrefixes || []);
    const newPrefixes = new Set(newSkeleton.childTaskInstructionPrefixes || []);
    
    if (!this.areSetsEqual(oldPrefixes, newPrefixes)) {
      differences.push({
        field: 'childTaskInstructionPrefixes',
        oldValue: Array.from(oldPrefixes),
        newValue: Array.from(newPrefixes),
        severity: 'major',
      });
    }
    
    // Comparer isCompleted
    if (oldSkeleton.isCompleted !== newSkeleton.isCompleted) {
      differences.push({
        field: 'isCompleted',
        oldValue: oldSkeleton.isCompleted,
        newValue: newSkeleton.isCompleted,
        severity: 'major',
      });
    }
    
    // Comparer metadata.createdAt
    if (oldSkeleton.metadata?.createdAt !== newSkeleton.metadata?.createdAt) {
      differences.push({
        field: 'metadata.createdAt',
        oldValue: oldSkeleton.metadata?.createdAt,
        newValue: newSkeleton.metadata?.createdAt,
        severity: 'minor',
      });
    }
    
    // Comparer metadata.lastActivity
    if (oldSkeleton.metadata?.lastActivity !== newSkeleton.metadata?.lastActivity) {
      differences.push({
        field: 'metadata.lastActivity',
        oldValue: oldSkeleton.metadata?.lastActivity,
        newValue: newSkeleton.metadata?.lastActivity,
        severity: 'minor',
      });
    }
    
    // Comparer metadata.messageCount
    if (oldSkeleton.metadata?.messageCount !== newSkeleton.metadata?.messageCount) {
      differences.push({
        field: 'metadata.messageCount',
        oldValue: oldSkeleton.metadata?.messageCount,
        newValue: newSkeleton.metadata?.messageCount,
        severity: 'major',
      });
    }
    
    // Calculer le score de similarité
    const totalFields = 9; // Nombre de champs comparés
    const identicalFields = totalFields - differences.length;
    const similarityScore = (identicalFields / totalFields) * 100;
    
    return {
      areIdentical: differences.length === 0,
      differences,
      similarityScore,
      metadata: {
        comparedAt: Date.now(),
        oldSystemName: 'regex-based',
        newSystemName: 'json-parsing',
      },
    };
  }
  
  /**
   * Vérifie si deux Sets sont égaux
   * @param set1 Premier set
   * @param set2 Deuxième set
   * @returns true si les sets sont égaux
   */
  private areSetsEqual<T>(set1: Set<T>, set2: Set<T>): boolean {
    if (set1.size !== set2.size) return false;
    for (const item of set1) {
      if (!set2.has(item)) return false;
    }
    return true;
  }
  
  /**
   * Formatte le résultat de comparaison en texte lisible
   * @param result Résultat de comparaison
   * @returns Rapport formaté en texte
   */
  formatReport(result: SkeletonComparisonResult): string {
    const lines: string[] = [
      '=== Skeleton Comparison Report ===',
      `Similarity Score: ${result.similarityScore.toFixed(2)}%`,
      `Identical: ${result.areIdentical ? 'YES' : 'NO'}`,
      '',
    ];
    
    if (result.differences.length > 0) {
      lines.push('Differences:');
      result.differences.forEach(diff => {
        lines.push(`  [${diff.severity.toUpperCase()}] ${diff.field}:`);
        lines.push(`    Old: ${JSON.stringify(diff.oldValue)}`);
        lines.push(`    New: ${JSON.stringify(diff.newValue)}`);
      });
    } else {
      lines.push('No differences detected.');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Vérifie si les différences sont dans les limites acceptables
   * @param result Résultat de comparaison
   * @param tolerance Pourcentage de tolérance (0-100)
   * @returns true si les différences sont acceptables
   */
  isWithinTolerance(result: SkeletonComparisonResult, tolerance: number): boolean {
    // Aucune différence critique ne devrait être tolérée
    const hasCriticalDiff = result.differences.some(d => d.severity === 'critical');
    if (hasCriticalDiff) {
      return false;
    }
    
    // Vérifier le score de similarité
    return result.similarityScore >= (100 - tolerance);
  }
  
  /**
   * Génère un résumé des différences par sévérité
   * @param result Résultat de comparaison
   * @returns Résumé des différences
   */
  getDifferenceSummary(result: SkeletonComparisonResult): {
    critical: number;
    major: number;
    minor: number;
    total: number;
  } {
    const summary = {
      critical: 0,
      major: 0,
      minor: 0,
      total: result.differences.length,
    };
    
    for (const diff of result.differences) {
      summary[diff.severity]++;
    }
    
    return summary;
  }

  /**
   * Identifie les améliorations apportées par le nouveau système
   */
  identifyImprovements(
    oldSkeleton: ConversationSkeleton,
    newSkeleton: ConversationSkeleton
  ): string[] {
    const improvements: string[] = [];
    
    // Amélioration 1 : Child tasks détectés
    const oldChildTasks = oldSkeleton.childTaskInstructionPrefixes?.length || 0;
    const newChildTasks = newSkeleton.childTaskInstructionPrefixes?.length || 0;
    if (newChildTasks > oldChildTasks) {
      const improvement = newChildTasks - oldChildTasks;
      improvements.push(`+${improvement} child tasks détectés (${oldChildTasks} → ${newChildTasks})`);
    }
    
    // Amélioration 2 : Normalisation workspace
    if (oldSkeleton.metadata?.workspace && newSkeleton.metadata?.workspace &&
        oldSkeleton.metadata.workspace !== newSkeleton.metadata.workspace &&
        newSkeleton.metadata.workspace.includes('\\\\')) {
      improvements.push('Normalisation path Windows (/ → \\\\)');
    }
    
    // Amélioration 3 : Réduction truncatedInstruction
    if (oldSkeleton.truncatedInstruction && !newSkeleton.truncatedInstruction) {
      improvements.push('Instruction complète extraite (truncated → complete)');
    }
    
    return improvements;
  }

  /**
   * Compare avec validation des améliorations
   */
  compareWithImprovements(
    oldSkeleton: ConversationSkeleton,
    newSkeleton: ConversationSkeleton
  ): SkeletonComparisonResult & { improvements: string[]; isValidUpgrade: boolean; validationReason: string } {
    const baseComparison = this.compare(oldSkeleton, newSkeleton);
    const improvements = this.identifyImprovements(oldSkeleton, newSkeleton);
    
    // Validation avec nouveaux critères
    const validation = validateComparisonResults(
      baseComparison.similarityScore,
      oldSkeleton.childTaskInstructionPrefixes?.length || 0,
      newSkeleton.childTaskInstructionPrefixes?.length || 0,
      improvements
    );
    
    return {
      ...baseComparison,
      improvements,
      isValidUpgrade: validation.isValid,
      validationReason: validation.reason
    };
  }
}