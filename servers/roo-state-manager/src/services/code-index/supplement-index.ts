/**
 * #4352 (a3): the supplement code index — what Zoo never indexes, indexed anyway.
 *
 * Zoo 3.92's code indexer skips whole families of files by construction: every
 * extension outside its scanner list (`.ps1`, `.psm1`, `.psd1`, `.sh`, `.bat`,
 * `.cmd`, `.mjs`, `.cjs`, `.yml`, `.yaml`, `.sql`, `.svelte`) and every hidden
 * directory (`-g !**\/.*\/**`). Measured on roo-extensions 25/10: 9,332 git-visible
 * files, 7,555 indexable by Zoo, 1,775 skipped — ~750 of them text files carrying
 * rules, scripts and CI config that agents search for. No ranking can return a file
 * that was never embedded, so `codebase_search` reports the blind spots
 * (`not_indexed_by_design`) and this module builds a SECOND collection for them.
 *
 * Design points that are not negotiable (ai-01 dispatch, 25/10):
 *  - collection name = `sup-` + sha256(NORMALISED origin URL)[:16] — one per
 *    repository, not per checkout path (the `ws-` collections are path-keyed, so
 *    two seats at different paths never share one; the supplement is the opposite,
 *    which is what makes a single writer meaningful);
 *  - ONE writer per collection, enforced in code by a sentinel record. `takeover`
 *    is the escape hatch and must be an explicit, named decision;
 *  - payload mirrors Zoo's own fields so the search merge needs no special case,
 *    plus `fileHash` (incremental), `writer` and `source: 'rsm-supplement'`;
 *  - chunking mirrors Zoo's fallback line-window chunker exactly (same constants,
 *    same segment hash formula) so a file indexed by both paths yields the same
 *    logical chunks instead of two disjoint views of it.
 *
 * Nothing here writes to Qdrant unless the caller says so: `dry_run` defaults to
 * true at the tool boundary, and the deploy is gated on the #4131 verdict.
 */
import { createHash } from 'crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { classifyZooPath } from './zoo-eligibility.js';
import { listGitVisiblePaths, readOriginUrl } from './git-visible.js';

/** Collection prefix. `ws-` is Zoo's; `sup-` is ours — never the same namespace. */
export const SUPPLEMENT_COLLECTION_PREFIX = 'sup-';

/** Zoo skips files over 1 MB (its own scanner cap); the supplement keeps the same bound. */
export const MAX_SUPPLEMENT_FILE_BYTES = 1024 * 1024;

/** How much of a file is sniffed to decide text vs binary (a single NUL byte is enough). */
const TEXT_SNIFF_BYTES = 8192;

// ── Zoo fallback chunker constants ───────────────────────────────────────────
// Copied verbatim from Zoo 3.92 (`src/services/code-index/constants/index.ts`
// @67df9f9c): a different value here would produce chunks that overlap the Zoo
// ones differently for a file both pipelines ever see.
export const MIN_BLOCK_CHARS = 50;
export const MAX_BLOCK_CHARS = 1000;
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15; // 15% tolerance for max chars
export const MIN_CHUNK_REMAINDER_CHARS = 200;

// ── Remote URL normalisation ─────────────────────────────────────────────────

/**
 * Reduces the several spellings of one repository to a single deterministic key:
 * `git@github.com:jsboige/roo-extensions.git`, `https://github.com/jsboige/roo-extensions`
 * and `https://user:token@github.com/jsboige/roo-extensions.git/` all normalise to
 * `github.com/jsboige/roo-extensions`. Credentials and the transport are dropped
 * (a token must never end up in a collection name, and SSH vs HTTPS is the same
 * repo), the scheme and the `.git` suffix go, and the rest is lowercased — GitHub
 * treats owner/repo case-insensitively, so two seats cloning differently must not
 * land in two collections.
 *
 * Returns null when there is nothing to key on (no remote, empty string).
 */
export function normaliseRemoteUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let s = String(raw).trim();
	if (!s) return null;
	// scp-like syntax: [user@]host:path
	const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s);
	if (scp && !/^[a-zA-Z]:[\\/]/.test(s) && !s.includes('://')) {
		s = `${scp[1]}/${scp[2]}`;
	} else {
		// scheme://[user[:password]@]host/path
		const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/.exec(s);
		if (withScheme) s = withScheme[1];
		// strip credentials, if any survived
		const at = s.lastIndexOf('@');
		if (at >= 0) s = s.slice(at + 1);
	}
	s = s.replace(/\\/g, '/').replace(/\/+$/, '');
	s = s.replace(/\.git$/i, '');
	s = s.replace(/\/+/g, '/');
	return s ? s.toLowerCase() : null;
}

/**
 * The supplement collection for a repository: `sup-` + sha256(normalised remote)[:16]
 * — the same 16-hex-char width as `ws-`, so both are recognisable at a glance in a
 * collection listing. Null when the remote cannot be keyed on.
 */
