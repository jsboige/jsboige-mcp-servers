/**
 * Garbage Scanner for Task Index (#1786)
 *
 * Detects and cleans "exploded" tasks in the skeleton cache and Qdrant index:
 * - Death spirals: repeated identical errors (502 retry loops)
 * - Duplicates: multiple skeletons with identical content signatures
 * - Low-value tasks: high error ratio, near-zero assistant output
 *
 * NEVER touches raw JSONL files (sanctuary rule #1621).
 *
 * @version 1.0.0
 */

import { ConversationSkeleton, SkeletonHeader, MessageSkeleton, ActionMetadata } from '../../types/conversation.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- Types ---

export type GarbageCategory = 'death_spiral' | 'duplicate' | 'low_value';

export interface GarbageCandidate {
    task_id: string;
    category: GarbageCategory;
    score: number; // 0-1, higher = more likely garbage
    details: {
        message_count: number;
        action_count: number;
        assistant_message_count: number;
        error_message_count: number;
        assistant_ratio: number;
        error_ratio: number;
        total_size: number;
        duplicate_group_key?: string;
        duplicate_group_size?: number;
        death_spiral_error?: string;
        death_spiral_count?: number;
    };
}

export interface GarbageScanResult {
    total_scanned: number;
    flagged: GarbageCandidate[];
    by_category: Record<GarbageCategory, number>;
    total_size_flagged: number;
    estimated_vectors_flagged: number;
}

export interface GarbageCleanupResult {
    skeletons_removed: number;
    vectors_deleted: number;
    space_freed_bytes: number;
    errors: string[];
}

export interface GarbageScanArgs {
    dry_run?: boolean;
    remove_skeletons?: boolean;
    remove_vectors?: boolean;
    category?: GarbageCategory | 'all';
    min_messages?: number;
    max_results?: number;
}

// --- Constants ---

const DEATH_SPIRAL_THRESHOLD = 5;
const LOW_VALUE_ASSISTANT_RATIO = 0.05;
const LOW_VALUE_ERROR_RATIO = 0.5;
const MIN_MESSAGES_FOR_SCAN = 10;
const DUPLICATE_SAME_FIELDS: (keyof Pick<
    SkeletonHeader['metadata'],
    'createdAt' | 'messageCount' | 'totalSize' | 'machineId'
>)[] = ['createdAt', 'messageCount', 'totalSize', 'machineId'];

// --- Detection Functions ---

function isActionMetadata(item: MessageSkeleton | ActionMetadata): item is ActionMetadata {
    return 'type' in item && (item.type === 'tool' || item.type === 'command');
}

function isMessageSkeleton(item: MessageSkeleton | ActionMetadata): item is MessageSkeleton {
    return 'role' in item;
}

/**
 * Detect death spirals: same error message repeated N+ times consecutively
 */
function detectDeathSpiral(skeleton: ConversationSkeleton): { detected: boolean; error?: string; count: number } {
    const sequence = skeleton.sequence || [];
    let lastError = '';
    let consecutiveCount = 0;
    let maxConsecutive = 0;
    let maxError = '';

    for (const item of sequence) {
        if (isMessageSkeleton(item) && item.role === 'assistant') {
            const content = (item.content || '').toLowerCase();
            const isError = content.includes('error') || content.includes('502') ||
                content.includes('timeout') || content.includes('failed') ||
                content.includes('bad gateway');

            if (isError) {
                // Normalize error for comparison (strip timestamps, counts)
                const normalized = content
                    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}/gi, '')
                    .replace(/\d+ms/g, '')
                    .replace(/\d+s/g, '')
                    .trim()
                    .slice(0, 200);

                if (normalized === lastError) {
                    consecutiveCount++;
                } else {
                    lastError = normalized;
                    consecutiveCount = 1;
                }

                if (consecutiveCount > maxConsecutive) {
                    maxConsecutive = consecutiveCount;
                    maxError = lastError;
                }
            } else {
                lastError = '';
                consecutiveCount = 0;
            }
        }
    }

    return {
        detected: maxConsecutive >= DEATH_SPIRAL_THRESHOLD,
        error: maxError || undefined,
        count: maxConsecutive
    };
}

/**
 * Compute assistant/error ratios from skeleton sequence
 */
