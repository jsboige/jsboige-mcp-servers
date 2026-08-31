/**
 * #3344: Backfill `workspace_name` / `workspace` on existing indexed points.
 *
 * The ai-01 counter-sample (6000 points, 2026-08-31) split the "49.1% missing
 * workspace_name" diagnosis into two cohorts:
 *   - 3.5%  points with `workspace` but no `workspace_name` → derivation gap,
 *           repairable deterministically (basename of the existing field);
 *   - 48.2% points with NEITHER field → emitters that indexed without any
 *           workspace coordinate. Not derivable from the point itself, but the
 *           originating task/session usually still lives on the machine that
 *           indexed it: resolved here via local storage lookup by task_id.
 *
 * This action is per-machine BY DESIGN: a fleet-wide repair happens when each
 * machine runs it — only the machine that owns a session file can resolve it.
 * Points that resolve nowhere are reported (by source and machine) as
 * unrepairable instead of being silently skipped, so the operator knows which
 * lanes need a re-index rather than a backfill.
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs, createReadStream } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getQdrantClient } from '../../services/qdrant.js';
import { workspaceBasename } from '../../services/task-indexer/ChunkExtractor.js';

export interface RepairWorkspaceOptions {
    /** Simulation mode: report what would be repaired, write nothing. Default: false (setPayload only ADDS fields — non-destructive). */
    dryRun?: boolean;
    /** Max points to scan per call (bounds scroll cost on a 2M+ collection). Default: 20000. */
    maxScanPoints?: number;
    /** Max points to repair per call. Default: 5000. */
    maxRepairPoints?: number;
}

const SCROLL_BATCH = 256;
const SET_PAYLOAD_BATCH = 100;

/** Read the first `cwd` found in the head of a Claude Code JSONL session file. */
async function readCwdFromJsonl(filePath: string, maxLines = 200): Promise<string | undefined> {
    try {
        const stream = createReadStream(filePath, 'utf-8');
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let lines = 0;
        try {
            for await (const line of rl) {
                if (!line.trim()) continue;
                if (++lines > maxLines) break;
                try {
                    const entry = JSON.parse(line);
                    if (typeof entry.cwd === 'string' && entry.cwd) {
                        return entry.cwd;
                    }
                } catch {
                    // malformed line — keep scanning
                }
            }
        } finally {
            rl.close();
            stream.destroy();
        }
    } catch {
        // unreadable file — caller treats as unresolvable
    }
    return undefined;
}

/**
 * Resolve the workspace of a claude-* taskId from local Claude Code storage.
 * Supports both taskId formats (see TaskIndexer.indexTask):
 *   - claude-{projectDir}            → per-project (first JSONL of the dir)
 *   - claude-{projectDir}--{uuid}    → per-session ({uuid}.jsonl)
 */
async function resolveClaudeWorkspace(taskId: string): Promise<string | undefined> {
    const { ClaudeStorageDetector } = await import('../../utils/claude-storage-detector.js');
    const locations = await ClaudeStorageDetector.detectStorageLocations();
    const suffix = taskId.replace(/^claude-/, '');
    // Child units (#2825 pagination): `${taskId}#unit-N` → strip the synthetic suffix.
    const baseSuffix = suffix.split('#unit-')[0];

    for (const loc of locations) {
        const basename = path.basename(loc.projectPath);
        if (baseSuffix === basename) {
            // Per-project id: take the first JSONL in the directory.
            let entries: string[];
            try {
                entries = (await fs.readdir(loc.projectPath)).filter(e => e.endsWith('.jsonl')).sort();
            } catch {
                continue;
            }
            if (entries.length === 0) continue;
            return await readCwdFromJsonl(path.join(loc.projectPath, entries[0]));
        }
        if (baseSuffix.startsWith(basename + '--')) {
            const sessionUuid = baseSuffix.substring(basename.length + 2);
            const cwd = await readCwdFromJsonl(path.join(loc.projectPath, `${sessionUuid}.jsonl`));
            if (cwd) return cwd;
        }
    }
    return undefined;
}

