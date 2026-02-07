#!/usr/bin/env node
/**
 * MCP Wrapper v3.0.0 - Filtre RooSync + Déduplication anti-doublons VS Code
 *
 * PROBLÈME RÉSOLU :
 * - Claude Code VS Code appelle tools/list plusieurs fois (main + sub-agents)
 * - Cela crée des doublons d'outils → erreur "Tool names must be unique"
 *
 * SOLUTION :
 * - Cache la liste d'outils après le premier appel
 * - Renvoie TOUJOURS la même réponse filtrée
 * - Garantit unicité des noms d'outils
 *
 * Outils autorisés (18):
 * - Messagerie CONS-1 (3): roosync_send, roosync_read, roosync_manage
 * - Lecture seule (4): get_status, list_diffs, compare_config, refresh_dashboard
 * - Consolidés (5): config, inventory, baseline, machines, init
 * - Décisions CONS-5 (2): roosync_decision, roosync_decision_info
 * - Monitoring (1): heartbeat_status
 * - Diagnostic (2): analyze_roosync_problems, diagnose_env
 * - Summary (1): roosync_summarize (CONS-12 unifié)
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

// Liste des outils RooSync autorisés pour Claude Code
// MAJ 2026-02-07: 18 outils (CONS-5: decisions 5→2)
const ALLOWED_TOOLS = new Set([
    // Messagerie CONS-1 (3 outils) - remplace 6 legacy
    'roosync_send',              // CONS-1: send + reply + amend
    'roosync_read',              // CONS-1: read_inbox + get_message
    'roosync_manage',            // CONS-1: mark_message_read + archive_message
    // Lecture seule (4 outils)
    'roosync_get_status',
    'roosync_list_diffs',
    'roosync_compare_config',
    'roosync_refresh_dashboard',
    // Outils consolidés (5 outils) - CONS-2/3/4/6
    'roosync_config',            // CONS-3: collect + publish + apply config
    'roosync_inventory',         // CONS-6: machine inventory + heartbeat state
    'roosync_baseline',          // CONS-4: update + manage + export baseline
    'roosync_machines',          // CONS-6: offline + warning machines
    'roosync_init',              // Infrastructure
    // Décisions CONS-5 (2 outils) - remplace 5 legacy
    'roosync_decision',          // CONS-5: approve + reject + apply + rollback
    'roosync_decision_info',     // CONS-5: get_decision_details + list + history
    // Monitoring (1 outil) - CONS-2
    'roosync_heartbeat_status',  // Statut heartbeat des machines
    // Diagnostic (2 outils) - non-RooSync mais utiles pour coordination
    'analyze_roosync_problems',  // Diagnostic problèmes RooSync
    'diagnose_env',              // Diagnostic environnement (.env, paths)
    // Summary (1 outil) - CONS-12
    'roosync_summarize'          // Outil consolidé 3→1 (CONS-12)
]);
// Total: 18 outils (3+4+5+2+1+2+1 = 18)

// Cache pour la réponse tools/list filtrée (anti-doublons VS Code)
let cachedToolsListResponse = null;

// Buffer pour accumuler les messages JSON incomplets
let buffer = '';

logDebug('Starting roo-state-manager MCP server v3.0 (anti-duplicate)...');
logDebug(`Allowed tools (${ALLOWED_TOOLS.size}): ${Array.from(ALLOWED_TOOLS).join(', ')}`);

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

// Fonction pour filtrer et cacher la réponse tools/list
function filterAndCacheToolsList(message) {
    try {
        const parsed = JSON.parse(message);

        // Si c'est une réponse "tools/list"
        if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {

            // Si on a déjà un cache, renvoyer le cache avec un nouvel ID
            if (cachedToolsListResponse) {
                logDebug('Using cached tools/list (preventing duplicates)');
                const cachedResponse = JSON.parse(cachedToolsListResponse);
                // Garder l'ID de la requête originale
                if (parsed.id !== undefined) {
                    cachedResponse.id = parsed.id;
                }
                return JSON.stringify(cachedResponse);
            }

            // Sinon, filtrer et créer le cache
            const originalCount = parsed.result.tools.length;
            parsed.result.tools = parsed.result.tools.filter(tool =>
                ALLOWED_TOOLS.has(tool.name)
            );
            const filteredCount = parsed.result.tools.length;

            logDebug(`Filtered tools: ${originalCount} -> ${filteredCount}`);
            logDebug(`Tool names: ${parsed.result.tools.map(t => t.name).join(', ')}`);

            if (filteredCount === 0) {
                logDebug('WARNING: No tools remaining after filtering!');
            }

            // Vérifier l'unicité des noms d'outils
            const toolNames = parsed.result.tools.map(t => t.name);
            const uniqueNames = new Set(toolNames);
            if (toolNames.length !== uniqueNames.size) {
                logDebug('ERROR: Duplicate tool names detected after filtering!');
                logDebug(`Tools: ${toolNames.join(', ')}`);
            }

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

// Filtrer stdout : filtrage dès le début + cache anti-doublons
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
            // C'est un message MCP JSON-RPC
            // Filtrer et cacher les tools/list pour éviter les doublons
            const filtered = filterAndCacheToolsList(trimmed);
            process.stdout.write(filtered + '\n');
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
