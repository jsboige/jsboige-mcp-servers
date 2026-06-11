/**
 * Outil MCP consolidé : export_data
 *
 * CONS-10: Consolide 5 outils d'export en 1 outil unifié.
 * CONS-14 (#1841 Cluster H): Absorbe task_export (markdown + debug).
 * Remplace:
 *   - export_tasks_xml
 *   - export_conversation_xml
 *   - export_project_xml
 *   - export_conversation_json
 *   - export_conversation_csv
 *   - task_export (markdown tree export + debug parsing)
 *
 * @module tools/export/export-data
 * @version 2.0.0
 * @since CONS-10, CONS-14
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { XmlExporterService } from '../../services/XmlExporterService.js';
import { TraceSummaryService, SummaryOptions } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import { handleExportTaskTreeMarkdown, ExportTaskTreeMarkdownArgs } from '../task/export-tree-md.tool.js';
import { handleDebugTaskParsing, DebugTaskParsingArgs } from '../task/debug-parsing.tool.js';
import { handleGetTaskTree } from '../task/get-tree.tool.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Hard caps to prevent OOM on large workspaces during project XML export.
 * Configurable via env vars for unusual deployments.
 *
 * Rationale: 50k conversations × ~500 bytes XML ≈ 25MB string, well under the
 * 100MB byte cap. The byte cap leaves headroom for the Node write buffer.
 * See #2307 Phase 1 audit item #2 (export_data memory guard).
 *
 * Note: wrapped in functions so unit tests can override via vi.stubEnv()
 * without module reload gymnastics.
 */
function getMaxProjectExportConversations(): number {
    return parseInt(process.env.EXPORT_MAX_PROJECT_CONVERSATIONS || '50000', 10);
}
function getMaxProjectExportBytes(): number {
    return parseInt(
        process.env.EXPORT_MAX_PROJECT_BYTES || String(100 * 1024 * 1024),
        10
    );
}

/**
 * Types d'export supportés
 */
export type ExportTarget = 'task' | 'conversation' | 'project';
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

    // Options markdown (CONS-14, from task_export)
    /** Format de sortie pour markdown: ascii-tree, markdown, hierarchical, json */
    outputFormat?: 'ascii-tree' | 'markdown' | 'hierarchical' | 'json';
    /** Inclure les tâches sœurs (même parent) dans l'arbre */
    includeSiblings?: boolean;
    /** ID de la tâche en cours d'exécution pour marquage */
    currentTaskId?: string;
    /** Longueur max de l'instruction affichée (défaut: 80) */
    truncateInstruction?: number;
    /** Afficher les métadonnées détaillées */
    showMetadata?: boolean;
}

/**
 * Définition du tool MCP consolidé
 */
