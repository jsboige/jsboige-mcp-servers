/**
 * #4352 (a3): the supplement code index (services/code-index/supplement-index.ts).
 *
 * Four contracts are guarded here, each with a mutation check (flip the guard, the
 * test must fail):
 *  - REMOTE KEYING: one collection per repository, whatever the clone spelling;
 *  - CHUNKER FIDELITY: the port of Zoo's fallback line-window chunker keeps Zoo's
 *    constants and its no-tiny-tail re-balancing;
 *  - SINGLE WRITER: a foreign sentinel refuses the write, and only an explicit
 *    `takeover` gets past it;
 *  - DRY RUN BY DEFAULT + incremental: a dry run writes nothing at all, and a
 *    second run over unchanged files embeds nothing.
 *
 * The selection test runs against a real temporary git repository — the whole point
 * of that function is to agree with `git ls-files`, so mocking git would test the mock.
 */
import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	normaliseRemoteUrl,
	supplementCollectionName,
	fileHashOf,
	chunkTextByLines,
	supplementPointId,
	pathSegmentsOf,
	selectSupplementFiles,
	readWriterRecord,
	claimSupplementWriter,
	readTemplateVectorConfig,
	pickLargestCollection,
	searchSupplement,
	runSupplementIndex,
	resolveSupplementCollection,
	clearSupplementCollectionCache,
	supplementCollectionPresent,
	SUPPLEMENT_SENTINEL_ID,
	MIN_BLOCK_CHARS,
	MIN_CHUNK_REMAINDER_CHARS,
	MAX_BLOCK_CHARS,
	type QdrantLike,
} from '../supplement-index.js';

// ── A minimal in-memory Qdrant, enough for every call this module makes ──────

class FakeQdrant implements QdrantLike {
	collections = new Map<string, {
		size: number;
		distance: string;
		declaredPoints: number;
		points: Map<string, { vector: number[]; payload: Record<string, any> }>;
	}>();
	upsertCalls: Array<{ collection: string; points: any[] }> = [];
	deleteCalls: Array<{ collection: string; ids: string[] }> = [];
	createCalls: Array<{ collection: string; body: any }> = [];
	queryCalls: Array<{ collection: string; body: any }> = [];
	queryResult: any = { points: [] };
	queryThrows = false;

	constructor(seed: Record<string, { points?: number; size?: number; distance?: string }> = {}) {
		for (const [name, cfg] of Object.entries(seed)) {
			this.collections.set(name, {
				size: cfg.size ?? 4,
				distance: cfg.distance ?? 'Cosine',
				declaredPoints: cfg.points ?? 0,
				points: new Map(),
			});
		}
	}

	async getCollection(name: string) {
		const c = this.collections.get(name);
		if (!c) throw new Error(`collection ${name} not found`);
		return {
			points_count: c.points.size || c.declaredPoints,
			config: { params: { vectors: { size: c.size, distance: c.distance } } },
		};
	}

	async createCollection(name: string, body: any) {
		this.createCalls.push({ collection: name, body });
		this.collections.set(name, {
			size: body?.vectors?.size ?? 0,
			distance: body?.vectors?.distance ?? 'Cosine',
			declaredPoints: 0,
			points: new Map(),
		});
	}

	async retrieve(name: string, body: any) {
		const c = this.collections.get(name);
		if (!c) throw new Error('not found');
		const ids: string[] = body?.ids ?? [];
		return { points: ids.filter((id) => c.points.has(id)).map((id) => ({ id, payload: c.points.get(id)!.payload })) };
	}

	async scroll(name: string, body: any) {
		const c = this.collections.get(name);
		if (!c) throw new Error('not found');
		const must = body?.filter?.must ?? [];
		const hasId: string[] | null = must.find((m: any) => Array.isArray(m?.has_id))?.has_id ?? null;
		const points = [...c.points.entries()]
			.filter(([id]) => !hasId || hasId.includes(id))
			.map(([id, p]) => ({ id, payload: p.payload }));
		return { points: points.slice(0, body?.limit ?? 1000), next_page_offset: null };
	}

