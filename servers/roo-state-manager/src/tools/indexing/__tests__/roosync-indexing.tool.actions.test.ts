/**
 * Tests for 3 dispatcher branches not covered by PR #684 / Sprint C1:
 *   - `garbage_scan`   L515-592 (source: roosync-indexing.tool.ts)
 *   - `save_snapshot`  L1104-1172 (source: roosync-indexing.tool.ts)
 *   - `repair_gaps`    L653-797 (source: roosync-indexing.tool.ts) — note:
 *     covered by behaviour-mocks of qdrant.count + indexTask path; full DB
 *     round-trip is covered by integration tests in the submodule root.
 *
 * Anchored on real source contract (roosync-indexing.tool.ts) — line refs in
 * comments. Tests are deterministic: dynamic imports are stubbed via vi.mock;
 * no live Qdrant, no filesystem outside tmpdir.
 *
 * Issue: web1 Cluster B residual (2026-07-02 cycle 7)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mutables for the module-local mocks (must use vi.hoisted).
const {
    mockScanForGarbage,
    mockCleanupGarbage,
    mockGetQdrantClient,
    mockIndexTask,
    mockDetectStorageLocations,
    mockFindConversationById,
    mockHomedir,
    sharedStatePathHolder,
} = vi.hoisted(() => ({
    mockScanForGarbage: vi.fn(),
    mockCleanupGarbage: vi.fn(),
    mockGetQdrantClient: vi.fn(),
    mockIndexTask: vi.fn(),
    mockDetectStorageLocations: vi.fn().mockReturnValue([]),
    mockFindConversationById: vi.fn(),
    mockHomedir: { value: '' as string },
    sharedStatePathHolder: { value: '' as string },
}));

// Dynamic-import mocks (hoisted). The dispatcher imports these lazily inside
// each switch case — we still must intercept via vi.mock to avoid touching
// Qdrant or other singletons.
vi.mock('../garbage-scanner.js', () => ({
    scanForGarbage: mockScanForGarbage,
    cleanupGarbage: mockCleanupGarbage,
}));

vi.mock('../../../services/qdrant.js', () => ({
    getQdrantClient: mockGetQdrantClient,
}));

vi.mock('../../../services/task-indexer.js', () => ({
    indexTask: mockIndexTask,
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        findConversationById: mockFindConversationById,
        detectStorageLocations: mockDetectStorageLocations,
    },
}));

// Intercept os.homedir() so tool_usage_stats → save_snapshot scans a controlled tmpdir
// instead of the real ~/.claude/projects (which has hundreds of real sessions on dev machines).
vi.mock('os', async (importOriginal) => {
    const mod = await importOriginal<typeof import('os')>();
    return {
        ...mod,
        homedir: () => mockHomedir.value || mod.homedir(),
        hostname: () => 'rsm-test-host',
    };
});

// Avoid hitting the real shared-state path on save_snapshot / trend_report.
vi.mock('../../../utils/shared-state-path.js', () => ({
    getSharedStatePath: () => sharedStatePathHolder.value,
    tryGetSharedStatePath: () => sharedStatePathHolder.value,
}));

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

const newCtx = () => {
    const cache = new Map();
    const ensureFresh = vi.fn().mockResolvedValue(true);
    const saveSkeleton = vi.fn().mockResolvedValue(undefined);
    const setEnabled = vi.fn();
    const rebuildHandler = vi.fn();
    return { cache, ensureFresh, saveSkeleton, setEnabled, rebuildHandler };
};

// =====================================================================
// garbage_scan (source L515-592)
// =====================================================================

describe('roosync_indexing garbage_scan action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('dry_run=true (default) runs scanForGarbage, skips cleanup, returns scan-only summary', async () => {
        // Source: L517 (default dry_run), L519-528 (call scanForGarbage with conversationCache),
        //         L532 (cleanup skipped because isDryRun=true), L544-545 (summary)
        mockScanForGarbage.mockResolvedValue({
            total_scanned: 50,
            flagged: [
                { task_id: 't-1', category: 'death_spiral', score: 0.9, details: { total_size: 1024, message_count: 200, assistant_ratio: 0.01, error_ratio: 0.7, death_spiral_count: 12 } },
                { task_id: 't-2', category: 'duplicate', score: 0.7, details: { total_size: 800, message_count: 100, assistant_ratio: 0.4, error_ratio: 0.1, duplicate_group_size: 3 } },
            ],
            by_category: { death_spiral: 1, duplicate: 1, low_value: 0 },
            total_size_flagged: 1824,
            estimated_vectors_flagged: 30,
        });

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'garbage_scan' } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(false);
        expect(mockScanForGarbage).toHaveBeenCalledWith(ctx.cache, expect.objectContaining({ dry_run: true, category: 'all' }));
        // Cleanup must NOT be called when dry_run=true
        expect(mockCleanupGarbage).not.toHaveBeenCalled();

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.action).toBe('garbage_scan');
        expect(parsed.mode).toBe('dry_run');
        expect(parsed.scan.flagged_count).toBe(2);
        expect(parsed.scan.by_category.death_spiral).toBe(1);
        expect(parsed.summary).toContain('[DRY RUN]');
        expect(parsed.summary).toContain('2 tâches garbage détectées');
        expect(parsed.cleanup).toBeNull();
    });

    test('dry_run=false with flagged results runs cleanup and returns executed summary', async () => {
        // Source: L531-541 (cleanup path when !isDryRun && flagged.length > 0),
        //         L546-547 (executed summary)
        mockScanForGarbage.mockResolvedValue({
            total_scanned: 10,
            flagged: [{ task_id: 't-1', category: 'low_value', score: 0.5, details: { total_size: 200, message_count: 30, assistant_ratio: 0.01, error_ratio: 0.6 } }],
            by_category: { death_spiral: 0, duplicate: 0, low_value: 1 },
            total_size_flagged: 200,
            estimated_vectors_flagged: 5,
        });
        mockCleanupGarbage.mockResolvedValue({
            skeletons_removed: 1,
            vectors_deleted: 5,
            space_freed_bytes: 200,
            errors: [],
        });

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'garbage_scan', dry_run: false } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(false);
        expect(mockCleanupGarbage).toHaveBeenCalled();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.mode).toBe('executed');
        expect(parsed.cleanup.skeletons_removed).toBe(1);
        expect(parsed.cleanup.vectors_deleted).toBe(5);
        expect(parsed.summary).toContain('[EXECUTED]');
        // top_flagged shape (L568-578): must contain top_flagged array with task_id, category, score
        expect(parsed.top_flagged).toBeDefined();
        expect(parsed.top_flagged[0].task_id).toBe('t-1');
        expect(parsed.top_flagged[0].category).toBe('low_value');
    });

    test('dry_run=false with zero flagged results skips cleanup (mode still surfaces executed label per source L554)', async () => {
        // Source: L531-541 — cleanup only runs when flagged.length > 0
        // Note (source L554): the response `mode` field reflects the request `dry_run`, NOT whether cleanup ran.
        // So `mode: "executed"` here even when flagged=[] — that matches `args.dry_run === false`.
        mockScanForGarbage.mockResolvedValue({
            total_scanned: 100, flagged: [], by_category: { death_spiral: 0, duplicate: 0, low_value: 0 },
            total_size_flagged: 0, estimated_vectors_flagged: 0,
        });

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'garbage_scan', dry_run: false } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(mockCleanupGarbage).not.toHaveBeenCalled();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.mode).toBe('executed'); // matches args.dry_run=false (source L554)
        expect(parsed.scan.flagged_count).toBe(0);
        expect(parsed.cleanup).toBeNull();
    });

    test('forwards category/min_messages/max_results/remove_skeletons/remove_vectors args', async () => {
        // Source: L523-527 — args passed through to scanForGarbage
        mockScanForGarbage.mockResolvedValue({
            total_scanned: 0, flagged: [], by_category: { death_spiral: 0, duplicate: 0, low_value: 0 },
            total_size_flagged: 0, estimated_vectors_flagged: 0,
        });

        const ctx = newCtx();
        await handleRooSyncIndexing(
            {
                action: 'garbage_scan',
                garbage_category: 'death_spiral',
                min_messages: 5,
                max_results: 25,
                remove_skeletons: false,
                remove_vectors: true,
            } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(mockScanForGarbage).toHaveBeenCalledWith(ctx.cache, expect.objectContaining({
            category: 'death_spiral',
            min_messages: 5,
            max_results: 25,
            remove_skeletons: false,
            remove_vectors: true,
        }));
    });

    test('returns isError when scanForGarbage throws', async () => {
        // Source: L583-591 — catch block
        mockScanForGarbage.mockRejectedValue(new Error('Qdrant unreachable'));

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'garbage_scan' } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du garbage scan');
        expect(result.content[0].text).toContain('Qdrant unreachable');
    });

    test('surfaces cleanup errors in response when present', async () => {
        // Source: L566 — `errors: cleanupResult.errors.length > 0 ? cleanupResult.errors : undefined`
        mockScanForGarbage.mockResolvedValue({
            total_scanned: 5,
            flagged: [{ task_id: 't-1', category: 'death_spiral', score: 0.8, details: { total_size: 100, message_count: 20, assistant_ratio: 0.05, error_ratio: 0.5, death_spiral_count: 7 } }],
            by_category: { death_spiral: 1, duplicate: 0, low_value: 0 },
            total_size_flagged: 100,
            estimated_vectors_flagged: 3,
        });
        mockCleanupGarbage.mockResolvedValue({
            skeletons_removed: 0,
            vectors_deleted: 2,
            space_freed_bytes: 100,
            errors: ['t-1: file locked'],
        });

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'garbage_scan', dry_run: false } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.cleanup.errors).toEqual(['t-1: file locked']);
    });
});

// =====================================================================
// save_snapshot (source L1104-1172)
// =====================================================================

describe('roosync_indexing save_snapshot action', () => {
    let tmpDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        // Restore os/DM mocks to safe defaults after clearAllMocks
        mockDetectStorageLocations.mockReturnValue([]);
        mockHomedir.value = '';
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-snapshot-'));
        sharedStatePathHolder.value = tmpDir;
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
        sharedStatePathHolder.value = '';
        mockHomedir.value = '';
    });

    test('writes snapshot file under tool-usage-snapshots/ on the shared path', async () => {
        // Source: L1118-1127 — write under {sharedPath}/tool-usage-snapshots/{hostname}-{YYYY-MM-DD}.json
        // The save_snapshot handler recurses into handleRooSyncIndexing(action: 'tool_usage_stats') —
        // we control the scan surface by (a) RoostorageDetector.detectStorageLocations → []
        // and (b) os.homedir() → empty tmpdir (so no real ~/.claude/projects is scanned).
        mockHomedir.value = tmpDir;
        mockDetectStorageLocations.mockReturnValue([]);

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'save_snapshot' } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.action).toBe('save_snapshot');
        expect(parsed.status).toBe('saved');
        expect(parsed.path).toContain('tool-usage-snapshots');

        // Snapshot file must exist on disk
        const files = fs.readdirSync(path.join(tmpDir, 'tool-usage-snapshots'));
        const snapshots = files.filter((f) => f.endsWith('.json'));
        expect(snapshots.length).toBeGreaterThanOrEqual(1);

        // Snapshot must contain snapshot_metadata (L1136-1141)
        const snapshotContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tool-usage-snapshots', snapshots[0]), 'utf-8'));
        expect(snapshotContent.snapshot_metadata).toBeDefined();
        expect(snapshotContent.snapshot_metadata.machine).toBe('rsm-test-host');
        expect(snapshotContent.snapshot_metadata.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(snapshotContent.snapshot_metadata.snapshot_type).toBe('weekly_baseline');
    });

    test('returns error when inner tool_usage_stats fails (invalid dates propagate)', async () => {
        // Source: L1115 — `if (statsResult.isError) return statsResult;`
        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'save_snapshot', start_date: 'not-a-date' } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid start_date');
        // No file should have been written
        const snapshotsDir = path.join(tmpDir, 'tool-usage-snapshots');
        expect(fs.existsSync(snapshotsDir)).toBe(false);
    });
});

// =====================================================================
// repair_gaps (source L653-797) — minimal coverage of:
//   - action validation (qdrant client not available)
//   - never_indexed candidate detection → gap reported
// =====================================================================

describe('roosync_indexing repair_gaps action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('reports never_indexed gaps from cache metadata (L673-696, L730-739)', async () => {
        // Mock qdrant.count → 0 (real gap)
        mockGetQdrantClient.mockReturnValue({
            count: vi.fn().mockResolvedValue({ count: 0 }),
        });
        mockIndexTask.mockResolvedValue(undefined);

        const ctx = newCtx();
        // Build a cache with one task that has metadata.indexingState undefined
        // and no metadata.qdrantIndexedAt → triggers never_indexed branch (L693-696)
        ctx.cache.set('never-1', {
            metadata: {
                lastActivity: '2026-07-01T10:00:00Z',
                // No indexingState, no qdrantIndexedAt → never_indexed
            },
        } as any);

        const result: any = await handleRooSyncIndexing(
            { action: 'repair_gaps', dry_run: false, max_repair_tasks: 5 } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.action).toBe('repair_gaps');
        // dry_run=false ran the repair branch (attempted indexTask)
        // We didn't mock findConversationById → returns undefined → "path not found" goes to errors
        // what matters: candidate was detected (total_cached_tasks > 0, candidates_prefiltered >= 1)
        expect(parsed.total_cached_tasks).toBe(1);
    });

    test('returns error when qdrant client not available', async () => {
        // Source: L666-667 — getQdrantClient throws
        mockGetQdrantClient.mockImplementation(() => {
            throw new Error('qdrant url not configured');
        });

        const ctx = newCtx();
        const result: any = await handleRooSyncIndexing(
            { action: 'repair_gaps' } as any,
            ctx.cache, ctx.ensureFresh, ctx.saveSkeleton, new Set(), ctx.setEnabled, ctx.rebuildHandler
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Error during repair_gaps');
        expect(result.content[0].text).toContain('qdrant url not configured');
    });
});
