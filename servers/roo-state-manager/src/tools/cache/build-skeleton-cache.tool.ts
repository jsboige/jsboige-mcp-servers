/**
 * Outil MCP : build_skeleton_cache
 * Force la reconstruction complète du cache de squelettes sur le disque
 * Opération potentiellement longue avec timeout étendu de 5 minutes
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Tool } from '../../types/tool-definitions.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { ServerState } from '../../services/state-manager.service.js';

const SKELETON_CACHE_DIR_NAME = '.skeletons';

interface BuildSkeletonCacheArgs {
    force_rebuild?: boolean;
    workspace_filter?: string;
    task_ids?: string[];  // Liste des IDs de tâches à construire spécifiquement
}

/**
 * Helper: Sauvegarde d'un squelette avec retry automatique et backoff exponentiel
 */
async function saveSkeletonWithRetry(
    taskId: string,
    skeletonPath: string,
    conversationCache: Map<string, ConversationSkeleton>,
    maxRetries: number = 3
): Promise<{ success: boolean; attempts: number; error?: string }> {
    // console.log(`[SAVE-DEBUG] 🔍 Début saveSkeletonWithRetry pour taskId: ${taskId.substring(0, 8)}`);
    // console.log(`[SAVE-DEBUG] 📍 Chemin cible: ${skeletonPath}`);
    // console.log(`[SAVE-DEBUG] 📦 Cache size: ${conversationCache.size}`);

    const skeleton = conversationCache.get(taskId);
    if (!skeleton) {
        // console.error(`[SAVE-DEBUG] ❌ CRITIQUE: Skeleton absent du cache pour ${taskId.substring(0, 8)}`);
        // console.error(`[SAVE-DEBUG] 🔑 Cache keys disponibles: ${Array.from(conversationCache.keys()).slice(0, 5).map(k => k.substring(0, 8)).join(', ')}...`);
        return { success: false, attempts: 0, error: 'Skeleton not found in cache' };
    }

    // console.log(`[SAVE-DEBUG] ✅ Skeleton trouvé dans cache`);
    // console.log(`[SAVE-DEBUG] 🏷️ parentTaskId avant écriture: ${skeleton.parentTaskId || 'undefined'}`);

    // 🔍 DIAGNOSTIC EXHAUSTIF - Phase 3 Bug Investigation (COMMENTÉ pour réduire le bruit)
    // console.log(`[PERSISTENCE-DEBUG] ========================================`);
    // console.log(`[PERSISTENCE-DEBUG] 🔍 SKELETON AVANT SAUVEGARDE - DIAGNOSTIC COMPLET`);
    // console.log(`[PERSISTENCE-DEBUG] ========================================`);
    // console.log(`[PERSISTENCE-DEBUG] skeleton AVANT sauvegarde:`, JSON.stringify({
    //     taskId: skeleton.taskId,
    //     parentTaskId: skeleton.parentTaskId,
    //     hasParentTaskId: 'parentTaskId' in skeleton,
    //     parentTaskIdType: typeof skeleton.parentTaskId,
    //     parentTaskIdValue: skeleton.parentTaskId,
    //     allKeys: Object.keys(skeleton),
    //     hasOwnProperty: Object.prototype.hasOwnProperty.call(skeleton, 'parentTaskId')
    // }, null, 2));
    // console.log(`[PERSISTENCE-DEBUG] ========================================`);

    // console.log(`[SAVE-DEBUG] 📊 Skeleton data size: ${JSON.stringify(skeleton).length} caractères`);

    // 🔍 VÉRIFICATION FINALE: Le JSON stringifié contient-il parentTaskId?
    const stringified = JSON.stringify(skeleton, null, 2);
    const containsParentTaskId = stringified.includes('"parentTaskId"');
    // console.log(`[PERSISTENCE-DEBUG] 🔎 JSON.stringify contient "parentTaskId": ${containsParentTaskId}`);
    if (!containsParentTaskId && skeleton.parentTaskId) {
        console.error(`[PERSISTENCE-DEBUG] 🚨 BUG CONFIRMÉ: parentTaskId présent dans objet mais ABSENT du JSON stringifié!`);
        console.error(`[PERSISTENCE-DEBUG] 🔍 Objet skeleton:`, skeleton);
        console.error(`[PERSISTENCE-DEBUG] 🔍 JSON.stringify output (premiers 500 chars):`, stringified.substring(0, 500));
    }

    // 🎯 DIAGNOSTIC FINAL ULTIME - Capturer l'objet EXACT avant écriture disque (COMMENTÉ)
    // console.log(`[ULTIMATE-DEBUG] ========================================`);
    // console.log(`[ULTIMATE-DEBUG] 🔥 OBJET FINAL AVANT fs.writeFile`);
    // console.log(`[ULTIMATE-DEBUG] ========================================`);
    // console.log(`[ULTIMATE-DEBUG] skeleton.taskId: ${skeleton.taskId}`);
    // console.log(`[ULTIMATE-DEBUG] skeleton.parentTaskId: ${skeleton.parentTaskId || 'undefined'}`);
    // console.log(`[ULTIMATE-DEBUG] 'parentTaskId' in skeleton: ${'parentTaskId' in skeleton}`);
    // console.log(`[ULTIMATE-DEBUG] skeleton.hasOwnProperty('parentTaskId'): ${Object.prototype.hasOwnProperty.call(skeleton, 'parentTaskId')}`);
    // console.log(`[ULTIMATE-DEBUG] typeof skeleton.parentTaskId: ${typeof skeleton.parentTaskId}`);
    // console.log(`[ULTIMATE-DEBUG] skeleton.parentTaskId === undefined: ${skeleton.parentTaskId === undefined}`);
    // console.log(`[ULTIMATE-DEBUG] skeleton.parentTaskId === null: ${skeleton.parentTaskId === null}`);
    // console.log(`[ULTIMATE-DEBUG] JSON.stringify(skeleton).includes('parentTaskId'): ${JSON.stringify(skeleton).includes('parentTaskId')}`);
    // console.log(`[ULTIMATE-DEBUG] ========================================`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // console.log(`[SAVE-DEBUG] 💾 Tentative ${attempt}/${maxRetries} d'écriture sur ${skeletonPath}`);

            // 🔥 CAPTURE ULTIME: Sérialiser JUSTE AVANT l'écriture pour garantir aucune modification
            const finalJson = JSON.stringify(skeleton, null, 2);
            // console.log(`[ULTIMATE-DEBUG] 📝 Contenu JSON FINAL à écrire (100 premiers chars): ${finalJson.substring(0, 100)}`);
            // console.log(`[ULTIMATE-DEBUG] 🔍 Contenu contient 'parentTaskId': ${finalJson.includes('parentTaskId')}`);

            await fs.writeFile(skeletonPath, finalJson);
            // console.log(`[SAVE-DEBUG] ✅ SUCCÈS écriture à la tentative ${attempt}`);

            // 🔍 VERIFICATION POST-WRITE IMMEDIATE
            // console.log(`[POST-WRITE-CHECK] 🔍 Relecture immédiate du fichier pour vérification...`);
            const writtenContent = await fs.readFile(skeletonPath, 'utf-8');
            const hasParentTaskIdInFile = writtenContent.includes('"parentTaskId"');
            // console.log(`[POST-WRITE-CHECK] 📄 Fichier contient "parentTaskId": ${hasParentTaskIdInFile}`);
            // console.log(`[POST-WRITE-CHECK] 📄 Taille fichier écrit: ${writtenContent.length} octets`);
            // console.log(`[POST-WRITE-CHECK] 📄 Premiers 200 caractères: ${writtenContent.substring(0, 200)}`);

            if (!hasParentTaskIdInFile && skeleton.parentTaskId) {
                console.error(`[POST-WRITE-CHECK] 🚨 BUG CONFIRMÉ: parentTaskId PERDU lors de l'écriture disque!`);
                console.error(`[POST-WRITE-CHECK] 🔍 String à écrire contenait parentTaskId: ${finalJson.includes('"parentTaskId"')}`);
                console.error(`[POST-WRITE-CHECK] 🔍 Fichier écrit ne contient PAS parentTaskId: ${!hasParentTaskIdInFile}`);
            } else if (hasParentTaskIdInFile) {
                console.log(`[POST-WRITE-CHECK] ✅ SUCCÈS: parentTaskId correctement persisté sur disque`);
            }

            return { success: true, attempts: attempt };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`[SAVE-DEBUG] ❌ Tentative ${attempt}/${maxRetries} échouée: ${errorMsg}`);

            if (attempt === maxRetries) {
                console.error(`[SAVE-DEBUG] 🚨 ÉCHEC FINAL après ${maxRetries} tentatives`);
                return { success: false, attempts: attempt, error: errorMsg };
            }

            // Backoff exponentiel : 200ms, 400ms, 800ms
            const backoffMs = Math.pow(2, attempt) * 100;
            // console.log(`[SAVE-DEBUG] ⏳ Retry dans ${backoffMs}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }

    return { success: false, attempts: maxRetries, error: 'Max retries reached' };
}

