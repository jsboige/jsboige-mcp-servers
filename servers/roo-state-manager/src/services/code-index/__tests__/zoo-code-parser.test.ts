/**
 * #4819 (5b) — parity test: the segments RSM's code path produces EQUAL Zoo
 * Code's own parser output (same segmentHash, same line ranges, same
 * identifier/type/content), for one grammar language without (TS), one with
 * (Python), and one fallback extension (.vb, no grammar).
 *
 * The goldens were frozen by running ZOO'S OWN code path — web-tree-sitter
 * 0.25.6 + tree-sitter-wasms 0.1.12 (the exact packages of Zoo's
 * src/package.json) with the QUERY STRINGS IMPORTED FROM the reference
 * submodule (roo-code @cb836567, content-identical to the zoo-parity.ts pin
 * 67df9f9c — diff measured empty 17/11) — over the committed fixtures with a
 * FIXED absolute writer path. parser.ts itself imports monorepo telemetry and
 * cannot be imported outside the workspace, so its BFS block walk was copied
 * verbatim into the generator; the corpus validation recorded on #4819
 * (stored Zoo-written points of an unchanged file reproduced exactly) is the
 * oracle that closes the loop on any error a double copy could share.
 *
 * Red on the base commit: the zoo-code-parser module does not exist there.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
	isWsWriterCodeIndexingEnabled,
	parseZooCodeContent,
	resetZooLanguageCache,
	routeZooFileExtension,
	WS_WRITER_CODE_INDEXING_ENV,
} from '../zoo-code-parser.js';
import { zooPointId } from '../zoo-parity.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-4819');

interface GoldenBlock {
	file_path: string;
	identifier: string | null;
	type: string;
	start_line: number;
	end_line: number;
	content: string;
	segmentHash: string;
	fileHash: string;
}

interface GoldenFile {
	file: string;
	absPath: string;
	parser: 'tree-sitter' | 'fallback';
	blocks: GoldenBlock[];
}

const goldens: GoldenFile[] = JSON.parse(readFileSync(join(FIXTURES_DIR, 'goldens.json'), 'utf8'));

describe('#4819 zoo-code-parser — parity with Zoo Code (goldens frozen from Zoo code)', () => {
	it('exactly one golden fixture per parser family', () => {
		const families = new Set(goldens.map((g) => g.parser));
		expect(families).toEqual(new Set(['tree-sitter', 'fallback']));
	});

	for (const golden of goldens) {
		const ext = `.${golden.file.split('.').pop()}`;
		it(
			`parity: ${golden.file} (${golden.parser}, ${golden.blocks.length} blocks)`,
			async () => {
				resetZooLanguageCache();
				// Normalize CRLF→LF: the goldens were frozen from LF content and a
				// Windows checkout (autocrlf) must not turn the parity check into
				// a line-ending detector — the property under test is RSM-parser
				// vs Zoo-parser on the SAME bytes, which LF-normalized content
				// guarantees on every platform.
				const content = readFileSync(join(FIXTURES_DIR, golden.file), 'utf8').replace(/\r\n/g, '\n');
				const blocks = await parseZooCodeContent(golden.absPath, ext, content);

				// Same blocks, same order, byte-exact on every Zoo-observable field.
				expect(blocks.map((b) => ({
			identifier: b.identifier,
			type: b.type,
			start_line: b.start_line,
			end_line: b.end_line,
			content: b.content,
			segmentHash: b.segmentHash,
			fileHash: b.fileHash,
			file_path: b.file_path,
		}))).toEqual(golden.blocks.map((b) => ({
			identifier: b.identifier,
			type: b.type,
			start_line: b.start_line,
			end_line: b.end_line,
			content: b.content,
			segmentHash: b.segmentHash,
			fileHash: b.fileHash,
			file_path: b.file_path,
		})));

				// The point ids the writer will mint are Zoo's ids for these
				// blocks (uuidv5 of the segment hash in the code-block namespace).
				for (const [i, block] of blocks.entries()) {
					expect(zooPointId(block.segmentHash)).toBe(zooPointId(golden.blocks[i].segmentHash));
				}
			},
			60_000,
		);
	}

	it('CRLF content produces the SAME blocks as LF (corpus written from LF worktrees, 17/11)', async () => {
		// A CRLF seat (autocrlf=true) must not fork the corpus: the parser
		// normalizes before parsing, so disk line endings are invisible in
		// segmentHash/fileHash. Measured on the live corpus: raw-CRLF parse
		// matched 41/189 stored hashes, LF parse 134/134.
		const ts = goldens.find((g) => g.file === 'fixture.ts')!;
		resetZooLanguageCache();
		const lfContent = readFileSync(join(FIXTURES_DIR, ts.file), 'utf8').replace(/\r\n/g, '\n');
		const crlfBlocks = await parseZooCodeContent(ts.absPath, '.ts', lfContent.replace(/\n/g, '\r\n'));
		expect(crlfBlocks.map((b) => b.segmentHash)).toEqual(ts.blocks.map((b) => b.segmentHash));
		expect(crlfBlocks.map((b) => b.fileHash)).toEqual(ts.blocks.map((b) => b.fileHash));
	});

	it('goldens exercise the paths that matter: identifiers, oversized decomposition, segments', () => {
		const ts = goldens.find((g) => g.file === 'fixture.ts')!;
		// identifier extraction (Zoo: childForFieldName("name"))
		expect(ts.blocks.some((b) => b.identifier === 'make')).toBe(true);
		expect(ts.blocks.some((b) => b.identifier === 'assemble')).toBe(true);
		// oversized method_definition decomposed into children (comments + statements)
		expect(ts.blocks.filter((b) => b.type === 'comment').length).toBeGreaterThan(0);
		expect(ts.blocks.filter((b) => b.type === 'expression_statement').length).toBeGreaterThan(0);
		// tiny definitions (< MIN_BLOCK_CHARS) dropped
		expect(ts.blocks.some((b) => b.identifier === 'tiny')).toBe(false);

		const py = goldens.find((g) => g.file === 'fixture.py')!;
		expect(py.blocks.some((b) => b.identifier === 'Calculator' && b.type === 'class_definition')).toBe(true);

		const vb = goldens.find((g) => g.file === 'fixture.vb')!;
		// fallback chunks + the fixed-size segment path for an oversized line
		expect(vb.blocks.some((b) => b.type === 'fallback_chunk')).toBe(true);
		expect(vb.blocks.some((b) => b.type === 'fallback_chunk_segment' && b.start_line === b.end_line)).toBe(true);
	});
});

describe('#4819 zoo-code-parser — population routing', () => {
	it('routes exactly Zoo\'s effective scanner population', () => {
		expect(routeZooFileExtension('.md')).toBe('markdown');
		expect(routeZooFileExtension('.markdown')).toBe('markdown');
		expect(routeZooFileExtension('.ts')).toBe('grammar');
		expect(routeZooFileExtension('.tsx')).toBe('grammar');
		expect(routeZooFileExtension('.py')).toBe('grammar');
		expect(routeZooFileExtension('.js')).toBe('grammar');
		expect(routeZooFileExtension('.json')).toBe('grammar');
		expect(routeZooFileExtension('.vb')).toBe('fallback');
		expect(routeZooFileExtension('.scala')).toBe('fallback');
		expect(routeZooFileExtension('.swift')).toBe('fallback');
		// elm/htm: in Zoo's scannerExtensions with NO grammar case — Zoo yields
		// zero blocks there (load throws, caught); excluded up front instead
		// (design-note divergence two, same net effect).
		expect(routeZooFileExtension('.elm')).toBeNull();
		expect(routeZooFileExtension('.htm')).toBeNull();
		// never in Zoo's population
		expect(routeZooFileExtension('.txt')).toBeNull();
		expect(routeZooFileExtension('.ps1')).toBeNull();
	});
});

describe('#4819 zoo-code-parser — kill switch', () => {
	it('code indexing is ON by default and WS_WRITER_CODE_INDEXING=0 turns it off', () => {
		expect(isWsWriterCodeIndexingEnabled({})).toBe(true);
		expect(isWsWriterCodeIndexingEnabled({ [WS_WRITER_CODE_INDEXING_ENV]: '0' })).toBe(false);
		expect(isWsWriterCodeIndexingEnabled({ [WS_WRITER_CODE_INDEXING_ENV]: '1' })).toBe(true);
		// any other value (empty, whitespace, "false") leaves it ON: the fleet
		// rule specifies a single =0 off-switch, not a boolean parser.
		expect(isWsWriterCodeIndexingEnabled({ [WS_WRITER_CODE_INDEXING_ENV]: '' })).toBe(true);
	});
});

describe('#4819 zoo-code-parser — wasm resolution', () => {
	it('zooWasmDirectory resolves the installed tree-sitter-wasms out/ directory', async () => {
		const { zooWasmDirectory } = await import('../zoo-code-parser.js');
		const dir = zooWasmDirectory();
		expect(existsSync(dir)).toBe(true);
		// one grammar of each family the parity test exercises
		expect(existsSync(join(dir, 'tree-sitter-typescript.wasm'))).toBe(true);
		expect(existsSync(join(dir, 'tree-sitter-python.wasm'))).toBe(true);
	});
});
