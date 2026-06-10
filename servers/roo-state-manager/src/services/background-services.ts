/**
 * Services de background pour l'architecture à 2 niveaux
 * Niveau 1: Reconstruction temps réel des squelettes
 * Niveau 2: Indexation Qdrant asynchrone non-bloquante
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import lockfile from 'proper-lockfile';
import { ConversationSkeleton, SkeletonHeader } from '../types/conversation.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ServerState } from './state-manager.service.js';
import { ANTI_LEAK_CONFIG } from '../config/server-config.js';
import { TaskIndexer, getHostIdentifier } from './task-indexer.js';
import { getCircuitBreakerState, isCircuitBreakerBlocking, getEmbeddingMetrics } from './task-indexer/VectorIndexer.js';
import { REBUILD_BACKOFF_MIN_MS_DEFAULT, REBUILD_BACKOFF_MAX_MS_DEFAULT } from '../types/indexing.js';
import { SkeletonCacheService } from './skeleton-cache.service.js';
import { shouldIndexTask } from './task-partition.js';
// REMOVED: import * as toolExports — was unused, added 6s to startup by importing ALL tools
import { RooStorageDetectorError, RooStorageDetectorErrorCode, GenericErrorCode } from '../types/errors.js';
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
 * #1984: Uses proper-lockfile + atomic rename to prevent race conditions
 * between 12+ concurrent MCP instances.
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

        // #1984: Acquire file lock before writing to prevent concurrent writes
        let release: (() => Promise<void>) | undefined;
        try {
            // Ensure file exists for lockfile (it needs a real file to lock)
            try { await fs.access(indexPath); } catch { await fs.writeFile(indexPath, '{}', 'utf8'); }
            release = await lockfile.lock(indexPath, { retries: 3, stale: 15000 });
        } catch (lockError: any) {
            // Lock acquisition failed — proceed without lock rather than blocking
            console.warn(`[#1984] Lock acquisition failed for skeleton index: ${lockError?.message || lockError}`);
        }

        try {
            // #1984: Atomic write via temp file + rename
            const tmpPath = path.join(skeletonsCacheDir, `${SKELETON_INDEX_FILENAME}.tmp-${process.pid}`);
            await fs.writeFile(tmpPath, content, 'utf8');
            await fs.rename(tmpPath, indexPath);
            console.log(`[Index] Saved skeleton index (atomic): ${entries.length} entries (${Math.round(content.length / 1024)}KB)`);
        } finally {
            if (release) {
                try { await release(); } catch { /* ignore unlock errors */ }
            }
        }
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
        let projectDirs = 0;
        // P3 fix: per-session taskIds (`claude-{project}--{sessionUuid}`) match the
        // skeleton refresh worker (background-services.ts line ~512) and TaskIndexer
        // path resolution (#937). The previous per-project format (`claude-{project}`)
        // produced orphan skeletons never resolved by the indexer.
        for (const location of locations) {
            projectDirs++;
            try {
                const files = (await fs.readdir(location.projectPath)).filter(f => f.endsWith('.jsonl'));
                if (files.length === 0) continue;
                const projectBasename = path.basename(location.projectPath);

                for (const file of files) {
                    const sessionUuid = file.replace(/\.jsonl$/, '');
                    const taskId = `claude-${projectBasename}--${sessionUuid}`;

                    if (conversationCache.has(taskId)) continue;

                    try {
                        const skeleton = await ClaudeStorageDetector.analyzeConversation(
                            taskId, location.projectPath
                        );
                        if (skeleton && (skeleton.sequence ?? []).length > 0) {
                            if (!skeleton.metadata) skeleton.metadata = {} as any;
                            skeleton.metadata.source = 'claude-code'; // Qdrant filtering
                            skeleton.metadata.dataSource = 'claude';  // indexTaskInQdrant() source detection
                            conversationCache.set(taskId, toHeader(skeleton));
                            loaded++;
                        }
                    } catch (error) {
                        console.warn(`[Claude] Failed to load session ${taskId}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[Claude] Failed to read project dir ${location.projectPath}:`, error);
            }
        }

        console.log(`[Claude] Loaded ${loaded} Claude Code sessions into cache (from ${projectDirs} project dirs)`);
    } catch (error) {
        console.warn('[Claude] Claude Code session discovery failed (non-blocking):', error);
    }
}

