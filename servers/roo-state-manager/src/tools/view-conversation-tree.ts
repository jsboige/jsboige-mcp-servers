import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../types/conversation.js';
import {
    SmartTruncationEngine,
    ContentTruncator,
    SmartOutputFormatter,
    DEFAULT_SMART_TRUNCATION_CONFIG,
    ViewConversationTreeArgs
} from './smart-truncation/index.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { GenericError, GenericErrorCode } from '../types/errors.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';

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
 * Logique principale pour view_conversation_tree (version asynchrone)
 */
async function handleViewConversationTreeExecutionAsync(
    args: ViewConversationTreeArgs,
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    const { view_mode = 'chain', detail_level = 'skeleton', max_output_length = 300000, current_task_id } = args;
    let { truncate = 0 } = args;
    
    // Gestion intelligente de truncate selon detail_level si non spécifié explicitement
    // NOTE: truncate valeur LIGNES (pas caractères) - pour summary, 100 permet ~200 lignes/message
    if (truncate === 0) {
        switch (detail_level) {
            case 'skeleton':
                truncate = 20; // #901 Fix: 3→20 — 3 lines was unreadable
                break;
            case 'summary':
                truncate = 0; // #901 Fix: no truncation for summary — smart_truncation handles length
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
            throw new GenericError("Cache is empty and no task_id was provided. Cannot determine latest task.", GenericErrorCode.INVALID_ARGUMENT);
        }
        // Sélection automatique de la tâche la plus récente (tous workspaces si non fourni)
        const latestTask = findLatestTask(conversationCache, workspace);
        if (!latestTask) {
            if (workspace) {
                throw new GenericError(`No tasks found for workspace '${workspace}'. Please verify workspace path or provide a specific task_id.`, GenericErrorCode.INVALID_ARGUMENT);
            }
            throw new GenericError("No tasks found. Cannot determine latest task.", GenericErrorCode.INVALID_ARGUMENT);
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

                // #901: skeleton shows first 300 chars (was 50 — unusable)
                // #902: respect truncate parameter in skeleton mode
                if (detail_level === 'skeleton') {
                    if (truncate === 0) {
                        // truncate=0: show full message (single line format)
                        const summary = item.content.replace(/\n/g, ' ');
                        output += `${indent}  [${role}]: ${summary}\n`;
                    } else if (truncate > 0) {
                        // truncate>0: apply truncateMessage then format as single line
                        const truncated = truncateMessage(item.content, truncate);
                        const summary = truncated.replace(/\n/g, ' ');
                        output += `${indent}  [${role}]: ${summary}\n`;
                    } else {
                        // Fallback: show first 300 chars (legacy behavior)
                        const summary = item.content.substring(0, 300).replace(/\n/g, ' ');
                        const ellipsis = item.content.length > 300 ? '...' : '';
                        output += `${indent}  [${role}]: ${summary}${ellipsis}\n`;
                    }
                } else {
                    // Summary/Full : comportement original
                    const message = truncateMessage(item.content, truncate);
                    const messageLines = message.split('\n').map(l => `${indent}    | ${l}`).join('\n');
                    output += `${indent}  [${role}]:\n${messageLines}\n`;
                }
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
                            const truncatedParams = truncateMessage(paramStr, 15); // #901: 5→15 lines
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
    let mainTask = skeletonMap.get(task_id);
    if (!mainTask) {
        throw new GenericError(`Task with ID '${task_id}' not found in cache.`, GenericErrorCode.INVALID_ARGUMENT);
    }

    // FIX #584: Lazy load full skeleton if sequence is empty but messageCount suggests content exists
    // This happens when scanDiskForNewTasks creates minimal skeletons for discovery
    // FIX #594: Throw explicit error instead of failing silently when lazy loading fails
    if (mainTask.sequence.length === 0 && mainTask.metadata.messageCount > 0) {
        console.log(`[view] Lazy loading full skeleton for ${task_id} (messageCount: ${mainTask.metadata.messageCount})`);

        // Find the task path by checking all storage locations
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        let taskPath: string | null = null;
        let locationsChecked: string[] = [];

        for (const locationPath of storageLocations) {
            const potentialPath = path.join(locationPath, 'tasks', task_id);
            locationsChecked.push(potentialPath);
            try {
                const stats = await fs.stat(potentialPath);
                if (stats.isDirectory()) {
                    taskPath = potentialPath;
                    break;
                }
            } catch {
                // Location doesn't have this task, continue to next
            }
        }

        if (taskPath) {
            const fullSkeleton = await RooStorageDetector.analyzeConversation(task_id, taskPath);
            if (fullSkeleton && fullSkeleton.sequence.length > 0) {
                // Update the cache with complete skeleton
                conversationCache.set(task_id, fullSkeleton);
                // Refresh mainTask reference
                mainTask = fullSkeleton;
                console.log(`[view] Successfully loaded ${fullSkeleton.sequence.length} sequence items for ${task_id}`);
            } else {
                // Task found but analyzeConversation returned null/empty
                throw new GenericError(
                    `Task '${task_id}' found at path but analysis failed. ` +
                    `The task files may be corrupted or in an unexpected format. ` +
                    `Checked ${locationsChecked.length} storage locations.`,
                    GenericErrorCode.INVALID_ARGUMENT,
                    { taskId: task_id, locationsChecked, taskPath }
                );
            }
        } else {
            // Task path not found in any storage location
            throw new GenericError(
                `Task '${task_id}' has ${mainTask.metadata.messageCount} messages but the task directory was not found in any storage location. ` +
                `Checked ${locationsChecked.length} location(s): ${storageLocations.slice(0, 3).join(', ')}${storageLocations.length > 3 ? '...' : ''}. ` +
                `The task may have been deleted or the storage locations may be misconfigured.`,
                GenericErrorCode.INVALID_ARGUMENT,
                { taskId: task_id, messageCount: mainTask.metadata.messageCount, locationsChecked, storageLocations }
            );
        }
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
                    // Display parent, then all its children (siblings of target + target itself)
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
        return handleSmartTruncationAsync(tasksToDisplay, args, view_mode, detail_level, max_output_length, currentTaskId);
    } else {
        // 🔄 LEGACY : Comportement original préservé (par défaut)
        return handleLegacyTruncationAsync(tasksToDisplay, args, view_mode, detail_level, max_output_length, truncate, currentTaskId);
    }
}

/**
 * Logique principale pour view_conversation_tree (version synchrone - pour compatibilité)
 */
function handleViewConversationTreeExecution(
    args: ViewConversationTreeArgs,
    conversationCache: Map<string, ConversationSkeleton>
): CallToolResult {
    const { view_mode = 'chain', detail_level = 'skeleton', max_output_length = 300000, current_task_id } = args;
    let { truncate = 0 } = args;
    
    // Gestion intelligente de truncate selon detail_level si non spécifié explicitement
    // NOTE: truncate valeur LIGNES (pas caractères) - pour summary, 100 permet ~200 lignes/message
    if (truncate === 0) {
        switch (detail_level) {
            case 'skeleton':
                truncate = 20; // #901 Fix: 3→20 — 3 lines was unreadable
                break;
            case 'summary':
                truncate = 0; // #901 Fix: no truncation for summary — smart_truncation handles length
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
            throw new GenericError("Cache is empty and no task_id was provided. Cannot determine latest task.", GenericErrorCode.INVALID_ARGUMENT);
        }
        // Sélection automatique de la tâche la plus récente (tous workspaces si non fourni)
        const latestTask = findLatestTask(conversationCache, workspace);
        if (!latestTask) {
            if (workspace) {
                throw new GenericError(`No tasks found for workspace '${workspace}'. Please verify workspace path or provide a specific task_id.`, GenericErrorCode.INVALID_ARGUMENT);
            }
            throw new GenericError("No tasks found. Cannot determine latest task.", GenericErrorCode.INVALID_ARGUMENT);
        }
        task_id = latestTask.taskId;
    }

    const skeletons = Array.from(conversationCache.values());
    const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

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

    let tasksToDisplay: ConversationSkeleton[] = [];
    const mainTask = skeletonMap.get(task_id);
    if (!mainTask) {
        throw new GenericError(`Task with ID '${task_id}' not found in cache.`, GenericErrorCode.INVALID_ARGUMENT);
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
                    const parentTask = skeletonMap.get(directParentId);
                    if(parentTask) tasksToDisplay.push(parentTask);
                    tasksToDisplay.push(...siblings);
                } else {
                     tasksToDisplay = chain;
                }
            } else {
                 tasksToDisplay.push(mainTask);
            }
            break;
    }
    
    // Version synchrone sans sauvegarde fichier
    if (args.smart_truncation === true) {
        return handleSmartTruncation(tasksToDisplay, args, view_mode, detail_level, max_output_length, currentTaskId);
    } else {
        return handleLegacyTruncation(tasksToDisplay, args, view_mode, detail_level, max_output_length, truncate, currentTaskId);
    }
}