function computeRatios(skeleton: ConversationSkeleton): {
    assistantCount: number;
    errorCount: number;
    totalMessages: number;
    assistantRatio: number;
    errorRatio: number;
} {
    const sequence = skeleton.sequence || [];
    let assistantCount = 0;
    let errorCount = 0;
    let totalMessages = 0;

    for (const item of sequence) {
        if (isMessageSkeleton(item)) {
            totalMessages++;
            if (item.role === 'assistant') {
                assistantCount++;
                const content = (item.content || '').toLowerCase();
                if (content.includes('error') || content.includes('502') ||
                    content.includes('timeout') || content.includes('failed') ||
                    content.includes('bad gateway')) {
                    errorCount++;
                }
            }
        }
    }

    return {
        assistantCount,
        errorCount,
        totalMessages,
        assistantRatio: totalMessages > 0 ? assistantCount / totalMessages : 0,
        errorRatio: totalMessages > 0 ? errorCount / totalMessages : 0
    };
}

/**
 * Compute duplicate group key from metadata
 */
function getDuplicateKey(skeleton: SkeletonHeader): string {
    const parts = DUPLICATE_SAME_FIELDS.map(field => {
        const val = skeleton.metadata[field];
        return val !== undefined ? String(val) : '';
    });
    return parts.join('|');
}

// --- Main Scan Function ---

/**
 * Scan skeleton cache for garbage tasks.
 * Operates on the in-memory cache — no disk reads needed for skeletons already loaded.
 */
export async function scanForGarbage(
    conversationCache: Map<string, ConversationSkeleton>,
    args: GarbageScanArgs
): Promise<GarbageScanResult> {
    const category = args.category || 'all';
    const minMessages = args.min_messages || MIN_MESSAGES_FOR_SCAN;
    const maxResults = args.max_results || 100;
    const dryRun = args.dry_run !== false; // default true

    const flagged: GarbageCandidate[] = [];
    let totalScanned = 0;

    // Phase 1: Per-skeleton analysis (death spiral, low value)
    for (const [taskId, skeleton] of conversationCache) {
        const msgCount = skeleton.metadata.messageCount || 0;
        if (msgCount < minMessages) continue;

        totalScanned++;
        const ratios = computeRatios(skeleton);

        // Check death spiral
        if (category === 'all' || category === 'death_spiral') {
            const spiral = detectDeathSpiral(skeleton);
            if (spiral.detected) {
                const score = Math.min(spiral.count / 10, 1); // 10+ consecutive = score 1.0
                flagged.push({
                    task_id: taskId,
                    category: 'death_spiral',
                    score,
                    details: {
                        message_count: msgCount,
                        action_count: skeleton.metadata.actionCount || 0,
                        assistant_message_count: ratios.assistantCount,
                        error_message_count: ratios.errorCount,
                        assistant_ratio: ratios.assistantRatio,
                        error_ratio: ratios.errorRatio,
                        total_size: skeleton.metadata.totalSize || 0,
                        death_spiral_error: spiral.error?.slice(0, 100),
                        death_spiral_count: spiral.count
                    }
                });
                continue; // Don't double-flag
            }
        }

        // Check low value
        if (category === 'all' || category === 'low_value') {
            if (ratios.assistantRatio < LOW_VALUE_ASSISTANT_RATIO &&
                ratios.errorRatio > LOW_VALUE_ERROR_RATIO &&
                msgCount >= minMessages) {
                const score = Math.max(1 - ratios.assistantRatio, ratios.errorRatio);
                flagged.push({
                    task_id: taskId,
                    category: 'low_value',
                    score,
                    details: {
                        message_count: msgCount,
                        action_count: skeleton.metadata.actionCount || 0,
                        assistant_message_count: ratios.assistantCount,
                        error_message_count: ratios.errorCount,
                        assistant_ratio: ratios.assistantRatio,
                        error_ratio: ratios.errorRatio,
                        total_size: skeleton.metadata.totalSize || 0
                    }
                });
                continue;
            }
        }
    }

    // Phase 2: Duplicate detection (cross-skeleton comparison)
    if (category === 'all' || category === 'duplicate') {
        const groups = new Map<string, SkeletonHeader[]>();
        for (const [taskId, skeleton] of conversationCache) {
            const key = getDuplicateKey(skeleton);
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(skeleton);
        }

        for (const [key, group] of groups) {
            if (group.length <= 1) continue;
            // All members of the group are duplicates, keep the first one
            for (let i = 1; i < group.length; i++) {
                const s = group[i];
                const msgCount = s.metadata.messageCount || 0;
                if (msgCount < minMessages) continue;

                // Don't add if already flagged
                if (flagged.some(f => f.task_id === s.taskId)) continue;

                const score = Math.min(0.5 + (group.length * 0.1), 1); // More duplicates = higher score
                flagged.push({
                    task_id: s.taskId,
                    category: 'duplicate',
                    score,
                    details: {
                        message_count: msgCount,
                        action_count: s.metadata.actionCount || 0,
                        assistant_message_count: 0,
                        error_message_count: 0,
                        assistant_ratio: 0,
                        error_ratio: 0,
                        total_size: s.metadata.totalSize || 0,
                        duplicate_group_key: key,
                        duplicate_group_size: group.length
                    }
                });
            }
        }
    }

    // Sort by score descending, limit results
    flagged.sort((a, b) => b.score - a.score);
    const limited = flagged.slice(0, maxResults);

    // Compute summary
    const byCategory: Record<GarbageCategory, number> = { death_spiral: 0, duplicate: 0, low_value: 0 };
    let totalSizeFlagged = 0;
    for (const candidate of limited) {
        byCategory[candidate.category]++;
        totalSizeFlagged += candidate.details.total_size;
    }

    // Estimate vectors (rough: ~1 vector per 500 chars of content, or ~20 per task message)
    const estimatedVectors = Math.round(
        limited.reduce((sum, c) => sum + c.details.message_count * 20, 0)
    );

    return {
        total_scanned: totalScanned,
        flagged: limited,
        by_category: byCategory,
        total_size_flagged: totalSizeFlagged,
        estimated_vectors_flagged: estimatedVectors
    };
}

