/**
 * Outil pour lister toutes les conversations avec filtres et tri
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { SkeletonCacheService } from '../../services/skeleton-cache.service.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

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
 * Interface pour les messages API (api_conversation_history.json)
 */
interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{
        type: 'text' | 'tool_use' | 'tool_result';
        text?: string;
        name?: string;
    }>;
    text?: string;
    say?: string;
    timestamp?: string;
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
                pendingSubtaskOnly: {
                    type: 'boolean',
                    description: 'Si true, retourne uniquement les tâches ayant une instruction de sous-tâche non complétée'
                },
                contentPattern: {
                    type: 'string',
                    description: 'Filtre les tâches contenant ce texte dans leurs messages (recherche insensible à la casse)'
                },
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
            workspace?: string,
            pendingSubtaskOnly?: boolean,
            contentPattern?: string
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

        // Filtre : Tâches en attente de sous-tâche (NOUVEAU)
        if (args.pendingSubtaskOnly === true) {
            console.log(`[DEBUG] Filtering by pendingSubtaskOnly`);
            const beforeCount = allSkeletons.length;
            
            const pendingTasks: ConversationSkeleton[] = [];
            for (const skeleton of allSkeletons) {
                try {
                    const hasPending = await hasPendingSubtask(skeleton.taskId);
                    if (hasPending) {
                        pendingTasks.push(skeleton);
                    }
                } catch (error) {
                    console.warn(`[FILTER] Error checking pending subtask for ${skeleton.taskId}:`, error);
                }
            }
            
            allSkeletons = pendingTasks;
            console.log(`[DEBUG] Pending subtask filter: ${beforeCount} -> ${allSkeletons.length} tasks`);
        }

        // Filtre : Recherche de contenu (NOUVEAU)
        if (args.contentPattern && args.contentPattern.trim().length > 0) {
            console.log(`[DEBUG] Filtering by contentPattern: "${args.contentPattern}"`);
            const beforeCount = allSkeletons.length;
            
            const matchingTasks: ConversationSkeleton[] = [];
            for (const skeleton of allSkeletons) {
                try {
                    const matches = await matchesContentPattern(skeleton.taskId, args.contentPattern);
                    if (matches) {
                        matchingTasks.push(skeleton);
                    }
                } catch (error) {
                    console.warn(`[FILTER] Error checking content pattern for ${skeleton.taskId}:`, error);
                }
            }
            
            allSkeletons = matchingTasks;
            console.log(`[DEBUG] Content pattern filter: ${beforeCount} -> ${allSkeletons.length} tasks`);
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

/**
 * Détecte si une tâche a une sous-tâche en attente de completion
 */
async function hasPendingSubtask(taskId: string): Promise<boolean> {
    try {
        const apiMessages = await loadApiMessages(taskId);
        return detectPendingSubtaskInMessages(apiMessages);
    } catch (error) {
        console.warn(`[hasPendingSubtask] Error for task ${taskId}:`, error);
        return false;
    }
}

/**
 * Vérifie si les messages d'une tâche contiennent un motif de texte
 */
async function matchesContentPattern(taskId: string, pattern: string): Promise<boolean> {
    try {
        const apiMessages = await loadApiMessages(taskId);
        const normalizedPattern = pattern.toLowerCase().trim();
        
        return apiMessages.some(msg => {
            const textContent = extractTextFromMessage(msg).toLowerCase();
            return textContent.includes(normalizedPattern);
        });
    } catch (error) {
        console.warn(`[matchesContentPattern] Error for task ${taskId}:`, error);
        return false;
    }
}

/**
 * Charge les messages API d'une tâche
 */
async function loadApiMessages(taskId: string): Promise<ApiMessage[]> {
    const tasksPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
    const apiHistoryPath = path.join(tasksPath, taskId, 'api_conversation_history.json');
    
    const content = await fs.readFile(apiHistoryPath, 'utf-8');
    const data = JSON.parse(content);
    
    // Le fichier peut être un array direct ou un objet avec une propriété messages
    return Array.isArray(data) ? data : (data.messages || []);
}

/**
 * Extrait le texte d'un message API (gère les différents formats)
 */
function extractTextFromMessage(message: ApiMessage): string {
    // Gestion du champ text (format UI)
    if (message.text) {
        return message.text;
    }
    
    // Gestion du champ say (format UI alternatif)
    if (message.say) {
        return message.say;
    }
    
    // Gestion du content (format API standard)
    if (typeof message.content === 'string') {
        return message.content;
    }
    
    if (Array.isArray(message.content)) {
        return message.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join(' ');
    }
    
    return '';
}

/**
 * Logique de détection de sous-tâche en attente
 */
function detectPendingSubtaskInMessages(messages: ApiMessage[]): boolean {
    // Parcours inversé pour trouver la dernière instruction de sous-tâche
    let lastSubtaskInstructionIndex = -1;
    
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        
        const content = extractTextFromMessage(message);
        
        if (content.includes('<new_task>') || content.includes('<task>')) {
            lastSubtaskInstructionIndex = i;
            break;
        }
    }
    
    // Aucune instruction trouvée
    if (lastSubtaskInstructionIndex === -1) {
        return false;
    }
    
    // Vérification qu'aucun message de completion ne suit
    for (let j = lastSubtaskInstructionIndex + 1; j < messages.length; j++) {
        const followingMessage = messages[j];
        if (followingMessage.role !== 'user') continue;
        
        const followingContent = extractTextFromMessage(followingMessage);
        
        if (followingContent.includes('[new_task completed]') ||
            followingContent.includes('[task completed]')) {
            return false; // La sous-tâche a été complétée
        }
    }
    
    return true; // En attente de completion
}