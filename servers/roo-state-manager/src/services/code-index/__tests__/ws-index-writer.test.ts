/**
 * #4736 P3 — the guarded incremental ws-* writer (services/code-index/ws-index-writer.ts).
 *
 * The issue's acceptance criterion, verbatim: "une 2ᵉ lane est refusée. Pour un
 * fichier modifié, le delta est égal au nombre de nouveaux blocs, les anciens
 * points sont supprimés, et la configuration de la collection reste inchangée."
 * Every guard here has a mutation check — flip the guard, the test fails:
 *
 *  - PREFIX VALIDATION: a wrong absolute prefix refuses the run (twin-id gate);
 *  - SINGLE WRITER: a foreign sentinel refuses the write, only an explicit
 *    takeover gets past, and takeover does NOT cross a model change;
 *  - NEVER BOOTSTRAP: no served collection → refusal, createCollection never called;
 *  - DRY RUN DEFAULT: a dry run writes nothing at all (no sentinel even);
 *  - WRITE FIRST, COLLECT BY ID (#4938): a modified file ends up owning exactly
 *    its new blocks — old orphaned ids gone, shared ids never deleted,
 *    points_count delta = new − old, config untouched;
 *  - CACHE HIT REQUIRES CONTENT (#4938): a cache entry at the current hash but
 *    with no content point is replanned (non-exact count, `exact: false`), and
 *    a failed batch leaves the file its OLD points and no cache;
 *  - INCREMENTAL: a second run over unchanged files embeds nothing (hash cache);
 *  - GC: a managed file deleted from disk has its points AND cache point removed.
 *
 * Id parity itself (the formulas) is pinned by zoo-parity.test.ts with literal
 * hashes; here the stored points are seeded through the same port, which is
 * exactly what the writer replays — the subject is the writer's bookkeeping.
 */
