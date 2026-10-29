/**
 * resolve-workspace.ts — seat-portable workspace resolution for the eval harness.
 *
 * Extracted from v2-block-granularity.eval.test.ts (po-2023, file `20261029a`)
 * so the codebase_search golden query can use the same rule. Root cause this
 * kills: the 2026-06 baseline golden hard-codes `workspace: 'd:/roo-extensions'`,
 * a path that only exists on the seat that indexed under that exact spelling —
 * every other seat resolves a ws-<sha256> collection that does not exist, the
 * run answers `collection_not_found`, and the golden is graded FAIL for an
 * environment reason (measured on po-2023 2026-10-29: 4th FAIL of the replay,
 * absent from ai-01's 01:40Z run where the path resolves). Same class as the
 * v2 fix (ai-01 triage on #4105, 2026-10-07): the query stays verbatim, the
 * workspace follows the checkout the harness runs from.
 *
 * Walks up from this file to the enclosing roo-extensions checkout. Returns
 * null when no enclosing checkout is found (e.g. a bare submodule worktree
 * outside any clone): callers record INCONCLUSIVE, never a crash. A worktree
 * NESTED under a roo-extensions checkout resolves to that worktree's own root
 * (its git dir satisfies the walk-up) — same safe outcome as v2 (ai-01 review
 * on ms#1404).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveScenarioWorkspace(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, 'mcps', 'internal')) && existsSync(join(dir, '.git'))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
