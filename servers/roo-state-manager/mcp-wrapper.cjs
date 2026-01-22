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
 * Outils autorisés (16):
 * - Messagerie (6): send_message, read_inbox, reply_message, get_message, mark_message_read, archive_message
 * - Lecture seule (5): get_status, get_machine_inventory, list_diffs, compare_config, get_decision_details
 * - E2E complet (3): collect_config, publish_config, apply_config
 * - Infrastructure (2): init, get_active_config
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
const ALLOWED_TOOLS = new Set([
    // Messagerie (6 outils)
    'roosync_send_message',
    'roosync_read_inbox',
    'roosync_reply_message',
    'roosync_get_message',
    'roosync_mark_message_read',
    'roosync_archive_message',
    // Lecture seule (5 outils)
    'roosync_get_status',
    'roosync_get_machine_inventory',
    'roosync_list_diffs',
    'roosync_compare_config',
    'roosync_get_decision_details',
    // Actions critiques pour E2E (3 outils)
    'roosync_collect_config',
    'roosync_publish_config',
    'roosync_apply_config',
    // Infrastructure (2 outils) - v3.0.0
    'roosync_init',              // Enregistrer machine et MAJ dashboard
    'roosync_get_active_config'  // Obtenir la config active
]);

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