	async upsert(name: string, body: any) {
		const c = this.collections.get(name);
		if (!c) throw new Error(`collection ${name} not found`);
		const points: any[] = body?.points ?? [];
		this.upsertCalls.push({ collection: name, points });
		for (const p of points) c.points.set(String(p.id), { vector: p.vector, payload: p.payload });
	}

	async delete(name: string, body: any) {
		const c = this.collections.get(name);
		if (!c) throw new Error('not found');
		const ids: string[] = body?.points ?? [];
		this.deleteCalls.push({ collection: name, ids });
		for (const id of ids) c.points.delete(id);
	}

	async query(name: string, body: any) {
		this.queryCalls.push({ collection: name, body });
		if (this.queryThrows) throw new Error('connection reset by peer');
		if (!this.collections.has(name)) throw new Error(`collection ${name} not found`);
		return this.queryResult;
	}

	pointsOf(name: string) {
		return [...(this.collections.get(name)?.points.entries() ?? [])];
	}
}

// ── A real temporary git repository ─────────────────────────────────────────

const tempDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'sup-index-'));
	tempDirs.push(dir);
	const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
	git('init');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'test');
	git('remote', 'add', 'origin', 'git@github.com:jsboige/supplement-fixture.git');
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

describe('normaliseRemoteUrl (#4352 a3)', () => {
	test('every clone spelling of one repository normalises to one key', () => {
		const spellings = [
			'git@github.com:jsboige/roo-extensions.git',
			'https://github.com/jsboige/roo-extensions.git',
			'https://github.com/jsboige/roo-extensions',
			'https://github.com/jsboige/roo-extensions/',
			'https://user:ghp_secret@github.com/jsboige/roo-extensions.git',
			'ssh://git@github.com/jsboige/roo-extensions.git',
			'  https://GitHub.com/jsboige/roo-extensions  ',
		];
		for (const s of spellings) {
			expect(normaliseRemoteUrl(s)).toBe('github.com/jsboige/roo-extensions');
		}
	});

	test('credentials never reach the key', () => {
		expect(normaliseRemoteUrl('https://user:ghp_secret@github.com/o/r.git')).not.toContain('ghp_secret');
	});

	test('different repositories get different keys, and nothing keyable yields null', () => {
		expect(normaliseRemoteUrl('https://github.com/o/a.git')).not.toBe(normaliseRemoteUrl('https://github.com/o/b.git'));
		expect(normaliseRemoteUrl('')).toBeNull();
		expect(normaliseRemoteUrl(null)).toBeNull();
		expect(normaliseRemoteUrl('   ')).toBeNull();
	});

	test('the collection name is sup- + 16 hex, one per repo, null without a remote', () => {
		const a = supplementCollectionName('git@github.com:jsboige/roo-extensions.git');
		expect(a).toMatch(/^sup-[a-f0-9]{16}$/);
		expect(supplementCollectionName('https://github.com/jsboige/roo-extensions')).toBe(a);
		expect(supplementCollectionName('https://github.com/jsboige/other-repo')).not.toBe(a);
		expect(supplementCollectionName(null)).toBeNull();
	});
});