import { describe, test, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import {
	joinZooWriterPath,
	toNativeRel,
	validateHashPathPrefix,
	readWsWriterRecord,
	claimWsWriter,
	runWsIndexWriter,
	WS_WRITER_SENTINEL_ID,
	wsWriterCachePointId,
	MAX_WS_WRITER_FILE_BYTES,
	type WsIndexWriterDeps,
} from '../ws-index-writer.js';
import {
	parseZooMarkdownContent,
	toZooPointPayload,
	zooPointId,
} from '../zoo-parity.js';
import type { QdrantLike } from '../supplement-index.js';

const PREFIX = 'd:\\test\\ws';
const COLLECTION = 'ws-aaaaaaaaaaaaaaaa';
const MODEL = 'test-embedding-model';

// ── A minimal in-memory Qdrant with payload filtering ────────────────────────

class FakeWsQdrant implements QdrantLike {
	collections = new Map<string, { size: number; distance: string; points: Map<string, { vector: number[]; payload: any }> }>();
	upsertCalls: Array<{ collection: string; points: any[] }> = [];
	deleteCalls: Array<{ collection: string; ids: string[] }> = [];
	createCalls: Array<{ collection: string; body: any }> = [];
	/** #4938 — every write and delete in call order, one entry per point id. */
	ops: string[] = [];
	/** #4938 — every count request as received (the tests pin `exact: false`). */
	countCalls: Array<{ collection: string; body: any }> = [];
	countInFlight = 0;
	countMaxInFlight = 0;

	constructor(seed: Record<string, { size?: number; distance?: string }> = {}) {
		for (const [name, cfg] of Object.entries(seed)) {
			this.collections.set(name, {
				size: cfg.size ?? 4,
				distance: cfg.distance ?? 'Cosine',
				points: new Map(),
			});
		}
	}

	private col(name: string) {
		const c = this.collections.get(name);
		if (!c) throw new Error(`collection ${name} not found`);
		return c;
	}

	async getCollection(name: string) {
		const c = this.col(name);
		return {
			points_count: c.points.size,
			config: { params: { vectors: { size: c.size, distance: c.distance } } },
		};
	}

	async getCollections() {
		return { collections: [...this.collections.keys()].map((name) => ({ name })) };
	}

	async createCollection(name: string, body: any) {
		this.createCalls.push({ collection: name, body });
		this.collections.set(name, {
			size: body?.vectors?.size ?? 0,
			distance: body?.vectors?.distance ?? 'Cosine',
			points: new Map(),
		});
	}

	async retrieve(name: string, body: any) {
		const c = this.col(name);
		const ids: string[] = body?.ids ?? [];
		// REAL client shape (@qdrant/js-client-rest 1.16.2, ms#1789 review):
		// the SDK UNWRAPS the HTTP envelope (`qdrant-client.js` returns
		// `response.data.result`), so `retrieve` answers a BARE ARRAY of points
		// and `scroll` answers `{ points, next_page_offset }` — NOT the raw
		// `{ result: ... }` envelope a fetch/curl probe would show. The earlier
		// fake answered `{ points }` (a shape the live client never produces)
		// and its correction `{ result: [...] }` (the RAW HTTP shape, also not
		// what the SDK returns): both fictions "verified" a guard that
		// production left blind (#4736 P4: three passes, zero skips). A fake
		// must be written from the pinned SDK's measured return, not from the
		// code it doubles — and the hash-cache/sentinel tests below fail if
		// responsePoints ever stops accepting the bare array.
		return ids.filter((id) => c.points.has(id)).map((id) => ({ id, payload: c.points.get(id)!.payload }));
	}

	async scroll(name: string, body: any) {
		const c = this.col(name);
		const must: any[] = body?.filter?.must ?? [];
		const mustNot: any[] = body?.filter?.must_not ?? [];
		const hasId: string[] | null = must.find((m: any) => Array.isArray(m?.has_id))?.has_id ?? null;
		const matches = (payload: any) =>
			must.every((m: any) => Array.isArray(m?.has_id) || String(payload?.[m.key]) === String(m.match?.value))
			&& mustNot.every((m: any) => String(payload?.[m.key]) !== String(m.match?.value));
		const points = [...c.points.entries()]
			.filter(([id]) => !hasId || hasId.includes(id))
			.filter(([, p]) => matches(p.payload))
			.map(([id, p]) => ({ id, payload: p.payload }));
		return { points: points.slice(0, body?.limit ?? 1000), next_page_offset: null };
	}

	async upsert(name: string, body: any) {
		const c = this.col(name);
		const points: any[] = body?.points ?? [];
		this.upsertCalls.push({ collection: name, points });
		for (const p of points) {
			c.points.set(String(p.id), { vector: p.vector, payload: p.payload });
			this.ops.push(`upsert:${p.id}`);
		}
	}

	async delete(name: string, body: any) {
		const c = this.col(name);
		const ids: string[] = body?.points ?? [];
		this.deleteCalls.push({ collection: name, ids });
		for (const id of ids) {
			c.points.delete(id);
			this.ops.push(`delete:${id}`);
		}
	}

	/**
	 * #4938 — `count` as the pinned SDK returns it (`@qdrant/js-client-rest`
	 * unwraps the envelope: a bare `{ count }`). The fake answers the true
	 * number whatever `exact` says — it has no cardinality estimator; what the
	 * tests pin is the REQUEST (`exact: false`, never `true`: #4928). It yields
	 * to the event loop so a batch's requests overlap, like real IO does.
	 */
	async count(name: string, body: any) {
		const c = this.col(name);
		this.countCalls.push({ collection: name, body });
		this.countInFlight++;
		this.countMaxInFlight = Math.max(this.countMaxInFlight, this.countInFlight);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			const must: any[] = body?.filter?.must ?? [];
			const mustNot: any[] = body?.filter?.must_not ?? [];
			const matches = (payload: any) =>
				must.every((m: any) => String(payload?.[m.key]) === String(m.match?.value))
				&& mustNot.every((m: any) => String(payload?.[m.key]) !== String(m.match?.value));
			return { count: [...c.points.values()].filter((p) => matches(p.payload)).length };
		} finally {
			this.countInFlight--;
		}
	}
}

/** Seeds Zoo-shaped stored points for a file, under the given prefix. */
function seedZooPoints(fake: FakeWsQdrant, collection: string, prefix: string, relPath: string, content: string): string[] {
	const c = fake.collections.get(collection)!;
	const blocks = parseZooMarkdownContent(joinZooWriterPath(prefix, toNativeRel(relPath)), content);
	const relNative = toNativeRel(relPath);
	const ids: string[] = [];
	for (const b of blocks) {
		const id = zooPointId(b.segmentHash);
		c.points.set(id, { vector: [0.5, 0.5, 0.5, 0.5], payload: toZooPointPayload(b, relNative) });
		ids.push(id);
	}
	return ids;
}

/** Zoo blocks of a file as the writer would compute them — the expected new state. */
function expectedBlocks(prefix: string, relPath: string, content: string) {
	return parseZooMarkdownContent(joinZooWriterPath(prefix, toNativeRel(relPath)), content);
}

