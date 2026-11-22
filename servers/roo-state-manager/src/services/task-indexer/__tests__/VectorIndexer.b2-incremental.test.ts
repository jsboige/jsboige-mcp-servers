/**
 * #4861 — B2 contentHash preflight: incremental pass (per-task hash ledger) +
 * FAIL-CLOSED scroll failure.
 *
 * Measured driver (ai-01 leader, collection >5M points → #2209 skips the
 * chunk_id preflight): a session already indexed except its tail cost a FULL
 * session scroll every pass — 443,851 sub-chunks / 42,078 scrolls / 89 min on
 * CoursIA-2 `2279c906`, then `retry_fail [qdrant_upsert_failed]`. And the
 * per-batch catch was fail-OPEN ("post-index dedup will catch them"): under
 * saturation, one failed scroll re-embedded the whole session.
 *
 * This file pins:
 *   1. a re-pass of an already-indexed session scrolls ONLY the new tail —
 *      the per-task ledger is written from the points confirmed written, and
 *      B2 subtracts it before scrolling (mutant A: ignoring the ledger must
 *      make the proportionality assertions go red);
 *   2. a B2 scroll failure rejects the pass with a deferral (CIRCUIT_BREAKER_
 *      OPEN + details.scrollFailed), embeddings.create is NEVER called, and
 *      the failure reaches the FILE logger (roosync-*.log) — not console.warn
 *      (mutant B: restoring the fail-open keep must make this go red);
 *   3. `resetCollection` clears the ledger directory — the recorded hashes no
 *      longer exist after a wipe;
 *   4. the B2 "done" loop line carries ledgerHits + scrollBatches so the
 *      issue's closure criterion (reads ∝ new chunks) is measurable in the
 *      roosync-*.log of the ai-01 leader;
 *   5. v1.1 — hashes the scroll confirms PRESENT are learned by the ledger:
 *      a session indexed before the ledger existed converges to zero scrolls
 *      on its second pass (mutant C: removing the scroll-found append makes
 *      pass 2 re-scroll the full session).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

// Same pacer pin as the sibling B2 suite: read ONCE at module load.
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
		deleteCollection: vi.fn().mockResolvedValue(undefined),
	})),
}));

vi.mock('../../openai.js', () => ({
	default: vi.fn(() => ({ embeddings: { create: mockEmbeddingsCreate } })),
	getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
	getEmbeddingDimensions: vi.fn(() => 1536),
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

function chunkOf(i: number): any {
	return {
		chunk_id: `c-4861-${i}`,
		content: `content-4861-${i}-${'x'.repeat(12)}`,
		indexed: true,
		task_id: 't-4861',
		sequence_order: i,
		chunk_type: 'message_exchange',
		role: 'user',
		total_chunks: 1,
		chunk_index: i + 1,
	};
}

function embedOk() {
	return (req: any) => {
		const n = Array.isArray(req.input) ? req.input.length : 1;
		return Promise.resolve({
			data: Array.from({ length: n }, () => ({ embedding: new Array(1536).fill(0.1) })),
		});
	};
}

function hashOf(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

let ledgerTmpDir: string;

describe('VectorIndexer — #4861 B2 incremental pass + fail-closed scroll', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		ledgerTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rsm-ledger-4861-'));
		process.env.INDEX_HASH_LEDGER_DIR = ledgerTmpDir;
		mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
		mockCreateCollection.mockResolvedValue(undefined);
		mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
		mockUpsert.mockResolvedValue(undefined);
		mockCount.mockResolvedValue({ count: 100 });   // small collection → chunk_id preflight proceeds
		mockRetrieve.mockResolvedValue([]);             // chunk_id preflight: nothing exists
		mockScroll.mockResolvedValue({ points: [], next_page_offset: null }); // B2: nothing exists
		mockValidateVector.mockReset().mockImplementation(() => {});
		mockSanitizePayload.mockReset().mockImplementation((p: any) => p || {});
		mockSplitChunk.mockReset().mockImplementation((c: any) => [c]);
		mockExtractTask.mockReset().mockResolvedValue([]);
		mockEmbeddingsCreate.mockReset().mockImplementation(embedOk());
	});

	afterEach(async () => {
		delete process.env.INDEX_HASH_LEDGER_DIR;
		if (ledgerTmpDir) {
			await fsp.rm(ledgerTmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	async function freshModule() {
		vi.resetModules();
		// vi.clearAllMocks() (beforeEach) strips mock IMPLEMENTATIONS — and
		// vi.resetModules() re-instantiates the mocked openai module around the
		// shared hoisted fn. Re-arm the implementation for this test's module
		// instance, like the sibling B2 suite does.
		mockEmbeddingsCreate.mockImplementation(embedOk());
		const mod = await import('../VectorIndexer.js');
		mod.resetCircuitBreakerForTest();
		return mod;
	}

	function silenceConsole() {
		const spies = [
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];
		return () => spies.forEach(s => s.mockRestore());
	}

	// ── 1. Incremental pass: reads ∝ NEW chunks ────────────────────────────

	test('re-pass of an indexed session scrolls ONLY the new tail (ledger written from confirmed upserts)', async () => {
		const { indexTask } = await freshModule();
		const restore = silenceConsole();
		try {
			// Pass 1: 250 sub-chunks, all new → B2 scrolls ceil(250/100) = 3 batches.
			mockExtractTask.mockResolvedValue(Array.from({ length: 250 }, (_, i) => chunkOf(i)));
			const written = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(written.length).toBe(250);
			const scrollsPass1 = mockScroll.mock.calls.length;
			expect(scrollsPass1).toBeGreaterThanOrEqual(3);

			// The ledger must now hold the 250 confirmed-written hashes.
			const files = await fsp.readdir(ledgerTmpDir);
			expect(files.length).toBe(1);
			const ledgerContent = await fsp.readFile(path.join(ledgerTmpDir, files[0]), 'utf8');
			const ledgerHashes = new Set(ledgerContent.split('\n').filter(Boolean));
			expect(ledgerHashes.size).toBe(250);
			expect(ledgerHashes.has(hashOf(chunkOf(0).content))).toBe(true);

			// Pass 2: SAME session + 1 new sub-chunk (the tail).
			mockScroll.mockClear();
			mockRetrieve.mockClear();
			mockEmbeddingsCreate.mockClear();
			mockExtractTask.mockResolvedValue(Array.from({ length: 251 }, (_, i) => chunkOf(i)));
			const written2 = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});

			// Only the new chunk is written.
			expect(written2.length).toBe(1);
			expect(written2[0].payload.contentHash).toBe(hashOf(chunkOf(250).content));

			// PROPORTIONALITY (mutant A: ignore the ledger → 6 B2 scroll batches
			// instead of 1, and this assertion goes red). B2: 1 batch of the new
			// hash; the #1985 post-embed dedup adds its own 1 batch for the
			// single new point. Total ≤ 2 — never the full-session 6.
			expect(mockScroll.mock.calls.length).toBeLessThanOrEqual(2);
			// Only the new chunk is embedded.
			expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	test('a fully-known session costs ZERO B2 scroll (nothing new to check)', async () => {
		const { indexTask } = await freshModule();
		const restore = silenceConsole();
		try {
			mockExtractTask.mockResolvedValue(Array.from({ length: 5 }, (_, i) => chunkOf(i)));
			await indexTask('t-4861', '/nowhere', 'roo', undefined, {});

			mockScroll.mockClear();
			mockEmbeddingsCreate.mockClear(); // drop pass 1's calls — assertions below are pass 2 only
			mockExtractTask.mockResolvedValue(Array.from({ length: 5 }, (_, i) => chunkOf(i)));
			const written = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(written.length).toBe(0);
			expect(mockScroll).not.toHaveBeenCalled();
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	// ── 1b. v1.1: the ledger LEARNS scroll-confirmed hashes ────────────────

	test('a pre-ledger session (all hashes found by scroll) converges to zero scrolls on pass 2', async () => {
		const { indexTask } = await freshModule();
		const { getDefaultLogger } = await import('../../../utils/logger.js');
		const restore = silenceConsole();
		const loopLines: string[] = [];
		const infoSpy = vi.spyOn(getDefaultLogger(), 'info').mockImplementation((line: string) => {
			loopLines.push(String(line));
		});
		try {
			// Qdrant answers every requested hash as already present FOR THIS TASK.
			mockScroll.mockImplementation((_collection: string, params: any) => {
				const requested = (params?.filter?.should ?? [])
					.map((m: any) => m?.match?.value)
					.filter(Boolean);
				return Promise.resolve({
					points: requested.map((h: string) => ({ id: `p-${h}`, payload: { contentHash: h } })),
					next_page_offset: null,
				});
			});
			const session = [chunkOf(0), chunkOf(1), chunkOf(2)];

			// Pass 1: EMPTY ledger → B2 scrolls the 3 hashes (1 batch), finds them
			// all present, skips every chunk, and must now RECORD them.
			mockExtractTask.mockResolvedValue(session);
			const written1 = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(written1.length).toBe(0);
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
			expect(mockScroll).toHaveBeenCalledTimes(1); // 3 hashes = one 100-hash batch
			const files = await fsp.readdir(ledgerTmpDir);
			expect(files.length).toBe(1);
			const ledgerHashes = new Set(
				(await fsp.readFile(path.join(ledgerTmpDir, files[0]), 'utf8')).split('\n').filter(Boolean),
			);
			expect(ledgerHashes.size).toBe(3);

			// Pass 2: same session, ledger populated by the SCROLL (not by an
			// upsert — nothing was ever written here). Mutant C: removing the
			// scroll-found append leaves the ledger empty, B2 re-scrolls, and
			// both assertions below go red.
			mockScroll.mockClear();
			mockEmbeddingsCreate.mockClear();
			const written2 = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(written2.length).toBe(0);
			expect(mockScroll).not.toHaveBeenCalled();

			const doneLines = loopLines.filter(l => l.includes('phase B2 (contentHash preflight) done'));
			expect(doneLines.length).toBe(2);
			expect(doneLines[1]).toMatch(/ledgerHits=3/);
			expect(doneLines[1]).toMatch(/scrollBatches=0/);
		} finally {
			infoSpy.mockRestore();
			restore();
		}
	});

	// ── 2. Fail-closed B2 scroll ────────────────────────────────────────────

	test('a B2 scroll failure defers the pass: CIRCUIT_BREAKER_OPEN + scrollFailed, NO embedding, file-logged', async () => {
		const { indexTask, getCircuitBreakerState } = await freshModule();
		const { getDefaultLogger } = await import('../../../utils/logger.js');
		const restore = silenceConsole();
		const infoSpy = vi.spyOn(getDefaultLogger(), 'info');
		try {
			mockExtractTask.mockResolvedValue(Array.from({ length: 3 }, (_, i) => chunkOf(i)));
			mockScroll.mockRejectedValue(new Error('qdrant scroll timeout (saturation)'));

			let thrown: any = null;
			try {
				await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			} catch (e) { thrown = e; }

			// Fail-CLOSED (mutant B: restoring the fail-open keep turns this red —
			// the old behaviour returned 3 indexed points and called embeddings).
			expect(thrown).not.toBeNull();
			expect(thrown.details?.scrollFailed).toBe(true);
			expect(String(thrown.message)).toMatch(/indexing deferred/);
			expect(thrown.details?.missingVectors).toBeUndefined();
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
			expect(mockUpsert).not.toHaveBeenCalled();

			// Breaker debited (the deferral mirrors #2165).
			expect(getCircuitBreakerState().failureCount).toBeGreaterThanOrEqual(1);

			// The failure reached the FILE logger (roosync-*.log), not just console.
			const lines = infoSpy.mock.calls.map(c => String(c[0]));
			expect(lines.some(l => l.includes('[#4861]') && l.includes('scroll FAILED'))).toBe(true);
			// Nothing was written → no ledger file created.
			expect((await fsp.readdir(ledgerTmpDir)).length).toBe(0);
		} finally {
			infoSpy.mockRestore();
			restore();
		}
	});

	test('after a fail-closed pass the next tick re-runs B2 (no partial ledger poisoned)', async () => {
		const { indexTask, resetCircuitBreakerForTest } = await freshModule();
		const restore = silenceConsole();
		try {
			mockExtractTask.mockResolvedValue([chunkOf(0)]);
			mockScroll.mockRejectedValueOnce(new Error('transient scroll failure'));
			await expect(indexTask('t-4861', '/nowhere', 'roo', undefined, {}))
				.rejects.toMatchObject({ details: expect.objectContaining({ scrollFailed: true }) });

			// Next tick: scroll answers again → the chunk is indexed normally.
			resetCircuitBreakerForTest();
			const written = await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(written.length).toBe(1);
			// And the ledger now holds exactly that chunk's hash.
			const files = await fsp.readdir(ledgerTmpDir);
			expect(files.length).toBe(1);
		} finally {
			restore();
		}
	});

	// ── 3. Ledger invalidation on reset ────────────────────────────────────

	test('resetCollection clears the hash-ledger directory (wiped points are not "already written")', async () => {
		const { indexTask, resetCollection } = await freshModule();
		const restore = silenceConsole();
		try {
			mockExtractTask.mockResolvedValue([chunkOf(0), chunkOf(1)]);
			await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect((await fsp.readdir(ledgerTmpDir)).length).toBe(1);

			// Small collection (mockCount = 100 < RESET_SAFETY_FLOOR) → reset allowed.
			await resetCollection();
			// The clear REMOVES the directory (fs.rm recursive) — absent or empty
			// both mean "no recorded hashes". A missing dir must not fail the test.
			const afterReset = await fsp.readdir(ledgerTmpDir).catch((e: any) =>
				e?.code === 'ENOENT' ? [] : Promise.reject(e));
			expect(afterReset.length).toBe(0);

			// A re-pass re-scrolls (nothing is "known" anymore).
			mockScroll.mockClear();
			await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			expect(mockScroll).toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	// ── 4. Proportionality visible in the file log ──────────────────────────

	test('the B2 done loop line carries ledgerHits + scrollBatches (closure criterion measurable)', async () => {
		const { indexTask } = await freshModule();
		const { getDefaultLogger } = await import('../../../utils/logger.js');
		const restore = silenceConsole();
		const loopLines: string[] = [];
		const infoSpy = vi.spyOn(getDefaultLogger(), 'info').mockImplementation((line: string) => {
			loopLines.push(String(line));
		});
		try {
			mockExtractTask.mockResolvedValue(Array.from({ length: 3 }, (_, i) => chunkOf(i)));
			await indexTask('t-4861', '/nowhere', 'roo', undefined, {});
			// Second pass: 1 new chunk → ledgerHits=3, scrollBatches=1.
			mockExtractTask.mockResolvedValue(Array.from({ length: 4 }, (_, i) => chunkOf(i)));
			await indexTask('t-4861', '/nowhere', 'roo', undefined, {});

			const doneLines = loopLines.filter(l => l.includes('phase B2 (contentHash preflight) done'));
			expect(doneLines.length).toBe(2);
			expect(doneLines[1]).toMatch(/ledgerHits=3/);
			expect(doneLines[1]).toMatch(/scrollBatches=1/);
		} finally {
			infoSpy.mockRestore();
			restore();
		}
	});
});
