/**
 * #4736 P1 — tests for the shared ws-* collection contract.
 *
 * The naming formula, the path-variant ladder, the content-match fallback and
 * the read-only probe moved from search-codebase.tool.ts to this service layer
 * so the future writer imports the SAME functions the reader serves with. These
 * tests pin: the Zoo formula (anchored on measured live values), the variant
 * ladder's convergence rules, the re-export identity (tool and service expose
 * one function object, not copies) and the probe's read-only guarantee.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockGetQdrantClient, mockEmbeddingCreate } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockEmbeddingCreate: vi.fn(),
}));

// The identity test imports the reader tool file, whose graph pulls the qdrant
// service and the OpenAI SDK — mocked per the established pattern
// (search-codebase.tool.test.ts preamble) so the import stays hermetic.
vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient,
}));
vi.mock('openai', () => ({
	default: vi.fn(() => ({
		embeddings: { create: mockEmbeddingCreate },
	})),
}));

import {
	getWorkspaceCollectionName,
	getWorkspaceCollectionVariants,
	parseVectorsConfig,
	probeWorkspaceCollections,
	selectVariantCollection,
	findCollectionByContent,
} from '../collection-naming.js';

const wsOf = (path: string): string =>
	`ws-${createHash('sha256').update(path).digest('hex').substring(0, 16)}`;

describe('getWorkspaceCollectionName (#4736 P1 — the Zoo formula)', () => {
	it('is ws- + sha256(cleaned path)[0:16], no normalization of case or separators', () => {
		// Anchors measured live 14/11/2026 — ws-d2ffdbaa832aed16 is the collection
		// Zoo wrote for this repo when it lived at d:\dev\roo-extensions, and the
		// one codebase_search serves today via content match.
		expect(getWorkspaceCollectionName('D:/roo-extensions')).toBe('ws-0a36c8a5231b0658');
		const BS = String.fromCharCode(92);
		expect(getWorkspaceCollectionName('d:' + BS + 'dev' + BS + 'roo-extensions')).toBe('ws-d2ffdbaa832aed16');
	});

	it('collapses double-escaped backslashes and trailing separators before hashing', () => {
		const BS = String.fromCharCode(92);
		const once = 'C:' + BS + 'dev' + BS + 'project';
		expect(getWorkspaceCollectionName(once + BS + BS)).toBe(wsOf(once));
		expect(getWorkspaceCollectionName('C:/dev/project/')).toBe(wsOf('C:/dev/project'));
	});

	it('is deterministic for the same input', () => {
		expect(getWorkspaceCollectionName('d:\\test')).toBe(getWorkspaceCollectionName('d:\\test'));
		expect(getWorkspaceCollectionName('d:\\test')).not.toBe(getWorkspaceCollectionName('d:\\other'));
	});
});

describe('getWorkspaceCollectionVariants (#3344 convergence)', () => {
	it('contains the primary name and the exact-hash variant set', () => {
		const variants = getWorkspaceCollectionVariants('D:/Dev/repo');
		expect(variants[0]).toBe(getWorkspaceCollectionName('D:/Dev/repo'));
		expect(variants).toContain(wsOf('d:/Dev/repo'));
		expect(variants).toContain(wsOf('D:\\Dev\\repo'));
		expect(variants).toContain(wsOf('d:\\Dev\\repo'));
		expect(new Set(variants).size).toBe(variants.length); // deduplicated
	});

	it('mirrors lowercase-drive spellings for an uppercase-drive input (#3344 branch 6)', () => {
		const variants = getWorkspaceCollectionVariants('D:\\Dev\\CoursIA-2');
		expect(variants).toContain(wsOf('d:\\Dev\\CoursIA-2'));
		expect(variants).toContain(wsOf('d:/Dev/CoursIA-2'));
	});

	it('mirrors uppercase-drive spellings for a lowercase-drive input (#3344 branch 5)', () => {
		const variants = getWorkspaceCollectionVariants('d:/dev/repo');
		expect(variants).toContain(wsOf('D:/dev/repo'));
		expect(variants).toContain(wsOf('D:\\dev\\repo'));
	});
});

describe('reader re-export identity (#4736 P1 — one contract, not two copies)', () => {
	it('exposes the SAME function objects the reader imports', async () => {
		const reader = await import('../../../tools/search/search-codebase.tool.js');
		expect(reader.getWorkspaceCollectionName).toBe(getWorkspaceCollectionName);
		expect(reader.getWorkspaceCollectionVariants).toBe(getWorkspaceCollectionVariants);
		expect(reader.findCollectionByContent).toBe(findCollectionByContent);
		expect(reader.selectVariantCollection).toBe(selectVariantCollection);
	});
});

describe('parseVectorsConfig', () => {
	it('reads size and distance from the unnamed vectors shape', () => {
		expect(parseVectorsConfig({ config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } }))
			.toEqual({ size: 2560, distance: 'Cosine' });
	});

	it('reads through the named-vectors shape (first named vector)', () => {
		expect(parseVectorsConfig({ config: { params: { vectors: { default: { size: 1536, distance: 'Euclid' } } } } }))
			.toEqual({ size: 1536, distance: 'Euclid' });
	});

	it('defaults distance to Cosine and returns null when no config is readable', () => {
		expect(parseVectorsConfig({ config: { params: { vectors: { size: 64 } } } }))
			.toEqual({ size: 64, distance: 'Cosine' });
		expect(parseVectorsConfig(null)).toBeNull();
		expect(parseVectorsConfig({ config: { params: {} } })).toBeNull();
	});
});

describe('probeWorkspaceCollections (#4736 P1 — read-only resolution probe)', () => {
	const absent = (name: string) => {
		const err = new Error(`Collection ${name} not found!`);
		(Object as any).assign(err, { status: 404 });
		throw err;
	};

	it('resolves by hash when a variant exists, and returns its vector config', async () => {
		const ws = 'X:/ws';
		const existing = wsOf(ws);
		const client = {
			getCollection: vi.fn((name: string) => {
				if (name === existing) {
					return { points_count: 5, config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } };
				}
				absent(name);
			}),
			upsert: vi.fn(),
			createCollection: vi.fn(),
			delete: vi.fn(),
		};
		const probe = await probeWorkspaceCollections(client as any, ws);
		expect(probe.primary).toBe(existing);
		expect(probe.resolved).toBe(existing);
		expect(probe.resolved_by).toBe('hash');
		expect(probe.resolved_vectors).toEqual({ size: 2560, distance: 'Cosine' });
		expect(probe.writes).toBe('none');
		expect(client.upsert).not.toHaveBeenCalled();
		expect(client.createCollection).not.toHaveBeenCalled();
		expect(client.delete).not.toHaveBeenCalled();
	});

	it('marks proven-absent variants exists:false without an error, transport failures with one', async () => {
		const ws = 'X:/ws';
		const client = {
			getCollection: vi.fn(() => absent('whatever')),
		};
		const probe = await probeWorkspaceCollections(client as any, ws);
		expect(probe.existing).toEqual([]);
		expect(probe.resolved).toBeNull();
		expect(probe.variants.every(v => !v.exists && !v.error)).toBe(true);

		const unreachable = { getCollection: vi.fn(() => { throw new Error('fetch failed ECONNREFUSED'); }) };
		const probe2 = await probeWorkspaceCollections(unreachable as any, ws);
		expect(probe2.variants.every(v => !v.exists && v.error)).toBe(true);
	});

	it('falls back to content match when no variant exists, mirroring the reader', async () => {
		const root = mkdtempSync(join(tmpdir(), 'p1-probe-'));
		try {
			// Workspace dirs: two discriminant (alpha, beta) + generic ones (src, docs)
			// so Jaccard sinks below 0.6 and acceptance must come via overlap — the
			// measured live shape for roo-extensions (jaccard 0.25 / overlap 0.888).
			for (const d of ['alpha', 'beta', 'src', 'docs']) mkdirSync(join(root, d));
			writeFileSync(join(root, 'alpha', 'x.ts'), 'export const x = 1;');
			writeFileSync(join(root, 'beta', 'y.ts'), 'export const y = 2;');

			const twin = wsOf(String.raw`q:\moved\elsewhere`);
			const client = {
				getCollection: vi.fn((name: string) => {
					if (name === twin) {
						return { points_count: 10, config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } };
					}
					absent(name);
				}),
				getCollections: vi.fn(() => ({ collections: [{ name: 'roo_tasks_semantic_index' }, { name: twin }] })),
				scroll: vi.fn(() => ({
					points: [
						{ payload: { pathSegments: { 0: 'alpha' }, filePath: 'alpha/x.ts' } },
						{ payload: { pathSegments: { 0: 'beta' }, filePath: 'beta/y.ts' } },
					],
				})),
				upsert: vi.fn(),
				createCollection: vi.fn(),
				delete: vi.fn(),
			};
			const probe = await probeWorkspaceCollections(client as any, root);
			expect(probe.resolved).toBe(twin);
			expect(probe.resolved_by).toBe('content-match');
			expect(probe.resolved_vectors).toEqual({ size: 2560, distance: 'Cosine' });
			expect(probe.content_match?.candidates_total).toBe(1);
			expect(probe.content_match?.match?.accepted_via).toBe('overlap');
			expect(client.upsert).not.toHaveBeenCalled();
			expect(client.createCollection).not.toHaveBeenCalled();
			expect(client.delete).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('falls back when the hash ladder resolves only an EMPTY collection', async () => {
		const root = mkdtempSync(join(tmpdir(), 'p1-empty-'));
		try {
			for (const d of ['alpha', 'beta']) mkdirSync(join(root, d));
			writeFileSync(join(root, 'alpha', 'x.ts'), 'x');
			writeFileSync(join(root, 'beta', 'y.ts'), 'y');
			const empty = wsOf(root);
			const twin = wsOf(String.raw`q:\moved\somewhere-else`);
			const client = {
				getCollection: vi.fn((name: string) => {
					if (name === empty) return { points_count: 0, config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } };
					if (name === twin) return { points_count: 7, config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } };
					absent(name);
				}),
				getCollections: vi.fn(() => ({ collections: [{ name: empty }, { name: twin }] })),
				scroll: vi.fn(() => ({
					points: [
						{ payload: { pathSegments: { 0: 'alpha' }, filePath: 'alpha/x.ts' } },
						{ payload: { pathSegments: { 0: 'beta' }, filePath: 'beta/y.ts' } },
					],
				})),
			};
			const probe = await probeWorkspaceCollections(client as any, root);
			// The ladder DID resolve — to the empty spelling — and the probe refused to
			// serve it, exactly like the reader (matched-but-empty → content fallback).
			expect(probe.hash_resolution.collection).toBe(empty);
			expect(probe.resolved).toBe(twin);
			expect(probe.resolved_by).toBe('content-match');
			expect(probe.content_match?.match?.name).toBe(twin);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports exists:false with an error when the client cannot read collections at all', async () => {
		const probe = await probeWorkspaceCollections({} as any, 'X:/ws');
		expect(probe.variants.length).toBeGreaterThan(0);
		expect(probe.variants.every(v => !v.exists && v.error === 'client has no getCollection')).toBe(true);
		expect(probe.resolved).toBeNull();
		expect(probe.resolved_by).toBe('none');
	});
});
