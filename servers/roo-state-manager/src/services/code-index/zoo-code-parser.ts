/**
 * #4819 (5b) — AST parity with Zoo Code's code indexer, for the ws-* writer.
 *
 * Zoo's `CodeParser.parseContent` (roo-code/src/services/code-index/processors/parser.ts)
 * splits code files into blocks via web-tree-sitter grammars + per-language tag
 * queries, with a size-based fallback. The ws-* collections still hold the
 * points that indexer wrote: a writer that recomputed blocks its own way would
 * fork every code file it touches into twin generations the stale purge cannot
 * recognize (same pathology zoo-parity.ts exists to prevent for markdown).
 * This module is the literal port of that path, reusing zoo-parity's already
 * measurement-validated chunker for the line-based paths.
 *
 * Provenance (see the 5b.0 design note on #4819):
 *  - Query strings: vendored byte-identical in ./zoo-queries/ from the
 *    reference submodule roo-code @cb836567 — diff against the zoo-parity.ts
 *    pin 67df9f9c (Zoo 3.92) measured EMPTY on 17/11 (queries/, parser.ts,
 *    languageParser.ts, constants, supported-extensions).
 *  - ext→language switch: verbatim from tree-sitter/languageParser.ts.
 *  - BFS block walk: verbatim from code-index/processors/parser.ts.
 *  - Grammars: the same prebuilt WASM binaries Zoo ships (tree-sitter-wasms),
 *    loaded lazily per extension and cached for the process lifetime.
 *
 * Deliberate divergence (one): Zoo loads wasm from its bundled dist directory
 * (VSIX constraint); this is a Node server, so the binaries resolve from
 * node_modules at runtime — same bytes, different location.
 *
 * Deliberate divergence (two): `elm`/`htm` sit in Zoo's scannerExtensions but
 * have NO case in its language switch — there the parser load throws, is
 * caught, and yields zero blocks. `routeZooFileExtension` excludes them up
 * front (same net effect: no points, without a per-file error log).
 *
 * Deliberate divergence (three): a grammar/wasm load failure THROWS instead
 * of yielding zero blocks (Zoo's behavior). The ws-writer purges a planned
 * file's stale points — "0 blocks" is read as a legitimate rewrite — so a
 * load failure returned as [] would delete the stored corpus for that file.
 * The writer catches the throw, skips the file and keeps its points.
 */
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import {
	Parser,
	Language,
	Query,
} from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
// ESM runtime (package "type": "module"): no global require — the codebase
// convention (server-config.ts) is a module-scoped createRequire.
const require = createRequire(import.meta.url);
import { chunkTextByLinesZoo, type ZooCodeBlock } from './zoo-parity.js';
import {
	cQuery,
	cppQuery,
	csharpQuery,
	cssQuery,
	elispQuery,
	elixirQuery,
	embeddedTemplateQuery,
	goQuery,
	htmlQuery,
	javaQuery,
	javascriptQuery,
	kotlinQuery,
	luaQuery,
	ocamlQuery,
	phpQuery,
	pythonQuery,
	rubyQuery,
	rustQuery,
	solidityQuery,
	systemrdlQuery,
	tlaPlusQuery,
	tomlQuery,
	tsxQuery,
	typescriptQuery,
	vueQuery,
	zigQuery,
} from './zoo-queries/index.js';

// ─── Population routing (supported-extensions.ts + languageParser.ts) ───────

/** Zoo's fallbackExtensions — always chunked by size, never parsed. */
export const ZOO_FALLBACK_EXTENSIONS: ReadonlySet<string> = new Set(['.vb', '.scala', '.swift']);

/**
 * Extensions with a grammar case in Zoo's languageParser switch. `swift` and
 * `scala` also have cases there but are unreachable (fallback routes them
 * first) and are intentionally absent. `elm`/`htm` are in scannerExtensions
 * with NO case (divergence two above) and absent here too.
 */
