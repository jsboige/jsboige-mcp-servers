/**
 * #4736 P3 — the guarded incremental writer for the shared `ws-*` collection.
 *
 * RSM becomes the writer of the collections Zoo Code left behind (user decision
 * 14/11/2026). P1 (collection-naming.ts) pinned the naming/resolution contract,
 * P2 (zoo-parity.ts) ported the id-minting formulas and proved them by
 * measurement (5 files, 100% id/payload parity; re-upsert of 117 points left
 * points_count at DELTA 0). This module is the writer those two phases arm —
 * with the guards the issue demands:
 *
 *  - ONE WRITER PER COLLECTION, enforced by a sentinel point (`machine:workspace`
 *    lane identity, same key as the issue-claim registry). A second lane is
 *    refused; only an explicit `takeover` gets past, and the previous owner is
 *    recorded.
 *  - NEVER CREATE, NEVER RECONFIGURE. The writer only writes into the collection
 *    `codebase_search` actually resolves for the workspace (probe reuse — risk 1)
 *    and never calls createCollection: the served collection's config is
 *    read-only to it (risk 2). A workspace with no served collection is refused,
 *    not bootstrapped.
 *  - ID PARITY GATED ON EVIDENCE. Zoo's segmentHash embeds the ABSOLUTE writer
 *    path (`d:\dev\roo-extensions\docs\a.md`), not the relative one — so the
 *    prefix is a property of the corpus, and a run with the wrong prefix would
 *    mint twin ids for identical content. Before anything else the run
 *    recomputes sampled stored points' segmentHash under the given prefix and
 *    REFUSES unless at least one verifies (the P2 replay is the reference).
 *  - STALE PURGE BY filePath BEFORE the upsert. The corpus holds ≥2 generations
 *    of blocks for some files (P2 finding) — Zoo never garbage-collected
 *    re-chunked files (#2609/#2554). A changed file has every existing point
 *    under its filePath deleted, then its new blocks written: after the run the
 *    file owns exactly its current blocks.
 *  - DRY RUN IS THE DEFAULT, at the service boundary and the tool boundary
 *    alike: the only way to write is an explicit `dryRun: false`.
 *
 * Scope is markdown only (.md/.markdown, Zoo-eligible paths): the population P2
 * proved byte-exact. Files Zoo never indexed (hidden-dir markdown, .ts…) are
 * skipped, not adopted — writing them would add content Zoo never indexed to a
 * served collection, which is P4/P5 territory (AST parity), not this phase.
 * Incrementality rides on per-file RSM cache points (type 'metadata', excluded
 * from every search path): `fileHash` → skip. Zoo's own payload carries no
 * fileHash, so the first run re-embeds; the second and later ones do not.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';
import { v5 as uuidv5 } from 'uuid';
import {
	parseZooMarkdownContent,
	toZooPointPayload,
	zooPointId,
	ZOO_CODE_BLOCK_NAMESPACE,
	type ZooCodeBlock,
} from './zoo-parity.js';
import { classifyZooPath } from './zoo-eligibility.js';
import { listGitVisiblePaths } from './git-visible.js';
import { parseVectorsConfig, probeWorkspaceCollections } from './collection-naming.js';
import type { QdrantLike } from './supplement-index.js';

/** The file types this writer manages — exactly the population P2 proved at parity. */
export const WS_WRITER_MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/** Zoo's own scanner cap; the writer keeps it so the corpus stays comparable. */
export const MAX_WS_WRITER_FILE_BYTES = 1024 * 1024;

/**
 * The writer sentinel's fixed point id — Zoo's own code-block namespace (an id
 * space, nothing more), under a name Zoo never mints. Distinct from Zoo's
 * `__indexing_metadata__` marker, which this writer never touches.
 */
export const WS_WRITER_SENTINEL_ID = uuidv5('__rsm_ws_writer__', ZOO_CODE_BLOCK_NAMESPACE);

/** Deterministic id of a file's hash-cache point (RSM bookkeeping, type metadata). */
export function wsWriterCachePointId(relativePath: string): string {
	return uuidv5(`__rsm_ws_writer_cache__\u0000${relativePath}`, ZOO_CODE_BLOCK_NAMESPACE);
}

/**
 * The absolute path Zoo's hash formula embeds: historical writer prefix + the
 * workspace-relative path with NATIVE separators. Always `\\`-joined: this
 * corpus was written by a Windows Zoo, and the prefix validation below refuses
 * a prefix that does not reproduce stored hashes, so a wrong separator
 * convention cannot write silently.
 */