export const exportDataTool: Tool = {
    name: 'export_data',
    description: 'Export data as XML, JSON, CSV, or Markdown. Debug task parsing. Targets: task (XML, debug), conversation (all formats), project (XML). CONS-10 + CONS-14 (absorbs task_export).',
    inputSchema: {
        type: 'object',
        properties: {
            target: {
                type: 'string',
                enum: ['task', 'conversation', 'project'],
                description: 'Export target: task, conversation, or project'
            },
            format: {
                type: 'string',
                enum: ['xml', 'json', 'csv', 'markdown', 'debug'],
                description: 'Output format: xml, json, csv, markdown (conversation tree), or debug (task parsing diagnostic)'
            },
            taskId: {
                type: 'string',
                description: 'Task ID (required for target=task, or conversation with json/csv/debug)'
            },
            conversationId: {
                type: 'string',
                description: 'Root conversation ID (required for target=conversation with xml/markdown)'
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
                description: 'Max tree depth (XML/markdown)'
            },
            startDate: {
                type: 'string',
                description:
                    'ISO 8601 start date filter (XML project). Recommended for large workspaces — without date filter, project XML export is capped at EXPORT_MAX_PROJECT_CONVERSATIONS conversations (default 50000) and EXPORT_MAX_PROJECT_BYTES (default 100MB).'
            },
            endDate: {
                type: 'string',
                description:
                    'ISO 8601 end date filter (XML project). Recommended for large workspaces — without date filter, project XML export is capped at EXPORT_MAX_PROJECT_CONVERSATIONS conversations (default 50000) and EXPORT_MAX_PROJECT_BYTES (default 100MB).'
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
            // Options markdown (CONS-14, from task_export)
            outputFormat: {
                type: 'string',
                enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'],
                description: '[markdown] Sub-format: ascii-tree (default), markdown, hierarchical, or json'
            },
            includeSiblings: {
                type: 'boolean',
                description: '[markdown] Include sibling tasks (default: true)'
            },
            currentTaskId: {
                type: 'string',
                description: '[markdown] Mark this task as current in the tree'
            },
            truncateInstruction: {
                type: 'number',
                description: '[markdown] Max instruction display length (default: 80)'
            },
            showMetadata: {
                type: 'boolean',
                description: '[markdown] Show detailed metadata (default: false)'
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
        conversation: ['xml', 'json', 'csv', 'markdown'],
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

    if (target === 'task') {
        if (format === 'xml' && !taskId) {
            throw new StateManagerError(
                'taskId est requis pour target=task format=xml',
                'MISSING_REQUIRED_PARAM',
                'ExportDataTool',
                { target, format, missingParam: 'taskId' }
            );
        }
        if (format === 'debug' && !taskId) {
            throw new StateManagerError(
                'taskId est requis pour target=task format=debug',
                'MISSING_REQUIRED_PARAM',
                'ExportDataTool',
                { target, format, missingParam: 'taskId' }
            );
        }
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
        if (format === 'markdown' && !conversationId) {
            throw new StateManagerError(
                'conversationId est requis pour target=conversation format=markdown',
                'MISSING_REQUIRED_PARAM',
                'ExportDataTool',
                { target, format, missingParam: 'conversationId' }
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
 *
 * #2549 fix: Uses getConversationSkeleton (loads full skeleton from disk)
 * instead of conversationCache (which only stores SkeletonHeader without sequence).
 * The cache is still used to verify the task exists before the expensive disk read.
 */
async function handleTaskXml(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<CallToolResult> {
    const { taskId, filePath, includeContent = false, prettyPrint = true } = args;

    await ensureSkeletonCacheIsFresh();

    // Verify task exists in cache (lightweight check)
    if (!conversationCache.has(taskId!)) {
        throw new StateManagerError(
            `Tâche avec l'ID '${taskId}' non trouvée dans le cache`,
            'TASK_NOT_FOUND',
            'ExportDataTool',
            { taskId, cacheSize: conversationCache.size }
        );
    }

    // Load full skeleton from disk (includes sequence) — #2549
    const fullSkeleton = await getConversationSkeleton(taskId!);
    if (!fullSkeleton) {
        throw new StateManagerError(
            `Impossible de charger le skeleton complet pour la tâche '${taskId}'`,
            'SKELETON_LOAD_FAILED',
            'ExportDataTool',
            { taskId }
        );
    }

    const xmlContent = xmlExporterService.generateTaskXml(fullSkeleton, {
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

    const children = collectTasks(conversationId!).slice(1);
    const xmlContent = xmlExporterService.generateConversationXml(rootSkeleton, children, {
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

    if (!projectPath) {
        return { content: [{ type: 'text', text: 'Error: projectPath is required for project XML export.' }] };
    }

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

    // Memory guard: reject exports exceeding conversation cap (#2307 Phase 1 item #2)
    const maxConversations = getMaxProjectExportConversations();
    if (relevantTasks.length > maxConversations) {
        throw new StateManagerError(
            `Project export cap exceeded: ${relevantTasks.length} conversations > ${maxConversations} max. ` +
                `Narrow the date range (startDate/endDate) or move to a per-task export. ` +
                `Override via EXPORT_MAX_PROJECT_CONVERSATIONS env var.`,
            'EXPORT_TOO_LARGE',
            'ExportDataTool',
            { conversationCount: relevantTasks.length, max: maxConversations }
        );
    }

    const xmlContent = xmlExporterService.generateProjectXml(relevantTasks, projectPath, {
        startDate,
        endDate,
        prettyPrint
    });

    // Memory guard: reject exports exceeding byte cap (#2307 Phase 1 item #2)
    const maxBytes = getMaxProjectExportBytes();
    const xmlSizeBytes = Buffer.byteLength(xmlContent, 'utf-8');
    if (xmlSizeBytes > maxBytes) {
        throw new StateManagerError(
            `Project export size cap exceeded: ${xmlSizeBytes} bytes > ${maxBytes} max. ` +
                `Narrow the date range (startDate/endDate). ` +
                `Override via EXPORT_MAX_PROJECT_BYTES env var.`,
            'EXPORT_TOO_LARGE',
            'ExportDataTool',
            { sizeBytes: xmlSizeBytes, max: maxBytes }
        );
    }

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
 * Handler pour export markdown d'une conversation (task tree)
 * CONS-14: Absorbed from task_export action='markdown'
 */
async function handleConversationMarkdown(
    args: ExportDataArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    const exportArgs: ExportTaskTreeMarkdownArgs = {
        conversation_id: args.conversationId!,
        filePath: args.filePath,
        max_depth: args.maxDepth,
        include_siblings: args.includeSiblings,
        current_task_id: args.currentTaskId,
        output_format: args.outputFormat || 'ascii-tree',
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

/**
 * Handler pour diagnostic de parsing d'une tâche
 * CONS-14: Absorbed from task_export action='debug'
 */
async function handleTaskDebug(args: ExportDataArgs): Promise<CallToolResult> {
    const debugArgs: DebugTaskParsingArgs = {
        task_id: args.taskId!
    };
    return await handleDebugTaskParsing(debugArgs);
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

        if (target === 'task') {
            if (format === 'xml') {
                return await handleTaskXml(args, conversationCache, xmlExporterService, ensureSkeletonCacheIsFresh, getConversationSkeleton);
            }
            if (format === 'debug') {
                return await handleTaskDebug(args);
            }
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
            if (format === 'markdown') {
                return await handleConversationMarkdown(args, conversationCache, ensureSkeletonCacheIsFresh);
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
