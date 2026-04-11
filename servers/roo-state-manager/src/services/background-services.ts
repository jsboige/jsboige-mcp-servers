/**
 * Services de background pour l'architecture à 2 niveaux
 * Niveau 1: Reconstruction temps réel des squelettes
 * Niveau 2: Indexation Qdrant asynchrone non-bloquante
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ConversationSkeleton, SkeletonHeader } from '../types/conversation.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ServerState } from './state-manager.service.js';
import { ANTI_LEAK_CONFIG } from '../config/server-config.js';
import { TaskIndexer, getHostIdentifier } from './task-indexer.js';
// REMOVED: import * as toolExports — was unused, added 6s to startup by importing ALL tools
import { RooStorageDetectorError, RooStorageDetectorErrorCode } from '../types/errors.js';
// #1140: Lazy import — RooSyncService loads 17 heavy modules (~6s).
// Only needed when HEARTBEAT_AUTO_START=true (disabled by default).
// import { RooSyncService } from './RooSyncService.js';

/**
 * Extract the SkeletonHeader from a full ConversationSkeleton.
 * Only metadata, prefixes, and flags — no sequence.
 */
export function toHeader(skeleton: ConversationSkeleton): SkeletonHeader {
    return {
        taskId: skeleton.taskId,
        parentTaskId: skeleton.parentTaskId,
        metadata: skeleton.metadata,
        isCompleted: skeleton.isCompleted,
        truncatedInstruction: skeleton.truncatedInstruction,
        childTaskInstructionPrefixes: skeleton.childTaskInstructionPrefixes,
    };
}

/** Index filename — lightweight metadata for all skeletons, loaded at startup */
const SKELETON_INDEX_FILENAME = '_skeleton_index.json';

/**
 * Structure of the skeleton index file.
 * Entries are SkeletonHeaders — no sequence data.
 */
interface SkeletonIndex {
    version: number;
    generatedAt: string;
    count: number;
    entries: SkeletonHeader[];
}

/**
 * #1110 FIX: Load skeleton INDEX at startup — metadata only, no sequences.
 *
 * Strategy:
 *  1. Load _skeleton_index.json (single file, ~1-2MB for 7000+ tasks) → instant
 *  2. Populate cache with lightweight skeletons (sequence: [])
 *  3. Full skeletons loaded on-demand by view/summarize, or by background worker
 *
 * Result: startup <1s instead of 90s+ on slow machines.
 */
export async function loadSkeletonsFromDisk(conversationCache: Map<string, SkeletonHeader>): Promise<void> {
    try {
        const startTime = Date.now();
        console.log('[Startup] Loading skeleton index...');
        const storageLocations = await RooStorageDetector.detectStorageLocations();

        if (storageLocations.length === 0) {
            console.warn('Aucun emplacement de stockage Roo trouvé');
            return;
        }

        const tasksDir = path.join(storageLocations[0], 'tasks');
        const skeletonsCacheDir = path.join(tasksDir, '.skeletons');
        const indexPath = path.join(skeletonsCacheDir, SKELETON_INDEX_FILENAME);

        const loadedFromIndex = await loadSkeletonsFromIndex(indexPath, conversationCache);

        const elapsed = Date.now() - startTime;

        if (loadedFromIndex) {
            console.log(`[Startup] Loaded ${conversationCache.size} skeleton metadata from index in ${elapsed}ms`);
        } else {
            // No index yet — first run or index corrupted.
            // Don't block startup. Background worker will build the cache and generate the index.
            console.log(`[Startup] No skeleton index found (${elapsed}ms). Background worker will populate cache.`);
        }
    } catch (error) {
        console.error('[Startup] Failed to load skeleton index:', error);
    }
}

/**
 * Load skeleton metadata from the index file.
 * Returns true if successful, false if index is missing/corrupted.
 */
async function loadSkeletonsFromIndex(
    indexPath: string,
    conversationCache: Map<string, SkeletonHeader>
): Promise<boolean> {
    try {
        let content = await fs.readFile(indexPath, 'utf8');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        const index: SkeletonIndex = JSON.parse(content);
        if (!index.entries || !Array.isArray(index.entries)) {
            console.warn('[Index] Invalid index format');
            return false;
        }

        for (const entry of index.entries) {
            if (entry.taskId) {
                conversationCache.set(entry.taskId, entry);
            }
        }

        return conversationCache.size > 0;
    } catch {
        return false;
    }
}

/**
 * Load a single full skeleton from disk (with sequence).
 * Called on-demand when view/summarize needs the full conversation data.
 */
