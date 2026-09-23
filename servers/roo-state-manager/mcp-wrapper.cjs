#!/usr/bin/env node
/**
 * MCP Wrapper v5.1.0 - Pass-through proxy + hot-swap across content-addressed builds
 *
 * v5.0 (#3713): Hot-swap. The wrapper now resolves the server through the
 * `build-current` marker (content-addressed vintages published by
 * scripts/publish-build.mjs), watches that marker, and swaps the server child
 * when a new vintage is published — without breaking the client connection.
 * A rebuild no longer rewrites bytes under a live process (the exit-10 armed
 * window and its forced VS Code restarts disappear), and new code goes live
 * in running sessions immediately.
 *
 *   - resolves the vintage ONCE per child spawn, keeps that path for the
 *     child's whole life (a vintage is immutable);
 *   - falls back to legacy fixed `build/index.js` when no marker exists
 *     (machine not yet migrated — and still safe: nothing rewrites build/
 *     anymore);
 *   - memorizes the client's `initialize` request + `notifications/initialized`
 *     and replays them into a freshly spawned child, absorbing the child's
 *     initialize response (the client already has one);
 *   - tracks in-flight requests; those orphaned by a swap get an explicit
 *     JSON-RPC error instead of hanging until timeout;
 *   - writes a `.ref-<pid>` file into the vintage it serves so publish-time
 *     retention never prunes a vintage a live wrapper still runs.
 *
 * v5.1 (#3713): schema delivery. A swap used to deliver new BEHAVIOUR but not new
 * SCHEMAS: the client fetches tools/list once and never asks again, and this
 * wrapper answered every later tools/list with its first cached copy anyway.
 * Now the in-memory tools/list cache is dropped at each swap, the wrapper
 * advertises `tools.listChanged` in the initialize result it forwards, and it
 * emits `notifications/tools/list_changed` once the new child has answered the
 * replayed handshake, so a connected client re-fetches the new vintage's list.
 *
 * v4.1 (#1894) retained: persisted tools/list cache (now per-vintage), stdin/
 * stdout passthrough with JSON-RPC filtering, stderr suppression, orphan-leak
 * kill cascade, parent-PID liveness watchdog.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// #2719: the names the HOST set (MCP client env block, shell), recorded BEFORE this
// process loads `.env`. spawnServer() hands the child this whole env, `.env` values
// included, so the child cannot tell the two apart on its own: it gets the list.
const HOST_ENV_KEYS = Object.keys(process.env).filter((k) => process.env[k] !== undefined);

// Load .env BEFORE spawning server
const envPath = path.join(__dirname, '.env');
const _origLog = console.log;
console.log = () => {};
const envResult = dotenv.config({ path: envPath });
console.log = _origLog;
if (envResult.error) {
    console.error(`[MCP-WRAPPER] ⚠️  Warning: Could not load .env from ${envPath}`);
    console.error(`[MCP-WRAPPER] Error: ${envResult.error.message}`);
} else {
    console.error(`[MCP-WRAPPER] ✅ Loaded .env from ${envPath}`);
}

// --- Vintage resolution (v5) ---
const MARKER_FILE = path.join(__dirname, 'build-current');
const LEGACY_DIR = path.join(__dirname, 'build');

function readMarkerVintage() {
    try {
        const name = fs.readFileSync(MARKER_FILE, 'utf-8').trim();
        if (/^build-[0-9a-f]{16}$/.test(name) && fs.existsSync(path.join(__dirname, name, 'index.js'))) {
            return name;
        }
    } catch {}
    return null;
}

function resolveServerDir() {
    const vintage = readMarkerVintage();
    return vintage ? path.join(__dirname, vintage) : LEGACY_DIR;
}

let serverDir = resolveServerDir();
let serverPath = path.join(serverDir, 'index.js');

// --- Persisted tools/list cache (per-vintage since v5) ---
// Lives inside the vintage dir (NOT os.tmpdir() — Windows Disk Cleanup clears
// %TEMP%, which invalidates the cache multiple times per day, causing the
// "0 tools" bug). A vintage is immutable, so a cache written there is valid
// by construction; the mtime check is kept for the legacy fallback dir.
// Resolved at call time, not once: after a swap the cache belongs to the NEW
// vintage (#3713 v5.1), never to the one the wrapper started on.
function cacheFile() {
    return path.join(serverDir, '.tools-cache.json');
}

function logDebug(message) {
    if (process.env.ROO_DEBUG_LOGS) {
        console.error(`[MCP-WRAPPER] ${message}`);
    }
}

function loadPersistedCache() {
    try {
        const data = fs.readFileSync(cacheFile(), 'utf-8');
        const cache = JSON.parse(data);
        const buildStat = fs.statSync(serverPath);
        if (cache.buildMtime === buildStat.mtime.toISOString() && cache.toolsList) {
            const toolCount = cache.toolsList.result?.tools?.length || 0;
            console.error(`[MCP-WRAPPER] 📦 Loaded persisted cache (${toolCount} tools)`);
            return cache.toolsList;
        }
        console.error('[MCP-WRAPPER] Cache stale (build changed), will refresh');
        return null;
    } catch {
        console.error('[MCP-WRAPPER] No persisted cache, will create after server start');
        return null;
    }
}

function savePersistedCache(toolsListResponse) {
    try {
        const buildStat = fs.statSync(serverPath);
        const cache = {
            buildMtime: buildStat.mtime.toISOString(),
            toolsList: toolsListResponse,
        };
        fs.writeFileSync(cacheFile(), JSON.stringify(cache), 'utf-8');
        logDebug(`Persisted cache saved (${toolsListResponse.result?.tools?.length || 0} tools)`);
    } catch (e) {
        logDebug(`Failed to persist cache: ${e.message}`);
    }
}

let persistedCache = loadPersistedCache();

// --- State ---
let answeredFromCache = false;
let cachedToolsListResponse = null;
let stdinBuffer = '';
let stdoutBuffer = '';

// Hot-swap state (v5)
let server = null;                       // current child
let initRequest = null;                  // client's initialize request line
let initId = undefined;                  // its id, to absorb the replayed response
let initializedNotification = null;      // client's notifications/initialized line
const inFlight = new Map();              // request id -> line sent to current child
const stdinQueue = [];                   // client lines buffered during a swap
let swapping = false;                    // swap sequence in progress (stdin buffered)
let swapHandshakePending = false;        // respawned child hasn't answered initialize yet
let previousServerDir = null;            // vintage to fall back to if the new one fails
let swapRetries = 0;
let handshakeWatchdog = null;
let listChangedAdvertised = false;       // initialize result forwarded with tools.listChanged

logDebug('Starting roo-state-manager MCP server v5.1 (pass-through + persisted cache + hot-swap + list_changed)...');
console.error(`[MCP-WRAPPER] 🧬 Serving vintage: ${path.basename(serverDir)}${serverDir === LEGACY_DIR ? ' (legacy fixed path — marker absent)' : ''}`);

// --- Vintage pin (.ref-<pid>) ---
// Tells publish-build retention "a live wrapper still runs this vintage".
function isVintageDir(dir) {
    return path.basename(dir).startsWith('build-');
}

function writeRefFile(dir) {
    if (!isVintageDir(dir)) return;
    try { fs.writeFileSync(path.join(dir, `.ref-${process.pid}`), `${Date.now()}\n`, 'utf-8'); } catch {}
}

function removeRefFile(dir) {
    if (!isVintageDir(dir)) return;
    try { fs.unlinkSync(path.join(dir, `.ref-${process.pid}`)); } catch {}
}

// Capture original cwd BEFORE overriding with __dirname
const originalCwd = process.cwd();

console.error(`[MCP-WRAPPER] 🔍 Workspace detection:`);
console.error(`[MCP-WRAPPER]   process.cwd() (originalCwd): ${originalCwd}`);
console.error(`[MCP-WRAPPER]   process.env.WORKSPACE_PATH:  ${process.env.WORKSPACE_PATH || '(not set)'}`);
console.error(`[MCP-WRAPPER]   __dirname:                   ${__dirname}`);
console.error(`[MCP-WRAPPER]   → WORKSPACE_PATH passed to server: ${process.env.WORKSPACE_PATH || originalCwd}`);

// --- Child spawn & wiring (v5: re-entrant for hot-swap) ---
function spawnServer() {
    const child = spawn('node', [serverPath], {
        cwd: __dirname,
        env: {
            ...process.env,
            WORKSPACE_PATH: process.env.WORKSPACE_PATH || originalCwd,
            // #2719: read by services/host-env-snapshot.ts. WORKSPACE_PATH is set just
            // above, by the wrapper itself: host-owned from the child's side.
            RSM_HOST_ENV_KEYS: [...HOST_ENV_KEYS, 'WORKSPACE_PATH'].join(','),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    child.stderr.on('data', (data) => filterStderr(data));

    child.stdout.on('data', (data) => {
        const output = data.toString();
        stdoutBuffer += output;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            if (trimmed.startsWith('{')) {
                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    process.stderr.write('[MCP-WRAPPER] dropped non-JSON line: ' + trimmed.slice(0, 120) + '\n');
                    return;
                }
                if (parsed && parsed.jsonrpc === '2.0') {
                    // Absorb the initialize response of a hot-swapped child: the
                    // client already has its own answer and must not get a second.
                    if (swapHandshakePending && parsed.id === initId && (parsed.result !== undefined || parsed.error !== undefined)) {
                        swapHandshakePending = false;
                        swapRetries = 0;
                        if (handshakeWatchdog) { clearTimeout(handshakeWatchdog); handshakeWatchdog = null; }
                        console.error('[MCP-WRAPPER] ✅ Hot-swap complete — new vintage serving');
                        notifyToolListChanged();
                        return;
                    }
                    // #3713 v5.1: the wrapper, not the server, is what swaps the tool
                    // list under a live client, so the wrapper advertises the capability
                    // in the ONE initialize result the client receives.
                    if (!listChangedAdvertised && parsed.id === initId && parsed.result && typeof parsed.result === 'object') {
                        listChangedAdvertised = true;
                        const caps = parsed.result.capabilities || (parsed.result.capabilities = {});
                        caps.tools = { ...(caps.tools || {}), listChanged: true };
                        process.stdout.write(JSON.stringify(parsed) + '\n');
                        return;
                    }
                    // A response closes its in-flight entry (never re-error it at swap).
                    if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
                        inFlight.delete(parsed.id);
                    }
                    const processed = processToolsList(trimmed);
                    if (processed !== null) {
                        process.stdout.write(processed + '\n');
                    }
                } else {
                    process.stderr.write('[MCP-WRAPPER] dropped non-JSONRPC JSON: ' + trimmed.slice(0, 120) + '\n');
                }
            } else if (trimmed.includes('Roo State Manager Server started')) {
                process.stderr.write('[MCP-WRAPPER] ' + line + '\n');
            }
        });
    });

    child.on('error', (error) => {
        logDebug(`Failed to start server: ${error.message}`);
        process.exit(1);
    });

    child.on('exit', (code) => {
        if (child !== server) return; // a superseded child dying late — not ours to act on
        if (swapHandshakePending) {
            // The respawned child died before completing the replayed handshake.
            logDebug(`Swapped child died pre-handshake (code ${code}) — retry/fallback`);
            retrySwapOrFallback();
            return;
        }
        logDebug(`Server exited with code ${code}`);
        removeRefFile(serverDir);
        process.exit(code || 0);
    });

    server = child;
    writeRefFile(serverDir);
}

// Intentionally stop a child: detach its handlers FIRST so its exit can never
// reach the crash path (process.exit) — the swap sequence owns what happens
// next, and a superseded child has nothing left to tell us.
function detachAndKillChild(child) {
    try { child.stdout && child.stdout.removeAllListeners('data'); } catch {}
    try { child.stderr && child.stderr.removeAllListeners('data'); } catch {}
    try { child.removeAllListeners('exit'); } catch {}
    try { child.removeAllListeners('error'); } catch {}
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
}

function filterStderr(data) {
    const output = data.toString();

    const suppressPatterns = [
        '[SKIP]',
        ' injecting env ',
        '✅ Toutes les variables',
        '🔧 [DEBUG]',
        '⚙️ [NotificationService]',
        '🔧 [ToolUsageInterceptor]',
        'Loading existing skeletons',
        /Found \d+ skeleton files/,
        /Loaded \d+ skeletons/,
        '🚀 Initialisation des services background',
        '🔍 Initialisation du service d\'indexation',
        'Qdrant client initialized',
        '🖥️  Machine actuelle:',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        /\(node:\d+\) Warning:/
    ];

    const shouldSuppress = suppressPatterns.some(pattern => {
        if (typeof pattern === 'string') {
            return output.includes(pattern);
        } else {
            return pattern.test(output);
        }
    });

    if (!shouldSuppress) {
        process.stderr.write(output);
    }
}

// --- stdin: intercept client → server messages ---
process.stdin.on('data', (data) => {
    const input = data.toString();
    stdinBuffer += input;
    const lines = stdinBuffer.split('\n');
    stdinBuffer = lines.pop() || '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // During a swap, buffer client lines; they will be forwarded to the
        // new child right after the replayed handshake, in order.
        if (swapping) {
            stdinQueue.push(trimmed);
            continue;
        }

        forwardClientLine(trimmed);
    }
});

// Register a client line's protocol state: the swap replay needs the handshake
// lines, and EVERY request id must sit in inFlight so a dying child fails it
// explicitly (never a hang). Extracted so the doSwap drain (W1, #3713 follow-up)
// registers the same state the live path does — raw writes left queued ids
// unerrorable if the child they were drained into later died.
function trackClientLine(trimmed) {
    try {
        const msg = JSON.parse(trimmed);
        if (msg.method === 'initialize' && msg.id !== undefined && msg.id !== null) {
            initRequest = trimmed;
            initId = msg.id;
        } else if (msg.method === 'notifications/initialized') {
            initializedNotification = trimmed;
        } else if (msg.method && msg.id !== undefined && msg.id !== null) {
            inFlight.set(msg.id, trimmed);
        }
    } catch {}
}

function forwardClientLine(trimmed) {
    trackClientLine(trimmed);

    server.stdin.write(trimmed + '\n');

    // Intercept tools/list for instant cache response (first call only)
    if (!answeredFromCache && persistedCache) {
        try {
            const msg = JSON.parse(trimmed);
            if (msg.method === 'tools/list') {
                const response = JSON.parse(JSON.stringify(persistedCache));
                response.id = msg.id;
                process.stdout.write(JSON.stringify(response) + '\n');
                // The client has its answer: the id must not stay errorable, or a
                // swap killing the child before it answers would send a second,
                // -32603 reply for the same id (F2, #3713 follow-up).
                inFlight.delete(msg.id);
                answeredFromCache = true;
                console.error('[MCP-WRAPPER] ⚡ Answered tools/list from persisted cache (<1ms)');
            }
        } catch {}
    }
}

// --- Orphan-leak fix (incident 2026-05-26, 73 orphans on ai-01) ---
// Windows has no parent-death signal (no SIGHUP-on-parent-death, no POSIX
// process groups). When the MCP client (Claude Code / Roo) goes away, its
// only signal to us is stdin EOF. We previously called only `server.stdin.end()`
// and waited indefinitely on `server.on('exit')` — but the server's event loop
// is pinned by `qdrantIndexInterval` + `_gdriveHealthInterval` + Qdrant client,
// so it never exited. Result: orphan processes accumulate (73 on ai-01,
// 23.9 GB RAM, 73 parallel embedding loops hammering embeddings.myia.io).
//
// Fix: cascade SIGTERM/SIGKILL with timers and a final force-exit; plus a
// parent-PID liveness watchdog as a belt-and-braces against stdin-EOF being
// lost through the cmd.exe shim or detached stdio.
let killCascadeArmed = false;
function forceKillServerCascade(reason) {
    if (killCascadeArmed) return;
    killCascadeArmed = true;
    console.error(`[MCP-WRAPPER] 🛑 ${reason} — initiating server kill cascade`);
    try { server.stdin.end(); } catch {}
    setTimeout(() => {
        try {
            console.error('[MCP-WRAPPER] kill-cascade T+5s: SIGTERM');
            server.kill('SIGTERM');
        } catch {}
    }, 5000).unref();
    setTimeout(() => {
        try {
            console.error('[MCP-WRAPPER] kill-cascade T+10s: SIGKILL');
            server.kill('SIGKILL');
        } catch {}
    }, 10000).unref();
    setTimeout(() => {
        console.error('[MCP-WRAPPER] kill-cascade T+12s: wrapper force-exit');
        process.exit(0);
    }, 12000).unref();
}

process.stdin.on('end', () => forceKillServerCascade('stdin EOF'));
process.stdin.on('close', () => forceKillServerCascade('stdin closed'));

// Parent-PID liveness watchdog. Windows doesn't notify children when the
// parent dies, so we poll every 30s with `process.kill(ppid, 0)` (no-signal
// liveness probe). If the parent is gone (ESRCH), our wrapper has become an
// orphan — trigger the kill cascade.
const initialParentPid = process.ppid;
if (initialParentPid && initialParentPid !== 0) {
    const parentWatchdog = setInterval(() => {
        try {
            process.kill(initialParentPid, 0);
        } catch (e) {
            if (e && e.code === 'ESRCH') {
                clearInterval(parentWatchdog);
                forceKillServerCascade(`parent PID ${initialParentPid} no longer exists`);
            }
            // EPERM = parent exists but we can't signal it (still alive) — keep watching.
        }
    }, 30_000);
    parentWatchdog.unref();
    console.error(`[MCP-WRAPPER] 👁  Parent-PID liveness watchdog armed (ppid=${initialParentPid}, 30s poll)`);
}

// --- Hot-swap (v5, #3713) ---
// Trigger: the `build-current` marker moved to a different vintage. The marker
// is switched atomically by publish-build.mjs only after a complete tree copy,
// so one marker event == one complete build (a naive watch on a tsc output dir
// would fire hundreds of times on half-written trees).
let swapCheckTimer = null;
function scheduleSwapCheck() {
    if (swapCheckTimer) return;
    swapCheckTimer = setTimeout(() => {
        swapCheckTimer = null;
        maybeSwap();
    }, 500);
}

function maybeSwap() {
    if (swapping || killCascadeArmed) return;
    const vintage = readMarkerVintage();
    if (!vintage) return;
    const targetDir = path.join(__dirname, vintage);
    if (targetDir === serverDir) return;
    doSwap(targetDir);
}

// Requests whose child was killed mid-flight can never be answered — fail them
// fast with an explicit error instead of letting the client hang (property (b):
// never a hang — true on EVERY swap path, not just the nominal one). Call AFTER
// the child is dead and its listeners detached: a racing late response would
// double-answer the id.
function failLostInFlightRequests(stage) {
    const lostIds = [...inFlight.keys()];
    inFlight.clear();
    for (const id of lostIds) {
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
                code: -32603,
                message: `roo-state-manager hot-swap: request lost during server restart onto a new build${stage ? ` (${stage})` : ''}; safe to retry if idempotent`,
            },
        }) + '\n');
    }
}

function armHandshakeWatchdog() {
    if (!swapHandshakePending) return;
    handshakeWatchdog = setTimeout(() => {
        if (!swapHandshakePending) return;
        console.error('[MCP-WRAPPER] ⏱ Hot-swap handshake timeout — retry/fallback');
        retrySwapOrFallback();
    }, 20_000);
    handshakeWatchdog.unref();
}

// #3713 v5.1: a new child may serve a different tool list. Forget the old one
// BEFORE anything is drained into the new child, or its tools/list answer would
// be replaced by the stale copy (processToolsList dedup) or suppressed outright
// (answeredFromCache left true by a child killed before answering). The copy
// loaded from disk at startup goes too: forwardClientLine answers EVERY
// tools/list from it (answeredFromCache flips back once the child answers), so
// keeping it would serve the startup vintage's list for the wrapper's lifetime.
function resetToolsListCache() {
    cachedToolsListResponse = null;
    answeredFromCache = false;
    persistedCache = null;
}

// Only a client that completed initialize through us was told listChanged, and
// a notification before initialize would break the protocol.
function notifyToolListChanged() {
    if (!listChangedAdvertised) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
    console.error('[MCP-WRAPPER] 📣 notifications/tools/list_changed sent — client re-fetches tools/list');
}

// Replay the captured handshake into the CURRENT child, then drain buffered
// client lines — tracked (W1), so queued request ids enter inFlight and become
// explicitly errorable if this child dies before answering, instead of hanging
// the client. Stream order guarantees the child sees initialize first. Shared
// by the nominal swap, the retry and the fallback: every path that respawns a
// child must replay AND drain identically.
function replayHandshakeAndDrain() {
    resetToolsListCache();
    swapHandshakePending = initRequest !== null;
    if (initRequest !== null) server.stdin.write(initRequest + '\n');
    if (initializedNotification !== null) server.stdin.write(initializedNotification + '\n');
    for (const line of stdinQueue) {
        trackClientLine(line);
        server.stdin.write(line + '\n');
    }
    stdinQueue.length = 0;
}

function doSwap(targetDir) {
    swapping = true;
    const oldDir = serverDir;
    console.error(`[MCP-WRAPPER] 🔄 Hot-swap: ${path.basename(oldDir)} → ${path.basename(targetDir)}`);

    // Kill the old child, detached — its exit handler must stay silent about
    // this intentional swap.
    const oldChild = server;
    detachAndKillChild(oldChild);
    removeRefFile(oldDir);

    // Requests already in the old child will never be answered — failed fast
    // below (after spawn) via failLostInFlightRequests().

    previousServerDir = oldDir;
    serverDir = targetDir;
    serverPath = path.join(serverDir, 'index.js');
    spawnServer();

    // Old-child requests can never be answered — fail them BEFORE the drain
    // registers queued ids: those belong to the LIVE new child and must survive
    // this call (they become errorable only if that child dies, at the
    // retry/fallback path, not here).
    failLostInFlightRequests();

    replayHandshakeAndDrain();
    swapping = false;

    if (!swapHandshakePending) {
        // Client never handshook through us (wrapper restarted mid-session?
        // impossible in practice) — nothing to wait for.
        console.error('[MCP-WRAPPER] ✅ Hot-swap complete — new vintage serving');
    } else {
        armHandshakeWatchdog();
    }
}

function retrySwapOrFallback() {
    swapHandshakePending = false;
    if (handshakeWatchdog) { clearTimeout(handshakeWatchdog); handshakeWatchdog = null; }
    detachAndKillChild(server);
    // Same never-a-hang contract as doSwap: requests in the killed child get an
    // explicit -32603, and their ids leave inFlight (no Map leak across retries).
    failLostInFlightRequests('retry/fallback');

    if (swapRetries < 2 && readMarkerVintage()) {
        swapRetries++;
        console.error(`[MCP-WRAPPER] 🔁 Hot-swap retry ${swapRetries}/2 on ${path.basename(serverDir)}`);
        spawnServer();
        replayHandshakeAndDrain();
        armHandshakeWatchdog();
        return;
    }

    if (previousServerDir && previousServerDir !== serverDir && fs.existsSync(path.join(previousServerDir, 'index.js'))) {
        console.error(`[MCP-WRAPPER] ⬅️ Hot-swap failed — falling back to ${path.basename(previousServerDir)}`);
        removeRefFile(serverDir);
        serverDir = previousServerDir;
        serverPath = path.join(serverDir, 'index.js');
        spawnServer();
        replayHandshakeAndDrain();
        armHandshakeWatchdog();
        return;
    }

    console.error('[MCP-WRAPPER] ❌ Hot-swap failed with no fallback — exiting');
    removeRefFile(serverDir);
    process.exit(1);
}

// Watch the server ROOT directory and react to marker writes. Watching the
// directory (not the marker file) survives the tmp+rename atomic switch.
try {
    const watcher = fs.watch(__dirname, (event, filename) => {
        if (filename === 'build-current' || filename === 'build-current.tmp') {
            scheduleSwapCheck();
        }
    });
    watcher.on('error', () => { /* polling below is the safety net */ });
    watcher.unref();
} catch { /* polling below is the safety net */ }
// Low-frequency polling safety net: covers a missed/edge-case watch event.
setInterval(() => maybeSwap(), 10_000).unref();

