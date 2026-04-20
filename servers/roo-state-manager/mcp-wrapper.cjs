#!/usr/bin/env node
/**
 * MCP Wrapper v4.0.0 - Pass-through + Déduplication anti-doublons VS Code
 *
 * CHANGEMENT v4: Plus de filtrage d'outils. Tous les outils de roo-state-manager
 * sont exposés à Claude Code (~37 outils après consolidations).
 *
 * Raisons du changement:
 * - Claude Code a besoin des outils conversation_browser (consolidé #457),
 *   view_task_details, get_raw_conversation pour analyser les runs
 *   du scheduler Roo sans lire manuellement les fichiers JSON.
 * - roosync_search et export_data sont utiles pour la coordination.
 * - ~37 outils est raisonnable pour Claude (pas de threshold comme Roo à 60).
 *
 * Fonctions conservées:
 * - Déduplication cache (VS Code appelle tools/list plusieurs fois)
 * - Suppression des logs stderr bruyants
 */

const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

// Charger le .env du projet AVANT de lancer le serveur
// Cela évite de dupliquer les variables dans settings.json
const envPath = path.join(__dirname, '.env');
// CRITICAL: dotenv v17+ logs to stdout, which breaks MCP stdio protocol.
// Temporarily suppress console.log during dotenv.config().
const _origLog = console.log;
console.log = () => {};
const envResult = dotenv.config({ path: envPath });
console.log = _origLog;
if (envResult.error) {
    console.error(`[MCP-WRAPPER] ⚠️  Warning: Could not load .env from ${envPath}`);
    console.error(`[MCP-WRAPPER] Error: ${envResult.error.message}`);
} else {
    // FIX: Use stderr, NOT stdout — MCP stdio protocol requires only JSON-RPC on stdout
    console.error(`[MCP-WRAPPER] ✅ Loaded .env from ${envPath}`);
}

// Chemin vers le serveur MCP réel
const serverPath = path.join(__dirname, 'build', 'index.js');

// Logger pour les messages de debug (vers stderr)
function logDebug(message) {
    if (process.env.ROO_DEBUG_LOGS) {
        console.error(`[MCP-WRAPPER] ${message}`);
    }
}

// Cache pour la réponse tools/list (anti-doublons VS Code)
let cachedToolsListResponse = null;

// Buffer pour accumuler les messages JSON incomplets
let buffer = '';

logDebug('Starting roo-state-manager MCP server v4.0 (pass-through + anti-duplicate)...');

// Capture the original cwd BEFORE overriding with __dirname.
// When launched by Claude Code or VS Code, cwd is the workspace folder.
// The server needs this to correctly identify which workspace it serves
// (critical for RooSync cross-workspace message routing).
const originalCwd = process.cwd();

// #883: Log workspace detection for diagnostics
console.error(`[MCP-WRAPPER] 🔍 Workspace detection:`);
console.error(`[MCP-WRAPPER]   process.cwd() (originalCwd): ${originalCwd}`);
console.error(`[MCP-WRAPPER]   process.env.WORKSPACE_PATH:  ${process.env.WORKSPACE_PATH || '(not set)'}`);
console.error(`[MCP-WRAPPER]   __dirname:                   ${__dirname}`);
console.error(`[MCP-WRAPPER]   → WORKSPACE_PATH passed to server: ${process.env.WORKSPACE_PATH || originalCwd}`);

// Spawn le serveur avec stdout et stderr redirigés pour filtrage
const server = spawn('node', [serverPath], {
    cwd: __dirname,
    env: {
        ...process.env,
        // Pass workspace path from the original cwd (set by VS Code/Claude Code)
        // unless already explicitly set via config
        WORKSPACE_PATH: process.env.WORKSPACE_PATH || originalCwd,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
});

// Rediriger stderr du serveur vers notre stderr (filtre les logs trop verbeux)
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

// Fonction pour cacher la réponse tools/list (anti-doublons, sans filtrage)
function cacheToolsList(message) {
    try {
        const parsed = JSON.parse(message);

        // Si c'est une réponse "tools/list"
        if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {

            // Si on a déjà un cache, renvoyer le cache avec le bon ID
            if (cachedToolsListResponse) {
                logDebug('Using cached tools/list (preventing duplicates)');
                const cachedResponse = JSON.parse(cachedToolsListResponse);
                if (parsed.id !== undefined) {
                    cachedResponse.id = parsed.id;
                }
                return JSON.stringify(cachedResponse);
            }

            // Premier appel: vérifier unicité et cacher
            const toolCount = parsed.result.tools.length;
            logDebug(`Tools/list: ${toolCount} tools`);

            // Vérifier l'unicité des noms d'outils
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

            logDebug(`Tool names: ${parsed.result.tools.map(t => t.name).join(', ')}`);

            // Mettre en cache
            cachedToolsListResponse = JSON.stringify(parsed);
            logDebug('Tools/list response cached');

            return cachedToolsListResponse;
        }

        // Sinon, retourner le message tel quel
        return message;
    } catch (error) {
        // Si ce n'est pas du JSON valide, retourner tel quel
        return message;
    }
}

// Traiter stdout : cache anti-doublons + suppression logs non-JSON
server.stdout.on('data', (data) => {
    const output = data.toString();

    // Ajouter au buffer
    buffer += output;

    // Traiter chaque ligne complète
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('{')) {
            // Only forward genuine JSON-RPC messages. Some services (e.g. BaselineService)
            // historically wrote JSON.stringify(logEntry) to stdout — those look like JSON
            // but aren't JSON-RPC, and they break clients like mcp-proxy/pydantic.
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                process.stderr.write('[MCP-WRAPPER] dropped non-JSON line: ' + trimmed.slice(0, 120) + '\n');
                return;
            }
            if (parsed && parsed.jsonrpc === '2.0') {
                const processed = cacheToolsList(trimmed);
                process.stdout.write(processed + '\n');
            } else {
                // Valid JSON but not JSON-RPC — route to stderr so it's still visible in logs.
                process.stderr.write('[MCP-WRAPPER] dropped non-JSONRPC JSON: ' + trimmed.slice(0, 120) + '\n');
            }
        } else if (trimmed.includes('Roo State Manager Server started')) {
            // FIX: Redirect to stderr, NOT stdout - MCP stdio protocol requires
            // only JSON-RPC messages on stdout. Non-JSON text breaks the handshake.
            process.stderr.write('[MCP-WRAPPER] ' + line + '\n');
        }
        // Sinon, c'est un log de debug, on le supprime silencieusement
    });
});

server.on('error', (error) => {
    logDebug(`Failed to start server: ${error.message}`);
    process.exit(1);
});

server.on('exit', (code) => {
    logDebug(`Server exited with code ${code}`);
    process.exit(code || 0);
});

// #1188: Kill child server process when parent exits (SIGTERM, SIGINT, or uncaught exception)
// Prevents zombie/orphan processes that linger after VS Code or Claude Code closes.
function gracefulShutdown(signal) {
    logDebug(`Received ${signal}, killing server process...`);
    try {
        server.kill('SIGTERM');
        // Give it 3 seconds, then force kill
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
    // Synchronous cleanup on any exit
    try { server.kill(); } catch {}
});
