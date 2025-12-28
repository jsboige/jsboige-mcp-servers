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
    /** ID de la tâche actuellement en cours d'exécution (pour marquage explicite comme "(TÂCHE ACTUELLE)") */
    current_task_id?: string;
    /** Format de sortie: 'ascii-tree' (défaut), 'markdown' (legacy), 'hierarchical' (complet avec TOC), ou 'json' */
    output_format?: 'ascii-tree' | 'markdown' | 'hierarchical' | 'json';
    /** Longueur maximale de l'instruction affichée (défaut: 80) */
    truncate_instruction?: number;
    /** Afficher les métadonnées détaillées (défaut: false) */
    show_metadata?: boolean;
}

/**
 * Interface pour passer le cache de conversations
 */
interface ConversationCacheProvider {
    conversationCache: Map<string, ConversationSkeleton>;
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
            },
            output_format: {
                type: 'string',
                enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'],
                description: 'Format de sortie: ascii-tree (défaut, arbre visuel), markdown (legacy, titres hiérarchiques), hierarchical (complet avec TOC et métadonnées), ou json (données brutes).',
                default: 'ascii-tree'
            },
            current_task_id: {
                type: 'string',
                description: 'ID de la tâche en cours d\'exécution pour marquage explicite comme "(TÂCHE ACTUELLE)". Si omis, aucune tâche ne sera marquée.'
            },
            truncate_instruction: {
                type: 'number',
                description: 'Longueur maximale de l\'instruction affichée dans le format ascii-tree (défaut: 80).',
                default: 80
            },
            show_metadata: {
                type: 'boolean',
                description: 'Afficher les métadonnées détaillées dans le format ascii-tree (défaut: false).',
                default: false
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
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    conversationCache?: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    try {
        const {
            conversation_id,
            filePath,
            max_depth,
            include_siblings = true,
            current_task_id,
            output_format = 'ascii-tree',
            truncate_instruction = 80,
            show_metadata = false
        } = args;

        if (!conversation_id) {
            throw new Error("conversation_id est requis");
        }

        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        await ensureSkeletonCacheIsFresh();

        // Utiliser get_task_tree pour récupérer l'arbre formaté
        const treeResult = await handleGetTaskTree({
            conversation_id,
            max_depth,
            include_siblings,
            current_task_id,
            output_format,
            truncate_instruction,
            show_metadata
        });

        if (!treeResult || !treeResult.content || !treeResult.content[0]) {
            throw new Error("Impossible de récupérer l'arbre des tâches");
        }

        const contentItem = treeResult.content[0];
        if (contentItem.type !== 'text') {
             throw new Error("Le format retourné n'est pas du texte");
        }

        const formattedTree = contentItem.text;
        if (typeof formattedTree !== 'string') {
            throw new Error("Format de données invalide retourné par get_task_tree");
        }

        // Sauvegarder dans un fichier si spécifié
        if (filePath) {
            let resolvedPath = filePath;

            // Résoudre le chemin relatif par rapport au workspace de la tâche
            if (!path.isAbsolute(filePath) && conversationCache) {
                const skeleton = conversationCache.get(conversation_id);
                if (skeleton && skeleton.metadata && skeleton.metadata.workspace) {
                    // Normaliser le chemin du workspace (gérer les ./ et ../)
                    const workspacePath = path.resolve(skeleton.metadata.workspace);
                    resolvedPath = path.join(workspacePath, filePath);
                    console.log(`[export_task_tree_markdown] Chemin relatif résolu: ${filePath} -> ${resolvedPath} (Workspace: ${skeleton.metadata.workspace})`);
                } else {
                    console.warn(`[export_task_tree_markdown] Impossible de résoudre le chemin relatif: workspace non trouvé pour ${conversation_id}`);
                    // Fallback: utiliser le CWD ou laisser tel quel (relatif au serveur)
                }
            }

            // Créer le répertoire parent si nécessaire
            const dir = path.dirname(resolvedPath);
            await fs.mkdir(dir, { recursive: true });

            // Écrire le fichier
            await fs.writeFile(resolvedPath, formattedTree, 'utf8');

            // Extraire les premières lignes pour l'aperçu
            const lines = formattedTree.split('\n');
            const preview = lines.slice(0, 50).join('\n');
            const truncated = lines.length > 50 ? '\n\n... (fichier complet sauvegardé)' : '';

            return {
                content: [{
                    type: 'text',
                    text: `✅ Arbre des tâches exporté avec succès vers: ${filePath}\n\n**Format:** ${output_format}\n**Lignes:** ${lines.length}\n\n**Aperçu:**\n\n${preview}${truncated}`
                }]
            };
        }

        // Retourner le contenu directement si pas de fichier
        return {
            content: [{ type: 'text', text: formattedTree }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export: ${errorMessage}` }],
            isError: true
        };
    }
}
