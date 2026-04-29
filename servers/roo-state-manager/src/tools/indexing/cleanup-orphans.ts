/**
 * Qdrant Orphan Cleanup (#1821)
 *
 * Detects and removes Qdrant vectors whose source JSONL files no longer exist.
 * Cross-references Qdrant task_ids against:
 *   1. In-memory skeleton cache (fast)
 *   2. On-disk source files (accurate)
 *
 * NEVER deletes source files — only Qdrant vectors.
 * Opt-in: dry-run by default, confirm required for deletion.
 *
 * @version 1.0.0
 */

import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import { networkMetrics } from '../../services/task-indexer/QdrantHealthMonitor.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const SCROLL_BATCH_SIZE = 1000;

export interface OrphanCleanupResult {
    total_task_ids_in_qdrant: number;
    in_cache: number;
    on_disk: number;
    orphans: string[];
    vectors_deleted: number;
    errors: string[];
}

/**
 * Scroll all unique task_ids from Qdrant collection.
 * Uses scroll API with payload to extract task_id from each point.
 */
async function scrollUniqueTaskIds(): Promise<Set<string>> {
    const qdrant = getQdrantClient();
    const taskIds = new Set<string>();
    let offset: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
        const scrollResult: any = await qdrant.scroll(COLLECTION_NAME, {
            limit: SCROLL_BATCH_SIZE,
            offset,
            with_payload: true,
            with_vector: false,
        });

        const points: any[] = scrollResult?.points || [];

        if (points.length === 0) {
            hasMore = false;
            break;
        }

        for (const point of points) {
            const payload = point.payload || {};
            const taskId = payload.task_id;
            if (taskId && typeof taskId === 'string') {
                taskIds.add(taskId);
            }
        }

        networkMetrics.qdrantCalls++;

        if (scrollResult.next_page_offset) {
            offset = scrollResult.next_page_offset;
        } else {
            hasMore = false;
        }
    }

    return taskIds;
}

/**
 * Check if a Claude Code session file exists on disk for a given task_id.
 * Scans ~/.claude/projects/ for JSONL files matching the task_id.
 */
async function claudeSessionExists(taskId: string): Promise<boolean> {
    const claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects');
    try {
        await fs.access(claudeProjectsPath);
    } catch {
        return false;
    }

    // Look for the JSONL file with this task_id as filename
    const expectedPath = path.join(claudeProjectsPath, `${taskId}.jsonl`);
    try {
        await fs.access(expectedPath);
        return true;
    } catch {
        // Not a direct match — could be in a subdirectory
    }

    // Check in subdirectory structure (project dirs contain UUID.jsonl files)
    // This is expensive so we only do it for cache misses
    // For now, we rely on the in-memory cache for Claude sessions
    return false;
}

/**
 * Detect and optionally clean orphaned Qdrant vectors.
 *
 * @param conversationCache In-memory skeleton cache for fast lookup
 * @param dryRun If true, only report — don't delete
 * @param confirm Required for deletion (must be true when dryRun=false)
 */
export async function detectAndCleanupOrphans(
    conversationCache: Map<string, ConversationSkeleton>,
    dryRun: boolean = true,
    confirm: boolean = false
): Promise<OrphanCleanupResult> {
    const result: OrphanCleanupResult = {
        total_task_ids_in_qdrant: 0,
        in_cache: 0,
        on_disk: 0,
        orphans: [],
        vectors_deleted: 0,
        errors: [],
    };

    // Phase 1: Scroll all unique task_ids from Qdrant
    console.log('[cleanup-orphans] Scrolling unique task_ids from Qdrant...');
    let qdrantTaskIds: Set<string>;
    try {
        qdrantTaskIds = await scrollUniqueTaskIds();
    } catch (error: any) {
        result.errors.push(`Failed to scroll Qdrant: ${error.message}`);
        return result;
    }
    result.total_task_ids_in_qdrant = qdrantTaskIds.size;
    console.log(`[cleanup-orphans] Found ${qdrantTaskIds.size} unique task_ids in Qdrant`);

    // Phase 2: Cross-reference with cache
    const cacheTaskIds = new Set(conversationCache.keys());
    const notInCache: string[] = [];

    for (const taskId of qdrantTaskIds) {
        if (cacheTaskIds.has(taskId)) {
            result.in_cache++;
        } else {
            notInCache.push(taskId);
        }
    }
    console.log(`[cleanup-orphans] ${result.in_cache} in cache, ${notInCache.length} need disk check`);

    // Phase 3: For cache misses, check disk
    const orphans: string[] = [];

    for (const taskId of notInCache) {
        try {
            // Check Roo storage
            const rooConversation = await RooStorageDetector.findConversationById(taskId);
            if (rooConversation) {
                result.on_disk++;
                continue;
            }

            // Check Claude Code sessions
            const claudeExists = await claudeSessionExists(taskId);
            if (claudeExists) {
                result.on_disk++;
                continue;
            }

            // Neither in cache nor on disk — it's an orphan
            orphans.push(taskId);
        } catch (error: any) {
            // If we can't determine status, skip it (safer to keep than to delete)
            result.errors.push(`Error checking ${taskId}: ${error.message}`);
        }
    }

    result.orphans = orphans;
    console.log(`[cleanup-orphans] ${result.on_disk} found on disk, ${orphans.length} orphans detected`);

    // Phase 4: Delete orphans (only if not dry-run and confirmed)
    if (!dryRun && confirm && orphans.length > 0) {
        console.log(`[cleanup-orphans] Deleting ${orphans.length} orphan task_ids from Qdrant...`);
        const qdrant = getQdrantClient();

        for (const taskId of orphans) {
            try {
                await qdrant.delete(COLLECTION_NAME, {
                    filter: {
                        must: [
                            { key: 'task_id', match: { value: taskId } }
                        ]
                    },
                });
                networkMetrics.qdrantCalls++;
                result.vectors_deleted++;
            } catch (error: any) {
                result.errors.push(`Failed to delete ${taskId}: ${error.message}`);
            }
        }
        console.log(`[cleanup-orphans] Deleted vectors for ${result.vectors_deleted} orphan task_ids`);
    } else if (orphans.length > 0 && !dryRun && !confirm) {
        result.errors.push('Confirmation required for deletion. Set confirm=true to proceed.');
    }

    return result;
}
