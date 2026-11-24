/**
 * #4902 — indexTask caches collection setup once per process; reset and 404 invalidate it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

process.env.EMBEDDING_OPS_PER_MINUTE = '0';

const {
    mockGetCollections, mockCreateCollection, mockCreatePayloadIndex,
    mockUpsert, mockDeleteCollection, mockCount, mockRetrieve, mockScroll,
    mockEmbeddingsCreate, mockExtractTask, mockValidateVector,
} = vi.hoisted(() => ({
    mockGetCollections: vi.fn(),
    mockCreateCollection: vi.fn(),
    mockCreatePayloadIndex: vi.fn(),
    mockUpsert: vi.fn(),
    mockDeleteCollection: vi.fn(),
    mockCount: vi.fn(),
    mockRetrieve: vi.fn(),
    mockScroll: vi.fn(),
    mockEmbeddingsCreate: vi.fn(),
    mockExtractTask: vi.fn(),
    mockValidateVector: vi.fn(),
}));

vi.mock('../../qdrant.js', () => ({
    getQdrantClient: vi.fn(() => ({
        getCollections: mockGetCollections,
        createCollection: mockCreateCollection,
        createPayloadIndex: mockCreatePayloadIndex,
        upsert: mockUpsert,
        deleteCollection: mockDeleteCollection,
        count: mockCount,
        retrieve: mockRetrieve,
        scroll: mockScroll,
    })),
}));

vi.mock('../../openai.js', () => ({
    default: vi.fn(() => ({ embeddings: { create: mockEmbeddingsCreate } })),
    getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
    getEmbeddingDimensions: vi.fn(() => 1536),
}));

vi.mock('../EmbeddingValidator.js', () => ({
    validateVectorGlobal: mockValidateVector,
    sanitizePayload: vi.fn((p: any) => p || {}),
}));

vi.mock('../ChunkExtractor.js', () => ({
    extractChunksFromTask: mockExtractTask,
    extractChunksFromClaudeSession: vi.fn(),
    splitChunk: vi.fn((chunk: any) => [chunk]),
    MAX_CHUNKS_PER_TASK: 50000,
    computeChunkId: vi.fn(() => 'cache-regression-chunk'),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
    networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

const COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
let ledgerTmpDir: string;

function chunk(taskId: string): any {
    return {
        chunk_id: `${taskId}-chunk`,
        content: `${taskId} collection setup regression content`,
        indexed: true,
        task_id: taskId,
        sequence_order: 1,
        chunk_type: 'message_exchange',
        role: 'user',
        total_chunks: 1,
        chunk_index: 1,
    };
}

function notFound(): Error {
    return Object.assign(new Error('Unexpected Response: 404 (Not Found)'), { status: 404 });
}

async function freshModule() {
    vi.resetModules();
    mockEmbeddingsCreate.mockImplementation((req: any) => Promise.resolve({
        data: Array.from({ length: Array.isArray(req.input) ? req.input.length : 1 },
            () => ({ embedding: new Array(1536).fill(0.1) })),
    }));
    const mod = await import('../VectorIndexer.js');
    mod.resetCircuitBreakerForTest();
    return mod;
}

describe('VectorIndexer — #4902 collection setup cache', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        process.env.QDRANT_UPSERT_RECOVERY_MS = '0';
        ledgerTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rsm-4902-'));
        process.env.INDEX_HASH_LEDGER_DIR = ledgerTmpDir;
        mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
        mockCreateCollection.mockResolvedValue(undefined);
        mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
        mockUpsert.mockResolvedValue(undefined);
        mockDeleteCollection.mockResolvedValue(undefined);
        mockCount.mockResolvedValue({ count: 0 });
        mockRetrieve.mockResolvedValue([]);
        mockScroll.mockResolvedValue({ points: [], next_page_offset: null });
        mockExtractTask.mockResolvedValue([]);
        mockValidateVector.mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.doUnmock('../IndexedHashLedger.js');
        vi.restoreAllMocks();
        delete process.env.INDEX_HASH_LEDGER_DIR;
        delete process.env.QDRANT_UPSERT_RECOVERY_MS;
        if (ledgerTmpDir) await fsp.rm(ledgerTmpDir, { recursive: true, force: true });
    });

    test('two indexTask calls share one getCollections and 11 createPayloadIndex calls', async () => {
        const { indexTask } = await freshModule();

        await Promise.all([indexTask('cache-a', '/nowhere'), indexTask('cache-b', '/nowhere')]);

        expect(mockGetCollections).toHaveBeenCalledTimes(1);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(11);
    });

    test('resetCollection invalidates the cache and a scroll 404 makes the next task re-verify', async () => {
        const { indexTask, resetCollection, resetCircuitBreakerForTest } = await freshModule();
        await indexTask('cache-reset', '/nowhere');
        expect(mockGetCollections).toHaveBeenCalledTimes(1);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(11);

        await resetCollection();
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(22);

        await indexTask('cache-reset', '/nowhere');
        expect(mockGetCollections).toHaveBeenCalledTimes(2);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(33);

        mockExtractTask.mockResolvedValue([chunk('cache-404')]);
        mockScroll.mockRejectedValueOnce(notFound());
        await expect(indexTask('cache-404', '/nowhere'))
            .rejects.toMatchObject({ details: { scrollFailed: true } });

        resetCircuitBreakerForTest();
        mockGetCollections.mockResolvedValue({ collections: [] });
        mockExtractTask.mockResolvedValue([]);
        await indexTask('cache-after-404', '/nowhere');
        expect(mockGetCollections).toHaveBeenCalledTimes(3);
        expect(mockCreateCollection).toHaveBeenCalledTimes(2);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(44);
    });

    test('an upsert 404 makes the next task re-verify and recreate the collection', async () => {
        // #4861 v1.2 (ms#1898) made the B2 preflight WRITE its absent lines to the
        // ledger after the scroll. A real file write does not complete within the
        // event-loop turns runAllTimersAsync() drains, so under fake timers the upsert
        // retry is scheduled after the drain and the test hangs (15 s timeout, measured
        // on main 554cbe29; green on 3b2c719f before ms#1898). Same remedy as the
        // fake-timer block of VectorIndexer.coverage.test.ts: stub the ledger for this
        // test only — this suite asserts collection setup, not ledger contents.
        vi.doMock('../IndexedHashLedger.js', () => ({
            loadIndexedHashLedger: async () => ({ present: new Set<string>(), absent: new Set<string>() }),
            appendIndexedHashes: async () => undefined,
            appendAbsentHashes: async () => undefined,
            clearIndexedHashLedgers: async () => undefined,
        }));
        vi.useFakeTimers();
        const { indexTask, resetCircuitBreakerForTest } = await freshModule();
        await indexTask('cache-upsert', '/nowhere');
        expect(mockGetCollections).toHaveBeenCalledTimes(1);

        mockExtractTask.mockResolvedValue([chunk('cache-upsert')]);
        mockUpsert.mockRejectedValue(notFound());
        const attempt = expect(indexTask('cache-upsert', '/nowhere')).rejects.toThrow();
        await vi.runAllTimersAsync();
        await attempt;
        expect(mockUpsert).toHaveBeenCalledTimes(3);

        resetCircuitBreakerForTest();
        mockGetCollections.mockResolvedValue({ collections: [] });
        mockExtractTask.mockResolvedValue([]);
        await indexTask('cache-after-upsert-404', '/nowhere');
        expect(mockGetCollections).toHaveBeenCalledTimes(2);
        expect(mockCreateCollection).toHaveBeenCalledTimes(1);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(22);
    });

    test('a failed collection check is not cached', async () => {
        const { indexTask } = await freshModule();
        mockGetCollections.mockRejectedValueOnce(new Error('temporary connection failure'));

        await expect(indexTask('cache-retry', '/nowhere')).rejects.toThrow('temporary connection failure');
        await indexTask('cache-retry', '/nowhere');

        expect(mockGetCollections).toHaveBeenCalledTimes(2);
        expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(11);
    });
});
