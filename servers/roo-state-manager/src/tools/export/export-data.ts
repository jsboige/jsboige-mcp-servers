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
// #1841 Cluster H: task_export fusion — import task tree handlers
import { handleExportTaskTreeMarkdown, type ExportTaskTreeMarkdownArgs } from '../task/export-tree-md.tool.js';
import { handleDebugTaskParsing, type DebugTaskParsingArgs } from '../task/debug-parsing.tool.js';
import { handleGetTaskTree } from '../task/get-tree.tool.js';

/**
 * Types d'export supportés
 */
export type ExportTarget = 'task' | 'conversation' | 'project' | 'task_tree';
export type ExportFormat = 'xml' | 'json' | 'csv' | 'markdown' | 'debug';

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

    // #1841 Cluster H: task_tree export options (target=task_tree, format=markdown)
    /** Inclure les tâches sœurs dans l'arbre (target=task_tree) */
    includeSiblings?: boolean;
    /** ID de la tâche en cours pour marquage (target=task_tree) */
    currentTaskId?: string;
    /** Format de sortie arbre: ascii-tree, markdown, hierarchical, json (target=task_tree) */
    outputFormat?: 'ascii-tree' | 'markdown' | 'hierarchical' | 'json';
    /** Longueur max de l'instruction affichée (target=task_tree) */
    truncateInstruction?: number;
    /** Afficher les métadonnées détaillées (target=task_tree) */
    showMetadata?: boolean;
}

/**
 * Définition du tool MCP consolidé
 */
