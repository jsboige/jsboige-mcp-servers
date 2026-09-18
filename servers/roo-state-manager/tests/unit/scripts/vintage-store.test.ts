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
const { hashTree, vintageNameFor, listVintages, pruneVintages, vintageHasLiveRef } = await import(libPath.href);

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
