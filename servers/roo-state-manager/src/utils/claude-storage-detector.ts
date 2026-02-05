/**
 * Détecteur automatique du stockage Claude Code
 * Identifie et analyse les emplacements de stockage des conversations Claude Code
 *
 * Architecture compatible avec RooStorageDetector pour réutilisation maximale
 * des services existants (summary, indexing, etc.)
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    ConversationSkeleton,
    MessageSkeleton,
    ActionMetadata,
} from '../types/conversation.js';
import {
    ClaudeStorageLocation,
    ClaudeJsonlEntry,
    ClaudeDetectionResult,
    ClaudeParsingOptions,
} from '../types/claude-storage.js';

/**
 * Détecteur pour les conversations Claude Code
 */
export class ClaudeStorageDetector {
    // Nom du répertoire de stockage Claude Code
    private static readonly CLAUDE_PROJECTS_DIR = 'projects';
    private static readonly CLAUDE_CONFIG_DIR = '.claude';

    // Patterns pour détecter les noms de projets Claude
    private static readonly PROJECT_NAME_PATTERNS = [
        /^c--.+$/,           // Format: c--project-name
        /^[a-f0-9-]{36}$/,   // UUID
    ];

    /**
     * Détecte les emplacements de stockage Claude Code
     * @returns Promesse avec la liste des emplacements trouvés
     */
    public static async detectStorageLocations(): Promise<ClaudeStorageLocation[]> {
        const locations: ClaudeStorageLocation[] = [];

        // Chercher dans le home directory
        const homeDir = os.homedir();
        const claudePath = path.join(homeDir, ClaudeStorageDetector.CLAUDE_CONFIG_DIR, ClaudeStorageDetector.CLAUDE_PROJECTS_DIR);

        try {
            await fs.access(claudePath);
            const projects = await this.listProjects(claudePath);

            for (const projectName of projects) {
                const projectPath = path.join(claudePath, projectName);
                locations.push({
                    path: claudePath,
                    type: 'local',
                    projectName,
                    projectPath,
                });
            }
        } catch {
            // Le répertoire n'existe pas, ignorer
        }

        // Chercher dans les chemins alternatifs (Windows)
        const appDataPath = process.env.APPDATA
            ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', ClaudeStorageDetector.CLAUDE_CONFIG_DIR, ClaudeStorageDetector.CLAUDE_PROJECTS_DIR)
            : null;

        if (appDataPath) {
            try {
                await fs.access(appDataPath);
                const projects = await this.listProjects(appDataPath);

                for (const projectName of projects) {
                    const projectPath = path.join(appDataPath, projectName);
                    // Éviter les doublons
                    if (!locations.some(l => l.projectPath === projectPath)) {
                        locations.push({
                            path: appDataPath,
                            type: 'local',
                            projectName,
                            projectPath,
                        });
                    }
                }
            } catch {
                // Le répertoire n'existe pas, ignorer
            }
        }

        return locations;
    }

