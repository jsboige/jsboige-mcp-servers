#!/usr/bin/env node
/**
 * MCP Wrapper v4.0.0 - Pass-through + Déduplication anti-doublons VS Code
 *
 * CHANGEMENT v4: Plus de filtrage d'outils. Tous les outils de roo-state-manager
 * sont exposés à Claude Code (39 outils au lieu de 18).
 *
 * Raisons du changement:
 * - Claude Code a besoin des outils task_browse, view_task_details,
 *   view_conversation_tree, get_raw_conversation pour analyser les runs
 *   du scheduler Roo sans lire manuellement les fichiers JSON.
 * - roosync_search et export_data sont utiles pour la coordination.
 * - 39 outils est raisonnable pour Claude (pas de threshold comme Roo à 60).
 *
 * Fonctions conservées:
 * - Déduplication cache (VS Code appelle tools/list plusieurs fois)
 * - Suppression des logs stderr bruyants
 */

const { spawn } = require('child_process');
const path = require('path');

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

// Spawn le serveur avec stdout et stderr redirigés pour filtrage
const server = spawn('node', [serverPath], {
    cwd: __dirname,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
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
            // Message MCP JSON-RPC - cacher tools/list pour éviter doublons
            const processed = cacheToolsList(trimmed);
            process.stdout.write(processed + '\n');
        } else if (trimmed.includes('Roo State Manager Server started')) {
            // Laisser passer le message de démarrage
            process.stdout.write(line + '\n');
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
