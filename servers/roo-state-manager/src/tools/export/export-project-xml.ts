/**
 * MCP Tool pour exporter un projet entier au format XML
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { XmlExporterService } from '../../services/XmlExporterService.js';
import { normalizePath } from '../../utils/path-normalizer.js';

/**
 * Arguments du tool export_project_xml
 */
interface ExportProjectXmlArgs {
    /** Chemin du workspace/projet à analyser */
    projectPath: string;
    /** Chemin de sortie pour le fichier XML (optionnel) */
    filePath?: string;
    /** Date de début (ISO 8601) pour filtrer les conversations */
    startDate?: string;
    /** Date de fin (ISO 8601) pour filtrer les conversations */
    endDate?: string;
    /** Indenter le XML pour une meilleure lisibilité */
    prettyPrint?: boolean;
}

/**
 * Définition du tool MCP
 */
export const exportProjectXmlTool: Tool = {
    name: 'export_project_xml',
    description: 'Exporte un aperçu de haut niveau d\'un projet entier au format XML.',
    inputSchema: {
        type: 'object',
        properties: {
            projectPath: {
                type: 'string',
                description: 'Le chemin du workspace/projet à analyser.'
            },
            filePath: {
                type: 'string',
                description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.'
            },
            startDate: {
                type: 'string',
                description: 'Date de début (ISO 8601) pour filtrer les conversations.'
            },
            endDate: {
                type: 'string',
                description: 'Date de fin (ISO 8601) pour filtrer les conversations.'
            },
            prettyPrint: {
                type: 'boolean',
                description: 'Si true, indente le XML pour une meilleure lisibilité (true par défaut).'
            }
        },
        required: ['projectPath']
    }
};

/**
 * Implémentation du handler pour le tool export_project_xml
 */
export async function handleExportProjectXml(
    args: ExportProjectXmlArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    xmlExporterService: XmlExporterService,
    ensureSkeletonCacheIsFresh: (options?: { workspace?: string }) => Promise<void>
): Promise<CallToolResult> {
    try {
        const { projectPath, filePath, startDate, endDate, prettyPrint = true } = args;
        
        // **FAILSAFE: Auto-rebuild cache si nécessaire avec filtre workspace**
        await ensureSkeletonCacheIsFresh({ workspace: projectPath });
        
        // Filtrer les conversations par workspace et date
        const relevantTasks = Array.from(conversationCache.values()).filter(skeleton => {
            if (skeleton.metadata?.workspace) {
                const normalizedWorkspace = normalizePath(skeleton.metadata.workspace);
                const normalizedProject = normalizePath(projectPath);
                
                if (normalizedWorkspace !== normalizedProject) {
                    return false;
                }
            }
            
            if (startDate) {
                const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
                if (taskDate < new Date(startDate)) {
                    return false;
                }
            }
            
            if (endDate) {
                const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
                if (taskDate > new Date(endDate)) {
                    return false;
                }
            }
            
            return true;
        });

        // TODO: Correction temporaire - adapter l'interface du service
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
                text: `Erreur lors de l'export XML du projet : ${errorMessage}`
            }]
        };
    }
}