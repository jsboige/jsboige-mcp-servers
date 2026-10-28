/**
 * #4352 g7 — the content-hash dedup is scoped to the task.
 *
 * The scroll behind both dedup passes (#1985 post-index, #2369 preflight)
 * filtered on contentHash ALONE — a GLOBAL predicate. Any point in the
 * collection carrying the same hash suppressed this task's own point, and
 * head content (system preambles, role definitions) is the most duplicated
 * content across sessions. po-2027's detector (#4405) measured the result on
 * 28/10: 172,324 head pages missing over 16,498 groups, and a re-filed task
 * reproduced the same bounds pass after pass — the skip decision is stable in
 * the content, so a re-pass could never complete the hole. That is why
 * "un repassage complète les chunks absents" was impossible regardless of how
 * many times the task was re-queued.
 *
 * The scroll now carries `must: task_id == <the sub-chunk's own task_id>`.
 * Cross-task duplicate content is written under its own chunk_id (each task's
 * timeline keeps its head); same-task duplicates — the resumes #1985 was
 * written for, and the re-split chunks #2369 was written for — still dedup.
 *
 * END STATE predicate, mirroring the detector: a task's head is intact
 * ⟺ min(chunk_index) == 1 over its points.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';

// Same pacer pin as VectorIndexer.coverage.test.ts (see its header comment).
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

/** sha256(content) — mirrors the SUT's per-sub-chunk contentHash. */
function hashOf(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/** The head content every session shares (system preamble) — the fleet defect. */
const SHARED_HEAD = 'You are Roo, a knowledgeable technical AI assistant… (shared system preamble)';

function t1Chunks(): any[] {
	return [
		{ chunk_id: 't1-c1', content: SHARED_HEAD, indexed: true, task_id: 't1', sequence_order: 0, chunk_type: 'message_exchange', role: 'system', total_chunks: 3, chunk_index: 1 },
		{ chunk_id: 't1-c2', content: 'user asks about dedup scope', indexed: true, task_id: 't1', sequence_order: 1, chunk_type: 'message_exchange', role: 'user', total_chunks: 3, chunk_index: 2 },
		{ chunk_id: 't1-c3', content: 'assistant answers about dedup scope', indexed: true, task_id: 't1', sequence_order: 2, chunk_type: 'message_exchange', role: 'assistant', total_chunks: 3, chunk_index: 3 },
	];
}

describe('VectorIndexer — content-hash dedup is scoped to the task (#4352 g7)', () => {
	/** In-memory Qdrant point store, filter-AWARE for scroll (should + must). */
	let store: Map<string, { id: string; vector: number[]; payload: any }>;
	let scrollFilters: any[];

	beforeEach(() => {
		vi.clearAllMocks();
		store = new Map();
		scrollFilters = [];

		mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
		mockCreateCollection.mockResolvedValue(undefined);
		mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
		mockValidateVector.mockImplementation(() => {});
		mockSanitizePayload.mockImplementation((p: any) => p || {});
		mockSplitChunk.mockImplementation((c: any) => [c]);
		mockExtractTask.mockReset().mockResolvedValue([]);

		// Embeddings: distinct 4-dim vectors sized to the request input.
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
		// Filter-aware scroll: a point matches when its contentHash is in the
		// `should` list AND (no `must` clause OR its task_id equals the must value)
		// — the semantics the scoped fix relies on.
		mockScroll.mockImplementation(async (_c: string, params: any) => {
			scrollFilters.push(params.filter);
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

	/** min(chunk_index) over one task's stored points — the detector's predicate. */
	function minChunkIndex(taskId: string): number | undefined {
		const idx = [...store.values()]
			.filter(p => p.payload?.task_id === taskId && typeof p.payload?.chunk_index === 'number')
			.map(p => p.payload.chunk_index as number);
		return idx.length === 0 ? undefined : Math.min(...idx);
	}

	test('END STATE — another task holding the same head content no longer starves this task\'s head (min(chunk_index)==1)', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// The pre-existing fleet state: task 'other' already indexed the shared
		// head content. Under the global scroll this suppressed t1's head point.
		store.set('other-p1', { id: 'other-p1', vector: [0, 0, 0, 0], payload: { task_id: 'other', chunk_index: 1, contentHash: hashOf(SHARED_HEAD) } });
		mockExtractTask.mockResolvedValue(t1Chunks());

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await indexTask('t1', '/p');
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		expect(mockUpsert).toHaveBeenCalled();
		expect(minChunkIndex('t1')).toBe(1);   // the head LANDED — red on the global scroll
	});

	test('END STATE — a re-pass completes an existing head hole (the 172k-page fleet state)', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// A task whose head was never written (a previous global-scroll pass
		// starved it) plus the foreign duplicate that starved it.
		const chunks = t1Chunks();
		store.set('t1-c2', { id: 't1-c2', vector: [0, 0, 0, 0], payload: { task_id: 't1', chunk_index: 2, contentHash: hashOf(chunks[1].content) } });
		store.set('t1-c3', { id: 't1-c3', vector: [0, 0, 0, 0], payload: { task_id: 't1', chunk_index: 3, contentHash: hashOf(chunks[2].content) } });
		store.set('other-p1', { id: 'other-p1', vector: [0, 0, 0, 0], payload: { task_id: 'other', chunk_index: 1, contentHash: hashOf(SHARED_HEAD) } });
		mockExtractTask.mockResolvedValue(chunks);

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await indexTask('t1', '/p');
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		// c2/c3 were skipped by the chunk_id preflight (already present); the
		// head was embedded and written — the re-pass completed the hole.
		expect(minChunkIndex('t1')).toBe(1);
		expect(store.has('t1-c1')).toBe(true);
	});

	test('the scroll filter carries the same-task must-clause (mechanism pin)', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		store.set('other-p1', { id: 'other-p1', vector: [0, 0, 0, 0], payload: { task_id: 'other', chunk_index: 1, contentHash: hashOf(SHARED_HEAD) } });
		mockExtractTask.mockResolvedValue(t1Chunks());

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await indexTask('t1', '/p');
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		// Every contentHash scroll the run made was scoped to t1 — none was global.
		expect(scrollFilters.length).toBeGreaterThan(0);
		for (const filter of scrollFilters) {
			expect(filter?.must?.[0]?.key).toBe('task_id');
			expect(filter?.must?.[0]?.match?.value).toBe('t1');
			expect((filter?.should ?? []).every((c: any) => c.key === 'contentHash')).toBe(true);
		}
	});

	test('same-task duplicate content STILL dedups (#1985/#2369 intent preserved)', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// The #2369 case: the same task already holds this content under a
		// DIFFERENT chunk_id (re-split sub-chunks with new UUIDs). Skipping it
		// is correct and must survive the scoping.
		store.set('t1-old-uuid', { id: 't1-old-uuid', vector: [0, 0, 0, 0], payload: { task_id: 't1', chunk_index: 1, contentHash: hashOf(SHARED_HEAD) } });
		mockExtractTask.mockResolvedValue(t1Chunks());

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let embedInputs: any[] = [];
		mockEmbeddingsCreate.mockImplementation(({ input }: any) => {
			embedInputs = Array.isArray(input) ? input : [input];
			return Promise.resolve({
				data: embedInputs.map((_: any, i: number) => ({ embedding: [i, 1, 0, 0] })),
				model: 'text-embedding-3-small',
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		});
		try {
			await indexTask('t1', '/p');
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		// head was skipped before embedding (its content already exists FOR t1)
		expect(embedInputs).not.toContain(SHARED_HEAD);
		expect(store.has('t1-c1')).toBe(false);
		// the other two chunks went through normally
		expect(store.has('t1-c2')).toBe(true);
		expect(store.has('t1-c3')).toBe(true);
	});
});
