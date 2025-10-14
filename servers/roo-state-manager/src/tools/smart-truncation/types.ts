/**
 * Types et interfaces pour le système de troncature intelligente
 * @fileoverview Définitions TypeScript pour l'algorithme de troncature avec gradient
 */

import { ConversationSkeleton } from '../../types/conversation.js';

/**
 * Configuration pour l'algorithme de troncature intelligente
 */
export interface SmartTruncationConfig {
    /** Limite maximale de caractères en sortie */
    maxOutputLength: number;
    /** Coefficient du gradient exponentiel (plus élevé = plus de préservation aux extrêmes) */
    gradientStrength: number;
    /** Seuil minimum de préservation (%) pour les tâches extrêmes */
    minPreservationRate: number;
    /** Seuil maximum de troncature (%) pour les tâches centrales */
    maxTruncationRate: number;
    /** Priorité de préservation par type de contenu */
    contentPriority: {
        userMessages: number;
        assistantMessages: number;
        actions: number;
        metadata: number;
    };
}

/**
 * Plan de troncature pour une tâche individuelle
 */
export interface TaskTruncationPlan {
    /** ID de la tâche */
    taskId: string;
    /** Position dans la chaîne (0-based) */
    position: number;
    /** Distance normalisée du centre [0,1] */
    distanceFromCenter: number;
    /** Poids de préservation [0,1] */
    preservationWeight: number;
    /** Taille originale estimée (caractères) */
    originalSize: number;
    /** Budget de troncature alloué (caractères) */
    truncationBudget: number;
    /** Taille cible après troncature */
    targetSize: number;
    /** Plan détaillé par élément de séquence */
    elementPlans: ElementTruncationPlan[];
}

/**
 * Plan de troncature pour un élément de séquence
 */
export interface ElementTruncationPlan {
    /** Index dans la séquence */
    sequenceIndex: number;
    /** Type d'élément */
    type: 'user_message' | 'assistant_message' | 'action';
    /** Taille originale */
    originalSize: number;
    /** Taille cible après troncature */
    targetSize: number;
    /** Méthode de troncature */
    truncationMethod: 'preserve' | 'truncate_middle' | 'truncate_end' | 'summary';
    /** Paramètres de troncature spécifiques */
    truncationParams?: {
        startLines?: number;
        endLines?: number;
        summaryLength?: number;
    };
}

/**
 * Résultat de l'algorithme de troncature intelligente
 */
export interface SmartTruncationResult {
    /** Configuration utilisée */
    config: SmartTruncationConfig;
    /** Plans de troncature par tâche */
    taskPlans: TaskTruncationPlan[];
    /** Métriques de compression */
    metrics: {
        /** Nombre total de tâches */
        totalTasks: number;
        /** Taille originale totale */
        originalTotalSize: number;
        /** Taille finale après troncature */
        finalTotalSize: number;
        /** Taux de compression global */
        compressionRatio: number;
        /** Répartition de la troncature par position */
        truncationByPosition: Record<number, number>;
    };
    /** Messages de diagnostic */
    diagnostics: string[];
}

/**
 * Arguments étendus pour view_conversation_tree avec troncature intelligente
 */
export interface ViewConversationTreeArgs {
    task_id?: string;
    workspace?: string;
    /** ID de la tâche actuellement en cours d'exécution (pour marquage explicite) */
    current_task_id?: string;
    view_mode?: 'single' | 'chain' | 'cluster';
    detail_level?: 'skeleton' | 'summary' | 'full';
    truncate?: number;
    max_output_length?: number;
    /** Flag feature pour activer la troncature intelligente */
    smart_truncation?: boolean;
    /** Configuration personnalisée pour la troncature intelligente */
    smart_truncation_config?: Partial<SmartTruncationConfig>;
}