/**
 * #1953: Clean up stale .tmp and .lock orphan files in shared-state directories.
 * ADR 008 made HeartbeatService entirely in-memory — the heartbeats/ directory
 * still contains .tmp files from the pre-ADR 008 disk-based system.
 * Also cleans stale .lock files from interrupted FileLockManager operations.
 */
async function cleanupStaleTempFiles(): Promise<void> {
    const sharedPath = process.env.ROOSYNC_SHARED_PATH;
    if (!sharedPath) return;

    const dirsToClean = ['heartbeats', 'presence', 'dashboards'];
    let totalRemoved = 0;

    for (const dir of dirsToClean) {
        const dirPath = path.join(sharedPath, dir);
        try {
            const entries = await fs.readdir(dirPath);
            for (const entry of entries) {
                if (entry.endsWith('.tmp') || entry.endsWith('.lock') || /^\.tmp-/.test(entry)) {
                    try {
                        await fs.unlink(path.join(dirPath, entry));
                        totalRemoved++;
                    } catch { /* already gone — ignore */ }
                }
            }
        } catch { /* directory missing or inaccessible — skip */ }
    }

    if (totalRemoved > 0) {
        console.log(`[#1953] Cleaned ${totalRemoved} stale .tmp/.lock files from shared state`);
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
            // #596: ROO_INDEX_FORCE forces a full rescan (bypass mtime incremental filter)
            // so previously unseen files (e.g., old Claude Code sessions) get discovered.
            const forceRescan = process.env.ROO_INDEX_FORCE === '1' || process.env.ROO_INDEX_FORCE === 'true';
            const lastCheck = forceRescan ? 0 : (state.lastSkeletonRefreshAt || 0);
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
                                    const newHeader = toHeader(skeleton);
                                    // #1984: Preserve existing indexingState when refreshing
                                    // analyzeConversation may not carry indexingState from .skeleton files
                                    if (existingSkeleton?.metadata?.indexingState && !newHeader.metadata?.indexingState) {
                                        if (!newHeader.metadata) newHeader.metadata = {} as any;
                                        newHeader.metadata.indexingState = existingSkeleton.metadata.indexingState;
                                    }
                                    state.conversationCache.set(entry.name, newHeader);
                                    // Queue for Qdrant indexation if lastActivity > lastIndexedAt
                                    // #2227: Use newHeader (not skeleton) — skeleton doesn't carry indexingState
                                    const lastIndexed = newHeader.metadata?.indexingState?.lastIndexedAt;
                                    const indexStatus = newHeader.metadata?.indexingState?.indexStatus;
                                    // P2 fix: in FORCE mode, skip tasks already indexed success whose
                                    // file hasn't changed since lastIndexedAt — otherwise this worker
                                    // re-queues identical tasks every 2 min, producing the
                                    // EMB-METRICS called=0 enqueue/dequeue cycle (preflight dedup
                                    // skips them all, markIndexingSuccess refreshes the timestamp,
                                    // next cycle re-queues again).
                                    const alreadyIndexedInForceMode = forceRescan
                                        && indexStatus === 'success'
                                        && lastIndexed
                                        && mtimeMs <= new Date(lastIndexed).getTime();
                                    if (!alreadyIndexedInForceMode
                                        && (!lastIndexed || new Date(newHeader.metadata.lastActivity).getTime() > new Date(lastIndexed).getTime())
                                        && shouldIndexTask(entry.name, state.machineId, state.fleetRoster)) {
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
                                        const newHeader = toHeader(skeleton);
                                        // #1984: Preserve existing indexingState when refreshing
                                        if (existingSkeleton?.metadata?.indexingState && !newHeader.metadata?.indexingState) {
                                            if (!newHeader.metadata) newHeader.metadata = {} as any;
                                            newHeader.metadata.indexingState = existingSkeleton.metadata.indexingState;
                                        }
                                        state.conversationCache.set(taskId, newHeader);
                                        // #2227: Use newHeader (not skeleton) — skeleton doesn't carry indexingState
                                        const lastIndexed = newHeader.metadata?.indexingState?.lastIndexedAt;
                                        const indexStatus = newHeader.metadata?.indexingState?.indexStatus;
                                        // P2 fix: same FORCE-mode guard as Roo branch (see comment above)
                                        const alreadyIndexedInForceMode = forceRescan
                                            && indexStatus === 'success'
                                            && lastIndexed
                                            && stat.mtime.getTime() <= new Date(lastIndexed).getTime();
                                        if (!alreadyIndexedInForceMode
                                            && (!lastIndexed || new Date(newHeader.metadata.lastActivity).getTime() > new Date(lastIndexed).getTime())
                                            && shouldIndexTask(taskId, state.machineId, state.fleetRoster)) {
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

        // #1747 — Activate skeleton-cache Tier 2 (Claude local) and Tier 3 (GDrive archives).
        // Default ON; rollback via SKELETON_CLAUDE_TIER=false / SKELETON_ARCHIVE_TIER=false in .env.
        const enableClaudeTier = process.env.SKELETON_CLAUDE_TIER !== 'false';
        const enableArchiveTier = process.env.SKELETON_ARCHIVE_TIER !== 'false';
        SkeletonCacheService.configure({ enableClaudeTier, enableArchiveTier });
        console.log(`🗂️  Skeleton cache tiers: Tier1=ON Tier2=${enableClaudeTier ? 'ON' : 'OFF'} Tier3=${enableArchiveTier ? 'ON' : 'OFF'}`);

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
        }).then(async () => {
            // #1747 sub-issue B: Log tier summary after all background loading completes
            const instance = SkeletonCacheService.getInstance();
            const stats = await instance.getCacheTierStats();
            console.log(
                `✅ Skeleton cache loaded: Tier1(Roo)=${stats.tier1_roo} ` +
                `Tier2(Claude)=${stats.config.enableClaudeTier ? stats.tier2_claude : 'OFF'} ` +
                `Tier3(Archives)=${stats.config.enableArchiveTier ? stats.tier3_archives : 'OFF'} ` +
                `— Total: ${stats.total}`
            );

            // #2165 ARCHITECTURE NOTE:
            // Both loadSkeletonsFromDisk and initializeQdrantIndexingService are fire-and-forget
            // at startup (see lines ~598 and ~640). If scanForOutdatedQdrantIndex runs before
            // the skeleton cache populates, totalTasks stays at 0 and indexing stalls forever.
            // This conditional re-scan only fires when the initial scan missed the cache,
            // avoiding unnecessary double-scans on every startup.
            if (state.conversationCache.size > 0 && state.isQdrantIndexingEnabled
                && state.indexingMetrics.totalTasks === 0) {
                try {
                    await scanForOutdatedQdrantIndex(state);
                    console.log(`[Post-Load] Re-scanned ${state.indexingMetrics.totalTasks} skeletons for Qdrant indexing (initial scan missed cache)`);
                } catch (error: any) {
                    console.error('[Post-Load] Re-scan failed, indexing may be incomplete:', error?.message || error);
                }
            }
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

        // Heartbeat: ADR 008 passive model — no auto-start needed.
        // Every MCP tool call IS the heartbeat. Status derived from timestamps.

        // #1953: Clean up stale .tmp/.lock orphan files from pre-ADR 008 heartbeat system
        cleanupStaleTempFiles().catch(() => { /* non-blocking */ });

        console.log('✅ Services background lancés');
    } catch (error: any) {
        console.error('❌ Erreur lors de l\'initialisation des services background:', error);
        throw error;
    }
}

/**
 * #1987 Phase 3a: Load noise filter blacklist from shared state.
 * File: $ROOSYNC_SHARED_STATE_PATH/qdrant-blacklist.json
 * Format: { "version": 1, "blacklistedTaskIds": ["id1", "id2", ...] }
 * Non-blocking: if file missing or malformed, proceeds with empty blacklist.
 */
async function loadNoiseFilterBlacklist(state: ServerState): Promise<void> {
    try {
        const sharedPath = process.env.ROOSYNC_SHARED_PATH;
        if (!sharedPath) {
            console.log('[NoiseFilter] No ROOSYNC_SHARED_PATH, blacklist disabled');
            return;
        }

        const blacklistPath = path.join(sharedPath, 'qdrant-blacklist.json'); // sharedPath already points to .shared-state
        const content = await fs.readFile(blacklistPath, 'utf8');

        const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
        const data = JSON.parse(cleaned);

        if (data.blacklistedTaskIds && Array.isArray(data.blacklistedTaskIds)) {
            state.indexingDecisionService.noiseFilter.loadBlacklist(data.blacklistedTaskIds);
            console.log(`[NoiseFilter] Loaded ${data.blacklistedTaskIds.length} blacklisted task IDs`);
        }
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            console.log('[NoiseFilter] No blacklist file found, proceeding without blacklist');
        } else {
            console.warn(`[NoiseFilter] Failed to load blacklist: ${error?.message || error}`);
        }
    }
}

/**
 * Initialise le service d'indexation Qdrant asynchrone
 */
async function initializeQdrantIndexingService(state: ServerState): Promise<void> {
    try {
        console.log('🔍 Initialisation du service d\'indexation Qdrant...');

        // #1987 Phase 3a: Load blacklist from shared state
        await loadNoiseFilterBlacklist(state);

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
        // #2352: Attempt leader-election at startup
        state.isIndexLeader = await tryAcquireLeaderLock();
        if (state.isIndexLeader) {
            console.log(`🔑 [Leader-Election] PID ${process.pid} is indexing leader at startup`);
        } else {
            console.log(`🔄 [Leader-Election] PID ${process.pid} is follower — will attempt takeover if leader goes stale`);
        }
        // #2352: Log task-space partition status
        if (state.fleetRoster && state.fleetRoster.length > 0) {
            console.log(`🎯 [Partition] Task-space partition enabled: ${state.fleetRoster.length} machines, this=${state.machineId}, shard=~${Math.round(100 / state.fleetRoster.length)}% of tasks`);
        } else {
            console.log(`🎯 [Partition] Task-space partition disabled (no ROO_FLEET_ROSTER) — all machines index all tasks`);
        }
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

        // #2352: Task-space partition — skip tasks owned by other machines
        if (!shouldIndexTask(taskId, state.machineId, state.fleetRoster)) {
            skipCount++;
            state.indexingMetrics.skippedTasks++;
            continue;
        }

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
        const opsPerMin = parseInt(process.env.EMBEDDING_OPS_PER_MINUTE || '30', 10);
        console.log(`💡 Traitement progressif avec rate limiting intelligent (${opsPerMin} ops/min)`);
        console.log(`⏱️  Temps estimé: ${Math.ceil(totalToProcess / opsPerMin)} minutes`);
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
 * #2352: Leader-election for Qdrant indexing.
 * Only one MCP instance per machine runs embeddings at a time.
 * Lock is a file in the skeletons directory containing { pid, timestamp }.
 * Stale after LEADER_LOCK_STALE_MS — allows takeover if leader process crashes.
 */
const LEADER_LOCK_FILENAME = '.indexer-leader.lock';
const LEADER_LOCK_STALE_MS = 15 * 60 * 1000; // 15 min (3× the 5-min indexing interval)

async function getLeaderLockPath(): Promise<string | null> {
    const locations = await RooStorageDetector.detectStorageLocations();
    if (locations.length === 0) return null;
    return path.join(locations[0], 'tasks', '.skeletons', LEADER_LOCK_FILENAME);
}

/**
 * Try to acquire or renew the leader lock. Non-blocking (single attempt).
 * Returns true if this process is the leader.
 */
async function tryAcquireLeaderLock(): Promise<boolean> {
    const lockPath = await getLeaderLockPath();
    if (!lockPath) return true; // No storage → single-instance, assume leader

    const lockData = { pid: process.pid, timestamp: Date.now() };

    try {
        // Try to create the lock file exclusively
        await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' });
        return true; // Created → we are the leader
    } catch (error: any) {
        if (error.code !== 'EEXIST') {
            // Unexpected error (permissions, disk full) — assume leader to avoid blocking indexing
            console.warn(`⚠️ [Leader-Election] Unexpected error acquiring lock: ${error.message}. Assuming leader.`);
            return true;
        }

        // Lock exists — check if it's ours or stale
        try {
            const content = await fs.readFile(lockPath, 'utf-8');
            const existing = JSON.parse(content);

            // If it's our PID, renew the timestamp
            if (existing.pid === process.pid) {
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                return true;
            }

            // Check staleness
            const age = Date.now() - existing.timestamp;
            if (age > LEADER_LOCK_STALE_MS) {
                // Stale — steal the lock
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                console.log(`🔑 [Leader-Election] Stolen stale lock (previous PID ${existing.pid}, age ${Math.round(age / 1000)}s). PID ${process.pid} is now leader.`);
                return true;
            }

            // Active lock held by another process
            return false;
        } catch {
            // Corrupt/unreadable lock — overwrite
            await fs.writeFile(lockPath, JSON.stringify(lockData));
            return true;
        }
    }
}

/**
 * Démarre le processus d'indexation Qdrant en arrière-plan
 * Traite jusqu'à QDRANT_INDEX_BATCH_SIZE tâches par intervalle (batch processing)
 */
export function startQdrantIndexingBackgroundProcess(state: ServerState): void {
    if (state.qdrantIndexInterval) {
        clearInterval(state.qdrantIndexInterval);
    }

    state.qdrantIndexInterval = setInterval(async () => {
        // #2195: Emit per-cycle embedding metrics snapshot at every interval (including
        // empty/blocked cycles) so observability stays live even when no indexing happens.
        // Counts are cumulative since MCP boot; rates are derived by subtracting two snapshots.
        const m = getEmbeddingMetrics();
        console.log(
            `[EMB-METRICS] called=${m.embeddings_called_total} ` +
            `cached=${m.embeddings_cached_hit_total} ` +
            `preflight_skipped=${m.embeddings_preflight_skipped_total} ` +
            `post_skipped=${m.embeddings_post_dedup_skipped_total} ` +
            `breaker_blocked=${m.embeddings_circuit_breaker_blocked_total} ` +
            `preflight_fail=${m.preflight_batches_qdrant_unreachable_total}`
        );

        if (!state.isQdrantIndexingEnabled || state.qdrantIndexQueue.size === 0) {
            return;
        }

        // #2352: Leader-election — only the leader does indexing
        if (!state.isIndexLeader) {
            // Try to become leader (non-blocking)
            const won = await tryAcquireLeaderLock();
            if (won) {
                state.isIndexLeader = true;
                console.log(`🔑 [Leader-Election] PID ${process.pid} became indexing leader`);
            } else {
                return; // Another instance is leader — skip indexing
            }
        } else {
            // Already leader — renew lock
            const renewed = await tryAcquireLeaderLock();
            if (!renewed) {
                state.isIndexLeader = false;
                console.warn(`⚠️ [Leader-Election] PID ${process.pid} lost leadership (lock stolen). Stepping down.`);
                return;
            }
        }

        // #2165: Global back-off. If the Qdrant circuit breaker is OPEN, every
        // indexTask() call would extract chunks and (before this fix) compute
        // embeddings only to have the upsert rejected — hammering the embedding
        // server. With the breaker open, skip the ENTIRE cycle: leave the queue
        // intact so tasks are retried once Qdrant recovers, and burn zero GPU.
        if (isCircuitBreakerBlocking()) {
            const snap = getCircuitBreakerState();
            console.warn(
                `🚫 [Qdrant-Worker] Circuit breaker OPEN — skipping indexing cycle ` +
                `(${state.qdrantIndexQueue.size} tasks queued, retry in ~${Math.round(snap.msUntilHalfOpen / 1000)}s). ` +
                `No embeddings computed this cycle.`
            );
            return;
        }

        // Traiter un batch de tâches par intervalle (au lieu d'une seule)
        const taskIds = Array.from(state.qdrantIndexQueue.values()).slice(0, QDRANT_INDEX_BATCH_SIZE);
        for (const taskId of taskIds) {
            state.qdrantIndexQueue.delete(taskId);
            await indexTaskInQdrant(taskId, state);

            // #2165: If a task tripped the breaker, stop the rest of this batch
            // immediately — the remaining tasks would all hit the open breaker
            // and (re-)extract chunks for nothing. They stay queued for next cycle.
            if (isCircuitBreakerBlocking()) {
                console.warn(`🚫 [Qdrant-Worker] Circuit breaker opened mid-batch — aborting remaining ${taskIds.length - taskIds.indexOf(taskId) - 1} task(s) this cycle.`);
                break;
            }
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

        // Rebuild backoff — when a task is reindexed because of an index-version
        // migration, sleep a random jitter to spread fleet-wide load on the shared
        // embedding API. Live/new tasks (action='index'|'retry') process immediately.
        if (decision.action === 'rebuild') {
            const minMs = Number.parseInt(process.env.ROO_INDEX_REBUILD_BACKOFF_MIN_MS ?? '', 10) || REBUILD_BACKOFF_MIN_MS_DEFAULT;
            const maxMs = Number.parseInt(process.env.ROO_INDEX_REBUILD_BACKOFF_MAX_MS ?? '', 10) || REBUILD_BACKOFF_MAX_MS_DEFAULT;
            const lo = Math.min(minMs, maxMs);
            const hi = Math.max(minMs, maxMs);
            const jitter = lo + Math.floor(Math.random() * (hi - lo + 1));
            console.log(`[REBUILD] Task ${taskId}: backoff ${jitter}ms before reindex (${decision.reason})`);
            await new Promise(resolve => setTimeout(resolve, jitter));
        }

        console.log(`[INDEX] Task ${taskId}: ${decision.reason}`);

        // #604: Determine source from skeleton metadata
        const source: 'roo' | 'claude-code' = skeleton.metadata?.dataSource === 'claude' ? 'claude-code' : 'roo';

        // #1985: Claude Code sessions are sanctuary — skip automatic background indexing.
        // Manual indexing via roosync_indexing(action: "index") is still allowed.
        // Root cause: Claude Code sessions get new UUIDs on resume/compact, causing
        // 3-4x duplicate vectors (49% of Qdrant storage = duplicates).
        // #937 mitigation: Per-session taskIds + UUIDv5 deterministic chunk_ids resolve the
        // duplicate risk. Set ROO_INDEX_CLAUDE_SESSIONS=true to lift sanctuary per-machine.
        const allowClaudeIndexing = process.env.ROO_INDEX_CLAUDE_SESSIONS === 'true';
        if (source === 'claude-code' && !allowClaudeIndexing) {
            console.log(`[SKIP] Task ${taskId}: Claude Code session — automatic indexing blocked (#1985 sanctuary protection). Set ROO_INDEX_CLAUDE_SESSIONS=true to enable.`);
            return;
        }

        const taskIndexer = new TaskIndexer();
        const TASK_TIMEOUT_MS = parseInt(process.env.INDEX_TASK_TIMEOUT_MS || '300', 10) * 1000;
        await Promise.race([
            taskIndexer.indexTask(taskId, source),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(
                    `Indexing timeout for ${taskId} after ${TASK_TIMEOUT_MS}ms — session too large or embedding backlog`
                )), TASK_TIMEOUT_MS).unref()
            ),
        ]);

        state.indexingDecisionService.markIndexingSuccess(skeleton);
        await saveSkeletonToDisk(skeleton);

        state.qdrantIndexCache.set(taskId, Date.now());
        state.indexingMetrics.indexedTasks++;
        state.indexingMetrics.lastIndexedAt = new Date().toISOString();

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
        } else if (error?.code === GenericErrorCode.CIRCUIT_BREAKER_OPEN) {
            // #2165: The circuit breaker was OPEN (or Qdrant was unreachable during
            // pre-flight dedup) — indexTask() bailed out BEFORE computing any
            // embeddings. This is a transient infra condition, NOT a task-level
            // failure. Do NOT call markIndexingFailure(): that would burn the task's
            // retry budget and could mark it permanently 'failed' after 3 cycles of
            // Qdrant being slow, even though the task content is perfectly fine.
            // Just re-queue it for the next cycle (which itself back-offs while the
            // breaker is open) — no skeleton write, no retry-counter mutation.
            state.qdrantIndexQueue.add(taskId);
            console.warn(`[DEFERRED] Task ${taskId}: ${error.message} — re-queued, retry counter untouched.`);
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
        'not found',              // #1401: "Claude Code session XXX not found" (archived/deleted)
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