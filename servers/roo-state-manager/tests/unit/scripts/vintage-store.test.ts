/**
 * Unit coverage for the vintage store (#3713).
 *
 * pruneVintages is the only destructive path of the hot-swap pipeline — it
 * deletes build directories. The invariants below are exactly what publish
 * promises: the current vintage is never pruned, the N most recent are kept,
 * a vintage pinned by a live wrapper ref survives, dead refs are cleaned so
 * they can't pin forever, and everything else goes.
 *
 * Uses real temp directories (not fs mocks): the behavior under test IS
 * filesystem interaction, and the repo has been burned by fs-mock drift
 * before (vitest `vi.mock('fs')` captures `node:fs` — memory file).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const libPath = new URL('../../../scripts/lib/vintage-store.mjs', import.meta.url);
const {
    hashTree, vintageNameFor, vintageNameOnDisk, stagingPathFor, cleanStaleStaging,
    listVintages, pruneVintages, vintageHasLiveRef,
} = await import(libPath.href);

let tmpRoot: string;

function makeVintage(name: string, files: Record<string, string>, ageMsAgo = 0): string {
    const dir = path.join(tmpRoot, name);
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf-8');
    }
    if (ageMsAgo > 0) {
        const past = new Date(Date.now() - ageMsAgo);
        fs.utimesSync(dir, past, past);
    }
    return dir;
}

const ALIVE = (_pid: number) => true;
const DEAD = (_pid: number) => false;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vintage-store-test-'));
});

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hashTree / vintageNameFor', () => {
    it('is deterministic for identical content', () => {
        const a = makeVintage('a', { 'index.js': 'console.log(1)', 'utils/x.js': 'export const x = 1;' });
        const b = makeVintage('b', { 'index.js': 'console.log(1)', 'utils/x.js': 'export const x = 1;' });
        expect(hashTree(a)).toBe(hashTree(b));
        expect(vintageNameFor(a)).toBe(vintageNameFor(b));
        expect(vintageNameFor(a)).toMatch(/^build-[0-9a-f]{16}$/);
    });

    it('changes when any file content changes', () => {
        const a = makeVintage('a', { 'index.js': 'console.log(1)' });
        const b = makeVintage('b', { 'index.js': 'console.log(2)' });
        expect(hashTree(a)).not.toBe(hashTree(b));
    });

    it('is insensitive to traversal order (sorted by relative path)', () => {
        const a = makeVintage('a', { 'a.js': 'A', 'z/b.js': 'B' });
        const b = makeVintage('b', { 'z/b.js': 'B', 'a.js': 'A' });
        expect(hashTree(a)).toBe(hashTree(b));
    });
});

describe('pruneVintages', () => {
    it('never prunes the current vintage, even below retention floor', () => {
        const current = makeVintage('build-aaaaaaaaaaaaaaaa', { 'index.js': 'x' }, 100_000);
        const { pruned } = pruneVintages(tmpRoot, { currentName: 'build-aaaaaaaaaaaaaaaa', retention: 3, alive: DEAD });
        expect(pruned).toEqual([]);
        expect(fs.existsSync(current)).toBe(true);
    });

    it('keeps the N most recent vintages and prunes older ones', () => {
        makeVintage('build-0000000000000000', { 'index.js': '0' }, 400_000);
        makeVintage('build-1111111111111111', { 'index.js': '1' }, 300_000);
        makeVintage('build-2222222222222222', { 'index.js': '2' }, 200_000);
        makeVintage('build-3333333333333333', { 'index.js': '3' }, 100_000);
        const { pruned, kept } = pruneVintages(tmpRoot, { currentName: 'build-3333333333333333', retention: 2, alive: DEAD });
        // retention=2: current + the most recent other (2222…); the two oldest go.
        expect(kept).toEqual(['build-3333333333333333', 'build-2222222222222222']);
        expect(pruned).toEqual(['build-1111111111111111', 'build-0000000000000000']);
        expect(fs.existsSync(path.join(tmpRoot, 'build-0000000000000000'))).toBe(false);
    });

    it('keeps a pinned vintage beyond retention (live wrapper ref)', () => {
        makeVintage('build-0000000000000000', { 'index.js': '0', '.ref-4242': 'now' }, 400_000);
        makeVintage('build-1111111111111111', { 'index.js': '1' }, 300_000);
        const { pruned, pinned } = pruneVintages(tmpRoot, { currentName: 'build-1111111111111111', retention: 1, alive: ALIVE });
        expect(pinned).toEqual(['build-0000000000000000']);
        expect(pruned).toEqual([]);
        expect(fs.existsSync(path.join(tmpRoot, 'build-0000000000000000'))).toBe(true);
    });

    it('cleans dead refs so they cannot pin forever, then prunes the vintage', () => {
        const dir = makeVintage('build-0000000000000000', { 'index.js': '0', '.ref-999999': 'now' }, 400_000);
        makeVintage('build-1111111111111111', { 'index.js': '1' }, 300_000);
        expect(vintageHasLiveRef(dir, ALIVE)).toBe(true);
        const { pruned } = pruneVintages(tmpRoot, { currentName: 'build-1111111111111111', retention: 1, alive: DEAD });
        expect(pruned).toEqual(['build-0000000000000000']);
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('ignores non-vintage directories (legacy build/, build-out/, arbitrary names)', () => {
        makeVintage('build', { 'index.js': 'legacy' });
        makeVintage('build-out', { 'index.js': 'scratch' });
        makeVintage('build-nothexzzzzzzzzzz', { 'index.js': 'bad name' });
        const { pruned } = pruneVintages(tmpRoot, { currentName: 'build-none', retention: 1, alive: DEAD });
        expect(pruned).toEqual([]);
        expect(fs.existsSync(path.join(tmpRoot, 'build', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(tmpRoot, 'build-out', 'index.js'))).toBe(true);
    });
});

describe('listVintages', () => {
    it('returns only vintages, newest first', () => {
        makeVintage('build-0000000000000000', { 'index.js': '0' }, 400_000);
        makeVintage('build-1111111111111111', { 'index.js': '1' }, 100_000);
        makeVintage('build-out', { 'index.js': 'scratch' });
        const names = listVintages(tmpRoot).map((v) => v.name);
        expect(names).toEqual(['build-1111111111111111', 'build-0000000000000000']);
    });
});

// The id is the completion witness (ms#1910 review of #4918): what gets marked
// must hash, on disk, to its own name. These pin the read-back itself; the
// publish-level refusals are in vintage-autonomy.test.ts next to it.
describe('vintageNameOnDisk — the id read back from the copy', () => {
    it('equals vintageNameFor over the same content', () => {
        const dir = makeVintage('build-aaaaaaaaaaaaaaaa', { 'index.js': 'x', 'deep/a.js': 'a', 'node_modules/@v/c/dist/i.js': 'y' });
        expect(vintageNameOnDisk(dir)).toBe(vintageNameFor(dir));
    });

    it('ignores the files a vintage gains after publication, at its root only', () => {
        // What write-build-info.mjs and mcp-wrapper.cjs write into a live vintage.
        const served = makeVintage('served', {
            'index.js': 'x',
            'build-info.json': '{"sha":"deadbeef"}',
            '.tools-cache.json': '{"toolsList":{}}',
            '.ref-4242': 'now',
        });
        const bare = makeVintage('bare', { 'index.js': 'x' });
        expect(vintageNameOnDisk(served)).toBe(vintageNameOnDisk(bare));

        // Nested, the very same names are content: a bundled dist keeps every file it has.
        const nested = makeVintage('nested', { 'index.js': 'x', 'node_modules/@v/c/dist/.ref-4242': 'now' });
        expect(vintageNameOnDisk(nested)).not.toBe(vintageNameOnDisk(bare));
    });

    it('differs from the complete tree when a file of the copy is missing', () => {
        const complete = makeVintage('complete', {
            'index.js': 'x',
            'node_modules/@v/c/package.json': '{}',
            'node_modules/@v/c/dist/index.js': 'core-v1',
        });
        // The shape of a copy interrupted right after package.json.
        const partial = makeVintage('partial', { 'index.js': 'x', 'node_modules/@v/c/package.json': '{}' });
        expect(vintageNameOnDisk(partial)).not.toBe(vintageNameOnDisk(complete));
    });
});

describe('staging trees', () => {
    it('are named after their vintage and their publish process, and are no vintage', () => {
        expect(stagingPathFor('/srv/build-0123456789abcdef', 77)).toBe('/srv/build-0123456789abcdef.staging-77');
        // Never listed, so never pruned and never taken for a publish.
        makeVintage('build-0123456789abcdef.staging-77', { 'index.js': 'half' });
        expect(listVintages(tmpRoot)).toEqual([]);
    });

    it('are removed once their publish process is gone, and only then', () => {
        const dead = makeVintage('build-aaaaaaaaaaaaaaaa.staging-4242', { 'index.js': 'half' });
        const live = makeVintage('build-bbbbbbbbbbbbbbbb.staging-4343', { 'index.js': 'half' });
        makeVintage('build-cccccccccccccccc', { 'index.js': 'published' });
        makeVintage('build-dddddddddddddddd.staging', { 'index.js': 'no pid: not ours to judge' });
        const only_4343_alive = (pid: number) => pid === 4343;

        expect(cleanStaleStaging(tmpRoot, { alive: only_4343_alive })).toEqual(['build-aaaaaaaaaaaaaaaa.staging-4242']);
        expect(fs.existsSync(dead)).toBe(false);
        expect(fs.existsSync(live)).toBe(true);
        expect(fs.existsSync(path.join(tmpRoot, 'build-cccccccccccccccc', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(tmpRoot, 'build-dddddddddddddddd.staging', 'index.js'))).toBe(true);
    });
});
