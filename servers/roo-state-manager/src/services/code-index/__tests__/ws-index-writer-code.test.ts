/**
 * #4819 suivi (coordinator queue 17/11) — the two writer-level behaviors the
 * parity tests do not pin: what the run does when a CODE parse throws, and
 * what the WS_WRITER_CODE_INDEXING=0 switch actually excludes.
 *
 *  - PARSE THROWS → the file is SKIPPED (never planned), its stored points
 *    survive the run, a warning names it. This is the corpus-destruction
 *    guard the runtime oracle caught: a load failure surfaced as `[]` would
 *    have made the file a legitimate "0-block rewrite" and the stale purge
 *    would have deleted its stored points (measured: 189 at risk).
 *  - KILL SWITCH =0 → code files are excluded at ENUMERATION (never
 *    candidates), P3 markdown-only behavior, stored code points untouched.
 *
 * The parse seam is forced by mocking zoo-code-parser's parseZooCodeContent
 * to throw — everything else (routing, switch, markdown port) stays real.
 */
import { describe, test, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

vi.mock('../zoo-code-parser.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../zoo-code-parser.js')>();
	return {
		...actual,
		parseZooCodeContent: () => {
			throw new Error('grammar load failed (forced by test)');
		},
	};
});

import {
	joinZooWriterPath,
	toNativeRel,
	runWsIndexWriter,
	wsWriterCachePointId,
	type WsIndexWriterDeps,
} from '../ws-index-writer.js';
import { parseZooMarkdownContent, toZooPointPayload, zooPointId } from '../zoo-parity.js';
import type { QdrantLike } from '../supplement-index.js';

const PREFIX = 'd:\\test\\ws';
const COLLECTION = 'ws-bbbbbbbbbbbbbbbb';
const MODEL = 'test-embedding-model';

// ── Minimal in-memory Qdrant (same SDK-shaped contract as ws-index-writer.test.ts) ──

class FakeWsQdrant implements QdrantLike {
	collections = new Map<string, { size: number; distance: string; points: Map<string, { vector: number[]; payload: any }> }>();
	upsertCalls: Array<{ collection: string; points: any[] }> = [];
	deleteCalls: Array<{ collection: string; ids: string[] }> = [];
	createCalls: Array<{ collection: string; body: any }> = [];

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
		this.collections.set(name, { size: body?.vectors?.size ?? 0, distance: body?.vectors?.distance ?? 'Cosine', points: new Map() });
	}

	async retrieve(name: string, body: any) {
		const c = this.col(name);
		const ids: string[] = body?.ids ?? [];
		return ids.filter((id) => c.points.has(id)).map((id) => ({ id, payload: c.points.get(id)!.payload }));
	}

	async scroll(name: string, body: any) {
		const c = this.col(name);
		const must: any[] = body?.filter?.must ?? [];
		const mustNot: any[] = body?.filter?.must_not ?? [];
		const matches = (payload: any) =>
			must.every((m: any) => String(payload?.[m.key]) === String(m.match?.value))
			&& mustNot.every((m: any) => String(payload?.[m.key]) !== String(m.match?.value));
		const points = [...c.points.entries()].filter(([, p]) => matches(p.payload)).map(([id, p]) => ({ id, payload: p.payload }));
		return { points: points.slice(0, body?.limit ?? 1000), next_page_offset: null };
	}

	async upsert(name: string, body: any) {
		const c = this.col(name);
		const points: any[] = body?.points ?? [];
		this.upsertCalls.push({ collection: name, points });
		for (const p of points) c.points.set(String(p.id), { vector: p.vector, payload: p.payload });
	}

	async delete(name: string, body: any) {
		const c = this.col(name);
		const ids: string[] = body?.points ?? [];
		this.deleteCalls.push({ collection: name, ids });
		for (const id of ids) c.points.delete(id);
	}
}

/** Zoo-shaped stored MARKDOWN points — gives the prefix gate something to verify. */
function seedMarkdownPoints(fake: FakeWsQdrant, collection: string, relPath: string, content: string): string[] {
	const c = fake.collections.get(collection)!;
	const blocks = parseZooMarkdownContent(joinZooWriterPath(PREFIX, toNativeRel(relPath)), content);
	const ids: string[] = [];
	for (const b of blocks) {
		const id = zooPointId(b.segmentHash);
		c.points.set(id, { vector: [0.5, 0.5, 0.5, 0.5], payload: toZooPointPayload(b, toNativeRel(relPath)) });
		ids.push(id);
	}
	return ids;
}

/**
 * Zoo-shaped stored CODE points with VALID segmentHashes (the 5-field
 * formula), so the prefix gate verifies them too — the subject here is the
 * purge decision, not the hash math.
 */
