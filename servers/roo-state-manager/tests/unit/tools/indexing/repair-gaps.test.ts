/**
 * Tests for roosync_indexing action=repair_gaps (#2246)
 *
 * Covers:
 * - indexed_success_but_zero_points gap detection
 * - lastActivity > lastIndexedAt + 60s gap detection (event-driven stale check)
 * - never_indexed task detection
 * - up-to-date tasks are not flagged
 * - repair execution when dry_run=false
 * - Qdrant error handling
 * - max_repair_tasks limit
 */

import { handleRooSyncIndexing } from '../../../../src/tools/indexing/roosync-indexing.tool.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

const {
    mockCount,
    mockIndexTask,
    mockFindConversationById,
    mockResetIndexingState,
    mockMarkIndexingSuccess,
} = vi.hoisted(() => ({
    mockCount: vi.fn(),
    mockIndexTask: vi.fn(),
    mockFindConversationById: vi.fn(),
    mockResetIndexingState: vi.fn(),
    mockMarkIndexingSuccess: vi.fn(),
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
    getQdrantClient: vi.fn(() => ({
        count: mockCount,
    })),
}));

vi.mock('../../../../src/services/indexing-decision.js', () => ({
    IndexingDecisionService: class {
        resetIndexingState = mockResetIndexingState;
        markIndexingSuccess = mockMarkIndexingSuccess;
    },
}));

vi.mock('../../../../src/services/task-indexer.js', () => ({
    indexTask: mockIndexTask,
    getHostIdentifier: vi.fn(() => 'test-host'),
    TaskIndexer: class {},
}));

vi.mock('../../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        findConversationById: mockFindConversationById,
    },
}));

function makeCache(
    tasks: Record<string, Partial<NonNullable<ConversationSkeleton['metadata']>>>
): Map<string, ConversationSkeleton> {
    const cache = new Map<string, ConversationSkeleton>();
    for (const [taskId, meta] of Object.entries(tasks)) {
        cache.set(taskId, {
            taskId,
            metadata: {
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 5,
                actionCount: 2,
                totalSize: 512,
                ...(meta as any),
            },
            sequence: [],
        } as ConversationSkeleton);
    }
    return cache;
}

const noopArgs = {
    ensureCacheFresh: vi.fn().mockResolvedValue(true),
    saveSkeleton: vi.fn().mockResolvedValue(undefined),
    qdrantIndexQueue: new Set<string>(),
    setQdrantIndexingEnabled: vi.fn(),
    rebuildHandler: vi.fn(),
};

async function callRepairGaps(
    cache: Map<string, ConversationSkeleton>,
    extra: Record<string, unknown> = {}
) {
    return handleRooSyncIndexing(
        { action: 'repair_gaps', ...extra },
        cache,
        noopArgs.ensureCacheFresh,
        noopArgs.saveSkeleton,
        noopArgs.qdrantIndexQueue,
        noopArgs.setQdrantIndexingEnabled,
        noopArgs.rebuildHandler
    );
}

