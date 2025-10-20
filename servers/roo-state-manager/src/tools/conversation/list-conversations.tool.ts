/**
 * Outil pour lister toutes les conversations avec filtres et tri
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { SkeletonCacheService } from '../../services/skeleton-cache.service.js';
import { normalizePath } from '../../utils/path-normalizer.js';

/**
 * Node enrichi pour construire l'arbre hiérarchique
 * Défini explicitement sans étendre ConversationSkeleton pour éviter d'inclure la propriété sequence
 */
interface SkeletonNode {
    taskId: string;
    parentTaskId?: string;
    metadata: {
        title?: string;
        lastActivity: string;
        createdAt: string;
        mode?: string;
        messageCount: number;
        actionCount: number;
        totalSize: number;
        workspace?: string;
        qdrantIndexedAt?: string;
        dataSource?: string;
        indexingState?: any;
    };
    firstUserMessage?: string;
    isCompleted?: boolean;
    completionMessage?: string;
    children: SkeletonNode[];
}

/**
 * Interface allégée pour list_conversations avec informations essentielles
 */
interface ConversationSummary {
    taskId: string;
    parentTaskId?: string;
    firstUserMessage?: string;
    isCompleted?: boolean;
    completionMessage?: string;
    metadata: {
        title?: string;
        lastActivity: string;
        createdAt: string;
        mode?: string;
        messageCount: number;
        actionCount: number;
        totalSize: number;
        workspace?: string;
    };
    children: ConversationSummary[];
}

/**
 * Convertit un SkeletonNode vers ConversationSummary
 */
function toConversationSummary(node: SkeletonNode): ConversationSummary {
    return {
        taskId: node.taskId,
        parentTaskId: node.parentTaskId,
        firstUserMessage: node.firstUserMessage,
        isCompleted: node.isCompleted,
        completionMessage: node.completionMessage,
        metadata: node.metadata,
        children: node.children.map((child: SkeletonNode) => toConversationSummary(child))
    };
}

/**
 * Définition de l'outil list_conversations
 */