function seedCodePoints(fake: FakeWsQdrant, collection: string, relPath: string): string[] {
	const c = fake.collections.get(collection)!;
	const relNative = toNativeRel(relPath);
	const abs = joinZooWriterPath(PREFIX, relNative);
	const ids: string[] = [];
	for (let i = 0; i < 2; i++) {
		const content = `function stored${i}() { return ${i}; } // zoo-era code block payload`;
		const start = 1 + i * 10;
		const end = start + 5;
		const segmentHash = createHash('sha256')
			.update(`${abs}-${start}-${end}-${content.length}-${content.slice(0, 100)}`)
			.digest('hex');
		const id = zooPointId(segmentHash);
		c.points.set(id, {
			vector: [0.5, 0.5, 0.5, 0.5],
			payload: { filePath: relNative, codeChunk: content, startLine: start, endLine: end, segmentHash },
		});
		ids.push(id);
	}
	return ids;
}

// ── Workspace fixture ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeWorkspace(files: Record<string, string>): { root: string; listFiles: () => Promise<string[]> } {
	const root = mkdtempSync(join(tmpdir(), 'ws-writer-code-'));
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

const DOC_V1 = '# Title\n\n' + 'alpha line of content for the first section\n'.repeat(6)
	+ '## Part Two\n\n' + 'beta line of content for the second section\n'.repeat(6);
const TS_CODE = 'export function make(n: number): string {\n\treturn `v${n}`;\n}\n';

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
		writer: 'po-2028:roo-extensions',
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

// ── Parse throws → skip, never purge (#4819 follow-up) ────────────────────────

describe('runWsIndexWriter code path (#4819 suivi)', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test('PARSE THROWS — the file is skipped with its stored points preserved (a 0-blocks "rewrite" would purge them)', async () => {
		const ws = makeWorkspace({ 'docs/keep.md': DOC_V1, 'src/broken.ts': TS_CODE });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		seedMarkdownPoints(fake, COLLECTION, 'docs/keep.md', DOC_V1); // changed file, re-indexed below
		const storedCodeIds = seedCodePoints(fake, COLLECTION, 'src/broken.ts');
		// both files changed on disk → both reach the parse loop
		writeFileSync(join(ws.root, 'docs/keep.md'), DOC_V1 + '\n## Added\n\n' + 'delta line to force re-index\n'.repeat(4));

		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...deps, dryRun: false });

		// the run SUCCEEDS: a per-file parse failure is a warning, not a run failure
		expect(report.status).toBe('success');
		expect(report.code_indexing_enabled).toBe(true);
		// both were considered and planned-for-indexing; only the markdown landed
		expect(report.files_considered).toBe(2);
		expect(report.files_to_index).toBe(2);
		expect(report.files_indexed).toBe(1);
		// the warning names the file and says exactly what happened to it
		expect(report.warnings.some((w) => /src\/broken\.ts: parse failed .*— file skipped, stored points preserved/.test(w))).toBe(true);
		// DECISIVE: the stored code points survive the run (no purge, no rewrite)
		const points = fake.collections.get(COLLECTION)!.points;
		for (const id of storedCodeIds) expect(points.has(id)).toBe(true);
		// never planned → never cached either
		expect(points.has(wsWriterCachePointId('src/broken.ts'))).toBe(false);
		// only the markdown content was embedded
		const mdBlocks = parseZooMarkdownContent(joinZooWriterPath(PREFIX, toNativeRel('docs/keep.md')), DOC_V1 + '\n## Added\n\n' + 'delta line to force re-index\n'.repeat(4));
		expect((deps as any).embedLog.flat()).toHaveLength(mdBlocks.length);
	});

	test('KILL SWITCH — WS_WRITER_CODE_INDEXING=0 excludes code at enumeration: P3 population, stored code points untouched', async () => {
		vi.stubEnv('WS_WRITER_CODE_INDEXING', '0');
		const ws = makeWorkspace({ 'docs/keep.md': DOC_V1, 'src/code.ts': TS_CODE });
		const fake = new FakeWsQdrant({ [COLLECTION]: { size: 4 } });
		seedMarkdownPoints(fake, COLLECTION, 'docs/keep.md', DOC_V1);
		const storedCodeIds = seedCodePoints(fake, COLLECTION, 'src/code.ts');
		writeFileSync(join(ws.root, 'docs/keep.md'), DOC_V1 + '\n## Added\n\n' + 'delta line to force re-index\n'.repeat(4));

		const deps = baseDeps({ client: fake, workspaceRoot: ws.root, listFiles: ws.listFiles });
		const report = await runWsIndexWriter({ ...deps, dryRun: false });

		// the switch is reported OFF and the code file never even became a candidate
		expect(report.code_indexing_enabled).toBe(false);
		expect(report.files_considered).toBe(1);
		expect(report.files_to_index).toBe(1);
		expect(report.files_indexed).toBe(1);
		// no parse was attempted on the code file (the mock would have thrown a
		// warning had it reached the loop — and none is allowed here)
		expect(report.warnings.some((w) => /src\/code\.ts/.test(w))).toBe(false);
		// stored code points survive untouched; no cache point for the code file
		const points = fake.collections.get(COLLECTION)!.points;
		for (const id of storedCodeIds) expect(points.has(id)).toBe(true);
		expect(points.has(wsWriterCachePointId('src/code.ts'))).toBe(false);
	});
});
