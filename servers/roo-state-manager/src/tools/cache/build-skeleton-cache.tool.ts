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

const SKELETON_CACHE_DIR_NAME = '.skeletons';

interface BuildSkeletonCacheArgs {
    force_rebuild?: boolean;
    workspace_filter?: string;
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
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
        conversationCache.clear();
        const { force_rebuild = false, workspace_filter } = args;
        
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
        const filterMode = workspace_filter ? `WORKSPACE_FILTERED(${workspace_filter})` : "ALL_WORKSPACES";

        console.log(`🔄 Starting PROCESSUS DESCENDANT skeleton cache build in ${mode} mode, ${filterMode}...`);

        // 🚀 PROCESSUS DESCENDANT - PHASE 1: Construire tous les squelettes ET alimenter l'index RadixTree
        const skeletonsWithPrefixes: Array<{ skeleton: ConversationSkeleton; prefixes: string[] }> = [];
        
        for (const storageDir of locations) {
            // storageDir is the base storage path, we need to add 'tasks' to get to the tasks directory
            const tasksDir = path.join(storageDir, 'tasks');
            const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
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
                            console.log(`🔍 SKIP INVALID: ${conversationId} - no metadata/api/ui files found`);
                            skeletonsSkipped++;
                            continue;
                        }
                        
                        console.log(`✅ VALID: ${conversationId} (validated via ${validationSource})`);
                        
                        // 🎯 FILTRE WORKSPACE: Utiliser la même méthode que get_storage_stats pour cohérence
                        if (workspace_filter) {
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
                                const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);
                                if (skeleton) {
                                    await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                                    // BUG FIX: Utiliser skeleton.taskId et non conversationId
                                    conversationCache.set(skeleton.taskId, skeleton);
                                    // 🚀 PHASE 1: Collecter les préfixes pour l'index RadixTree
                                    if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                                        skeletonsWithPrefixes.push({ skeleton, prefixes: skeleton.childTaskInstructionPrefixes });
                                    }
                                    skeletonsBuilt++;
                                } else {
                                    console.error(`❌ Failed to analyze conversation ${conversationId}: analyzeConversation returned null`);
                                    skeletonsSkipped++;
                                }
                            } catch (analyzeError) {
                                console.error(`❌ Error during analysis of ${conversationId}:`, analyzeError);
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
            
            // Configuration STRICT comme demandé (matching exact seulement)
            const hierarchyEngine = new HierarchyReconstructionEngine({
                batchSize: 50,
                strictMode: true,        // ✅ MODE STRICT = MATCHING EXACT
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
            
            console.log(`🎯 Lancement engine sur ${enhancedSkeletons.length} squelettes en MODE STRICT...`);
            
            // Phase 1: Extraction des instructions new_task (avec matching exact)
            console.log(`📋 Phase 1: Extraction des déclarations new_task en MODE STRICT...`);
            const phase1Result = await hierarchyEngine.executePhase1(enhancedSkeletons, { strictMode: true });
            console.log(`✅ Phase 1: ${phase1Result.processedCount} traités, ${phase1Result.totalInstructionsExtracted} instructions extraites`);
            
            // Phase 2: Reconstruction hiérarchique (avec matching exact)
            console.log(`🔗 Phase 2: Reconstruction hiérarchique MODE STRICT...`);
            const phase2Result = await hierarchyEngine.executePhase2(enhancedSkeletons, { strictMode: true });
            console.log(`✅ Phase 2: ${phase2Result.resolvedCount} relations assignées, ${phase2Result.unresolvedCount} ignorés`);
            
            // ✅ BUG FIX: Utiliser directement phase2Result.resolvedCount au lieu de re-compter
            hierarchyRelationsFound = phase2Result.resolvedCount;
            
            // Application des résultats (ne compter QUE les nouvelles relations via reconstructedParentId)
            enhancedSkeletons.forEach(skeleton => {
                const newlyResolvedParent = (skeleton as any)?.reconstructedParentId;
                if (newlyResolvedParent && newlyResolvedParent !== skeleton.taskId) {
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

                    console.log(`🎯 Relation MODE STRICT: ${skeleton.taskId.substring(0, 8)} → ${newlyResolvedParent.substring(0, 8)}`);
                }
            });
            
            console.log(`🎉 BILAN ENGINE MODE STRICT: ${hierarchyRelationsFound} relations trouvées !`);
            
        } catch (engineError) {
            console.error(`❌ Erreur HierarchyReconstructionEngine:`, engineError);
            console.log(`🔄 Fallback: Continuer sans hierarchy engine...`);
            
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
        
        console.log(`🔗 Found ${skeletonsToUpdate.length} parent-child relationships to apply...`);
        
        // Appliquer les mises à jour de hiérarchie (sans sauvegarde immédiate pour éviter timeout)
        for (const update of skeletonsToUpdate) {
            const skeleton = conversationCache.get(update.taskId);
            if (skeleton) {
                skeleton.parentTaskId = update.newParentId;
                // OPTIMISATION: Reporter la sauvegarde sur disque en arrière-plan
                // La sauvegarde sera faite lors du prochain rebuild ou sur demande
            }
        }
        
        // Sauvegarder TOUS les squelettes modifiés (correction bug MAX_SAVES)
        let savedCount = 0;
        for (const update of skeletonsToUpdate) {
            try {
                for (const storageDir of locations) {
                    const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
                    const skeletonPath = path.join(skeletonDir, `${update.taskId}.json`);
                    if (existsSync(skeletonPath)) {
                        const skeleton = conversationCache.get(update.taskId);
                        if (skeleton) {
                            await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                            savedCount++;
                        }
                        break;
                    }
                }
            } catch (saveError) {
                console.error(`Failed to save updated skeleton for ${update.taskId}:`, saveError);
            }
        }
        
        console.log(`📝 Saved ${savedCount}/${skeletonsToUpdate.length} updated skeletons to disk`);
        
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