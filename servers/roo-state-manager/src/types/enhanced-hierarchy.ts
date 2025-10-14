/**
 * Types étendus pour le système de reconstruction hiérarchique en deux passes
 * Résout le problème des 47 tâches orphelines en reconstruisant les parentIds
 */

import { ConversationSkeleton, NewTaskInstruction } from './conversation.js';

/**
 * Informations sur les fichiers sources d'une conversation
 */
export interface FileInfo {
    path: string;
    exists: boolean;
    size?: number;
    lastModified?: string;
}

/**
 * Statistiques d'extraction des instructions de sous-tâches
 */
export interface ExtractionStats {
    totalPatterns: number;
    xmlDelegations: number;
    taskTags: number;
    duplicatesRemoved: number;
    processingTimeMs?: number;
}

/**
 * État de traitement pour le système en deux passes
 */
export interface ProcessingState {
    phase1Completed: boolean;
    phase2Completed: boolean;
    processingErrors: string[];
    lastProcessedAt?: string;
}

/**
 * Checksums des fichiers sources pour détecter les changements
 */
export interface SourceFileChecksums {
    uiMessages?: string;
    apiHistory?: string;
    metadata?: string;
}

/**
 * Instructions de sous-tâches parsées avec métadonnées
 */
export interface ParsedSubtaskInstructions {
    instructions: NewTaskInstruction[];
    parsingTimestamp: string;
    sourceFiles: {
        uiMessages: FileInfo;
        apiHistory: FileInfo;
    };
    extractionStats: ExtractionStats;
}

/**
 * Extension de ConversationSkeleton pour le système de reconstruction hiérarchique
 */
export interface EnhancedConversationSkeleton extends ConversationSkeleton {
    /**
     * Instructions de sous-tâches parsées depuis les ui_messages
     * Utilisé en PASSE 1 pour extraire et stocker les instructions
     */
    parsedSubtaskInstructions?: ParsedSubtaskInstructions;
    
    /**
     * Timestamp du dernier parsing des instructions de sous-tâches
     * Pour éviter le re-parsing inutile si les fichiers n'ont pas changé
     */
    subtaskParsingTimestamp?: string;
    
    /**
     * État de traitement des deux passes
     * Permet la reprise après interruption
     */
    processingState: ProcessingState;
    
    /**
     * Checksums des fichiers sources
     * Pour détecter les changements et invalider le cache
     */
    sourceFileChecksums: SourceFileChecksums;
    
    /**
     * Nouveau parentId reconstruit via le système en deux passes
     * Remplace le parentTaskId manquant/incorrect
     */
    reconstructedParentId?: string;
    
    /**
     * Score de confiance pour le parentId reconstruit (0-1)
     * Plus le score est élevé, plus la reconstruction est fiable
     */
    parentConfidenceScore?: number;
    
    /**
     * Méthode utilisée pour reconstruire le parentId
     * Pour le debug et l'analyse de qualité
     */
    parentResolutionMethod?: 'radix_tree' | 'radix_tree_exact' | 'metadata' | 'temporal_proximity' | 'manual' | 'root_detected';
    
    /**
     * Instructions de création de cette tâche (depuis le parent)
     * Préfixe de 200 caractères pour le radix tree
     */
    ownInstructionPrefix?: string;
    
    /**
     * Indique si cette tâche est une vraie racine (pas de parent)
     * Différent de parentTaskId === undefined qui peut être une erreur
     */
    isRootTask?: boolean;
}

/**
 * Résultat de la PASSE 1 (extraction et parsing)
 */
export interface Phase1Result {
    processedCount: number;
    parsedCount: number;
    errors: Array<{
        taskId: string;
        error: string;
    }>;
    totalInstructionsExtracted: number;
    radixTreeSize: number;
    processingTimeMs: number;
}

/**
 * Résultat de la PASSE 2 (résolution des parentIds)
 */
export interface Phase2Result {
    processedCount: number;
    resolvedCount: number;
    unresolvedCount: number;
    resolutionMethods: Record<string, number>;
    averageConfidenceScore: number;
    errors: Array<{
        taskId: string;
        error: string;
    }>;
    processingTimeMs: number;
}

/**
 * Configuration pour le moteur de reconstruction
 */
export interface ReconstructionConfig {
    /** Force le rebuild même si les checksums n'ont pas changé */
    forceRebuild?: boolean;
    
    /** Traiter par batches pour améliorer les performances */
    batchSize?: number;
    
    /** Seuil de similarité pour la recherche dans le radix tree (0-1) */
    similarityThreshold?: number;
    
    /** Score de confiance minimum pour accepter un parentId reconstruit (0-1) */
    minConfidenceScore?: number;
    
    /** Filtrer par workspace spécifique */
    workspaceFilter?: string;
    
    /** Activer les logs détaillés pour le debug */
    debugMode?: boolean;
    
    /** Timeout en ms pour chaque opération */
    operationTimeout?: number;
    
    /** Mode strict : utilise uniquement le matching exact, pas de fallbacks (défaut: true) */
    strictMode?: boolean;
}

/**
 * Résultat de recherche de similarité dans le radix tree
 */
export interface SimilaritySearchResult {
    taskId: string;
    instruction: string;
    similarityScore: number;
    matchedPrefix: string;
    matchType: 'exact' | 'prefix' | 'fuzzy';
}

/**
 * Validation d'un parentId candidat
 */
export interface ParentValidation {
    isValid: boolean;
    validationType: 'temporal' | 'circular' | 'workspace' | 'existence';
    reason?: string;
}