import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../types/conversation.js';
import {
    SmartTruncationEngine,
    ContentTruncator,
    SmartOutputFormatter,
    DEFAULT_SMART_TRUNCATION_CONFIG,
    ViewConversationTreeArgs
} from './smart-truncation/index.js';

/**
 * Tronque un message en gardant le début et la fin
 */
function truncateMessage(message: string, truncate: number): string {
    if (truncate === 0) {
        return message;
    }
    const lines = message.split('\n');
    if (lines.length <= truncate * 2) {
        return message;
    }
    const start = lines.slice(0, truncate).join('\n');
    const end = lines.slice(-truncate).join('\n');
    return `${start}\n[...]\n${end}`;
}

/**
 /**
  * Trouve la tâche la plus récente dans le cache, optionnellement filtrée par workspace
  */
 function findLatestTask(conversationCache: Map<string, ConversationSkeleton>, workspace?: string): ConversationSkeleton | undefined {
     if (conversationCache.size === 0) {
         return undefined;
     }
     let validTasks = Array.from(conversationCache.values()).filter(
         s => s.metadata && s.metadata.lastActivity
     );
     
     // Filtrer par workspace si spécifié
     if (workspace) {
         validTasks = validTasks.filter(s => s.metadata.workspace === workspace);
     }
     
     if (validTasks.length === 0) {
         return undefined;
     }
     return validTasks.reduce((latest, current) => {
         return new Date(latest.metadata.lastActivity) > new Date(current.metadata.lastActivity) ? latest : current;
     });
 }
/**
 * Logique principale pour view_conversation_tree
 */
