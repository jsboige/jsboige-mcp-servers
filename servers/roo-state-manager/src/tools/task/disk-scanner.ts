/**
 * Disk Scanner for New Conversations
 * 
 * Scans the filesystem to detect conversations that don't have
 * skeleton cache entries yet. This ensures newly created conversations
 * are immediately visible to the system.
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import os from 'os';
import { ConversationSkeleton, SkeletonHeader } from '../../types/conversation.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { detectSourceFromPath } from '../../utils/extension-paths.js';

/**
 * Read task_metadata.json for a task (small file, ~200 bytes).
 * Returns parsed object or empty object if unavailable.
 */
async function readTaskMetadata(taskPath: string): Promise<Record<string, any>> {
    try {
        const metaPath = path.join(taskPath, 'task_metadata.json');
        const content = await fs.readFile(metaPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

/**
 * Quick analysis of a conversation file to create a minimal skeleton
 * without full processing overhead.
 * Reads both ui_messages.json (for title/timestamps) and task_metadata.json
 * (for workspace, totalSize, accurate counts).
 */
async function quickAnalyze(
    taskId: string,
    taskPath: string
): Promise<ConversationSkeleton> {
    // Read task_metadata.json for workspace, totalSize, accurate counts
    const taskMeta = await readTaskMetadata(taskPath);

    // #2429: Detect source from storage path (zoo-code vs roo)
    const source = detectSourceFromPath(taskPath);

    const uiPath = path.join(taskPath, 'ui_messages.json');

    try {
        const content = await fs.readFile(uiPath, 'utf-8');
        const messages = JSON.parse(content);

        // Extract basic metadata
        const firstMessage = messages[0] || {};
        const lastMessage = messages[messages.length - 1] || {};

        return {
            taskId,
            metadata: {
                title: firstMessage.text?.substring(0, 100) || 'Untitled Task',
                createdAt: taskMeta.createdAt || new Date(firstMessage.ts || Date.now()).toISOString(),
                lastActivity: taskMeta.lastActivity || new Date(lastMessage.ts || firstMessage.ts || Date.now()).toISOString(),
                mode: 'unknown',
                messageCount: taskMeta.messageCount || messages.length,
                actionCount: taskMeta.actionCount || 0,
                totalSize: taskMeta.totalSize || 0,
                workspace: taskMeta.workspace || '',
                machineId: os.hostname(),
                source,
            },
            parentTaskId: undefined,
            sequence: []
        };
    } catch (error) {
        // Fallback if ui_messages.json can't be read
        return {
            taskId,
            metadata: {
                title: 'Unknown Task',
                createdAt: taskMeta.createdAt || new Date().toISOString(),
                lastActivity: taskMeta.lastActivity || new Date().toISOString(),
                mode: 'unknown',
                messageCount: taskMeta.messageCount || 0,
                actionCount: taskMeta.actionCount || 0,
                totalSize: taskMeta.totalSize || 0,
                workspace: taskMeta.workspace || '',
                machineId: os.hostname(),
                source,
            },
            parentTaskId: undefined,
            sequence: []
        };
    }
}

// --- Incremental disk scan cache ---
// Only re-scans when the tasks/ directory has actually changed (mtime check).
// Falls back to TTL-based invalidation as safety net.
const DISK_SCAN_CACHE_TTL = 300_000; // 5 minutes (was 30s, #834 perf fix)
let lastScanTime = 0;
let lastScanResults: ConversationSkeleton[] | null = null;
let lastTasksDirMtime = 0; // mtime of the tasks/ directory at last scan

/**
 * Invalidate the disk scan cache. Useful for testing or after known filesystem changes.
 */
export function invalidateDiskScanCache(): void {
    lastScanTime = 0;
    lastScanResults = null;
    lastTasksDirMtime = 0;
}

/**
 * Scans the tasks directory for conversations that aren't in the cache yet.
 * Uses a 30s TTL cache to avoid re-scanning 7000+ directories on every call.
 *
 * @param existingCache - Current skeleton cache to check against
 * @param workspace - Optional workspace filter
 * @returns Array of newly discovered conversation skeletons
 */
export async function scanDiskForNewTasks(
    existingCache: Map<string, SkeletonHeader>,
    workspace?: string
): Promise<ConversationSkeleton[]> {
    const now = Date.now();

    // If we have cached scan results and TTL hasn't expired,
    // return only entries from the cache that aren't already in existingCache
    if (lastScanResults !== null && (now - lastScanTime) < DISK_SCAN_CACHE_TTL) {
        const newFromCache = lastScanResults.filter(skeleton => !existingCache.has(skeleton.taskId));
        if (workspace) {
            return newFromCache.filter(s =>
                !workspace || s.metadata.workspace === workspace || !s.metadata.workspace
            );
        }
        return newFromCache;
    }

    const storagePaths = await RooStorageDetector.detectStorageLocations();
    if (storagePaths.length === 0) {
        return [];
    }

    const tasksDir = path.join(storagePaths[0], 'tasks');

    try {
        if (!existsSync(tasksDir)) {
            return [];
        }

        // Incremental check: only re-scan if the tasks/ directory has changed.
        // When a new subdirectory is created, the parent directory mtime updates.
        // This avoids iterating 7000+ entries when nothing changed.
        const dirStat = await fs.stat(tasksDir);
        const currentMtime = dirStat.mtimeMs;

        if (lastScanResults !== null && currentMtime === lastTasksDirMtime) {
            // Directory unchanged — return cached results filtered against existingCache
            lastScanTime = now; // refresh TTL
            const newFromCache = lastScanResults.filter(skeleton => !existingCache.has(skeleton.taskId));
            if (workspace) {
                return newFromCache.filter(s =>
                    !workspace || s.metadata.workspace === workspace || !s.metadata.workspace
                );
            }
            return newFromCache;
        }

        // Directory changed or first scan — do full readdir
        const taskDirs = await fs.readdir(tasksDir);

        // Parallelize quickAnalyze for uncached tasks (perf: #673)
        // existsSync replaced with async fs.access to avoid blocking the Node event loop
        const uncachedIds = taskDirs.filter(id => !existingCache.has(id));
        const analyzeTask = async (taskId: string): Promise<ConversationSkeleton | null> => {
            const taskPath = path.join(tasksDir, taskId);
            const uiPath = path.join(taskPath, 'ui_messages.json');
            try {
                await fs.access(uiPath);
            } catch {
                return null; // not a valid conversation directory
            }
            const skeleton = await quickAnalyze(taskId, taskPath);
            if (workspace && skeleton.metadata.workspace !== workspace && skeleton.metadata.workspace) {
                return null; // filtered by workspace
            }
            return skeleton;
        };

        const results = await Promise.all(uncachedIds.map(analyzeTask));
        const newTasks = results.filter((s): s is ConversationSkeleton => s !== null);

        // Update cache
        lastScanTime = now;
        lastScanResults = newTasks;
        lastTasksDirMtime = currentMtime;

        return newTasks;
    } catch (error) {
        console.error('Error scanning disk for new tasks:', error);
        return [];
    }
}

/**
 * Result of a ghost eviction pass (#3721).
 */
export interface GhostEvictionResult {
    /** TaskIds removed from the cache (backing file gone). */
    evicted: string[];
    /** Entries spared because they are remote (GDrive archive tier). */
    skippedRemote: number;
    /** True when a source could not be enumerated reliably — eviction for that
     *  source was skipped entirely (fail-open, never mass-evict on I/O errors). */
    failOpenRoo: boolean;
    failOpenClaude: boolean;
}

/**
 * #3721 — Evict cache entries whose backing file no longer exists.
 *
 * The conversation cache is add-only: `scanDiskForNewTasks` / Worker A /
 * `loadClaudeCodeSessions` insert skeletons but nothing removes them when the
 * underlying JSONL or task directory is deleted. Deleted sessions keep being
 * served by `list` with their stale metadata forever (ghosts), and `view` on
 * them misdiagnoses "file gone" as "JSONL corrupted".
 *
 * This pass enumerates the LIVE local taskIds (one readdir per storage root —
 * no per-entry stat) and deletes cache entries that positively classify as
 * local yet are not live anymore.
 *
 * Safety rules:
 * - Remote entries (`metadata.dataSource` 'archive' / 'gdrive-archive') are
 *   spared — their files are not supposed to exist locally.
 * - FAIL-OPEN per source: if storage detection returns nothing, or ANY single
 *   readdir fails (permissions, drive flap), that source's eviction is skipped
 *   entirely. A temporarily unavailable drive must never look like "everything
 *   was deleted".
 * - Membership is checked against BOTH Claude taskId formats: per-session
 *   `claude-{project}--{uuid}` and legacy per-project `claude-{project}`
 *   (project basenames contain '--' themselves, so the id is never parsed).
 */
export async function evictGoneLocalTasks(
    conversationCache: Map<string, SkeletonHeader>
): Promise<GhostEvictionResult> {
    const result: GhostEvictionResult = {
        evicted: [],
        skippedRemote: 0,
        failOpenRoo: false,
        failOpenClaude: false,
    };

    // --- Live Roo task ids: names of directories under <storage>/tasks ---
    const rooLive = new Set<string>();
    try {
        const storagePaths = await RooStorageDetector.detectStorageLocations();
        if (storagePaths.length === 0) {
            result.failOpenRoo = true;
        } else {
            for (const storagePath of storagePaths) {
                try {
                    const entries = await fs.readdir(path.join(storagePath, 'tasks'), { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && entry.name !== '.skeletons') {
                            rooLive.add(entry.name);
                        }
                    }
                } catch {
                    // One unreadable location = we can't trust the live set
                    result.failOpenRoo = true;
                    break;
                }
            }
        }
    } catch {
        result.failOpenRoo = true;
    }

    // --- Live Claude task ids: per-session + per-project formats ---
    const claudeLive = new Set<string>();
    try {
        const { ClaudeStorageDetector } = await import('../../utils/claude-storage-detector.js');
        const locations = await ClaudeStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            result.failOpenClaude = true;
        } else {
            for (const location of locations) {
                const projectBasename = path.basename(location.projectPath);
                claudeLive.add(`claude-${projectBasename}`); // legacy per-project format
                try {
                    const files = await fs.readdir(location.projectPath);
                    for (const file of files) {
                        if (file.endsWith('.jsonl')) {
                            claudeLive.add(`claude-${projectBasename}--${file.replace(/\.jsonl$/, '')}`);
                        }
                    }
                } catch {
                    result.failOpenClaude = true;
                    break;
                }
            }
        }
    } catch {
        result.failOpenClaude = true;
    }

    if (result.failOpenRoo && result.failOpenClaude) {
        // Nothing can be verified — keep everything.
        return result;
    }

    for (const [taskId, skeleton] of conversationCache.entries()) {
        const dataSource = (skeleton as any)?.metadata?.dataSource;
        if (dataSource === 'archive' || dataSource === 'gdrive-archive') {
            result.skippedRemote++;
            continue;
        }

        if (taskId.startsWith('claude-')) {
            if (result.failOpenClaude) continue; // fail-open: cannot verify
            if (!claudeLive.has(taskId)) {
                conversationCache.delete(taskId);
                result.evicted.push(taskId);
            }
        } else {
            if (result.failOpenRoo) continue; // fail-open: cannot verify
            if (!rooLive.has(taskId)) {
                conversationCache.delete(taskId);
                result.evicted.push(taskId);
            }
        }
    }

    return result;
}