export function supplementCollectionName(rawRemote: string | null | undefined): string | null {
	const normalised = normaliseRemoteUrl(rawRemote);
	if (!normalised) return null;
	const hash = createHash('sha256').update(normalised).digest('hex');
	return `${SUPPLEMENT_COLLECTION_PREFIX}${hash.substring(0, 16)}`;
}

/** sha256 of the raw file content — Zoo's own `fileHash` convention. */
export function fileHashOf(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Deterministic point id (Qdrant accepts UUID or uint64 only, so a bare 32-char hex
 * string is rejected). Keyed on (file, segmentHash) so re-indexing an unchanged
 * chunk overwrites the same point instead of duplicating it.
 */
export function supplementPointId(relPath: string, segmentHash: string): string {
	const hex = createHash('sha256').update(`sup\u0000${relPath}\u0000${segmentHash}`).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Zoo's payload shape: `pathSegments.{i}` = the i-th directory of the relative path. */
export function pathSegmentsOf(relPath: string): Record<string, string> {
	const segments = relPath.split(/[\\/]/).filter(Boolean);
	const out: Record<string, string> = {};
	segments.forEach((segment, index) => { out[String(index)] = segment; });
	return out;
}

// ── Chunking: a faithful port of Zoo's fallback line-window chunker ──────────

export interface SupplementChunk {
	startLine: number;
	endLine: number;
	content: string;
	segmentHash: string;
	type: string;
}

/**
 * Port of `CodeParser._chunkTextByLines` (Zoo 3.92, parser.ts @67df9f9c), used by
 * Zoo for every file it has no tree-sitter grammar for — which is exactly the
 * supplement's population. Kept line-for-line on purpose: constants, the
 * re-balancing pass that avoids a sub-`MIN_CHUNK_REMAINDER_CHARS` tail, the
 * oversized-line segmentation, and the segment-hash inputs
 * (`filePath-start-end-length-preview`, plus the start char offset for segments).
 * A file indexed by both pipelines must yield the same windows, otherwise the
 * merge would show two different views of the same lines.
 *
 * ONE divergence, and it is not a re-implementation detail: Zoo's loop drops every
 * line between a re-balanced split point and the current one (its `i >= chunkStartLineIndex`
 * guard pushes only the current line after moving the split back). Measured on a
 * 56-line file: 8 lines disappear, silently. This port replays from the new start
 * instead, because losing content from the files the supplement exists to expose
 * cannot be traded for bug-for-bug parity — and there is nothing to be compatible
 * with: Zoo never chunks these files at all. The exhaustive-window test pins it.
 */
export function chunkTextByLines(
	content: string,
	filePath: string,
	chunkType = 'fallback_chunk',
): SupplementChunk[] {
	const lines = content.split('\n');
	const seenSegmentHashes = new Set<string>();
	const chunks: SupplementChunk[] = [];
	let currentChunkLines: string[] = [];
	let currentChunkLength = 0;
	let chunkStartLineIndex = 0; // 0-based index within `lines`
	const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR;

	const makeSegmentHash = (startLine: number, endLine: number, length: number, preview: string) =>
		createHash('sha256').update(`${filePath}-${startLine}-${endLine}-${length}-${preview}`).digest('hex');

	const finalizeChunk = (endLineIndex: number): void => {
		if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
			const chunkContent = currentChunkLines.join('\n');
			const startLine = 1 + chunkStartLineIndex;
			const endLine = 1 + endLineIndex;
			const segmentHash = makeSegmentHash(startLine, endLine, chunkContent.length, chunkContent.slice(0, 100));
			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash);
				chunks.push({ startLine, endLine, content: chunkContent, segmentHash, type: chunkType });
			}
		}
		currentChunkLines = [];
		currentChunkLength = 0;
		chunkStartLineIndex = endLineIndex + 1;
	};

	const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number): void => {
		const segmentHash = createHash('sha256')
			.update(`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segment.slice(0, 100)}`)
			.digest('hex');
		if (!seenSegmentHashes.has(segmentHash)) {
			seenSegmentHashes.add(segmentHash);
			chunks.push({
				startLine: originalLineNumber,
				endLine: originalLineNumber,
				content: segment,
				segmentHash,
				type: `${chunkType}_segment`,
			});
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLength = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for newline, except last line
		const originalLineNumber = 1 + i;

		// Oversized line: flush the pending chunk, then emit character segments.
		if (lineLength > effectiveMaxChars) {
			if (currentChunkLines.length > 0) {
				finalizeChunk(i - 1);
			}
			let remainingLineContent = line;
			let currentSegmentStartChar = 0;
			while (remainingLineContent.length > 0) {
				const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS);
				remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS);
				createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar);
				currentSegmentStartChar += MAX_BLOCK_CHARS;
			}
			chunkStartLineIndex = i + 1;
			continue;
		}

		if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
			// Re-balancing: do not leave a tail smaller than MIN_CHUNK_REMAINDER_CHARS.
			let splitIndex = i - 1;
			if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 1) {
				let remainderLength = 0;
				for (let j = i; j < lines.length; j++) {
					remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0);
				}
				if (remainderLength < MIN_CHUNK_REMAINDER_CHARS) {
					for (let k = i - 2; k >= chunkStartLineIndex; k--) {
						const potentialChunkLength = lines.slice(chunkStartLineIndex, k + 1).join('\n').length + 1;
						const potentialNextChunkLength = lines.slice(k + 1).join('\n').length + 1;
						if (potentialChunkLength >= MIN_BLOCK_CHARS && potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS) {
							splitIndex = k;
							break;
						}
					}
				}
			}

			finalizeChunk(splitIndex);

			// DELIBERATE DIVERGENCE from Zoo (documented in the function comment): after a
			// re-balanced split the split point sits BEFORE the current line, and Zoo's
			// `if (i >= chunkStartLineIndex)` then pushes only the current line — silently
			// dropping every line between the split point and `i` (measured: 8 lines lost
			// on a 56-line file). Reproducing that would lose content from the very files
			// this index exists to make searchable, and there is no compatibility to keep:
			// Zoo never indexes this corpus. Replay from the new start instead.
			if (chunkStartLineIndex <= i - 1) {
				i = chunkStartLineIndex - 1;
				continue;
			}

			currentChunkLines.push(line);
			currentChunkLength += lineLength;
		} else {
			currentChunkLines.push(line);
			currentChunkLength += lineLength;
		}
	}

	if (currentChunkLines.length > 0) {
		finalizeChunk(lines.length - 1);
	}

	return chunks;
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface SupplementSelection {
	/** Workspace-relative paths, forward slashes, as `git ls-files` prints them. */
	selected: string[];
	/** git-visible files that are a blind spot but were dropped, by reason. */
	dropped: { too_large: number; binary: number; unreadable: number };
	/** Blind spots bucketed by kind (`.ps1`, `hidden-dir`…), the honest denominator. */
	by_kind: Record<string, number>;
	git_visible: number;
}

