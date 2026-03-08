/**
 * Service d'archivage cross-machine des taches sur GDrive
 *
 * Archive les taches completes au format agnostique lors de l'indexation Qdrant,
 * permettant la recuperation cross-machine via le repertoire partage RooSync.
 *
 * Sources supportees:
 * - Roo: ui_messages.json (primaire) ou api_conversation_history.json (fallback)
 * - Claude Code: *.jsonl (JSON Lines format, une conversation par fichier)
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
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

interface ClaudeCodeJsonlLine {
    sessionId?: string;
    agentId?: string;
    type?: string;
    message?: {
        role: 'user' | 'assistant' | 'system';
        content: string;
    };
    timestamp?: string;
    uuid?: string;
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

/**
 * Lis un fichier JSONL (Claude Code session format)
 * Chaque ligne est un objet JSON avec un message embedded
 */
async function readJsonlFile(filePath: string): Promise<ClaudeCodeJsonlLine[]> {
    const lines: ClaudeCodeJsonlLine[] = [];

    return new Promise((resolve, reject) => {
        const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            if (line.trim().length === 0) return;
            try {
                const obj = JSON.parse(line);
                lines.push(obj);
            } catch (err) {
                console.warn(`[ARCHIVE] Failed to parse JSONL line: ${err}`);
            }
        });

        rl.on('close', () => {
            resolve(lines);
        });

        rl.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Transforme les messages Claude Code JSONL en format standard ArchivedTaskMessage
 */
function transformClaudeCodeJsonl(jsonlLines: ClaudeCodeJsonlLine[]): ArchivedTaskMessage[] {
    return jsonlLines
        .filter(line => line.message && line.message.content && line.message.content.trim().length > 0)
        .map(line => ({
            role: line.message!.role as 'user' | 'assistant',
            content: truncateContent(line.message!.content),
            timestamp: line.timestamp || new Date().toISOString(),
        }));
}

function getArchiveBasePath(): string {
    return path.join(getSharedStatePath(), 'task-archive');
}

export class TaskArchiver {
    /**
     * Archive une tache Roo complete sur GDrive.
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
                source: 'roo',
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
     * Archive une session Claude Code depuis un fichier JSONL
     * Stocke sur GDrive avec un prefixe "claude-" pour distinguer des taches Roo
     */
    static async archiveClaudeCodeSession(
        sessionId: string,
        jsonlPath: string,
        title?: string
    ): Promise<void> {
        const machineId = getMachineId();
        const archiveDir = path.join(getArchiveBasePath(), machineId);
        const archivePath = path.join(archiveDir, `claude-${sessionId}.json.gz`);

        // Verifier si deja archive
        try {
            await fs.access(archivePath);
            return; // Deja archive
        } catch {
            // Fichier n'existe pas, on continue
        }

        // Lire le fichier JSONL
        let messages: ArchivedTaskMessage[];
        try {
            const jsonlLines = await readJsonlFile(jsonlPath);
            messages = transformClaudeCodeJsonl(jsonlLines);
        } catch (err) {
            console.warn(`[ARCHIVE] Failed to read JSONL file ${jsonlPath}: ${err}`);
            return;
        }

        if (messages.length === 0) {
            return;
        }

        // Deduire le titre du chemin si non fourni
        const deducedTitle = title || path.basename(path.dirname(jsonlPath));

        const archived: ArchivedTask = {
            version: 1,
            taskId: sessionId,
            machineId,
            hostIdentifier: getHostIdentifier(),
            archivedAt: new Date().toISOString(),
            metadata: {
                title: deducedTitle,
                messageCount: messages.length,
                isCompleted: true,
                source: 'claude-code',
            },
            messages,
        };

        // Creer le repertoire et ecrire le fichier compresse
        await fs.mkdir(archiveDir, { recursive: true });
        const jsonData = JSON.stringify(archived);
        const compressed = await gzipAsync(Buffer.from(jsonData, 'utf-8'));
        await fs.writeFile(archivePath, compressed);

        console.log(`[ARCHIVE] Claude Code session ${sessionId} archived (${messages.length} msgs, ${compressed.length} bytes gz)`);
    }

    /**
     * Collecte et archive toutes les sessions Claude Code d'un repertoire
     * Utile pour archivage batch initial
     */
    static async archiveClaudeCodeSessions(
        projectsBasePath: string,
        maxSessions?: number
    ): Promise<{ archived: number; failed: number }> {
        let archivedCount = 0;
        let failedCount = 0;
        let processedCount = 0;

        try {
            const projects = await fs.readdir(projectsBasePath);

            for (const project of projects) {
                const projectPath = path.join(projectsBasePath, project);
                const stat = await fs.stat(projectPath);
                if (!stat.isDirectory()) continue;

                try {
                    const sessionDirs = await fs.readdir(projectPath);
                    for (const sessionDir of sessionDirs) {
                        const sessionPath = path.join(projectPath, sessionDir);
                        const sessionStat = await fs.stat(sessionPath);
                        if (!sessionStat.isDirectory()) continue;

                        // Chercher des fichiers JSONL dans ce repertoire ou sous-repertoires
                        const jsonlFiles = await TaskArchiver.findJsonlFiles(sessionPath);
                        for (const jsonlFile of jsonlFiles) {
                            try {
                                const sessionId = `${project}/${sessionDir}/${path.basename(jsonlFile, '.jsonl')}`;
                                await TaskArchiver.archiveClaudeCodeSession(sessionId, jsonlFile);
                                archivedCount++;
                            } catch (err) {
                                console.error(`[ARCHIVE] Failed to archive ${jsonlFile}: ${err}`);
                                failedCount++;
                            }

                            processedCount++;
                            if (maxSessions && processedCount >= maxSessions) {
                                return { archived: archivedCount, failed: failedCount };
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[ARCHIVE] Error processing project ${project}: ${err}`);
                }
            }
        } catch (err) {
            console.error(`[ARCHIVE] Error reading projects directory: ${err}`);
        }

        return { archived: archivedCount, failed: failedCount };
    }

    /**
     * Trouve tous les fichiers JSONL dans un repertoire (recursif)
     */
    private static async findJsonlFiles(dirPath: string, maxDepth: number = 5, currentDepth: number = 0): Promise<string[]> {
        const files: string[] = [];

        if (currentDepth >= maxDepth) {
            return files;
        }

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    files.push(fullPath);
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const subFiles = await TaskArchiver.findJsonlFiles(fullPath, maxDepth, currentDepth + 1);
                    files.push(...subFiles);
                }
            }
        } catch (err) {
            console.warn(`[ARCHIVE] Error reading directory ${dirPath}: ${err}`);
        }

        return files;
    }

    /**
     * Lit une tache archivee depuis GDrive (toutes machines).
     * Supporte les deux formats: Roo ({taskId}.json.gz) et Claude Code (claude-{taskId}.json.gz)
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
            // Essayer d'abord le format Roo
            const rooArchivePath = path.join(archiveBase, machineDir, `${taskId}.json.gz`);
            try {
                const compressed = await fs.readFile(rooArchivePath);
                const decompressed = await gunzipAsync(compressed);
                const archived: ArchivedTask = JSON.parse(decompressed.toString('utf-8'));
                return archived;
            } catch {
                // Essayer le format Claude Code
                const claudeArchivePath = path.join(archiveBase, machineDir, `claude-${taskId}.json.gz`);
                try {
                    const compressed = await fs.readFile(claudeArchivePath);
                    const decompressed = await gunzipAsync(compressed);
                    const archived: ArchivedTask = JSON.parse(decompressed.toString('utf-8'));
                    return archived;
                } catch {
                    // Pas dans ce repertoire machine
                    continue;
                }
            }
        }

        return null;
    }

    /**
     * Liste les taches archivees (Roo et Claude Code), optionnellement filtrees par machine.
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
                        const taskId = file.replace('.json.gz', '');
                        taskIds.push(taskId);
                    }
                }
            } catch {
                continue;
            }
        }

        return taskIds;
    }

    /**
     * Liste les taches archivees filtrees par source (roo ou claude-code)
     */
    static async listArchivedTasksBySource(source: 'roo' | 'claude-code', machineId?: string): Promise<string[]> {
        const archiveBase = getArchiveBasePath();
        const taskIds: string[] = [];
        const prefix = source === 'claude-code' ? 'claude-' : '';

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
                        if (prefix === '') {
                            // Roo tasks: files that don't start with 'claude-'
                            if (!file.startsWith('claude-')) {
                                taskIds.push(file.replace('.json.gz', ''));
                            }
                        } else {
                            // Claude Code tasks: files that start with 'claude-'
                            if (file.startsWith('claude-')) {
                                taskIds.push(file.replace('claude-', '').replace('.json.gz', ''));
                            }
                        }
                    }
                }
            } catch {
                continue;
            }
        }

        return taskIds;
    }
}