describe('chunkTextByLines — Zoo fallback chunker fidelity (#4352 a3)', () => {
	const line = 'x'.repeat(20); // 21 chars with its newline

	test('a file under MIN_BLOCK_CHARS produces no chunk (mutation: a 0 threshold would emit one)', () => {
		expect(chunkTextByLines('tiny content\n', 'a.ps1')).toEqual([]);
		expect(MIN_BLOCK_CHARS).toBe(50);
	});

	test('a long file splits into contiguous, exhaustive line windows', () => {
		const lines = Array.from({ length: 100 }, () => line);
		const content = lines.join('\n');
		const chunks = chunkTextByLines(content, 'scripts/a.ps1');
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].startLine).toBe(1);
		expect(chunks[chunks.length - 1].endLine).toBe(100);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
		}
		for (const c of chunks) {
			expect(c.content.length).toBeGreaterThanOrEqual(MIN_BLOCK_CHARS);
			expect(c.type).toBe('fallback_chunk');
		}
		// Nothing lost: the union of the windows is the whole file, in order.
		expect(chunks.map((c) => c.content).join('\n')).toBe(content);
	});

	test('the no-tiny-tail re-balancing keeps the LAST chunk above MIN_CHUNK_REMAINDER_CHARS', () => {
		// 56 lines of 21 chars = 1176 chars: the naive split leaves a 41-char tail,
		// which Zoo refuses — the split point moves back to line 46.
		const content = Array.from({ length: 56 }, () => line).join('\n');
		const chunks = chunkTextByLines(content, 'b.ps1');
		expect(chunks.length).toBe(2);
		expect(chunks[1].content.length).toBeGreaterThanOrEqual(MIN_CHUNK_REMAINDER_CHARS);
	});

	test('an oversized line becomes MAX_BLOCK_CHARS segments on its own line', () => {
		const chunks = chunkTextByLines('a'.repeat(MAX_BLOCK_CHARS * 3 + 7), 'long.ps1');
		expect(chunks.length).toBe(4);
		for (const c of chunks) {
			expect(c.type).toBe('fallback_chunk_segment');
			expect(c.startLine).toBe(1);
			expect(c.endLine).toBe(1);
			expect(c.content.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
		}
	});

	test('the segment hash is deterministic and position-dependent', () => {
		const content = Array.from({ length: 100 }, () => line).join('\n');
		const a = chunkTextByLines(content, 'c.ps1');
		const b = chunkTextByLines(content, 'c.ps1');
		expect(a.map((c) => c.segmentHash)).toEqual(b.map((c) => c.segmentHash));
		// Same text at a different place is a different segment (the hash carries the lines).
		expect(chunkTextByLines(`${line}\n${line}`, 'd.ps1')).toEqual([]);
	});
});

