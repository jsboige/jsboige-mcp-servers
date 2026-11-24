/**
 * #4910 — phase-B chunk_id preflight must not amplify a Qdrant outage.
 *
 * A failed `count` used to enable the whole retrieve loop, and every 5 s client
 * timeout started another request while the server kept the previous one. The
 * pre-fix loop is exercised here through the public `indexTask` API, with Qdrant
 * mocked: healthy dedup stays intact, but an outage gets at most ONE retrieve.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as crypto from 'crypto';

process.env.EMBEDDING_OPS_PER_MINUTE = '0';

const {
    mockGetCollections, mockCreatePayloadIndex, mockUpsert, mockCount,
    mockRetrieve, mockScroll, mockEmbeddingsCreate, mockExtractTask,
} = vi.hoisted(() => ({
    mockGetCollections: vi.fn(),
    mockCreatePayloadIndex: vi.fn(),
    mockUpsert: vi.fn(),
    mockCount: vi.fn(),
    mockRetrieve: vi.fn(),
    mockScroll: vi.fn(),
    mockEmbeddingsCreate: vi.fn(),
    mockExtractTask: vi.fn(),
}));

vi.mock('../../qdrant.js', () => ({
    getQdrantClient: vi.fn(() => ({
        getCollections: mockGetCollections,
        createPayloadIndex: mockCreatePayloadIndex,
        upsert: mockUpsert,
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
    validateVectorGlobal: vi.fn(),
    sanitizePayload: vi.fn((p: any) => p || {}),
}));

vi.mock('../ChunkExtractor.js', () => ({
    extractChunksFromTask: mockExtractTask,
    extractChunksFromClaudeSession: vi.fn(),
    splitChunk: vi.fn((chunk: any) => [chunk]),
    MAX_CHUNKS_PER_TASK: 50000,
    computeChunkId: vi.fn(),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
    networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

// This suite asserts preflight calls, not ledger persistence.
vi.mock('../IndexedHashLedger.js', () => ({
    loadIndexedHashLedger: async () => ({ present: new Set<string>(), absent: new Set<string>() }),
    appendIndexedHashes: async () => undefined,
    appendAbsentHashes: async () => undefined,
    clearIndexedHashLedgers: async () => undefined,
}));

const COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const DIM = 1536;

function hashOf(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function makeChunks(count: number): any[] {
    return Array.from({ length: count }, (_, i) => ({
        chunk_id: `outage-${i}`,
        content: `outage content ${i}`,
        indexed: true,
        task_id: 'outage-task',
        sequence_order: i,
        chunk_type: 'message_exchange',
        role: 'user',
        total_chunks: count,
        chunk_index: i,
    }));
}

async function freshModule() {
    vi.resetModules();
    const mod = await import('../VectorIndexer.js');
    mod.resetCircuitBreakerForTest();
    return mod;
}

describe('VectorIndexer — #4910 preflight outage amplification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        process.env.QDRANT_UPSERT_RECOVERY_MS = '0';
        mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
        mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
        mockUpsert.mockResolvedValue(undefined);
        mockScroll.mockResolvedValue({ points: [], next_page_offset: null });
        mockCount.mockResolvedValue({ count: 100 });
        mockRetrieve.mockResolvedValue([]);
        mockEmbeddingsCreate.mockImplementation((req: any) => Promise.resolve({
            data: Array.from({ length: Array.isArray(req.input) ? req.input.length : 1 },
                () => ({ embedding: new Array(DIM).fill(0.1) })),
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.QDRANT_UPSERT_RECOVERY_MS;
        vi.restoreAllMocks();
    });

    test('count rejects: retrieve is not called and the task is still indexed', async () => {
        const { indexTask } = await freshModule();
        mockCount.mockRejectedValue(new Error('count: Operation timed out'));
        mockExtractTask.mockResolvedValue(makeChunks(1));

        const result = await indexTask('outage-count', '/nowhere');

        expect(mockRetrieve).not.toHaveBeenCalled();
        expect(result).toHaveLength(1);
    });

    // Real clock: the 5 s race is the behaviour under test. On the pre-fix loop this
    // test takes ~50 s (10 batches × 5 s) and observes 10 retrieves.
    test('first retrieve beyond 5 s, for 10 batches: retrieve is called exactly once', async () => {
        const { indexTask } = await freshModule();
        const chunks = makeChunks(1000);
        mockExtractTask.mockResolvedValue(chunks);
        mockRetrieve.mockImplementation(() => new Promise(() => {})); // server never answers

        const result = await indexTask('outage-timeout', '/nowhere');

        expect(mockRetrieve).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1000); // remaining batches stay "unknown" → indexed
    }, 70_000);

    test('healthy server: all 10 batches are retrieved and dedup is applied', async () => {
        const { indexTask } = await freshModule();
        const chunks = makeChunks(1000);
        mockExtractTask.mockResolvedValue(chunks);
        mockRetrieve.mockImplementation(async (_collection: string, req: any) => {
            const first = chunks.find(c => c.chunk_id === req.ids[0]);
            return first ? [{ id: first.chunk_id, payload: { contentHash: hashOf(first.content) } }] : [];
        });

        const result = await indexTask('outage-healthy', '/nowhere');

        expect(mockRetrieve).toHaveBeenCalledTimes(10);
        expect(result).toHaveLength(990); // one unchanged chunk skipped per batch
    });
});
