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
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { TaskArchiver } from '../../services/task-archiver/index.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const SCROLL_BATCH_SIZE = 1000;

/**
 * #694 fleet-safety threshold. On a fleet-shared collection (multiple machines writing
 * to one Qdrant collection), a single machine sees every OTHER machine's task_ids as
 * orphans — they're absent from ITS local cache and disk. If orphans exceed this fraction
 * of total task_ids, we treat it as a mono-machine artifact and refuse to delete, to avoid
 * destroying the fleet's index. 0.5 = majority of the collection would be flagged.
 */
const FLEET_SAFETY_ORPHAN_RATIO = 0.5;

export interface OrphanCleanupResult {
    total_task_ids_in_qdrant: number;
    in_cache: number;
    on_disk: number;
    /** #698: task_ids found in the cross-machine shared-state archive (another machine's task — NOT an orphan). */
    in_archive: number;
    orphans: string[];
    vectors_deleted: number;
    errors: string[];
    /** #694: true when deletion was aborted because orphans > 50% of total (mono-machine artifact on a fleet-shared collection). */
    fleet_safety_abort?: boolean;
    /** #694: human-readable reason for a fleet-safety abort. */
    abort_reason?: string;
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
 * Single-pass basename index of Claude Code session JSONLs across the project
 * subdirectories of ~/.claude/projects (#3986). One readdir per project dir,
 * then O(1) lookups for every cache-miss task_id of the same run.
 *
 * Built ONCE per detectAndCleanupOrphans call — NEVER memoized across runs: a
 * session created after a previous run must not be mis-read as an orphan.
 * Degrades to the empty set (legacy behavior) on any readdir failure — a broken
 * index must not produce false orphans.
 */
async function buildClaudeSessionIndex(claudeProjectsPath: string): Promise<Set<string>> {
    const basenames = new Set<string>();
    let projectDirs: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
        projectDirs = (await fs.readdir(claudeProjectsPath, { withFileTypes: true })) as typeof projectDirs;
    } catch {
        return basenames; // unreadable root — degrade to legacy behavior
    }
    if (!Array.isArray(projectDirs)) return basenames; // defensive (mocked/partial fs)

    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = (await fs.readdir(path.join(claudeProjectsPath, dir.name), { withFileTypes: true })) as typeof entries;
        } catch {
            continue; // unreadable project dir — skip it, never blocks the cleanup
        }
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                basenames.add(entry.name);
            }
        }
    }
    return basenames;
}

/** UUID v4 shape (Claude Code session file names). Hex 8-4-4-4-12, case-insensitive. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a Claude Code session file exists on disk for a given task_id.
 * Scans ~/.claude/projects/ for JSONL files matching the task_id — the legacy
 * root layout and the per-project subdirectory layout (#3986).
 */