/** True when the first bytes look like text (no NUL byte) — the same test `git grep` uses. */
function looksLikeText(absPath: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(absPath, 'r');
		const buf = Buffer.alloc(TEXT_SNIFF_BYTES);
		const read = readSync(fd, buf, 0, TEXT_SNIFF_BYTES, 0);
		return !buf.subarray(0, read).includes(0);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* already closed */ }
		}
	}
}

/**
 * The files the supplement index covers: git-visible (so `.gitignore` is honoured
 * exactly as Zoo honours it), a Zoo blind spot (never a file Zoo already embeds),
 * a text file, and at most 1 MB — Zoo's own scanner cap, kept so the two corpora
 * are comparable.
 *
 * `git_visible` is returned alongside the selection because "0 selected" must be
 * distinguishable from "could not read the repository" (null from git is reported
 * as an error by the caller, not as an empty selection).
 */
export async function selectSupplementFiles(
	workspaceRoot: string,
	options: { maxFileBytes?: number } = {},
): Promise<SupplementSelection> {
	const maxBytes = options.maxFileBytes ?? MAX_SUPPLEMENT_FILE_BYTES;
	const paths = await listGitVisiblePaths(workspaceRoot);
	if (paths === null) {
		throw new Error(`not a git workspace (or git unavailable): ${workspaceRoot}`);
	}
	const selection: SupplementSelection = {
		selected: [],
		dropped: { too_large: 0, binary: 0, unreadable: 0 },
		by_kind: {},
		git_visible: paths.length,
	};
	for (const relPath of paths) {
		const kind = classifyZooPath(relPath);
		if (kind === null || kind === 'eligible') continue; // Zoo indexes it, or it is not text
		selection.by_kind[kind] = (selection.by_kind[kind] || 0) + 1;
		const absPath = join(workspaceRoot, relPath);
		let size: number;
		try {
			const st = statSync(absPath);
			if (!st.isFile()) continue;
			size = st.size;
		} catch {
			selection.dropped.unreadable++;
			continue;
		}
		if (size > maxBytes) {
			selection.dropped.too_large++;
			continue;
		}
		if (!looksLikeText(absPath)) {
			selection.dropped.binary++;
			continue;
		}
		selection.selected.push(relPath);
	}
	selection.selected.sort();
	return selection;
}

// ── Single-writer guard ──────────────────────────────────────────────────────

/** The sentinel's fixed point id — sha256('rsm-supplement-sentinel'), formatted as a UUID. */
export const SUPPLEMENT_SENTINEL_ID = supplementPointId('rsm-supplement', 'sentinel');

/**
 * What the sentinel records. `writer` is the lane that owns the collection
 * (`machine:workspace`); `takenOverFrom` records the previous owner when an
 * explicit takeover happened, so a silent handover leaves a trace.
 * `embeddingModelId`/`embeddingModelDimensions` pin the embedding space the
 * existing points live in: the incremental skip keys on `fileHash` alone, so a
 * model switch with no recorded fingerprint would keep vectors from another
 * space and report them as "unchanged" (review ms#1514, fix 2).
 */