// ── Workspace fixture ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeWorkspace(files: Record<string, string>): { root: string; listFiles: () => Promise<string[]> } {
	const root = mkdtempSync(join(tmpdir(), 'ws-writer-'));
	tempDirs.push(root);
	const paths: string[] = [];
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), content);
		paths.push(rel);
	}
	paths.sort();
	return { root, listFiles: () => Promise.resolve([...paths]) };
}

/** Markdown that yields several blocks: headers split sections, each ≥ MIN chars. */
const DOC_V1 = '# Title\n\n' + 'alpha line of content for the first section\n'.repeat(6)
	+ '## Part Two\n\n' + 'beta line of content for the second section\n'.repeat(6);
const DOC_V2 = '# Title (edited)\n\n' + 'alpha line rewritten for the first section\n'.repeat(8)
	+ '## Part Two\n\n' + 'beta line rewritten for the second section\n'.repeat(8)
	+ '## Part Three\n\n' + 'gamma line of a brand new third section\n'.repeat(6);

afterAll(() => {
	for (const dir of tempDirs) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

function baseDeps(overrides: Partial<WsIndexWriterDeps> & { client: FakeWsQdrant; workspaceRoot: string }): WsIndexWriterDeps & { embedLog: string[][] } {
	const embedLog: string[][] = [];
	const embed = async (texts: string[]) => {
		embedLog.push(texts);
		return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
	};
	const deps = {
		writer: 'web1:roo-extensions',
		hashPathPrefix: PREFIX,
		embeddingModelId: MODEL,
		embeddingEndpoint: 'embed.internal',
		collection: COLLECTION,
		embed,
		sleep: async () => {},
		...overrides,
	};
	(deps as any).embedLog = embedLog;
	return deps as WsIndexWriterDeps & { embedLog: string[][] };
}

// ── Path join ─────────────────────────────────────────────────────────────────

describe('joinZooWriterPath', () => {
	test('prefix + native relative path, backslash-joined', () => {
		expect(joinZooWriterPath('d:\\dev\\roo-extensions', 'docs\\a.md')).toBe('d:\\dev\\roo-extensions\\docs\\a.md');
	});

	test('a trailing separator on the prefix is tolerated, never doubled', () => {
		expect(joinZooWriterPath('d:\\dev\\roo-extensions\\', 'docs\\a.md')).toBe('d:\\dev\\roo-extensions\\docs\\a.md');
		expect(joinZooWriterPath('d:/dev/roo-extensions/', 'docs\\a.md')).toBe('d:\\dev\\roo-extensions\\docs\\a.md');
	});
});

// ── Prefix validation (the twin-id gate) ──────────────────────────────────────

describe('validateHashPathPrefix (#4736 P3)', () => {
	test('verifies stored points under the historical prefix', async () => {
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const result = await validateHashPathPrefix(fake, COLLECTION, PREFIX);
		expect(result.verified).toBeGreaterThan(0);
		expect(result.sampled).toBe(result.verified); // every 5-field point recomputes
		expect(result.verified_sample?.filePath).toBe('docs\\a.md');
	});

	test('a wrong prefix verifies nothing', async () => {
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const result = await validateHashPathPrefix(fake, COLLECTION, 'x:\\elsewhere');
		expect(result.verified).toBe(0);
	});

	test('an arbitrary foreign hash is sampled but never verified (sha256 is not an accident)', async () => {
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		fake.collections.get(COLLECTION)!.points.set('foreign-id', {
			vector: [0, 0, 0, 0],
			payload: { filePath: 'docs\\other.md', codeChunk: 'x'.repeat(120), startLine: 1, endLine: 2, segmentHash: 'deadbeef' },
		});
		const result = await validateHashPathPrefix(fake, COLLECTION, PREFIX);
		expect(result.verified).toBeGreaterThan(0);
		expect(result.sampled).toBe(result.verified + 1);
	});

	test('one hand-computed sha256 proves the formula itself (not just self-consistency)', async () => {
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const content = 'x'.repeat(120);
		const abs = joinZooWriterPath(PREFIX, 'docs\\formula.md');
		const expectedHash = createHash('sha256')
			.update(`${abs}-1-2-${content.length}-${content.slice(0, 100)}`)
			.digest('hex');
		fake.collections.get(COLLECTION)!.points.set('manual-id', {
			vector: [0, 0, 0, 0],
			payload: { filePath: 'docs\\formula.md', codeChunk: content, startLine: 1, endLine: 2, segmentHash: expectedHash },
		});
		const result = await validateHashPathPrefix(fake, COLLECTION, PREFIX);
		expect(result.verified).toBe(1);
	});
});

// ── The writer run ────────────────────────────────────────────────────────────

describe('runWsIndexWriter (#4736 P3)', () => {
	test('refuses when no served collection resolves — and never bootstraps one', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant(); // ZERO collections
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root });
		delete (deps as any).collection; // force the probe path
		await expect(runWsIndexWriter(deps)).rejects.toThrow(/NEVER bootstraps/);
		expect(fake.createCalls).toHaveLength(0);
		expect(fake.upsertCalls).toHaveLength(0);
	});

	test('refuses on an unvalidated prefix before writing anything', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, hashPathPrefix: 'x:\\wrong', listFiles: ws.listFiles });
		await expect(runWsIndexWriter(deps)).rejects.toThrow(/prefix validation failed/);
		expect(fake.upsertCalls).toHaveLength(0);
		expect(fake.deleteCalls).toHaveLength(0);
	});

	test('dry run (the default) writes nothing — no sentinel, no point, no embedding', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V2 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const oldIds = seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter(deps);
		expect(report.dry_run).toBe(true);
		expect(report.status).toBe('dry_run');
		expect(report.files_to_index).toBe(1);
		expect(report.prefix_validation.verified).toBeGreaterThan(0);
		expect(fake.upsertCalls).toHaveLength(0);
		expect(fake.deleteCalls).toHaveLength(0);
		expect(fake.collections.get(COLLECTION)!.points.size).toBe(oldIds.length);
		expect((deps as any).embedLog).toHaveLength(0);
	});

	test('MODIFIED FILE — old points purged, delta = new blocks, config unchanged (the criterion)', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V2 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const oldIds = seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const before = fake.collections.get(COLLECTION)!.points.size;
		const configBefore = JSON.stringify({ ...(await fake.getCollection(COLLECTION)).config });

		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...deps, dryRun: false });

		expect(report.status).toBe('success');
		expect(report.points_deleted).toBe(oldIds.length);
		const newBlocks = expectedBlocks(PREFIX, 'docs/a.md', DOC_V2);
		expect(report.points_written).toBe(newBlocks.length);
		// delta on CONTENT points = new blocks minus purged old ones; the raw
		// points.size delta additionally carries the two bookkeeping points
		// (sentinel + cache, asserted further below).
		const after = fake.collections.get(COLLECTION)!.points.size;
		expect(after - before).toBe(newBlocks.length - oldIds.length + 2);
		// old ids gone, new ids present with Zoo's payload shape (native separators)
		const colPoints = fake.collections.get(COLLECTION)!.points;
		for (const id of oldIds) expect(colPoints.has(id)).toBe(false);
		for (const b of newBlocks) {
			const id = zooPointId(b.segmentHash);
			expect(colPoints.has(id)).toBe(true);
			expect(colPoints.get(id)!.payload.filePath).toBe('docs\\a.md');
			expect(colPoints.get(id)!.payload.segmentHash).toBe(b.segmentHash);
		}
		// the file owns EXACTLY its new blocks (plus the two bookkeeping points)
		const filePointIds = [...colPoints.values()].filter((p) => p.payload.filePath === 'docs\\a.md').length;
		expect(filePointIds).toBe(newBlocks.length);
		// config unchanged: never created, never reconfigured
		expect(fake.createCalls).toHaveLength(0);
		expect(JSON.stringify({ ...(await fake.getCollection(COLLECTION)).config })).toBe(configBefore);
		// sentinel + cache point landed
		expect(colPoints.has(WS_WRITER_SENTINEL_ID)).toBe(true);
		expect(colPoints.has(wsWriterCachePointId('docs/a.md'))).toBe(true);
		// embedded exactly the new blocks, all in the collection's dimension
		expect((deps as any).embedLog.flat()).toHaveLength(newBlocks.length);
		for (const call of fake.upsertCalls) {
			for (const p of call.points) expect(p.vector).toHaveLength(4);
		}
	});

	test('SECOND LANE refused; explicit takeover proceeds and records the previous owner', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...deps, dryRun: false });
		expect((await readWsWriterRecord(fake, COLLECTION))?.writer).toBe('web1:roo-extensions');

		const lane2 = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles, writer: 'web2:roo-extensions' });
		await expect(runWsIndexWriter({ ...lane2, dryRun: false })).rejects.toThrow(/written by web1:roo-extensions/);

		const took = await runWsIndexWriter({ ...lane2, dryRun: false, takeover: true });
		expect(took.status).toBe('success'); // all unchanged → nothing to write
		const record = await readWsWriterRecord(fake, COLLECTION);
		expect(record?.writer).toBe('web2:roo-extensions');
		expect(record?.takenOverFrom).toBe('web1:roo-extensions');
	});

	test('UNCHANGED second run embeds nothing and writes no point (hash cache; retrieve = SDK bare array — fails if only `{ result: [...] }` is handled)', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...deps, dryRun: false });
		const afterFirst = fake.collections.get(COLLECTION)!.points.size;

		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...second, dryRun: false });
		expect(report.files_skipped_unchanged).toBe(1);
		expect(report.files_to_index).toBe(0);
		expect(report.points_deleted).toBe(0);
		expect(report.points_written).toBe(0);
		expect((second as any).embedLog).toHaveLength(0);
		// sentinel re-claim overwrites the same id: DELTA 0 on points_count
		expect(fake.collections.get(COLLECTION)!.points.size).toBe(afterFirst);
	});

	test('an embedding-model switch is refused — takeover does not cross a model change', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...deps, dryRun: false });

		const switched = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles, embeddingModelId: 'another-model' });
		await expect(runWsIndexWriter({ ...switched, dryRun: false })).rejects.toThrow(/refuses/);
		await expect(runWsIndexWriter({ ...switched, dryRun: false, takeover: true })).rejects.toThrow(/refuses/);
	});

	test('wrong-dimension vectors are refused per batch (no foreign space in a served collection)', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V2 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const oldIds = seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const run = {
			...deps,
			dryRun: false,
			embed: async (texts: string[]) => texts.map(() => [0.1, 0.2]), // 2d into a 4d collection
		};
		const report = await runWsIndexWriter(run as any);
		expect(report.status).toBe('failed');
		expect(report.batches_failed).toBeGreaterThan(0);
		expect(report.points_written).toBe(0);
		expect(report.warnings.some((w) => /wrong dimension/.test(w))).toBe(true);
		// nothing NEW landed: every content point still present belongs to the
		// generation seeded above. Since #4938 the write comes first and the
		// collection of the old generation after, so a refused batch leaves the
		// file its previous points instead of emptying it.
		expect(oldIds.length).toBeGreaterThan(0);
		for (const [id, p] of fake.collections.get(COLLECTION)!.points) {
			if (p.payload.type === 'metadata') continue;
			if (!oldIds.includes(String(id))) throw new Error('a content point was written despite the dimension refusal');
		}
	});

	test('DELETED FILE — a managed file gone from disk has points AND cache point removed', async () => {
		const ws = makeWorkspace({ 'docs/keep.md': DOC_V1, 'docs/gone.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...deps, dryRun: false });
		const goneIds = expectedBlocks(PREFIX, 'docs/gone.md', DOC_V1).map((b) => zooPointId(b.segmentHash));
		expect(fake.collections.get(COLLECTION)!.points.has(wsWriterCachePointId('docs/gone.md'))).toBe(true);

		unlinkSync(join(ws.root, 'docs/gone.md'));
		ws.listFiles = () => Promise.resolve(['docs/keep.md']);
		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...second, dryRun: false });
		expect(report.files_removed).toBe(1);
		const points = fake.collections.get(COLLECTION)!.points;
		for (const id of goneIds) expect(points.has(id)).toBe(false);
		expect(points.has(wsWriterCachePointId('docs/gone.md'))).toBe(false);
		expect(points.has(wsWriterCachePointId('docs/keep.md'))).toBe(true);
		expect(points.has(WS_WRITER_SENTINEL_ID)).toBe(true);
	});

	// ── Review round 2 (ai-01, 15/11) — the four reproduced defects ──────────

	test('PARTIAL WRITE — a file with a failed batch is NEVER cached (it used to be, and the next run skipped it)', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const blocks = expectedBlocks(PREFIX, 'docs/a.md', DOC_V1);
		expect(blocks.length).toBeGreaterThan(1); // the fixture must span ≥2 batches

		let calls = 0;
		const flaky = async (texts: string[]) => {
			calls++;
			if (calls === 2) throw new Error('Request Timeout'); // transient on batch 2
			return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
		};
		const first = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...first, dryRun: false, batchSize: 1, embed: flaky });

		expect(report.status).toBe('partial');
		expect(report.batches_failed).toBe(1);
		expect(report.points_written).toBeGreaterThan(0);
		expect(report.points_written).toBeLessThan(blocks.length);
		// the decisive assertion: no cache point for a file that lost a batch
		expect(fake.collections.get(COLLECTION)!.points.has(wsWriterCachePointId('docs/a.md'))).toBe(false);

		// next run must RE-INDEX the file (not skip it as "unchanged") and finish it
		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const rerun = await runWsIndexWriter({ ...second, dryRun: false });
		expect(rerun.files_skipped_unchanged).toBe(0);
		expect(rerun.files_to_index).toBe(1);
		expect(rerun.points_written).toBe(blocks.length);
		expect(fake.collections.get(COLLECTION)!.points.has(wsWriterCachePointId('docs/a.md'))).toBe(true);
	});

	test('CHUNK CAP — applied to WHOLE FILES before the purge: an excluded file keeps its points', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1, 'docs/b.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const first = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...first, dryRun: false });

		// both files change, but the budget only covers the first one's new blocks
		writeFileSync(join(ws.root, 'docs/a.md'), DOC_V2);
		writeFileSync(join(ws.root, 'docs/b.md'), DOC_V2);
		const aNew = expectedBlocks(PREFIX, 'docs/a.md', DOC_V2);
		const bOld = expectedBlocks(PREFIX, 'docs/b.md', DOC_V1);
		const bOldIds = bOld.map((b) => zooPointId(b.segmentHash));
		expect(bOldIds.every((id) => fake.collections.get(COLLECTION)!.points.has(id))).toBe(true);

		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles, maxChunks: aNew.length });
		const report = await runWsIndexWriter({ ...second, dryRun: false });

		expect(report.truncated).toBe(true);
		expect(report.points_written).toBe(aNew.length);
		// a.md fully rewritten; b.md untouched by the purge (its old points survive)
		const points = fake.collections.get(COLLECTION)!.points;
		expect(bOldIds.every((id) => points.has(id))).toBe(true);
		// and b's cache point still carries the OLD hash → the next run re-plans it
		const bCache = points.get(wsWriterCachePointId('docs/b.md'));
		expect(bCache?.payload.fileHash).toBe(
			createHash('sha256').update(DOC_V1).digest('hex'),
		);
	});

	test('PREFIX READ ERROR — a failed scroll refuses; it is not "nothing to twin"', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		(fake as any).scroll = async () => { throw new Error('Request Timeout'); };
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await expect(runWsIndexWriter({ ...deps, dryRun: false })).rejects.toThrow(/cannot read .* to validate the hash-path prefix/);
		expect(fake.upsertCalls).toHaveLength(0);
	});

	test('SENTINEL READ ERROR — a failed read refuses; it is not "no writer"', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1); // prefix gate passes via scroll
		(fake as any).retrieve = async () => { throw new Error('Request Timeout'); };
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await expect(runWsIndexWriter({ ...deps, dryRun: false })).rejects.toThrow(/cannot read the ws-writer sentinel/);
		expect(fake.upsertCalls).toHaveLength(0);
	});

	test('EMPTY COLLECTION — inconclusive (read, zero verifiable points), proceeds WITH the promised warning', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } }); // really read, zero points
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter(deps); // dry run
		expect(report.status).toBe('dry_run');
		expect(report.prefix_validation.read_error).toBeUndefined();
		expect(report.prefix_validation).toMatchObject({ verified: 0, sampled: 0 });
		expect(report.warnings.some((w) => /could NOT be validated/.test(w))).toBe(true);
	});

	test('PURGE READ ERROR — refuses instead of skipping the stale purge (a skipped purge duplicates)', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const realScroll = fake.scroll.bind(fake);
		(fake as any).scroll = async (name: string, body: any) => {
			if (body?.filter?.must?.some((m: any) => m?.key === 'filePath')) throw new Error('Request Timeout');
			return realScroll(name, body);
		};
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await expect(runWsIndexWriter({ ...deps, dryRun: false })).rejects.toThrow(/refusing to skip the stale purge/);
		// the sentinel claim may land before the purge, but no CONTENT point may
		for (const call of fake.upsertCalls) {
			for (const p of call.points) expect(p.payload.type).toBe('metadata');
		}
	});

	test('CACHE READ ERROR — refuses instead of re-indexing blind', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const realScroll = fake.scroll.bind(fake);
		(fake as any).scroll = async (name: string, body: any) => {
			if (body?.filter?.must?.some((m: any) => m?.key === 'source')) throw new Error('Request Timeout');
			return realScroll(name, body);
		};
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await expect(runWsIndexWriter({ ...deps, dryRun: false })).rejects.toThrow(/refusing to re-index blind/);
		expect(fake.upsertCalls).toHaveLength(0);
	});

	test('non-eligible markdown (hidden dir) and oversized files are skipped, not adopted', async () => {
		const ws = makeWorkspace({ '.hidden/notes.md': DOC_V1 });
		writeFileSync(join(ws.root, 'big.md'), 'x'.repeat(MAX_WS_WRITER_FILE_BYTES + 1));
		const files = ['.hidden/notes.md', 'big.md'];
		ws.listFiles = () => Promise.resolve(files);
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...deps, dryRun: false });
		expect(report.files_considered).toBe(0);
		expect(report.files_to_index).toBe(0);
		expect(report.warnings.some((w) => /over \d+ bytes skipped/.test(w))).toBe(true);
		expect((deps as any).embedLog).toHaveLength(0);
	});
});

