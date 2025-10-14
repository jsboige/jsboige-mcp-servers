/**
 * Moteur de troncature intelligente avec gradient exponentiel
 * @fileoverview Implémentation de l'algorithme de troncature intelligente pour view_conversation_tree
 */

import { ConversationSkeleton } from '../../types/conversation.js';
import {
    SmartTruncationConfig,
    SmartTruncationResult,
    TaskTruncationPlan,
    ElementTruncationPlan
} from './types.js';

/**
 * Configuration par défaut pour la troncature intelligente
 */
const DEFAULT_CONFIG: SmartTruncationConfig = {
    maxOutputLength: 300000, // 300K caractères (doublé depuis 150K)
    gradientStrength: 2.0, // Coefficient pour exp(-2.0 × distance²)
    minPreservationRate: 0.9, // 90% minimum préservé aux extrêmes
    maxTruncationRate: 0.7, // 70% maximum tronqué au centre
    contentPriority: {
        userMessages: 1.0,     // Priorité maximale
        assistantMessages: 0.8, // Priorité élevée
        actions: 0.6,          // Priorité modérée
        metadata: 0.4          // Priorité basse
    }
};

/**
 * Calculateur de gradient exponentiel
 */
class GradientCalculator {
    /**
     * Calcule le poids de préservation selon la position dans la chaîne
     * @param position Position de la tâche (0-based)
     * @param totalTasks Nombre total de tâches
     * @param gradientStrength Coefficient du gradient exponentiel
     * @returns Poids de préservation [0,1]
     */
    static calculatePreservationWeight(
        position: number,
        totalTasks: number,
        gradientStrength: number
    ): number {
        if (totalTasks <= 1) return 1.0;
        
        // Position normalisée du centre [0,1]
        const center = (totalTasks - 1) / 2;
        const distanceFromCenter = Math.abs(position - center) / center;
        
        // Fonction exponentielle : exp(-k × distance²)
        const weight = Math.exp(-gradientStrength * distanceFromCenter * distanceFromCenter);
        
        // Contraindre entre [0,1]
        return Math.max(0, Math.min(1, weight));
    }
}

/**
 * Calculateur de taille précis (vs estimations approximatives)
 */
class SizeCalculator {
    /**
     * Calcule la taille exacte d'une tâche
     */
    static calculateTaskSize(skeleton: ConversationSkeleton): number {
        let totalSize = 0;
        
        // En-tête de tâche (titre, métadonnées)
        totalSize += 200; // Approximation pour l'en-tête
        
        // Contenu de la séquence
        for (const item of skeleton.sequence) {
            if ('role' in item) {
                // Message utilisateur/assistant
                totalSize += item.content.length + 100; // Contenu + formatage
            } else {
                // Action/outil
                totalSize += 150; // Métadonnées + formatage de base
                
                // Ajouter taille des paramètres si présents
                if (item.parameters) {
                    const paramStr = JSON.stringify(item.parameters);
                    totalSize += paramStr.length;
                }
            }
        }
        
        return totalSize;
    }
    
    /**
     * Calcule la taille exacte d'un élément de séquence
     */
    static calculateElementSize(item: any): number {
        if ('role' in item) {
            return item.content.length + 100; // Message + formatage
        } else {
            let size = 150; // Base pour action
            if (item.parameters) {
                size += JSON.stringify(item.parameters).length;
            }
            return size;
        }
    }
}

/**
 * Allocateur de budget de troncature
 */
class BudgetAllocator {
    /**
     * Répartit le budget de troncature entre les tâches selon le gradient
     */
    static allocateTruncationBudget(
        tasks: ConversationSkeleton[],
        totalExcess: number,
        config: SmartTruncationConfig
    ): TaskTruncationPlan[] {
        if (totalExcess <= 0) {
            // Pas de troncature nécessaire
            return tasks.map((task, index) => ({
                taskId: task.taskId,
                position: index,
                distanceFromCenter: this.calculateDistanceFromCenter(index, tasks.length),
                preservationWeight: 1.0,
                originalSize: SizeCalculator.calculateTaskSize(task),
                truncationBudget: 0,
                targetSize: SizeCalculator.calculateTaskSize(task),
                elementPlans: []
            }));
        }
        
        // Calcul des poids de préservation
        const weights = tasks.map((_, index) => 
            GradientCalculator.calculatePreservationWeight(
                index, 
                tasks.length, 
                config.gradientStrength
            )
        );
        
        // Conversion poids de préservation → poids de troncature
        // Plus le poids de préservation est élevé, moins on tronque
        const truncationWeights = weights.map(w => 1 - w);
        const totalTruncationWeight = truncationWeights.reduce((sum, w) => sum + w, 0);
        
        // Répartition du budget
        const plans: TaskTruncationPlan[] = tasks.map((task, index) => {
            const originalSize = SizeCalculator.calculateTaskSize(task);
            
            // Budget alloué proportionnellement au poids de troncature
            let truncationBudget = 0;
            if (totalTruncationWeight > 0) {
                truncationBudget = (totalExcess * truncationWeights[index]) / totalTruncationWeight;
            }
            
            // Contraindre selon les limites de configuration
            const maxAllowedTruncation = originalSize * config.maxTruncationRate;
            const minRequiredPreservation = originalSize * config.minPreservationRate;
            
            truncationBudget = Math.min(truncationBudget, maxAllowedTruncation);
            truncationBudget = Math.max(0, Math.min(truncationBudget, originalSize - minRequiredPreservation));
            
            return {
                taskId: task.taskId,
                position: index,
                distanceFromCenter: this.calculateDistanceFromCenter(index, tasks.length),
                preservationWeight: weights[index],
                originalSize,
                truncationBudget,
                targetSize: originalSize - truncationBudget,
                elementPlans: []
            };
        });
        
        return plans;
    }
    
