/**
 * Types pour le support du stockage Claude Code
 *
 * Claude Code stocke les conversations au format JSONL dans ~/.claude/projects/<project-id>/
 * Chaque ligne est un objet JSON représentant un message ou un événement.
 */

/**
 * Emplacement de stockage Claude Code
 */
export interface ClaudeStorageLocation {
    /** Chemin vers le répertoire projects dans ~/.claude */
    path: string;
    /** Type de stockage (toujours local pour Claude Code) */
    type: 'local';
    /** Nom du projet Claude Code */
    projectName: string;
    /** Chemin complet du projet */
    projectPath: string;
}

/**
 * Types d'entrées dans le JSONL Claude Code
 */
export type ClaudeEntryType =
    | 'user'              // Message utilisateur
    | 'assistant'         // Message assistant
    | 'command_result'    // Résultat d'une commande shell
    | 'read_result'       // Résultat d'une lecture de fichier
    | 'tool_result'       // Résultat d'un outil
    | 'command_output';   // Sortie de commande

/**
 * Structure d'une entrée JSONL de Claude Code
 */
export interface ClaudeJsonlEntry {
    /** Type de l'entrée */
    type: ClaudeEntryType;

    /** Contenu du message (pour user/assistant) */
    message?: {
        role: 'user' | 'assistant';
        content: string | ClaudeContentBlock[];
    };

    /** Résultat d'une commande (pour command_result) */
    command?: {
        command: string;
        exitCode: number;
        output: string;
    };

    /** Résultat de lecture (pour read_result) */
    readResult?: {
        filePath: string;
        content: string;
        lineCount?: number;
    };

    /** Résultat d'outil (pour tool_result) */
    toolResult?: {
        name: string;
        result: any;
    };

    /** Timestamp ISO 8601 */
    timestamp: string;

    /** UUID unique pour cette entrée */
    uuid: string;

    /** Métadonnées supplémentaires */
    metadata?: {
        /** ID de la tâche/conversation */
        taskId?: string;
        /** Fichiers lus/modifiés */
        files?: string[];
        /** Outils utilisés */
        tools?: string[];
    };
}

/**
 * Bloc de contenu dans les messages Claude
 */
export interface ClaudeContentBlock {
    type: 'text' | 'image' | 'tool_use' | 'tool_result';
    text?: string;
    image?: {
        source: {
            type: 'base64';
            media_type: string;
            data: string;
        };
    };
    toolUse?: {
        name: string;
        id: string;
        input: Record<string, any>;
    };
    toolResult?: {
        tool_use_id: string;
        content?: string | Array<{ type: string; text?: string }>;
        is_error?: boolean;
    };
}

/**
 * Métadonnées d'une conversation Claude
 */
export interface ClaudeConversationMetadata {
    /** ID de la conversation (UUID) */
    taskId: string;

    /** Titre de la conversation */
    title?: string;

    /** Date de création */
    createdAt: string;

    /** Dernière activité */
    lastActivity: string;

    /** Nombre de messages */
    messageCount: number;

    /** Nombre d'actions (outils, commandes) */
    actionCount: number;

    /** Taille totale de la conversation */
    totalSize: number;

    /** Workspace associé */
    workspace?: string;

    /** Mode Claude Code */
    mode?: string;

    /** ID de la tâche parente */
    parentTaskId?: string;
}

/**
 * Options de parsing pour ClaudeStorageDetector
 */
export interface ClaudeParsingOptions {
    /** Inclure les résultats d'outils dans la séquence */
    includeToolResults?: boolean;

    /** Longueur maximale du contenu avant troncature */
    maxContentLength?: number;

    /** Inclure les métadonnées étendues */
    includeExtendedMetadata?: boolean;
}

/**
 * Résultat de détection du stockage Claude
 */
export interface ClaudeDetectionResult {
    /** Emplacements détectés */
    locations: ClaudeStorageLocation[];

    /** Statistiques globales */
    stats: {
        totalProjects: number;
        totalConversations: number;
        totalSize: number;
    };
}