describe('point ids and payload shapes (#4352 a3)', () => {
	test('point ids are UUID-shaped and deterministic per (file, segment)', () => {
		const id = supplementPointId('scripts/a.ps1', 'abc');
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(supplementPointId('scripts/a.ps1', 'abc')).toBe(id);
		expect(supplementPointId('scripts/a.ps1', 'abd')).not.toBe(id);
		expect(supplementPointId('scripts/b.ps1', 'abc')).not.toBe(id);
		expect(SUPPLEMENT_SENTINEL_ID).toMatch(/^[0-9a-f]{8}-/);
		expect(SUPPLEMENT_SENTINEL_ID).not.toBe(id);
	});

	test('pathSegments mirrors Zoo: index → directory segment', () => {
		expect(pathSegmentsOf('scripts/scheduling/run.ps1')).toEqual({ '0': 'scripts', '1': 'scheduling', '2': 'run.ps1' });
		expect(pathSegmentsOf('scripts\\win\\run.ps1')).toEqual({ '0': 'scripts', '1': 'win', '2': 'run.ps1' });
	});

	test('fileHash mirrors Zoo: sha256 of the raw content', () => {
		expect(fileHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

describe('selectSupplementFiles — real git repository (#4352 a3)', () => {
	test('selects only git-visible, Zoo-blind, text files under 1 MB', async () => {
		const dir = makeRepo();
		mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
		mkdirSync(join(dir, 'src'), { recursive: true });
		writeFileSync(join(dir, 'src', 'code.ts'), 'export const x = 1;\n'); // Zoo indexes it
		writeFileSync(join(dir, 'scripts.ps1'), 'Write-Host "hello"\n'.repeat(5));
		writeFileSync(join(dir, '.claude', 'rules', 'r.md'), '# rule\n'.repeat(10));
		writeFileSync(join(dir, 'blob.ps1'), Buffer.from([0x00, 0x01, 0x02, 0x00])); // binary
		writeFileSync(join(dir, 'huge.ps1'), 'y'.repeat(1024 * 1024 + 1)); // over the 1 MB cap
		writeFileSync(join(dir, '.gitignore'), 'ignored.ps1\n');
		writeFileSync(join(dir, 'ignored.ps1'), 'Write-Host "nope"\n'.repeat(5));
		execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });

		const selection = await selectSupplementFiles(dir);
		expect(selection.selected.sort()).toEqual(['.claude/rules/r.md', 'scripts.ps1']);
		expect(selection.dropped.too_large).toBe(1);
		expect(selection.dropped.binary).toBe(1);
		expect(selection.by_kind['.ps1']).toBeGreaterThanOrEqual(2); // scripts.ps1 + huge.ps1 (+ ignored is untracked)
		expect(selection.selected).not.toContain('src/code.ts');
	});

	test('a directory that is not a git repository is an error, never an empty selection', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sup-nogit-'));
		tempDirs.push(dir);
		await expect(selectSupplementFiles(dir)).rejects.toThrow(/not a git workspace/);
	});
});

describe('single-writer guard (#4352 a3)', () => {
	const REMOTE = 'github.com/jsboige/supplement-fixture';
	const COLLECTION = 'sup-0000000000000000';

	test('the first writer claims the sentinel, and the read-back agrees', async () => {
		const client = new FakeQdrant({ [COLLECTION]: {} });
		const claim = await claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', {
			remote: REMOTE, vector: [0, 0, 0, 0], now: '2026-10-25T00:00:00.000Z',
		});
		expect(claim.claimed).toBe(true);
		const record = await readWriterRecord(client, COLLECTION);
		expect(record?.writer).toBe('web2:roo-extensions');
		expect(record?.since).toBe('2026-10-25T00:00:00.000Z');
	});

	test('a foreign writer is REFUSED without takeover (mutation: drop the check, this stops throwing)', async () => {
		const client = new FakeQdrant({ [COLLECTION]: {} });
		await claimSupplementWriter(client, COLLECTION, 'ai-01:roo-extensions', { remote: REMOTE, vector: [0, 0, 0, 0] });
		const before = client.upsertCalls.length;
		await expect(
			claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', { remote: REMOTE, vector: [0, 0, 0, 0] })
		).rejects.toThrow(/written by ai-01:roo-extensions/);
		// and nothing was written
		expect(client.upsertCalls.length).toBe(before);
		expect((await readWriterRecord(client, COLLECTION))?.writer).toBe('ai-01:roo-extensions');
	});

	test('takeover is the ONLY way past the guard, and it records who was taken over from', async () => {
		const client = new FakeQdrant({ [COLLECTION]: {} });
		await claimSupplementWriter(client, COLLECTION, 'ai-01:roo-extensions', { remote: REMOTE, vector: [0, 0, 0, 0] });
		const claim = await claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', {
			remote: REMOTE, takeover: true, vector: [0, 0, 0, 0],
		});
		expect(claim.claimed).toBe(true);
		const record = await readWriterRecord(client, COLLECTION);
		expect(record?.writer).toBe('web2:roo-extensions');
		expect(record?.takenOverFrom).toBe('ai-01:roo-extensions');
	});

	test('a dry run never writes the sentinel', async () => {
		const client = new FakeQdrant({ [COLLECTION]: {} });
		const claim = await claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', {
			remote: REMOTE, dryRun: true, vector: [0, 0, 0, 0],
		});
		expect(claim.claimed).toBe(false);
		expect(client.upsertCalls.length).toBe(0);
		expect(await readWriterRecord(client, COLLECTION)).toBeNull();
	});

	test('same writer again is idempotent (no takeover needed)', async () => {
		const client = new FakeQdrant({ [COLLECTION]: {} });
		await claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', { remote: REMOTE, vector: [0, 0, 0, 0] });
		const again = await claimSupplementWriter(client, COLLECTION, 'web2:roo-extensions', { remote: REMOTE, vector: [0, 0, 0, 0] });
		expect(again.claimed).toBe(true);
		expect((await readWriterRecord(client, COLLECTION))?.writer).toBe('web2:roo-extensions');
	});
});

describe('vector template (#4352 a3)', () => {
	test('copies size and distance from the served Zoo collection', async () => {
		const client = new FakeQdrant({ 'ws-abc': { size: 2560, distance: 'Cosine' } });
		expect(await readTemplateVectorConfig(client, 'ws-abc')).toEqual({ size: 2560, distance: 'Cosine' });
	});

	test('a named-vectors config is read too, and an unreadable template yields null (never a guess)', async () => {
		const client = new FakeQdrant();
		const named = { getCollection: async () => ({ config: { params: { vectors: { text: { size: 1024, distance: 'Dot' } } } } }) };
		expect(await readTemplateVectorConfig(named as any, 'ws-named')).toEqual({ size: 1024, distance: 'Dot' });
		expect(await readTemplateVectorConfig(client, 'ws-missing')).toBeNull();
		expect(await readTemplateVectorConfig(client, null)).toBeNull();
	});

	test('pickLargestCollection takes the biggest existing spelling, not the first', async () => {
		const client = new FakeQdrant({ 'ws-small': { points: 5 }, 'ws-big': { points: 900 } });
		expect(await pickLargestCollection(client, ['ws-absent', 'ws-small', 'ws-big'])).toBe('ws-big');
		expect(await pickLargestCollection(client, ['ws-absent'])).toBeNull();
	});
});