const GRAMMAR_LANGUAGES: ReadonlyMap<string, { language: string; query: string }> = new Map(
	(
		[
			['ts', { language: 'typescript', query: typescriptQuery }],
			['tsx', { language: 'tsx', query: tsxQuery }],
			['js', { language: 'javascript', query: javascriptQuery }],
			['jsx', { language: 'javascript', query: javascriptQuery }],
			['json', { language: 'javascript', query: javascriptQuery }],
			['py', { language: 'python', query: pythonQuery }],
			['rs', { language: 'rust', query: rustQuery }],
			['go', { language: 'go', query: goQuery }],
			['c', { language: 'c', query: cQuery }],
			['h', { language: 'c', query: cQuery }],
			['cpp', { language: 'cpp', query: cppQuery }],
			['hpp', { language: 'cpp', query: cppQuery }],
			['cs', { language: 'c_sharp', query: csharpQuery }],
			['rb', { language: 'ruby', query: rubyQuery }],
			['java', { language: 'java', query: javaQuery }],
			['php', { language: 'php', query: phpQuery }],
			['kt', { language: 'kotlin', query: kotlinQuery }],
			['kts', { language: 'kotlin', query: kotlinQuery }],
			['css', { language: 'css', query: cssQuery }],
			['html', { language: 'html', query: htmlQuery }],
			['ml', { language: 'ocaml', query: ocamlQuery }],
			['mli', { language: 'ocaml', query: ocamlQuery }],
			['sol', { language: 'solidity', query: solidityQuery }],
			['toml', { language: 'toml', query: tomlQuery }],
			['vue', { language: 'vue', query: vueQuery }],
			['lua', { language: 'lua', query: luaQuery }],
			['rdl', { language: 'systemrdl', query: systemrdlQuery }],
			['tla', { language: 'tlaplus', query: tlaPlusQuery }],
			['zig', { language: 'zig', query: zigQuery }],
			['ejs', { language: 'embedded_template', query: embeddedTemplateQuery }],
			['erb', { language: 'embedded_template', query: embeddedTemplateQuery }],
			['el', { language: 'elisp', query: elispQuery }],
			['ex', { language: 'elixir', query: elixirQuery }],
			['exs', { language: 'elixir', query: elixirQuery }],
		] as [string, { language: string; query: string }][]
	).map(([ext, entry]) => [`.${ext}`, entry] as [string, { language: string; query: string }]),
);

/**
 * How the ws-writer treats a file extension.
 *  - 'markdown' → parseZooMarkdownContent (P3, unchanged)
 *  - 'grammar'  → this module's tree-sitter path
 *  - 'fallback' → size-based chunking (no grammar)
 *  - null       → not in Zoo's effective population; skip
 */
export function routeZooFileExtension(extension: string): 'markdown' | 'grammar' | 'fallback' | null {
	const ext = extension.toLowerCase();
	if (ext === '.md' || ext === '.markdown') return 'markdown';
	if (ZOO_FALLBACK_EXTENSIONS.has(ext)) return 'fallback';
	if (GRAMMAR_LANGUAGES.has(ext)) return 'grammar';
	return null;
}

/**
 * The kill switch demanded by the fleet rule: the code population is ACTIVE
 * BY DEFAULT, and `WS_WRITER_CODE_INDEXING=0` returns the writer to its P3
 * markdown-only behavior.
 */
export const WS_WRITER_CODE_INDEXING_ENV = 'WS_WRITER_CODE_INDEXING';

export function isWsWriterCodeIndexingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[WS_WRITER_CODE_INDEXING_ENV] !== '0';
}

// ─── Lazy grammar loading (languageParser.ts port) ──────────────────────────

interface LoadedLanguage {
	parser: Parser;
	query: Query;
}

let parserInitialized = false;
const loadedLanguages = new Map<string, LoadedLanguage>();
const pendingLoads = new Map<string, Promise<LoadedLanguage>>();

/**
 * Directory of the prebuilt wasm binaries — the same `tree-sitter-wasms`
 * package Zoo depends on, resolved from this server's node_modules.
 */
export function zooWasmDirectory(): string {
	const pkg = require.resolve('tree-sitter-wasms/package.json');
	return join(dirname(pkg), 'out');
}

async function loadZooLanguage(ext: string): Promise<LoadedLanguage> {
	const entry = GRAMMAR_LANGUAGES.get(ext);
	if (!entry) throw new Error(`no Zoo grammar for ${ext}`);

	const pending = pendingLoads.get(ext);
	if (pending) return pending;

	const load = (async () => {
		if (!parserInitialized) {
			await Parser.init();
			parserInitialized = true;
		}
		const language = await Language.load(join(zooWasmDirectory(), `tree-sitter-${entry.language}.wasm`));
		const parser = new Parser();
		parser.setLanguage(language);
		const query = new Query(language, entry.query);
		const loaded: LoadedLanguage = { parser, query };
		loadedLanguages.set(ext, loaded);
		return loaded;
	})();

	pendingLoads.set(ext, load);
	try {
		return await load;
	} finally {
		pendingLoads.delete(ext);
	}
}

/** Test seam: forget loaded grammars (each test run re-loads from disk). */
export function resetZooLanguageCache(): void {
	loadedLanguages.clear();
	pendingLoads.clear();
	parserInitialized = false;
}

// ─── The parse (parser.ts parseContent BFS, verbatim) ───────────────────────

const MAX_BLOCK_CHARS = 1000;
const MIN_BLOCK_CHARS = 50;
const MAX_CHARS_TOLERANCE_FACTOR = 1.15;

