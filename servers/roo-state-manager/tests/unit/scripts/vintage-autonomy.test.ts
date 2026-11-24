/**
 * A vintage resolves its workspace dependencies to its OWN copy (#4918).
 *
 * npm links `@vibesync/core` under node_modules, but the package lives in
 * packages/vibesync-core: one dist/ for every vintage, rebuilt in place, even
 * under live hosts. Before #4918 the published vintage kept its bare
 * '@vibesync/core' imports and read that shared dist/ when a module was loaded
 * late — so a running host could receive the core of a later build.
 *
 * The fixture is a seat in miniature: a workspace root, one workspace package,
 * a server whose build-out imports it. The REAL publish-build.mjs runs there
 * as a child process, and the resolution is proven by a real dynamic import in
 * another child process — not by reading paths.
 *
 * Uses real temp directories, like vintage-store.test.ts next to it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The scripts under test as they sit in this server. Overridable only to run
// this same file against another revision of them (the red-on-base proof).
const scriptsDir = process.env.RSM_PUBLISH_SCRIPTS_DIR
    ?? fileURLToPath(new URL('../../../scripts/', import.meta.url));
const { hashTree } = await import(pathToFileURL(path.join(scriptsDir, 'lib', 'vintage-store.mjs')).href);

const CORE_V1 = "export const MARK = 'core-v1';\n";
const CORE_V2 = "export const MARK = 'core-v2';\n";

let seat: string; // <tmp>/ws — the workspace root
let server: string; // <tmp>/ws/servers/roo-state-manager
let coreDist: string; // <tmp>/ws/packages/vibesync-core/dist — the SHARED build
let link: string; // <tmp>/ws/node_modules/@vibesync/core — npm's workspace link

function write(rel: string, content: string): void {
    const target = path.join(seat, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
}

/** The shared dist/ of the workspace package, as its `tsc` leaves it. */
function buildSharedCore(mark: string): void {
    write('packages/vibesync-core/dist/index.js', `export const MARK = '${mark}';\n`);
}

function serverManifest(dependencies: Record<string, string>): void {
    write('servers/roo-state-manager/package.json', JSON.stringify({ name: 'roo-state-manager', type: 'module', dependencies }));
}

