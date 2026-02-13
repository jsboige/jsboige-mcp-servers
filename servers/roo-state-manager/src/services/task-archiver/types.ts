/**
 * Types pour l'archivage cross-machine des taches sur GDrive
 * Format agnostique Roo/Claude pour partage inter-machines
 */

export interface ArchivedTaskMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

export interface ArchivedTaskMetadata {
    title: string;
    workspace?: string;
    mode?: string;
    createdAt?: string;
    lastActivity?: string;
    messageCount: number;
    isCompleted: boolean;
    parentTaskId?: string;
}

export interface ArchivedTask {
    version: 1;
    taskId: string;
    machineId: string;
    hostIdentifier: string;
    archivedAt: string;
    metadata: ArchivedTaskMetadata;
    messages: ArchivedTaskMessage[];
}