export async function loadFullSkeleton(
    taskId: string,
    conversationCache: Map<string, SkeletonHeader>
): Promise<ConversationSkeleton | null> {
    try {
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        if (storageLocations.length === 0) return null;

        const skeletonsCacheDir = path.join(storageLocations[0], 'tasks', '.skeletons');
        const filePath = path.join(skeletonsCacheDir, `${taskId}.json`);

        let content = await fs.readFile(filePath, 'utf8');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        const skeleton: ConversationSkeleton = JSON.parse(content);

        // #1325: Validate that the loaded skeleton actually has a sequence.
        // saveSkeletonToDisk can create header-only files when no existing
        // file was present — these lack a sequence and should not be trusted.
        if (!Array.isArray(skeleton.sequence) || skeleton.sequence.length === 0) {
            return null;
        }

        // Update cache with header only — sequence stays on disk
        conversationCache.set(taskId, toHeader(skeleton));
        return skeleton;
    } catch {
        return null;
    }
}

/**
 * Generate or update the skeleton index file from current cache.
 * Called in background after skeleton loading or periodically by the refresh worker.
 */
export async function saveSkeletonIndex(
    conversationCache: Map<string, SkeletonHeader>
): Promise<void> {
    try {
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        if (storageLocations.length === 0) return;

        const skeletonsCacheDir = path.join(storageLocations[0], 'tasks', '.skeletons');
        await fs.mkdir(skeletonsCacheDir, { recursive: true });
        const indexPath = path.join(skeletonsCacheDir, SKELETON_INDEX_FILENAME);

        // Cache already contains SkeletonHeaders — serialize directly
        const entries = Array.from(conversationCache.values());

        const index: SkeletonIndex = {
            version: 1,
            generatedAt: new Date().toISOString(),
            count: entries.length,
            entries,
        };

        const content = JSON.stringify(index);
        await fs.writeFile(indexPath, content, 'utf8');
        console.log(`[Index] Saved skeleton index: ${entries.length} entries (${Math.round(content.length / 1024)}KB)`);
    } catch (error: any) {
        console.warn('[Index] Failed to save skeleton index:', error?.message || error);
    }
}

/**
 * #1072: Maximum number of tasks to scan during proactive repair.
 * On machines with thousands of tasks, scanning all of them blocks startup.
 * The remaining tasks will be handled by the periodic skeleton refresh worker.
 */
const MAX_PROACTIVE_REPAIR_TASKS = 200;

/**
 * Auto-réparation proactive des métadonnées manquantes au démarrage
 */