/** Resolve the workspace of a Roo taskId from local Roo storage (task_metadata.json). */
async function resolveRooWorkspace(taskId: string): Promise<string | undefined> {
    const { RooStorageDetector } = await import('../../utils/roo-storage-detector.js');
    const locations = await RooStorageDetector.detectStorageLocations();
    const baseTaskId = taskId.split('#unit-')[0];
    for (const location of locations) {
        const metadataPath = path.join(location, 'tasks', baseTaskId, 'task_metadata.json');
        try {
            const content = await fs.readFile(metadataPath, 'utf-8');
            const clean = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
            const metadata = JSON.parse(clean);
            if (typeof metadata.workspace === 'string' && metadata.workspace) {
                return metadata.workspace;
            }
        } catch {
            // not in this location — try the next
        }
    }
    return undefined;
}

interface GroupCount { total: number }

function bump(map: Record<string, GroupCount>, key: string): void {
    const k = key || '__unknown__';
    map[k] = map[k] || { total: 0 };
    map[k].total++;
}

export async function handleRepairWorkspace(options: RepairWorkspaceOptions = {}): Promise<CallToolResult> {
    const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
    const dryRun = options.dryRun === true;
    const maxScan = Math.max(1, options.maxScanPoints ?? 20000);
    const maxRepair = Math.max(1, options.maxRepairPoints ?? 5000);

    const qdrant = getQdrantClient();
    const taskIdCache = new Map<string, string | undefined>();

    const findings = {
        scanned: 0,
        missing_workspace_name: 0,
        with_workspace_only: 0, // derivation gap cohort (3.5% in the ai-01 sample)
        with_neither: 0,        // no workspace coordinate at all (48.2% in the ai-01 sample)
    };
    const repairs = {
        from_workspace_derivation: 0,
        from_local_lookup: 0,
        applied_points: 0,
        set_payload_calls: 0,
    };
    const unresolved = {
        total: 0,
        by_source: {} as Record<string, GroupCount>,
        by_machine: {} as Record<string, GroupCount>,
    };
    let stopReason = 'end_of_collection';

    // Pending setPayload operations, grouped by identical payload so each Qdrant
    // call updates a batch of points sharing the same value.
    const pending = new Map<string, { payload: Record<string, string>; ids: (string | number)[] }>();

    const flush = async (force = false): Promise<void> => {
        for (const [key, group] of pending) {
            if (force || group.ids.length >= SET_PAYLOAD_BATCH) {
                if (!dryRun) {
                    await qdrant.setPayload(collectionName, { payload: group.payload, points: group.ids, wait: false });
                }
                repairs.set_payload_calls++;
                repairs.applied_points += group.ids.length;
                pending.delete(key);
            }
        }
    };

    const queueUpdate = (payload: Record<string, string>, id: string | number): void => {
        const key = JSON.stringify(payload);
        const group = pending.get(key) || { payload, ids: [] };
        group.ids.push(id);
        pending.set(key, group);
    };

    const countPending = (): number => {
        let n = 0;
        for (const g of pending.values()) n += g.ids.length;
        return n;
    };

    try {
        // Server-side filter: points where workspace_name is empty or missing.
        // On servers that reject is_empty, fall back to client-side scan (slower,
        // bounded by maxScanPoints either way).
        let filterMode: 'server_filter' | 'client_scan' = 'server_filter';
        let offset: any = undefined;
        let useFilter: any = { must: [{ is_empty: { field: 'workspace_name' } }] };
        try {
            await qdrant.scroll(collectionName, {
                limit: 1,
                filter: useFilter,
                with_payload: { include: ['workspace'] },
                with_vector: false,
            });
        } catch {
            filterMode = 'client_scan';
            useFilter = undefined;
        }

        let consecutiveFullPages = 0;
        while (findings.scanned < maxScan && repairs.applied_points + countPending() < maxRepair) {
            const result: any = await qdrant.scroll(collectionName, {
                limit: SCROLL_BATCH,
                ...(offset === undefined ? {} : { offset }),
                ...(useFilter ? { filter: useFilter } : {}),
                with_payload: { include: ['workspace', 'workspace_name', 'task_id', 'source', 'host_os'] },
                with_vector: false,
            });
            const points: any[] = result?.points || result?.result?.points || [];
            if (points.length === 0) {
                stopReason = 'end_of_collection';
                break;
            }
            findings.scanned += points.length;

            // In client_scan mode, a full page with no matches means we cannot
            // distinguish "done" from "gap ahead" — keep paging until scan budget
            // or end of collection, but stop early after many consecutive dry pages.
            let matchedInPage = 0;

            for (const point of points) {
                const payload = point?.payload || {};
                const hasWorkspace = typeof payload.workspace === 'string' && payload.workspace.length > 0;
                const hasName = typeof payload.workspace_name === 'string' && payload.workspace_name.length > 0;

                if (hasName) continue; // already complete (client_scan mode)
                matchedInPage++;
                findings.missing_workspace_name++;

                if (hasWorkspace) {
                    findings.with_workspace_only++;
                    queueUpdate({ workspace_name: workspaceBasename(payload.workspace) }, point.id);
                    repairs.from_workspace_derivation++;
                } else {
                    findings.with_neither++;
                    const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
                    if (!taskId) {
                        unresolved.total++;
                        bump(unresolved.by_source, String(payload.source ?? '__none__'));
                        bump(unresolved.by_machine, String(payload.host_os ?? '__none__'));
                        continue;
                    }
                    if (!taskIdCache.has(taskId)) {
                        const resolved = taskId.startsWith('claude-')
                            ? await resolveClaudeWorkspace(taskId)
                            : await resolveRooWorkspace(taskId);
                        taskIdCache.set(taskId, resolved);
                    }
                    const ws = taskIdCache.get(taskId);
                    if (ws) {
                        queueUpdate({ workspace: ws, workspace_name: workspaceBasename(ws) }, point.id);
                        repairs.from_local_lookup++;
                    } else {
                        unresolved.total++;
                        bump(unresolved.by_source, String(payload.source ?? (taskId.startsWith('claude-') ? 'claude-code' : 'roo')));
                        bump(unresolved.by_machine, String(payload.host_os ?? '__none__'));
                    }
                }
            }

            if (filterMode === 'client_scan' && matchedInPage === 0) {
                consecutiveFullPages++;
                if (consecutiveFullPages >= 10) {
                    stopReason = 'no_more_matches_in_scan_budget';
                    break;
                }
            } else {
                consecutiveFullPages = 0;
            }

            await flush();

            const nextOffset = result?.next_page_offset;
            if (nextOffset === undefined || nextOffset === null) {
                stopReason = 'end_of_collection';
                break;
            }
            offset = nextOffset;
        }

        if (findings.scanned >= maxScan && stopReason === 'end_of_collection') {
            stopReason = 'scan_budget';
        }
        if (countPending() + repairs.applied_points >= maxRepair && stopReason === 'end_of_collection') {
            stopReason = 'repair_budget';
        }

        await flush(true);

        return {
            isError: false,
            content: [{
                type: 'text',
                text: JSON.stringify({
                    action: 'repair_workspace',
                    collection: collectionName,
                    dry_run: dryRun,
                    filter_mode: filterMode,
                    stop_reason: stopReason,
                    scan: {
                        scanned_points: findings.scanned,
                        max_scan_points: maxScan,
                    },
                    findings: {
                        missing_workspace_name: findings.missing_workspace_name,
                        with_workspace_only: findings.with_workspace_only,
                        with_neither: findings.with_neither,
                    },
                    repairs: dryRun
                        ? {
                            from_workspace_derivation: repairs.from_workspace_derivation,
                            from_local_lookup: repairs.from_local_lookup,
                            would_apply_points: countPending() + repairs.applied_points,
                            applied_points: 0,
                            note: 'dry_run=true — nothing was written. Re-run with dry_run=false to apply.',
                        }
                        : {
                            from_workspace_derivation: repairs.from_workspace_derivation,
                            from_local_lookup: repairs.from_local_lookup,
                            applied_points: repairs.applied_points,
                            set_payload_calls: repairs.set_payload_calls,
                        },
                    unresolved: {
                        total: unresolved.total,
                        by_source: unresolved.by_source,
                        by_machine: unresolved.by_machine,
                        hint: 'Unresolved points carry no workspace coordinate AND their task/session is not on this machine. They belong to other machines (run the action there) or to deleted tasks (re-index to fix).',
                    },
                    hint: 'setPayload only ADDS workspace fields — vectors, content and other payload keys are untouched. Re-run until missing_workspace_name stops decreasing; verify with roosync_indexing(action: "diagnose", deep: true).',
                }, null, 2)
            }]
        };
    } catch (error: any) {
        return {
            isError: true,
            content: [{
                type: 'text',
                text: JSON.stringify({
                    action: 'repair_workspace',
                    status: 'error',
                    message: `repair_workspace failed: ${error?.message ?? String(error)}`,
                    scanned_points: findings.scanned,
                    applied_points: repairs.applied_points,
                }, null, 2)
            }]
        };
    }
}