export const listConversationsTool = {
    definition: {
        name: 'list_conversations',
        description: 'Liste toutes les conversations avec filtres et tri.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number' },
                sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'] },
                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                hasApiHistory: { type: 'boolean' },
                hasUiMessages: { type: 'boolean' },
                workspace: { type: 'string', description: 'Filtre les conversations par chemin de workspace.' },
            },
        },
    },
    
    /**
     * Handler pour l'outil list_conversations
     */
    handler: async (
        args: {
            limit?: number,
            sortBy?: 'lastActivity' | 'messageCount' | 'totalSize',
            sortOrder?: 'asc' | 'desc',
            workspace?: string
        },
        conversationCache: Map<string, ConversationSkeleton>
    ): Promise<CallToolResult> => {
        // 🔇 LOGS VERBEUX COMMENTÉS (explosion contexte)
        // console.log('[🔧 FIXED VERSION] list_conversations called with:', JSON.stringify(args));
        // console.log('[🔧 FIXED VERSION] This is the corrected version without sequence property');
        
        let allSkeletons = Array.from(conversationCache.values()).filter(skeleton =>
            skeleton.metadata
        );

        // Filtrage par workspace
        let workspaceFilteredCount = 0;
        if (args.workspace) {
            const normalizedWorkspace = normalizePath(args.workspace);
            const countBeforeFilter = allSkeletons.length;
            
            // 🔇 LOGS VERBEUX COMMENTÉS (explosion contexte - liste workspaces disponibles)
            // console.log(`[DEBUG] Filtering by workspace: "${args.workspace}" -> normalized: "${normalizedWorkspace}"`);
            // const workspaces = allSkeletons
            //     .filter(s => s.metadata.workspace)
            //     .map(s => `"${s.metadata.workspace!}" -> normalized: "${normalizePath(s.metadata.workspace!)}"`)
            //     .slice(0, 5);
            // console.log(`[DEBUG] Available workspaces (first 5):`, workspaces);
            
            allSkeletons = allSkeletons.filter(skeleton =>
                skeleton.metadata.workspace &&
                normalizePath(skeleton.metadata.workspace) === normalizedWorkspace
            );
            
            workspaceFilteredCount = countBeforeFilter - allSkeletons.length;
            // 🔇 LOG VERBEUX COMMENTÉ (explosion contexte)
            // console.log(`[DEBUG] Found ${allSkeletons.length} conversations matching workspace filter`);
        }

        // Tri
        allSkeletons.sort((a, b) => {
            let comparison = 0;
            const sortBy = args.sortBy || 'lastActivity';
            switch (sortBy) {
                case 'lastActivity':
                    comparison = new Date(b.metadata!.lastActivity).getTime() - new Date(a.metadata!.lastActivity).getTime();
                    break;
                case 'messageCount':
                    comparison = (b.metadata?.messageCount || 0) - (a.metadata?.messageCount || 0);
                    break;
                case 'totalSize':
                    comparison = (b.metadata?.totalSize || 0) - (a.metadata?.totalSize || 0);
                    break;
            }
            return (args.sortOrder === 'asc') ? -comparison : comparison;
        });
        
        // Créer les SkeletonNode SANS la propriété sequence MAIS avec toutes les infos importantes
        const skeletonMap = new Map<string, SkeletonNode>(allSkeletons.map(s => {
            const sequence = (s as any).sequence;
            
            // Variables pour les informations à extraire
            let firstUserMessage: string | undefined = undefined;
            let isCompleted = false;
            let completionMessage: string | undefined = undefined;
            
            // Extraire les informations de la sequence si elle existe
            if (sequence && Array.isArray(sequence)) {
                // 1. Premier message utilisateur
                const firstUserMsg = sequence.find((msg: any) => msg.role === 'user');
                if (firstUserMsg && firstUserMsg.content) {
                    // Tronquer à 200 caractères pour éviter les messages trop longs
                    firstUserMessage = firstUserMsg.content.length > 200
                        ? firstUserMsg.content.substring(0, 200) + '...'
                        : firstUserMsg.content;
                }
                
                // 2. Détecter si la conversation est terminée (dernier message de type attempt_completion)
                const lastAssistantMessages = sequence
                    .filter((msg: any) => msg.role === 'assistant')
                    .slice(-3); // Prendre les 3 derniers messages assistant pour chercher attempt_completion
                
                for (const msg of lastAssistantMessages.reverse()) {
                    if (msg.content && Array.isArray(msg.content)) {
                        for (const content of msg.content) {
                            if (content.type === 'tool_use' && content.name === 'attempt_completion') {
                                isCompleted = true;
                                const result = content.input?.result;
                                if (result) {
                                    completionMessage = result.length > 150
                                        ? result.substring(0, 150) + '...'
                                        : result;
                                }
                                break;
                            }
                        }
                        if (isCompleted) break;
                    }
                }
            }
            
            // Créer explicitement un SkeletonNode avec SEULEMENT les propriétés nécessaires
            // pour éviter de copier des propriétés volumineuses ou des références circulaires
            return [s.taskId, {
                taskId: s.taskId,
                parentTaskId: s.parentTaskId,
                metadata: s.metadata,
                firstUserMessage,
                isCompleted,
                completionMessage,
                children: []
            }];
        }));
        
        const forest: SkeletonNode[] = [];

        skeletonMap.forEach(node => {
            if (node.parentTaskId && skeletonMap.has(node.parentTaskId)) {
                skeletonMap.get(node.parentTaskId)!.children.push(node);
            } else {
                forest.push(node);
            }
        });

        // Appliquer la limite à la forêt de premier niveau
        const limitedForest = args.limit ? forest.slice(0, args.limit) : forest;
        
        // Convertir en ConversationSummary pour EXCLURE la propriété sequence qui contient tout le contenu
        const summaries = limitedForest.map(node => toConversationSummary(node));
        
        // 📊 LOG AGRÉGÉ FINAL (remplace les logs verbeux commentés)
        console.log(`📊 list_conversations: Found ${allSkeletons.length} conversations (workspace filtered: ${workspaceFilteredCount}), returning ${summaries.length} top-level results`);
        
        const result = JSON.stringify(summaries, null, 2);

        return { content: [{ type: 'text', text: result }] };
    }
};