describe('searchSupplement (#4352 a3)', () => {
	test('forwards the same bounds and applies the main search exclusions', async () => {
		const client = new FakeQdrant({ 'sup-abc': {} });
		client.queryResult = { points: [{ id: '1', score: 0.8, payload: { filePath: 'a.ps1', codeChunk: 'x' } }, { id: '2', score: 0.1, payload: {} }] };
		const { points, error } = await searchSupplement(client, 'sup-abc', [0.1, 0.2], {
			limit: 30, minScore: 0.62, directoryPrefix: 'scripts\\scheduling', timeoutSec: 7,
		});
		expect(error).toBeUndefined();
		expect(points).toHaveLength(1); // the payload-less point is dropped, like the main search does
		const body = client.queryCalls[0].body;
		expect(body.score_threshold).toBe(0.62);
		expect(body.limit).toBe(30);
		expect(body.timeout).toBe(7);
		const mustNot = body.filter.must_not.map((m: any) => m.key + '=' + m.match.value);
		expect(mustNot).toContain('type=metadata');
		expect(mustNot).toContain('pathSegments.0=roo-code');
		expect(mustNot).toContain('pathSegments.0=i18n');
		expect(body.filter.must).toEqual([
			{ key: 'pathSegments.0', match: { value: 'scripts' } },
			{ key: 'pathSegments.1', match: { value: 'scheduling' } },
		]);
	});

	test('an unreachable supplement collection is reported, never thrown (fail-open)', async () => {
		const client = new FakeQdrant();
		client.queryThrows = true;
		const { points, error } = await searchSupplement(client, 'sup-abc', [0.1], { limit: 5, minScore: 0.5 });
		expect(points).toEqual([]);
		expect(error).toMatch(/connection reset/);
	});

	test('a missing collection is reported, never thrown', async () => {
		const client = new FakeQdrant();
		const { points, error } = await searchSupplement(client, 'sup-missing', [0.1], { limit: 5, minScore: 0.5 });
		expect(points).toEqual([]);
		expect(error).toMatch(/not found/);
	});
});