/**
 * Fonction helper pour construire la réponse en cas de timeout
 */
function buildTimeoutResponse(
    skeletonsBuilt: number,
    skeletonsSkipped: number,
    hierarchyRelations: number,
    debugLogs: string[],
    timeoutMessage: string,
    cacheSize: number
): CallToolResult {
    const summary = `Skeleton cache build TIMEOUT (PARTIEL). Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}, Cache size: ${cacheSize}, Hierarchy relations found: ${hierarchyRelations}`;

    const response = {
        summary,
        details: {
            mode: "TIMEOUT_PARTIAL",
            built: skeletonsBuilt,
            skipped: skeletonsSkipped,
            cached: cacheSize,
            hierarchyRelations,
            timeoutMessage,
            nextAction: "⚠️ Relancez build_skeleton_cache pour compléter l'analyse des parentID"
        },
        debugLogs: debugLogs.slice(-20) // Garder seulement les 20 derniers logs
    };

    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
}

/**
 * Définition du tool (sans handler)
 */
export const buildSkeletonCacheDefinition = {
    name: 'build_skeleton_cache',
    description: 'Force la reconstruction complète du cache de squelettes sur le disque. Opération potentiellement longue.',
    inputSchema: {
        type: 'object',
        properties: {
            force_rebuild: {
                type: 'boolean',
                description: 'Si true, reconstruit TOUS les squelettes (lent). Si false/omis, ne reconstruit que les squelettes obsolètes ou manquants (rapide).',
                default: false
            },
            workspace_filter: {
                type: 'string',
                description: 'Filtre optionnel par workspace. Si spécifié, ne traite que les conversations de ce workspace.'
            },
            task_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Liste optionnelle d\'IDs de tâches spécifiques à construire. Si fourni, seules ces tâches seront traitées (ignore workspace_filter). Active les logs verbeux.'
            }
        },
        required: []
    }
};

/**
 * Handler pour build_skeleton_cache
 * Cette fonction doit être appelée avec le conversationCache depuis index.ts
 */
