/**
 * #4736 P1 — handler tests for roosync_indexing action=probe_code_index.
 *
 * The action is the read-only contract probe for the ws-* takeover: it replays
 * the reader's collection resolution (shared functions, collection-naming.ts)
 * and returns per-variant existence, points and vector config. These tests pin
 * the tool-boundary behavior: resolved equals the variant the shared naming
 * ladder finds, the vector config rides along, nothing writes, and an
 * unreachable Qdrant surfaces as an error instead of "no collection".
 */
import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'crypto';

const { mockGetQdrantClient, mockUpsert, mockCreateCollection, mockDelete, mockGetCollection, mockScroll, mockGetCollections } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockUpsert: vi.fn(),
	mockCreateCollection: vi.fn(),
	mockDelete: vi.fn(),
	mockGetCollection: vi.fn(),
	mockScroll: vi.fn(),
	mockGetCollections: vi.fn(),
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient,
}));

// readOriginUrl forks git — the probe only reports the supplement name, mock it
// hermetic (no remote → null).
vi.mock('../../../services/code-index/git-visible.js', () => ({
	readOriginUrl: vi.fn(async () => null),
	listGitVisiblePaths: vi.fn(async () => null),
}));

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

const wsOf = (path: string): string =>
	`ws-${createHash('sha256').update(path).digest('hex').substring(0, 16)}`;

const ensureFresh = vi.fn().mockResolvedValue(true);
const saveSkeleton = vi.fn();
const setEnabled = vi.fn();
const rebuildHandler = vi.fn();

const callProbe = (workspace?: string) => handleRooSyncIndexing(
	{ action: 'probe_code_index', ...(workspace ? { workspace } : {}) } as any,
	new Map() as any, ensureFresh, saveSkeleton, new Set() as any, setEnabled, rebuildHandler
);

describe('roosync_indexing probe_code_index (#4736 P1)', () => {
	test('resolves the shared-ladder variant and returns its vector config — no writes', async () => {
		const ws = 'X:/ws';
		const existing = wsOf(ws);
		mockGetCollection.mockImplementation(async (name: string) => {
			if (name === existing) {
				return { points_count: 5, config: { params: { vectors: { size: 2560, distance: 'Cosine' } } } };
			}
			throw Object.assign(new Error(`Collection ${name} not found!`), { status: 404 });
		});
		mockGetCollections.mockResolvedValue({ collections: [{ name: existing }] });
		mockScroll.mockResolvedValue({ points: [] });
		mockGetQdrantClient.mockReturnValue({
			getCollection: mockGetCollection,
			getCollections: mockGetCollections,
			scroll: mockScroll,
			upsert: mockUpsert,
			createCollection: mockCreateCollection,
			delete: mockDelete,
		});

		const result: any = await callProbe(ws);
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.action).toBe('probe_code_index');
		expect(parsed.writes).toBe('none');
		expect(parsed.resolved).toBe(existing);
		expect(parsed.resolved_by).toBe('hash');
		expect(parsed.resolved_vectors).toEqual({ size: 2560, distance: 'Cosine' });
		expect(parsed.primary_hash).toBe(existing);
		expect(parsed.collection_variants.length).toBeGreaterThan(0);
		expect(parsed.supplement_collection).toBeNull();
		expect(mockUpsert).not.toHaveBeenCalled();
		expect(mockCreateCollection).not.toHaveBeenCalled();
		expect(mockDelete).not.toHaveBeenCalled();
	});

	test('unreachable Qdrant surfaces as an error, never as "no collection"', async () => {
		mockGetCollection.mockRejectedValue(new Error('fetch failed ECONNREFUSED'));
		mockGetQdrantClient.mockReturnValue({
			getCollection: mockGetCollection,
			getCollections: mockGetCollections,
			scroll: mockScroll,
			upsert: mockUpsert,
			createCollection: mockCreateCollection,
			delete: mockDelete,
		});

		const result: any = await callProbe('X:/ws');
		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('probe_code_index_unreachable');
		expect(mockUpsert).not.toHaveBeenCalled();
	});
});