// ── #4938 — a cache hit is trusted only while content exists; write, then collect ──

/** Same LINE COUNT as DOC_V1's first section, so the Part Two block keeps its
 * start/end pair — and therefore its Zoo segmentHash — across the edit. */
const DOC_V1_BETA_SAME = '# Title (edited)\n\n' + 'alpha line rewritten for the first section\n'.repeat(6)
	+ '## Part Two\n\n' + 'beta line of content for the second section\n'.repeat(6);

describe('runWsIndexWriter (#4938) — cache hit without content, write-then-collect', () => {
	afterEach(() => { delete process.env.WS_WRITER_CACHE_CONTENT_CHECK; });

	test('A CACHE HIT WITH NO CONTENT POINT IS REPLANNED — the measured 269-file hole', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1, 'docs/b.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const first = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...first, dryRun: false });

		// Reproduce the measured state on a.md: the cache entry still carries the
		// hash of the CURRENT file, its content points are gone (the purge-then-
		// write window, or a filePath purge issued by another seat).
		const aBlocks = expectedBlocks(PREFIX, 'docs/a.md', DOC_V1);
		const col = fake.collections.get(COLLECTION)!.points;
		for (const b of aBlocks) col.delete(zooPointId(b.segmentHash));
		const bIds = expectedBlocks(PREFIX, 'docs/b.md', DOC_V1).map((b) => zooPointId(b.segmentHash));
		const sizeBeforeSecond = col.size;

		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...second, dryRun: false });

		// the run closes the hole itself, and says so
		expect(report.cache_hit_without_content).toBe(1);
		expect(report.warnings.some((w) => /cache_hit_without_content/.test(w))).toBe(true);
		expect(report.files_to_index).toBe(1);
		expect(report.files_skipped_unchanged).toBe(1);
		expect(report.points_written).toBe(aBlocks.length);
		expect((second as any).embedLog.flat()).toHaveLength(aBlocks.length);
		for (const b of aBlocks) expect(col.has(zooPointId(b.segmentHash))).toBe(true);
		for (const id of bIds) expect(col.has(id)).toBe(true);
		// a.md's cache point was overwritten in place: the net delta is a.md's blocks
		expect(col.size).toBe(sizeBeforeSecond + aBlocks.length);
		// the verification is a non-exact count per skipped file — never `exact: true` (#4928)
		expect(fake.countCalls).toHaveLength(2);
		for (const call of fake.countCalls) {
			expect(call.body?.exact).toBe(false);
			expect(call.body?.filter?.must_not).toEqual([{ key: 'type', match: { value: 'metadata' } }]);
		}

		// and the journal returns to zero once the content is back
		const third = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const after = await runWsIndexWriter({ ...third, dryRun: false });
		expect(after.cache_hit_without_content).toBe(0);
		expect(after.files_skipped_unchanged).toBe(2);
		expect(after.points_written).toBe(0);
	});

	test('A FAILED EMBEDDING BATCH leaves the file its OLD points and no cache — neither empty nor trusted', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V2 });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const oldIds = seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const newIds = expectedBlocks(PREFIX, 'docs/a.md', DOC_V2).map((b) => zooPointId(b.segmentHash));
		expect(oldIds.every((id) => !newIds.includes(id))).toBe(true); // fixture: two disjoint generations

		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({
			...deps, dryRun: false,
			embed: async () => { throw new Error('embedding endpoint down'); },
		});

		expect(report.status).toBe('failed');
		expect(report.points_written).toBe(0);
		expect(report.points_deleted).toBe(0);
		const points = fake.collections.get(COLLECTION)!.points;
		// not empty: the previous generation is intact (it used to be purged first)
		for (const id of oldIds) expect(points.has(id)).toBe(true);
		for (const id of newIds) expect(points.has(id)).toBe(false);
		// and no cache: the next run RE-PLANS the file instead of skipping it
		expect(points.has(wsWriterCachePointId('docs/a.md'))).toBe(false);
		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const rerun = await runWsIndexWriter({ ...second, dryRun: false });
		expect(rerun.files_skipped_unchanged).toBe(0);
		expect(rerun.files_to_index).toBe(1);
	});

	test('WRITE FIRST, THEN COLLECT BY ID — a shared block is never deleted, an orphaned one always is', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1_BETA_SAME });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		const oldIds = seedZooPoints(fake, COLLECTION, PREFIX, 'docs/a.md', DOC_V1);
		const newBlocks = expectedBlocks(PREFIX, 'docs/a.md', DOC_V1_BETA_SAME);
		const newIds = newBlocks.map((b) => zooPointId(b.segmentHash));
		const shared = oldIds.filter((id) => newIds.includes(id));
		const orphaned = oldIds.filter((id) => !newIds.includes(id));
		// the fixture must exercise both halves, or the test proves nothing
		expect(shared.length).toBeGreaterThan(0);
		expect(orphaned.length).toBeGreaterThan(0);

		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...deps, dryRun: false });

		expect(report.status).toBe('success');
		const points = fake.collections.get(COLLECTION)!.points;
		for (const id of newIds) expect(points.has(id)).toBe(true);
		for (const id of orphaned) expect(points.has(id)).toBe(false);
		for (const id of shared) expect(points.has(id)).toBe(true);
		expect(report.points_deleted).toBe(orphaned.length);
		// the shared ids were never in a delete call
		for (const call of fake.deleteCalls) {
			for (const id of call.ids) expect(shared).not.toContain(id);
		}
		// ORDER: every new block landed before the first old-only id was collected
		const lastUpsert = Math.max(...newIds.map((id) => fake.ops.lastIndexOf(`upsert:${id}`)));
		const firstOrphanDelete = Math.min(...orphaned.map((id) => fake.ops.indexOf(`delete:${id}`)));
		expect(lastUpsert).toBeGreaterThanOrEqual(0);
		expect(firstOrphanDelete).toBeGreaterThan(lastUpsert);
	});

	test('KILL-SWITCH =0 — the blind skip is restored and no count is issued', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const first = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...first, dryRun: false });
		const col = fake.collections.get(COLLECTION)!.points;
		for (const b of expectedBlocks(PREFIX, 'docs/a.md', DOC_V1)) col.delete(zooPointId(b.segmentHash));

		process.env.WS_WRITER_CACHE_CONTENT_CHECK = '0';
		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...second, dryRun: false });
		expect(report.files_skipped_unchanged).toBe(1);
		expect(report.files_to_index).toBe(0);
		expect(report.cache_hit_without_content).toBe(0);
		expect(fake.countCalls).toHaveLength(0);
	});

	test('A COUNT THAT CANNOT ANSWER REFUSES THE RUN — it is not permission to trust the cache', async () => {
		const ws = makeWorkspace({ 'docs/a.md': DOC_V1 });
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		const first = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await runWsIndexWriter({ ...first, dryRun: false });
		const upsertsBefore = fake.upsertCalls.length;
		const deletesBefore = fake.deleteCalls.length;

		(fake as any).count = async () => { throw new Error('Request Timeout'); };
		const second = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		await expect(runWsIndexWriter({ ...second, dryRun: false })).rejects.toThrow(/refusing to trust a cache hit blind/);
		// the refusal lands before the sentinel claim and before any write
		expect(fake.upsertCalls).toHaveLength(upsertsBefore);
		expect(fake.deleteCalls).toHaveLength(deletesBefore);
	});
});

// ── claimWsWriter direct contract ─────────────────────────────────────────────

describe('claimWsWriter (#4736 P3)', () => {
	test('a foreign owner refuses without takeover; an explicit one records the previous owner', async () => {
		const fake = new FakeWsQdrant({ [COLLECTION]: {} });
		await claimWsWriter(fake, COLLECTION, 'lane-a', { hashPathPrefix: PREFIX, vector: [0, 0, 0, 0] });
		await expect(
			claimWsWriter(fake, COLLECTION, 'lane-b', { hashPathPrefix: PREFIX, vector: [0, 0, 0, 0] }),
		).rejects.toThrow(/lane-a/);
		await claimWsWriter(fake, COLLECTION, 'lane-b', { hashPathPrefix: PREFIX, vector: [0, 0, 0, 0], takeover: true });
		expect((await readWsWriterRecord(fake, COLLECTION))?.takenOverFrom).toBe('lane-a');
	});
});
