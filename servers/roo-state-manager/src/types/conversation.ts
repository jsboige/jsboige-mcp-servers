/**
 * Types pour la gestion des conversations et du stockage Roo
 */

export interface FileInContext {
    path: string;
    content: string;
    lineCount: number;
}

/**
 * Représente une métadonnée d'action de taille fixe pour remplacer les sorties complètes.
 */
export interface ActionMetadata {
  type: 'tool' | 'command';
  name: string;
  parameters: Record<string, any>;
  status: 'success' | 'failure' | 'in_progress';
  timestamp: string;
  line_count?: number;
  content_size?: number;
  file_path?: string;
}

/**
 * Représente un message tronqué dans le squelette de la conversation.
 */
export interface MessageSkeleton {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  isTruncated: boolean;
}

/**
 * Nouvelle représentation "squelette" d'une conversation, optimisée pour la mémoire.
 */
export interface ConversationSkeleton {
  taskId: string;
  parentTaskId?: string;
  metadata: {
    title?: string;
    lastActivity: string;
    createdAt: string;
    mode?: string;
    messageCount: number;
    actionCount: number;
    totalSize: number; // Taille totale de la conversation sur le disque
     workspace?: string;
     qdrantIndexedAt?: string; // Timestamp de la dernière indexation Qdrant réussie
   };
  // Une séquence combinée et ordonnée de messages et d'actions.
  sequence: (MessageSkeleton | ActionMetadata)[];
}

// Représente les métadonnées complètes d'une tâche.
export interface TaskMetadata {
    parentTaskId?: string; // camelCase est la nouvelle norme
    parent_task_id?: string; // snake_case pour la rétrocompatibilité
    rootTaskId?: string;
    prompt?: {
        task: string;
    };
    title?: string;
    lastActivity?: string;
    createdAt?: string;
    mode?: string;
    files_in_context?: FileInContext[];
    workspace?: string;
}

// Représente une conversation complète avec toutes les données pour l'analyse.
/** @deprecated */
export interface ConversationSummary {
    // Fields from the old ConversationSkeleton to maintain compatibility during transition
    taskId: string;
    parentTaskId?: string;
    prompt: string;
    lastActivity: string;
    messageCount: number;
    size: number;
    hasApiHistory: boolean;
    hasUiMessages: boolean;
    mode?: string;

    // Fields specific to ConversationSummary
    path: string;
    metadata: TaskMetadata;
}


// Interfaces pour le stockage, non directement utilisées dans le cache principal
export interface RooStorageLocation {
    path: string;
    type: 'local' | 'cloud';
}

export interface RooStorageDetectionResult {
    locations: RooStorageLocation[];
}

export interface StorageStats {
    conversationCount: number;
    totalSize: number;
    fileTypes: Record<string, number>;
}

/**
 * Options étendues pour la génération de résumés de grappes de tâches
 */
export interface ClusterSummaryOptions {
    // Options héritées des résumés standards
    detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    truncationChars?: number;
    compactStats?: boolean;
    includeCss?: boolean;
    generateToc?: boolean;
    outputFormat?: 'markdown' | 'html';
    
    // Mode de génération de grappe
    clusterMode?: 'aggregated' | 'detailed' | 'comparative';
    
    // Inclusion des statistiques de grappe
    includeClusterStats?: boolean;
    
    // Analyse cross-task des patterns communs
    crossTaskAnalysis?: boolean;
    
    // Profondeur maximale de la hiérarchie à inclure
    maxClusterDepth?: number;
    
    // Tri des tâches dans la grappe
    clusterSortBy?: 'chronological' | 'size' | 'activity' | 'alphabetical';
    
    // Inclusion d'une timeline unifiée
    includeClusterTimeline?: boolean;
    
    // Seuil de troncature spécifique aux grappes
    clusterTruncationChars?: number;
    
    // Affichage des relations inter-tâches
    showTaskRelationships?: boolean;
}

/**
 * Statistiques étendues pour les grappes de tâches
 */
export interface ClusterSummaryStatistics {
    // Statistiques de base (héritées)
    totalSections: number;
    userMessages: number;
    assistantMessages: number;
    toolResults: number;
    userContentSize: number;
    assistantContentSize: number;
    toolResultsSize: number;
    totalContentSize: number;
    userPercentage: number;
    assistantPercentage: number;
    toolResultsPercentage: number;
    compressionRatio?: number;
    
    // Métriques spécifiques aux grappes
    totalTasks: number;
    clusterDepth: number;
    averageTaskSize: number;
    
    // Distribution des tâches
    taskDistribution: {
        byMode: Record<string, number>;
        bySize: { small: number; medium: number; large: number };
        byActivity: Record<string, number>;
    };
    
    // Métriques temporelles
    clusterTimeSpan: {
        startTime: string;
        endTime: string;
        totalDurationHours: number;
    };
    
    // Métriques de contenu agrégées
    clusterContentStats: {
        totalUserMessages: number;
        totalAssistantMessages: number;
        totalToolResults: number;
        totalContentSize: number;
        averageMessagesPerTask: number;
    };
    
    // Analyse des patterns
    commonPatterns?: {
        frequentTools: Record<string, number>;
        commonModes: Record<string, number>;
        crossTaskTopics: string[];
    };
}

/**
 * Résultat de génération de résumé de grappe
 */
export interface ClusterSummaryResult {
    // Propriétés héritées
    success: boolean;
    content: string;
    statistics: ClusterSummaryStatistics;
    error?: string;
    
    // Métadonnées spécifiques aux grappes
    clusterMetadata: {
        rootTaskId: string;
        totalTasks: number;
        clusterMode: string;
        generationTimestamp: string;
    };
    
    // Index des tâches incluses
    taskIndex: {
        taskId: string;
        title: string;
        order: number;
        size: number;
    }[];
    
    // Format et taille
    format: string;
    size: number;
}

/**
 * Structure d'organisation des tâches dans une grappe
 */
export interface OrganizedClusterTasks {
    rootTask: ConversationSkeleton;
    allTasks: ConversationSkeleton[];
    sortedTasks: ConversationSkeleton[];
    taskHierarchy: Map<string, ConversationSkeleton[]>;
    taskOrder: string[];
}

/**
 * Contenu classifié au niveau de la grappe
 */
export interface ClassifiedClusterContent {
    aggregatedContent: ClusterClassifiedContent[];
    perTaskContent: Map<string, ClusterClassifiedContent[]>;
    crossTaskPatterns: CrossTaskPattern[];
}

/**
 * Pattern identifié à travers plusieurs tâches
 */
export interface CrossTaskPattern {
    pattern: string;
    frequency: number;
    taskIds: string[];
    category: 'tool' | 'mode' | 'topic' | 'interaction';
}

/**
 * Classification de contenu pour les grappes (référence au type du service)
 */
export interface ClusterClassifiedContent {
    type: 'User' | 'Assistant';
    subType: 'UserMessage' | 'ToolResult' | 'ToolCall' | 'Completion';
    content: string;
    index: number;
    toolType?: string;
    resultType?: string;
}

export interface StorageStats {
    conversationCount: number;
    totalSize: number;
    fileTypes: Record<string, number>;
}


// Types d'erreur spécifiques
export class RooStorageError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'RooStorageError';
    }
}

export class ConversationNotFoundError extends RooStorageError {
    constructor(taskId: string) {
        super(`Conversation with taskId ${taskId} not found`, 'CONVERSATION_NOT_FOUND');
    }
}

export class InvalidStoragePathError extends RooStorageError {
    constructor(path: string) {
        super(`Invalid storage path: ${path}`, 'INVALID_STORAGE_PATH');
    }
}