export interface SupplementWriterRecord {
	writer: string;
	since: string;
	remote: string;
	takenOverFrom?: string;
	embeddingModelId?: string;
	embeddingModelDimensions?: number;
}

export interface QdrantLike {
	query?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	search?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	upsert?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	scroll?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	retrieve?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	delete?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	getCollection?: (collection: string) => Promise<any>;
	createCollection?: (collection: string, body: Record<string, unknown>) => Promise<any>;
	collectionExists?: (collection: string) => Promise<any>;
}

/** Reads the writer sentinel; null when the collection is absent or holds no sentinel. */export async function readWriterRecord(
	client: QdrantLike,
	collection: string,
): Promise<SupplementWriterRecord | null> {
	try {
		if (client.retrieve) {
			const res: any = await client.retrieve(collection, {
				ids: [SUPPLEMENT_SENTINEL_ID],
				with_payload: true,
				with_vector: false,
			});
			const point = (res?.points ?? res?.result?.points ?? [])[0];
			const payload = point?.payload;
			if (payload && typeof payload.writer === 'string') {
				return {
					writer: payload.writer,
					since: String(payload.since ?? ''),
					remote: String(payload.remote ?? ''),
					takenOverFrom: typeof payload.takenOverFrom === 'string' ? payload.takenOverFrom : undefined,
					...(typeof payload.embeddingModelId === 'string' ? { embeddingModelId: payload.embeddingModelId } : {}),
					...(typeof payload.embeddingModelDimensions === 'number' ? { embeddingModelDimensions: payload.embeddingModelDimensions } : {}),
				};
			}
			return null;
		}
		// Fallback for clients without `retrieve`: scroll filtered on the sentinel id.
		if (client.scroll) {
			const res: any = await client.scroll(collection, {
				filter: { must: [{ has_id: [SUPPLEMENT_SENTINEL_ID] }] },
				limit: 1,
				with_payload: true,
				with_vector: false,
			});
			const point = (res?.points ?? res?.result?.points ?? [])[0];
			const payload = point?.payload;
			if (payload && typeof payload.writer === 'string') {
				return {
					writer: payload.writer,
					since: String(payload.since ?? ''),
					remote: String(payload.remote ?? ''),
					takenOverFrom: typeof payload.takenOverFrom === 'string' ? payload.takenOverFrom : undefined,
					...(typeof payload.embeddingModelId === 'string' ? { embeddingModelId: payload.embeddingModelId } : {}),
					...(typeof payload.embeddingModelDimensions === 'number' ? { embeddingModelDimensions: payload.embeddingModelDimensions } : {}),
				};
			}
		}
		return null;
	} catch {
		return null; // collection absent — no writer yet
	}
}

/**
 * Picks the largest existing collection among `candidates` — the same "largest
 * variant wins" rule `codebase_search` applies (#4352): one folder can own up to
 * four `ws-` collections (path spellings), and the template for a `sup-` creation
 * must be the one the searches actually serve, not the first spelling that exists.
 */
export async function pickLargestCollection(
	client: QdrantLike,
	candidates: string[],
): Promise<string | null> {
	if (!client.getCollection) return null;
	let best: { name: string; points: number } | null = null;
	for (const name of candidates) {
		try {
			const info: any = await client.getCollection(name);
			const points = Number(info?.points_count ?? info?.result?.points_count ?? 0);
			if (!best || points > best.points) best = { name, points };
		} catch {
			// absent spelling — not an error, there are up to twelve of them
		}
	}
	return best?.name ?? null;
}

