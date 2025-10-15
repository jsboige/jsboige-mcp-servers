/**
 * Outil MCP : get_task_tree
 * Récupère une vue arborescente et hiérarchique des tâches
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

export interface GetTaskTreeArgs {
    conversation_id: string;
    max_depth?: number;
    include_siblings?: boolean;
    output_format?: 'json' | 'markdown';
    /** ID de la tâche actuellement en cours d'exécution (pour marquage explicite) */
    current_task_id?: string;
}

/**
 * Définition de l'outil get_task_tree
 */
export const getTaskTreeTool = {
    name: 'get_task_tree',
    description: 'Récupère une vue arborescente et hiérarchique des tâches.',
    inputSchema: {
        type: 'object',
        properties: {
            conversation_id: {
                type: 'string',
                description: 'ID de la conversation pour laquelle récupérer l\'arbre des tâches.'
            },
            max_depth: {
                type: 'number',
                description: 'Profondeur maximale de l\'arbre à retourner.'
            },
            include_siblings: {
                type: 'boolean',
                description: 'Inclure les tâches sœurs (même parent) dans l\'arbre.'
            },
            current_task_id: {
                type: 'string',
                description: 'ID de la tâche en cours d\'exécution pour marquage explicite comme "(TÂCHE ACTUELLE)". Si omis, aucune tâche ne sera marquée.'
            }
        },
        required: ['conversation_id'],
    }
};

/**
 * Handler pour get_task_tree
 * Récupère et formate l'arbre de tâches d'une conversation
 */
