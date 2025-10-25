/**
 * Outil MCP : get_task_tree
 * Récupère une vue arborescente et hiérarchique des tâches
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import {
    formatTaskTreeAscii,
    generateTreeHeader,
    generateTreeFooter,
    countTreeNodes,
    getMaxTreeDepth,
    type TaskTreeNode,
    type FormatAsciiTreeOptions
} from './format-ascii-tree.js';
import {
    formatTaskTreeHierarchical,
    type FormatHierarchicalTreeOptions
} from './format-hierarchical-tree.js';
import { globalTaskInstructionIndex } from '../../utils/task-instruction-index.js';

export interface GetTaskTreeArgs {
    conversation_id: string;
    max_depth?: number;
    include_siblings?: boolean;
    output_format?: 'json' | 'markdown' | 'ascii-tree' | 'hierarchical';
    /** ID de la tâche actuellement en cours d'exécution (pour marquage explicite) */
    current_task_id?: string;
    /** Longueur maximale de l'instruction affichée (défaut: 80) */
    truncate_instruction?: number;
    /** Afficher les métadonnées détaillées (défaut: false) */
    show_metadata?: boolean;
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
            output_format: {
                type: 'string',
                enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'],
                description: 'Format de sortie: json (défaut), markdown (legacy), ascii-tree (arbre visuel avec connecteurs), ou hierarchical (format complet avec TOC et métadonnées).',
                default: 'json'
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
    const {
        conversation_id,
        max_depth = Infinity,
        include_siblings = false,
        output_format = 'json',
        current_task_id,
        truncate_instruction = 80,
        show_metadata = false
    } = args;

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
        const availableIds = skeletons.slice(0, 10).map(s => `${s.taskId} (${s.metadata?.title || 'No title'})`).join(', ');
        throw new Error(`Task ID '${conversation_id}' not found. Available tasks (first 10): ${availableIds}`);
    }

    // 🎯 CORRECTION CRITIQUE : Reconstruction dynamique via radix tree inversé
    // Plus d'utilisation des métadonnées parentId statiques qui peuvent être corrompues
    const childrenMap = new Map<string, string[]>();
    
    console.log(`[get-task-tree] 🔄 Reconstruction hiérarchique via radix tree pour ${skeletons.length} tâches`);
    
    // Pour chaque tâche, trouver ses parents via le radix tree
    for (const skeleton of skeletons) {
        // Utiliser l'instruction complète de la tâche pour la recherche
        const taskInstruction = skeleton.metadata?.title || skeleton.truncatedInstruction || '';
        
        if (taskInstruction && taskInstruction.length > 10) {
            try {
                // 🔍 Rechercher les parents via le radix tree inversé
                const parentCandidates = await globalTaskInstructionIndex.getParentsForInstruction(taskInstruction);
                
                if (parentCandidates.length > 0) {
                    // Prendre le premier parent trouvé (déterministe)
                    const parentId = parentCandidates[0].taskId;
                    
                    console.log(`[get-task-tree] ✅ Parent trouvé pour ${skeleton.taskId.substring(0, 8)} -> ${parentId.substring(0, 8)} via radix tree`);
                    
                    // Ajouter la relation parent-enfant dans le childrenMap
                    if (!childrenMap.has(parentId)) {
                        childrenMap.set(parentId, []);
                    }
                    childrenMap.get(parentId)!.push(skeleton.taskId);
                    
                    // Mettre à jour le parentId dans le squelette pour cohérence
                    (skeleton as any).parentTaskId = parentId;
                    (skeleton as any).parentId = parentId;
                } else {
                    console.log(`[get-task-tree] ⚠️ Aucun parent trouvé pour ${skeleton.taskId.substring(0, 8)} via radix tree`);
                }
            } catch (error) {
                console.warn(`[get-task-tree] ❌ Erreur recherche parent pour ${skeleton.taskId.substring(0, 8)}:`, error);
            }
        } else {
            console.log(`[get-task-tree] ⏭️ Instruction trop courte pour ${skeleton.taskId.substring(0, 8)}, skipping`);
        }
    }
    
    console.log(`[get-task-tree] 📊 Reconstruction terminée: ${childrenMap.size} relations parent-enfant trouvées`);

    /**
     * Trouve la racine absolue en remontant la chaîne des parents
     */
    const findAbsoluteRoot = (taskId: string): string => {
        let currentId = taskId;
        let visited = new Set<string>();
        
        while (currentId && !visited.has(currentId)) {
            visited.add(currentId);
            const skeleton = skeletons.find(s => s.taskId === currentId);
            if (!skeleton) {
                break; // Tâche non trouvée, on arrête
            }
            
            const parentId = (skeleton as any)?.parentId ?? (skeleton as any)?.parentTaskId;
            if (!parentId) {
                // Plus de parent, c'est la racine
                return currentId;
            }
            
            currentId = parentId;
        }
        
        return currentId; // Dernier ID trouvé (racine ou boucle détectée)
    };

    const buildTree = (
        taskId: string,
        depth: number,
        visited: Set<string> = new Set(),
        maxDepth: number = 100
    ): any => {
        // 🆕 1. VÉRIFICATION CYCLE (priorité absolue)
        if (visited.has(taskId)) {
            console.warn(`[get_task_tree] ❌ CYCLE DÉTECTÉ pour taskId=${taskId ? taskId.substring(0, 8) : 'undefined'}`);
            return null;
        }
        
        // 🆕 2. GARDE-FOU PROFONDEUR EXPLICITE
        if (depth >= maxDepth) {
            console.warn(`[get_task_tree] ⚠️ PROFONDEUR MAX ATTEINTE (${maxDepth}) pour taskId=${taskId ? taskId.substring(0, 8) : 'undefined'}`);
            return null;
        }
        
        // 🆕 3. VÉRIFICATION taskId DÉFINI
        if (!taskId) {
            console.warn(`[get_task_tree] ⚠️ taskId undefined ou null, profondeur=${depth}`);
            return null;
        }
        
        // 3. Vérification profondeur paramétrable (existant)
        if (depth > max_depth) {
            return null;
        }
        
        const skeleton = skeletons.find(s => s.taskId === taskId);
        if (!skeleton) {
            return null;
        }

        // 🆕 4. MARQUER COMME VISITÉ **AVANT** RÉCURSION
        visited.add(taskId);

        // 🆕 5. RÉCURSION PROTÉGÉE
        const childrenIds = childrenMap.get(taskId) || [];
        const children = childrenIds
            .filter(childId => !visited.has(childId))
            .map(childId => buildTree(childId, depth + 1, visited, maxDepth))
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
    
    // 🚀 NOUVELLE LOGIQUE : Toujours remonter jusqu'à la racine absolue
    // pour garantir la hiérarchie complète depuis le début
    const absoluteRootId = findAbsoluteRoot(targetSkeleton.taskId);
    
    if (include_siblings) {
        // Si les siblings sont demandés, construire l'arbre depuis la racine absolue
        // pour inclure toute la hiérarchie complète
        tree = buildTree(absoluteRootId, 0, new Set(), max_depth === Infinity ? 100 : max_depth);
    } else {
        // Même sans siblings, on construit depuis la racine absolue pour avoir
        // le contexte complet de la hiérarchie jusqu'à la tâche cible
        tree = buildTree(absoluteRootId, 0, new Set(), max_depth === Infinity ? 100 : max_depth);
    }

    if (!tree) {
        throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Task exists but tree construction failed.`);
    }

    // Format output based on output_format parameter
    if (output_format === 'ascii-tree') {
        // Format ASCII avec la nouvelle fonction
        const options: FormatAsciiTreeOptions = {
            truncateInstruction: truncate_instruction,
            showMetadata: show_metadata,
            showStatus: true,
            highlightCurrent: true
        };
        
        const asciiTree = formatTaskTreeAscii(tree as TaskTreeNode, options);
        const header = generateTreeHeader(conversation_id, max_depth, include_siblings, tree.title);
        const totalNodes = countTreeNodes(tree as TaskTreeNode);
        const actualDepth = getMaxTreeDepth(tree as TaskTreeNode);
        const footer = generateTreeFooter(totalNodes, actualDepth);
        
        return { content: [{ type: 'text', text: header + asciiTree + footer }] };
    } else if (output_format === 'hierarchical') {
        // Format hiérarchique complet avec TOC et métadonnées
        const options: FormatHierarchicalTreeOptions = {
            includeToC: true,
            includeLegend: true,
            includeStats: true
        };
        
        const hierarchicalTree = formatTaskTreeHierarchical(tree as TaskTreeNode, options);
        
        return { content: [{ type: 'text', text: hierarchicalTree }] };
    } else if (output_format === 'markdown') {
        // Format markdown legacy (conservé pour compatibilité)
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
        // Format JSON (défaut)
        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
    }
}