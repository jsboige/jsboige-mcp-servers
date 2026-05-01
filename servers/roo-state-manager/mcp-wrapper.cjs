#!/usr/bin/env node
/**
 * MCP Wrapper v4.1.0 - Pass-through + Persisted tools/list cache
 *
 * v4.1 (#1894): Persisted tools/list cache to eliminate startup timeout.
 * The wrapper intercepts tools/list requests and responds from a disk cache
 * (<1ms) while the server starts in the background (~6s). The server's
 * response updates the cache for next session.
 *
 * Previous features retained:
 * - Deduplication cache (VS Code calls tools/list multiple times)
 * - Suppression of verbose stderr logs
 * - stdin/stdout passthrough with JSON-RPC filtering
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

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

// Path to the real MCP server
const serverPath = path.join(__dirname, 'build', 'index.js');

// --- Persisted tools/list cache ---
const CACHE_FILE = path.join(os.tmpdir(), '.mcp-roo-state-tools-cache.json');

function logDebug(message) {
    if (process.env.ROO_DEBUG_LOGS) {
        console.error(`[MCP-WRAPPER] ${message}`);
    }
}

function loadPersistedCache() {
    try {
        const data = fs.readFileSync(CACHE_FILE, 'utf-8');
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
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
        logDebug(`Persisted cache saved (${toolsListResponse.result?.tools?.length || 0} tools)`);
    } catch (e) {
        logDebug(`Failed to persist cache: ${e.message}`);
    }
}

const persistedCache = loadPersistedCache();

// --- State ---
let answeredFromCache = false;
let cachedToolsListResponse = null;
let stdinBuffer = '';
let stdoutBuffer = '';

logDebug('Starting roo-state-manager MCP server v4.1 (pass-through + persisted cache)...');

// Capture original cwd BEFORE overriding with __dirname
const originalCwd = process.cwd();

console.error(`[MCP-WRAPPER] 🔍 Workspace detection:`);
console.error(`[MCP-WRAPPER]   process.cwd() (originalCwd): ${originalCwd}`);
console.error(`[MCP-WRAPPER]   process.env.WORKSPACE_PATH:  ${process.env.WORKSPACE_PATH || '(not set)'}`);
console.error(`[MCP-WRAPPER]   __dirname:                   ${__dirname}`);
console.error(`[MCP-WRAPPER]   → WORKSPACE_PATH passed to server: ${process.env.WORKSPACE_PATH || originalCwd}`);

// Spawn server with PIPED stdin so we can intercept tools/list requests
const server = spawn('node', [serverPath], {
    cwd: __dirname,
    env: {
        ...process.env,
        WORKSPACE_PATH: process.env.WORKSPACE_PATH || originalCwd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
});

// --- stderr: filter verbose server logs ---
server.stderr.on('data', (data) => {
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
});

// --- stdin: intercept client → server messages ---
process.stdin.on('data', (data) => {
    const input = data.toString();
    stdinBuffer += input;
    const lines = stdinBuffer.split('\n');
    stdinBuffer = lines.pop() || '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Forward ALL messages to server
        server.stdin.write(trimmed + '\n');

        // Intercept tools/list for instant cache response (first call only)
        if (!answeredFromCache && persistedCache) {
            try {
                const msg = JSON.parse(trimmed);
                if (msg.method === 'tools/list') {
                    const response = JSON.parse(JSON.stringify(persistedCache));
                    response.id = msg.id;
                    process.stdout.write(JSON.stringify(response) + '\n');
                    answeredFromCache = true;
                    console.error('[MCP-WRAPPER] ⚡ Answered tools/list from persisted cache (<1ms)');
                }
            } catch {}
        }
    }
});

process.stdin.on('end', () => {
    server.stdin.end();
});

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

server.stdout.on('data', (data) => {
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

// --- Process lifecycle ---
server.on('error', (error) => {
    logDebug(`Failed to start server: ${error.message}`);
    process.exit(1);
});

server.on('exit', (code) => {
    logDebug(`Server exited with code ${code}`);
    process.exit(code || 0);
});

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
});
