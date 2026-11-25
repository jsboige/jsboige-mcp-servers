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
const CORE_V3 = "export const MARK = 'core-v3';\n";

let tmpRoot: string; // <tmp>/vintage-autonomy-XXXX — what afterEach removes
let seat: string; // the workspace root — tmpRoot, or deeper where a test needs it elsewhere
let server: string; // <seat>/servers/roo-state-manager
let coreDist: string; // <seat>/packages/vibesync-core/dist — the SHARED build
const links: string[] = []; // the directory links inside the seat — junctions on Windows

function write(rel: string, content: string): void {
    const target = path.join(seat, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
}

/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. afterEach removes it first. */
function linkDir(target: string, at: string): string {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, 'junction');
    links.push(at);
    return at;
}

/** What npm links for a workspace member of the seat: node_modules/<name> → packages/<name>. */
function workspaceLink(targetRel: string, name: string): string {
    return linkDir(path.join(seat, ...targetRel.split('/')), path.join(seat, 'node_modules', ...name.split('/')));
}

/** The shared dist/ of the workspace package, as its `tsc` leaves it. */
function buildSharedCore(mark: string): void {
    write('packages/vibesync-core/dist/index.js', `export const MARK = '${mark}';\n`);
}

/** `other` carries the other blocks of the manifest when a test needs them: { devDependencies: {…} }. */
function serverManifest(dependencies: Record<string, string>, other: Record<string, Record<string, string>> = {}): void {
    write('servers/roo-state-manager/package.json', JSON.stringify({ name: 'roo-state-manager', type: 'module', dependencies, ...other }));
}

