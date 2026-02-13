/**
 * Service d'archivage cross-machine des taches sur GDrive
 *
 * Archive les taches completes au format agnostique lors de l'indexation Qdrant,
 * permettant la recuperation cross-machine via le repertoire partage RooSync.
 *
 * Source primaire: ui_messages.json (complet, non-compacte)
 * Fallback: api_conversation_history.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { ArchivedTask, ArchivedTaskMessage } from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MAX_CONTENT_LENGTH = 10 * 1024; // 10KB - tronquer les tool results volumineux

function getHostIdentifier(): string {
    return `${os.hostname()}-${os.platform()}-${os.arch()}`;
}

function getMachineId(): string {
    return os.hostname().toLowerCase();
}

function truncateContent(content: string): string {
    if (content.length <= MAX_CONTENT_LENGTH) return content;
    return content.substring(0, MAX_CONTENT_LENGTH) + '\n[... truncated ...]';
}

interface UiMessage {
    author: 'user' | 'agent';
    text: string;
    timestamp: string;
}

interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | any[];
    timestamp?: string;
}

function transformUiMessages(messages: UiMessage[]): ArchivedTaskMessage[] {
    return messages
        .filter(msg => msg.text && msg.text.trim().length > 0)
        .map(msg => ({
            role: (msg.author === 'agent' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: truncateContent(msg.text),
            timestamp: msg.timestamp,
        }));
}

function transformApiMessages(messages: ApiMessage[]): ArchivedTaskMessage[] {
    return messages
        .filter(msg => msg.role !== 'system' && msg.content)
        .map(msg => {
            const content = typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content);
            return {
                role: msg.role as 'user' | 'assistant',
                content: truncateContent(content),
                timestamp: msg.timestamp,
            };
        });
}

function getArchiveBasePath(): string {
    return path.join(getSharedStatePath(), 'task-archive');
}

export class TaskArchiver {
    /**
     * Archive une tache complete sur GDrive.
     * Non-bloquant: les erreurs sont logguees mais ne remontent pas.
     */
    static async archiveTask(
        taskId: string,
        taskPath: string,
        skeleton: ConversationSkeleton
    ): Promise<void> {
        const machineId = getMachineId();
        const archiveDir = path.join(getArchiveBasePath(), machineId);
        const archivePath = path.join(archiveDir, `${taskId}.json.gz`);

        // Verifier si deja archive (eviter re-ecriture inutile)
        try {
            await fs.access(archivePath);
            return; // Deja archive
        } catch {
            // Fichier n'existe pas, on continue
        }

        // Lire les messages: ui_messages.json (primaire) ou api_conversation_history.json (fallback)
        let messages: ArchivedTaskMessage[];
        const uiPath = path.join(taskPath, 'ui_messages.json');
        const apiPath = path.join(taskPath, 'api_conversation_history.json');

        try {
            const uiContent = await fs.readFile(uiPath, 'utf-8');
            const uiMessages: UiMessage[] = JSON.parse(uiContent);
            messages = transformUiMessages(uiMessages);
        } catch {
            try {
                const apiContent = await fs.readFile(apiPath, 'utf-8');
                const apiMessages: ApiMessage[] = JSON.parse(apiContent);
                messages = transformApiMessages(apiMessages);
            } catch {
                console.warn(`[ARCHIVE] No message files found for task ${taskId}`);
                return;
            }
        }

        if (messages.length === 0) {
            return;
        }

        const archived: ArchivedTask = {
            version: 1,
            taskId,
            machineId,
            hostIdentifier: getHostIdentifier(),
            archivedAt: new Date().toISOString(),
            metadata: {
                title: skeleton.metadata?.title || 'Untitled',
                workspace: skeleton.metadata?.workspace,
                mode: skeleton.metadata?.mode,
                createdAt: skeleton.metadata?.createdAt,
                lastActivity: skeleton.metadata?.lastActivity,
                messageCount: messages.length,
                isCompleted: skeleton.isCompleted || false,
                parentTaskId: skeleton.parentTaskId,
            },
            messages,
        };

        // Creer le repertoire et ecrire le fichier compresse
        await fs.mkdir(archiveDir, { recursive: true });
        const jsonData = JSON.stringify(archived);
        const compressed = await gzipAsync(Buffer.from(jsonData, 'utf-8'));
        await fs.writeFile(archivePath, compressed);

        console.log(`[ARCHIVE] Task ${taskId} archived (${messages.length} msgs, ${compressed.length} bytes gz)`);
    }

    /**
     * Lit une tache archivee depuis GDrive (toutes machines).
     * Retourne null si non trouvee.
     */
    static async readArchivedTask(taskId: string): Promise<ArchivedTask | null> {
        const archiveBase = getArchiveBasePath();

        let machineDirs: string[];
        try {
            machineDirs = await fs.readdir(archiveBase);
        } catch {
            return null; // Repertoire d'archive n'existe pas
        }

        for (const machineDir of machineDirs) {
            const archivePath = path.join(archiveBase, machineDir, `${taskId}.json.gz`);
            try {
                const compressed = await fs.readFile(archivePath);
                const decompressed = await gunzipAsync(compressed);
                const archived: ArchivedTask = JSON.parse(decompressed.toString('utf-8'));
                return archived;
            } catch {
                continue; // Pas dans ce repertoire machine
            }
        }

        return null;
    }

    /**
     * Liste les taches archivees, optionnellement filtrees par machine.
     */
    static async listArchivedTasks(machineId?: string): Promise<string[]> {
        const archiveBase = getArchiveBasePath();
        const taskIds: string[] = [];

        let machineDirs: string[];
        try {
            machineDirs = machineId ? [machineId] : await fs.readdir(archiveBase);
        } catch {
            return [];
        }

        for (const dir of machineDirs) {
            const dirPath = path.join(archiveBase, dir);
            try {
                const files = await fs.readdir(dirPath);
                for (const file of files) {
                    if (file.endsWith('.json.gz')) {
                        taskIds.push(file.replace('.json.gz', ''));
                    }
                }
            } catch {
                continue;
            }
        }

        return taskIds;
    }
}