/**
 * Helper pour sauvegarder le résultat dans un fichier si output_file est spécifié
 */
async function saveToFileIfRequested(
    output_file: string | undefined,
    content: string
): Promise<{ saved: boolean; filePath?: string; error?: string }> {
    if (!output_file) {
        return { saved: false };
    }

    try {
        // Résoudre le chemin relatif par rapport au workspace
        const fullPath = path.resolve(process.cwd(), output_file);
        
        // Créer les répertoires parents si nécessaire
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        
        // Écrire le contenu formaté
        await fs.writeFile(fullPath, content, 'utf-8');
        
        return { saved: true, filePath: fullPath };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { saved: false, error: errorMsg };
    }
}

/**
 * Wrapper pour rendre handleLegacyTruncation asynchrone
 */
async function handleLegacyTruncationAsync(
    tasksToDisplay: ConversationSkeleton[],
    args: ViewConversationTreeArgs,
    view_mode: string,
    detail_level: string,
    max_output_length: number,
    truncate: number,
    currentTaskId: string | null
): Promise<CallToolResult> {
    const result = handleLegacyTruncation(
        tasksToDisplay,
        args,
        view_mode,
        detail_level,
        max_output_length,
        truncate,
        currentTaskId
    );

    const contentItem = result.content[0];
    const treeOutput = (contentItem.type === 'text' ? contentItem.text : '') as string;
 
    // Sauvegarder dans un fichier si demandé
    const saveResult = await saveToFileIfRequested(args.output_file, treeOutput);
    
    if (saveResult.saved && saveResult.filePath) {
        return {
            content: [{
                type: 'text',
                text: `✅ Arbre sauvegardé dans: ${saveResult.filePath}\n\n${treeOutput}`
            }]
        };
    } else if (saveResult.error) {
        return {
            content: [{
                type: 'text',
                text: `❌ Erreur lors de la sauvegarde: ${saveResult.error}\n\n${treeOutput}`
            }]
        };
    }

    return result;
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
    
    // Logique intelligente de troncature basée sur detail_level (ORIGINALE)
    // FIX #833: also recalculate when truncate was auto-set (not user-specified) but output still exceeds limit
    // The auto-set value (20 for skeleton) is a default, not an explicit user choice
    const wasTruncateAutoSet = args.truncate === undefined || args.truncate === 0;
    if (detail_level !== 'full' && wasTruncateAutoSet && estimatedSize > max_output_length) {
        // Pour skeleton/summary seulement : forcer une troncature intelligente si la sortie est trop grande
        const totalMessages = tasksToDisplay.reduce((count, task) =>
            count + task.sequence.filter(item => 'role' in item).length, 0);
        truncate = Math.max(2, Math.floor(max_output_length / (estimatedSize / Math.max(1, totalMessages * 20))));
    }
    // Mode full : JAMAIS de troncature automatique, respecter strictement la demande de l'utilisateur
    // truncate reste à sa valeur initiale (0 par défaut ou valeur explicite de l'utilisateur)

    // FIX #833: create formatTask AFTER truncate recalculation so the closure captures the correct value
    const formatTask = createFormatTaskFunction(detail_level, truncate, currentTaskId);

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
 * Wrapper pour rendre handleSmartTruncation asynchrone
 */
async function handleSmartTruncationAsync(
    tasksToDisplay: ConversationSkeleton[],
    args: ViewConversationTreeArgs,
    view_mode: string,
    detail_level: string,
    max_output_length: number,
    currentTaskId: string | null
): Promise<CallToolResult> {
    const result = handleSmartTruncation(
        tasksToDisplay,
        args,
        view_mode,
        detail_level,
        max_output_length,
        currentTaskId
    );

    const contentItem = result.content[0];
    const treeOutput = (contentItem.type === 'text' ? contentItem.text : '') as string;
 
    // Sauvegarder dans un fichier si demandé
    const saveResult = await saveToFileIfRequested(args.output_file, treeOutput);
    
    if (saveResult.saved && saveResult.filePath) {
        return {
            content: [{
                type: 'text',
                text: `✅ Arbre sauvegardé dans: ${saveResult.filePath}\n\n${treeOutput}`
            }]
        };
    } else if (saveResult.error) {
        return {
            content: [{
                type: 'text',
                text: `❌ Erreur lors de la sauvegarde: ${saveResult.error}\n\n${treeOutput}`
            }]
        };
    }

    return result;
}

/**
 * FIX P0-1d: Limites de troncature adaptées au detail_level
 * Quand smart_truncation est activé, ces limites garantissent que
 * le moteur de troncature se déclenche effectivement au lieu de
 * laisser passer tout à 300K (bug "0% compression")
 */
function getSmartTruncationLimit(detail_level: string): number {
    switch (detail_level) {
        case 'skeleton': return 15000;   // ~3-4 pages de squelette
        case 'summary':  return 50000;   // ~12 pages de résumé
        case 'full':     return 150000;  // ~35 pages de détail
        default:         return 50000;
    }
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
        // FIX P0-1d: Utiliser des limites adaptées au detail_level quand smart_truncation est activé
        // Le default de 300K est trop haut - les conversations ne l'atteignent jamais,
        // donc excessSize = 0 et aucune troncature ne se déclenche (bug "0% compression")
        const wasExplicitlySet = args.smart_truncation_config?.maxOutputLength !== undefined;
        const effectiveMaxOutput = wasExplicitlySet
            ? max_output_length
            : Math.min(max_output_length, getSmartTruncationLimit(detail_level));

        // Configuration avec overrides utilisateur
        const smartConfig = {
            ...DEFAULT_SMART_TRUNCATION_CONFIG,
            maxOutputLength: effectiveMaxOutput,
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

                // #901: skeleton shows first 300 chars (was 50 — unusable)
                // #902: respect truncate parameter in skeleton mode
                if (detail_level === 'skeleton') {
                    if (truncate === 0) {
                        // truncate=0: show full message (single line format)
                        const summary = item.content.replace(/\n/g, ' ');
                        output += `${indent}  [${role}]: ${summary}\n`;
                    } else if (truncate > 0) {
                        // truncate>0: apply truncateMessage then format as single line
                        const truncated = truncateMessage(item.content, truncate);
                        const summary = truncated.replace(/\n/g, ' ');
                        output += `${indent}  [${role}]: ${summary}\n`;
                    } else {
                        // Fallback: show first 300 chars (legacy behavior)
                        const summary = item.content.substring(0, 300).replace(/\n/g, ' ');
                        const ellipsis = item.content.length > 300 ? '...' : '';
                        output += `${indent}  [${role}]: ${summary}${ellipsis}\n`;
                    }
                } else {
                    // Summary/Full : comportement original
                    const message = truncateMessage(item.content, truncate);
                    const messageLines = message.split('\n').map(l => `${indent}    | ${l}`).join('\n');
                    output += `${indent}  [${role}]:\n${messageLines}\n`;
                }
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
                            const truncatedParams = truncateMessage(paramStr, 15); // #901: 5→15 lines
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
            },
            output_file: { type: 'string', description: 'Chemin optionnel pour sauvegarder l\'arbre dans un fichier markdown' }
        },
    },
    handler: async (args: any, conversationCache: Map<string, ConversationSkeleton>): Promise<CallToolResult> => {
        return handleViewConversationTreeExecutionAsync(args, conversationCache);
    }
};