describe('repair_gaps action (#2246)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIndexTask.mockResolvedValue([{ id: 'point-1' }]);
        mockFindConversationById.mockResolvedValue({ path: '/fake/path/task' });
    });

    describe('gap detection (dry_run=true by default)', () => {
        it('flags indexed_success_but_zero_points when Qdrant has 0 points', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            const cache = makeCache({
                'task-zero': {
                    indexingState: {
                        indexStatus: 'success',
                        lastIndexedAt: new Date().toISOString(),
                    },
                },
            });

            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(1);
            expect(data.gap_details[0].reason).toBe('indexed_success_but_zero_points');
            expect(data.gap_details[0].points_in_qdrant).toBe(0);
            expect(mockIndexTask).not.toHaveBeenCalled();
        });

        it('flags stale task when lastActivity > lastIndexedAt + 60s', async () => {
            mockCount.mockResolvedValue({ count: 10 });
            const now = Date.now();
            const cache = makeCache({
                'task-stale': {
                    lastActivity: new Date(now).toISOString(),
                    indexingState: {
                        indexStatus: 'success',
                        // Indexed 2 minutes ago, activity is now → stale (>60s threshold)
                        lastIndexedAt: new Date(now - 120_000).toISOString(),
                    },
                },
            });

            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(1);
            expect(data.gap_details[0].reason).toContain('lastActivity > lastIndexedAt');
            expect(mockIndexTask).not.toHaveBeenCalled();
        });

        it('flags never_indexed task with no indexingState and no qdrantIndexedAt', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            const cache = makeCache({
                'task-new': {
                    // No indexingState, no qdrantIndexedAt
                },
            });

            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(1);
            expect(data.gap_details[0].reason).toBe('never_indexed');
        });

        it('does not flag up-to-date task (lastActivity <= lastIndexedAt)', async () => {
            mockCount.mockResolvedValue({ count: 10 });
            const now = Date.now();
            const cache = makeCache({
                'task-ok': {
                    // Activity 2 minutes ago, indexed just now → not stale
                    lastActivity: new Date(now - 120_000).toISOString(),
                    indexingState: {
                        indexStatus: 'success',
                        lastIndexedAt: new Date(now).toISOString(),
                    },
                },
            });

            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(0);
            expect(mockIndexTask).not.toHaveBeenCalled();
        });

        it('does not flag task within the 60s grace window', async () => {
            mockCount.mockResolvedValue({ count: 5 });
            const now = Date.now();
            const cache = makeCache({
                'task-grace': {
                    // Activity 30s ago, indexed 1min ago → within 60s threshold, not stale
                    lastActivity: new Date(now - 30_000).toISOString(),
                    indexingState: {
                        indexStatus: 'success',
                        lastIndexedAt: new Date(now - 90_000).toISOString(),
                    },
                },
            });

            // activityTime(now-30s) > indexedTime(now-90s) + 60s(now-30s) === equal → not stale
            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(0);
        });
    });

    describe('repair execution (dry_run=false)', () => {
        it('calls indexTask and marks success for each gap', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            const cache = makeCache({
                'task-gap': {
                    indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() },
                },
            });

            const result = await callRepairGaps(cache, { dry_run: false });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.gaps_detected).toBe(1);
            expect(data.repaired).toBe(1);
            expect(mockIndexTask).toHaveBeenCalledWith('task-gap', '/fake/path/task', 'roo');
            expect(mockMarkIndexingSuccess).toHaveBeenCalled();
        });

        it('reports error when conversation path not found', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            mockFindConversationById.mockResolvedValue(null); // path not found
            const cache = makeCache({
                'task-nopath': {
                    indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() },
                },
            });

            const result = await callRepairGaps(cache, { dry_run: false });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.repaired).toBe(0);
            expect(data.errors).toContain('task-nopath: path not found');
            expect(mockIndexTask).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('handles Qdrant count errors gracefully', async () => {
            mockCount.mockRejectedValue(new Error('Qdrant connection refused'));
            const cache = makeCache({ 'task-err': {} });

            const result = await callRepairGaps(cache);
            const data = JSON.parse((result.content[0] as any).text);

            expect(result.isError).toBeFalsy();
            expect(data.errors).toBeDefined();
            expect(data.errors[0]).toContain('task-err');
        });
    });

    describe('max_repair_tasks limit', () => {
        it('stops scanning after max_repair_tasks gaps', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            // 3 tasks all with indexed_success_but_zero_points
            const cache = makeCache({
                'task-a': { indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() } },
                'task-b': { indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() } },
                'task-c': { indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() } },
            });

            const result = await callRepairGaps(cache, { max_repair_tasks: 2 });
            const data = JSON.parse((result.content[0] as any).text);

            // Only 2 tasks scanned (map iteration stops when gaps.length >= maxTasks)
            expect(data.gaps_detected).toBeLessThanOrEqual(2);
            expect(data.scanned_up_to).toBeLessThanOrEqual(2);
        });
    });

    describe('summary output', () => {
        it('returns dry_run mode in summary', async () => {
            mockCount.mockResolvedValue({ count: 5 });
            const result = await callRepairGaps(new Map());
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.mode).toBe('dry_run');
            expect(data.summary).toContain('[DRY RUN]');
        });

        it('returns executed mode in summary when dry_run=false', async () => {
            mockCount.mockResolvedValue({ count: 0 });
            const cache = makeCache({
                'task-fix': { indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() } },
            });

            const result = await callRepairGaps(cache, { dry_run: false });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.mode).toBe('executed');
            expect(data.summary).toContain('[EXECUTED]');
        });
    });
});