async function claudeSessionExists(taskId: string, sessionBasenames?: Set<string>): Promise<boolean> {
    const claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects');
    try {
        await fs.access(claudeProjectsPath);
    } catch {
        return false;
    }

    // Look for the JSONL file with this task_id as filename (legacy root layout)
    const expectedPath = path.join(claudeProjectsPath, `${taskId}.jsonl`);
    try {
        await fs.access(expectedPath);
        return true;
    } catch {
        // Not a direct match — could be in a subdirectory
    }

    // #3986: the real layout is ~/.claude/projects/<project-hash>/<uuid>.jsonl. The old
    // `return false` here mis-classified every subdirectory session as an orphan
    // (mass false-negatives → systematic FLEET-SAFETY aborts, or live vectors deleted).
    // The index is built once per run by the caller; standalone calls build it on demand.
    const basenames = sessionBasenames ?? await buildClaudeSessionIndex(claudeProjectsPath);
    if (basenames.has(`${taskId}.jsonl`)) {
        return true;
    }

    // #2609: Qdrant stores per-session claude-code task_ids as `claude-{project}--{uuid}`,
    // but the JSONL on disk is named by the BARE uuid (any project dir may host it —
    // sessions opened from a worktree live under the worktree's project dir, not the
    // one encoded in the task_id). Look up the suffix after the last `--`: a uuid never
    // contains a double dash, and project names that do (drive-letter encodings like
    // `d--Dev-...`) simply miss here and fall through to the per-project path below.
    const lastSep = taskId.lastIndexOf('--');
    if (lastSep !== -1) {
        const sessionFile = `${taskId.slice(lastSep + 2)}.jsonl`;
        if (basenames.has(sessionFile)) {
            return true;
        }
        // Per-session id with a uuid suffix: the one-pass basename index covers every
        // project dir, so a miss here is authoritative — do NOT fall through to the
        // detector, whose per-project aggregate would mis-read a dead session as live.
        if (SESSION_UUID_RE.test(taskId.slice(lastSep + 2))) {
            return false;
        }
    }

    // Per-project legacy ids (`claude-{project}`, no session uuid) name no file —
    // delegate to the detector, which resolves the project dir itself.
    if (taskId.startsWith('claude-')) {
        return (await ClaudeStorageDetector.findConversationById(taskId)) !== null;
    }
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
        in_archive: 0,
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
    // #3986: one-pass basename index of Claude sessions (~/.claude/projects/<proj>/<uuid>.jsonl),
    // built lazily on the first cache-miss that needs it, reused for the whole run.
    let claudeBasenames: Set<string> | null = null;

    for (const taskId of notInCache) {
        try {
            // Check Roo storage
            const rooConversation = await RooStorageDetector.findConversationById(taskId);
            if (rooConversation) {
                result.on_disk++;
                continue;
            }

            // Check Claude Code sessions
            if (claudeBasenames === null) {
                claudeBasenames = await buildClaudeSessionIndex(path.join(os.homedir(), '.claude', 'projects'));
            }
            const claudeExists = await claudeSessionExists(taskId, claudeBasenames);
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

    // Phase 3.4: Fleet-archive cross-check (#698 — option B follow-up to #694).
    // On a fleet-shared collection, a task_id absent from THIS machine's cache+disk may still
    // belong to another machine — its source was archived to the shared-state GDrive archive.
    // Re-classify such task_ids as non-orphans BEFORE the fleet-safety threshold check, so the
    // threshold is computed against true orphans (reduces false positives on legit cleanups).
    // Non-blocking: ROOSYNC_SHARED_PATH unset / readdir failure → skip (no false orphans, no block).
    if (orphans.length > 0) {
        try {
            const archivedTaskIds = new Set(await TaskArchiver.listArchivedTasks());
            if (archivedTaskIds.size > 0) {
                const trueOrphans = orphans.filter(id => !archivedTaskIds.has(id));
                result.in_archive = orphans.length - trueOrphans.length;
                if (result.in_archive > 0) {
                    console.log(`[cleanup-orphans] ${result.in_archive} orphans re-classified as archived (cross-machine)`);
                    orphans.length = 0;
                    orphans.push(...trueOrphans);
                    result.orphans = orphans;
                }
            }
        } catch (archiveError: any) {
            // Archive unavailable (no shared path, GDrive offline) — keep orphans as-is.
            // Not an error condition: the fleet-safety threshold still guards deletion.
            console.warn(`[cleanup-orphans] Fleet-archive cross-check skipped: ${archiveError?.message || archiveError}`);
        }
    }

    // Phase 3.5: Fleet-safety guard (#694). On a fleet-shared collection, a single machine
    // sees other machines' task_ids as orphans (absent from its local cache/disk). If orphans
    // exceed half the total task_ids, this is almost certainly a mono-machine artifact —
    // ABORT deletion (even with confirm=true) to avoid destroying the fleet's index.
    if (
        result.total_task_ids_in_qdrant > 0 &&
        orphans.length > result.total_task_ids_in_qdrant * FLEET_SAFETY_ORPHAN_RATIO
    ) {
        const pct = ((orphans.length / result.total_task_ids_in_qdrant) * 100).toFixed(1);
        result.abort_reason =
            `FLEET-SAFETY ABORT: ${orphans.length} of ${result.total_task_ids_in_qdrant} task_ids (${pct}%) ` +
            `would be deleted — exceeds the ${FLEET_SAFETY_ORPHAN_RATIO * 100}% fleet-safety threshold. On a fleet-shared ` +
            `Qdrant collection this is almost certainly a mono-machine artifact (the other machines' task_ids are ` +
            `absent from this machine's local cache/disk). Run cleanup_orphans from a coordinator with full inventory ` +
            `visibility, or delete specific task_ids individually.`;
        result.fleet_safety_abort = true;
        result.errors.push(result.abort_reason);
        console.warn(`[cleanup-orphans] ${result.abort_reason}`);
        // Do NOT proceed to deletion — return early. orphans[] stays populated for visibility.
        return result;
    }

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
