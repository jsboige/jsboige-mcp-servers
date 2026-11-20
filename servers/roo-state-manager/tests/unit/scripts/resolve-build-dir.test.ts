/**
 * #4824 review (ai-01, 18/11): the diagnostic's build selector must never pick
 * a vintage by lexicographic order — a content hash says nothing about which
 * build is current, so ALL GREEN could describe the wrong artifact.
 *
 * The named regression is inverse lexical order: the current vintage sorts
 * FIRST, an older one sorts LAST. The `build-current` marker decides, the hash
 * never does. This pins the canonical resolver (#3713) the diagnostic now
 * shares with every other ops script, including its documented fallback to the
 * legacy `build/` directory on a machine not yet migrated to vintages.
 *
 * Uses real temp directories (not fs mocks), like vintage-store.test.ts: the
 * behavior under test IS filesystem interaction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const libPath = new URL('../../../scripts/lib/resolve-build-dir.mjs', import.meta.url);
const { resolveBuildDir } = await import(libPath.href);

let pkgRoot: string;

function makeVintage(name: string, withIndex = true): void {
	const dir = path.join(pkgRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	if (withIndex) fs.writeFileSync(path.join(dir, 'index.js'), '// fixture\n', 'utf-8');
}

function writeMarker(name: string): void {
	fs.writeFileSync(path.join(pkgRoot, 'build-current'), `${name}\n`, 'utf-8');
}

beforeEach(() => {
	pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-build-dir-'));
});

afterEach(() => {
	fs.rmSync(pkgRoot, { recursive: true, force: true });
});

describe('resolveBuildDir', () => {
	it('follows the build-current marker, not lexicographic order (inverse-order regression)', () => {
		makeVintage('build-ffffffffffffffff'); // sorts LAST — older, NOT current
		makeVintage('build-0123456789abcdef'); // sorts FIRST — current
		writeMarker('build-0123456789abcdef');
		expect(resolveBuildDir(pkgRoot)).toBe(path.join(pkgRoot, 'build-0123456789abcdef'));
	});

	it('falls back to the legacy build/ directory when no marker exists (not-yet-migrated machine)', () => {
		makeVintage('build-0123456789abcdef');
		expect(resolveBuildDir(pkgRoot)).toBe(path.join(pkgRoot, 'build'));
	});

	it('falls back to build/ when the marker is malformed', () => {
		makeVintage('build-0123456789abcdef');
		writeMarker('../../etc');
		expect(resolveBuildDir(pkgRoot)).toBe(path.join(pkgRoot, 'build'));
	});

	it('falls back to build/ when the marker names a vintage without index.js', () => {
		makeVintage('build-0123456789abcdef', false);
		writeMarker('build-0123456789abcdef');
		expect(resolveBuildDir(pkgRoot)).toBe(path.join(pkgRoot, 'build'));
	});
});