function handleViewConversationTreeExecution(
    args: ViewConversationTreeArgs,
    conversationCache: Map<string, ConversationSkeleton>
): CallToolResult {
    const { view_mode = 'chain', detail_level = 'skeleton', max_output_length = 300000, current_task_id } = args;
    let { truncate = 0 } = args;
    
    // Gestion intelligente de truncate selon detail_level si non spécifié explicitement
    if (truncate === 0) {
        switch (detail_level) {
            case 'skeleton':
                truncate = 3;
                break;
            case 'summary':
                truncate = 10;
                break;
            case 'full':
                truncate = 0;
                break;
        }
    }
    let { task_id, workspace } = args;

    if (!task_id) {
        // Si le cache est vide, message explicite attendu par les tests
        if (conversationCache.size === 0) {
            throw new Error("Cache is empty and no task_id was provided. Cannot determine the latest task.");
        }
        // Sélection automatique de la tâche la plus récente (tous workspaces si non fourni)
        const latestTask = findLatestTask(conversationCache, workspace);
        if (!latestTask) {
            if (workspace) {
                throw new Error(`No tasks found for workspace '${workspace}'. Please verify the workspace path or provide a specific task_id.`);
            }
            throw new Error("No tasks found. Cannot determine the latest task.");
        }
        task_id = latestTask.taskId;
    }

    const skeletons = Array.from(conversationCache.values());
    const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

    // 🎯 DÉTECTION TÂCHE ACTUELLE : Utiliser current_task_id si fourni, sinon ne rien marquer
    // Note: L'auto-détection par lastActivity est peu fiable car la tâche en cours d'exécution
    // n'a pas encore son timestamp mis à jour. Pour une détection fiable, passer current_task_id.
    const currentTaskId: string | null = current_task_id || null;

    const getTaskChain = (startTaskId: string): ConversationSkeleton[] => {
        const chain: ConversationSkeleton[] = [];
        let currentId: string | undefined = startTaskId;
        while (currentId) {
            const skeleton = skeletonMap.get(currentId);
            if (skeleton) {
                chain.unshift(skeleton);
                currentId = skeleton.parentTaskId;
            } else {
                break;
            }
        }
        return chain;
    };

    const formatTask = (skeleton: ConversationSkeleton, indent: string): string => {
        // 🎯 Marquer la tâche actuelle - Comparer les 8 premiers caractères (UUIDs courts)
        const nodeShortId = (skeleton.taskId || '').substring(0, 8);
        const currentShortId = (currentTaskId || '').substring(0, 8);
        const currentMarker = (nodeShortId === currentShortId && currentShortId) ? ' (TÂCHE ACTUELLE)' : '';
        
        let output = `${indent}▶️ Task: ${skeleton.metadata.title || skeleton.taskId} (ID: ${skeleton.taskId})${currentMarker}\n`;
        output += `${indent}  Parent: ${skeleton.parentTaskId || 'None'}\n`;
        output += `${indent}  Messages: ${skeleton.metadata.messageCount}\n`;
        
        skeleton.sequence.forEach(item => {
            if ('role' in item) { // Message user/assistant
                const role = item.role === 'user' ? '👤 User' : '🤖 Assistant';
                const message = truncateMessage(item.content, truncate);
                const messageLines = message.split('\n').map(l => `${indent}    | ${l}`).join('\n');
                output += `${indent}  [${role}]:\n${messageLines}\n`;
            } else { // Action - format selon detail_level
                const icon = item.type === 'command' ? '⚙️' : '🛠️';
                const timestamp = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('fr-FR') : '';
                
                switch (detail_level) {
                    case 'skeleton':
                        // Métadonnées seulement : nom + statut + timestamp
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        break;
                    case 'summary':
                        // Paramètres tronqués inclus
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        if (item.parameters && Object.keys(item.parameters).length > 0) {
                            const paramStr = JSON.stringify(item.parameters, null, 2);
                            const truncatedParams = truncateMessage(paramStr, 5);
                            output += `${indent}    Params: ${truncatedParams}\n`;
                        }
                        break;
                    case 'full':
                        // Paramètres complets (ActionMetadata n'a pas de propriété result)
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        if (item.parameters && Object.keys(item.parameters).length > 0) {
                            const paramStr = JSON.stringify(item.parameters, null, 2);
                            output += `${indent}    Params: ${paramStr}\n`;
                        }
                        if (item.content_size !== undefined) {
                            output += `${indent}    Content Size: ${item.content_size} chars\n`;
                        }
                        if (item.line_count !== undefined) {
                            output += `${indent}    Line Count: ${item.line_count}\n`;
                        }
                        break;
                }
            }
        });
        return output;
    };

    // Estimation intelligente de la taille de sortie
    const estimateOutputSize = (skeletons: ConversationSkeleton[]): number => {
        let totalSize = 0;
        for (const skeleton of skeletons) {
            totalSize += 200; // En-tête de tâche
            for (const item of skeleton.sequence) {
                if ('role' in item) {
                    totalSize += item.content.length + 100; // Message + formatage
                } else {
                    totalSize += 150; // Action + formatage
                }
            }
        }
        return totalSize;
    };

    let tasksToDisplay: ConversationSkeleton[] = [];
    const mainTask = skeletonMap.get(task_id);
    if (!mainTask) {
        throw new Error(`Task with ID '${task_id}' not found in cache.`);
    }

    switch (view_mode) {
        case 'single':
            tasksToDisplay.push(mainTask);
            break;
        case 'chain':
            tasksToDisplay = getTaskChain(task_id);
            break;
        case 'cluster':
            const chain = getTaskChain(task_id);
            if (chain.length > 0) {
                const directParentId = chain[chain.length - 1].parentTaskId;
                if (directParentId) {
                    const siblings = skeletons.filter(s => s.parentTaskId === directParentId);
                    // Display parent, then all its children (siblings of the target + target itself)
                    const parentTask = skeletonMap.get(directParentId);
                    if(parentTask) tasksToDisplay.push(parentTask);
                    tasksToDisplay.push(...siblings);
                } else {
                     tasksToDisplay = chain; // It's a root task, show its chain
                }
            } else {
                 tasksToDisplay.push(mainTask);
            }
            break;
    }
    
    // 🎯 POINT D'AIGUILLAGE : Smart Truncation vs Legacy
    if (args.smart_truncation === true) {
        // ✨ NOUVEAU : Algorithme de troncature intelligente avec gradient
        return handleSmartTruncation(tasksToDisplay, args, view_mode, detail_level, max_output_length, currentTaskId);
    } else {
        // 🔄 LEGACY : Comportement original préservé (par défaut)
        return handleLegacyTruncation(tasksToDisplay, args, view_mode, detail_level, max_output_length, truncate, currentTaskId);
    }
}

/**
 * 🔄 ALGORITHME LEGACY (comportement original préservé)
 */
