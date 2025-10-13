/**
 * Outil MCP : export_task_tree_markdown
 * Exporte un arbre de tâches au format Markdown hiérarchique avec statuts de complétion et instructions
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { promises as fs } from 'fs';
import path from 'path';

export interface ExportTaskTreeMarkdownArgs {
    conversation_id: string;
    filePath?: string;
    max_depth?: number;
    include_siblings?: boolean;
}

/**
 * Définition de l'outil export_task_tree_markdown
 */
export const exportTaskTreeMarkdownTool = {
    name: 'export_task_tree_markdown',
    description: 'Exporte un arbre de tâches au format Markdown hiérarchique avec statuts de complétion et instructions.',
    inputSchema: {
        type: 'object',
        properties: {
            conversation_id: {
                type: 'string',
                description: 'ID de la conversation pour laquelle exporter l\'arbre des tâches.'
            },
            filePath: {
                type: 'string',
                description: 'Chemin optionnel pour sauvegarder le fichier Markdown. Si omis, le contenu est retourné.'
            },
            max_depth: {
                type: 'number',
                description: 'Profondeur maximale de l\'arbre à inclure dans l\'export.'
            },
            include_siblings: {
                type: 'boolean',
                description: 'Inclure les tâches sœurs (même parent) dans l\'arbre.',
                default: true
            }
        },
        required: ['conversation_id']
    }
};

/**
 * Handler pour export_task_tree_markdown
 * Exporte l'arbre de tâches au format Markdown
 */
export async function handleExportTaskTreeMarkdown(
    args: ExportTaskTreeMarkdownArgs,
    handleGetTaskTree: (args: any) => Promise<CallToolResult>,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    try {
        const { conversation_id, filePath, max_depth, include_siblings = true } = args;

        if (!conversation_id) {
            throw new Error("conversation_id est requis");
        }

        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        // Note: handleGetTaskTree ci-dessous va déjà appeler _ensureSkeletonCacheIsFresh,
        // mais on le fait aussi ici pour cohérence et sécurité
        await ensureSkeletonCacheIsFresh();

        // Utiliser get_task_tree pour récupérer l'arbre avec les nouveaux champs
        const treeResult = await handleGetTaskTree({
            conversation_id,
            max_depth,
            include_siblings
        });

        if (!treeResult || !treeResult.content || !treeResult.content[0]) {
            throw new Error("Impossible de récupérer l'arbre des tâches");
        }

        const textContent = treeResult.content[0].text;
        if (typeof textContent !== 'string') {
            throw new Error("Format de données invalide retourné par get_task_tree");
        }
        const treeData = JSON.parse(textContent);

        // Fonction récursive pour formatter l'arbre en Markdown
        const formatNodeToMarkdown = (node: any, depth: number = 0): string => {
            let markdown = '';
            const indent = '#'.repeat(Math.max(2, depth + 2)); // Commence par ## au minimum
            const shortId = node.taskIdShort || node.taskId?.substring(0, 8) || 'unknown';
            const status = node.metadata?.isCompleted ? 'Completed' : 'In Progress';
            const instruction = node.metadata?.truncatedInstruction || 'No instruction available';
            
            // Titre principal avec ID court et statut
            markdown += `${indent} ${node.title || 'Task'} (${shortId})\n`;
            markdown += `**Status:** ${status}\n`;
            markdown += `**Instruction:** ${instruction}\n`;
            
            // Statistiques si disponibles
            if (node.metadata?.stats) {
                const stats = node.metadata.stats;
                const messageCount = stats.messageCount || 0;
                const sizeKB = Math.round((stats.totalSize || 0) / 1024);
                markdown += `**Stats:** ${messageCount} messages | ${sizeKB} KB\n`;
            }
            
            // Workspace si disponible
            if (node.metadata?.workspace) {
                markdown += `**Workspace:** ${node.metadata.workspace}\n`;
            }
            
            markdown += '\n';

            // Enfants si présents
            if (node.children && node.children.length > 0) {
                if (depth === 0) {
                    markdown += `### Child Tasks\n\n`;
                }
                
                for (const child of node.children) {
                    markdown += formatNodeToMarkdown(child, depth + 1);
                }
            }

            return markdown;
        };

        // En-tête du document
        const currentDate = new Date().toISOString().split('T')[0];
        let markdown = `# Task Tree - ${currentDate}\n\n`;

        // Traiter le nœud racine ou les nœuds multiples
        if (Array.isArray(treeData)) {
            for (const rootNode of treeData) {
                markdown += formatNodeToMarkdown(rootNode, 0);
                markdown += '\n---\n\n';
            }
        } else {
            markdown += formatNodeToMarkdown(treeData, 0);
        }

        // Sauvegarder dans un fichier si spécifié
        if (filePath) {
            // Créer le répertoire parent si nécessaire
            const dir = path.dirname(filePath);
            await fs.mkdir(dir, { recursive: true });
            
            // Écrire le fichier
            await fs.writeFile(filePath, markdown, 'utf8');
            
            return {
                content: [{
                    type: 'text',
                    text: `✅ Arbre des tâches exporté avec succès vers: ${filePath}\n\nContenu:\n\n${markdown}`
                }]
            };
        }

        return {
            content: [{ type: 'text', text: markdown }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export Markdown: ${errorMessage}` }],
            isError: true
        };
    }
}