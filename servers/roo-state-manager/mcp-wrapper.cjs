#!/usr/bin/env node
/**
 * MCP Wrapper v2.6.0 - Filtre les outils RooSync pour Claude Code
 *
 * Outils autorisés (15):
 * - Messagerie (6): send_message, read_inbox, reply_message, get_message, mark_message_read, archive_message
 * - Lecture seule (5): get_status, get_machine_inventory, list_diffs, compare_config, get_decision_details
 * - E2E complet (3): collect_config, publish_config, apply_config
 * - Infrastructure (1): init (enregistrement machine et MAJ dashboard)
 *
 * Exclus (overengineering):
 * - Heartbeat (6 outils)
 * - Sync-on-offline/on-online (2 outils)
 * - Decision management (approve/reject/apply/rollback)
 * - Baseline management (update, manage, export) - sauf init
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

// Liste des outils RooSync autorisés pour Claude Code (coordination)
// - Messagerie : communication inter-machine
// - Lecture seule : monitoring et diagnostic
// - Actions critiques : collect/publish/apply config pour E2E complet
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
    // Actions critiques pour E2E (3 outils) - v2.5.0
    'roosync_collect_config',
    'roosync_publish_config',   // AJOUT: Publier sa config pour les autres
    'roosync_apply_config',
    // Infrastructure (1 outil) - v2.6.0
    'roosync_init'              // AJOUT: Enregistrer machine et MAJ dashboard
]);

// Buffer pour accumuler les messages JSON incomplets
let buffer = '';
let initialized = false; // Pour savoir si le handshake MCP est fait

logDebug('Starting roo-state-manager MCP server (RooSync messaging tools only)...');
logDebug(`Allowed tools: ${Array.from(ALLOWED_TOOLS).join(', ')}`);

// Spawn le serveur avec stdout et stderr redirigés pour filtrage
const server = spawn('node', [serverPath], {
    cwd: __dirname,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'] // stdin=inherit, stdout=pipe, stderr=pipe
});

// Rediriger stderr du serveur vers notre stderr (filtre les logs trop verbeux)
server.stderr.on('data', (data) => {
    const output = data.toString();

    // Filtrer les logs trop verbeux qui peuvent polluer la sortie
    const suppressPatterns = [
        '[SKIP]',           // Les messages de skip d'indexation
        ' injecting env ',  // Messages de dotenv
        '✅ Toutes les variables',  // Message de succès dotenv
        '🔧 [DEBUG]',       // Debug messages
        '⚙️ [NotificationService]',  // Notification service init
        '🔧 [ToolUsageInterceptor]', // Tool interceptor init
        'Loading existing skeletons',  // Loading skeletons
        /Found \d+ skeleton files/,   // Found skeletons
        /Loaded \d+ skeletons/,       // Loaded skeletons
        '🚀 Initialisation des services background',  // Background services init
        '🔍 Initialisation du service d\'indexation',  // Indexing init
        'Qdrant client initialized',   // Qdrant init
        '🖥️  Machine actuelle:',  // Machine info
        'NODE_TLS_REJECT_UNAUTHORIZED',  // Node warning
        /\(node:\d+\) Warning:/  // Node warnings
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

// Fonction pour filtrer les outils dans un message MCP
function filterTools(message) {
    try {
        const parsed = JSON.parse(message);

        // Si c'est une réponse "tools/list", filtrer la liste des outils
        if (
            parsed.result &&
            parsed.result.tools &&
            Array.isArray(parsed.result.tools)
        ) {
            const originalCount = parsed.result.tools.length;
            parsed.result.tools = parsed.result.tools.filter(tool =>
                ALLOWED_TOOLS.has(tool.name)
            );
            const filteredCount = parsed.result.tools.length;

            logDebug(`Filtered tools: ${originalCount} -> ${filteredCount}`);

            if (filteredCount === 0) {
                logDebug('WARNING: No tools remaining after filtering!');
            }

            return JSON.stringify(parsed);
        }

        // Sinon, retourner le message tel quel
        return message;
    } catch (error) {
        // Si ce n'est pas du JSON valide, retourner tel quel
        return message;
    }
}

// Filtrer stdout pour ne laisser passer QUE les messages MCP (JSON-RPC)
// et filtrer la liste des outils
server.stdout.on('data', (data) => {
    const output = data.toString();

    // Avant l'initialisation, laisser passer tout stdout (logs de démarrage)
    if (!initialized) {
        process.stdout.write(output);
        // Vérifier si on a reçu une réponse initialize ou tools/list
        if (output.includes('"method":"initialize"') ||
            output.includes('"result":{') ||
            output.includes('"serverInfo"')) {
            initialized = true;
            logDebug('MCP initialized, enabling filtering');
        }
        return;
    }

    // Après l'initialisation, filtrer
    // Ajouter au buffer
    buffer += output;

    // Traiter chaque ligne complète
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Garder le dernier élément (potentiellement incomplet)

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('{')) {
            // C'est un message MCP JSON-RPC
            // Filtrer la liste des outils si nécessaire
            const filtered = filterTools(trimmed);
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