function handleLegacyTruncation(
    tasksToDisplay: ConversationSkeleton[],
    args: ViewConversationTreeArgs,
    view_mode: string,
    detail_level: string,
    max_output_length: number,
    truncate: number,
    currentTaskId: string | null
): CallToolResult {
    // Logique intelligente de troncature ORIGINALE
    // Utilisation du SizeCalculator du module smart-truncation pour cohérence
    const estimatedSize = tasksToDisplay.reduce((sum, task) => {
        let taskSize = 200; // En-tête de tâche
        for (const item of task.sequence) {
            if ('role' in item) {
                taskSize += item.content.length + 100; // Message + formatage
            } else {
                taskSize += 150; // Action + formatage
            }
        }
        return sum + taskSize;
    }, 0);
    
    const formatTask = createFormatTaskFunction(detail_level, truncate, currentTaskId);
    
    // Logique intelligente de troncature basée sur detail_level (ORIGINALE)
    if (detail_level !== 'full' && truncate === 0 && estimatedSize > max_output_length) {
        // Pour skeleton/summary seulement : forcer une troncature intelligente si la sortie est trop grande
        const totalMessages = tasksToDisplay.reduce((count, task) =>
            count + task.sequence.filter(item => 'role' in item).length, 0);
        truncate = Math.max(2, Math.floor(max_output_length / (estimatedSize / Math.max(1, totalMessages * 20))));
    }
    // Mode full : JAMAIS de troncature automatique, respecter strictement la demande de l'utilisateur
    // truncate reste à sa valeur initiale (0 par défaut ou valeur explicite de l'utilisateur)
    
    let formattedOutput = `Conversation Tree (Mode: ${view_mode}, Detail: ${detail_level})\n======================================\n`;
    if (estimatedSize > max_output_length && truncate > 0) {
        formattedOutput += `⚠️  Sortie estimée: ${Math.round(estimatedSize/1000)}k chars, limite: ${Math.round(max_output_length/1000)}k chars, troncature: ${truncate} lignes\n\n`;
    }
    tasksToDisplay.forEach((task, index) => {
        const indent = '  '.repeat(index);
        formattedOutput += formatTask(task, indent);
    });

    return { content: [{ type: 'text', text: formattedOutput }] };
}

/**
 * ✨ NOUVEL ALGORITHME DE TRONCATURE INTELLIGENTE
 */
function handleSmartTruncation(
    tasksToDisplay: ConversationSkeleton[],
    args: ViewConversationTreeArgs,
    view_mode: string,
    detail_level: string,
    max_output_length: number,
    currentTaskId: string | null
): CallToolResult {
    try {
        // Configuration avec overrides utilisateur
        const smartConfig = {
            ...DEFAULT_SMART_TRUNCATION_CONFIG,
            maxOutputLength: max_output_length,
            ...args.smart_truncation_config
        };
        
        // Application de l'algorithme intelligent
        const engine = new SmartTruncationEngine(smartConfig);
        const truncationResult = engine.apply(tasksToDisplay);
        
        // Application des plans de troncature
        const truncatedTasks = ContentTruncator.applyTruncationPlans(
            tasksToDisplay,
            truncationResult.taskPlans
        );
        
        // Formatage de la sortie avec informations intelligentes
        let formattedOutput = SmartOutputFormatter.formatTruncatedOutput(
            truncatedTasks,
            truncationResult.taskPlans,
            view_mode,
            detail_level
        );
        
        // Formatage des tâches (réutilise la fonction existante)
        const formatTask = createFormatTaskFunction(detail_level, 0, currentTaskId); // Troncature géré par smart system
        truncatedTasks.forEach((task, index) => {
            const indent = '  '.repeat(index);
            formattedOutput += formatTask(task, indent);
        });
        
        // Diagnostic en debug si demandé
        if (truncationResult.diagnostics.length > 0) {
            formattedOutput += '\n' + '='.repeat(50) + '\n';
            formattedOutput += '🔍 Smart Truncation Diagnostics:\n';
            truncationResult.diagnostics.forEach(diag => {
                formattedOutput += `  • ${diag}\n`;
            });
        }
        
        return { content: [{ type: 'text', text: formattedOutput }] };
        
    } catch (error) {
        // Fallback automatique vers l'algorithme legacy en cas d'erreur
        console.warn('SmartTruncation failed, falling back to legacy algorithm:', error);
        const fallbackArgs = { ...args, smart_truncation: false };
        return handleViewConversationTreeExecution(fallbackArgs, new Map(tasksToDisplay.map(t => [t.taskId, t])));
    }
}

/**
 * Factory pour créer la fonction formatTask (extraction pour réutilisation)
 */