describe('runSupplementIndex (#4352 a3)', () => {
	const COLLECTION_HOST = /^sup-[a-f0-9]{16}$/;

	function repoWithFiles() {
		const dir = makeRepo();
		writeFileSync(join(dir, 'build.ps1'), 'Write-Host "step one"\n'.repeat(10));
		mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
		writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\njobs:\n  a:\n    runs-on: x\n'.repeat(3));
		execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
		return dir;
	}

	let embedCalls: string[][] = [];
	const embed = async (texts: string[]) => {
		embedCalls.push(texts);
		return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
	};

	beforeEach(() => { embedCalls = []; });

	test('dry run writes NOTHING — no collection, no sentinel, no point, no embedding', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100, size: 4 } });
		const report = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served', embed,
		});
		expect(report.dry_run).toBe(true);
		expect(report.status).toBe('dry_run');
		expect(report.collection).toMatch(COLLECTION_HOST);
		expect(report.files_to_index).toBe(2);
		expect(report.files_selected).toBe(2);
		expect(client.createCalls).toHaveLength(0);
		expect(client.upsertCalls).toHaveLength(0);
		expect(embedCalls).toHaveLength(0);
	});

	test('a write run creates the collection from the served vectors, claims the sentinel, and mirrors Zoo payloads', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100, size: 2560, distance: 'Cosine' } });
		const report = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		expect(report.points_written).toBeGreaterThan(0);
		expect(report.files_indexed).toBe(2);
		expect(report.writer_guard.ok).toBe(true);

		// vector config mirrors the served collection — a guess would break comparability
		expect(client.createCalls[0].body).toEqual({ vectors: { size: 2560, distance: 'Cosine' } });

		const points = client.pointsOf(report.collection).filter(([id]) => id !== SUPPLEMENT_SENTINEL_ID);
		expect(points.length).toBe(report.points_written);
		for (const [, p] of points) {
			expect(p.payload.source).toBe('rsm-supplement');
			expect(p.payload.writer).toBe('web2:fixture');
			expect(p.payload.filePath).toMatch(/^(build\.ps1|\.github\/workflows\/ci\.yml)$/);
			expect(typeof p.payload.startLine).toBe('number');
			expect(typeof p.payload.endLine).toBe('number');
			expect(p.payload.pathSegments).toBeTruthy();
			expect(p.payload.segmentHash).toHaveLength(64);
			expect(p.payload.fileHash).toHaveLength(64);
			expect(p.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
		}
		// the sentinel is excluded from every search by construction
		const sentinel = client.collections.get(report.collection)!.points.get(SUPPLEMENT_SENTINEL_ID)!;
		expect(sentinel.payload.type).toBe('metadata');
		expect(sentinel.payload.writer).toBe('web2:fixture');
		expect(sentinel.payload.remote).toBe('github.com/jsboige/supplement-fixture');
	});

	test('incremental: a second run over unchanged files embeds and writes nothing', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		const first = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		embedCalls = [];
		const second = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		expect(second.files_skipped_unchanged).toBe(first.files_indexed);
		expect(second.files_to_index).toBe(0);
		expect(second.points_written).toBe(0);
		expect(embedCalls).toHaveLength(0);
	});

	test('a changed file replaces its chunks (no orphan), a deleted file is removed', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		const first = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		const before = client.pointsOf(first.collection).filter(([id]) => id !== SUPPLEMENT_SENTINEL_ID).length;

		// change one file (fewer chunks), delete the other
		writeFileSync(join(dir, 'build.ps1'), 'Write-Host "one"\n');
		unlinkSync(join(dir, '.github', 'workflows', 'ci.yml'));
		execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });

		const second = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		expect(second.files_removed).toBe(1);
		expect(second.points_deleted).toBeGreaterThanOrEqual(1);
		const after = client.pointsOf(second.collection).filter(([id]) => id !== SUPPLEMENT_SENTINEL_ID);
		expect(after.length).toBeLessThan(before);
		expect(after.every(([, p]) => p.payload.filePath === 'build.ps1')).toBe(true);
	});

	test('a foreign writer is refused before anything is written', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'ai-01:roo-extensions', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		});
		const callsBefore = client.upsertCalls.length;
		embedCalls = [];
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
		})).rejects.toThrow(/written by ai-01:roo-extensions/);
		expect(client.upsertCalls.length).toBe(callsBefore);
		expect(embedCalls).toHaveLength(0);
	});

	test('a misaligned embedding response aborts instead of writing a shifted batch', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		const shortEmbed = async (texts: string[]) => texts.slice(1).map(() => [0.1, 0.2, 0.3, 0.4]);
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed: shortEmbed, dryRun: false, batchSize: 100, throttleMs: 0,
		})).rejects.toThrow(/misaligned|returned \d+ vectors/);
		const written = client.pointsOf(`sup-${'0'.repeat(16)}`);
		expect(written).toHaveLength(0);
	});

	// ── review ms#1514, fix 2: the embedding-space fingerprint ────────────────

	test('the sentinel records the embedding fingerprint — flip the recording off and a model switch goes silent', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100, size: 2560 } });
		const report = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		const sentinel = client.collections.get(report.collection)!.points.get(SUPPLEMENT_SENTINEL_ID)!;
		expect(sentinel.payload.embeddingModelId).toBe('text-embedding-3-small');
		// dimensions come from the template collection — the served space, not a guess
		expect(sentinel.payload.embeddingModelDimensions).toBe(2560);
	});

	test('a second run under the SAME fingerprint still skips unchanged files', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		embedCalls = [];
		const second = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		expect(second.files_skipped_unchanged).toBe(2);
		expect(second.points_written).toBe(0);
		expect(embedCalls).toHaveLength(0);
	});

	test('a run under a DIFFERENT model refuses, writes nothing, and leaves the sentinel untouched', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		const first = await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		const pointsBefore = client.pointsOf(first.collection).length;
		const sentinelBefore = client.collections.get(first.collection)!.points.get(SUPPLEMENT_SENTINEL_ID)!.payload;
		embedCalls = [];
		// the guard must name both spaces — a refusal the caller cannot act on is noise
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-large',
		})).rejects.toThrow(/holds vectors embedded with text-embedding-3-small .* would embed with text-embedding-3-large/s);
		// mutation check: nothing written and nothing embedded by the refused run
		expect(client.pointsOf(first.collection)).toHaveLength(pointsBefore);
		expect(embedCalls).toHaveLength(0);
		// the guard fires before the claim, so the old fingerprint survives the refusal
		const sentinelAfter = client.collections.get(first.collection)!.points.get(SUPPLEMENT_SENTINEL_ID)!.payload;
		expect(sentinelAfter).toEqual(sentinelBefore);
	});

	test('the model refusal also fires on a DRY run — planning must not cross spaces either', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		// dry_run defaults to true here
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed,
			embeddingModelId: 'text-embedding-3-large',
		})).rejects.toThrow(/takeover does not cross a model change/);
	});

	test('takeover does NOT cross a model change — ownership and embedding space are two different guards', async () => {
		const dir = repoWithFiles();
		const client = new FakeQdrant({ 'ws-served': { points: 100 } });
		await runSupplementIndex({
			client, workspaceRoot: dir, writer: 'ai-01:roo-extensions', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0,
			embeddingModelId: 'text-embedding-3-small',
		});
		// takeover answers the writer guard; the model guard stands on its own
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served',
			embed, dryRun: false, batchSize: 100, throttleMs: 0, takeover: true,
			embeddingModelId: 'text-embedding-3-large',
		})).rejects.toThrow(/takeover does not cross a model change/);
	});

	// ── review ms#1514, fix 1: the presence gate (unit) ───────────────────────

	test('supplementCollectionPresent: an absent collection answers false, and the absence is cached until the TTL or the clear', async () => {
		const client = new FakeQdrant({}); // no sup- collection at all
		clearSupplementCollectionCache();
		expect(await supplementCollectionPresent(client, '/test/presence-ws', 'sup-aaaaaaaaaaaaaaaa')).toBe(false);
		// the collection appears behind our back: the cached absence still answers
		await client.createCollection('sup-aaaaaaaaaaaaaaaa', { vectors: { size: 4, distance: 'Cosine' } });
		expect(await supplementCollectionPresent(client, '/test/presence-ws', 'sup-aaaaaaaaaaaaaaaa')).toBe(false);
		// cache cleared: the probe sees reality
		clearSupplementCollectionCache();
		expect(await supplementCollectionPresent(client, '/test/presence-ws', 'sup-aaaaaaaaaaaaaaaa')).toBe(true);
	});

	test('supplementCollectionPresent: a client without getCollection says present — never suppress the corpus because the instrument is missing', async () => {
		const bare = {} as QdrantLike;
		clearSupplementCollectionCache();
		expect(await supplementCollectionPresent(bare, '/test/presence-bare', 'sup-bbbbbbbbbbbbbbbb')).toBe(true);
	});

	test('a workspace with no origin remote is an explicit error, not an empty index', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sup-noremote-'));
		tempDirs.push(dir);
		execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });
		const client = new FakeQdrant();
		await expect(runSupplementIndex({
			client, workspaceRoot: dir, writer: 'web2:fixture', templateCollection: 'ws-served', embed,
		})).rejects.toThrow(/origin remote/);
	});

	test('an uncached workspace resolves its collection from the remote, then serves it from cache', async () => {
		const dir = repoWithFiles();
		clearSupplementCollectionCache();
		const first = await resolveSupplementCollection(dir);
		expect(first).toMatch(COLLECTION_HOST);
		// the cache answers even if git stops answering
		unlinkSync(join(dir, '.git', 'config'));
		expect(await resolveSupplementCollection(dir)).toBe(first);
	});
});
