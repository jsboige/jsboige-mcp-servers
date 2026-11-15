/**
 * #4736 P2 — bug-for-bug parity with Zoo Code's markdown indexer: segmentHash
 * formulas, line chunking, uuidv5 point ids and the upsert payload shape.
 *
 * RSM becomes the writer of the shared `ws-*` collections (user decision
 * 14/11/2026), but 328k points already live in ws-d2ffdbaa832aed16 with ids
 * minted by Zoo's indexer. A writer that recomputed ids its own way would fork
 * every block it touches into a twin point — the exact pathology the shared
 * collection contract (P1, collection-naming.ts) exists to prevent. This module
 * is the byte-exact port of the code that minted those ids, so the recomputed
 * id of an unchanged block IS the stored id.
 *
 * Validated by measurement before being ported (web1, 15/11): a faithful
 * Python replay of these formulas reproduced, for 5 already-indexed markdown
 * files (19/22/34/24/76 stored points), every segmentHash, every uuidv5 id and
 * every payload field at 100%; re-upserting 3 of them (117 points, vectors
 * reused) left points_count at 328245 → 328245 (DELTA 0) with payloads
 * identical on post-verify.
 *
 * ONE non-obvious parameter the hashes bake in (#4736 P2 finding): Zoo's
 * scanner called parseFile with the ABSOLUTE writer path, and the hash formula
 * embeds that path — while the payload filePath is RELATIVE (native
 * separators). The historical writer prefix on this corpus is
 * `d:\dev\roo-extensions` (recovered by replaying every candidate prefix
 * against the stored hashes; it is the only one that matches). Any re-writer
 * MUST parse with that same absolute prefix or it mints different ids for the
 * same content. `parseZooMarkdownContent` takes the absolute writer path;
 * `toZooPointPayload` takes the relative path — mirroring Zoo's split
 * (scanner.ts:449-465).
 *
 * UTF-16 subtlety, DO NOT "FIX" IT: the hash formula interpolates
 * `content.slice(0, 100)` — 100 UTF-16 code units, not code points. A cut
 * landing inside a surrogate pair (emoji) leaves a lone surrogate in the
 * preview, which Node's sha256.update() encodes as U+FFFD (probed: identical
 * digest via update(string), Buffer.from(…, 'utf8') and an explicit
 * lone→U+FFFD replacement — beware, Python's encode(errors='replace') would
 * hash '?' instead, a DIFFERENT byte). No stored point adjudicates this byte
 * (adjudication pass 15/11: none of the 5 measured files has a surrogate cut
 * in any preview), so the reference is the runtime Zoo ran on; the behavior
 * is native in TS and pinned by test with a literal hash.
 *
 * Scope: markdown (md/markdown) + the shared line chunker, i.e. every path
 * measured above. The tree-sitter AST pipeline that indexed the corpus' .ts
 * files (web-tree-sitter + WASM grammars) is deliberately NOT ported here — it
 * is a separate, heavier parity surface left to the writer phase (P3).
 *
 * This module is NOT a general-purpose chunker. services/code-index's own
 * `supplement-index.ts` chunks for the sup-* collections and deliberately
 * diverges on two points (it replays dropped lines instead of dropping them,
 * and never cuts a surrogate pair). Those divergences are correct for sup-*
 * but would break ws-* id parity — which is why this port is separate and
 * literal instead of shared.
 */
import { createHash } from 'crypto';
import { v5 as uuidv5 } from 'uuid';

// ─── Zoo constants (roo-code/src/services/code-index/constants/index.ts) ─────

export const ZOO_CODE_BLOCK_NAMESPACE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
export const ZOO_MAX_BLOCK_CHARS = 1000;
export const ZOO_MIN_BLOCK_CHARS = 50;
export const ZOO_MIN_CHUNK_REMAINDER_CHARS = 200;
export const ZOO_MAX_CHARS_TOLERANCE_FACTOR = 1.15;

// ─── Zoo CodeBlock shape (roo-code/src/services/code-index/interfaces.ts) ────

export interface ZooCodeBlock {
	file_path: string;
	identifier: string | null;
	type: string;
	start_line: number;
	end_line: number;
	content: string;
	segmentHash: string;
	fileHash: string;
}

/** The upsert payload Zoo's scanner attaches to each point (scanner.ts:458-464). */
export interface ZooPointPayload {
	filePath: string;
	codeChunk: string;
	startLine: number;
	endLine: number;
	segmentHash: string;
}

