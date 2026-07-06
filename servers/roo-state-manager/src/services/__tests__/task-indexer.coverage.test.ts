/**
 * Coverage tests for TaskIndexer façade delegation methods (task-indexer.ts).
 *
 * Issue #833 (C3 → Vein B coverage). The global jest.setup.js stubs the whole
 * task-indexer.js module with a MockTaskIndexer (L349), so the REAL class methods
 * that simply delegate to the VectorIndexer / QdrantHealthMonitor modules are never
 * exercised — ~30.76% function coverage per po-2023 c.3 gap-data run, confirmed
 * firsthand po-2024 c.5 (scoped run = full-run numbers exactly).
 *
 * This suite opts out of the stub (vi.unmock, file-level wins over setup-level —
 * same seam as task-indexer.claude-branches.test.ts) and mocks the delegation
 * targets so every wrapper executes and its pass-through wiring is asserted.
 *
 * Uncovered functions targeted (firsthand scoped run):
 *   checkCollectionHealth (L55), upsertPointsBatch (L70), startHealthCheck (L84),
 *   stopHealthCheck (L91), updateSkeletonIndexTimestamp (L172), resetCollection (L179),
 *   getCollectionStatus (L186), countPointsByHostOs (L193), cleanupOldVectors (L200).
 *   Plus the Roo standard-success branch of indexTask (L145/148/150).
 *
 * Isolation: VectorIndexer, QdrantHealthMonitor, RooStorageDetector all mocked →
 * no real Qdrant / embedding / global storage touched. Task dirs live in an OS
 * temp dir → CI-safe (no APPDATA/GDrive/PS).
 *
 * @module services/__tests__/task-indexer.coverage
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Opt out of the global setup stub (jest.setup.js L349) so we exercise the REAL
// TaskIndexer class. File-level vi.unmock wins over setup-level vi.mock.
vi.unmock('../task-indexer.js');

// Intercept the VectorIndexer seam — delegation target for reset/count/cleanup/
// updateSkeleton/upsert/indexTask. All named exports task-indexer.ts imports are
// provided. Return values are wired in beforeEach (NOT in the factory) because
// vi.clearAllMocks() resets mockResolvedValue in vitest 3.2.4 — same pattern as
// task-indexer.claude-branches.test.ts (indexTaskVector mockResolvedValue in beforeEach).
vi.mock('../task-indexer/VectorIndexer.js', () => ({
    indexTask: vi.fn(),
    resetCollection: vi.fn(),
    countPointsByHostOs: vi.fn(),
    cleanupOldVectors: vi.fn(),
    updateSkeletonIndexTimestamp: vi.fn(),
    upsertPointsBatch: vi.fn(),
    qdrantRateLimiter: {},
}));

// Intercept the QdrantHealthMonitor seam — the constructor does
// `new QdrantHealthMonitor()` (task-indexer.ts L43) and the health wrappers delegate
// to the resulting instance. Methods are attached to the constructor PROTOTYPE so
// every `new` yields an object whose methods resolve to the shared vi.fn refs via
// the prototype chain (bulletproof across class-field transform settings). Expose
// the refs via __mocks for call assertions.
vi.mock('../task-indexer/QdrantHealthMonitor.js', () => {
    const checkCollectionHealth = vi.fn();
    const startHealthCheck = vi.fn();
    const stopHealthCheck = vi.fn();
    const getCollectionStatus = vi.fn();
    function MockQdrantHealthMonitor() {}
    MockQdrantHealthMonitor.prototype.checkCollectionHealth = checkCollectionHealth;
    MockQdrantHealthMonitor.prototype.startHealthCheck = startHealthCheck;
    MockQdrantHealthMonitor.prototype.stopHealthCheck = stopHealthCheck;
    MockQdrantHealthMonitor.prototype.getCollectionStatus = getCollectionStatus;
    // Return values wired in beforeEach (clearAllMocks resets mockResolvedValue).
    return {
        QdrantHealthMonitor: MockQdrantHealthMonitor,
        logNetworkMetrics: vi.fn(),
        __mocks: { checkCollectionHealth, startHealthCheck, stopHealthCheck, getCollectionStatus },
    };
});

// Mock the Roo storage detector to control the Roo branch of indexTask (L137-154).
// NOTE: from src/services/__tests__/, src/utils/ is two levels up (../../utils/), not one.
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
    },
}));

import { TaskIndexer } from '../task-indexer.js';
import {
    resetCollection as resetCollectionVector,
    countPointsByHostOs as countPointsByHostOsVector,
    cleanupOldVectors as cleanupOldVectorsVector,
    updateSkeletonIndexTimestamp as updateSkeletonIndexTimestampVector,
    upsertPointsBatch as upsertPointsBatchVector,
    indexTask as indexTaskVector,
} from '../task-indexer/VectorIndexer.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
// Side-channel handle the mock factory exposes. Named import from the mocked module
// resolves to the factory's __mocks (vi.mock replaces the module).
import { __mocks as healthMonitor } from '../task-indexer/QdrantHealthMonitor.js';

const FAKE_POINTS = [{ id: 'p1', vector: [0.1], payload: {} }] as any;

describe('TaskIndexer façade — delegation wrappers (coverage #833)', () => {
    let indexer: TaskIndexer;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Re-wire return values AFTER clearAllMocks (it resets mockResolvedValue in
        // vitest 3.2.4). Bare delegation targets resolve to undefined / void by default.
        vi.mocked(countPointsByHostOsVector).mockResolvedValue(42);
        vi.mocked(cleanupOldVectorsVector).mockResolvedValue({ deletedCount: 5, cutoffDate: '2026-04-07T00:00:00.000Z' });
        healthMonitor.checkCollectionHealth.mockResolvedValue({
            status: 'green',
            points_count: 10,
            segments_count: 2,
            indexed_vectors_count: 10,
            optimizer_status: 'ok',
        });
        healthMonitor.getCollectionStatus.mockResolvedValue({ exists: true, count: 42 });
        indexer = new TaskIndexer();
    });

    afterEach(() => {
        errSpy.mockRestore();
    });

    test('resetCollection delegates to VectorIndexer.resetCollection (L179-181)', async () => {
        await indexer.resetCollection();
        expect(resetCollectionVector).toHaveBeenCalledTimes(1);
        expect(resetCollectionVector).toHaveBeenCalledWith();
    });

    test('countPointsByHostOs forwards the hostOs argument (L193-195)', async () => {
        const count = await indexer.countPointsByHostOs('win32-host');
        expect(count).toBe(42);
        expect(countPointsByHostOsVector).toHaveBeenCalledWith('win32-host');
    });

    test('cleanupOldVectors forwards defaults (90, false, undefined) (L200-206)', async () => {
        const result = await indexer.cleanupOldVectors();
        expect(result.deletedCount).toBe(5);
        expect(cleanupOldVectorsVector).toHaveBeenCalledWith(90, false, undefined);
    });

    test('cleanupOldVectors forwards explicit args (L200-206)', async () => {
        await indexer.cleanupOldVectors(30, true, 'ws-abc');
        expect(cleanupOldVectorsVector).toHaveBeenCalledWith(30, true, 'ws-abc');
    });

    test('updateSkeletonIndexTimestamp forwards (taskId, storageLocation) (L172-174)', async () => {
        await indexer.updateSkeletonIndexTimestamp('task-1', '/storage');
        expect(updateSkeletonIndexTimestampVector).toHaveBeenCalledWith('task-1', '/storage');
    });

    test('getCollectionStatus delegates to healthMonitor (L186-188)', async () => {
        const status = await indexer.getCollectionStatus();
        expect(status).toEqual({ exists: true, count: 42 });
        expect(healthMonitor.getCollectionStatus).toHaveBeenCalledTimes(1);
    });

    test('startHealthCheck delegates to healthMonitor (L84-86)', () => {
        indexer.startHealthCheck();
        expect(healthMonitor.startHealthCheck).toHaveBeenCalledTimes(1);
    });

    test('stopHealthCheck delegates to healthMonitor (L91-93)', () => {
        indexer.stopHealthCheck();
        expect(healthMonitor.stopHealthCheck).toHaveBeenCalledTimes(1);
    });

    test('checkCollectionHealth (private) delegates to healthMonitor (L55-63)', async () => {
        // TypeScript `private` is erased at runtime — the wrapper is reachable directly.
        const status = await (indexer as any).checkCollectionHealth();
        expect(status).toEqual({
            status: 'green',
            points_count: 10,
            segments_count: 2,
            indexed_vectors_count: 10,
            optimizer_status: 'ok',
        });
        expect(healthMonitor.checkCollectionHealth).toHaveBeenCalledTimes(1);
    });

    test('upsertPointsBatch (private) forwards (points, options) (L70-79)', async () => {
        const points = [{ id: 'p1', vector: [0.1], payload: {} }];
        const opts = { batchSize: 16, waitOnLast: true, maxRetries: 3 };
        await (indexer as any).upsertPointsBatch(points, opts);
        expect(upsertPointsBatchVector).toHaveBeenCalledWith(points, opts);
    });

    test('upsertPointsBatch (private) tolerates absent options (L70-79)', async () => {
        const points = [{ id: 'p1', vector: [0.1], payload: {} }];
        await (indexer as any).upsertPointsBatch(points);
        expect(upsertPointsBatchVector).toHaveBeenCalledWith(points, undefined);
    });
});

describe('TaskIndexer.indexTask — Roo standard path resolution (coverage L141-161)', () => {
    let indexer: TaskIndexer;
    let tmpDir: string;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(indexTaskVector).mockResolvedValue(FAKE_POINTS);
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-roo-'));
        indexer = new TaskIndexer();
    });

    afterEach(async () => {
        errSpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('Roo task found in a location → indexes task dir + updates skeleton timestamp (L145/148/150)', async () => {
        // task-indexer.ts L142: taskPath = path.join(location, 'tasks', taskId).
        const taskDir = path.join(tmpDir, 'tasks', 'roo-task-1');
        await fs.mkdir(taskDir, { recursive: true });
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([tmpDir]);

        const points = await indexer.indexTask('roo-task-1', 'roo');

        expect(points).toBe(FAKE_POINTS);
        // L145: delegates with the resolved task dir, source preserved, no metadata.
        expect(indexTaskVector).toHaveBeenCalledWith('roo-task-1', taskDir, 'roo', undefined);
        // L148: skeleton timestamp updated with (taskId, location) AFTER indexing.
        expect(updateSkeletonIndexTimestampVector).toHaveBeenCalledWith('roo-task-1', tmpDir);
    });

    test('Roo task absent from all locations → throws TASK_NOT_FOUND (L156-161)', async () => {
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([tmpDir]);
        await expect(indexer.indexTask('missing-task', 'roo')).rejects.toThrow(/not found/i);
        expect(indexTaskVector).not.toHaveBeenCalled();
    });
});
