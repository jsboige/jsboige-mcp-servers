/**
 * Outil MCP consolidé : export_data
 *
 * CONS-10: Consolide 5 outils d'export en 1 outil unifié.
 * Remplace:
 *   - export_tasks_xml
 *   - export_conversation_xml
 *   - export_project_xml
 *   - export_conversation_json
 *   - export_conversation_csv
 *
 * @module tools/export/export-data
 * @version 1.0.0
 * @since CONS-10
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { XmlExporterService } from '../../services/XmlExporterService.js';
import { TraceSummaryService, SummaryOptions } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Types d'export supportés
 */
export type ExportTarget = 'task' | 'conversation' | 'project';
export type ExportFormat = 'xml' | 'json' | 'csv';

/**
 * Arguments consolidés du tool export_data
 */
export interface ExportDataArgs {
    /** Cible de l'export: task (une tâche), conversation (arbre), project (projet entier) */
    target: ExportTarget;
    /** Format de sortie: xml, json, csv */
    format: ExportFormat;
    /** ID de la tâche (requis pour target=task ou conversation avec json/csv) */
    taskId?: string;
    /** ID de la conversation racine (requis pour target=conversation avec xml) */
    conversationId?: string;
    /** Chemin du projet (requis pour target=project) */
    projectPath?: string;
    /** Chemin de sortie pour le fichier (optionnel, sinon retourne le contenu) */
    filePath?: string;

    // Options XML
    /** Inclure le contenu complet des messages (XML) */
    includeContent?: boolean;
    /** Indenter pour lisibilité (XML) */
    prettyPrint?: boolean;
    /** Profondeur max de l'arbre (XML conversation) */
    maxDepth?: number;
    /** Date de début filtre (XML project) */
    startDate?: string;
    /** Date de fin filtre (XML project) */
    endDate?: string;

    // Options JSON
    /** Variante JSON: light (squelette) ou full (détail complet) */
    jsonVariant?: 'light' | 'full';

    // Options CSV
    /** Variante CSV: conversations, messages, ou tools */
    csvVariant?: 'conversations' | 'messages' | 'tools';

    // Options communes JSON/CSV
    /** Nombre max de caractères avant troncature (0 = pas de troncature) */
    truncationChars?: number;
    /** Index de début (1-based) pour plage de messages */
    startIndex?: number;
    /** Index de fin (1-based) pour plage de messages */
    endIndex?: number;
}

/**
 * Définition du tool MCP consolidé
 */
export const exportDataTool: Tool = {
    name: 'export_data',
    description: `Outil consolidé pour exporter des données au format XML, JSON ou CSV.

Cibles supportées:
- task: Export d'une tâche individuelle (XML uniquement)
- conversation: Export d'une conversation complète (tous formats)
- project: Export d'un projet entier (XML uniquement)

Formats supportés:
- xml: Format XML structuré
- json: Format JSON avec variantes light/full
- csv: Format CSV avec variantes conversations/messages/tools

CONS-10: Remplace export_tasks_xml, export_conversation_xml, export_project_xml, export_conversation_json, export_conversation_csv`,
    inputSchema: {
        type: 'object',
        properties: {
            target: {
                type: 'string',
                enum: ['task', 'conversation', 'project'],
                description: 'Cible de l\'export: task, conversation, ou project'
            },
            format: {
                type: 'string',
                enum: ['xml', 'json', 'csv'],
                description: 'Format de sortie: xml, json, ou csv'
            },
            taskId: {
                type: 'string',
                description: 'ID de la tâche (requis pour target=task, ou conversation avec json/csv)'
            },
            conversationId: {
                type: 'string',
                description: 'ID de la conversation racine (requis pour target=conversation avec xml)'
            },
            projectPath: {
                type: 'string',
                description: 'Chemin du projet (requis pour target=project)'
            },
            filePath: {
                type: 'string',
                description: 'Chemin de sortie pour le fichier. Si non fourni, retourne le contenu.'
            },
            // Options XML
            includeContent: {
                type: 'boolean',
                description: 'Inclure le contenu complet des messages (XML, défaut: false)'
            },
            prettyPrint: {
                type: 'boolean',
                description: 'Indenter pour lisibilité (XML, défaut: true)'
            },
            maxDepth: {
                type: 'integer',
                description: 'Profondeur max de l\'arbre de tâches (XML conversation)'
            },
            startDate: {
                type: 'string',
                description: 'Date de début ISO 8601 pour filtrer (XML project)'
            },
            endDate: {
                type: 'string',
                description: 'Date de fin ISO 8601 pour filtrer (XML project)'
            },
            // Options JSON
            jsonVariant: {
                type: 'string',
                enum: ['light', 'full'],
                description: 'Variante JSON: light (squelette) ou full (détail complet)'
            },
            // Options CSV
            csvVariant: {
                type: 'string',
                enum: ['conversations', 'messages', 'tools'],
                description: 'Variante CSV: conversations, messages, ou tools'
            },
            // Options communes
            truncationChars: {
                type: 'number',
                description: 'Max caractères avant troncature (0 = pas de troncature)'
            },
            startIndex: {
                type: 'number',
                description: 'Index de début (1-based) pour plage de messages'
            },
            endIndex: {
                type: 'number',
                description: 'Index de fin (1-based) pour plage de messages'
            }
        },
        required: ['target', 'format']
    }
};

