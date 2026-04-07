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