export function joinZooWriterPath(prefix: string, relativeNativePath: string): string {
	// Normalize the prefix to backslashes FIRST: the historical hashes embed
	// `d:\dev\...`, and a forward-slash variant of the same path must join to
	// the exact same hashed string, not a mixed-separator hybrid.
	const normalized = prefix.replace(/\//g, '\\');
	const trimmed = normalized.replace(/[\\/]+$/, '');
	return `${trimmed}\\${relativeNativePath}`;
}

/** git-style forward-slash relative path → the native-separator form Zoo payloads carry. */
export function toNativeRel(relativePath: string): string {
	return relativePath.replace(/\//g, '\\');
}

/** sha256 of the raw file content — Zoo's own `fileHash` convention. */
function fileHashOf(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

// ── Prefix validation (the id-parity gate) ────────────────────────────────────

export interface PrefixValidation {
	/** Stored points whose segmentHash recomputed exactly under this prefix. */
	verified: number;
	/** Points actually sampled (payload-complete, non-metadata). */
	sampled: number;
	/** One verifying point, for the report — proof, not just a count. */
	verified_sample?: { filePath: string; segmentHash: string };
	/**
	 * Set when the collection could not be READ at all. A failed read is not an
	 * empty collection: `runWsIndexWriter` refuses on it. Only a collection that
	 * was really read and holds no verifiable point is "inconclusive" (#4736 P3
	 * review — a scroll timeout used to pass as inconclusive and the run wrote).
	 */
	read_error?: string;
}

/**
 * Recomputes sampled stored points' segmentHash under `prefix`.
 *
 * Only the 5-field block formula (`absPath-start-end-length-preview`) can be
 * recomputed from a payload — oversized-line SEGMENT blocks hash a start-char
 * index the payload does not carry, so they are skipped, not counted against
 * the prefix. One verifying point proves the prefix (a sha256 match is not an
 * accident); zero verifying points is a refusal, not a warning.
 */
export async function validateHashPathPrefix(
	client: QdrantLike,
	collection: string,
	prefix: string,
	options: { sampleSize?: number } = {},
): Promise<PrefixValidation> {
	if (typeof client.scroll !== 'function') return { verified: 0, sampled: 0 };
	const limit = Math.min(Math.max(options.sampleSize ?? 100, 1), 500);
	let res: any;
	try {
		res = await client.scroll(collection, {
			limit,
			with_payload: { include: ['filePath', 'segmentHash', 'codeChunk', 'startLine', 'endLine', 'type'] },
			with_vector: false,
		});
	} catch (error) {
		return { verified: 0, sampled: 0, read_error: error instanceof Error ? error.message : String(error) };
	}
	const points = res?.points ?? res?.result?.points ?? [];
	const out: PrefixValidation = { verified: 0, sampled: 0 };
	for (const p of points) {
		const payload = p?.payload;
		if (!payload || payload.type === 'metadata') continue;
		if (typeof payload.filePath !== 'string' || typeof payload.segmentHash !== 'string'
			|| typeof payload.codeChunk !== 'string') continue;
		const startLine = Number(payload.startLine);
		const endLine = Number(payload.endLine);
		if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) continue;
		out.sampled++;
		const abs = joinZooWriterPath(prefix, payload.filePath);
		const recomputed = createHash('sha256')
			.update(`${abs}-${startLine}-${endLine}-${payload.codeChunk.length}-${payload.codeChunk.slice(0, 100)}`)
			.digest('hex');
		if (recomputed === payload.segmentHash) {
			out.verified++;
			if (!out.verified_sample) {
				out.verified_sample = { filePath: payload.filePath, segmentHash: payload.segmentHash };
			}
		}
	}
	return out;
}

// ── Single-writer guard (sentinel in the served collection) ───────────────────

/** What the ws-writer sentinel records — mirrors the supplement's record shape. */
export interface WsWriterRecord {
	writer: string;
	since: string;
	collection: string;
	hashPathPrefix?: string;
	takenOverFrom?: string;
	embeddingModelId?: string;
	embeddingModelDimensions?: number;
	embeddingEndpoint?: string;
}

function parseWriterPayload(payload: any): WsWriterRecord | null {
	if (!payload || typeof payload.writer !== 'string') return null;
	return {
		writer: payload.writer,
		since: String(payload.since ?? ''),
		collection: String(payload.collection ?? ''),
		...(typeof payload.hashPathPrefix === 'string' ? { hashPathPrefix: payload.hashPathPrefix } : {}),
		...(typeof payload.takenOverFrom === 'string' ? { takenOverFrom: payload.takenOverFrom } : {}),
		...(typeof payload.embeddingModelId === 'string' ? { embeddingModelId: payload.embeddingModelId } : {}),
		...(typeof payload.embeddingModelDimensions === 'number' ? { embeddingModelDimensions: payload.embeddingModelDimensions } : {}),
		...(typeof payload.embeddingEndpoint === 'string' ? { embeddingEndpoint: payload.embeddingEndpoint } : {}),
	};
}

/**
 * Reads the ws-writer sentinel; null when the collection was read and holds
 * none. A READ ERROR throws — it is not "no writer": a foreign owner could be
 * hidden behind a timeout, and treating that as free would let the run proceed
 * (#4736 P3 review). The collection is resolved before this is called on the
 * write path, so an absent collection is a caller bug, not a normal state.
 */
export async function readWsWriterRecord(
	client: QdrantLike,
	collection: string,
): Promise<WsWriterRecord | null> {
	const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
	try {
		if (typeof client.retrieve === 'function') {
			const res: any = await client.retrieve(collection, {
				ids: [WS_WRITER_SENTINEL_ID],
				with_payload: true,
				with_vector: false,
			});
			return parseWriterPayload(responsePoints(res)[0]?.payload);
		}
		if (typeof client.scroll === 'function') {
			const res: any = await client.scroll(collection, {
				filter: { must: [{ has_id: [WS_WRITER_SENTINEL_ID] }] },
				limit: 1,
				with_payload: true,
				with_vector: false,
			});
			return parseWriterPayload(responsePoints(res)[0]?.payload);
		}
		return null;
	} catch (error) {
		throw new Error(
			`cannot read the ws-writer sentinel on ${collection} (${describe(error)}) — a failed read is not ` +
			`"no writer": a foreign owner could be hidden behind it. Nothing was written.`
		);
	}
}

/**
 * Claims the writer sentinel. Compare-after-write like the supplement (Qdrant
 * has no conditional write): after upserting, the sentinel is read back and a
 * record no longer ours throws — a concurrent claim won, nothing else ran.
 */
export async function claimWsWriter(
	client: QdrantLike,
	collection: string,
	writer: string,
	options: {
		hashPathPrefix: string;
		takeover?: boolean;
		vector: number[];
		now?: string;
		embeddingModel?: { id: string | null; dimensions: number | null };
		embeddingEndpoint?: string | null;
	},
): Promise<{ claimed: boolean; previous: WsWriterRecord | null }> {
	const previous = await readWsWriterRecord(client, collection);
	const isOther = previous !== null && previous.writer !== writer;
	if (isOther && !options.takeover) {
		throw new Error(
			`collection ${collection} is written by ${previous?.writer} (since ${previous?.since}). ` +
			`One writer per ws- collection is enforced in code (#4736 P3): pass takeover: true only if this ` +
			`lane is meant to own it from now on.`
		);
	}
	if (typeof client.upsert !== 'function') throw new Error('qdrant client has no upsert');
	await client.upsert(collection, {
		wait: true,
		points: [{
			id: WS_WRITER_SENTINEL_ID,
			vector: options.vector,
			payload: {
				// type metadata = excluded from every search path, like Zoo's own marker.
				type: 'metadata',
				source: 'rsm-ws-writer-sentinel',
				writer,
				since: options.now ?? new Date().toISOString(),
				collection,
				hashPathPrefix: options.hashPathPrefix,
				...(isOther ? { takenOverFrom: previous?.writer } : {}),
				...(options.embeddingModel?.id ? { embeddingModelId: options.embeddingModel.id } : {}),
				...(options.embeddingModel?.dimensions ? { embeddingModelDimensions: options.embeddingModel.dimensions } : {}),
				...(options.embeddingEndpoint ? { embeddingEndpoint: options.embeddingEndpoint } : {}),
			},
		}],
	});
	const readBack = await readWsWriterRecord(client, collection);
	if (readBack && readBack.writer !== writer) {
		throw new Error(
			`writer guard: ${collection} is now owned by ${readBack.writer}, not ${writer} — a concurrent ` +
			`claim won the sentinel; no points were written by this call, but the sentinel itself may have ` +
			`been overwritten.`
		);
	}
	return { claimed: true, previous };
}

// ── The index run ─────────────────────────────────────────────────────────────

export interface WsIndexWriterDeps {
	client: QdrantLike;
	workspaceRoot: string;
	/** Lane identity, `machine:workspace` — the value recorded in the sentinel. */
	writer: string;
	/**
	 * The historical ABSOLUTE writer prefix Zoo's segmentHashes embed
	 * (`d:\dev\roo-extensions` on this corpus). REQUIRED and validated against
	 * stored points before anything else — see validateHashPathPrefix.
	 */
	hashPathPrefix: string;
	/** Default true: report what would happen, write nothing. */
	dryRun?: boolean;
	takeover?: boolean;
	/**
	 * Write into this collection instead of the probed resolution. The tool
	 * boundary does not set it; tests use it to pin a fake collection.
	 */
	collection?: string;
	/** Model id this run embeds with — recorded in the sentinel, compared on the next run. */
	embeddingModelId?: string | null;
	/** Host of the embedding endpoint — same model name elsewhere is another space. */
	embeddingEndpoint?: string | null;
	embed: (texts: string[]) => Promise<number[][]>;
	batchSize?: number;
	throttleMs?: number;
	maxFiles?: number;
	maxChunks?: number;
	/** Test seam: override the workspace file listing (forward-slash relative paths). */
	listFiles?: () => Promise<string[] | null>;
	now?: () => string;
	sleep?: (ms: number) => Promise<void>;
}

export interface WsIndexWriterReport {
	status: 'success' | 'partial' | 'failed' | 'dry_run';
	collection: string;
	resolved_by: 'explicit' | 'hash' | 'content-match';
	writer: string;
	dry_run: boolean;
	vector_config: { size: number; distance: string } | null;
	prefix_validation: PrefixValidation;
	writer_guard: { ok: boolean; previous_writer: string | null; took_over_from?: string };
	files_considered: number;
	files_skipped_unchanged: number;
	files_to_index: number;
	files_indexed: number;
	files_failed: { path: string; error: string }[];
	files_removed: number;
	points_deleted: number;
	points_written: number;
	chunks_embedded: number;
	batches: number;
	batches_failed: number;
	truncated: boolean;
	elapsed_ms: number;
	warnings: string[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Points carried by a Qdrant response, whatever the endpoint's shape.
 *
 * The pinned SDK (`@qdrant/js-client-rest` 1.16.2, ms#1789 review) UNWRAPS the
 * HTTP envelope before returning (`qdrant-client.js` returns
 * `response.data.result`):
 *   - `retrieve` answers a BARE ARRAY of points;
 *   - `scroll`   answers `{ points, next_page_offset }` at the top level.
 * The raw HTTP shapes (what a bare fetch/curl probe sees) differ:
 *   - `retrieve` → `{ result: PointStruct[] }`;
 *   - `scroll`   → `{ result: { points, next_page_offset } }`.
 * Reading only `result.points` made `retrieve` return nothing on every call:
 * the hash cache stayed empty (every pass re-indexed the whole corpus — three
 * measured passes, zero skips) and the ws-writer sentinel read as absent
 * (the mono-writer guard was blind). Accept all four shapes, SDK-unwrapped
 * first — that is what the live client hands us.
 */
function responsePoints(res: any): any[] {
	if (Array.isArray(res)) return res;
	if (Array.isArray(res?.result)) return res.result;
	return res?.result?.points ?? res?.points ?? [];
}

/** Existing content-point ids under one filePath (native separators), metadata excluded, paged. */
async function contentPointIdsForFile(client: QdrantLike, collection: string, relNative: string): Promise<string[]> {
	if (typeof client.scroll !== 'function') return [];
	const ids: string[] = [];
	let offset: any;
	for (let page = 0; page < 20; page++) {
		let res: any;
		try {
			res = await client.scroll(collection, {
				limit: 1000,
				...(offset !== undefined && offset !== null ? { offset } : {}),
				filter: {
					must: [{ key: 'filePath', match: { value: relNative } }],
					must_not: [{ key: 'type', match: { value: 'metadata' } }],
				},
				with_payload: false,
				with_vector: false,
			});
		} catch (error) {
			// Same class as the prefix guard (#4736 P3 review): an empty id list
			// would silently skip the stale purge and the upsert would then ADD a
			// new generation beside the old one — the exact P2 duplication this
			// writer exists to prevent. Refuse instead.
			throw new Error(
				`cannot read existing points of ${relNative} in ${collection} ` +
				`(${error instanceof Error ? error.message : String(error)}) — refusing to skip the stale purge.`
			);
		}
		for (const p of res?.points ?? res?.result?.points ?? []) ids.push(String(p.id));
		offset = res?.next_page_offset ?? res?.result?.next_page_offset;
		if (offset === undefined || offset === null) break;
	}
	return ids;
}

/** Every RSM hash-cache point of the collection (the managed-file set). */
async function scrollCachePoints(
	client: QdrantLike,
	collection: string,
): Promise<{ id: string; filePath: string; fileHash: string }[]> {
	if (typeof client.scroll !== 'function') return [];
	const out: { id: string; filePath: string; fileHash: string }[] = [];
	let offset: any;
	for (let page = 0; page < 100; page++) {
		let res: any;
		try {
			res = await client.scroll(collection, {
				limit: 1000,
				...(offset !== undefined && offset !== null ? { offset } : {}),
				filter: { must: [{ key: 'source', match: { value: 'rsm-ws-writer-cache' } }] },
				with_payload: { include: ['filePath', 'fileHash'] },
				with_vector: false,
			});
		} catch (error) {
			// An empty cache set is not "nothing managed": it would re-embed the
			// whole corpus AND miss the deleted-file GC. Refuse like the others.
			throw new Error(
				`cannot read the writer cache points of ${collection} ` +
				`(${error instanceof Error ? error.message : String(error)}) — refusing to re-index blind.`
			);
		}
		for (const p of res?.points ?? res?.result?.points ?? []) {
			if (typeof p?.payload?.filePath === 'string') {
				out.push({ id: String(p.id), filePath: String(p.payload.filePath), fileHash: String(p.payload.fileHash ?? '') });
			}
		}
		offset = res?.next_page_offset ?? res?.result?.next_page_offset;
		if (offset === undefined || offset === null) break;
	}
	return out;
}

async function deleteIds(client: QdrantLike, collection: string, ids: string[]): Promise<void> {
	if (ids.length === 0 || typeof client.delete !== 'function') return;
	for (let i = 0; i < ids.length; i += 500) {
		await client.delete(collection, { points: ids.slice(i, i + 500) });
	}
}

/**
 * One guarded incremental run over the served ws- collection.
 *
 * Order of operations is load-bearing: resolve → validate prefix → writer
 * guard → plan (cache skip) → [dry run stops] → claim sentinel → purge stale
 * points of changed/removed files → embed + upsert new blocks → write cache
 * points. A crash between purge and upsert leaves a file unindexed (the next
 * run re-indexes it — the cache was not written); it never leaves stale AND
 * fresh generations coexisting.
 */
export async function runWsIndexWriter(deps: WsIndexWriterDeps): Promise<WsIndexWriterReport> {
	const startedAt = Date.now();
	const dryRun = deps.dryRun !== false;
	const batchSize = Math.max(1, deps.batchSize ?? 32);
	const throttleMs = Math.max(0, deps.throttleMs ?? 200);
	const maxFiles = deps.maxFiles && deps.maxFiles > 0 ? deps.maxFiles : Number.POSITIVE_INFINITY;
	const maxChunks = deps.maxChunks && deps.maxChunks > 0 ? deps.maxChunks : 20_000;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? (() => new Date().toISOString());
	const warnings: string[] = [];

	// 1. Resolve the target collection — exactly what the reader serves.
	let collection: string;
	let resolvedBy: 'explicit' | 'hash' | 'content-match';
	let vectorConfig: { size: number; distance: string } | null = null;
	if (deps.collection) {
		collection = deps.collection;
		resolvedBy = 'explicit';
		if (typeof deps.client.getCollection !== 'function') {
			throw new Error('qdrant client has no getCollection — cannot verify the target collection exists');
		}
		const info: any = await deps.client.getCollection(collection); // absent → throws → refuse
		vectorConfig = parseVectorsConfig(info);
	} else {
		const probe = await probeWorkspaceCollections(deps.client, deps.workspaceRoot);
		if (!probe.resolved) {
			throw new Error(
				`no served ws- collection resolves for ${deps.workspaceRoot} (probe: ${probe.existing.length} ` +
				`variant(s) exist, content match: ${probe.content_match?.match ? probe.content_match.match.name : 'none'}). ` +
				`The ws writer only writes into the collection codebase_search serves and NEVER bootstraps one ` +
				`(#4736 risks 1-2).`
			);
		}
		collection = probe.resolved;
		resolvedBy = probe.resolved_by === 'content-match' ? 'content-match' : 'hash';
		vectorConfig = probe.resolved_vectors;
	}
	if (!vectorConfig) {
		throw new Error(
			`cannot read the vector config of ${collection} — refusing to write blind. The served ` +
			`collection's size/distance is read-only context for this writer (#4736 risk 2).`
		);
	}

	// 2. Prefix validation — the id-parity gate. Sampled points that verify
	// nothing is EVIDENCE AGAINST the prefix → refuse. A collection with zero
	// verifiable content points is INCONCLUSIVE (nothing to twin today) → the
	// run proceeds, with the prefix recorded as unvalidated and a warning: the
	// purge is id-agnostic (keyed on filePath), so a wrong-prefix generation
	// remains fully purgeable by a later corrected run.
	const prefixValidation = await validateHashPathPrefix(deps.client, collection, deps.hashPathPrefix);
	if (prefixValidation.read_error) {
		throw new Error(
			`cannot read ${collection} to validate the hash-path prefix (${prefixValidation.read_error}) — ` +
			`a failed read is not an empty collection, and an unvalidated prefix would mint TWIN ids for ` +
			`unchanged content (#4736 P3 review). Nothing was written.`
		);
	}
	if (prefixValidation.sampled === 0) {
		warnings.push(
			`hash-path prefix ${JSON.stringify(deps.hashPathPrefix)} could NOT be validated: ${collection} was ` +
			`read and holds no verifiable content point yet (inconclusive, not refused). The stale purge is ` +
			`id-agnostic (keyed on filePath), so a wrong-prefix generation stays purgeable by a later corrected run.`
		);
	}
	if (prefixValidation.verified === 0 && prefixValidation.sampled > 0) {
		throw new Error(
			`hash-path prefix validation failed on ${collection}: 0 of ${prefixValidation.sampled} sampled ` +
			`point(s) recomputed to their stored segmentHash under prefix ${JSON.stringify(deps.hashPathPrefix)}. ` +
			`Zoo's segmentHash embeds the ABSOLUTE writer path, so an unvalidated prefix would mint TWIN ids ` +
			`for unchanged content (#4736 P2 finding — this corpus was written under 'd:\\dev\\roo-extensions'). ` +
			`Nothing was written.`
		);
	}

	// 3. Writer guard before any write decision.
	const previous = await readWsWriterRecord(deps.client, collection);
	const foreignWriter = previous !== null && previous.writer !== deps.writer;
	if (foreignWriter && !deps.takeover) {
		throw new Error(
			`collection ${collection} is written by ${previous?.writer} (since ${previous?.since}). ` +
			`One writer per ws- collection is enforced in code (#4736 P3): pass takeover: true only if this ` +
			`lane is meant to own it from now on.`
		);
	}
	// Embedding-space guard, same rationale as the supplement's: the cache skip
	// keys on fileHash alone, so a model/endpoint switch would report every file
	// "unchanged" while new vectors land in another space. The switch REFUSES —
	// takeover does not cross a model change. Remedy for a served collection:
	// deliberately purge-and-reindex the affected files; never mix silently.
	if (previous?.embeddingModelId != null) {
		const dimensionsMatch = previous.embeddingModelDimensions == null
			|| vectorConfig == null
			|| previous.embeddingModelDimensions === vectorConfig.size;
		const prevEndpoint = previous.embeddingEndpoint ?? null;
		const nextEndpoint = deps.embeddingEndpoint ?? null;
		if (previous.embeddingModelId !== deps.embeddingModelId || !dimensionsMatch || prevEndpoint !== nextEndpoint) {
			throw new Error(
				`collection ${collection} was last written with ${previous.embeddingModelId}` +
				`${previous.embeddingModelDimensions ? ` (${previous.embeddingModelDimensions}d)` : ''}` +
				`${prevEndpoint ? ` at ${prevEndpoint}` : ''}, but this run would embed with ` +
				`${deps.embeddingModelId ?? 'an unknown model'} (${vectorConfig?.size ?? '?'}d)` +
				`${nextEndpoint ? ` at ${nextEndpoint}` : ''}. Mixing embedding spaces in a SERVED collection ` +
				`yields a meaningless ranking with no error — the run refuses, and takeover does not cross a ` +
				`model change. If the model really changed, purge-and-reindex the affected files deliberately.`
			);
		}
	}

	// 4. Enumerate the markdown population (Zoo-eligible paths only).
	const listed = deps.listFiles
		? await deps.listFiles()
		: await listGitVisiblePaths(deps.workspaceRoot);
	if (listed === null) {
		throw new Error(`not a git workspace (or git unavailable): ${deps.workspaceRoot}`);
	}
	const candidates: string[] = [];
	let droppedOversize = 0;
	const filesFailed: { path: string; error: string }[] = [];
	for (const relPath of listed) {
		if (classifyZooPath(relPath) !== 'eligible') continue; // hidden-dir md, binaries, submodule gitlinks…
		const ext = extname(relPath).toLowerCase();
		if (!WS_WRITER_MARKDOWN_EXTENSIONS.has(ext)) continue; // non-markdown: P4/P5 (AST parity), not P3
		const abs = join(deps.workspaceRoot, relPath);
		try {
			const st = statSync(abs);
			if (!st.isFile()) continue;
			if (st.size > MAX_WS_WRITER_FILE_BYTES) { droppedOversize++; continue; }
		} catch (error) {
			filesFailed.push({ path: relPath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		candidates.push(relPath);
	}
	candidates.sort();
	if (droppedOversize > 0) warnings.push(`${droppedOversize} markdown file(s) over ${MAX_WS_WRITER_FILE_BYTES} bytes skipped (Zoo's scanner cap)`);

	// 5. Cache lookup — batched retrieve by deterministic cache ids.
	const cacheHits = new Map<string, string>();
	if (typeof deps.client.retrieve === 'function') {
		for (let i = 0; i < candidates.length; i += 500) {
			const batch = candidates.slice(i, i + 500);
			const res: any = await deps.client.retrieve(collection, {
				ids: batch.map((p) => wsWriterCachePointId(p)),
				with_payload: true,
				with_vector: false,
			});
			for (const pt of responsePoints(res)) {
				if (pt?.payload?.source === 'rsm-ws-writer-cache' && typeof pt.payload.filePath === 'string') {
					cacheHits.set(String(pt.payload.filePath), String(pt.payload.fileHash ?? ''));
				}
			}
		}
	}

	// 6. Plan: skip unchanged, read the rest.
	const toIndex: { relPath: string; relNative: string; content: string; fileHash: string }[] = [];
	let skippedUnchanged = 0;
	let truncated = false;
	for (const relPath of candidates) {
		if (toIndex.length >= maxFiles) { truncated = true; break; }
		let content: string;
		try {
			content = readFileSync(join(deps.workspaceRoot, relPath), 'utf8');
		} catch (error) {
			filesFailed.push({ path: relPath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const fileHash = fileHashOf(content);
		if (cacheHits.get(relPath) === fileHash) { skippedUnchanged++; continue; }
		toIndex.push({ relPath, relNative: toNativeRel(relPath), content, fileHash });
	}

	// 7. Deleted-file GC over the MANAGED set only (our cache points). Zoo-era
	// orphans are out of scope — this writer never adopts files it did not index.
	const cachePoints = await scrollCachePoints(deps.client, collection);
	const removed: string[] = [];
	for (const cp of cachePoints) {
		if (!existsSync(join(deps.workspaceRoot, cp.filePath))) removed.push(cp.filePath);
	}

	const report: WsIndexWriterReport = {
		status: dryRun ? 'dry_run' : 'success',
		collection,
		resolved_by: resolvedBy,
		writer: deps.writer,
		dry_run: dryRun,
		vector_config: vectorConfig,
		prefix_validation: prefixValidation,
		writer_guard: {
			ok: !foreignWriter || Boolean(deps.takeover),
			previous_writer: previous?.writer ?? null,
			...(foreignWriter && deps.takeover ? { took_over_from: previous?.writer } : {}),
		},
		files_considered: candidates.length,
		files_skipped_unchanged: skippedUnchanged,
		files_to_index: toIndex.length,
		files_indexed: 0,
		files_failed: filesFailed,
		files_removed: removed.length,
		points_deleted: 0,
		points_written: 0,
		chunks_embedded: 0,
		batches: 0,
		batches_failed: 0,
		truncated,
		elapsed_ms: 0,
		warnings,
	};

	if (dryRun) {
		report.elapsed_ms = Date.now() - startedAt;
		return report;
	}

	// 8. Claim the sentinel (zero vector of the collection's size).
	const claim = await claimWsWriter(deps.client, collection, deps.writer, {
		hashPathPrefix: deps.hashPathPrefix,
		takeover: deps.takeover,
		vector: new Array(vectorConfig.size).fill(0),
		now: now(),
		embeddingModel: { id: deps.embeddingModelId ?? null, dimensions: vectorConfig.size },
		embeddingEndpoint: deps.embeddingEndpoint ?? null,
	});
	if (claim.claimed) report.writer_guard.ok = true;

	// 8b. Parse blocks and apply the chunk budget to WHOLE FILES, BEFORE any
	// purge (#4736 P3 review WARNING 2). Purging is only safe for a file the
	// run fully rewrites: a file the cap excludes keeps its previous
	// generation, and a file that does not fit must not be purged either.
	const planned: { item: (typeof toIndex)[number]; blocks: ZooCodeBlock[] }[] = [];
	let chunkBudget = maxChunks;
	for (const item of toIndex) {
		const blocks = parseZooMarkdownContent(
			joinZooWriterPath(deps.hashPathPrefix, item.relNative),
			item.content,
			item.fileHash,
		);
		if (blocks.length > chunkBudget) {
			report.truncated = true;
			break;
		}
		chunkBudget -= blocks.length;
		if (blocks.length === 0) {
			warnings.push(`${item.relPath}: no block above the minimum — nothing to embed`);
		}
		planned.push({ item, blocks });
	}

	// 9. Purge stale points BEFORE any upsert (the P2 ≥2-generations finding),
	// over the files this run fully rewrites.
	let pointsDeleted = 0;
	for (const { item } of planned) {
		const ids = await contentPointIdsForFile(deps.client, collection, item.relNative);
		await deleteIds(deps.client, collection, ids);
		pointsDeleted += ids.length;
	}
	const removedCacheIds: string[] = [];
	for (const filePath of removed) {
		const ids = await contentPointIdsForFile(deps.client, collection, toNativeRel(filePath));
		await deleteIds(deps.client, collection, ids);
		pointsDeleted += ids.length;
		removedCacheIds.push(wsWriterCachePointId(filePath));
	}
	await deleteIds(deps.client, collection, removedCacheIds);
	report.points_deleted = pointsDeleted;

	// 10. Embed and upsert — Zoo ids, Zoo payload, nothing else. Every file in
	// `planned` fits whole: the budget above already excluded the rest.
	const pending: { id: string; relPath: string; block: ZooCodeBlock; fileHash: string }[] = [];
	const plannedByFile = new Map<string, number>();
	for (const { item, blocks } of planned) {
		plannedByFile.set(item.relPath, blocks.length);
		for (const block of blocks) {
			pending.push({ id: zooPointId(block.segmentHash), relPath: item.relPath, block, fileHash: item.fileHash });
		}
	}

	let written = 0;
	const writtenByFile = new Map<string, number>();
	const batchTotal = Math.ceil(pending.length / batchSize);
	for (let i = 0; i < pending.length; i += batchSize) {
		const batch = pending.slice(i, i + batchSize);
		const batchNo = Math.floor(i / batchSize) + 1;
		try {
			const vectors = await deps.embed(batch.map((b) => b.block.content));
			if (vectors.length !== batch.length) {
				throw new Error(
					`embedding returned ${vectors.length} vectors for ${batch.length} chunks — refusing to write a ` +
					`misaligned batch (chunk/vector mismatch silently corrupts the index)`
				);
			}
			if (vectors.some((v) => v.length !== vectorConfig.size)) {
				throw new Error(
					`embedding returned vectors of the wrong dimension (collection is ${vectorConfig.size}d) — ` +
					`refusing to write vectors from another space into the served collection`
				);
			}
			if (typeof deps.client.upsert !== 'function') throw new Error('qdrant client has no upsert');
			await deps.client.upsert(collection, {
				wait: true,
				points: batch.map((b, index) => ({
					id: b.id,
					vector: vectors[index],
					payload: toZooPointPayload(b.block, toNativeRel(b.relPath)),
				})),
			});
			report.batches++;
			report.chunks_embedded += batch.length;
			written += batch.length;
			for (const b of batch) writtenByFile.set(b.relPath, (writtenByFile.get(b.relPath) ?? 0) + 1);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			report.batches_failed++;
			const affected = Array.from(new Set(batch.map((b) => b.relPath)));
			const preview = affected.slice(0, 3).join(', ') + (affected.length > 3 ? `, +${affected.length - 3} more` : '');
			warnings.push(
				`batch ${batchNo}/${batchTotal} failed (${message}) — ${batch.length} chunk(s) across ` +
				`${affected.length} file(s) not written: ${preview}`
			);
		}
		if (throttleMs > 0 && i + batchSize < pending.length) await sleep(throttleMs);
	}
	report.points_written = written;
	report.files_indexed = [...plannedByFile].filter(
		([relPath, total]) => total > 0 && (writtenByFile.get(relPath) ?? 0) === total,
	).length;

	// 11. Cache points for every file whose blocks ALL landed — the incremental
	// skip key for the next run. A file spanning several batches that lost one
	// of them is NEVER cached (#4736 P3 review CRITICAL: it used to be, and the
	// next run then skipped it as unchanged at 2 of its 3 blocks).
	const cacheUids: string[] = [];
	const zeroVector = new Array(vectorConfig.size).fill(0);
	for (const { item } of planned) {
		const total = plannedByFile.get(item.relPath) ?? 0;
		if ((writtenByFile.get(item.relPath) ?? 0) !== total) continue;
		cacheUids.push(wsWriterCachePointId(item.relPath));
	}
	if (cacheUids.length > 0 && typeof deps.client.upsert === 'function') {
		const byPath = new Map(planned.map(({ item }) => [wsWriterCachePointId(item.relPath), item]));
		for (let i = 0; i < cacheUids.length; i += 500) {
			const slice = cacheUids.slice(i, i + 500);
			await deps.client.upsert(collection, {
				wait: true,
				points: slice.map((id) => ({
					id,
					vector: zeroVector,
					payload: {
						type: 'metadata',
						source: 'rsm-ws-writer-cache',
						filePath: byPath.get(id)!.relPath,
						fileHash: byPath.get(id)!.fileHash,
						writer: deps.writer,
						since: now(),
					},
				})),
			});
		}
	}

	if (report.batches_failed > 0) {
		report.status = report.points_written > 0 ? 'partial' : 'failed';
	}
	report.elapsed_ms = Date.now() - startedAt;
	return report;
}