// ─── Markdown header extraction (tree-sitter/markdownParser.ts, ported) ──────

export interface ZooMarkdownHeader {
	/** 0-based row of the header's first line. */
	startRow: number;
	/** 0-based row of the section's last line (start of next header − 1; EOF for the last). */
	endRow: number;
	text: string;
	level: number;
}

/**
 * Port of parseMarkdown(): ATX (`#{1,6} Text`) and setext (`===`/`---`
 * underlines with a valid plain-text line above), each header yielding a
 * section that extends to the start of the next header (or EOF).
 *
 * The original emits name+definition mock captures, sorts them by row and
 * regroups them in adjacent pairs to recompute section ranges. Rows are
 * strictly increasing along the scan (one line yields at most one header, and
 * a setext's text row always follows the previous header's row), so the sort
 * is a no-op and the pairing is exactly the emission order — we build the
 * pairs directly. Equivalence was measured against the stored corpus.
 */
export function parseZooMarkdownHeaders(content: string): ZooMarkdownHeader[] {
	if (!content || content.trim() === '') return [];

	const lines = content.split('\n');
	const found: Array<{ row: number; text: string; level: number }> = [];

	const atxHeaderRegex = /^(#{1,6})\s+(.+)$/;
	const setextH1Regex = /^={3,}\s*$/;
	const setextH2Regex = /^-{3,}\s*$/;
	const validSetextTextRegex = /^\s*[^#<>!\[\]`\t]+[^\n]$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const atxMatch = line.match(atxHeaderRegex);
		if (atxMatch) {
			found.push({ row: i, text: atxMatch[2].trim(), level: atxMatch[1].length });
			continue;
		}

		if (i > 0) {
			if (setextH1Regex.test(line) && validSetextTextRegex.test(lines[i - 1])) {
				found.push({ row: i - 1, text: lines[i - 1].trim(), level: 1 });
				continue;
			}
			if (setextH2Regex.test(line) && validSetextTextRegex.test(lines[i - 1])) {
				found.push({ row: i - 1, text: lines[i - 1].trim(), level: 2 });
				continue;
			}
		}
	}

	return found.map((h, idx) => ({
		startRow: h.row,
		endRow: idx < found.length - 1 ? found[idx + 1].row - 1 : lines.length - 1,
		text: h.text,
		level: h.level,
	}));
}

// ─── Line chunker (parser.ts _chunkTextByLines, ported) ──────────────────────

/**
 * Port of _chunkTextByLines(). Accumulates lines into chunks up to
 * MAX_BLOCK_CHARS × 1.15, splits oversized lines into fixed 1000-char
 * segments, and re-balances a final split when the remainder would be tiny.
 *
 * BUG-FOR-BUG, DO NOT "FIX": when re-balancing picks an earlier split line,
 * the original drops the lines between that split and the current line —
 * `finalizeChunk(splitIndex)` resets the chunk window past them and the loop
 * guard `if (i >= chunkStartLineIndex)` skips them for real. Those lines are
 * never chunked. The stored corpus embeds this behavior (measured: the 76
 * points of a 44KB file only match with it), so parity requires the drop —
 * supplement-index.ts's replay-instead-of-drop variant is the *better*
 * chunker but mints different hashes.
 */
export function chunkTextByLinesZoo(
	lines: string[],
	filePath: string,
	fileHash: string,
	chunkType: string,
	seenSegmentHashes: Set<string>,
	baseStartLine: number = 1, // 1-based start line of the *first* line in `lines`
): ZooCodeBlock[] {
	const chunks: ZooCodeBlock[] = [];
	let currentChunkLines: string[] = [];
	let currentChunkLength = 0;
	let chunkStartLineIndex = 0; // 0-based index within the `lines` array
	const effectiveMaxChars = ZOO_MAX_BLOCK_CHARS * ZOO_MAX_CHARS_TOLERANCE_FACTOR;

	const finalizeChunk = (endLineIndex: number) => {
		if (currentChunkLength >= ZOO_MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
			const chunkContent = currentChunkLines.join('\n');
			const startLine = baseStartLine + chunkStartLineIndex;
			const endLine = baseStartLine + endLineIndex;
			const contentPreview = chunkContent.slice(0, 100);
			const segmentHash = createHash('sha256')
				.update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
				.digest('hex');

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash);
				chunks.push({
					file_path: filePath,
					identifier: null,
					type: chunkType,
					start_line: startLine,
					end_line: endLine,
					content: chunkContent,
					segmentHash,
					fileHash,
				});
			}
		}
		currentChunkLines = [];
		currentChunkLength = 0;
		chunkStartLineIndex = endLineIndex + 1;
	};

	const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
		const segmentPreview = segment.slice(0, 100);
		const segmentHash = createHash('sha256')
			.update(
				`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
			)
			.digest('hex');

		if (!seenSegmentHashes.has(segmentHash)) {
			seenSegmentHashes.add(segmentHash);
			chunks.push({
				file_path: filePath,
				identifier: null,
				type: `${chunkType}_segment`,
				start_line: originalLineNumber,
				end_line: originalLineNumber,
				content: segment,
				segmentHash,
				fileHash,
			});
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLength = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for newline, except last line
		const originalLineNumber = baseStartLine + i;

		// Handle oversized lines (longer than effectiveMaxChars)
		if (lineLength > effectiveMaxChars) {
			// Finalize any existing normal chunk before processing the oversized line
			if (currentChunkLines.length > 0) {
				finalizeChunk(i - 1);
			}

			// Split the oversized line into segments
			let remainingLineContent = line;
			let currentSegmentStartChar = 0;
			while (remainingLineContent.length > 0) {
				const segment = remainingLineContent.substring(0, ZOO_MAX_BLOCK_CHARS);
				remainingLineContent = remainingLineContent.substring(ZOO_MAX_BLOCK_CHARS);
				createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar);
				currentSegmentStartChar += ZOO_MAX_BLOCK_CHARS;
			}
			// Update chunkStartLineIndex to continue processing from the next line
			chunkStartLineIndex = i + 1;
			continue;
		}

		// Handle normally sized lines
		if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
			// Re-balancing Logic
			let splitIndex = i - 1;
			let remainderLength = 0;
			for (let j = i; j < lines.length; j++) {
				remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0);
			}

			if (
				currentChunkLength >= ZOO_MIN_BLOCK_CHARS &&
				remainderLength < ZOO_MIN_CHUNK_REMAINDER_CHARS &&
				currentChunkLines.length > 1
			) {
				for (let k = i - 2; k >= chunkStartLineIndex; k--) {
					const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1);
					const potentialChunkLength = potentialChunkLines.join('\n').length + 1;
					const potentialNextChunkLines = lines.slice(k + 1);
					const potentialNextChunkLength = potentialNextChunkLines.join('\n').length + 1;

					if (
						potentialChunkLength >= ZOO_MIN_BLOCK_CHARS &&
						potentialNextChunkLength >= ZOO_MIN_CHUNK_REMAINDER_CHARS
					) {
						splitIndex = k;
						break;
					}
				}
			}

			finalizeChunk(splitIndex);

			if (i >= chunkStartLineIndex) {
				currentChunkLines.push(line);
				currentChunkLength += lineLength;
			} else {
				// Zoo drops the lines between the re-balanced split and the
				// current line (see function doc) — jump past them.
				i = chunkStartLineIndex - 1;
				continue;
			}
		} else {
			currentChunkLines.push(line);
			currentChunkLength += lineLength;
		}
	}

	// Process the last remaining chunk
	if (currentChunkLines.length > 0) {
		finalizeChunk(lines.length - 1);
	}

	return chunks;
}

// ─── Markdown sections (parser.ts processMarkdownSection, ported) ────────────

function processMarkdownSectionZoo(
	lines: string[],
	filePath: string,
	fileHash: string,
	type: string,
	seenSegmentHashes: Set<string>,
	startLine: number,
	identifier: string | null = null,
): ZooCodeBlock[] {
	const content = lines.join('\n');

	if (content.trim().length < ZOO_MIN_BLOCK_CHARS) {
		return [];
	}

	// Check if content needs chunking (either total size or individual line size)
	const needsChunking =
		content.length > ZOO_MAX_BLOCK_CHARS * ZOO_MAX_CHARS_TOLERANCE_FACTOR ||
		lines.some(line => line.length > ZOO_MAX_BLOCK_CHARS * ZOO_MAX_CHARS_TOLERANCE_FACTOR);

	if (needsChunking) {
		// Apply chunking for large content or oversized lines
		const chunks = chunkTextByLinesZoo(lines, filePath, fileHash, type, seenSegmentHashes, startLine);
		// Preserve identifier in all chunks if provided
		if (identifier) {
			chunks.forEach(chunk => {
				chunk.identifier = identifier;
			});
		}
		return chunks;
	}

	// Create a single block for normal-sized content with no oversized lines
	const endLine = startLine + lines.length - 1;
	const contentPreview = content.slice(0, 100);
	const segmentHash = createHash('sha256')
		.update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
		.digest('hex');

	if (!seenSegmentHashes.has(segmentHash)) {
		seenSegmentHashes.add(segmentHash);
		return [
			{
				file_path: filePath,
				identifier,
				type,
				start_line: startLine,
				end_line: endLine,
				content,
				segmentHash,
				fileHash,
			},
		];
	}

	return [];
}

// ─── Markdown file (parser.ts parseMarkdownContent, ported) ──────────────────

/**
 * Port of parseMarkdownContent(): sections split on headers, pre-header
 * content, and trailing content, all through processMarkdownSectionZoo.
 *
 * @param absWriterPath The ABSOLUTE path Zoo's parser was invoked with — it is
 *        embedded in every segmentHash (see module doc: on this corpus the
 *        historical prefix is `d:\dev\roo-extensions`).
 * @param content File content (as read utf8).
 * @param fileHash sha256 hex of the content (or of the on-disk bytes Zoo read).
 */
export function parseZooMarkdownContent(absWriterPath: string, content: string, fileHash?: string): ZooCodeBlock[] {
	const hash = fileHash ?? createHash('sha256').update(content).digest('hex');
	const lines = content.split('\n');
	const seenSegmentHashes = new Set<string>();
	const markdownCaptures = parseZooMarkdownHeaders(content);

	if (markdownCaptures.length === 0) {
		// No headers found, process entire content
		return processMarkdownSectionZoo(lines, absWriterPath, hash, 'markdown_content', seenSegmentHashes, 1);
	}

	const results: ZooCodeBlock[] = [];
	let lastProcessedLine = 0;

	// Process content before the first header
	const firstHeaderRow = markdownCaptures[0].startRow;
	if (firstHeaderRow > 0) {
		const preHeaderLines = lines.slice(0, firstHeaderRow);
		const preHeaderBlocks = processMarkdownSectionZoo(
			preHeaderLines, absWriterPath, hash, 'markdown_content', seenSegmentHashes, 1,
		);
		results.push(...preHeaderBlocks);
	}

	// Process header sections
	for (const capture of markdownCaptures) {
		const startLine = capture.startRow + 1;
		const endLine = capture.endRow + 1;
		const sectionLines = lines.slice(startLine - 1, endLine);

		const sectionBlocks = processMarkdownSectionZoo(
			sectionLines, absWriterPath, hash, `markdown_header_h${capture.level}`,
			seenSegmentHashes, startLine, capture.text,
		);
		results.push(...sectionBlocks);

		lastProcessedLine = endLine;
	}

	// Process any remaining content after the last header section
	if (lastProcessedLine < lines.length) {
		const remainingLines = lines.slice(lastProcessedLine);
		const remainingBlocks = processMarkdownSectionZoo(
			remainingLines, absWriterPath, hash, 'markdown_content', seenSegmentHashes, lastProcessedLine + 1,
		);
		results.push(...remainingBlocks);
	}

	return results;
}

// ─── Point identity & payload (scanner.ts:449-465, ported) ───────────────────

/** Zoo's point id: uuidv5(segmentHash) in the code-block namespace. */
export function zooPointId(segmentHash: string): string {
	return uuidv5(segmentHash, ZOO_CODE_BLOCK_NAMESPACE);
}

/** Zoo's metadata point id (per-collection indexing marker, uuidv5 of a fixed name). */
export function zooIndexingMetadataPointId(): string {
	return uuidv5('__indexing_metadata__', ZOO_CODE_BLOCK_NAMESPACE);
}

/**
 * The upsert payload Zoo's scanner attaches to a block. NOTE the path split:
 * `relativeNativePath` (workspace-relative, native `\` separators on Windows)
 * is what the payload carries, while the block's file_path (absolute, hashed)
 * never leaves the id. Mirrors generateRelativeFilePath(normalize(file_path)).
 */
export function toZooPointPayload(block: ZooCodeBlock, relativeNativePath: string): ZooPointPayload {
	return {
		filePath: relativeNativePath,
		codeChunk: block.content,
		startLine: block.start_line,
		endLine: block.end_line,
		segmentHash: block.segmentHash,
	};
}
