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
  };
  // Une séquence combinée et ordonnée de messages et d'actions.
  sequence: (MessageSkeleton | ActionMetadata)[];
}

// Représente les métadonnées complètes d'une tâche.
export interface TaskMetadata {
    parentTaskId?: string;
    rootTaskId?: string;
    prompt?: {
        task: string;
    };
    title?: string;
    lastActivity?: string;
    createdAt?: string;
    mode?: string;
    files_in_context?: FileInContext[];
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