    /**
     * Liste tous les projets dans un répertoire donné
     */
    public static async listProjects(projectsPath: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(projectsPath, { withFileTypes: true });
            return entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .filter(name => this.isLikelyClaudeProject(name));
        } catch {
            return [];
        }
    }

    /**
     * Vérifie si un nom ressemble à un projet Claude
     */
    private static isLikelyClaudeProject(name: string): boolean {
        return this.PROJECT_NAME_PATTERNS.some(pattern => pattern.test(name));
    }

    /**
     * Valide un chemin de stockage personnalisé
     */
    public static async validateCustomPath(customPath: string): Promise<boolean> {
        try {
            const normalizedPath = path.resolve(customPath);
            const stats = await fs.stat(normalizedPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Parse une ligne JSONL
     */
    public static async parseJsonlLine(line: string): Promise<ClaudeJsonlEntry | null> {
        try {
            const trimmed = line.trim();
            if (!trimmed) {
                return null;
            }

            const entry = JSON.parse(trimmed) as ClaudeJsonlEntry;

            // Validation basique
            if (!entry.type || !entry.timestamp) {
                return null;
            }

            return entry;
        } catch {
            return null;
        }
    }

    /**
     * Analyse une conversation et la transforme en ConversationSkeleton
     * Compatible avec l'architecture Roo existante
     */
    public static async analyzeConversation(
        taskId: string,
        projectPath: string,
        options: ClaudeParsingOptions = {}
    ): Promise<ConversationSkeleton | null> {
        const {
            includeToolResults = true,
            maxContentLength = 400,
            includeExtendedMetadata = false,
        } = options;

        try {
            // Vérifier que le répertoire existe
            const stats = await fs.stat(projectPath);
            if (!stats.isDirectory()) {
                return null;
            }

            // Lister les fichiers JSONL dans le répertoire
            const entries = await fs.readdir(projectPath);
            const jsonlFiles = entries.filter(e => e.endsWith('.jsonl'));

            if (jsonlFiles.length === 0) {
                // Aucun fichier JSONL trouvé
                return this.createMinimalSkeleton(taskId, projectPath);
            }

            // Parser tous les fichiers JSONL
            const allEntries: ClaudeJsonlEntry[] = [];
            let totalSize = 0;

            for (const file of jsonlFiles) {
                const filePath = path.join(projectPath, file);
                const fileStats = await fs.stat(filePath);
                totalSize += fileStats.size;

                const entries = await this.parseJsonlFile(filePath);
                allEntries.push(...entries);
            }

            if (allEntries.length === 0) {
                return this.createMinimalSkeleton(taskId, projectPath, totalSize);
            }

            // Transformer les entrées en séquence
            const sequence = await this.buildSequenceFromEntries(allEntries, {
                includeToolResults,
                maxContentLength,
            });

            // Extraire les métadonnées
            const metadata = this.extractMetadata(allEntries, taskId, projectPath, totalSize);

            // Détecter le workspace
            const workspace = await this.detectWorkspace(allEntries, projectPath);

            return {
                taskId,
                sequence,
                metadata: {
                    ...metadata,
                    workspace,
                },
            };
        } catch (error) {
            console.error(`[ClaudeStorageDetector] Error analyzing conversation ${taskId}:`, error);
            return null;
        }
    }

    /**
     * Parse un fichier JSONL complet
     */
    private static async parseJsonlFile(filePath: string): Promise<ClaudeJsonlEntry[]> {
        const entries: ClaudeJsonlEntry[] = [];

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');

            for (const line of lines) {
                const entry = await this.parseJsonlLine(line);
                if (entry) {
                    entries.push(entry);
                }
            }
        } catch (error) {
            console.error(`[ClaudeStorageDetector] Error parsing JSONL file ${filePath}:`, error);
        }

        return entries;
    }

    /**
     * Construit une séquence à partir des entrées JSONL
     */
    private static async buildSequenceFromEntries(
        entries: ClaudeJsonlEntry[],
        options: { includeToolResults: boolean; maxContentLength: number }
    ): Promise<(MessageSkeleton | ActionMetadata)[]> {
        const sequence: (MessageSkeleton | ActionMetadata)[] = [];

        for (const entry of entries) {
            const timestamp = entry.timestamp;

            // Messages user/assistant
            if (entry.type === 'user' || entry.type === 'assistant') {
                if (entry.message) {
                    const content = this.extractContent(entry.message.content, options.maxContentLength);
                    const isTruncated = this.getContentLength(entry.message.content) > options.maxContentLength;

                    sequence.push({
                        role: entry.message.role,
                        content,
                        timestamp,
                        isTruncated,
                    });
                }
            }
            // Résultats de commande
            else if (entry.type === 'command_result' && entry.command) {
                sequence.push({
                    type: 'command',
                    name: entry.command.command,
                    status: entry.command.exitCode === 0 ? 'success' : 'failure',
                    parameters: { exitCode: entry.command.exitCode },
                    timestamp,
                    line_count: entry.command.output.split('\n').length,
                    content_size: entry.command.output.length,
                });
            }
            // Résultats de lecture
            else if (entry.type === 'read_result' && entry.readResult) {
                sequence.push({
                    type: 'tool',
                    name: 'read_file',
                    status: 'success',
                    parameters: { filePath: entry.readResult.filePath },
                    timestamp,
                    file_path: entry.readResult.filePath,
                    line_count: entry.readResult.lineCount,
                    content_size: entry.readResult.content.length,
                });
            }
            // Résultats d'outil
            else if (entry.type === 'tool_result' && entry.toolResult && options.includeToolResults) {
                sequence.push({
                    type: 'tool',
                    name: entry.toolResult.name,
                    status: 'success',
                    parameters: {},
                    timestamp,
                    content_size: JSON.stringify(entry.toolResult.result).length,
                });
            }
        }

        // Trier par timestamp
        return sequence.sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    }

    /**
     * Extrait le contenu textuel d'un message Claude
     */
    private static extractContent(content: string | any[], maxLength: number): string {
        let text = '';

        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            // Extraire le texte des blocks
            const textBlocks = content
                .filter((block: any) => block.type === 'text' && block.text)
                .map((block: any) => block.text);
            text = textBlocks.join('\n\n');
        }

        if (text.length > maxLength) {
            const half = Math.floor(maxLength / 2);
            return `${text.substring(0, half)}...${text.substring(text.length - half)}`;
        }

        return text;
    }

    /**
     * Calcule la longueur réelle du contenu
     */
    private static getContentLength(content: string | any[]): number {
        if (typeof content === 'string') {
            return content.length;
        } else if (Array.isArray(content)) {
            return JSON.stringify(content).length;
        }
        return 0;
    }

    /**
     * Extrait les métadonnées des entrées
     */
    private static extractMetadata(
        entries: ClaudeJsonlEntry[],
        taskId: string,
        projectPath: string,
        totalSize: number
    ): ConversationSkeleton['metadata'] {
        const messageCount = entries.filter(e => e.type === 'user' || e.type === 'assistant').length;
        const actionCount = entries.filter(e =>
            e.type === 'command_result' ||
            e.type === 'read_result' ||
            e.type === 'tool_result'
        ).length;

        // Timestamps
        const timestamps = entries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
        const createdAt = timestamps.length > 0
            ? new Date(Math.min(...timestamps)).toISOString()
            : new Date().toISOString();
        const lastActivity = timestamps.length > 0
            ? new Date(Math.max(...timestamps)).toISOString()
            : new Date().toISOString();

        // Titre (premier message utilisateur)
        const title = this.extractTitle(entries);

        return {
            title,
            createdAt,
            lastActivity,
            messageCount,
            actionCount,
            totalSize,
            dataSource: projectPath,
        };
    }

    /**
     * Extrait le titre de la conversation
     */
    private static extractTitle(entries: ClaudeJsonlEntry[]): string | undefined {
        const firstUserEntry = entries.find(e => e.type === 'user');
        if (firstUserEntry?.message?.content) {
            const content = this.extractContent(firstUserEntry.message.content, 100);
            return content.split('\n')[0].substring(0, 80);
        }
        return undefined;
    }

    /**
     * Détecte le workspace depuis les entrées
     */
    private static async detectWorkspace(
        entries: ClaudeJsonlEntry[],
        projectPath: string
    ): Promise<string | undefined> {
        // Chercher dans les métadonnées des fichiers
        for (const entry of entries) {
            if (entry.metadata?.files && entry.metadata.files.length > 0) {
                const firstFile = entry.metadata.files[0];
                // Extraire le workspace depuis le chemin du fichier
                const match = firstFile.match(/([\\/][^\\/]+[\\/][^\\/]+)/);
                if (match) {
                    return match[1].replace(/^[\\/]+/, '');
                }
            }

            // Chercher dans readResult
            if (entry.readResult?.filePath) {
                const match = entry.readResult.filePath.match(/([\\/][^\\/]+[\\/][^\\/]+)/);
                if (match) {
                    return match[1].replace(/^[\\/]+/, '');
                }
            }

            // Chercher dans le contenu des messages
            if (entry.message?.content && typeof entry.message.content === 'string') {
                const workspaceMatch = entry.message.content.match(/Current working directory[^\n]*\n([^\n]+)/);
                if (workspaceMatch && workspaceMatch[1]) {
                    return workspaceMatch[1].trim();
                }
            }
        }

        // Fallback: essayer d'extraire depuis le nom du projet
        const projectName = path.basename(projectPath);
        if (projectName.startsWith('c--')) {
            return projectName.replace(/^c--/, '').replace(/-/g, '/');
        }

        return undefined;
    }

    /**
     * Crée un squelette minimal pour les conversations vides
     */
    private static createMinimalSkeleton(
        taskId: string,
        projectPath: string,
        totalSize: number = 0
    ): ConversationSkeleton {
        const now = new Date().toISOString();
        return {
            taskId,
            sequence: [],
            metadata: {
                createdAt: now,
                lastActivity: now,
                messageCount: 0,
                actionCount: 0,
                totalSize,
                dataSource: projectPath,
            },
        };
    }

    /**
     * Analyse une conversation par son ID
     */
    public static async findConversationById(taskId: string): Promise<ConversationSkeleton | null> {
        const locations = await this.detectStorageLocations();

        for (const location of locations) {
            // Chercher dans tous les projets
            const projects = await this.listProjects(location.path);

            for (const projectName of projects) {
                const projectPath = path.join(location.path, projectName);

                // Vérifier si c'est la bonne conversation
                const skeleton = await this.analyzeConversation(taskId, projectPath);
                if (skeleton) {
                    return skeleton;
                }
            }
        }

        return null;
    }

    /**
     * Obtient les statistiques de stockage
     */
    public static async getStorageStats(): Promise<{
        totalLocations: number;
        totalConversations: number;
        totalSize: number;
    }> {
        const locations = await this.detectStorageLocations();
        let totalConversations = 0;
        let totalSize = 0;

        for (const location of locations) {
            const projects = await this.listProjects(location.path);

            for (const projectName of projects) {
                const projectPath = path.join(location.path, projectName);

                try {
                    const entries = await fs.readdir(projectPath);
                    const jsonlFiles = entries.filter(e => e.endsWith('.jsonl'));

                    for (const file of jsonlFiles) {
                        const filePath = path.join(projectPath, file);
                        const stats = await fs.stat(filePath);
                        totalSize += stats.size;
                        totalConversations++;
                    }
                } catch {
                    // Ignorer les erreurs
                }
            }
        }

        return {
            totalLocations: locations.length,
            totalConversations,
            totalSize,
        };
    }
}
