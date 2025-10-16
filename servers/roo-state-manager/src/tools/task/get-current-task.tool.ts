/**
 * Outil pour récupérer la tâche actuellement active dans un workspace donné
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import { scanDiskForNewTasks } from './disk-scanner.js';

/**
 * Interface pour le résultat de get_current_task
 */
interface CurrentTaskResult {
    task_id: string;
    title?: string;
    workspace_path?: string;
    created_at: string;
    updated_at: string;
    message_count: number;
    action_count: number;
    total_size: number;
    parent_task_id?: string;
    mode?: string;
}

/**
 * Trouve la tâche la plus récente dans le cache, optionnellement filtrée par workspace
 */
async function findMostRecentTask(
    conversationCache: Map<string, ConversationSkeleton>,
    workspace?: string,
    forceRescan: boolean = true
): Promise<ConversationSkeleton | undefined> {
    // ÉTAPE 1: Scanner le disque pour nouvelles conversations
    if (forceRescan) {
        try {
            const newTasks = await scanDiskForNewTasks(conversationCache, workspace);
            
            // Ajouter les nouvelles tâches au cache
            for (const task of newTasks) {
                conversationCache.set(task.taskId, task);
            }
            
            if (newTasks.length > 0) {
                console.log(`[get_current_task] Discovered ${newTasks.length} new task(s) not in cache`);
            }
        } catch (error) {
            console.error('[get_current_task] Error during disk scan:', error);
            // Continue avec le cache existant si le scan échoue
        }
    }
    
    // ÉTAPE 2: Filtrer et trier (logique existante inchangée)
    if (conversationCache.size === 0) {
        return undefined;
    }
    
    let validTasks = Array.from(conversationCache.values()).filter(
        s => s.metadata && s.metadata.lastActivity
    );
    
    // Filtrer par workspace si spécifié
    if (workspace) {
        const normalizedWorkspace = normalizePath(workspace);
        validTasks = validTasks.filter(s => 
            s.metadata.workspace && 
            normalizePath(s.metadata.workspace) === normalizedWorkspace
        );
    }
    
    if (validTasks.length === 0) {
        return undefined;
    }
    
    // Retourner la tâche avec le lastActivity le plus récent
    return validTasks.reduce((latest, current) => {
        return new Date(latest.metadata.lastActivity) > new Date(current.metadata.lastActivity) 
            ? latest 
            : current;
    });
}

/**
 * Définition de l'outil get_current_task
 */
export const getCurrentTaskTool = {
    definition: {
        name: 'get_current_task',
        description: 'Récupère la tâche actuellement active dans un workspace donné. Si aucun workspace n\'est spécifié, utilise le workspace actuel détecté automatiquement.',
        inputSchema: {
            type: 'object',
            properties: {
                workspace: {
                    type: 'string',
                    description: 'Chemin du workspace (détection auto si omis)'
                }
            }
        }
    },
    
    /**
     * Handler pour l'outil get_current_task
     */
    handler: async (
        args: { workspace?: string },
        conversationCache: Map<string, ConversationSkeleton>,
        contextWorkspace?: string,
        ensureSkeletonCacheIsFresh?: () => Promise<void>
    ): Promise<CallToolResult> => {
        console.log('[get_current_task] Called with args:', JSON.stringify(args));
        console.log('[get_current_task] Context workspace:', contextWorkspace);
        
        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        if (ensureSkeletonCacheIsFresh) {
            await ensureSkeletonCacheIsFresh();
        }
        
        // Déterminer le workspace à utiliser : args > context > error
        const targetWorkspace = args.workspace || contextWorkspace;
        
        if (!targetWorkspace) {
            throw new Error(
                'Workspace non fourni et impossible à détecter automatiquement. ' +
                'Veuillez spécifier un workspace explicitement.'
            );
        }
        
        console.log('[get_current_task] Using workspace:', targetWorkspace);
        
        // Chercher la tâche la plus récente avec scan disque activé
        const currentTask = await findMostRecentTask(conversationCache, targetWorkspace, true);
        
        if (!currentTask) {
            throw new Error(
                `Aucune tâche trouvée dans le workspace "${targetWorkspace}". ` +
                'Vérifiez que le chemin du workspace est correct ou que des conversations existent.'
            );
        }
        
        // Construire le résultat
        const result: CurrentTaskResult = {
            task_id: currentTask.taskId,
            title: currentTask.metadata.title,
            workspace_path: currentTask.metadata.workspace,
            created_at: currentTask.metadata.createdAt,
            updated_at: currentTask.metadata.lastActivity,
            message_count: currentTask.metadata.messageCount,
            action_count: currentTask.metadata.actionCount,
            total_size: currentTask.metadata.totalSize,
            parent_task_id: currentTask.parentTaskId,
            mode: currentTask.metadata.mode
        };
        
        console.log('[get_current_task] Found task:', currentTask.taskId);
        
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }]
        };
    }
};