/**
 * Valide les combinaisons target/format supportées
 */
function validateTargetFormat(target: ExportTarget, format: ExportFormat): void {
    const validCombinations: Record<ExportTarget, ExportFormat[]> = {
        task: ['xml'],
        conversation: ['xml', 'json', 'csv'],
        project: ['xml']
    };

    if (!validCombinations[target].includes(format)) {
        throw new StateManagerError(
            `Combinaison target='${target}' / format='${format}' non supportée. ` +
            `Pour target='${target}', formats supportés: ${validCombinations[target].join(', ')}`,
            'INVALID_TARGET_FORMAT_COMBINATION',
            'ExportDataTool',
            { target, format, validFormats: validCombinations[target] }
        );
    }
}

/**
 * Valide que les paramètres requis sont présents
 */
function validateRequiredParams(args: ExportDataArgs): void {
    const { target, format, taskId, conversationId, projectPath } = args;

    if (target === 'task' && !taskId) {
        throw new StateManagerError(
            'taskId est requis pour target=task',
            'MISSING_REQUIRED_PARAM',
            'ExportDataTool',
            { target, missingParam: 'taskId' }
        );
    }

    if (target === 'conversation') {
        if (format === 'xml' && !conversationId) {
            throw new StateManagerError(
                'conversationId est requis pour target=conversation format=xml',
                'MISSING_REQUIRED_PARAM',
                'ExportDataTool',
                { target, format, missingParam: 'conversationId' }
            );
        }
        if ((format === 'json' || format === 'csv') && !taskId) {
            throw new StateManagerError(
                `taskId est requis pour target=conversation format=${format}`,
                'MISSING_REQUIRED_PARAM',
                'ExportDataTool',
                { target, format, missingParam: 'taskId' }
            );
        }
    }

    if (target === 'project' && !projectPath) {
        throw new StateManagerError(
            'projectPath est requis pour target=project',
            'MISSING_REQUIRED_PARAM',
            'ExportDataTool',
            { target, missingParam: 'projectPath' }
        );
    }
}

/**
 * Handler pour export XML d'une tâche individuelle
 */
async function handleTaskXml(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    const { taskId, filePath, includeContent = false, prettyPrint = true } = args;

    await ensureSkeletonCacheIsFresh();

    const skeleton = conversationCache.get(taskId!);
    if (!skeleton) {
        throw new StateManagerError(
            `Tâche avec l'ID '${taskId}' non trouvée dans le cache`,
            'TASK_NOT_FOUND',
            'ExportDataTool',
            { taskId, cacheSize: conversationCache.size }
        );
    }

    const xmlContent = (xmlExporterService as any).generateTaskXml(skeleton, {
        includeContent,
        prettyPrint
    });

    if (filePath) {
        await xmlExporterService.saveXmlToFile(xmlContent, filePath);
        return {
            content: [{
                type: 'text',
                text: `Export XML de la tâche '${taskId}' sauvegardé dans '${filePath}'.`
            }]
        };
    }

    return { content: [{ type: 'text', text: xmlContent }] };
}

