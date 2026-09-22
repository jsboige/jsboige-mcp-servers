/**
 * Schema delivery across a hot-swap (#3713, wrapper v5.1).
 *
 * The v5 swap delivered new behaviour but not new schemas: a connected client
 * fetches tools/list once, and the wrapper answered every later tools/list with
 * its first cached copy anyway. This drives the REAL mcp-wrapper.cjs over stdio
 * against two fake vintages that serve different tool names, and checks the
 * three properties the fix promises:
 *   (1) the initialize result the client receives advertises tools.listChanged,
 *       without dropping what the server itself declared;
 *   (2) after the marker moves, the client receives notifications/tools/list_changed;
 *   (3) a tools/list sent after that notification returns the NEW vintage's list,
 *       although the startup vintage's persisted cache answered the first one.
 *
 * Hermetic: the wrapper is copied into a temp dir with its own marker, so the
 * machine's real build-current is never touched (unlike scripts/hot-swap-probe.mjs,
 * which swaps every live wrapper on the host).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const os = await vi.importActual<typeof import('node:os')>('node:os');
const path = await vi.importActual<typeof import('node:path')>('node:path');
const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const { fileURLToPath } = await vi.importActual<typeof import('node:url')>('node:url');

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VINTAGE_A = 'build-aaaaaaaaaaaaaaaa';
const VINTAGE_B = 'build-bbbbbbbbbbbbbbbb';

function fakeServer(toolName: string): string {
    return [
        "let buf = '';",
        "process.stdin.on('data', (d) => {",
        '    buf += d;',
        "    const lines = buf.split('\\n');",
        '    buf = lines.pop();',
        '    for (const line of lines) {',
        '        if (!line.trim()) continue;',
        '        const m = JSON.parse(line);',
        '        if (m.id === undefined || m.id === null) continue;',
        '        let result = {};',
        "        if (m.method === 'initialize') {",
        `            result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'fake', version: '${toolName}' } };`,
        "        } else if (m.method === 'tools/list') {",
        `            result = { tools: [{ name: '${toolName}', inputSchema: { type: 'object' } }] };`,
        '        }',
        "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
        '    }',
        '});',
        '',
    ].join('\n');
}

let tmpRoot: string;
let wrapper: ChildProcessWithoutNullStreams | null = null;
let received: any[] = [];
let stderrTail = '';

function send(msg: object): void {
    wrapper!.stdin.write(JSON.stringify(msg) + '\n');
}

async function waitFor(pred: (m: any) => boolean, what: string, timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = received.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for ${what}; stderr tail:\n${stderrTail.slice(-2000)}`);
}

function publishMarker(vintage: string): void {
    // Same atomic switch as scripts/publish-build.mjs: tmp + rename.
    const marker = path.join(tmpRoot, 'build-current');
    fs.writeFileSync(marker + '.tmp', vintage + '\n', 'utf-8');
    fs.renameSync(marker + '.tmp', marker);
}

function initialize(): void {
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-list-changed-'));
    fs.copyFileSync(path.join(pkgRoot, 'mcp-wrapper.cjs'), path.join(tmpRoot, 'mcp-wrapper.cjs'));
    for (const [vintage, tool] of [[VINTAGE_A, 'tool_from_a'], [VINTAGE_B, 'tool_from_b']]) {
        fs.mkdirSync(path.join(tmpRoot, vintage));
        fs.writeFileSync(path.join(tmpRoot, vintage, 'index.js'), fakeServer(tool), 'utf-8');
    }
    // The startup vintage has served a session before, as in production: its
    // persisted tools/list cache exists, so the wrapper answers tools/list from it.
    const indexA = path.join(tmpRoot, VINTAGE_A, 'index.js');
    fs.writeFileSync(path.join(tmpRoot, VINTAGE_A, '.tools-cache.json'), JSON.stringify({
        buildMtime: fs.statSync(indexA).mtime.toISOString(),
        toolsList: { jsonrpc: '2.0', id: 0, result: { tools: [{ name: 'tool_from_a', inputSchema: { type: 'object' } }] } },
    }), 'utf-8');
    publishMarker(VINTAGE_A);
    received = [];
    stderrTail = '';

    wrapper = spawn(process.execPath, [path.join(tmpRoot, 'mcp-wrapper.cjs')], {
        cwd: tmpRoot,
        // dotenv is required by the wrapper and resolved from the package, not the temp dir.
        env: { ...process.env, NODE_PATH: path.join(pkgRoot, 'node_modules'), WORKSPACE_PATH: tmpRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    let out = '';
    wrapper.stdout.on('data', (d) => {
        out += d.toString();
        const lines = out.split('\n');
        out = lines.pop() || '';
        for (const l of lines) if (l.trim()) received.push(JSON.parse(l));
    });
    wrapper.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-8000); });
});

afterEach(async () => {
    if (wrapper && wrapper.exitCode === null) {
        const exited = new Promise<boolean>((r) => wrapper!.once('exit', () => r(true)));
        const sleep = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms));
        // Graceful path first: on stdin EOF the wrapper closes its child's stdin and
        // exits once the child is gone. Killing the wrapper outright can leave the fake
        // server alive with its cwd inside tmpRoot, which Windows refuses to delete.
        wrapper.stdin.end();
        if (!(await Promise.race([exited, sleep(5000)]))) {
            wrapper.kill();
            await Promise.race([exited, sleep(2000)]);
        }
    }
    wrapper = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('mcp-wrapper hot-swap schema delivery (#3713 v5.1)', () => {
    it('advertises listChanged, notifies after a swap, and serves the new vintage tool list', async () => {
        initialize();
        const init = await waitFor((m) => m.id === 0, 'initialize result');
        expect(init.result.capabilities.tools).toEqual({ listChanged: true });
        expect(init.result.capabilities.logging).toEqual({}); // the server's own capability is kept
        expect(init.result.serverInfo.version).toBe('tool_from_a');
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        const before = await waitFor((m) => m.id === 1, 'tools/list before swap');
        expect(before.result.tools.map((t: any) => t.name)).toEqual(['tool_from_a']);

        publishMarker(VINTAGE_B);
        await waitFor((m) => m.method === 'notifications/tools/list_changed', 'notifications/tools/list_changed');

        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const after = await waitFor((m) => m.id === 2, 'tools/list after swap');
        expect(after.result.tools.map((t: any) => t.name)).toEqual(['tool_from_b']);

        // One initialize result only: the swapped child's replayed answer was absorbed.
        expect(received.filter((m) => m.id === 0)).toHaveLength(1);
        // Positive control: the pre-swap list came from the persisted cache, so the
        // post-swap assertion above covers the path production takes.
        expect(stderrTail).toContain('Answered tools/list from persisted cache');
    }, 45_000);

    it('sends no list_changed while no swap happens', async () => {
        initialize();
        await waitFor((m) => m.id === 0, 'initialize result');
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        await waitFor((m) => m.id === 1, 'tools/list');
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        await waitFor((m) => m.id === 2, 'second tools/list');
        expect(received.some((m) => m.method === 'notifications/tools/list_changed')).toBe(false);
    }, 30_000);
});
