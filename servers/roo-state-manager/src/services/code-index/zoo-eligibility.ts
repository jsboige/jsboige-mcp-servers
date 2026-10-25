/**
 * #4352: what the Zoo 3.92 code indexer can and cannot index, in one place.
 *
 * Shared by the coverage denominator of `codebase_search` (only files Zoo indexes count)
 * and by the blind-spot report (files Zoo never indexes, so a search returns nothing for
 * them whatever the ranking). Rules read from Zoo 3.92's bundle (`dist/extension.js`):
 * the `Vtr` extension array its scanner filters on, the listing glob `!**\/.*\/**` (every
 * hidden directory), and the `Hx` directory names.
 */
import { extname } from 'path';

/**
 * Extensions the Zoo indexer parses. The list previously used by the coverage count also
 * held `.ps1`, `.sh`, `.yml`/`.yaml`, `.mjs`/`.cjs`, `.sql` and `.svelte`, which Zoo never
 * indexes, so roo-extensions read 0.593 « PARTIAL » on ai-01 (25/10) while its git-tracked
 * code counted with Zoo's own rules reads 0.891 (#4352 c.6395339763).
 */
export const ZOO_ELIGIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
	'tla', 'js', 'jsx', 'ts', 'vue', 'tsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs',
	'rb', 'java', 'php', 'swift', 'sol', 'kt', 'kts', 'ex', 'exs', 'el', 'html', 'htm', 'md',
	'markdown', 'txt', 'json', 'css', 'rdl', 'ml', 'mli', 'lua', 'scala', 'toml', 'zig', 'elm',
	'ejs', 'erb', 'vb', 'dart'
].map(e => `.${e}`));

/**
 * Directories Zoo skips: every hidden directory (the ".*" pattern of DIRS_TO_IGNORE,
 * roo-code/src/services/glob/constants.ts) plus an explicit list, plus two path patterns
 * expressed as (parent, name) pairs. Compiled dirs are NOT skipped: bare `build/`,
 * `build-<hash>/` and `build-out/` are indexed (measured ai-01 2026-09-30).
 */
const ZOO_SKIP_DIR_NAMES = new Set([
	'node_modules', '__pycache__', 'env', 'venv', 'dist', 'out', 'bundle',
	'vendor', 'tmp', 'temp', 'deps', 'pkg', 'Pods',
]);
const ZOO_SKIP_DIR_PAIRS = new Set(['target/dependency', 'build/dependencies']);

export const isZooSkippedDir = (name: string, parentName: string | null): boolean =>
	name.startsWith('.') || ZOO_SKIP_DIR_NAMES.has(name)
	|| (parentName !== null && ZOO_SKIP_DIR_PAIRS.has(`${parentName}/${name}`));

/**
 * Text files Zoo never indexes that still carry code or rules an agent searches for.
 * Measured on roo-extensions, 25/10: 596 `.ps1`, 92 `.mjs`/`.cjs`, 19 `.sh`, 24 `.yml`/`.yaml`,
 * 19 `.sql`, 27 `.bat`, 6 `.psm1`. Binaries (images, PDFs, archives) are not blind spots.
 */
const BLIND_SPOT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	'ps1', 'psm1', 'psd1', 'sh', 'bash', 'bat', 'cmd', 'mjs', 'cjs', 'yml', 'yaml', 'sql', 'svelte'
].map(e => `.${e}`));

/** The kind label used for files Zoo skips only because they sit under a hidden directory. */
export const HIDDEN_DIR_KIND = 'hidden-dir';

/**
 * Classifies a workspace-relative path (forward slashes, as `git ls-files` prints it) the
 * way Zoo would:
 * - `'eligible'`: Zoo indexes it;
 * - a blind-spot kind: a text file Zoo never indexes, either its extension (`'.ps1'`) or
 *   `'hidden-dir'` for an otherwise readable file under `.claude/`, `.roo/`, `.github/`…;
 * - `null`: neither (binaries, unknown extensions, `.git/`, or a dir Zoo skips by name such
 *   as `node_modules/`, which holds vendored or generated files, not workspace code).
 */
export function classifyZooPath(relPath: string): 'eligible' | string | null {
	const segments = relPath.split('/');
	let parent: string | null = null;
	let hidden = false;
	for (const dir of segments.slice(0, -1)) {
		if (dir === '.git') return null;
		if (dir.startsWith('.')) hidden = true;
		else if (isZooSkippedDir(dir, parent)) return null;
		parent = dir;
	}
	const ext = extname(relPath).toLowerCase();
	const readable = ZOO_ELIGIBLE_EXTENSIONS.has(ext) || BLIND_SPOT_TEXT_EXTENSIONS.has(ext);
	if (hidden) return readable ? HIDDEN_DIR_KIND : null;
	if (ZOO_ELIGIBLE_EXTENSIONS.has(ext)) return 'eligible';
	return BLIND_SPOT_TEXT_EXTENSIONS.has(ext) ? ext : null;
}

/** True for a text file Zoo never indexes (see classifyZooPath). */
export function isZooBlindSpot(relPath: string): boolean {
	const kind = classifyZooPath(relPath);
	return kind !== null && kind !== 'eligible';
}