/** A pid no process holds, in the range Windows and POSIX pids never reach in practice (4-aligned, probed). */
function deadPid(): number {
    for (let pid = 999_992; pid > 999_000; pid -= 4) {
        try { process.kill(pid, 0); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EPERM') return pid;
        }
    }
    throw new Error('no dead pid in the probe range');
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

/** The vintage directories present in the seat. */
function vintageNames(): string[] {
    return fs.readdirSync(server, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^build-[0-9a-f]{16}$/.test(e.name))
        .map((e) => e.name);
}

/** A host loading modules from `vintage` — AFTER the shared dist/ may have moved on. */
function loadFrom(vintage: string, ...modules: string[]): { status: number | null; marks: string[] } {
    const urls = modules.map((m) => JSON.stringify(pathToFileURL(path.join(server, vintage, m)).href)).join(', ');
    const script = `for (const url of [${urls}]) console.log((await import(url)).MARK);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: server, encoding: 'utf-8' });
    return { status: r.status, marks: r.stdout.split(/\r?\n/).filter(Boolean) };
}

/** The seat in miniature, built with `root` as its workspace root. */
function buildSeat(root: string): void {
    seat = root;
    server = path.join(seat, 'servers', 'roo-state-manager');
    coreDist = path.join(seat, 'packages', 'vibesync-core', 'dist');
    links.length = 0;

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
    workspaceLink('packages/vibesync-core', '@vibesync/core');
    serverManifest({ '@vibesync/core': '*' });
    for (const module of ['index.js', 'lazy.js']) {
        write(`servers/roo-state-manager/build-out/${module}`, "import { MARK } from '@vibesync/core';\nexport { MARK };\n");
    }
    fs.mkdirSync(path.join(server, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(scriptsDir, 'publish-build.mjs'), path.join(server, 'scripts', 'publish-build.mjs'));
    fs.copyFileSync(path.join(scriptsDir, 'write-build-info.mjs'), path.join(server, 'scripts', 'write-build-info.mjs'));
    fs.copyFileSync(path.join(scriptsDir, 'lib', 'vintage-store.mjs'), path.join(server, 'scripts', 'lib', 'vintage-store.mjs'));
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vintage-autonomy-'));
    buildSeat(tmpRoot);
});

afterEach(() => {
    // The links go first and are not followed — RemoveDirectory/unlink on a link remove the link,
    // never its target — so everything removed afterwards stays inside the temp tree.
    for (const l of links.splice(0).reverse()) {
        if (process.platform === 'win32') fs.rmdirSync(l);
        else fs.unlinkSync(l);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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

    it('carries it even when the workspace itself sits under a folder named node_modules', () => {
        // The package's real path then holds a node_modules segment too: read as segments, every
        // workspace package of such a checkout passed for a regular one — silently.
        buildSeat(path.join(tmpRoot, 'node_modules', 'ws'));

        const r = publish();
        expect(r.status).toBe(0);
        expect(r.output).toContain('bundling workspace dependency @vibesync/core');
        expect(fs.readFileSync(path.join(vintageCopy(currentVintage()), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V1);
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

    it('is not bundled either: a dependency linked into a store under the same node_modules tree — pnpm installs every package this way', () => {
        const stored = path.join(seat, 'node_modules', '.pnpm', 'left-pad@1.0.0', 'node_modules', 'left-pad');
        fs.mkdirSync(stored, { recursive: true });
        fs.writeFileSync(path.join(stored, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }));
        fs.writeFileSync(path.join(stored, 'index.js'), 'module.exports = (s) => String(s).padStart(2, "0");\n');
        linkDir(stored, path.join(seat, 'node_modules', 'left-pad'));
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

    it('is not bundled, and cannot fail the publish: a workspace package the server declares as a devDependency or a peerDependency only', () => {
        // Neither has a build: both are build- and test-time. The next grain of #4886 adds workspace
        // packages the server only builds or tests with.
        write('packages/dev-tool/package.json', JSON.stringify({ name: '@vibesync/dev-tool', version: '0.1.0', type: 'module', main: './dist/index.js' }));
        write('packages/peer-tool/package.json', JSON.stringify({ name: '@vibesync/peer-tool', version: '0.1.0', type: 'module', main: './dist/index.js' }));
        workspaceLink('packages/dev-tool', '@vibesync/dev-tool');
        workspaceLink('packages/peer-tool', '@vibesync/peer-tool');
        serverManifest(
            { '@vibesync/core': '*' },
            { devDependencies: { '@vibesync/dev-tool': '*' }, peerDependencies: { '@vibesync/peer-tool': '*' } },
        );

        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        expect(fs.existsSync(path.join(vintageCopy(vintage), 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(server, vintage, 'node_modules', '@vibesync', 'dev-tool'))).toBe(false);
        expect(fs.existsSync(path.join(server, vintage, 'node_modules', '@vibesync', 'peer-tool'))).toBe(false);
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

// ms#1910 review of #4918. The first version skipped a bundled package as soon
// as its package.json was in the vintage — the FIRST file copied, not the
// last: a copy interrupted right after it left a same-id vintage with a
// partial dist/, and the next publish marked it. The id is now read back from
// the copy itself; nothing else vouches for completeness. The same read-back
// closes the second gap: the id is computed on the sources, the copy is made
// after — two reads of one shared dist/.
describe('a copy that did not finish (ms#1910 review)', () => {
    it('is redone: the staging tree of a dead publish is discarded and the vintage published complete', () => {
        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        // Rewind to the crash: the final name never appeared, only a staging tree that stopped after package.json.
        fs.rmSync(path.join(server, vintage), { recursive: true, force: true });
        fs.rmSync(path.join(server, 'build-current'));
        const staging = path.join(server, `${vintage}.staging-${deadPid()}`);
        write(`servers/roo-state-manager/${path.basename(staging)}/node_modules/@vibesync/core/package.json`, '{"name":"@vibesync/core"}\n');

        const again = publish();
        expect(again.status).toBe(0);
        expect(again.output).toContain('removed stale staging');
        expect(fs.existsSync(staging)).toBe(false);
        expect(currentVintage()).toBe(vintage);
        expect(fs.readFileSync(vintageCopy(vintage, 'dist', 'index.js'), 'utf-8')).toBe(CORE_V1);
    });

    it('is refused when it sits under the final name, and is never marked', () => {
        expect(publish().status).toBe(0);
        buildSharedCore('core-v2');
        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        expect(fs.readFileSync(vintageCopy(vintage, 'dist', 'index.js'), 'utf-8')).toBe(CORE_V2);

        // The interruption the first version let through: package.json there, dist/ never copied.
        fs.rmSync(path.join(vintageCopy(vintage), 'dist'), { recursive: true, force: true });
        fs.rmSync(path.join(server, 'build-current'));

        const refused = publish();
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain('REFUSED');
        expect(refused.output).toContain(vintage);
        expect(fs.existsSync(path.join(server, 'build-current'))).toBe(false);
        // The remedy the refusal names is the one that unblocks the seat.
        expect(refused.output).toContain(`Remove ${path.join(server, vintage)}`);
        fs.rmSync(path.join(server, vintage), { recursive: true, force: true });
        expect(publish().status).toBe(0);
        expect(fs.readFileSync(vintageCopy(currentVintage(), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V2);
    });

    it('is not what a served vintage looks like: the files a live wrapper adds are not content', () => {
        expect(publish().status).toBe(0);
        const vintage = currentVintage();
        // mcp-wrapper.cjs writes both into the vintage it serves; build-info.json is already there from the publish.
        fs.writeFileSync(path.join(server, vintage, '.tools-cache.json'), '{"buildMtime":"x","toolsList":{}}\n', 'utf-8');
        fs.writeFileSync(path.join(server, vintage, `.ref-${process.pid}`), `${Date.now()}\n`, 'utf-8');
        expect(fs.existsSync(path.join(server, vintage, 'build-info.json'))).toBe(true);

        const again = publish();
        expect(again.status).toBe(0);
        expect(again.output).toContain('already published');
        expect(currentVintage()).toBe(vintage);
    });

    it('is refused when a source changes between the hash and the copy — nothing is published, the marker does not move', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();
        buildSharedCore('core-v2');

        // Another build rewrites the shared dist/ while THIS publish copies it: injected into the seat's
        // publisher right after the id is computed from the sources.
        const script = path.join(server, 'scripts', 'publish-build.mjs');
        const anchor = 'const vintageId = vintageNameFor(outDir, bundledParts(bundled));';
        const text = fs.readFileSync(script, 'utf-8');
        expect(text, 'the line this test injects after').toContain(anchor);
        const rewrite = `fs.writeFileSync(path.join(bundled[0].realDir, 'dist', 'index.js'), ${JSON.stringify(CORE_V3)});`;
        fs.writeFileSync(script, text.replace(anchor, `${anchor}\n${rewrite}`), 'utf-8');

        const refused = publish();
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain('REFUSED: the staged copy hashes to');
        expect(refused.output).toContain('Build again.');
        expect(currentVintage()).toBe(first);
        expect(vintageNames()).toEqual([first]);
        expect(fs.readdirSync(server).filter((name) => name.includes('.staging-'))).toEqual([]);

        // The build that follows publishes what the source is now.
        fs.copyFileSync(path.join(scriptsDir, 'publish-build.mjs'), script);
        const next = publish();
        expect(next.status).toBe(0);
        expect(currentVintage()).not.toBe(first);
        expect(fs.readFileSync(vintageCopy(currentVintage(), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V3);
    });

    // Two publishes of one build race for the final name. The rename of the
    // loser fails; what sits there is then READ BACK, never trusted.
    function otherPublishWinsTheName(script: string, alsoWrite: string): void {
        const anchor = 'fs.renameSync(stagingDir, vintageDir);';
        const text = fs.readFileSync(script, 'utf-8');
        expect(text, 'the line this test injects before').toContain(anchor);
        const wins = `fs.cpSync(stagingDir, vintageDir, { recursive: true });${alsoWrite}`;
        fs.writeFileSync(script, text.replace(anchor, `${wins}\n${anchor}`), 'utf-8');
    }

    it('is read back, not trusted, when another publish put the same content under the final name first', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();
        buildSharedCore('core-v2');
        otherPublishWinsTheName(path.join(server, 'scripts', 'publish-build.mjs'), '');

        const r = publish();
        expect(r.status).toBe(0);
        expect(r.output).toContain('was published concurrently');
        expect(r.output).not.toContain('REFUSED');
        expect(currentVintage()).not.toBe(first);
        expect(vintageNames()).toHaveLength(2);
        expect(fs.readFileSync(vintageCopy(currentVintage(), 'dist', 'index.js'), 'utf-8')).toBe(CORE_V2);
        expect(fs.readdirSync(server).filter((name) => name.includes('.staging-'))).toEqual([]);
    });

    it('is refused when the tree that won the final name does not hash to it', () => {
        expect(publish().status).toBe(0);
        const first = currentVintage();
        buildSharedCore('core-v2');
        otherPublishWinsTheName(
            path.join(server, 'scripts', 'publish-build.mjs'),
            ` fs.writeFileSync(path.join(vintageDir, 'stray.js'), 'x');`,
        );

        const refused = publish();
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain('REFUSED:');
        expect(refused.output).toContain('published concurrently');
        expect(currentVintage()).toBe(first);
        expect(fs.readdirSync(server).filter((name) => name.includes('.staging-'))).toEqual([]);
    });
});
