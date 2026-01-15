/**
 * MCP Tool pour exporter une tâche individuelle au format XML
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { XmlExporterService } from '../../services/XmlExporterService.js';

/**
 * Arguments du tool export_tasks_xml
 */
interface ExportTasksXmlArgs {
    /** Identifiant unique de la tâche à exporter */
    taskId: string;
    /** Chemin de sortie pour le fichier XML (optionnel) */
    filePath?: string;
    /** Inclure le contenu complet des messages */
    includeContent?: boolean;
    /** Indenter le XML pour une meilleure lisibilité */
    prettyPrint?: boolean;
}

/**
 * Définition du tool MCP
 */
export const exportTasksXmlTool: Tool = {
    name: 'export_tasks_xml',
    description: 'Exporte une tâche individuelle au format XML.',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'L\'identifiant unique de la tâche à exporter.'
            },
            filePath: {
                type: 'string',
                description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.'
            },
            includeContent: {
                type: 'boolean',
                description: 'Si true, inclut le contenu complet des messages (false par défaut).'
            },
            prettyPrint: {
                type: 'boolean',
                description: 'Si true, indente le XML pour une meilleure lisibilité (true par défaut).'
            }
        },
        required: ['taskId']
    }
};

/**
 * Implémentation du handler pour le tool export_tasks_xml
 */
export async function handleExportTasksXml(
    args: ExportTasksXmlArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    try {
        const { taskId, filePath, includeContent = false, prettyPrint = true } = args;
        
        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        await ensureSkeletonCacheIsFresh();
        
        const skeleton = conversationCache.get(taskId);
        if (!skeleton) {
            throw new StateManagerError(
                `Tâche avec l'ID '${taskId}' non trouvée dans le cache`,
                'TASK_NOT_FOUND',
                'ExportTasksXmlTool',
                { taskId, cacheSize: conversationCache.size }
            );
        }

        const xmlContent = xmlExporterService.generateTaskXml(skeleton, {
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
        } else {
            return {
                content: [{
                    type: 'text',
                    text: xmlContent
                }]
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text',
                text: `Erreur lors de l'export XML : ${errorMessage}`
            }]
        };
    }
}