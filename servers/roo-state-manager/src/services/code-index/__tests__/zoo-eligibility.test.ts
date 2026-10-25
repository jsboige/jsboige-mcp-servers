/**
 * #4352: Zoo 3.92 eligibility and blind spots (services/code-index/zoo-eligibility.ts).
 */
import { describe, test, expect } from 'vitest';
import { classifyZooPath, isZooBlindSpot, isZooSkippedDir, HIDDEN_DIR_KIND } from '../zoo-eligibility.js';

describe('classifyZooPath (#4352)', () => {
	test('files Zoo indexes are eligible', () => {
		for (const p of ['src/a.ts', 'docs/guide.md', 'mcps/internal/x/y.py', 'notes.txt', 'build-0123abcd/out.js']) {
			expect(classifyZooPath(p)).toBe('eligible');
		}
	});

	test('text files Zoo never indexes are blind spots named by their extension', () => {
		expect(classifyZooPath('scripts/scheduling/check_scheduled_task_safe_to_delete.ps1')).toBe('.ps1');
		expect(classifyZooPath('servers/rsm/scripts/read-roosync-inbox.mjs')).toBe('.mjs');
		expect(classifyZooPath('tools/run.sh')).toBe('.sh');
		expect(classifyZooPath('ci/pipeline.YML')).toBe('.yml');
	});

	test('readable files under a hidden directory are blind spots of kind hidden-dir', () => {
		expect(classifyZooPath('.claude/rules/agent-claim-discipline.md')).toBe(HIDDEN_DIR_KIND);
		expect(classifyZooPath('.claude/skills/memory-inject/SKILL.md')).toBe(HIDDEN_DIR_KIND);
		expect(classifyZooPath('.github/workflows/ci.yml')).toBe(HIDDEN_DIR_KIND);
		expect(classifyZooPath('zoo-code/.roo/rules/x.md')).toBe(HIDDEN_DIR_KIND);
	});

	test('binaries, .git, and dirs Zoo skips by name are neither eligible nor blind spots', () => {
		expect(classifyZooPath('docs/img/diagram.png')).toBeNull();
		expect(classifyZooPath('.claude/assets/logo.png')).toBeNull();
		expect(classifyZooPath('.git/config')).toBeNull();
		expect(classifyZooPath('node_modules/pkg/index.js')).toBeNull();
		expect(classifyZooPath('rust/target/dependency/x.ps1')).toBeNull();
		expect(classifyZooPath('.claude/x/node_modules/y.js')).toBeNull();
	});

	test('isZooBlindSpot is true exactly for the blind-spot kinds', () => {
		expect(isZooBlindSpot('scripts/x.ps1')).toBe(true);
		expect(isZooBlindSpot('.claude/rules/r.md')).toBe(true);
		expect(isZooBlindSpot('src/a.ts')).toBe(false);
		expect(isZooBlindSpot('docs/img/a.png')).toBe(false);
	});

	test('isZooSkippedDir keeps the coverage semantics (hidden, named, and the two path pairs)', () => {
		expect(isZooSkippedDir('.claude', null)).toBe(true);
		expect(isZooSkippedDir('node_modules', 'src')).toBe(true);
		expect(isZooSkippedDir('dependency', 'target')).toBe(true);
		expect(isZooSkippedDir('dependency', 'src')).toBe(false);
		expect(isZooSkippedDir('build', null)).toBe(false);
	});
});
