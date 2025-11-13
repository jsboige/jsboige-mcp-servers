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
        include_siblings = true,
        output_format = 'json',
        current_task_id,
        truncate_instruction = 80,
        show_metadata = false
    } = args;

    // **FAILSAFE: Auto-rebuild cache si nécessaire**
    await ensureSkeletonCacheIsFresh();

    // 🎯 CORRECTION : Gérer le cache vide gracieusement
    if (conversationCache.size === 0) {
        return {
            content: [{
                type: 'text',
                text: '# Arbre de Tâches Vide\n\n**Aucune conversation trouvée**\n\nLe cache des squelettes est vide. Veuillez exécuter `build_skeleton_cache` pour peupler le cache.\n\n---\n\n**Statistiques:**\n- Nombre total de tâches: 0\n- Profondeur maximale atteinte: 0\n- Généré le: ' + new Date().toISOString() + '\n'
            }]
        };
    }

    const skeletons = Array.from(conversationCache.values());
    
    // Enhanced ID matching: support both exact match and prefix match
    const findTaskById = (id: string) => {
        // Try exact match first
        const exactMatch = skeletons.find(s => s.taskId === id);
        if (exactMatch) {
            return exactMatch;
        }
        
        // Try prefix match (with defensive check)
        const prefixMatches = skeletons.filter(s => s.taskId && s.taskId.startsWith(id));
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

    // 🎯 CORRECTION CRITIQUE : Reconstruction hybride robuste
    // Stratégie multi-niveaux avec fallback pour garantir la détection des relations
    const childrenMap = new Map<string, string[]>();
    
    console.log(`[get-task-tree] 🔄 Reconstruction hiérarchique hybride pour ${skeletons.length} tâches`);
    
    // ÉTAPE 1: Utiliser les métadonnées parentId existantes (priorité haute)
    for (const skeleton of skeletons) {
        const existingParentId = (skeleton as any)?.parentId ?? (skeleton as any)?.parentTaskId;
        if (existingParentId) {
            if (!childrenMap.has(existingParentId)) {
                childrenMap.set(existingParentId, []);
            }
            childrenMap.get(existingParentId)!.push(skeleton.taskId);
            console.log(`[get-task-tree] ✅ Parent statique trouvé pour ${skeleton.taskId?.substring(0, 8) || 'unknown'} -> ${existingParentId?.substring(0, 8) || 'unknown'} (métadonnées)`);
        }
    }
    
    // ÉTAPE 2: Compléter avec radix tree pour les tâches sans parent (priorité basse)
    const tasksWithoutParent = skeletons.filter(s => !((s as any)?.parentId) && !((s as any)?.parentTaskId));
    console.log(`[get-task-tree] 📊 ${tasksWithoutParent.length} tâches sans parent, tentative radix tree...`);
    
    for (const skeleton of tasksWithoutParent) {
        // Utiliser l'instruction complète de la tâche pour la recherche
        const taskInstruction = skeleton.metadata?.title || skeleton.truncatedInstruction || '';
        
        if (taskInstruction && taskInstruction.length > 10) {
            try {
                // 🔍 Rechercher les parents via le radix tree inversé
                const parentCandidates = await globalTaskInstructionIndex.getParentsForInstruction(taskInstruction);
                
                if (parentCandidates.length > 0) {
                    // Prendre le premier parent trouvé (déterministe)
                    const parentId = parentCandidates[0].taskId;
                    
                    console.log(`[get-task-tree] ✅ Parent radix trouvé pour ${skeleton.taskId?.substring(0, 8) || 'unknown'} -> ${parentId?.substring(0, 8) || 'unknown'} via radix tree`);
                    
                    // Ajouter la relation parent-enfant dans le childrenMap
                    if (!childrenMap.has(parentId)) {
                        childrenMap.set(parentId, []);
                    }
                    childrenMap.get(parentId)!.push(skeleton.taskId);
                    
                    // Mettre à jour le parentId dans le squelette pour cohérence
                    (skeleton as any).parentTaskId = parentId;
                    (skeleton as any).parentId = parentId;
                } else {
                    console.log(`[get-task-tree] ⚠️ Aucun parent radix trouvé pour ${skeleton.taskId?.substring(0, 8) || 'unknown'} via radix tree`);
                }
            } catch (error) {
                console.warn(`[get-task-tree] ❌ Erreur recherche parent radix pour ${skeleton.taskId?.substring(0, 8) || 'unknown'}:`, error);
            }
        } else {
            console.log(`[get-task-tree] ⏭️ Instruction trop courte pour ${skeleton.taskId?.substring(0, 8) || 'unknown'}, skipping`);
        }
    }
    
    // ÉTAPE 3: Validation et statistiques
    const totalRelations = childrenMap.size;
    const tasksWithRelations = skeletons.filter(s => ((s as any)?.parentId) || ((s as any)?.parentTaskId));
    console.log(`[get-task-tree] 📊 Reconstruction terminée: ${totalRelations} relations trouvées (${tasksWithRelations.length} tâches avec relations)`);
    
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
        maxDepth: number
    ): any => {
        // 🎯 CORRECTION : 1. VÉRIFICATION CYCLE (priorité absolue)
        if (visited.has(taskId)) {
            console.warn(`Référence circulaire détectée`);
            return null;
        }
        
        // 🎯 CORRECTION : Vérifier les références circulaires directes dans les métadonnées
        const currentSkeleton = skeletons.find(s => s.taskId === taskId);
        if (currentSkeleton && ((currentSkeleton as any)?.parentTaskId || (currentSkeleton as any)?.parentId)) {
            const parentTaskId = (currentSkeleton as any)?.parentTaskId ?? (currentSkeleton as any)?.parentId;
            const childrenIds = childrenMap.get(taskId) || [];
            
            // Vérifier si le parent est aussi un enfant (référence circulaire directe)
            if (childrenIds.includes(parentTaskId)) {
                console.warn(`[get-task-tree] 🔄 Référence circulaire détectée`);
                // 🎯 CORRECTION : Ne pas retourner null, mais continuer en évitant la boucle
                // L'arbre doit être construit mais avec le cycle évité
            }
        }
        
        // 🎯 CORRECTION : 2. GARDE-FOU PROFONDEUR EXPLICITE
        if (depth >= maxDepth && maxDepth !== Infinity && maxDepth !== 0) {
            console.warn(`[get_task_tree] ⚠️ PROFONDEUR MAX ATTEINTE (${maxDepth}) pour taskId=${taskId?.substring(0, 8) || 'undefined'}`);
            return null;
        }
        
        // 🆕 3. VÉRIFICATION taskId DÉFINI
        if (!taskId) {
            console.warn(`[get_task_tree] ⚠️ taskId undefined ou null, profondeur=${depth}`);
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
        const nodeShortId = skeleton.taskId?.substring(0, 8) || '';
        const currentShortId = current_task_id?.substring(0, 8) || '';
        const isCurrentTask = (nodeShortId === currentShortId && currentShortId !== '');
        
        // 🎯 CORRECTION : Enhanced node with rich metadata CORRECTES
        const node = {
            taskId: skeleton.taskId || '',
            taskIdShort: skeleton.taskId?.substring(0, 8) || 'unknown',
            title: skeleton.metadata?.title || `Task ${skeleton.taskId?.substring(0, 8) || 'unknown'}`,
            metadata: {
                messageCount: skeleton.metadata?.messageCount || 0,
                actionCount: skeleton.metadata?.actionCount || 0,
                totalSizeKB: skeleton.metadata?.totalSize ? Math.round(skeleton.metadata.totalSize / 1024) : 0,
                totalSizeBytes: skeleton.metadata?.totalSize || 0,
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
    
    /**
     * Filtre un arbre pour n'afficher que la branche menant à la tâche cible
     */
    const filterTreeToTargetBranch = (tree: any, targetTaskId: string): any => {
        if (!tree) return null;
        
        // Fonction récursive pour filtrer les enfants
        const filterBranch = (node: any): any => {
            if (!node) return null;
            
            // Si c'est la tâche cible, on garde tout Ce sous-arbre
            if (node.taskId === targetTaskId) {
                return node;
            }
            
            // 🎯 CORRECTION : Si c'est un parent sur le chemin vers la cible, on garde ce nœud
            const isOnPathToTarget = (n: any): boolean => {
                if (!n) return false;
                if (n.taskId === targetTaskId) return true;
                if (!n.children) return false;
                return n.children.some((child: any) => isOnPathToTarget(child));
            };
            
            // Sinon, on ne garde que les enfants qui mènent à la cible
            if (node.children && node.children.length > 0) {
                const filteredChildren = node.children
                    .map((child: any) => filterBranch(child))
                    .filter((child: any) => child !== null);
                
                if (filteredChildren.length > 0 || isOnPathToTarget(node)) {
                    return {
                        ...node,
                        children: filteredChildren
                    };
                }
            }
            
            return null;
        };
        
        return filterBranch(tree);
    };
    
    let tree;
    
    // 🚀 NOUVELLE LOGIQUE : Toujours remonter jusqu'à la racine absolue
    // pour garantir la hiérarchie complète depuis le début
    const absoluteRootId = findAbsoluteRoot(targetSkeleton.taskId);
    
    if (include_siblings) {
        // Si les siblings sont demandés, construire l'arbre depuis la racine absolue
        // pour inclure toute la hiérarchie complète
        tree = buildTree(absoluteRootId, 0, new Set(), max_depth === Infinity || max_depth === 0 ? 100 : max_depth);
    } else {
        // 🎯 CORRECTION : Sans siblings, construire uniquement la branche demandée
        // pour inclure le parent mais exclure les autres branches
        const absoluteRoot = findAbsoluteRoot(conversation_id);
        
        // 🎯 CORRECTION CRITIQUE : Filtrer les enfants pour n'inclure que la branche cible
        const filteredChildrenMap = new Map<string, string[]>();
        
        // Copier les relations parent-enfant existantes
        for (const [parentId, children] of childrenMap.entries()) {
            filteredChildrenMap.set(parentId, [...children]);
        }
        
        // 🎯 FILTRAGE : Ne garder que la branche qui mène à la tâche cible
        const filterBranch = (taskId: string, visited: Set<string>): boolean => {
            if (taskId === conversation_id) {
                return true; // Garder la tâche cible
            }
            
            const skeleton = skeletons.find(s => s.taskId === taskId);
            if (!skeleton) {
                return false;
            }
            
            const parentId = (skeleton as any)?.parentId ?? (skeleton as any)?.parentTaskId;
            if (!parentId) {
                return false; // Arrêter au niveau racine
            }
            
            // Vérifier si ce parent mène à la tâche cible
            return filterBranch(parentId, visited);
        };
        
        // Filtrer toutes les relations pour ne garder que la branche cible
        for (const [parentId, children] of childrenMap.entries()) {
            const filteredChildren = children.filter(childId => filterBranch(childId, new Set([childId])));
            filteredChildrenMap.set(parentId, filteredChildren);
        }
        
        // Construire l'arbre avec les relations filtrées
        const buildTreeFiltered = (
            taskId: string,
            depth: number,
            visited: Set<string> = new Set(),
            maxDepth: number
        ): any => {
            // 🎯 CORRECTION : 1. VÉRIFICATION CYCLE (priorité absolue)
            if (visited.has(taskId)) {
                console.warn(`Référence circulaire détectée`);
                return null;
            }
            
            // 🎯 CORRECTION : 2. GARDE-FOU PROFONDEUR EXPLICITE
            if (depth >= maxDepth && maxDepth !== Infinity && maxDepth !== 0) {
                console.warn(`[get_task_tree] ⚠️ PROFONDEUR MAX ATTEINTE (${maxDepth}) pour taskId=${taskId?.substring(0, 8) || 'undefined'}`);
                return null;
            }
            
            // 🆕 3. VÉRIFICATION taskId DÉFINI
            if (!taskId) {
                console.warn(`[get_task_tree] ⚠️ taskId undefined ou null, profondeur=${depth}`);
                return null;
            }
            
            const skeleton = skeletons.find(s => s.taskId === taskId);
            if (!skeleton) {
                return null;
            }
            
            // 🆕 4. MARQUER COMME VISITÉ **AVANT** RÉCURSION
            visited.add(taskId);
            
            // 🆕 5. RÉCURSION PROTÉGÉE avec enfants filtrés
            const childrenIds = filteredChildrenMap.get(taskId) || [];
            const children = childrenIds
                .filter(childId => !visited.has(childId))
                .map(childId => buildTreeFiltered(childId, depth + 1, visited, maxDepth))
                .filter(child => child !== null);
            
            // 🎯 Marquer la tâche actuelle - Comparer les 8 premiers caractères (UUIDs courts)
            const nodeShortId = skeleton.taskId?.substring(0, 8) || '';
            const currentShortId = current_task_id?.substring(0, 8) || '';
            const isCurrentTask = (nodeShortId === currentShortId && currentShortId !== '');
            
            // 🎯 CORRECTION : Enhanced node with rich metadata CORRECTES
            const node = {
                taskId: skeleton.taskId || '',
                taskIdShort: skeleton.taskId?.substring(0, 8) || 'unknown',
                title: skeleton.metadata?.title || `Task ${skeleton.taskId?.substring(0, 8) || 'unknown'}`,
                metadata: {
                    messageCount: skeleton.metadata?.messageCount || 0,
                    actionCount: skeleton.metadata?.actionCount || 0,
                    totalSizeKB: skeleton.metadata?.totalSize ? Math.round(skeleton.metadata.totalSize / 1024) : 0,
                    totalSizeBytes: skeleton.metadata?.totalSize || 0,
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
        
        tree = buildTreeFiltered(absoluteRoot, 0, new Set(), max_depth === Infinity || max_depth === 0 ? 100 : max_depth);
    }

    if (!tree) {
        throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Task exists but tree construction failed.`);
    }

    // Format output based on output_format parameter
    if (output_format === 'ascii-tree') {
        // 🎯 CORRECTION : Format ASCII avec la nouvelle fonction
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
        // 🎯 CORRECTION : Format markdown avec titres hiérarchiques corrects
        const formatTreeMarkdown = (node: any, level: number = 1): string => {
            const indent = '#'.repeat(level);
            let line = `${indent} ${node.title}\n`;
            
            if (node.metadata) {
                line += `${indent} **Messages:** ${node.metadata.messageCount || 0}\n`;
                line += `${indent} **Taille:** ${node.metadata.totalSizeKB || 0} KB\n`;
                line += `${indent} **Mode:** ${node.metadata.mode || 'Unknown'}\n`;
            }
            
            if (node.children && node.children.length > 0) {
                node.children.forEach((child: any) => {
                    line += formatTreeMarkdown(child, level + 1);
                });
            }
            
            return line;
        };
        
        const markdownTree = formatTreeMarkdown(tree);
        const metadata = `**Arbre des tâches:** ${conversation_id}\n**Profondeur max:** ${max_depth === Infinity ? '∞' : max_depth}\n**Inclure siblings:** ${include_siblings ? 'Oui' : 'Non'}\n**Racine:** ${tree.taskIdShort} - ${tree.title}\n\n`;
        
        return { content: [{ type: 'text', text: metadata + markdownTree }] };
    } else {
        // Format JSON (défaut)
        // 🎯 CORRECTION : Pour le test, tree doit être un tableau avec la racine comme premier élément
        const jsonOutput = {
            conversation_id: conversation_id,
            root_task: {
                taskId: tree.taskId,
                title: tree.title,
                metadata: tree.metadata
            },
            tree: [tree], // 🎯 CORRECTION : Mettre l'arbre dans un tableau pour le test
            metadata: {
                total_nodes: countTreeNodes(tree as TaskTreeNode),
                max_depth: getMaxTreeDepth(tree as TaskTreeNode),
                generated_at: new Date().toISOString(),
                include_siblings: include_siblings,
                output_format: output_format
            }
        };
        return { content: [{ type: 'text', text: JSON.stringify(jsonOutput, null, 2) }] };
    }
}