/**
 * Handler pour export XML d'une conversation
 */
async function handleConversationXml(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    const { conversationId, filePath, maxDepth, includeContent = false, prettyPrint = true } = args;

    await ensureSkeletonCacheIsFresh();

    const rootSkeleton = conversationCache.get(conversationId!);
    if (!rootSkeleton) {
        throw new StateManagerError(
            `Conversation racine avec l'ID '${conversationId}' non trouvée`,
            'CONVERSATION_NOT_FOUND',
            'ExportDataTool',
            { conversationId, cacheSize: conversationCache.size }
        );
    }

    // Collecter toutes les tâches de la conversation
    const collectTasks = (taskId: string, currentDepth = 0): ConversationSkeleton[] => {
        if (maxDepth && currentDepth >= maxDepth) return [];

        const task = conversationCache.get(taskId);
        if (!task) return [];

        const tasks = [task];
        for (const [childTaskId, childTask] of conversationCache.entries()) {
            if (childTask.parentTaskId === taskId) {
                tasks.push(...collectTasks(childTaskId, currentDepth + 1));
            }
        }
        return tasks;
    };

    const allTasks = collectTasks(conversationId!);
    const xmlContent = (xmlExporterService as any).generateConversationXml(allTasks, {
        includeContent,
        prettyPrint
    });

    if (filePath) {
        await xmlExporterService.saveXmlToFile(xmlContent, filePath);
        return {
            content: [{
                type: 'text',
                text: `Export XML de la conversation '${conversationId}' sauvegardé dans '${filePath}'.`
            }]
        };
    }

    return { content: [{ type: 'text', text: xmlContent }] };
}

/**
 * Handler pour export XML d'un projet
 */
async function handleProjectXml(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: (options?: { workspace?: string }) => Promise<void>
): Promise<CallToolResult> {
    const { projectPath, filePath, startDate, endDate, prettyPrint = true } = args;

    await ensureSkeletonCacheIsFresh({ workspace: projectPath });

    // Filtrer les conversations par workspace et date
    const relevantTasks = Array.from(conversationCache.values()).filter(skeleton => {
        if (skeleton.metadata?.workspace) {
            const normalizedWorkspace = normalizePath(skeleton.metadata.workspace);
            const normalizedProject = normalizePath(projectPath!);
            if (normalizedWorkspace !== normalizedProject) return false;
        }

        if (startDate) {
            const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
            if (taskDate < new Date(startDate)) return false;
        }

        if (endDate) {
            const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
            if (taskDate > new Date(endDate)) return false;
        }

        return true;
    });

    const xmlContent = (xmlExporterService as any).generateProjectXml(relevantTasks, {
        projectPath,
        startDate,
        endDate,
        prettyPrint
    });

    if (filePath) {
        await xmlExporterService.saveXmlToFile(xmlContent, filePath);
        return {
            content: [{
                type: 'text',
                text: `Export XML du projet '${projectPath}' sauvegardé dans '${filePath}'.`
            }]
        };
    }

    return { content: [{ type: 'text', text: xmlContent }] };
}

/**
 * Handler pour export JSON d'une conversation
 */