export async function startProactiveMetadataRepair(): Promise<void> {
    console.log('[Auto-Repair] 🔧 Démarrage du scan proactif de réparation des métadonnées...');

    try {
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            console.log('[Auto-Repair] ℹ️ Aucun emplacement de stockage trouvé. Scan terminé.');
            return;
        }

        let repairedCount = 0;
        const tasksToRepair: { taskId: string, taskPath: string }[] = [];

        // 1. Détecter toutes les tâches nécessitant une réparation
        for (const loc of locations) {
            const tasksPath = path.join(loc, 'tasks');
            try {
                const taskIds = await fs.readdir(tasksPath);

                for (const taskId of taskIds) {
                    if (taskId === '.skeletons') continue;

                    const taskPath = path.join(tasksPath, taskId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');

                    try {
                        const stats = await fs.stat(taskPath);
                        if (!stats.isDirectory()) continue;

                        const files = await fs.readdir(taskPath);
                        if (files.length === 0) continue;

                        try {
                            await fs.access(metadataPath);
                        } catch {
                            tasksToRepair.push({ taskId, taskPath });
                        }
                    } catch (error) {
                        console.debug(`[Auto-Repair] Erreur lors de l'analyse de ${taskId}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[Auto-Repair] ⚠️ Erreur lors de la lecture de ${tasksPath}:`, error);
            }
        }

        if (tasksToRepair.length === 0) {
            console.log('[Auto-Repair] ✅ Tous les squelettes sont cohérents. Scan terminé.');
            return;
        }

        // #1072 FIX: Cap the number of tasks to repair at startup
        const totalFound = tasksToRepair.length;
        if (tasksToRepair.length > MAX_PROACTIVE_REPAIR_TASKS) {
            console.log(`[Auto-Repair] ⚠️ ${totalFound} tâches trouvées, limitées à ${MAX_PROACTIVE_REPAIR_TASKS} (le reste sera traité par le worker périodique)`);
            tasksToRepair.length = MAX_PROACTIVE_REPAIR_TASKS;
        }

        console.log(`[Auto-Repair] 📋 Trouvé ${totalFound} tâches nécessitant une réparation, traitement de ${tasksToRepair.length}.`);

        // 2. Traiter la réparation en parallèle (avec une limite)
        const concurrencyLimit = 5;
        let processedCount = 0;
        let stoppedByMemoryPressure = false;
        for (let i = 0; i < tasksToRepair.length; i += concurrencyLimit) {
            const batch = tasksToRepair.slice(i, i + concurrencyLimit);
            await Promise.all(batch.map(async (task) => {
                try {
                    const skeleton = await RooStorageDetector.analyzeConversation(task.taskId, task.taskPath);
                    if (skeleton && skeleton.metadata) {
                        const metadataFilePath = path.join(task.taskPath, 'task_metadata.json');
                        await fs.writeFile(metadataFilePath, JSON.stringify(skeleton.metadata, null, 2), 'utf-8');
                        repairedCount++;
                    } else {
                        console.debug(`[Auto-Repair] ⚠️ Impossible de générer le squelette pour ${task.taskId}`);
                    }
                } catch (e) {
                     console.debug(`[Auto-Repair] ❌ Échec de réparation pour ${task.taskId}:`, e);
                }
            }));
            processedCount = i + batch.length;
            console.log(`[Auto-Repair] 📊 Lot traité, ${repairedCount}/${tasksToRepair.length} réparées jusqu'à présent...`);

            // #975 OOM FIX: Memory pressure guard — stop repair if heap exceeds 1.5 GB
            const memUsage = process.memoryUsage();
            if (memUsage.heapUsed > 1.5 * 1024 * 1024 * 1024) {
                console.warn(`[Auto-Repair] ⚠️ Memory pressure detected (${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap used). Pausing repair — ${tasksToRepair.length - processedCount} tasks remaining.`);
                stoppedByMemoryPressure = true;
                break;
            }
        }

        // #975 OOM FIX: Hint GC after heavy repair loop
        if (global.gc) {
            global.gc();
        }

        if (stoppedByMemoryPressure) {
            console.log(`[Auto-Repair] ⚠️ Scan interrompu par pression mémoire. ${repairedCount} métadonnées réparées sur ${tasksToRepair.length} prévues.`);
        } else {
            console.log(`[Auto-Repair] ✅ Scan terminé. ${repairedCount} métadonnées réparées avec succès.`);
        }

    } catch (error) {
        console.error('[Auto-Repair] ❌ Erreur critique lors du scan:', error);
    }
}

/**
 * #604: Discover and load Claude Code sessions into the conversation cache
 * Scans ~/.claude/projects/ for JSONL files and creates skeletons
 */
export async function loadClaudeCodeSessions(conversationCache: Map<string, SkeletonHeader>): Promise<void> {
    try {
        const { ClaudeStorageDetector } = await import('../utils/claude-storage-detector.js');
        const locations = await ClaudeStorageDetector.detectStorageLocations();

        if (locations.length === 0) {
            console.log('[Claude] No Claude Code project directories found');
            return;
        }

        let loaded = 0;
        for (const location of locations) {
            try {
                const taskId = `claude-${path.basename(location.projectPath)}`;

                // Skip if already in cache
                if (conversationCache.has(taskId)) continue;

                const skeleton = await ClaudeStorageDetector.analyzeConversation(
                    taskId, location.projectPath
                );
                if (skeleton && (skeleton.sequence ?? []).length > 0) {
                    // #937 FIX: Set both source and dataSource consistently for Claude sessions
                    if (!skeleton.metadata) skeleton.metadata = {} as any;
                    skeleton.metadata.source = 'claude-code'; // For filtering in Qdrant
                    skeleton.metadata.dataSource = 'claude'; // For indexTaskInQdrant() source detection
                    conversationCache.set(taskId, toHeader(skeleton));
                    loaded++;
                }
            } catch (error) {
                console.warn(`[Claude] Failed to load session from ${location.projectPath}:`, error);
            }
        }

        console.log(`[Claude] Loaded ${loaded} Claude Code sessions into cache (from ${locations.length} project dirs)`);
    } catch (error) {
        console.warn('[Claude] Claude Code session discovery failed (non-blocking):', error);
    }
}

/** #883: Interval for skeleton refresh worker (2 minutes) */
export const SKELETON_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * #883 Worker A: Periodic incremental skeleton refresh
 * Scans for tasks modified since last check and updates skeletons in cache.
 * When a skeleton is updated (lastActivity changes), queues it for Qdrant indexation.
 */
export function startSkeletonRefreshWorker(state: ServerState): void {
    if (state.skeletonRefreshInterval) {
        clearInterval(state.skeletonRefreshInterval);
    }

    state.skeletonRefreshInterval = setInterval(async () => {
        try {
            const startTime = Date.now();
            const lastCheck = state.lastSkeletonRefreshAt || 0;
            let updatedCount = 0;
            let newCount = 0;

            // --- Scan Roo tasks ---
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            for (const location of storageLocations) {
                try {
                    const tasksDir = path.join(location, 'tasks');
                    const entries = await fs.readdir(tasksDir, { withFileTypes: true });

                    for (const entry of entries) {
                        if (!entry.isDirectory() || entry.name === '.skeletons') continue;

                        try {
                            // Check if api_conversation_history.json was modified since last scan
                            const historyPath = path.join(tasksDir, entry.name, 'api_conversation_history.json');
                            const stat = await fs.stat(historyPath);
                            const mtimeMs = stat.mtime.getTime();

                            if (mtimeMs <= lastCheck) continue; // Not modified since last check

                            const existingSkeleton = state.conversationCache.get(entry.name);
                            const existingLastActivity = existingSkeleton?.metadata?.lastActivity
                                ? new Date(existingSkeleton.metadata.lastActivity).getTime()
                                : 0;

                            // Only rebuild if the file is actually newer than our cached skeleton
                            if (mtimeMs > existingLastActivity) {
                                const taskPath = path.join(tasksDir, entry.name);
                                const skeleton = await RooStorageDetector.analyzeConversation(entry.name, taskPath);
                                if (skeleton) {
                                    state.conversationCache.set(entry.name, toHeader(skeleton));
                                    // Queue for Qdrant indexation if lastActivity > lastIndexedAt
                                    const lastIndexed = skeleton.metadata?.indexingState?.lastIndexedAt;
                                    if (!lastIndexed || new Date(skeleton.metadata.lastActivity).getTime() > new Date(lastIndexed).getTime()) {
                                        state.qdrantIndexQueue.add(entry.name);
                                    }
                                    if (existingSkeleton) { updatedCount++; } else { newCount++; }
                                }
                            }
                        } catch {
                            // Skip individual task errors (file not found, etc.)
                        }
                    }
                } catch {
                    // Skip storage location errors
                }
            }

            // --- Scan Claude Code sessions ---
            try {
                const { ClaudeStorageDetector } = await import('../utils/claude-storage-detector.js');
                const claudeLocations = await ClaudeStorageDetector.detectStorageLocations();
                const seenProjects = new Set<string>();

                for (const location of claudeLocations) {
                    if (seenProjects.has(location.projectPath)) continue;
                    seenProjects.add(location.projectPath);

                    try {
                        const files = (await fs.readdir(location.projectPath)).filter(f => f.endsWith('.jsonl'));
                        for (const file of files) {
                            try {
                                const filePath = path.join(location.projectPath, file);
                                const stat = await fs.stat(filePath);
                                if (stat.mtime.getTime() <= lastCheck) continue;

                                // #937 FIX: Use project-dir--UUID format so TaskIndexer can resolve the path
                                const projectBasename = path.basename(location.projectPath);
                                const sessionUuid = file.replace('.jsonl', '');
                                const taskId = `claude-${projectBasename}--${sessionUuid}`;
                                const existingSkeleton = state.conversationCache.get(taskId);
                                const existingLastActivity = existingSkeleton?.metadata?.lastActivity
                                    ? new Date(existingSkeleton.metadata.lastActivity).getTime()
                                    : 0;

                                if (stat.mtime.getTime() > existingLastActivity) {
                                    const skeleton = await ClaudeStorageDetector.analyzeConversation(taskId, location.projectPath);
                                    if (skeleton && (skeleton.sequence ?? []).length > 0) {
                                        if (!skeleton.metadata) skeleton.metadata = {} as any;
                                        skeleton.metadata.dataSource = 'claude';
                                        state.conversationCache.set(taskId, toHeader(skeleton));
                                        const lastIndexed = skeleton.metadata?.indexingState?.lastIndexedAt;
                                        if (!lastIndexed || new Date(skeleton.metadata.lastActivity).getTime() > new Date(lastIndexed).getTime()) {
                                            state.qdrantIndexQueue.add(taskId);
                                        }
                                        if (existingSkeleton) { updatedCount++; } else { newCount++; }
                                    }
                                }
                            } catch {
                                // Skip individual file errors
                            }
                        }
                    } catch {
                        // Skip project dir errors
                    }
                }
            } catch {
                // Claude detection not critical
            }

            state.lastSkeletonRefreshAt = startTime;
            const elapsed = Date.now() - startTime;

            if (updatedCount > 0 || newCount > 0) {
                console.log(`[Skeleton-Worker] Refresh: ${newCount} new, ${updatedCount} updated, ${state.qdrantIndexQueue.size} queued for Qdrant (${elapsed}ms)`);

                // #1110: Regenerate skeleton index for fast next-startup
                saveSkeletonIndex(state.conversationCache).catch((err: any) => {
                    console.warn('[Skeleton-Worker] Index save failed (non-blocking):', err?.message || err);
                });
            }
        } catch (error) {
            console.error('[Skeleton-Worker] Error during refresh:', error);
        }
    }, SKELETON_REFRESH_INTERVAL_MS);

    // #1110: Generate initial index after first population
    // Wait 30s for background loading to complete, then save index
    setTimeout(() => {
        if (state.conversationCache.size > 0) {
            saveSkeletonIndex(state.conversationCache).catch((err: any) => {
                console.warn('[Skeleton-Worker] Initial index save failed:', err?.message || err);
            });
        }
    }, 30_000);

    console.log(`🔄 Worker A (skeleton refresh) started — interval: ${SKELETON_REFRESH_INTERVAL_MS / 1000}s`);
}

/**
 * Initialise les services background
 *
 * #1110 FIX: ZERO blocking I/O at startup.
 *  - BLOCKING PHASE: Nothing. Server is ready instantly.
 *  - ALL I/O is non-blocking: skeleton index, Claude sessions, repair, Qdrant, heartbeat.
 *  - The skeleton index is loaded lazily on first tool call that needs it
 *    (via ensureSkeletonCacheLoaded), not at startup.
 */
export async function initializeBackgroundServices(state: ServerState): Promise<void> {
    try {
        console.log('🚀 Initialisation des services background (zero blocking I/O)...');

        // ===== ALL NON-BLOCKING (fire-and-forget) =====

        // Load skeleton index in background — first tool call that needs it
        // will find it already loaded (or will trigger lazy load via ensureSkeletonCacheLoaded)
        loadSkeletonsFromDisk(state.conversationCache).then(() => {
            // Mark refresh timestamp AFTER index is loaded, so the first worker tick
            // only picks up tasks modified AFTER this point — NOT all 7620 tasks.
            // Without this, lastSkeletonRefreshAt=0 causes the worker to re-analyze everything.
            state.lastSkeletonRefreshAt = Date.now();
            // Once index is loaded, discover Claude sessions too
            return loadClaudeCodeSessions(state.conversationCache);
        }).catch((error: any) => {
            console.warn('[Startup] Background skeleton/Claude load failed (non-blocking):', error?.message || error);
        });

        // Auto-réparation proactive: fire-and-forget with timeout
        startProactiveMetadataRepair().catch((error: any) => {
            console.warn('[Auto-Repair] Background repair failed (non-blocking):', error?.message || error);
        });

        // #883 Worker A: Start periodic skeleton refresh (incremental, non-blocking)
        startSkeletonRefreshWorker(state);

        // Niveau 2: Initialisation du service d'indexation Qdrant asynchrone (Worker B)
        initializeQdrantIndexingService(state).catch((error: any) => {
            console.warn('[Qdrant] Background indexing init failed (non-blocking):', error?.message || error);
        });

        // Heartbeat service: disabled by default to prevent GDrive sync storm (#607)
        if (process.env.HEARTBEAT_AUTO_START === 'true') {
            // #1140: Dynamic import to avoid loading RooSyncService at startup
            const { RooSyncService } = await import('./RooSyncService.js');
            const rooSyncService = RooSyncService.getInstance();
            rooSyncService.startHeartbeatService(
                (machineId: string) => {
                    console.log(`[Heartbeat] Machine offline: ${machineId}`);
                },
                (machineId: string) => {
                    console.log(`[Heartbeat] Machine online: ${machineId}`);
                }
            ).then(() => {
                console.log('✅ Heartbeat service auto-started');
            }).catch((error: any) => {
                console.warn('⚠️ Heartbeat init failed (non-blocking):', error.message);
            });
        } else {
            console.log('ℹ️ Heartbeat auto-start disabled (#607). Use roosync_heartbeat tool or set HEARTBEAT_AUTO_START=true');
        }

        console.log('✅ Services background lancés');
    } catch (error: any) {
        console.error('❌ Erreur lors de l\'initialisation des services background:', error);
        throw error;
    }
}

/**
 * Initialise le service d'indexation Qdrant asynchrone
 */
async function initializeQdrantIndexingService(state: ServerState): Promise<void> {
    try {
        console.log('🔍 Initialisation du service d\'indexation Qdrant...');

        // FIX #1199: Split verification and scanning into separate phases with defensive error handling
        // Phase 1: Verify consistency (non-critical, safe to skip if Qdrant is down)
        try {
            await verifyQdrantConsistency(state);
        } catch (error: any) {
            console.warn('⚠️  Vérification cohérence Qdrant échouée (non-critique):', error?.message || error);
            // Continue anyway - this is not critical for startup
        }

        // Phase 2: Scan for outdated indices (non-critical, safe to skip if Qdrant is down)
        try {
            await scanForOutdatedQdrantIndex(state);
        } catch (error: any) {
            console.warn('⚠️  Scan Qdrant échoué (non-critique):', error?.message || error);
            // Continue anyway - this is not critical for startup
        }

        // Phase 3: Start background process (always safe - doesn't contact Qdrant immediately)
        startQdrantIndexingBackgroundProcess(state);

        console.log('✅ Service d\'indexation Qdrant initialisé (indexation en arrière-plan activée)');
    } catch (error: any) {
        console.error('⚠️  Erreur lors de l\'initialisation du service d\'indexation Qdrant (non-bloquant):', error?.message || error);
        // Even if this fails, we still want to proceed and let the background process handle it gracefully
        state.isQdrantIndexingEnabled = true; // Keep it enabled - let the background process disable if needed
        console.error('⚠️  Service d\'indexation continuera en arrière-plan avec gestion des erreurs renforcée');
    }
}

/**
 * #1072: Maximum queue size for initial Qdrant indexation scan.
 * Prevents the queue from exploding on machines with massive Qdrant inconsistencies.
 * The background worker processes the queue progressively.
 */
const MAX_INITIAL_INDEX_QUEUE = 500;

/**
 * Scanner pour identifier les squelettes ayant besoin d'une réindexation
 */
async function scanForOutdatedQdrantIndex(state: ServerState): Promise<void> {
    let indexCount = 0;
    let skipCount = 0;
    let retryCount = 0;
    let failedCount = 0;
    let migratedCount = 0;

    console.log(`🔍 Début du scan d'indexation avec mécanisme d'idempotence...`);

    for (const [taskId, skeleton] of state.conversationCache.entries()) {
        state.indexingMetrics.totalTasks++;

        // Migration automatique des anciens formats
        if (state.indexingDecisionService.migrateLegacyIndexingState(skeleton)) {
            migratedCount++;
            await saveSkeletonToDisk(skeleton);
        }

        // Décision d'indexation avec nouvelle logique
        const decision = state.indexingDecisionService.shouldIndex(skeleton);

        // Sauvegarder si une migration legacy a eu lieu durant shouldIndex
        if (decision.requiresSave) {
            await saveSkeletonToDisk(skeleton);
            migratedCount++;
        }

        if (decision.shouldIndex) {
            // #1072 FIX: Cap the initial queue size to prevent explosion
            if (state.qdrantIndexQueue.size >= MAX_INITIAL_INDEX_QUEUE) {
                skipCount++;
                continue; // Will be picked up by periodic refresh worker
            }
            state.qdrantIndexQueue.add(taskId);
            if (decision.action === 'retry') {
                retryCount++;
                state.indexingMetrics.retryTasks++;
            } else {
                indexCount++;
            }
        } else {
            skipCount++;
            state.indexingMetrics.skippedTasks++;
            console.log(`[SKIP] ${taskId}: ${decision.reason}`);

            if (skeleton.metadata?.indexingState?.indexStatus === 'failed') {
                failedCount++;
                state.indexingMetrics.failedTasks++;
            }
        }
    }

    // Rapport de scan détaillé
    console.log(`📊 Scan terminé avec mécanisme d'idempotence:`);
    console.log(`   ✅ À indexer: ${indexCount} tâches`);
    console.log(`   🔄 À retenter: ${retryCount} tâches`);
    console.log(`   ⏭️  Skippées: ${skipCount} tâches (anti-fuite)`);
    console.log(`   ❌ Échecs permanents: ${failedCount} tâches`);
    console.log(`   🔄 Migrations legacy: ${migratedCount} tâches`);

    const totalToProcess = indexCount + retryCount;
    if (totalToProcess > 1000) {
        console.log(`⚠️  Queue importante détectée: ${totalToProcess} tâches à traiter`);
        console.log(`💡 Traitement progressif avec rate limiting intelligent (200 ops/min)`);
        console.log(`⏱️  Temps estimé: ${Math.ceil(totalToProcess / 200)} minutes`);
    }

    // Estimation de la bande passante économisée
    const estimatedSavings = skipCount * 50000;
    state.indexingMetrics.bandwidthSaved += estimatedSavings;
    console.log(`💰 Bande passante économisée: ~${Math.round(estimatedSavings / 1024 / 1024)}MB grâce aux skips`);
}

/**
 * Vérifie la cohérence entre les squelettes locaux et l'index Qdrant
 * FIX #1199: Made completely non-blocking - errors don't propagate, just logged as warnings
 */
async function verifyQdrantConsistency(state: ServerState): Promise<void> {
    try {
        const now = Date.now();
        if (now - state.lastQdrantConsistencyCheck < ANTI_LEAK_CONFIG.CONSISTENCY_CHECK_INTERVAL) {
            console.log('⏳ Vérification Qdrant ignorée (dernière < 24h) - Protection anti-fuite');
            return;
        }

        console.log('🔍 Vérification de la cohérence Qdrant vs Squelettes (timeout: 10s)...');

        const taskIndexer = new TaskIndexer();
        const currentHostId = getHostIdentifier();
        console.log(`🖥️  Machine actuelle: ${currentHostId}`);

        let localIndexedCount = 0;
        for (const [taskId, skeleton] of state.conversationCache.entries()) {
            if (skeleton.metadata?.qdrantIndexedAt) {
                localIndexedCount++;
            }
        }

        // FIX #1199: Wrap countPointsByHostOs with timeout to prevent hanging
        let qdrantCount = 0;
        try {
            const countPromise = taskIndexer.countPointsByHostOs(currentHostId);
            qdrantCount = await Promise.race([
                countPromise,
                new Promise<number>((_, reject) =>
                    setTimeout(() => reject(new Error('Qdrant count timeout after 10s')), 10000)
                )
            ]);
        } catch (error: any) {
            console.warn(`⚠️  Impossible de compter les points Qdrant (timeout ou connexion échouée): ${error?.message || error}`);
            // Return gracefully - Qdrant is unreachable, but we don't want to crash the server
            return;
        }

        state.lastQdrantConsistencyCheck = now;

        console.log(`📊 Cohérence Qdrant:`);
        console.log(`   - Squelettes locaux indexés: ${localIndexedCount}`);
        console.log(`   - Points Qdrant (machine ${currentHostId}): ${qdrantCount}`);

        const discrepancy = Math.abs(localIndexedCount - qdrantCount);
        const threshold = Math.max(50, Math.floor(localIndexedCount * 0.25));

        if (discrepancy > threshold) {
            console.warn(`⚠️  Incohérence détectée: écart de ${discrepancy} entre squelettes et Qdrant`);
            console.log(`📊 Seuil de tolérance: ${threshold} (25% de ${localIndexedCount})`);
            console.log(`✨ Pas d'inquiétude: les tâches manquantes seront indexées par le scan automatique`);
        } else {
            console.log(`✅ Cohérence Qdrant-Squelettes validée (écart acceptable: ${discrepancy})`);
        }

    } catch (error: any) {
        console.warn('⚠️  Erreur lors de la vérification de cohérence Qdrant (non-bloquant):', error?.message || error);
        // Don't re-throw - we want this to be completely non-blocking
    }
}

/** Nombre de tâches traitées par cycle d'indexation (batch processing) */
export const QDRANT_INDEX_BATCH_SIZE = 5;

/**
 * Démarre le processus d'indexation Qdrant en arrière-plan
 * Traite jusqu'à QDRANT_INDEX_BATCH_SIZE tâches par intervalle (batch processing)
 */
export function startQdrantIndexingBackgroundProcess(state: ServerState): void {
    if (state.qdrantIndexInterval) {
        clearInterval(state.qdrantIndexInterval);
    }

    state.qdrantIndexInterval = setInterval(async () => {
        if (!state.isQdrantIndexingEnabled || state.qdrantIndexQueue.size === 0) {
            return;
        }

        // Traiter un batch de tâches par intervalle (au lieu d'une seule)
        const taskIds = Array.from(state.qdrantIndexQueue.values()).slice(0, QDRANT_INDEX_BATCH_SIZE);
        for (const taskId of taskIds) {
            state.qdrantIndexQueue.delete(taskId);
            await indexTaskInQdrant(taskId, state);
        }
    }, ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);

    console.log('🔄 Service d\'indexation Qdrant en arrière-plan démarré');
}

/**
 * Indexe une tâche spécifique dans Qdrant
 */
export async function indexTaskInQdrant(taskId: string, state: ServerState): Promise<void> {
    try {
        const skeleton = state.conversationCache.get(taskId);
        if (!skeleton) {
            console.warn(`[WARN] Skeleton for task ${taskId} not found in cache. Skipping indexing.`);
            return;
        }

        const decision = state.indexingDecisionService.shouldIndex(skeleton);

        if (decision.requiresSave) {
            await saveSkeletonToDisk(skeleton);
            console.log(`[MIGRATION] Task ${taskId}: Migration legacy sauvegardée`);
        }

        if (!decision.shouldIndex) {
            console.log(`[SKIP] Task ${taskId}: ${decision.reason} - Protection anti-fuite`);
            return;
        }

        console.log(`[INDEX] Task ${taskId}: ${decision.reason}`);

        // #604: Determine source from skeleton metadata
        const source: 'roo' | 'claude-code' = skeleton.metadata?.dataSource === 'claude' ? 'claude-code' : 'roo';
        const taskIndexer = new TaskIndexer();
        await taskIndexer.indexTask(taskId, source);

        state.indexingDecisionService.markIndexingSuccess(skeleton);
        await saveSkeletonToDisk(skeleton);

        state.qdrantIndexCache.set(taskId, Date.now());
        state.indexingMetrics.indexedTasks++;

        console.log(`[SUCCESS] Task ${taskId} successfully indexed in Qdrant.`);

        // Archive cross-machine sur GDrive (non-bloquant)
        try {
            const { TaskArchiver } = await import('./task-archiver/index.js');
            const conversation = await RooStorageDetector.findConversationById(taskId);
            if (conversation?.path && skeleton) {
                await TaskArchiver.archiveTask(taskId, conversation.path, skeleton as any);
            }
        } catch (archiveError) {
            console.warn(`[ARCHIVE] Non-blocking archive failed for ${taskId}:`, archiveError);
        }

    } catch (error: any) {
        if (error.message && error.message.includes('not found in any storage location')) {
            console.warn(`[WARN] Task ${taskId} is in cache but not on disk. Skipping indexing.`);
        } else {
            const skeleton = state.conversationCache.get(taskId);
            if (skeleton) {
                const isPermanentError = classifyIndexingError(error);
                state.indexingDecisionService.markIndexingFailure(skeleton, error.message, isPermanentError);
                await saveSkeletonToDisk(skeleton);

                state.indexingMetrics.failedTasks++;

                if (isPermanentError) {
                    console.error(`[PERMANENT_FAIL] Task ${taskId}: ${error.message} - Marqué pour skip définitif`);
                } else {
                    console.error(`[RETRY_FAIL] Task ${taskId}: ${error.message} - Programmé pour retry avec backoff`);
                }
            }

            console.error(`[ERROR] Failed to index task ${taskId} in Qdrant:`, error);
        }
    }
}

/**
 * Classifie les erreurs d'indexation
 */
export function classifyIndexingError(error: any): boolean {
    const errorMessage = error.message ? error.message.toLowerCase() : '';

    const permanentErrors = [
        'file not found',
        'access denied',
        'permission denied',
        'invalid format',
        'corrupted data',
        'authentication failed',
        'quota exceeded permanently'
    ];

    const temporaryErrors = [
        'network error',
        'connection timeout',
        'rate limit',
        'service unavailable',
        'timeout',
        'econnreset',
        'enotfound'
    ];

    if (permanentErrors.some(perm => errorMessage.includes(perm))) {
        return true;
    }

    if (temporaryErrors.some(temp => errorMessage.includes(temp))) {
        return false;
    }

    return false;
}

/**
 * Sauvegarde un squelette sur le disque.
 * Accepts SkeletonHeader (from cache) — merges updated metadata into the
 * existing on-disk full skeleton so the sequence is preserved.
 * Also accepts ConversationSkeleton (full) which is written directly.
 */
export async function saveSkeletonToDisk(skeleton: SkeletonHeader): Promise<void> {
    try {
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        if (storageLocations.length === 0) {
            throw new RooStorageDetectorError(
                'Aucun emplacement de stockage Roo trouvé',
                RooStorageDetectorErrorCode.NO_STORAGE_FOUND,
                { function: 'saveSkeletonToDisk', skeletonTaskId: skeleton.taskId }
            );
        }

        // ✅ FIX CRITIQUE: Utiliser tasks/.skeletons comme build-skeleton-cache.tool.ts
        const tasksDir = path.join(storageLocations[0], 'tasks');
        const skeletonsCacheDir = path.join(tasksDir, '.skeletons');
        await fs.mkdir(skeletonsCacheDir, { recursive: true });

        const filePath = path.join(skeletonsCacheDir, `${skeleton.taskId}.json`);

        // If the input already has a sequence (ConversationSkeleton), write directly.
        // Otherwise merge header metadata into existing on-disk skeleton to preserve sequence.
        let toWrite: any = skeleton;
        if (!('sequence' in skeleton)) {
            try {
                let existing = await fs.readFile(filePath, 'utf8');
                if (existing.charCodeAt(0) === 0xFEFF) existing = existing.slice(1);
                const parsed = JSON.parse(existing);
                if (parsed && Array.isArray(parsed.sequence)) {
                    // Merge: keep on-disk sequence, update header fields
                    toWrite = { ...parsed, ...skeleton, sequence: parsed.sequence };
                }
            } catch {
                // #1325: No existing file — don't write header-only data to disk.
                // Header-only files corrupt the skeleton cache because loadFullSkeleton
                // returns them as valid skeletons without sequence, causing 0 exchanges
                // in trace summarize.
                return;
            }
        }

        await fs.writeFile(filePath, JSON.stringify(toWrite, null, 2), 'utf8');

        // Skeleton saved successfully
    } catch (error: any) {
        console.error(`Erreur lors de la sauvegarde du squelette ${skeleton.taskId}:`, error);
    }
}