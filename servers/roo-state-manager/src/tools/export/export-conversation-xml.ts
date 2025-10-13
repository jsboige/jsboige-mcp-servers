/**
 * MCP Tool pour exporter une conversation complète au format XML
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { XmlExporterService } from '../../services/XmlExporterService.js';

/**
 * Arguments du tool export_conversation_xml
 */
interface ExportConversationXmlArgs {
    /** Identifiant de la tâche racine de la conversation */
    conversationId: string;
    /** Chemin de sortie pour le fichier XML (optionnel) */
    filePath?: string;
    /** Profondeur maximale de l'arbre de tâches */
    maxDepth?: number;
    /** Inclure le contenu complet des messages */
    includeContent?: boolean;
    /** Indenter le XML pour une meilleure lisibilité */
    prettyPrint?: boolean;
}

/**
 * Définition du tool MCP
 */
export const exportConversationXmlTool: Tool = {
    name: 'export_conversation_xml',
    description: 'Exporte une conversation complète (tâche racine + descendants) au format XML.',
    inputSchema: {
        type: 'object',
        properties: {
            conversationId: {
                type: 'string',
                description: 'L\'identifiant de la tâche racine de la conversation à exporter.'
            },
            filePath: {
                type: 'string',
                description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.'
            },
            maxDepth: {
                type: 'integer',
                description: 'Profondeur maximale de l\'arbre de tâches à inclure.'
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
        required: ['conversationId']
    }
};

/**
 * Implémentation du handler pour le tool export_conversation_xml
 */
export async function handleExportConversationXml(
    args: ExportConversationXmlArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    try {
        const { conversationId, filePath, maxDepth, includeContent = false, prettyPrint = true } = args;
        
        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        await ensureSkeletonCacheIsFresh();
        
        const rootSkeleton = conversationCache.get(conversationId);
        if (!rootSkeleton) {
            throw new Error(`Conversation racine avec l'ID '${conversationId}' non trouvée dans le cache.`);
        }

        // Collecter toutes les tâches de la conversation
        const collectTasks = (taskId: string, currentDepth = 0): ConversationSkeleton[] => {
            if (maxDepth && currentDepth >= maxDepth) {
                return [];
            }
            
            const task = conversationCache.get(taskId);
            if (!task) {
                return [];
            }

            const tasks = [task];
            
            // Rechercher les enfants
            for (const [childTaskId, childTask] of conversationCache.entries()) {
                if (childTask.parentTaskId === taskId) {
                    tasks.push(...collectTasks(childTaskId, currentDepth + 1));
                }
            }
            
            return tasks;
        };

        const allTasks = collectTasks(conversationId);
        
        // TODO: Correction temporaire - adapter l'interface du service
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
                text: `Erreur lors de l'export XML de la conversation : ${errorMessage}`
            }]
        };
    }
}