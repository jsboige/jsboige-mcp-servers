/**
 * Types pour le service de génération de résumés de traces Roo
 *
 * Extrait de TraceSummaryService.ts pour éviter les dépendances circulaires
 * et améliorer l'organisation du code.
 */

/**
 * Formats d'export supportés
 */
export type ExportFormat = 'markdown' | 'html' | 'json' | 'csv';

/**
 * Variantes pour l'export JSON
 */
export type JsonVariant = 'light' | 'full';

/**
 * Variantes pour l'export CSV
 */
export type CsvVariant = 'conversations' | 'messages' | 'tools';

/**
 * Options de configuration pour la génération de résumé
 */
export interface SummaryOptions {
    detailLevel: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    truncationChars: number;
    compactStats: boolean;
    includeCss: boolean;
    generateToc: boolean;
    outputFormat: ExportFormat;
    jsonVariant?: JsonVariant;
    csvVariant?: CsvVariant;
    // SDDD Phase 3: Feature flag pour les strategies
    enableDetailLevels?: boolean;
    // Range processing: optional start and end indices for message filtering
    startIndex?: number;
    endIndex?: number;
    tocStyle?: 'markdown' | 'html';
    hideEnvironmentDetails?: boolean;
}

/**
 * Résultat de génération de résumé
 */
export interface SummaryResult {
    success: boolean;
    content: string;
    statistics: SummaryStatistics;
    error?: string;
}

/**
 * Statistiques calculées sur le contenu
 */
export interface SummaryStatistics {
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
}

/**
 * Formats d'export JSON - Version légère
 */
export interface JsonExportLight {
    format: 'roo-conversation-light';
    version: string;
    exportTime: string;
    summary: {
        totalConversations: number;
        totalMessages: number;
        totalSize: number;
        dateRange: {
            earliest: string;
            latest: string;
        };
    };
    conversations: JsonConversationSkeleton[];
    drillDown: {
        available: boolean;
        endpoint: string;
        fullDataEndpoint: string;
    };
}

/**
 * Squelette de conversation pour export JSON
 */
export interface JsonConversationSkeleton {
    taskId: string;
    firstUserMessage: string;
    isCompleted: boolean;
    workspace: string;
    createdAt: string;
    lastActivity: string;
    messageCount: number;
    actionCount: number;
    totalSize: number;
    children: string[];
}

/**
 * Formats d'export JSON - Version complète
 */
export interface JsonExportFull {
    format: 'roo-conversation-full';
    version: string;
    exportTime: string;
    task: {
        taskId: string;
        metadata: {
            createdAt: string;
            lastActivity: string;
            messageCount: number;
            actionCount: number;
            totalSize: number;
            workspace: string;
            location?: string;
        };
        messages: JsonMessage[];
        children: string[];
    };
}

/**
 * Message pour export JSON
 */
export interface JsonMessage {
    role: 'user' | 'assistant';
    timestamp: string;
    content: string;
    isTruncated: boolean;
    toolCalls: JsonToolCall[];
}

/**
 * Appel d'outil pour export JSON
 */
export interface JsonToolCall {
    toolName: string;
    serverName?: string;
    arguments: Record<string, any>;
    result: string;
    success: boolean;
}

/**
 * Enregistrement conversation pour export CSV
 */
export interface CsvConversationRecord {
    taskId: string;
    workspace: string;
    isCompleted: boolean;
    createdAt: string;
    lastActivity: string;
    messageCount: number;
    actionCount: number;
    totalSize: number;
    firstUserMessage: string;
}

/**
 * Enregistrement message pour export CSV
 */
export interface CsvMessageRecord {
    taskId: string;
    messageIndex: number;
    role: string;
    timestamp: string;
    contentLength: number;
    isTruncated: boolean;
    toolCount: number;
    workspace: string;
}

/**
 * Enregistrement outil pour export CSV
 */
export interface CsvToolRecord {
    taskId: string;
    messageIndex: number;
    toolName: string;
    serverName: string;
    executionTime: string;
    success: boolean;
    argsCount: number;
    resultLength: number;
    workspace: string;
}

/**
 * Type de message pour la bijection TOC ↔ Corps
 */
export type MsgType = 'assistant' | 'outil' | 'user' | 'erreur' | 'condensation' | 'new-instructions' | 'completion';

/**
 * Item unifié pour la source unique TOC + Corps
 */
export interface RenderItem {
    type: MsgType;
    n: number;
    title: string;
    html: string;
    originalIndex?: number;
    toolType?: string;
    resultType?: string;
    sid?: string;      // ID de section stable (assigné une fois)
    tid?: string;      // ID TOC stable = 'toc-' + sid (assigné une fois)
    lineNumber?: number; // Ligne de référence dans le source
}