function publish(): { status: number | null; output: string } {
    const r = spawnSync(process.execPath, [path.join(server, 'scripts', 'publish-build.mjs')], { cwd: server, encoding: 'utf-8' });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function currentVintage(): string {
    return fs.readFileSync(path.join(server, 'build-current'), 'utf-8').trim();
}

function vintageCopy(vintage: string, ...segments: string[]): string {
    return path.join(server, vintage, 'node_modules', '@vibesync', 'core', ...segments);
}

/** A host loading modules from `vintage` — AFTER the shared dist/ may have moved on. */
function loadFrom(vintage: string, ...modules: string[]): { status: number | null; marks: string[] } {
    const urls = modules.map((m) => JSON.stringify(pathToFileURL(path.join(server, vintage, m)).href)).join(', ');
    const script = `for (const url of [${urls}]) console.log((await import(url)).MARK);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: server, encoding: 'utf-8' });
    return { status: r.status, marks: r.stdout.split(/\r?\n/).filter(Boolean) };
}

beforeEach(() => {
    seat = fs.mkdtempSync(path.join(os.tmpdir(), 'vintage-autonomy-'));
    server = path.join(seat, 'servers', 'roo-state-manager');
    coreDist = path.join(seat, 'packages', 'vibesync-core', 'dist');
    link = path.join(seat, 'node_modules', '@vibesync', 'core');

    write('package.json', JSON.stringify({ name: 'ws', workspaces: ['packages/*', 'servers/roo-state-manager'] }));
    write(
        'packages/vibesync-core/package.json',
        JSON.stringify({
            name: '@vibesync/core',
            version: '0.1.0',
            type: 'module',
            main: './dist/index.js',
            exports: { '.': './dist/index.js', './*': './dist/*.js' },
            files: ['dist'],
        }),
    );
    buildSharedCore('core-v1');
    // npm's workspace link: a junction on Windows (no privilege needed), a directory symlink elsewhere.
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(seat, 'packages', 'vibesync-core'), link, 'junction');
    serverManifest({ '@vibesync/core': '*' });
    for (const module of ['index.js', 'lazy.js']) {
        write(`servers/roo-state-manager/build-out/${module}`, "import { MARK } from '@vibesync/core';\nexport { MARK };\n");
    }
    fs.mkdirSync(path.join(server, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(scriptsDir, 'publish-build.mjs'), path.join(server, 'scripts', 'publish-build.mjs'));
    fs.copyFileSync(path.join(scriptsDir, 'lib', 'vintage-store.mjs'), path.join(server, 'scripts', 'lib', 'vintage-store.mjs'));
});

afterEach(() => {
    // The link goes first and is not followed — RemoveDirectory/unlink on a link remove the link,
    // never its target — so everything removed afterwards stays inside the temp tree.
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
    fs.rmSync(seat, { recursive: true, force: true });
});

describe('a vintage carries its workspace dependencies (#4918)', () => {
    it('publishes a COPY of @vibesync/core inside the vintage', () => {
        const r = publish();
        expect(r.status).toBe(0);
        const copy = vintageCopy(currentVintage());
        expect(fs.readFileSync(path.join(copy, 'package.json'), 'utf-8')).toContain('"@vibesync/core"');
        expect(fs.readFileSync(path.join(copy, 'dist', 'index.js'), 'utf-8')).toBe(CORE_V1);
        expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false);
    });

    it('resolves @vibesync/core to the vintage copy for a module loaded after the shared dist/ was rebuilt', () => {
        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        // The shared dist/ moves on while a host still runs the vintage.
        buildSharedCore('core-v2');
        expect(fs.readFileSync(path.join(coreDist, 'index.js'), 'utf-8')).toBe(CORE_V2);

        const loaded = loadFrom(vintage, 'index.js', 'lazy.js');
        expect(loaded.status).toBe(0);
        expect(loaded.marks).toEqual(['core-v1', 'core-v1']);
    });

    it('publishes a NEW vintage when only the shared dist/ changed, and leaves the first one intact', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();
        buildSharedCore('core-v2');

        const second = publish();
        expect(second.status).toBe(0);
        expect(second.output).not.toContain('already published');
        expect(currentVintage()).not.toBe(first);
        expect(fs.readFileSync(path.join(vintageCopy(first), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V1);
        expect(fs.readFileSync(path.join(vintageCopy(currentVintage()), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V2);
    });

    it('publishes the same vintage again when nothing changed', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();

        const again = publish();
        expect(again.output).toContain('already published');
        expect(currentVintage()).toBe(first);
    });
});

describe('what is not a workspace dependency', () => {
    it('is not bundled: a regular dependency stays where npm installed it', () => {
        write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }));
        write('node_modules/left-pad/index.js', 'module.exports = (s) => String(s).padStart(2, "0");\n');
        serverManifest({ '@vibesync/core': '*', 'left-pad': '^1.0.0' });

        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        expect(fs.existsSync(path.join(server, vintage, 'node_modules', 'left-pad'))).toBe(false);
        expect(fs.existsSync(path.join(vintageCopy(vintage), 'package.json'))).toBe(true);
    });

    it('changes neither the vintage id nor its content', () => {
        serverManifest({});
        const outDir = path.join(server, 'build-out');

        expect(publish().status).toBe(0);
        expect(currentVintage()).toBe(`build-${hashTree(outDir).slice(0, 16)}`);
        expect(fs.existsSync(path.join(server, currentVintage(), 'node_modules'))).toBe(false);
    });
});

describe('a workspace dependency without a build', () => {
    it('fails the publish before the marker moves', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();
        fs.rmSync(coreDist, { recursive: true, force: true });

        const failed = publish();
        expect(failed.status).not.toBe(0);
        expect(failed.output).toContain('cannot bundle @vibesync/core');
        expect(currentVintage()).toBe(first);
    });
});