export const exportDataTool: Tool = {
    name: 'export_data',
    description: `Outil consolidé pour exporter des données au format XML, JSON, CSV ou Markdown.\n\nCibles supportées:\n- task: Export d'une tâche individuelle (XML, debug)\n- task_tree: Export d'un arbre de tâches (Markdown/ascii-tree/hierarchical/json)\n- conversation: Export d'une conversation complète (XML, JSON, CSV)\n- project: Export d'un projet entier (XML)\n\nCONS-10+H: Remplace export_tasks_xml, export_conversation_xml, export_project_xml, export_conversation_json, export_conversation_csv, task_export`,
    inputSchema: {
        type: 'object',
        properties: {
            target: {
                type: 'string',
                enum: ['task', 'conversation', 'project', 'task_tree'],
                description: "Cible de l'export: task, conversation, project, ou task_tree"
            },
            format: {
                type: 'string',
                enum: ['xml', 'json', 'csv', 'markdown', 'debug'],
                description: 'Format de sortie: xml, json, csv, markdown, ou debug'
            },
            taskId: {
                type: 'string',
                description: 'Task ID (required for target=task, or conversation with json/csv)'
            },
            conversationId: {
                type: 'string',
                description: 'Root conversation ID (required for target=conversation with xml)'
            },
            projectPath: {
                type: 'string',
                description: 'Project path (required for target=project)'
            },
            filePath: {
                type: 'string',
                description: 'Output file path. If omitted, returns content inline.'
            },
            // Options XML
            includeContent: {
                type: 'boolean',
                description: 'Include full message content (XML, default: false)'
            },
            prettyPrint: {
                type: 'boolean',
                description: 'Indent for readability (XML, default: true)'
            },
            maxDepth: {
                type: 'integer',
                description: 'Max tree depth (XML conversation)'
            },
            startDate: {
                type: 'string',
                description: 'ISO 8601 start date filter (XML project)'
            },
            endDate: {
                type: 'string',
                description: 'ISO 8601 end date filter (XML project)'
            },
            // Options JSON
            jsonVariant: {
                type: 'string',
                enum: ['light', 'full'],
                description: 'JSON variant: light (skeleton) or full (complete)'
            },
            // Options CSV
            csvVariant: {
                type: 'string',
                enum: ['conversations', 'messages', 'tools'],
                description: 'CSV variant: conversations, messages, or tools'
            },
            // Options communes
            truncationChars: {
                type: 'number',
                description: 'Max chars before truncation (0 = no truncation)'
            },
            startIndex: {
                type: 'number',
                description: 'Start index (1-based) for message range'
            },
            endIndex: {
                type: 'number',
                description: 'End index (1-based) for message range'
            },
            // #1841 Cluster H: task_tree export options
            includeSiblings: {
                type: 'boolean',
                description: 'Include sibling tasks in tree (target=task_tree, default: true)'
            },
            currentTaskId: {
                type: 'string',
                description: 'Current task ID for explicit marking (target=task_tree)'
            },
            outputFormat: {
                type: 'string',
                enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'],
                description: 'Tree output format (target=task_tree, default: ascii-tree)'
            },
            truncateInstruction: {
                type: 'number',
                description: 'Max instruction length displayed (target=task_tree, default: 80)'
            },
            showMetadata: {
                type: 'boolean',
                description: 'Show detailed metadata (target=task_tree, default: false)'
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
        task: ['xml', 'debug'],
        task_tree: ['markdown'],
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

    // #1841 Cluster H: task_tree validation
    if (target === 'task_tree' && !conversationId) {
        throw new StateManagerError(
            'conversationId est requis pour target=task_tree',
            'MISSING_REQUIRED_PARAM',
            'ExportDataTool',
            { target, missingParam: 'conversationId' }
        );
    }

    if (target === 'task' && format === 'debug' && !taskId) {
        throw new StateManagerError(
            'taskId est requis pour target=task format=debug',
            'MISSING_REQUIRED_PARAM',
            'ExportDataTool',
            { target, format, missingParam: 'taskId' }
        );
    }
}

/**
 * Validate filePath for security (path traversal, unsafe characters).
 * Shared across JSON and CSV export handlers — XML uses XmlExporterService.validateFilePath.
 */
function validateExportFilePath(filePath: string): void {
    const dangerousPatterns = [
        /\.\./,          // Directory traversal
        /^[\/\\]/,       // Absolute paths
        /[<>:"|?*]/,     // Windows forbidden characters
    ];

    if (dangerousPatterns.some(pattern => pattern.test(filePath))) {
        throw new StateManagerError(
            `Unsafe file path: ${filePath}`,
            'PATH_TRAVERSAL_DETECTED',
            'ExportDataTool',
            { filePath }
        );
    }

    if (filePath.length > 260) {
        throw new StateManagerError(
            `File path too long (${filePath.length} chars, max 260)`,
            'PATH_TOO_LONG',
            'ExportDataTool',
            { filePath, length: filePath.length }
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
        validateExportFilePath(filePath);

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
        validateExportFilePath(filePath);

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
                    text: 'Paramètre "target" requis. Valeurs: task, task_tree, conversation, project'
                }]
            };
        }

        if (!args.format) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'Paramètre "format" requis. Valeurs: xml, json, csv, markdown, debug'
                }]
            };
        }

        // Valider la combinaison target/format
        validateTargetFormat(args.target, args.format);

        // Valider les paramètres requis
        validateRequiredParams(args);

        // Router vers le handler approprié
        const { target, format } = args;

        // #1841 Cluster H: task debug diagnostic (was task_export action='debug')
        if (target === 'task' && format === 'debug') {
            const debugArgs: DebugTaskParsingArgs = { task_id: args.taskId! };
            return await handleDebugTaskParsing(debugArgs);
        }

        if (target === 'task' && format === 'xml') {
            return await handleTaskXml(args, conversationCache, xmlExporterService, ensureSkeletonCacheIsFresh);
        }

        // #1841 Cluster H: task tree markdown export (was task_export action='markdown')
        if (target === 'task_tree' && format === 'markdown') {
            const exportArgs: ExportTaskTreeMarkdownArgs = {
                conversation_id: args.conversationId!,
                filePath: args.filePath,
                max_depth: args.maxDepth,
                include_siblings: args.includeSiblings,
                current_task_id: args.currentTaskId,
                output_format: args.outputFormat,
                truncate_instruction: args.truncateInstruction,
                show_metadata: args.showMetadata
            };

            const wrappedHandleGetTaskTree = async (treeArgs: any) => {
                return await handleGetTaskTree(treeArgs, conversationCache, ensureSkeletonCacheIsFresh);
            };

            return await handleExportTaskTreeMarkdown(
                exportArgs,
                wrappedHandleGetTaskTree,
                ensureSkeletonCacheIsFresh,
                conversationCache
            );
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