/**
 * Port of Zoo's parseContent for non-markdown files: query captures walked
 * breadth-first, blocks minted between MIN_BLOCK_CHARS and
 * MAX_BLOCK_CHARS × 1.15, oversized nodes decomposed into children (leaf
 * nodes chunked by lines), empty captures falling back to size chunking when
 * the content reaches the minimum. Hashes, ids and payloads stay Zoo's — see
 * zoo-parity.ts for the formulas this rides on.
 *
 * @param absWriterPath The ABSOLUTE writer path Zoo's scanner was invoked with
 *        — embedded in every segmentHash (joinZooWriterPath builds it).
 * @param ext Lower-case extension WITH the leading dot, routed 'grammar' or
 *        'fallback' by routeZooFileExtension.
 * @param fileHash sha256 hex override; when omitted the hash covers the
 *        CRLF-normalized content — which is what the stored corpus carries
 *        (Zoo hashed the LF bytes it read), so callers that want full payload
 *        parity on every seat simply omit it.
 */
export async function parseZooCodeContent(
	absWriterPath: string,
	ext: string,
	content: string,
	fileHash?: string,
): Promise<ZooCodeBlock[]> {
	// CRLF→LF before anything else. Corpus-empirical (17/11): the stored code
	// points were written from LF working trees — DiffDetector.ts parsed raw
	// (CRLF seat) matched only 41/189 stored hashes, parsed LF matched 134/134
	// with zero extras. Zoo's own read was raw `readFile` on an LF checkout, so
	// the normalization reproduces ITS input bytes on every seat regardless of
	// autocrlf. The markdown path (zoo-parity.ts) does NOT normalize: its
	// corpus generation was measured at parity WITH the raw bytes.
	const normalized = content.replace(/\r\n/g, '\n');
	const hash = fileHash ?? createHash('sha256').update(normalized).digest('hex');
	const seenSegmentHashes = new Set<string>();

	// Fallback extensions never touch a grammar (Zoo: shouldUseFallbackChunking).
	if (ZOO_FALLBACK_EXTENSIONS.has(ext)) {
		return chunkTextByLinesZoo(normalized.split('\n'), absWriterPath, hash, 'fallback_chunk', seenSegmentHashes);
	}

	let language: LoadedLanguage;
	try {
		language = loadedLanguages.get(ext) ?? (await loadZooLanguage(ext));
	} catch (error) {
		// Deliberate divergence from Zoo (which logs and yields no blocks):
		// the ws-writer treats "0 blocks" as a legitimate rewrite signal and
		// PURGES the file's stored points. A grammar/wasm load failure must
		// never take that path — it throws, and the writer skips the file
		// entirely (points preserved, warning surfaced). Measured 17/11: the
		// ESM require bug produced exactly this silent 0-blocks-on-189-point
		// file case.
		throw new Error(
			`zoo-code-parser: grammar load failed for ${ext}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const tree = language.parser.parse(normalized);
	const captures = tree ? language.query.captures(tree.rootNode) : [];

	if (captures.length === 0) {
		if (normalized.length >= MIN_BLOCK_CHARS) {
			return chunkTextByLinesZoo(normalized.split('\n'), absWriterPath, hash, 'fallback_chunk', seenSegmentHashes);
		}
		return [];
	}

	const results: ZooCodeBlock[] = [];
	const queue: Node[] = Array.from(captures).map((capture) => capture.node);

	while (queue.length > 0) {
		const currentNode = queue.shift()!;

		if (currentNode.text.length >= MIN_BLOCK_CHARS) {
			if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
				if (currentNode.children.filter((child) => child !== null).length > 0) {
					queue.push(...currentNode.children.filter((child) => child !== null));
				} else {
					results.push(
						...chunkTextByLinesZoo(
							currentNode.text.split('\n'),
							absWriterPath,
							hash,
							currentNode.type,
							seenSegmentHashes,
							currentNode.startPosition.row + 1,
						),
					);
				}
			} else {
				const identifier =
					currentNode.childForFieldName('name')?.text ||
					currentNode.children.find((c) => c?.type === 'identifier')?.text ||
					null;
				const start_line = currentNode.startPosition.row + 1;
				const end_line = currentNode.endPosition.row + 1;
				const blockContent = currentNode.text;
				const contentPreview = blockContent.slice(0, 100);
				const segmentHash = createHash('sha256')
					.update(`${absWriterPath}-${start_line}-${end_line}-${blockContent.length}-${contentPreview}`)
					.digest('hex');

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash);
					results.push({
						file_path: absWriterPath,
						identifier,
						type: currentNode.type,
						start_line,
						end_line,
						content: blockContent,
						segmentHash,
						fileHash: hash,
					});
				}
			}
		}
		// Nodes smaller than MIN_BLOCK_CHARS are ignored (Zoo).
	}

	return results;
}