async function handleConversationJson(
    args: ExportDataArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<CallToolResult> {
    const { taskId, filePath, jsonVariant = 'light', truncationChars = 0, startIndex, endIndex } = args;

    const conversation = await getConversationSkeleton(taskId!);
    if (!conversation) {
        throw new StateManagerError(
            `Conversation avec taskId ${taskId} introuvable`,
            'CONVERSATION_NOT_FOUND',
            'ExportDataTool',
            { taskId }
        );
    }

    const summaryOptions: SummaryOptions = {
        detailLevel: 'Full',
        outputFormat: 'json',
        jsonVariant,
        truncationChars,
        compactStats: false,
        includeCss: false,
        generateToc: false,
        startIndex,
        endIndex
    };

    const exportConfigManager = new ExportConfigManager();
    const summaryService = new TraceSummaryService(exportConfigManager);
    const result = await summaryService.generateSummary(conversation, summaryOptions);

    if (!result.success) {
        throw new StateManagerError(
            `Erreur lors de la génération JSON: ${result.error}`,
            'EXPORT_GENERATION_FAILED',
            'ExportDataTool',
            { taskId, error: result.error }
        );
    }

    if (filePath) {
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(filePath, result.content, 'utf8');

        return {
            content: [{
                type: 'text',
                text: `Export JSON (${jsonVariant}) de la tâche '${taskId}' sauvegardé dans '${filePath}'. ` +
                      `Taille: ${Math.round(result.content.length / 1024 * 10) / 10} KB`
            }]
        };
    }

    return { content: [{ type: 'text', text: result.content }] };
}

/**
 * Handler pour export CSV d'une conversation
 */
async function handleConversationCsv(
    args: ExportDataArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<CallToolResult> {
    const { taskId, filePath, csvVariant = 'conversations', truncationChars = 0, startIndex, endIndex } = args;

    const conversation = await getConversationSkeleton(taskId!);
    if (!conversation) {
        throw new StateManagerError(
            `Conversation avec taskId ${taskId} introuvable`,
            'CONVERSATION_NOT_FOUND',
            'ExportDataTool',
            { taskId }
        );
    }

    const summaryOptions: SummaryOptions = {
        detailLevel: 'Full',
        outputFormat: 'csv',
        csvVariant,
        truncationChars,
        compactStats: false,
        includeCss: false,
        generateToc: false,
        startIndex,
        endIndex
    };

    const exportConfigManager = new ExportConfigManager();
    const summaryService = new TraceSummaryService(exportConfigManager);
    const result = await summaryService.generateSummary(conversation, summaryOptions);

    if (!result.success) {
        throw new StateManagerError(
            `Erreur lors de la génération CSV: ${result.error}`,
            'EXPORT_GENERATION_FAILED',
            'ExportDataTool',
            { taskId, error: result.error }
        );
    }

    const csvLines = result.content.split('\n').length;

    if (filePath) {
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(filePath, result.content, 'utf8');

        return {
            content: [{
                type: 'text',
                text: `Export CSV (${csvVariant}) de la tâche '${taskId}' sauvegardé dans '${filePath}'. ` +
                      `${csvLines} lignes, ${Math.round(result.content.length / 1024 * 10) / 10} KB`
            }]
        };
    }

    return { content: [{ type: 'text', text: result.content }] };
}

/**
 * Handler principal consolidé pour export_data
 */
export async function handleExportData(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: (options?: { workspace?: string }) => Promise<void>,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<CallToolResult> {
    try {
        // Valider les arguments
        if (!args.target) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'Paramètre "target" requis. Valeurs: task, conversation, project'
                }]
            };
        }

        if (!args.format) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'Paramètre "format" requis. Valeurs: xml, json, csv'
                }]
            };
        }

        // Valider la combinaison target/format
        validateTargetFormat(args.target, args.format);

        // Valider les paramètres requis
        validateRequiredParams(args);

        // Router vers le handler approprié
        const { target, format } = args;

        if (target === 'task' && format === 'xml') {
            return await handleTaskXml(args, conversationCache, xmlExporterService, ensureSkeletonCacheIsFresh);
        }

        if (target === 'conversation') {
            if (format === 'xml') {
                return await handleConversationXml(args, conversationCache, xmlExporterService, ensureSkeletonCacheIsFresh);
            }
            if (format === 'json') {
                return await handleConversationJson(args, getConversationSkeleton);
            }
            if (format === 'csv') {
                return await handleConversationCsv(args, getConversationSkeleton);
            }
        }

        if (target === 'project' && format === 'xml') {
            return await handleProjectXml(args, conversationCache, xmlExporterService, ensureSkeletonCacheIsFresh);
        }

        // Cas non géré (ne devrait pas arriver si validation OK)
        return {
            isError: true,
            content: [{
                type: 'text',
                text: `Combinaison target='${target}' / format='${format}' non implémentée`
            }]
        };

    } catch (error) {
        if (error instanceof StateManagerError) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `Erreur: ${error.message} (${error.code})`
                }]
            };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{
                type: 'text',
                text: `Erreur lors de l'export: ${errorMessage}`
            }]
        };
    }
}
