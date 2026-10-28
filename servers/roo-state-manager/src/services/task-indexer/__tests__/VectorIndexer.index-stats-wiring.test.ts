/**
 * #4352 crit.4 — the counters a live `--index` answer reports are WIRED, not decorative.
 *
 * `describeIndexOutcome` (unit-tested in VectorIndexer.index-stats.test.ts) can only
 * be as honest as the numbers it receives. A reason string built from a stats object
 * that no code fills would be worse than the bare `0` it replaced: it would name a
 * cause nobody measured. These tests drive the real `indexTask` and read the caller's
 * object back, so an unwired `stats.dedupSkipped += …` (or a missing extraction
 * count) turns them red.
 *
 * The harness mirrors VectorIndexer.dedup-scope.test.ts (same pacer pin, same
 * in-memory store, filter-aware scroll) — no real Qdrant, no real embeddings.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';

process.env.EMBEDDING_OPS_PER_MINUTE = '0';

const {
	mockGetCollections, mockCreateCollection, mockCreatePayloadIndex,
	mockUpsert, mockCount, mockRetrieve, mockScroll,
} = vi.hoisted(() => ({
	mockGetCollections: vi.fn(),
	mockCreateCollection: vi.fn(),
	mockCreatePayloadIndex: vi.fn(),
	mockUpsert: vi.fn(),
	mockCount: vi.fn(),
	mockRetrieve: vi.fn(),
	mockScroll: vi.fn(),
}));
const { mockEmbeddingsCreate } = vi.hoisted(() => ({ mockEmbeddingsCreate: vi.fn() }));
const { mockExtractTask, mockSplitChunk } = vi.hoisted(() => ({
	mockExtractTask: vi.fn(),
	mockSplitChunk: vi.fn(),
}));
const { mockValidateVector, mockSanitizePayload } = vi.hoisted(() => ({
	mockValidateVector: vi.fn(),
	mockSanitizePayload: vi.fn((p: any) => p || {}),
}));

vi.mock('../../qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		getCollections: mockGetCollections,
		createCollection: mockCreateCollection,
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
	getEmbeddingDimensions: vi.fn(() => 4),
}));

vi.mock('../EmbeddingValidator.js', () => ({
	validateVectorGlobal: mockValidateVector,
	sanitizePayload: mockSanitizePayload,
}));

vi.mock('../ChunkExtractor.js', () => ({
	extractChunksFromTask: mockExtractTask,
	extractChunksFromClaudeSession: vi.fn(),
	splitChunk: mockSplitChunk,
	MAX_CHUNKS_PER_TASK: 50000,
	computeChunkId: vi.fn(() => 'mock-deterministic-uuid'),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
	networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

const COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

function hashOf(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function chunks(): any[] {
	return [
		{ chunk_id: 't1-c1', content: 'head preamble', indexed: true, task_id: 't1', sequence_order: 0, chunk_type: 'message_exchange', role: 'system', total_chunks: 3, chunk_index: 1 },
		{ chunk_id: 't1-c2', content: 'user asks a question', indexed: true, task_id: 't1', sequence_order: 1, chunk_type: 'message_exchange', role: 'user', total_chunks: 3, chunk_index: 2 },
		{ chunk_id: 't1-c3', content: 'assistant answers it', indexed: true, task_id: 't1', sequence_order: 2, chunk_type: 'message_exchange', role: 'assistant', total_chunks: 3, chunk_index: 3 },
	];
}

function freshStats() {
	return { chunksExtracted: 0, subChunksBuilt: 0, dedupSkipped: 0, pointsIndexed: 0, missingVectors: 0 };
}

describe('indexTask — the reported counters describe the run (#4352 crit.4)', () => {
	let store: Map<string, { id: string; vector: number[]; payload: any }>;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new Map();

		mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
		mockCreateCollection.mockResolvedValue(undefined);
		mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
		mockValidateVector.mockImplementation(() => {});
		mockSanitizePayload.mockImplementation((p: any) => p || {});
		mockSplitChunk.mockImplementation((c: any) => [c]);
		mockExtractTask.mockReset().mockResolvedValue([]);

		mockEmbeddingsCreate.mockReset().mockImplementation(({ input }: any) => {
			const arr = Array.isArray(input) ? input : [input];
			return Promise.resolve({
				data: arr.map((_: any, i: number) => ({ embedding: [i, 1, 0, 0] })),
				model: 'text-embedding-3-small',
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		});

		mockCount.mockImplementation(async () => ({ count: store.size }));
		mockRetrieve.mockImplementation(async (_c: string, { ids }: any) =>
			ids
				.filter((id: string) => store.has(id))
				.map((id: string) => ({ id, payload: store.get(id)!.payload })),
		);
		mockScroll.mockImplementation(async (_c: string, params: any) => {
			const hashes: string[] = (params.filter?.should ?? []).map((c: any) => c.match?.value);
			const mustTask: string | undefined = params.filter?.must?.[0]?.match?.value;
			const matches = [...store.values()].filter(p => {
				if (!hashes.includes(p.payload?.contentHash)) return false;
				return mustTask === undefined ? true : p.payload?.task_id === mustTask;
			});
			return {
				points: matches.map(p => ({ id: p.id, payload: { contentHash: p.payload.contentHash } })),
				next_page_offset: null,
			};
		});
		mockUpsert.mockImplementation(async (_c: string, { points }: any) => {
			for (const p of points) store.set(p.id, { id: p.id, vector: p.vector, payload: p.payload });
		});
	});

	test('a real pass reports extracted / built / indexed, and zero dedup', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();
		mockExtractTask.mockResolvedValue(chunks());

		const stats = freshStats();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let points: any[];
		try {
			points = await indexTask('t1', '/p', 'roo', undefined, { stats });
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore();
		}

		expect(points!.length).toBe(3);
		expect(stats.chunksExtracted).toBe(3);
		expect(stats.subChunksBuilt).toBe(3);
		expect(stats.dedupSkipped).toBe(0);
		expect(stats.pointsIndexed).toBe(3);
		expect(stats.missingVectors).toBe(0);
	});

	test('a re-pass over an already-indexed task reports the dedup, not a bare zero', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();
		const cs = chunks();
		mockExtractTask.mockResolvedValue(cs);
		// The ai-01 28/10 situation: every sub-chunk is already in Qdrant for this task.
		for (const c of cs) {
			store.set(c.chunk_id, { id: c.chunk_id, vector: [0, 0, 0, 0], payload: { task_id: 't1', contentHash: hashOf(c.content) } });
		}

		const stats = freshStats();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let points: any[];
		try {
			points = await indexTask('t1', '/p', 'roo', undefined, { stats });
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore();
		}

		expect(points!.length).toBe(0);
		expect(stats.chunksExtracted).toBe(3);
		expect(stats.subChunksBuilt).toBe(3);
		// The whole point: the caller can now SAY it was a dedup, and how much.
		expect(stats.dedupSkipped).toBe(3);
		expect(stats.pointsIndexed).toBe(0);
	});

	test('an empty session reports chunksExtracted=0 — the third case, not a dedup', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();
		mockExtractTask.mockResolvedValue([]);

		const stats = freshStats();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let points: any[];
		try {
			points = await indexTask('t1', '/p', 'roo', undefined, { stats });
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore();
		}

		expect(points!.length).toBe(0);
		expect(stats.chunksExtracted).toBe(0);
		expect(stats.dedupSkipped).toBe(0);
		expect(stats.pointsIndexed).toBe(0);
	});

	test('a reused stats object is reset per attempt — no stale counters', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();
		mockExtractTask.mockResolvedValue(chunks());

		const stats = { chunksExtracted: 99, subChunksBuilt: 99, dedupSkipped: 99, pointsIndexed: 99, missingVectors: 99 };
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await indexTask('t1', '/p', 'roo', undefined, { stats });
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore();
		}

		expect(stats.chunksExtracted).toBe(3);   // red if the object is not reset first
		expect(stats.pointsIndexed).toBe(3);
		// `dedupSkipped` is the one counter that is only ever added to (`+=`) and is
		// NOT reassigned by a clean pass: it is the field that actually proves the
		// reset. Seeded at 99 with no dedup in this run ⇒ 0 only if reset happened.
		expect(stats.dedupSkipped).toBe(0);
	});
});