/**
 * Remove garbage tasks from skeleton cache and optionally Qdrant.
 * NEVER touches raw JSONL files.
 */
export async function cleanupGarbage(
    conversationCache: Map<string, ConversationSkeleton>,
    candidates: GarbageCandidate[],
    args: GarbageScanArgs
): Promise<GarbageCleanupResult> {
    const removeSkeletons = args.remove_skeletons !== false;
    const removeVectors = args.remove_vectors !== false;
    const result: GarbageCleanupResult = {
        skeletons_removed: 0,
        vectors_deleted: 0,
        space_freed_bytes: 0,
        errors: []
    };

    for (const candidate of candidates) {
        const taskId = candidate.task_id;

        // Remove skeleton file
        if (removeSkeletons) {
            try {
                const { RooStorageDetector } = await import('../../utils/roo-storage-detector.js');
                const locations = await RooStorageDetector.detectStorageLocations();
                if (locations.length > 0) {
                    const storagePath = locations[0];
                    const skeletonDir = path.join(storagePath, 'tasks', '.skeletons');
                    const skeletonFile = path.join(skeletonDir, `${taskId}.json`);

                    try {
                        const stat = await fs.stat(skeletonFile);
                        await fs.unlink(skeletonFile);
                        result.space_freed_bytes += stat.size;
                        result.skeletons_removed++;
                    } catch {
                        // File may not exist on this machine
                    }
                }
            } catch (error: any) {
                result.errors.push(`Skeleton removal failed for ${taskId}: ${error.message}`);
            }

            // Remove from in-memory cache
            const skeleton = conversationCache.get(taskId);
            if (skeleton) {
                result.space_freed_bytes += skeleton.metadata.totalSize || 0;
                conversationCache.delete(taskId);
            }
        }

        // Remove Qdrant vectors
        if (removeVectors) {
            try {
                const { getQdrantClient } = await import('../../services/qdrant.js');
                const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
                const qdrant = getQdrantClient();

                // Delete vectors by task_id filter
                await qdrant.delete(COLLECTION_NAME, {
                    filter: {
                        must: [
                            { key: 'task_id', match: { value: taskId } }
                        ]
                    }
                });

                // Estimate deleted count
                result.vectors_deleted += candidate.details.message_count * 20; // rough estimate
            } catch (error: any) {
                result.errors.push(`Vector removal failed for ${taskId}: ${error.message}`);
            }
        }
    }

    return result;
}