export async function handleGetTaskTree(
    args: GetTaskTreeArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    const { conversation_id, max_depth = Infinity, include_siblings = false, output_format = 'json', current_task_id } = args;

    // **FAILSAFE: Auto-rebuild cache si nécessaire**
    await ensureSkeletonCacheIsFresh();

    // Ensure cache is populated
    if (conversationCache.size === 0) {
        throw new Error(`Task cache is empty. Please run 'build_skeleton_cache' first to populate the cache.`);
    }

    const skeletons = Array.from(conversationCache.values());
    
    // Enhanced ID matching: support both exact match and prefix match
    const findTaskById = (id: string) => {
        // Try exact match first
        const exactMatch = skeletons.find(s => s.taskId === id);
        if (exactMatch) {
            return exactMatch;
        }
        
        // Try prefix match
        const prefixMatches = skeletons.filter(s => s.taskId.startsWith(id));
        if (prefixMatches.length === 0) {
            return null;
        }
        if (prefixMatches.length === 1) {
            return prefixMatches[0];
        }
        
        // Multiple matches - throw error with suggestions
        const suggestions = prefixMatches.slice(0, 5).map(s => s.taskId).join(', ');
        throw new Error(`Ambiguous task ID '${id}'. Multiple matches found: ${suggestions}. Please provide a more specific ID.`);
    };
    
    const targetSkeleton = findTaskById(conversation_id);
    if (!targetSkeleton) {
        const availableIds = skeletons.slice(0, 10).map(s => `${s.taskId.substring(0, 8)} (${s.metadata?.title || 'No title'})`).join(', ');
        throw new Error(`Task ID '${conversation_id}' not found. Available tasks (first 10): ${availableIds}`);
    }

    const childrenMap = new Map<string, string[]>();
    skeletons.forEach(s => {
        const pId = (s as any)?.parentId ?? (s as any)?.parentTaskId;
        if (pId) {
            if (!childrenMap.has(pId)) {
                childrenMap.set(pId, []);
            }
            childrenMap.get(pId)!.push(s.taskId);
        }
    });

    const buildTree = (taskId: string, depth: number): any => {
        if (depth > max_depth) {
            return null;
        }
        const skeleton = skeletons.find(s => s.taskId === taskId);
        if (!skeleton) {
            return null;
        }

        const childrenIds = childrenMap.get(taskId) || [];
        const children = childrenIds
            .map(childId => buildTree(childId, depth + 1))
            .filter(child => child !== null);
        
        // 🎯 Marquer la tâche actuelle - Comparer les 8 premiers caractères (UUIDs courts)
        const nodeShortId = skeleton.taskId.substring(0, 8);
        const currentShortId = current_task_id ? current_task_id.substring(0, 8) : '';
        const isCurrentTask = (nodeShortId === currentShortId && currentShortId !== '');
        
        // Enhanced node with rich metadata
        const node = {
            taskId: skeleton.taskId,
            taskIdShort: skeleton.taskId.substring(0, 8),
            title: skeleton.metadata?.title || `Task ${skeleton.taskId.substring(0, 8)}`,
            metadata: {
                messageCount: skeleton.metadata?.messageCount || 0,
                actionCount: skeleton.metadata?.actionCount || 0,
                totalSizeKB: skeleton.metadata?.totalSize ? Math.round(skeleton.metadata.totalSize / 1024 * 10) / 10 : 0,
                lastActivity: skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || 'Unknown',
                createdAt: skeleton.metadata?.createdAt || 'Unknown',
                mode: skeleton.metadata?.mode || 'Unknown',
                workspace: skeleton.metadata?.workspace || 'Unknown',
                hasParent: !!(((skeleton as any)?.parentId) || ((skeleton as any)?.parentTaskId)),
                childrenCount: childrenIds.length,
                depth: depth,
                // 🚀 NOUVEAUX CHAMPS : Ajout des fonctionnalités demandées
                isCompleted: skeleton.isCompleted || false,
                truncatedInstruction: skeleton.truncatedInstruction || undefined,
                // 🎯 NOUVEAU CHAMP : Marquage de la tâche actuelle
                isCurrentTask: isCurrentTask
            },
            parentId: (skeleton as any)?.parentId ?? (skeleton as any)?.parentTaskId,
            parentTaskId: (skeleton as any)?.parentTaskId,
            children: children.length > 0 ? children : undefined,
        };
        
        return node;
    };
    
    let tree;
    
    const targetParentId = (targetSkeleton as any)?.parentId ?? (targetSkeleton as any)?.parentTaskId;
    if (include_siblings && targetParentId) {
        // Si la tâche a un parent et que les siblings sont demandés,
        // construire l'arbre depuis le parent pour inclure les frères et sœurs.
        tree = buildTree(targetParentId, 0);
    } else {
        // Sinon (pas de parent ou siblings non demandés),
        // construire l'arbre depuis la tâche cible elle-même.
        tree = buildTree(targetSkeleton.taskId, 0);
    }

    if (!tree) {
        throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Task exists but tree construction failed.`);
    }

    // Format output based on output_format parameter
    if (output_format === 'markdown') {
        const formatTreeMarkdown = (node: any, prefix: string = '', isLast: boolean = true): string => {
            const connector = prefix === '' ? '' : (isLast ? '└── ' : '├── ');
            const nextPrefix = prefix === '' ? '' : prefix + (isLast ? '    ' : '│   ');
            
            let line = `${prefix}${connector}**${node.taskIdShort}** ${node.title}`;
            if (node.metadata) {
                line += ` _(${node.metadata.messageCount} msgs, ${node.metadata.totalSizeKB}KB, ${node.metadata.mode})_`;
            }
            line += '\n';
            
            if (node.children && node.children.length > 0) {
                node.children.forEach((child: any, index: number) => {
                    const childIsLast = index === node.children.length - 1;
                    line += formatTreeMarkdown(child, nextPrefix, childIsLast);
                });
            }
            
            return line;
        };
        
        const markdownTree = formatTreeMarkdown(tree);
        const metadata = `**Arbre des tâches:** ${conversation_id}\n**Profondeur max:** ${max_depth === Infinity ? '∞' : max_depth}\n**Inclure siblings:** ${include_siblings ? 'Oui' : 'Non'}\n**Racine:** ${tree.taskIdShort} - ${tree.title}\n\n`;
        
        return { content: [{ type: 'text', text: metadata + markdownTree }] };
    } else {
        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
    }
}