function createFormatTaskFunction(detail_level: string, truncate: number, currentTaskId: string | null): (skeleton: ConversationSkeleton, indent: string) => string {
    return (skeleton: ConversationSkeleton, indent: string): string => {
        // 🎯 Marquer la tâche actuelle - Comparer les 8 premiers caractères (UUIDs courts)
        const nodeShortId = (skeleton.taskId || '').substring(0, 8);
        const currentShortId = (currentTaskId || '').substring(0, 8);
        const currentMarker = (nodeShortId === currentShortId && currentShortId) ? ' (TÂCHE ACTUELLE)' : '';
        
        let output = `${indent}▶️ Task: ${skeleton.metadata.title || skeleton.taskId} (ID: ${skeleton.taskId})${currentMarker}\n`;
        output += `${indent}  Parent: ${skeleton.parentTaskId || 'None'}\n`;
        output += `${indent}  Messages: ${skeleton.metadata.messageCount}\n`;
        
        skeleton.sequence.forEach(item => {
            if ('role' in item) { // Message user/assistant
                const role = item.role === 'user' ? '👤 User' : '🤖 Assistant';
                const message = truncateMessage(item.content, truncate);
                const messageLines = message.split('\n').map(l => `${indent}    | ${l}`).join('\n');
                output += `${indent}  [${role}]:\n${messageLines}\n`;
            } else { // Action - format selon detail_level
                const icon = item.type === 'command' ? '⚙️' : '🛠️';
                const timestamp = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('fr-FR') : '';
                
                switch (detail_level) {
                    case 'skeleton':
                        // Métadonnées seulement : nom + statut + timestamp
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        break;
                    case 'summary':
                        // Paramètres tronqués inclus
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        if (item.parameters && Object.keys(item.parameters).length > 0) {
                            const paramStr = JSON.stringify(item.parameters, null, 2);
                            const truncatedParams = truncateMessage(paramStr, 5);
                            output += `${indent}    Params: ${truncatedParams}\n`;
                        }
                        break;
                    case 'full':
                        // Paramètres complets (ActionMetadata n'a pas de propriété result)
                        output += `${indent}  [${icon} ${item.name}] → ${item.status}${timestamp ? ` (${timestamp})` : ''}\n`;
                        if (item.parameters && Object.keys(item.parameters).length > 0) {
                            const paramStr = JSON.stringify(item.parameters, null, 2);
                            output += `${indent}    Params: ${paramStr}\n`;
                        }
                        if (item.content_size !== undefined) {
                            output += `${indent}    Content Size: ${item.content_size} chars\n`;
                        }
                        if (item.line_count !== undefined) {
                            output += `${indent}    Line Count: ${item.line_count}\n`;
                        }
                        break;
                }
            }
        });
        return output;
    };
}

/**
 * Objet outil pour view_conversation_tree
 */
export const viewConversationTree = {
    name: 'view_conversation_tree',
    description: 'Fournit une vue arborescente et condensée des conversations pour une analyse rapide.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'L\'ID de la tâche de départ. Si non fourni, workspace devient obligatoire.' },
            workspace: { type: 'string', description: 'Chemin du workspace pour trouver la tâche la plus récente. Obligatoire si task_id non fourni.' },
            current_task_id: { type: 'string', description: 'ID de la tâche en cours d\'exécution pour marquage explicite comme "(TÂCHE ACTUELLE)". Si omis, aucune tâche ne sera marquée.' },
            view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], default: 'chain', description: 'Le mode d\'affichage.' },
            detail_level: { type: 'string', enum: ['skeleton', 'summary', 'full'], default: 'skeleton', description: 'Niveau de détail: skeleton (métadonnées seulement), summary (résumé), full (complet).' },
            truncate: { type: 'number', default: 0, description: 'Nombre de lignes à conserver au début et à la fin de chaque message. 0 pour vue complète (défaut intelligent).' },
            max_output_length: { type: 'number', default: 300000, description: 'Limite maximale de caractères en sortie. Au-delà, force la troncature. (AUGMENTÉ: 300K vs 150K)' },
            smart_truncation: { type: 'boolean', default: false, description: '🧠 Activer l\'algorithme de troncature intelligente avec gradient (NOUVEAU)' },
            smart_truncation_config: {
                type: 'object',
                description: '⚙️ Configuration avancée pour la troncature intelligente (NOUVEAU)',
                properties: {
                    gradientStrength: { type: 'number', description: 'Force du gradient exponentiel (défaut: 2.0)' },
                    minPreservationRate: { type: 'number', description: 'Taux minimum de préservation pour les extrêmes (défaut: 0.9)' },
                    maxTruncationRate: { type: 'number', description: 'Taux maximum de troncature pour le centre (défaut: 0.7)' }
                }
            }
        },
    },
    handler: (args: any, conversationCache: Map<string, ConversationSkeleton>): CallToolResult => {
        return handleViewConversationTreeExecution(args, conversationCache);
    }
};