/** The collection's vector size + distance, copied from the served Zoo collection. */
export async function readTemplateVectorConfig(
	client: QdrantLike,
	templateCollection: string | null | undefined,
): Promise<{ size: number; distance: string } | null> {
	if (!templateCollection || !client.getCollection) return null;
	try {
		const info: any = await client.getCollection(templateCollection);
		const params = info?.config?.params?.vectors ?? info?.result?.config?.params?.vectors;
		const named = params && typeof params === 'object' && !Array.isArray(params) && typeof params.size !== 'number'
			? (Object.values(params)[0] as any)
			: params;
		if (named && typeof named.size === 'number') {
			return { size: named.size, distance: String(named.distance ?? 'Cosine') };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Enforces one writer per collection.
 *
 * With no sentinel the caller becomes the writer. With a sentinel naming someone
 * else this throws unless `takeover` is true — the escape hatch is explicit because
 * the failure it prevents is silent: two seats embedding the same repository under
 * two different embedding models produce a collection whose points are not
 * comparable, and every search on it returns a meaningless ranking.
 *
 * Qdrant has no conditional write, so the claim is compare-after-write: after
 * writing, the sentinel is read back, and a writer whose record is no longer its
 * own (a concurrent claim won) throws instead of proceeding.
 */
export async function claimSupplementWriter(
	client: QdrantLike,
	collection: string,
	writer: string,
	options: {
		remote: string;
		takeover?: boolean;
		dryRun?: boolean;
		now?: string;
		vector: number[];
		/** Recorded in the sentinel so the incremental skip can detect a model switch. */
		embeddingModel?: { id: string | null; dimensions: number | null };
	},
): Promise<{ claimed: boolean; previous: SupplementWriterRecord | null; sentinelId: string }> {
	const previous = await readWriterRecord(client, collection);
	const isOther = previous !== null && previous.writer !== writer;
	if (isOther && !options.takeover) {
		throw new Error(
			`collection ${collection} is written by ${previous?.writer} (since ${previous?.since}). ` +
			`One writer per supplement collection is enforced in code: pass takeover: true only if this lane ` +
			`is meant to own it from now on.`
		);
	}
	if (options.dryRun) return { claimed: false, previous, sentinelId: SUPPLEMENT_SENTINEL_ID };
	if (!client.upsert) throw new Error('qdrant client has no upsert');
	await client.upsert(collection, {
		wait: true,
		points: [{
			id: SUPPLEMENT_SENTINEL_ID,
			vector: options.vector,
			payload: {
				// `type: 'metadata'` is what both search paths already exclude, so the
				// sentinel can never surface as a hit.
				type: 'metadata',
				source: 'rsm-supplement-sentinel',
				writer,
				since: options.now ?? new Date().toISOString(),
				remote: options.remote,
				...(isOther ? { takenOverFrom: previous?.writer } : {}),
				...(options.embeddingModel?.id ? { embeddingModelId: options.embeddingModel.id } : {}),
				...(options.embeddingModel?.dimensions ? { embeddingModelDimensions: options.embeddingModel.dimensions } : {}),
			},
		}],
	});
	const readBack = await readWriterRecord(client, collection);
	if (readBack && readBack.writer !== writer) {
		throw new Error(
			`writer guard: ${collection} is now owned by ${readBack.writer}, not ${writer} — a concurrent ` +
			`claim won the sentinel; no points were written by this call, but the sentinel itself may have ` +
			`been overwritten.`
		);
	}
	return { claimed: true, previous, sentinelId: SUPPLEMENT_SENTINEL_ID };
}

// ── Search (merged by codebase_search) ───────────────────────────────────────

/** Same filter shape as the main search: no metadata, no reference-only or i18n trees. */
function buildSupplementFilter(directoryPrefix?: string): Record<string, unknown> {
	const filter: any = {
		must_not: [
			{ key: 'type', match: { value: 'metadata' } },
			{ key: 'pathSegments.0', match: { value: 'roo-code' } },
			{ key: 'pathSegments.0', match: { value: 'i18n' } },
		],
	};
	if (directoryPrefix) {
		const segments = directoryPrefix.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
		if (segments.length > 0) {
			// Qdrant indexes pathSegments.0-4 only; filtering deeper eliminates every
			// candidate on the ANN pass (#797).
			filter.must = segments.slice(0, 5).map((segment, index) => ({
				key: `pathSegments.${index}`,
				match: { value: segment },
			}));
		}
	}
	return filter;
}

/**
 * Queries the supplement collection with the SAME query vector as the main search.
 * Fail-open by contract: an unreachable, missing or malformed supplement collection
 * returns `{ points: [], error }` and never fails the search that called it — a
 * best-effort extra corpus must never take the main corpus down with it.
 */
export async function searchSupplement(
	client: QdrantLike,
	collection: string,
	vector: number[],
	options: {
		limit: number;
		minScore: number;
		directoryPrefix?: string;
		timeoutSec?: number;
	} = { limit: 15, minScore: 0.5 },
): Promise<{ points: any[]; error?: string }> {
	try {
		if (!client.query) return { points: [], error: 'qdrant client has no query()' };
		const res: any = await client.query(collection, {
			query: vector,
			filter: buildSupplementFilter(options.directoryPrefix),
			score_threshold: options.minScore,
			limit: options.limit,
			params: { hnsw_ef: 256, exact: false },
			...(options.timeoutSec ? { timeout: options.timeoutSec } : {}),
			with_payload: { include: ['filePath', 'codeChunk', 'startLine', 'endLine', 'pathSegments'] },
		});
		const points = (res?.points ?? res?.result?.points ?? []).filter(
			(p: any) => p?.payload?.filePath && p?.payload?.codeChunk,
		);
		return { points };
	} catch (error) {
		return { points: [], error: error instanceof Error ? error.message : String(error) };
	}
}

// ── Index run ────────────────────────────────────────────────────────────────

export interface SupplementIndexReport {
	status: 'success' | 'dry_run';
	collection: string;
	remote: string;
	writer: string;
	dry_run: boolean;
	collection_exists: boolean;
	writer_guard: { ok: boolean; previous_writer: string | null; took_over_from?: string };
	vector_config: { size: number; distance: string } | null;
	git_visible: number;
	files_selected: number;
	blind_spots_by_kind: Record<string, number>;
	files_skipped_unchanged: number;
	files_to_index: number;
	files_indexed: number;
	files_failed: { path: string; error: string }[];
	files_removed: number;
	points_deleted: number;
	chunks_embedded: number;
	points_written: number;
	batches: number;
	truncated: boolean;
	elapsed_ms: number;
	warnings: string[];
}

export interface SupplementIndexDeps {
	client: QdrantLike;
	workspaceRoot: string;
	/** Lane identity, `machine:workspace` — the value recorded in the sentinel. */
	writer: string;
	/** Default true: report what would happen, write nothing. */
	dryRun?: boolean;
	takeover?: boolean;
	/** The served Zoo collection to copy vector size/distance from (required for creation). */
	templateCollection?: string | null;
	/** Model id this run embeds with — recorded in the sentinel, compared on the next run. */
	embeddingModelId?: string | null;
	embed: (texts: string[]) => Promise<number[][]>;
	batchSize?: number;
	throttleMs?: number;
	maxFiles?: number;
	maxChunks?: number;
	now?: () => string;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Existing points of the supplement collection: filePath → { fileHash, ids }. */
async function readIndexedFiles(
	client: QdrantLike,
	collection: string,
): Promise<{ exists: boolean; files: Map<string, { fileHash: string; ids: string[] }> }> {
	const files = new Map<string, { fileHash: string; ids: string[] }>();
	if (!client.scroll) return { exists: false, files };
	let offset: any;
	let exists = true;
	for (let page = 0; page < 200; page++) {
		let res: any;
		try {
			res = await client.scroll(collection, {
				limit: 1000,
				...(offset !== undefined && offset !== null ? { offset } : {}),
				with_payload: { include: ['filePath', 'fileHash', 'type'] },
				with_vector: false,
			});
		} catch {
			exists = false;
			break;
		}
		const points = res?.points ?? res?.result?.points ?? [];
		for (const p of points) {
			const fp = p?.payload?.filePath;
			if (!fp || p?.payload?.type === 'metadata') continue;
			const entry = files.get(String(fp)) ?? { fileHash: String(p?.payload?.fileHash ?? ''), ids: [] };
			entry.ids.push(String(p.id));
			files.set(String(fp), entry);
		}
		offset = res?.next_page_offset ?? res?.result?.next_page_offset;
		if (offset === undefined || offset === null) break;
	}
	return { exists, files };
}

/**
 * One index run: select, compare, chunk, embed, upsert.
 *
 * Incremental by `fileHash`: a file whose stored hash matches the hash on disk is
 * skipped without being chunked or embedded. Files whose hash changed have their
 * old points deleted before the new ones are written (a shrinking file must not
 * keep orphan chunks), and files that disappeared from disk have their points
 * removed — Zoo's rename/delete GC gap (#2609/#2554), not repeated here.
 */
export async function runSupplementIndex(deps: SupplementIndexDeps): Promise<SupplementIndexReport> {
	const startedAt = Date.now();
	const dryRun = deps.dryRun !== false;
	const batchSize = Math.max(1, deps.batchSize ?? 32);
	const throttleMs = Math.max(0, deps.throttleMs ?? 200);
	const maxFiles = deps.maxFiles && deps.maxFiles > 0 ? deps.maxFiles : Number.POSITIVE_INFINITY;
	const maxChunks = deps.maxChunks && deps.maxChunks > 0 ? deps.maxChunks : 20_000;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? (() => new Date().toISOString());
	const warnings: string[] = [];

	const remote = await readOriginUrl(deps.workspaceRoot);
	const normalisedRemote = normaliseRemoteUrl(remote);
	const collection = supplementCollectionName(remote);
	if (!collection || !normalisedRemote) {
		throw new Error(
			`workspace ${deps.workspaceRoot} has no usable origin remote (got ${JSON.stringify(remote)}) — ` +
			`the supplement collection is keyed on the normalised remote URL, so there is nothing to key on.`
		);
	}

	const selection = await selectSupplementFiles(deps.workspaceRoot);
	const { exists: collectionExists, files: indexed } = await readIndexedFiles(deps.client, collection);

	// Writer guard before any write decision, so a foreign owner is refused early.
	const vectorConfig = await readTemplateVectorConfig(deps.client, deps.templateCollection);
	const previous = collectionExists ? await readWriterRecord(deps.client, collection) : null;
	const foreignWriter = previous !== null && previous.writer !== deps.writer;
	if (foreignWriter && !deps.takeover) {
		throw new Error(
			`collection ${collection} is written by ${previous?.writer} (since ${previous?.since}). ` +
			`One writer per supplement collection is enforced in code: pass takeover: true only if this lane ` +
			`is meant to own it from now on.`
		);
	}
	// Embedding-space guard (review ms#1514, fix 2). The incremental skip keys on
	// `fileHash` alone: after a model switch every hash is "unchanged", the run
	// would embed nothing, and the collection would mix two vector spaces while
	// reporting files_skipped_unchanged as good news. The sentinel fingerprint
	// makes the switch visible, and the run REFUSES — takeover does not cross a
	// model change, because that is exactly the silent failure it exists for.
	// Remedy: the supplement is derived data — delete the collection and rerun to
	// rebuild it whole under the current model.
	if (previous?.embeddingModelId != null) {
		const dimensionsMatch = previous.embeddingModelDimensions == null
			|| vectorConfig == null
			|| previous.embeddingModelDimensions === vectorConfig.size;
		if (previous.embeddingModelId !== deps.embeddingModelId || !dimensionsMatch) {
			throw new Error(
				`collection ${collection} holds vectors embedded with ${previous.embeddingModelId} (${previous.embeddingModelDimensions ?? '?'}d), ` +
				`but this run would embed with ${deps.embeddingModelId ?? 'an unknown model'} (${vectorConfig?.size ?? '?'}d). ` +
				`Mixing embedding spaces yields a meaningless ranking with no error, so the run refuses — ` +
				`takeover does not cross a model change. The supplement is derived data: delete the ` +
				`${collection} collection and rerun to rebuild it under the current model.`
			);
		}
	}

	const report: SupplementIndexReport = {
		status: dryRun ? 'dry_run' : 'success',
		collection,
		remote: normalisedRemote,
		writer: deps.writer,
		dry_run: dryRun,
		collection_exists: collectionExists,
		writer_guard: {
			ok: !foreignWriter || Boolean(deps.takeover),
			previous_writer: previous?.writer ?? null,
			...(foreignWriter && deps.takeover ? { took_over_from: previous?.writer } : {}),
		},
		vector_config: vectorConfig,
		git_visible: selection.git_visible,
		files_selected: selection.selected.length,
		blind_spots_by_kind: selection.by_kind,
		files_skipped_unchanged: 0,
		files_to_index: 0,
		files_indexed: 0,
		files_failed: [],
		files_removed: 0,
		points_deleted: 0,
		chunks_embedded: 0,
		points_written: 0,
		batches: 0,
		truncated: false,
		elapsed_ms: 0,
		warnings,
	};

	// 1. Plan: which files need work.
	const toIndex: { relPath: string; content: string; fileHash: string }[] = [];
	for (const relPath of selection.selected) {
		if (toIndex.length >= maxFiles) { report.truncated = true; break; }
		let content: string;
		try {
			content = readFileSync(join(deps.workspaceRoot, relPath), 'utf8');
		} catch (error) {
			report.files_failed.push({ path: relPath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const fileHash = fileHashOf(content);
		if (indexed.get(relPath)?.fileHash === fileHash) {
			report.files_skipped_unchanged++;
			continue;
		}
		toIndex.push({ relPath, content, fileHash });
	}
	report.files_to_index = toIndex.length;

	// 2. Files that vanished from disk but still have points.
	const removed = [...indexed.keys()].filter((fp) => !selection.selected.includes(fp));
	report.files_removed = removed.length;

	if (dryRun) {
		report.elapsed_ms = Date.now() - startedAt;
		return report;
	}

	// 3. Ensure the collection exists, mirroring the served Zoo collection's vectors.
	if (!collectionExists) {
		if (!deps.client.createCollection) throw new Error('qdrant client has no createCollection');
		if (!vectorConfig) {
			throw new Error(
				`cannot create ${collection}: the served Zoo collection (${deps.templateCollection ?? 'none given'}) ` +
				`could not be read, and the vector size/distance must mirror it — a guessed size produces a ` +
				`collection whose points are not comparable with the ws- ones.`
			);
		}
		await deps.client.createCollection(collection, {
			vectors: { size: vectorConfig.size, distance: vectorConfig.distance },
		});
		// The search path caches "collection absent" for 5 minutes — a collection
		// that just came into being must not stay invisible until the TTL expires.
		collectionPresenceCache.delete(deps.workspaceRoot);
	}

	// 4. Claim the writer (sentinel), with a zero vector of the collection's size.
	const claim = await claimSupplementWriter(deps.client, collection, deps.writer, {
		remote: normalisedRemote,
		takeover: deps.takeover,
		vector: new Array(vectorConfig?.size ?? 0).fill(0),
		now: now(),
		embeddingModel: { id: deps.embeddingModelId ?? null, dimensions: vectorConfig?.size ?? null },
	});
	if (claim.claimed) report.writer_guard.ok = true;

	// 5. Delete points of removed files, and of changed files (stale chunks).
	const idsToDelete: string[] = [];
	for (const fp of removed) idsToDelete.push(...(indexed.get(fp)?.ids ?? []));
	for (const item of toIndex) idsToDelete.push(...(indexed.get(item.relPath)?.ids ?? []));
	if (idsToDelete.length > 0 && deps.client.delete) {
		for (let i = 0; i < idsToDelete.length; i += 500) {
			await deps.client.delete(collection, { points: idsToDelete.slice(i, i + 500) });
		}
		report.points_deleted = idsToDelete.length;
	}

	// 6. Chunk, then embed in throttled batches.
	const pending: { id: string; relPath: string; chunk: SupplementChunk; fileHash: string }[] = [];
	for (const item of toIndex) {
		const chunks = chunkTextByLines(item.content, item.relPath);
		if (chunks.length === 0) {
			warnings.push(`${item.relPath}: no chunk above MIN_BLOCK_CHARS (${MIN_BLOCK_CHARS}) — nothing to embed`);
		}
		for (const chunk of chunks) {
			if (pending.length >= maxChunks) { report.truncated = true; break; }
			pending.push({
				id: supplementPointId(item.relPath, chunk.segmentHash),
				relPath: item.relPath,
				chunk,
				fileHash: item.fileHash,
			});
		}
		if (pending.length >= maxChunks) break;
	}

	let written = 0;
	const filesWritten = new Set<string>();
	for (let i = 0; i < pending.length; i += batchSize) {
		const batch = pending.slice(i, i + batchSize);
		const vectors = await deps.embed(batch.map((b) => b.chunk.content));
		if (vectors.length !== batch.length) {
			throw new Error(
				`embedding returned ${vectors.length} vectors for ${batch.length} chunks — refusing to write a ` +
				`misaligned batch (chunk/vector mismatch silently corrupts the index)`
			);
		}
		if (!deps.client.upsert) throw new Error('qdrant client has no upsert');
		await deps.client.upsert(collection, {
			wait: true,
			points: batch.map((b, index) => ({
				id: b.id,
				vector: vectors[index],
				payload: {
					filePath: b.relPath,
					codeChunk: b.chunk.content,
					startLine: b.chunk.startLine,
					endLine: b.chunk.endLine,
					segmentHash: b.chunk.segmentHash,
					pathSegments: pathSegmentsOf(b.relPath),
					fileHash: b.fileHash,
					writer: deps.writer,
					source: 'rsm-supplement',
					type: b.chunk.type,
				},
			})),
		});
		report.batches++;
		report.chunks_embedded += batch.length;
		written += batch.length;
		for (const b of batch) filesWritten.add(b.relPath);
		if (throttleMs > 0 && i + batchSize < pending.length) await sleep(throttleMs);
	}
	report.points_written = written;
	report.files_indexed = filesWritten.size;
	report.elapsed_ms = Date.now() - startedAt;
	return report;
}

// ── Workspace → collection resolution (cached, for the search path) ───────────

const collectionCache = new Map<string, { value: string | null; remote: string | null; expiresAt: number }>();
const COLLECTION_CACHE_TTL_MS = 5 * 60_000;

/**
 * Negative cache for the search path: a derived collection name is NOT an
 * existence proof, and most repos will never have a `sup-` collection. Without
 * this gate every search pays a Qdrant query that 404s and the response
 * announces a supplement that does not exist (review ms#1514, fix 1). Same TTL
 * as the remote probe.
 */
const collectionPresenceCache = new Map<string, { name: string; present: boolean; expiresAt: number }>();

/** Test hook — clears the workspace → collection caches (name and presence). */
export function clearSupplementCollectionCache(): void {
	collectionCache.clear();
	collectionPresenceCache.clear();
}

/**
 * Whether the supplement collection actually exists in Qdrant. Cached per
 * workspace for 5 minutes, absence included: probing on every search would
 * reintroduce the per-call round trip this gate removes. A client without
 * `getCollection` cannot tell, so it says "present" and lets `searchSupplement`
 * fail open — never suppress the corpus because the instrument is missing.
 */
export async function supplementCollectionPresent(
	client: QdrantLike,
	workspaceRoot: string,
	collection: string,
): Promise<boolean> {
	const cached = collectionPresenceCache.get(workspaceRoot);
	if (cached && cached.name === collection && cached.expiresAt > Date.now()) return cached.present;
	let present = true;
	if (typeof client.getCollection === 'function') {
		try {
			await client.getCollection(collection);
		} catch {
			present = false;
		}
	}
	collectionPresenceCache.set(workspaceRoot, { name: collection, present, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS });
	return present;
}

/**
 * The supplement collection serving this workspace, read from its `origin` remote.
 * Cached for 5 minutes per path: `codebase_search` runs it on every call and a
 * `git config` fork per search is not free. Null when the workspace has no remote
 * (no supplement, and no error — the search simply reports none).
 */
export async function resolveSupplementCollection(workspaceRoot: string): Promise<string | null> {
	const cached = collectionCache.get(workspaceRoot);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const remote = await readOriginUrl(workspaceRoot);
	const value = supplementCollectionName(remote);
	collectionCache.set(workspaceRoot, {
		value,
		remote: normaliseRemoteUrl(remote),
		expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS,
	});
	return value;
}