    private static calculateDistanceFromCenter(position: number, totalTasks: number): number {
        if (totalTasks <= 1) return 0;
        const center = (totalTasks - 1) / 2;
        return Math.abs(position - center) / center;
    }
}

/**
 * Moteur principal de troncature intelligente
 */
export class SmartTruncationEngine {
    private config: SmartTruncationConfig;
    
    constructor(config?: Partial<SmartTruncationConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    
    /**
     * Applique l'algorithme de troncature intelligente
     */
    public apply(tasks: ConversationSkeleton[]): SmartTruncationResult {
        const diagnostics: string[] = [];
        
        try {
            // Étape 1 : Calcul de la taille totale et du surplus
            const totalSize = tasks.reduce((sum, task) => sum + SizeCalculator.calculateTaskSize(task), 0);
            const excessSize = Math.max(0, totalSize - this.config.maxOutputLength);
            
            diagnostics.push(`Taille totale: ${totalSize} chars, Limite: ${this.config.maxOutputLength}, Surplus: ${excessSize}`);
            
            // Étape 2 : Répartition du budget selon le gradient
            const taskPlans = BudgetAllocator.allocateTruncationBudget(tasks, excessSize, this.config);
            
            // Étape 3 : Planification détaillée par élément (pour l'instant, simplifiée)
            for (const plan of taskPlans) {
                const task = tasks.find(t => t.taskId === plan.taskId);
                if (task && plan.truncationBudget > 0) {
                    plan.elementPlans = this.planElementTruncation(task, plan.truncationBudget);
                }
            }
            
            // Étape 4 : Calcul des métriques
            const finalTotalSize = taskPlans.reduce((sum, plan) => sum + plan.targetSize, 0);
            const compressionRatio = totalSize > 0 ? (totalSize - finalTotalSize) / totalSize : 0;
            
            const truncationByPosition: Record<number, number> = {};
            taskPlans.forEach(plan => {
                truncationByPosition[plan.position] = plan.truncationBudget;
            });
            
            diagnostics.push(`Compression: ${(compressionRatio * 100).toFixed(1)}%, Taille finale: ${finalTotalSize}`);
            
            return {
                config: this.config,
                taskPlans,
                metrics: {
                    totalTasks: tasks.length,
                    originalTotalSize: totalSize,
                    finalTotalSize,
                    compressionRatio,
                    truncationByPosition
                },
                diagnostics
            };
            
        } catch (error) {
            diagnostics.push(`Erreur dans SmartTruncationEngine: ${error}`);
            
            // Fallback : plan sans troncature
            return this.createFallbackResult(tasks, diagnostics);
        }
    }
    
    /**
     * Planifie la troncature des éléments d'une tâche
     */
    private planElementTruncation(task: ConversationSkeleton, truncationBudget: number): ElementTruncationPlan[] {
        const plans: ElementTruncationPlan[] = [];
        let remainingBudget = truncationBudget;
        
        // Identifier les éléments candidats à la troncature (messages centraux prioritairement)
        const elements = task.sequence.map((item, index) => ({
            index,
            item,
            size: SizeCalculator.calculateElementSize(item),
            type: 'role' in item ?
                (item.role === 'user' ? 'user_message' as const : 'assistant_message' as const) : 'action' as const
        }));
        
        // Trier par priorité (actions d'abord, puis messages assistant, puis user messages)
        const priorityOrder: Record<'action' | 'assistant_message' | 'user_message', number> = {
            action: 3,
            assistant_message: 2,
            user_message: 1
        };
        elements.sort((a, b) => priorityOrder[b.type] - priorityOrder[a.type]);
        
        for (const element of elements) {
            if (remainingBudget <= 0) break;
            
            const truncationAmount = Math.min(remainingBudget, element.size * 0.7); // Max 70% de troncature
            
            if (truncationAmount > 10) { // Seuil minimum pour valoir la peine
                plans.push({
                    sequenceIndex: element.index,
                    type: element.type as any,
                    originalSize: element.size,
                    targetSize: element.size - truncationAmount,
                    truncationMethod: 'truncate_middle',
                    truncationParams: {
                        startLines: 5,
                        endLines: 5
                    }
                });
                
                remainingBudget -= truncationAmount;
            }
        }
        
        return plans;
    }
    
    /**
     * Crée un résultat de fallback en cas d'erreur
     */
    private createFallbackResult(tasks: ConversationSkeleton[], diagnostics: string[]): SmartTruncationResult {
        const totalSize = tasks.reduce((sum, task) => sum + SizeCalculator.calculateTaskSize(task), 0);
        
        const taskPlans: TaskTruncationPlan[] = tasks.map((task, index) => ({
            taskId: task.taskId,
            position: index,
            distanceFromCenter: 0,
            preservationWeight: 1.0,
            originalSize: SizeCalculator.calculateTaskSize(task),
            truncationBudget: 0,
            targetSize: SizeCalculator.calculateTaskSize(task),
            elementPlans: []
        }));
        
        return {
            config: this.config,
            taskPlans,
            metrics: {
                totalTasks: tasks.length,
                originalTotalSize: totalSize,
                finalTotalSize: totalSize,
                compressionRatio: 0,
                truncationByPosition: {}
            },
            diagnostics
        };
    }
}