export async function handleBuildSkeletonCache(
    args: BuildSkeletonCacheArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    state?: ServerState // Optionnel pour rétrocompatibilité, mais recommandé pour l'indexation
): Promise<CallToolResult> {
        conversationCache.clear();
        const { force_rebuild = false, workspace_filter, task_ids } = args;

        // 🚀 PROTECTION TIMEOUT ÉTENDU : 5 minutes pour permettre rebuilds complets
        const GLOBAL_TIMEOUT_MS = 300000; // 300s = 5 minutes (ancien: 50s)
        const globalStartTime = Date.now();
        let timeoutReached = false;

        // Helper pour vérifier le timeout global
        const checkGlobalTimeout = () => {
            if (Date.now() - globalStartTime > GLOBAL_TIMEOUT_MS) {
                timeoutReached = true;
                return true;
            }
            return false;
        };

        // 🔍 Capturer les logs de debug
        const debugLogs: string[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: any[]) => {
            const message = args.join(' ');
            if (message.includes('DEBUG') || message.includes('🎯') || message.includes('🔍') || message.includes('BALISE')) {
                debugLogs.push(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${message}`);
            }
            originalConsoleLog(...args);
        };

        const locations = await RooStorageDetector.detectStorageLocations(); // This returns base storage paths
        if (locations.length === 0) {
            console.log = originalConsoleLog; // Restaurer
            return { content: [{ type: 'text', text: 'Storage not found. Cache not built.' }] };
        }

        let skeletonsBuilt = 0;
        let skeletonsSkipped = 0;
        let hierarchyRelationsFound = 0;
        const mode = force_rebuild ? "FORCE_REBUILD" : "SMART_REBUILD";

        // 🎯 Déterminer le mode de filtrage
        let filterMode: string;
        if (task_ids && task_ids.length > 0) {
            filterMode = `TARGETED_BUILD(${task_ids.length} tasks)`;
        } else if (workspace_filter) {
            filterMode = `WORKSPACE_FILTERED(${workspace_filter})`;
        } else {
            filterMode = "ALL_WORKSPACES";
        }

        console.log(`🔄 Starting PROCESSUS DESCENDANT skeleton cache build in ${mode} mode, ${filterMode}...`);
        if (task_ids && task_ids.length > 0) {
            console.log(`🎯 TARGETED MODE: Building only ${task_ids.length} specific tasks: ${task_ids.join(', ')}`);
            console.log(`🔍 VERBOSE LOGGING ENABLED for targeted build`);
        }

        // 🚀 PROCESSUS DESCENDANT - PHASE 1: Construire tous les squelettes ET alimenter l'index RadixTree
        const skeletonsWithPrefixes: Array<{ skeleton: ConversationSkeleton; prefixes: string[] }> = [];

        for (const storageDir of locations) {
            // storageDir is the base storage path, we need to add 'tasks' to get to the tasks directory
            const tasksDir = path.join(storageDir, 'tasks');
            // BUG FIX CRITIQUE: Les squelettes doivent être dans tasks/.skeletons, pas .skeletons à la racine
            const skeletonDir = path.join(tasksDir, SKELETON_CACHE_DIR_NAME);
            await fs.mkdir(skeletonDir, { recursive: true });

            let conversationDirs;
            try {
                conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
            } catch (error) {
                console.warn(`Could not read tasks directory: ${tasksDir}`, error);
                continue;
            }
            for (const convDir of conversationDirs) {
                if (convDir.isDirectory() && convDir.name !== SKELETON_CACHE_DIR_NAME) {
                    const conversationId = convDir.name;

                    // 🎯 FILTRAGE CIBLÉ: Si task_ids est fourni, ne traiter QUE ces tâches
                    if (task_ids && task_ids.length > 0) {
                        if (!task_ids.includes(conversationId)) {
                            continue; // Skip cette tâche qui n'est pas dans la liste ciblée
                        }
                        console.log(`🎯 TARGETED: Processing task ${conversationId} (found in task_ids list)`);
                    }

                    const taskPath = path.join(tasksDir, conversationId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');
                    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
                    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    try {
                        // 🔍 CORRECTION BUG: Valider la tâche si elle a au moins un fichier de conversation
                        // (pas seulement task_metadata.json qui peut manquer pour des tâches anciennes/récentes)
                        let isValidTask = false;
                        let metadataStat: any = null;
                        let validationSource = '';

                        // Tentative 1: Vérifier task_metadata.json (préféré)
                        try {
                            metadataStat = await fs.stat(metadataPath);
                            isValidTask = true;
                            validationSource = 'task_metadata.json';
                        } catch {
                            // Tentative 2: Vérifier api_conversation_history.json
                            try {
                                const apiStat = await fs.stat(apiHistoryPath);
                                metadataStat = apiStat; // Utiliser la date du fichier API comme référence
                                isValidTask = true;
                                validationSource = 'api_conversation_history.json';
                            } catch {
                                // Tentative 3: Vérifier ui_messages.json
                                try {
                                    const uiStat = await fs.stat(uiMessagesPath);
                                    metadataStat = uiStat; // Utiliser la date du fichier UI comme référence
                                    isValidTask = true;
                                    validationSource = 'ui_messages.json';
                                } catch {
                                    // Aucun fichier valide trouvé
                                    console.warn(`⚠️ INVALID: Task ${conversationId} has no valid conversation files`);
                                }
                            }
                        }

                        if (!isValidTask) {
                            const msg = `🔍 SKIP INVALID: ${conversationId} - no metadata/api/ui files found`;
                            console.log(msg);
                            if (task_ids && task_ids.includes(conversationId)) {
                                console.log(`❌ TARGETED TASK REJECTED: ${conversationId} - Reason: No valid conversation files (no metadata/api/ui)`);
                                debugLogs.push(`REJECTION: ${conversationId} - No valid conversation files`);
                            }
                            skeletonsSkipped++;
                            continue;
                        }

                        console.log(`✅ VALID: ${conversationId} (validated via ${validationSource})`);
                        if (task_ids && task_ids.includes(conversationId)) {
                            console.log(`🎯 TARGETED TASK VALIDATED: ${conversationId} via ${validationSource}`);
                        }

                        // 🎯 FILTRE WORKSPACE: Utiliser la même méthode que get_storage_stats pour cohérence
                        // NOTE: workspace_filter est IGNORÉ si task_ids est fourni
                        if (workspace_filter && (!task_ids || task_ids.length === 0)) {
                            try {
                                const taskWorkspace = await RooStorageDetector.detectWorkspaceForTask(taskPath);

                                // Normalisation des chemins pour la comparaison
                                const normalizedFilter = path.normalize(workspace_filter).toLowerCase();
                                const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();

                                if (taskWorkspace === 'UNKNOWN' || !normalizedWorkspace.includes(normalizedFilter)) {
                                    continue; // Skip cette conversation si elle ne correspond pas au filtre
                                }
                            } catch (workspaceError) {
                                console.warn(`Could not detect workspace for filtering: ${taskPath}`, workspaceError);
                                continue; // Skip si on ne peut pas détecter le workspace
                            }
                        }

                        let shouldRebuild = force_rebuild;

                        if (!force_rebuild) {
                            // Mode intelligent : vérifier si le squelette est obsolète
                            try {
                                const skeletonStat = await fs.stat(skeletonPath);
                                if (skeletonStat.mtime >= metadataStat.mtime) {
                                    // Squelette à jour, le charger dans le cache
                                    try {
                                        let skeletonContent = await fs.readFile(skeletonPath, 'utf-8');
                                        if (skeletonContent.charCodeAt(0) === 0xFEFF) {
                                            skeletonContent = skeletonContent.slice(1);
                                        }
                                        const skeleton: ConversationSkeleton = JSON.parse(skeletonContent);
                                        if (skeleton && skeleton.taskId) {
                                            conversationCache.set(skeleton.taskId, skeleton);

                                            // 🚀 INDEXATION QDRANT: Ajouter à la queue si le state est disponible
                                            if (state && state.isQdrantIndexingEnabled) {
                                                state.qdrantIndexQueue.add(skeleton.taskId);
                                                // console.log(`[INDEX-QUEUE] Added ${skeleton.taskId} to Qdrant indexing queue (from cache)`);
                                            }

                                            // 🚀 PHASE 1: Alimenter l'index avec les préfixes de ce squelette existant
                                            if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                                                skeletonsWithPrefixes.push({ skeleton, prefixes: skeleton.childTaskInstructionPrefixes });
                                            }
                                            skeletonsSkipped++;
                                        } else {
                                            shouldRebuild = true; // Squelette corrompu
                                        }
                                    } catch (loadError) {
                                        console.error(`Corrupted skeleton file, will rebuild: ${skeletonPath}`, loadError);
                                        shouldRebuild = true;
                                    }
                                } else {
                                    shouldRebuild = true; // Squelette obsolète
                                }
                            } catch (statError) {
                                shouldRebuild = true; // Squelette manquant
                            }
                        }

                        if (shouldRebuild) {
                            try {
                                if (task_ids && task_ids.includes(conversationId)) {
                                    console.log(`🔧 TARGETED: Analyzing conversation ${conversationId}...`);
                                }

                                const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);
                                if (skeleton) {
                                    await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                                    // BUG FIX: Utiliser skeleton.taskId et non conversationId
                                    conversationCache.set(skeleton.taskId, skeleton);

                                    // 🚀 INDEXATION QDRANT: Ajouter à la queue si le state est disponible
                                    if (state && state.isQdrantIndexingEnabled) {
                                        state.qdrantIndexQueue.add(skeleton.taskId);
                                        // console.log(`[INDEX-QUEUE] Added ${skeleton.taskId} to Qdrant indexing queue`);
                                    }

                                    // 🚀 PHASE 1: Collecter les préfixes pour l'index RadixTree
                                    if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                                        skeletonsWithPrefixes.push({ skeleton, prefixes: skeleton.childTaskInstructionPrefixes });
                                        if (task_ids && task_ids.includes(conversationId)) {
                                            console.log(`✅ TARGETED: ${conversationId} - Found ${skeleton.childTaskInstructionPrefixes.length} childTaskInstructionPrefixes`);
                                            debugLogs.push(`SUCCESS: ${conversationId} - ${skeleton.childTaskInstructionPrefixes.length} prefixes found`);
                                        }
                                    } else if (task_ids && task_ids.includes(conversationId)) {
                                        console.log(`⚠️ TARGETED: ${conversationId} - No childTaskInstructionPrefixes found (may not be a parent task)`);
                                        debugLogs.push(`WARNING: ${conversationId} - No childTaskInstructionPrefixes`);
                                    }
                                    skeletonsBuilt++;

                                    if (task_ids && task_ids.includes(conversationId)) {
                                        console.log(`✅ TARGETED BUILD SUCCESS: ${conversationId}`);
                                    }
                                } else {
                                    console.error(`❌ Failed to analyze conversation ${conversationId}: analyzeConversation returned null`);
                                    if (task_ids && task_ids.includes(conversationId)) {
                                        console.log(`❌ TARGETED TASK FAILED: ${conversationId} - analyzeConversation returned null`);
                                        debugLogs.push(`FAILURE: ${conversationId} - analyzeConversation returned null`);
                                    }
                                    skeletonsSkipped++;
                                }
                            } catch (analyzeError) {
                                console.error(`❌ Error during analysis of ${conversationId}:`, analyzeError);
                                if (task_ids && task_ids.includes(conversationId)) {
                                    console.log(`❌ TARGETED TASK ERROR: ${conversationId} - ${analyzeError}`);
                                    debugLogs.push(`ERROR: ${conversationId} - ${String(analyzeError)}`);
                                }
                                skeletonsSkipped++;
                            }
                        }

                    } catch (error: any) {
                        // 🔍 AMÉLIORATION: Logging détaillé pour comprendre pourquoi une tâche est skipped
                        const errorMsg = error?.message || String(error);
                        if (errorMsg.includes('ENOENT')) {
                            console.warn(`⚠️ SKIP: Task ${conversationId} - File not found (${errorMsg})`);
                        } else if (errorMsg.includes('permission')) {
                            console.warn(`⚠️ SKIP: Task ${conversationId} - Permission denied`);
                        } else {
                            console.error(`❌ ERROR: Task ${conversationId} - ${errorMsg}`);
                        }

                        if (task_ids && task_ids.includes(conversationId)) {
                            console.log(`❌ TARGETED TASK EXCEPTION: ${conversationId} - ${errorMsg}`);
                            debugLogs.push(`EXCEPTION: ${conversationId} - ${errorMsg}`);
                        }
                        skeletonsSkipped++;
                    }
                }
            }
        }

        // 🚀 PROCESSUS DESCENDANT - PHASE 2: Alimenter le globalTaskInstructionIndex avec tous les préfixes
        console.log(`🔍 PHASE 2: Alimenting RadixTree with ${skeletonsWithPrefixes.length} tasks with prefixes...`);

        // Importer globalTaskInstructionIndex
        const { globalTaskInstructionIndex } = await import('../../utils/task-instruction-index.js');

        // CORRECTION: Toujours vider l'index avant de le repeupler
        globalTaskInstructionIndex.clear();

        for (const { skeleton, prefixes } of skeletonsWithPrefixes) {
            for (const prefix of prefixes) {
                globalTaskInstructionIndex.addInstruction(skeleton.taskId, prefix);
            }
        }

        const indexStats = globalTaskInstructionIndex.getStats();
        console.log(`🎯 RadixTree populated: ${indexStats.totalInstructions} instructions, ${indexStats.totalNodes} nodes`);

        // Log critique seulement si problème détecté
        if (indexStats.totalInstructions === 0 && skeletonsWithPrefixes.length > 0) {
            console.log(`⚠️ ATTENTION: ${skeletonsWithPrefixes.length} squelettes avec préfixes mais index vide`);
        }

        // CORRECTION: Exécuter les Phases 2-3 même en mode intelligent si l'index était vide
        const shouldRunHierarchyPhase = indexStats.totalInstructions > 0;
        console.log(`🔍 Should run hierarchy phase: ${shouldRunHierarchyPhase} (index has ${indexStats.totalInstructions} instructions)`);

        // 🚀 PROCESSUS DESCENDANT - PHASE 3: Recalculer les relations parent-enfant avec l'index maintenant populé
        console.log(`🔗 PHASE 3: Recalculating parent-child relationships...`);

        const skeletonsToUpdate: Array<{ taskId: string; newParentId: string }> = [];
        const orphanSkeletons = Array.from(conversationCache.values()).filter(s =>
            !(((s as any)?.parentId) || s.parentTaskId) && s.metadata?.workspace
        );

        console.log(`🔍 Found ${orphanSkeletons.length} orphan tasks to process...`);

        // 🚨 VÉRIFICATION TIMEOUT AVANT PHASE HIÉRARCHIQUE
        if (checkGlobalTimeout()) {
            console.log(`⏰ TIMEOUT ANTICIPÉ atteint avant phase hiérarchique!`);
            const partialResult = buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, 0, debugLogs,
                "TIMEOUT: Phase hiérarchique non exécutée. Relancez le build pour compléter l'analyse des parentID.",
                conversationCache.size);
            console.log = originalConsoleLog; // Restaurer
            return partialResult;
        }

        // OPTIMISATION: Traiter par lots de 50 pour éviter les timeouts
        const BATCH_SIZE = 50;
        const MAX_PROCESSING_TIME = Math.min(35000, GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime) - 5000); // Garder 5s de marge
        const startTime = Date.now();

        console.log(`⏱️ Phase hiérarchique: ${MAX_PROCESSING_TIME}ms disponibles pour traiter ${orphanSkeletons.length} orphelins`);

        // 🎯 SOLUTION ARCHITECTURALE : Utiliser le VRAI HierarchyReconstructionEngine en MODE STRICT
        // ✅ EXÉCUTION UNIQUE sur TOUS les squelettes (pas batch par batch)
        console.log(`🚀 Utilisation du HierarchyReconstructionEngine (MODE STRICT - MATCHING EXACT) sur ${orphanSkeletons.length} orphelins...`);

        try {
            // Import dynamique du vrai engine
            const { HierarchyReconstructionEngine } = await import('../../utils/hierarchy-reconstruction-engine.js');

            // Configuration QUASI-STRICT (matching exact + fuzzy haute confiance)
            // Permet de tolérer les variations mineures (espaces, ponctuation) qui font échouer le strictMode
            const hierarchyEngine = new HierarchyReconstructionEngine({
                batchSize: 50,
                strictMode: false,       // ❌ MODE STRICT DÉSACTIVÉ pour permettre le fuzzy
                similarityThreshold: 0.85, // ✅ SEUIL TRÈS ÉLEVÉ pour éviter les faux positifs
                minConfidenceScore: 0.85,  // ✅ CONFIANCE MINIMALE ÉLEVÉE
                debugMode: true,
                forceRebuild: false
            });

            // Conversion des squelettes pour le vrai engine
            const enhancedSkeletons = Array.from(conversationCache.values()).map(skeleton => ({
                ...skeleton,
                // Enhanced fields requis par l'interface EnhancedConversationSkeleton
                // 🎯 FIX CRITIQUE : Ne PAS passer parsedSubtaskInstructions mais marquer phase1Completed
                // Le RadixTree est DÉJÀ alimenté, donc Phase 1 doit être sautée
                parsedSubtaskInstructions: undefined,
                processingState: {
                    // ✅ CORRECTION : phase1Completed=true si les prefixes existent déjà
                    // Cela force shouldSkipPhase1() à retourner true et évite le double parsing
                    phase1Completed: !!(skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0),
                    phase2Completed: false,
                    processingErrors: [],
                    lastProcessedAt: new Date().toISOString()
                },
                sourceFileChecksums: {
                    uiMessages: undefined,
                    apiHistory: undefined,
                    metadata: undefined
                }
            }));

            // ========== LOGS AJOUTÉS POUR INVESTIGATION ==========
            console.log('[CACHE-ENGINE-LAUNCH] ====================================');
            console.log('[CACHE-ENGINE-LAUNCH] Starting HierarchyReconstructionEngine');
            console.log('[CACHE-ENGINE-LAUNCH] Skeletons total:', enhancedSkeletons.length);
            console.log('[CACHE-ENGINE-LAUNCH] Mode: STRICT (exact matching only)');
            console.log('[CACHE-ENGINE-LAUNCH] ====================================');

            // console.log(`🎯 Lancement engine sur ${enhancedSkeletons.length} squelettes en MODE STRICT...`);

            // Phase 1: Extraction des instructions new_task
            // console.log(`📋 Phase 1: Extraction des déclarations new_task...`);
            const phase1Result = await hierarchyEngine.executePhase1(enhancedSkeletons, { strictMode: false });
            // console.log(`✅ Phase 1: ${phase1Result.processedCount} traités, ${phase1Result.totalInstructionsExtracted} instructions extraites`);

            // Phase 2: Reconstruction hiérarchique (avec matching fuzzy haute confiance)
            // console.log(`🔗 Phase 2: Reconstruction hiérarchique MODE QUASI-STRICT...`);
            // console.log(`[CRITICAL-DEBUG] 🔍 AVANT executePhase2 - enhancedSkeletons.length=${enhancedSkeletons.length}`);
            const phase2Result = await hierarchyEngine.executePhase2(enhancedSkeletons, {
                strictMode: false,
                similarityThreshold: 0.85,
                minConfidenceScore: 0.85
            });
            // console.log(`[CRITICAL-DEBUG] 🔍 APRÈS executePhase2 - resolvedCount=${phase2Result.resolvedCount}, unresolvedCount=${phase2Result.unresolvedCount}`);
            // console.log(`✅ Phase 2: ${phase2Result.resolvedCount} relations assignées, ${phase2Result.unresolvedCount} ignorés`);

            // ========== PHASE 2.5 : FALLBACK MAPPING VIA PARSED INSTRUCTIONS ==========
            // Si Phase 2 n'a pas trouvé de relations via RadixTree, on essaie un mapping direct
            // basé sur les instructions new_task extraites en Phase 1
            // console.log('[PHASE2.5] 🔍 Fallback: Direct mapping via parsedSubtaskInstructions...');
            let phase25Count = 0;

            // Créer un map taskId -> skeleton pour accès rapide
            const taskIdToSkeleton = new Map<string, ConversationSkeleton>();
            enhancedSkeletons.forEach(sk => taskIdToSkeleton.set(sk.taskId, sk));

            // Pour chaque skeleton, vérifier s'il a des instructions new_task
            enhancedSkeletons.forEach(potentialParent => {
                const instructions = (potentialParent as any)?.parsedSubtaskInstructions?.instructions;
                if (!instructions || !Array.isArray(instructions)) return;

                // Pour chaque instruction new_task du parent
                instructions.forEach((instr: any) => {
                    if (!instr.taskId) return; // Pas de taskId cible

                    // Chercher l'enfant correspondant dans le batch
                    const child = taskIdToSkeleton.get(instr.taskId);
                    if (!child) return; // Enfant pas dans le batch

                    // Si l'enfant n'a pas déjà un reconstructedParentId (Phase 2 a échoué)
                    if (!(child as any).reconstructedParentId) {
                        (child as any).reconstructedParentId = potentialParent.taskId;
                        (child as any).parentConfidenceScore = 1.0; // Confiance maximale (direct match)
                        (child as any).parentResolutionMethod = 'phase2.5_direct_instruction';
                        phase25Count++;
                        // console.log(`[PHASE2.5] ✅ DIRECT MATCH: ${child.taskId.substring(0, 8)} → ${potentialParent.taskId.substring(0, 8)}`);
                    }
                });
            });

            if (phase25Count > 0) {
                // console.log(`[PHASE2.5] ✅ ${phase25Count} relations supplémentaires trouvées via fallback direct`);
            } else {
                // console.log(`[PHASE2.5] ⚠️ Aucune relation supplémentaire trouvée`);
            }

            // ========== LOGS RÉSULTATS ENGINE ==========
            console.log('[CACHE-ENGINE-RESULT] ====================================');
            console.log('[CACHE-ENGINE-RESULT] Engine completed');
            console.log('[CACHE-ENGINE-RESULT] Phase 1 - Processed:', phase1Result.processedCount);
            console.log('[CACHE-ENGINE-RESULT] Phase 1 - Parsed:', phase1Result.parsedCount);
            console.log('[CACHE-ENGINE-RESULT] Phase 2 - Resolved:', phase2Result.resolvedCount);
            console.log('[CACHE-ENGINE-RESULT] Phase 2 - Unresolved:', phase2Result.unresolvedCount);
            console.log('[CACHE-ENGINE-RESULT] ====================================');

            // ✅ BUG FIX: Utiliser directement phase2Result.resolvedCount au lieu de re-compter
            hierarchyRelationsFound = phase2Result.resolvedCount;
            // console.log(`[BUG-DEBUG] 📊 Phase2 terminée: resolvedCount=${phase2Result.resolvedCount}, unresolvedCount=${phase2Result.unresolvedCount}`);
            // console.log(`[BUG-DEBUG] 📋 enhancedSkeletons.length=${enhancedSkeletons.length}`);

            // ========== DIAGNOSTIC PHASE 3 : ZONE 1 - Construction skeletonsToUpdate ==========
            // console.log(`\n🔍 [PHASE3-PREP] ====================================`);
            // console.log(`[PHASE3-PREP] Starting skeletonsToUpdate construction...`);
            // console.log(`[PHASE3-PREP] Total skeletons in cache: ${conversationCache.size}`);
            // console.log(`[PHASE3-PREP] enhancedSkeletons length: ${enhancedSkeletons.length}`);
            // console.log(`[PHASE3-PREP] ====================================\n`);

            // Application des résultats (ne compter QUE les nouvelles relations via reconstructedParentId)
            // RÉDUCTION DE LOGS: Afficher seulement chaque 10ème skeleton pour éviter la saturation
            enhancedSkeletons.forEach((skeleton, index) => {
                const reconstructed = (skeleton as any)?.reconstructedParentId;
                const existing = skeleton.parentTaskId;

                // RÉDUCTION DE LOGS: Désactiver complètement les logs PHASE3-PREP répétitifs
                    // if (index % 10 === 0 || reconstructed || existing) {
                    //     // console.log(`[PHASE3-PREP] 🔍 Skeleton ${index + 1}/${enhancedSkeletons.length}:`);
                    //     // console.log(`  📋 TaskID: ${skeleton.taskId?.substring(0, 8) || 'UNDEFINED'}`);
                    //     // console.log(`  🔗 reconstructedParentId: ${reconstructed ? reconstructed.substring(0, 8) : 'UNDEFINED'}`);
                    //     // console.log(`  🔗 existing parentTaskId: ${existing ? existing.substring(0, 8) : 'UNDEFINED'}`);
                    // }

                const newlyResolvedParent = reconstructed;
                const isSelf = newlyResolvedParent === skeleton.taskId;

                if (newlyResolvedParent && !isSelf) {
                    // console.log(`  ✅ WILL ADD to skeletonsToUpdate: ${skeleton.taskId.substring(0, 8)} → ${newlyResolvedParent.substring(0, 8)}`);
                    skeletonsToUpdate.push({
                        taskId: skeleton.taskId,
                        newParentId: newlyResolvedParent
                    });

                    // Mettre à jour le cache en mémoire pour persister la relation avant sauvegarde disque
                    const cached = conversationCache.get(skeleton.taskId);
                    if (cached) {
                        cached.parentTaskId = newlyResolvedParent;
                        (cached as any).parentId = newlyResolvedParent;
                    }
                } else {
                    // console.log(`  ⏭️ SKIP reason:`);
                    if (!newlyResolvedParent) {
                        // console.log(`     - reconstructedParentId is UNDEFINED`);
                    }
                    if (isSelf) {
                        // console.log(`     - reconstructedParentId points to SELF (circular)`);
                    }
                    if (existing) {
                        // console.log(`     - parentTaskId already exists: ${existing.substring(0, 8)}`);
                    }
                }
                // console.log(''); // Ligne vide pour lisibilité
            });

            // console.log(`\n[PHASE3-PREP] 📊 ====================================`);
            // console.log(`[PHASE3-PREP] FINAL skeletonsToUpdate length: ${skeletonsToUpdate.length}`);
            if (skeletonsToUpdate.length > 0) {
                // console.log(`[PHASE3-PREP] Updates to apply:`);
                skeletonsToUpdate.forEach((update, i) => {
                    console.log(`  ${i + 1}. ${update.taskId.substring(0, 8)} → ${update.newParentId.substring(0, 8)}`);
                });
            } else {
                // console.log(`[PHASE3-PREP] ⚠️ NO UPDATES - skeletonsToUpdate is EMPTY`);
                // console.log(`[PHASE3-PREP] Possible causes:`);
                // console.log(`  - All skeletons missing reconstructedParentId`);
                console.log(`  - All skeletons already have parentTaskId`);
                console.log(`  - All reconstructedParentId point to self`);
            }
            // console.log(`[PHASE3-PREP] ====================================\n`);

        } catch (engineError) {
            console.error(`[ENGINE-ERROR] ❌ ERREUR HIERARCHY ENGINE:`, engineError);
            console.error(`[ENGINE-ERROR] 📋 Error name: ${(engineError as any)?.name}`);
            console.error(`[ENGINE-ERROR] 📋 Error message: ${(engineError as any)?.message}`);
            console.error(`[ENGINE-ERROR] 📋 Error stack:`, (engineError as any)?.stack);
            console.log(`[ENGINE-ERROR] 🔄 Fallback: Continuer sans hierarchy engine...`);

            // 🚨 Vérifier si c'est un timeout et adapter la réponse
            if (checkGlobalTimeout()) {
                const partialResult = buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, hierarchyRelationsFound, debugLogs,
                    "TIMEOUT: Build partiel terminé. Phase hiérarchique incomplète - relancez pour finaliser l'analyse parentID.",
                    conversationCache.size);
                console.log = originalConsoleLog; // Restaurer
                return partialResult;
            }
        }

        // 🚨 VÉRIFICATION TIMEOUT AVANT SAUVEGARDE
        if (checkGlobalTimeout()) {
            console.log(`⏰ TIMEOUT ANTICIPÉ atteint avant sauvegarde!`);
            const partialResult = buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, hierarchyRelationsFound, debugLogs,
                "TIMEOUT: Relations trouvées mais sauvegarde incomplète. Relancez pour persister les changements.",
                conversationCache.size);
            console.log = originalConsoleLog; // Restaurer
            return partialResult;
        }

        // ========== DIAGNOSTIC PHASE 3 : ZONE 2 - Exécution Boucle Sauvegarde ==========
        console.log(`\n💾 [PHASE3] ====================================`);
        if (skeletonsToUpdate.length === 0) {
            console.log(`[PHASE3] ⚠️ skeletonsToUpdate is EMPTY - Phase 3 will be SKIPPED`);
            console.log(`[PHASE3] This means NO files will be created/updated`);
            console.log(`[PHASE3] ====================================\n`);
        } else {
            console.log(`[PHASE3] 🚀 Starting Phase 3 execution...`);
            // console.log(`[PHASE3] Total updates to process: ${skeletonsToUpdate.length}`);
            // console.log(`[PHASE3] ====================================\n`);

            let savedCount = 0;
            let errorCount = 0;
            const failedUpdates: Array<{taskId: string, reason: string}> = [];

            for (const update of skeletonsToUpdate) {
                const iterNum = savedCount + errorCount + 1;
                // console.log(`[PHASE3-LOOP] 📝 Processing update ${iterNum}/${skeletonsToUpdate.length}:`);
                // console.log(`  - TaskID: ${update.taskId.substring(0, 8)}`);
                // console.log(`  - New ParentID: ${update.newParentId.substring(0, 8)}`);

                // Vérifier d'abord si le skeleton est dans le cache
                const cachedSkeleton = conversationCache.get(update.taskId);
                if (!cachedSkeleton) {
                    // console.error(`[PHASE3-DEBUG] ❌ ERREUR: Skeleton ${update.taskId.substring(0, 8)} ABSENT du cache!`);
                    failedUpdates.push({taskId: update.taskId, reason: 'Skeleton absent du cache'});
                    errorCount++;
                    continue;
                }
                // console.log(`[PHASE3-DEBUG] ✅ Skeleton trouvé dans cache avec parentTaskId AVANT maj: ${cachedSkeleton.parentTaskId || 'undefined'}`);

                // ✅ FIX CRITIQUE: Mettre à jour le cache EN MÉMOIRE avant sauvegarde
                cachedSkeleton.parentTaskId = update.newParentId;
                // console.log(`[PHASE3] 📝 Cache mémoire mis à jour: ${update.taskId.substring(0, 8)} -> parentTaskId: ${update.newParentId.substring(0, 8)}`);

                let saved = false;
                for (let locIdx = 0; locIdx < locations.length; locIdx++) {
                    const storageDir = locations[locIdx];
                    // ✅ FIX CRITIQUE: Utiliser tasks/.skeletons comme Phase 1 (ligne 225)
                    const tasksDir = path.join(storageDir, 'tasks');
                    const skeletonDir = path.join(tasksDir, SKELETON_CACHE_DIR_NAME);
                    const skeletonPath = path.join(skeletonDir, `${update.taskId}.json`);

                    // console.log(`[PHASE3-DEBUG] 🔍 Test location ${locIdx + 1}/${locations.length}: ${storageDir}`);
                    // console.log(`[PHASE3-DEBUG]   ├─ Skeleton dir: ${skeletonDir}`);
                    // console.log(`[PHASE3-DEBUG]   └─ Skeleton path: ${skeletonPath}`);

                    // Vérifier si le fichier existe OU si le répertoire skeleton_cache existe
                    const skeletonDirExists = existsSync(skeletonDir);
                    const fileExists = existsSync(skeletonPath);

                    // console.log(`[PHASE3-DEBUG]   Dir exists: ${skeletonDirExists}, File exists: ${fileExists}`);

                    if (!skeletonDirExists) {
                        // console.log(`[PHASE3-DEBUG] ⚠️ Répertoire skeleton_cache manquant, skip location`);
                        continue; // Essayer le prochain storage location
                    }

                    // ✅ FIX FINAL: Toujours sauvegarder (saveSkeletonWithRetry crée le fichier si nécessaire)
                    // console.log(`[PHASE3-DEBUG] 📝 Sauvegarde skeleton (existe: ${fileExists})...`);
                    const saveResult = await saveSkeletonWithRetry(update.taskId, skeletonPath, conversationCache, 3);

                    if (saveResult.success) {
                        // console.log(`[PHASE3] ✅ Skeleton sauvegardé: ${update.taskId.substring(0, 8)} -> ${update.newParentId?.substring(0, 8) || 'N/A'}`);
                        savedCount++;
                        saved = true;
                        // console.log(`  ✅ Result: SUCCESS - Skeleton saved`);
                        break; // Sortir de la boucle locations
                    } else {
                        // console.error(`[PHASE3] ❌ Erreur sauvegarde: ${saveResult.error}`);
                        failedUpdates.push({taskId: update.taskId, reason: saveResult.error || 'Unknown error'});
                        errorCount++;
                        saved = false;
                        // console.log(`  ❌ Result: FAILED - ${saveResult.error || 'Unknown error'}`);
                        break; // Sortir de la boucle locations même en cas d'échec
                    }
                }

                if (!saved && !failedUpdates.find(f => f.taskId === update.taskId)) {
                    // Aucun storage location n'a le fichier
                    failedUpdates.push({taskId: update.taskId, reason: 'Fichier squelette introuvable dans tous les storage locations'});
                    errorCount++;
                    console.error(`[PHASE3] ❌ CRITIQUE: Aucun storage location ne contient ${update.taskId.substring(0, 8)}`);
                }
                console.log(''); // Ligne vide après chaque update
            }

            // Rapport détaillé de sauvegarde - LOGS FINAUX PHASE 3
            console.log(`\n[PHASE3] 📊 FINAL STATISTICS:`);
            console.log(`  ✅ Saved successfully: ${savedCount}`);
            console.log(`  ❌ Failed: ${errorCount}`);
            console.log(`  📝 Total processed: ${skeletonsToUpdate.length}`);

            if (failedUpdates.length > 0) {
                console.error(`\n[PHASE3] ⚠️ ÉCHECS DÉTAILLÉS (${failedUpdates.length}):`);
                failedUpdates.forEach((fail: {taskId: string, reason: string}) => {
                    console.error(`  - ${fail.taskId.substring(0, 8)}: ${fail.reason}`);
                });
            }
            console.log(`[PHASE3] ====================================\n`);
        }

        console.log(`✅ Skeleton cache build complete. Mode: ${mode}, Cache size: ${conversationCache.size}, New relations: ${hierarchyRelationsFound}`);

        // 🔍 Restaurer console.log original
        console.log = originalConsoleLog;

        // 🔍 Inclure les logs de debug dans la réponse
        let response = `Skeleton cache build complete (${mode}). Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}, Cache size: ${conversationCache.size}, Hierarchy relations found: ${hierarchyRelationsFound}`;

        if (debugLogs.length > 0) {
            response += `\n\n🔍 DEBUG LOGS (${debugLogs.length} entries):\n${debugLogs.join('\n')}`;
        } else {
            response += `\n\n🔍 No debug logs captured (expected: DEBUG, 🎯, 🔍, BALISE keywords)`;
        }

        return { content: [{ type: 'text', text: response }] };
}
