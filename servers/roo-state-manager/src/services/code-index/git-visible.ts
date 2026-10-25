/**
 * #4352 (a3): the git-visible file list of a workspace, in one place.
 *
 * Zoo lists files with ripgrep, which honours `.gitignore`; a disk walk does not.
 * Measured on ai-01, 25/10: the walk finds 10,856 candidate files under
 * D:/roo-extensions, git sees 7,604, and 7,017 of the 7,018 files indexed in
 * ws-59e7574de63c6e62 are among those 7,604 (none under a gitignored `build-*`
 * dir). Both readers of that list — the coverage denominator of `codebase_search`
 * and the supplement index selection — must agree on what "git-visible" means,
 * so the two git calls live here and nowhere else.
 */
import { execFile } from 'child_process';

/**
 * Tracked files plus untracked-but-not-ignored files, as `git ls-files` prints
 * them: workspace-relative, forward slashes. Empty array = git ran but sees
 * nothing; `null` = not a git workspace (or git unavailable) — the caller decides
 * what to do, and must not read `null` as "no files".
 *
 * Submodule contents are NOT recursed into (`--recurse-submodules` is omitted on
 * purpose by default): each submodule is its own repository with its own remote,
 * so it gets its own `sup-` collection instead of being folded into the parent's.
 * `git ls-files` then lists the gitlink path alone, which has no extension and is
 * filtered out downstream by `classifyZooPath`.
 */
export function listGitVisiblePaths(
	workspaceRoot: string,
	options: { includeSubmodules?: boolean } = {},
): Promise<string[] | null> {
	const git = (args: string[]) => new Promise<string>((resolveOut, reject) => {
		execFile(
			'git',
			['-C', workspaceRoot, ...args],
			{ maxBuffer: 64 * 1024 * 1024, timeout: 20_000, windowsHide: true },
			(err, stdout) => (err ? reject(err) : resolveOut(String(stdout))),
		);
	});
	return (async () => {
		try {
			const recursive = options.includeSubmodules ? ['--recurse-submodules'] : [];
			const tracked = await git(['ls-files', ...recursive, '-z']);
			const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
			const seen = new Set<string>();
			for (const p of `${tracked}\0${untracked}`.split('\0')) {
				if (p) seen.add(p);
			}
			return [...seen];
		} catch {
			return null;
		}
	})();
}

/** The `origin` URL of a workspace, or null when there is none (not a repo, no remote). */
export function readOriginUrl(workspaceRoot: string): Promise<string | null> {
	return new Promise((resolveOut) => {
		execFile(
			'git',
			['-C', workspaceRoot, 'config', '--get', 'remote.origin.url'],
			{ timeout: 10_000, windowsHide: true },
			(err, stdout) => resolveOut(err ? null : String(stdout).trim() || null),
		);
	});
}
