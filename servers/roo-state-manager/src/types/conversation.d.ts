/**
 * Types pour la gestion des conversations et du stockage Roo
 * Basés sur les découvertes du stockage Roo existant
 */
export interface ApiMessage {
    role: 'user' | 'assistant';
    content: string | Array<{
        type: 'text' | 'image';
        text?: string;
        source?: {
            type: 'base64';
            media_type: string;
            data: string;
        };
    }>;
    timestamp?: string;
}
export interface ApiConversationHistory {
    messages: ApiMessage[];
    model?: string;
    max_tokens?: number;
    temperature?: number;
}
export interface ClineMessage {
    id: string;
    type: 'ask' | 'say' | 'completion_result' | 'tool_use' | 'tool_result';
    text?: string;
    tool?: string;
    toolInput?: any;
    toolResult?: any;
    timestamp: string;
    isError?: boolean;
}
export interface UiMessages {
    messages: ClineMessage[];
}
export interface TaskMetadata {
    taskId: string;
    createdAt: string;
    updatedAt: string;
    title?: string;
    description?: string;
    mode?: string;
    status: 'active' | 'completed' | 'archived';
    totalMessages: number;
    totalTokens?: number;
    cost?: number;
    files_in_context?: FileInContext[];
}
export interface FileInContext {
    path: string;
    record_state: 'active' | 'stale';
    record_source: 'read_tool' | 'roo_edited' | 'user_edited';
    lastRead?: string;
    lastModified?: string;
    size?: number;
}
export interface TaskHistoryEntry {
    id: string;
    name: string;
    createdAt: string;
    isRunning: boolean;
    totalCost: number;
}
export interface GlobalTaskHistory {
    tasks: TaskHistoryEntry[];
}
export interface RooStorageLocation {
    globalStoragePath: string;
    tasksPath: string;
    settingsPath: string;
    exists: boolean;
}
export interface ConversationSummary {
    taskId: string;
    path: string;
    metadata: TaskMetadata | null;
    messageCount: number;
    lastActivity: string;
    hasApiHistory: boolean;
    hasUiMessages: boolean;
    size: number;
}
export interface RooStorageDetectionResult {
    found: boolean;
    locations: RooStorageLocation[];
    conversations: ConversationSummary[];
    totalConversations: number;
    totalSize: number;
    errors: string[];
}
export interface RooSettings {
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    customInstructions?: string;
    [key: string]: any;
}
export interface RooConfiguration {
    settings: RooSettings;
    modes?: any[];
    servers?: any[];
}
export interface BackupMetadata {
    version: string;
    createdAt: string;
    source: string;
    conversationCount: number;
    totalSize: number;
}
export interface ConversationBackup {
    metadata: BackupMetadata;
    conversations: ConversationSummary[];
    configurations: RooConfiguration;
}
export declare class RooStorageError extends Error {
    code: string;
    constructor(message: string, code: string);
}
export declare class ConversationNotFoundError extends RooStorageError {
    constructor(taskId: string);
}
export declare class InvalidStoragePathError extends RooStorageError {
    constructor(path: string);
}
//# sourceMappingURL=conversation.d.ts.map