// --- stdout: process server → client messages ---
// Returns string to forward, or null to suppress
function processToolsList(message) {
    try {
        const parsed = JSON.parse(message);

        if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {
            // Always update persisted cache with fresh server response
            savePersistedCache(parsed);

            // If we already answered from cache, suppress server's duplicate
            if (answeredFromCache) {
                answeredFromCache = false;
                cachedToolsListResponse = JSON.stringify(parsed);
                logDebug('Suppressed server tools/list (already answered from cache)');
                return null;
            }

            // Dedup: if already cached, return cached version with updated id
            if (cachedToolsListResponse) {
                logDebug('Using cached tools/list (preventing duplicates)');
                const cachedResponse = JSON.parse(cachedToolsListResponse);
                if (parsed.id !== undefined) {
                    cachedResponse.id = parsed.id;
                }
                return JSON.stringify(cachedResponse);
            }

            // First real response: deduplicate tool names and cache
            const toolCount = parsed.result.tools.length;
            logDebug(`Tools/list: ${toolCount} tools`);

            const toolNames = parsed.result.tools.map(t => t.name);
            const uniqueNames = new Set(toolNames);
            if (toolNames.length !== uniqueNames.size) {
                logDebug('WARNING: Duplicate tool names detected, deduplicating...');
                const seen = new Set();
                parsed.result.tools = parsed.result.tools.filter(tool => {
                    if (seen.has(tool.name)) return false;
                    seen.add(tool.name);
                    return true;
                });
                logDebug(`After dedup: ${parsed.result.tools.length} tools`);
            }

            cachedToolsListResponse = JSON.stringify(parsed);
            return cachedToolsListResponse;
        }

        return message;
    } catch (error) {
        return message;
    }
}

// Initial child (module-level, after all handler definitions)
spawnServer();

function gracefulShutdown(signal) {
    logDebug(`Received ${signal}, killing server process...`);
    try {
        server.kill('SIGTERM');
        setTimeout(() => {
            try { server.kill('SIGKILL'); } catch {}
            process.exit(0);
        }, 3000);
    } catch (e) {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('exit', () => {
    try { server.kill(); } catch {}
    removeRefFile(serverDir);
});
