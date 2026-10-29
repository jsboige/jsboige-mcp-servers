/**
 * Transport HTTP (daemon) pour roo-state-manager — #4149 F2, phase 0.
 *
 * Objectif : un daemon unique sert plusieurs workspaces. Chaque client
 * porte son identité sur l'en-tête `x-roosync-as` ("machine" ou
 * "machine:workspace") ; le transport l'installe dans un AsyncLocalStorage
 * (voir `caller-context.ts`) AUTOUR de chaque requête, jamais dans une
 * variable de module.
 *
 * Garde-fous (revue ai-01 du 29/10, amendements 1-3) :
 * 1. **loopback only** — un bind non-local est refusé au démarrage ;
 * 2. **bearer key** — `Authorization: Bearer <clé>`, comparaison à temps
 *    constant ; sans clé configurée le transport refuse de démarrer ;
 * 3. **trust gate** — l'identité assertée passe par `resolveCallerIdentity`
 *    (même porte `ROOSYNC_TRUSTED_CALLER_IDS` que le paramètre `as`) ;
 * 4. **écriture sans identité refusée** — sur HTTP, une écriture dont la
 *    requête ne porte pas d'identité est refusée bruyamment : la résolution
 *    locale (cwd/env du daemon) ne vaut pour AUCUN client.
 *
 * Le transport stdio n'est PAS modifié : même comportement qu'avant.
 *
 * @module transport/http-transport
 * @version 1.0.0 - #4149 F2 phase 0
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveCallerIdentity, normalizeWorkspaceId } from '../utils/message-helpers.js';
import { runWithCallerContext, type CallerContext } from './caller-context.js';

/** Hôtes acceptés pour le bind — loopback strict (amendement ai-01). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0177.0.0.1']);

/** En-tête porteur de l'identité assertée par le client. */
export const CALLER_IDENTITY_HEADER = 'x-roosync-as';

/** Corps maximal accepté (garde anti-mémoire) — 4 Mio. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Ce que le transport doit savoir faire — McpServer du SDK (typage structurel
 * minimal : le transport ne dépend pas de la version du SDK pour ce point).
 */
export interface McpConnectable {
    connect(transport: StreamableHTTPServerTransport): Promise<void>;
}

export interface HttpTransportOptions {
    /** Serveur MCP à brancher sur le transport. */
    server: McpConnectable;
    /** Port d'écoute. */
    port: number;
    /** Hôte de bind — loopback obligatoire (défaut `127.0.0.1`). */
    bindHost?: string;
    /** Clé bearer attendue dans `Authorization: Bearer <clé>` — obligatoire. */
    apiKey: string;
    /** Chemin MCP (défaut `/mcp`). */
    path?: string;
    /** Corps maximal accepté en octets. */
    maxBodyBytes?: number;
}

export interface HttpTransportHandle {
    /** Port réellement écouté (utile quand `port` vaut 0 = port libre). */
    port: number;
    /** URL du point d'entrée MCP. */
    url: string;
    /** Arrêt propre du serveur HTTP. */
    close(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Classification lecture / écriture du gate HTTP — DEFAULT-DENY.
 *
 * Revue ai-01 du 29/10 (bloquant 1) : la version précédente listait les
 * *actions d'écriture* et laissait passer tout le reste. Deux trous
 * concrets : les outils ABSENTS de la table (roosync_harmonization,
 * roosync_indexing — qui ont des actions mutantes) passaient la porte,
 * et les actions non listées de roosync_manage (bulk_mark_read,
 * bulk_archive, cleanup) passaient aussi.
 *
 * Le défaut est donc INVERSÉ : on n'autorise SANS identité que ce qui est
 * explicitement une lecture. Tout le reste — écriture, outil inconnu,
 * action inconnue — exige une identité assertée et trustée. Un outil
 * ajouté demain est refusé par défaut, pas accepté par omission.
 *
 * La surface ci-dessous est la surface RÉELLE du registre
 * (`src/tools/registry.ts`, 47 outils) — vérifiée sur les switchs
 * d'actions de chaque outil. Le test de complétude
 * (`__tests__/http-transport.surface.test.ts`) échoue si un outil du
 * registre n'est pas classifié ici : aucune écriture ne peut rester
 * « non classifiée ».
 * ------------------------------------------------------------------ */

/**
 * Outils dont TOUTES les actions sont en lecture seule (pas de notion
 * d'action mutante). La surface a été relue outil par outil.
 */
const READ_ONLY_TOOLS = new Set([
    'storage_info',
    'task_export',
    'view_task_details',
    'codebase_search',
    'debug_analyze_conversation',
    'read_vscode_logs',
    'claudish_traffic',
    'get_mcp_best_practices',
    'diagnose_conversation_bom',
    'export_data',
    'get_raw_conversation',
    'analyze_roosync_problems',
    'roosync_get_status',
    'roosync_health_view',
    'roosync_compare_config',
    'roosync_list_diffs',
    'roosync_inventory',
    'roosync_read',
    'roosync_refresh_dashboard',
    'roosync_claim',
]);

/**
 * Outils MIXTES : seules les actions listées ici sont des lectures.
 * TOUTE autre action (y compris une action inconnue) est une écriture.
 */
const READ_ONLY_ACTIONS: Record<string, ReadonlySet<string>> = {
    roosync_search: new Set(['semantic', 'text', 'diagnose']),
    conversation_browser: new Set(['current', 'list', 'summarize', 'tree', 'view']),
    export_config: new Set(['get']),
    roosync_dashboard: new Set(['read', 'read_overview', 'list', 'read_archive', 'refresh']),
    roosync_messages: new Set(['inbox', 'message', 'stats', 'attachments_list', 'attachments_get']),
    roosync_manage: new Set(['stats']),
    roosync_attachments: new Set(['list', 'get']),
    roosync_storage_management: new Set(['storage']),
    roosync_harmonization: new Set(['status', 'list']),
    roosync_diagnose: new Set(['analyze', 'health', 'env', 'debug', 'test']),
    roosync_baseline: new Set(['list_versions', 'current_version', 'export']),
    roosync_config: new Set(['collect']),
    roosync_indexing: new Set(['status', 'diagnose', 'tool_usage_stats', 'trend_report']),
};

/**
 * Outils d'écriture pure — listés pour la complétude de surface (le test
 * de surface exige que TOOLUT outil du registre soit classifié).
 */
const WRITE_ONLY_TOOLS = new Set([
    'touch_mcp_settings',
    'maintenance',
    'manage_mcp_settings',
    'index_task_semantic',
    'reset_qdrant_collection',
    'rebuild_and_restart_mcp',
    'rebuild_task_index',
    'repair_conversation_bom',
    'roosync_init',
    'roosync_report_lifecycle',
    'roosync_send',
    'roosync_update_dashboard',
    'roosync_sync_event',
    'roosync_mcp_management',
]);

/**
 * Flags mutateurs : une lecture qui porte l'un d'eux EST une écriture.
 *
 * Exemple vérifié : `roosync_inventory` (lecture) accepte `resetCache`
 * qui vide le cache — sans identité, la requête ne doit pas l'atteindre.
 */
const MUTATING_ARG_FLAGS = new Set([
    'resetCache', 'reset_cache', 'clearCache',
    'rebuild', 'rebuildIndex', 'rebuild_index', 'repair', 'repair_bom',
    'apply', 'apply_profile', 'publish', 'publishTo',
    'write', 'scrub', 'delete', 'remove', 'cleanup', 'purge',
    'overwrite', 'migrate', 'restore', 'inject', 'set', 'update', 'create', 'save',
]);

/** Résultat de la classification d'un appel d'outil. */
export interface CallClassification {
    /** Nom de l'outil appelé (vide si ce n'est pas un tools/call). */
    tool: string;
    /** Action demandée (vide si l'appelant n'en fournit pas). */
    action: string;
    /** true = lecture pure, autorisée sans identité assertée. */
    readOnly: boolean;
}

function hasMutatingFlag(args: Record<string, unknown>): boolean {
    for (const key of Object.keys(args)) {
        if (MUTATING_ARG_FLAGS.has(key)) {
            const value = args[key];
            // Un flag explicitement faux n'est pas une mutation.
            if (value === false || value === undefined || value === null) continue;
            return true;
        }
    }
    return false;
}

/**
 * Classe un appel d'outil : lecture pure ou écriture.
 *
 * Règle unique : **une lecture doit être explicitement listée**. Tout le
 * reste est écriture (default-deny).
 */
export function classifyCall(body: unknown): CallClassification {
    if (!body || typeof body !== 'object') return { tool: '', action: '', readOnly: true };
    const rpc = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    // Ce n'est pas un appel d'outil (initialize, tools/list, notifications) :
    // rien à protéger ici — la porte d'identité ne s'applique qu'aux outils.
    if (rpc.method !== 'tools/call') return { tool: '', action: '', readOnly: true };

    const tool = String(rpc.params?.name ?? '');
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
    const action = typeof args.action === 'string' ? args.action : '';

    if (READ_ONLY_TOOLS.has(tool)) {
        // Outil sans notion d'action mutante : lecture, sauf flag mutateur.
        return { tool, action, readOnly: !hasMutatingFlag(args) };
    }
    const readActions = READ_ONLY_ACTIONS[tool];
    if (readActions) {
        // Action absente ou inconnue => écriture (default-deny).
        const readOnly = action !== '' && readActions.has(action) && !hasMutatingFlag(args);
        return { tool, action, readOnly };
    }
    // Outil d'écriture explicite, ou outil INCONNU : écriture dans les deux cas.
    return { tool, action, readOnly: false };
}

/**
 * Cette requête exige-t-elle une identité assertée ?
 *
 * Inverse de `classifyCall(...).readOnly` — le nom dit ce que la porte
 * fait : tout ce qui n'est pas une lecture explicitement listée passe par
 * la porte d'identité.
 */
export function requiresIdentity(body: unknown): boolean {
    return !classifyCall(body).readOnly;
}

/** Surface classified — exportée pour le test de complétude. */
export const CLASSIFIED_TOOLS = {
    readOnly: READ_ONLY_TOOLS,
    mixed: READ_ONLY_ACTIONS,
    writeOnly: WRITE_ONLY_TOOLS,
};

/** Comparaison à temps constant de deux chaînes de même longueur. */
function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/** Réponse JSON d'erreur (jamais de valeur de secret dans le corps). */
function sendJsonError(res: http.ServerResponse, status: number, code: string, message: string): void {
    const payload = JSON.stringify({ error: code, message });
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

/** Lit le corps de la requête, plafonné — au-delà, `413`. */
async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', (err) => reject(err));
    });
}

/**
 * Démarre le transport HTTP.
 *
 * @throws Error si la clé bearer est absente ou si le bind n'est pas loopback
 *         (échec fermé : un daemon sans clé n'écoute pas du tout).
 */
export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransportHandle> {
    const bindHost = options.bindHost ?? '127.0.0.1';
    const apiKey = options.apiKey ?? '';
    const mcpPath = options.path ?? '/mcp';
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    if (!apiKey.trim()) {
        throw new Error(
            'ROOSYNC_HTTP_API_KEY absent ou vide : le transport HTTP refuse de démarrer (fail-closed). ' +
            'Un daemon sans clé bearer écouterait en clair sur le loopback.'
        );
    }
    if (!LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
        throw new Error(
            `Bind HTTP refusé : « ${bindHost} » n'est pas un hôte loopback ` +
            `(${[...LOOPBACK_HOSTS].join(', ')}). #4149 F2 : transport loopback-only.`
        );
    }

    // Mode stateless : pas de session partagée entre les requêtes — chaque
    // requête est indépendante, et l'identité vient de l'en-tête, pas d'une
    // session (amendement 2 : identité PAR REQUÊTE).
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    await options.server.connect(transport);

    const server = http.createServer((req, res) => {
        void handleRequest(req, res);
    });

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
            if (url.pathname !== mcpPath) {
                sendJsonError(res, 404, 'not_found', `Chemin MCP attendu : ${mcpPath}`);
                return;
            }
            if (req.method !== 'POST') {
                // Mode stateless : pas de flux SSE, pas de session à supprimer.
                sendJsonError(res, 405, 'method_not_allowed', 'Seul POST est accepté (mode stateless).');
                return;
            }

            // --- Bearer -------------------------------------------------------
            const authHeader = String(req.headers.authorization ?? '');
            const expected = `Bearer ${apiKey}`;
            if (!safeEqual(authHeader, expected)) {
                res.writeHead(401, {
                    'www-authenticate': 'Bearer',
                    'content-type': 'application/json',
                });
                res.end(JSON.stringify({
                    error: 'unauthorized',
                    message: 'Clé bearer absente ou invalide (en-tête Authorization: Bearer <clé>).',
                }));
                return;
            }

            // --- Corps --------------------------------------------------------
            let raw: string;
            try {
                raw = (await readBody(req, maxBodyBytes)) ?? '';
            } catch {
                sendJsonError(res, 413, 'payload_too_large', 'Corps de requête trop volumineux.');
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                sendJsonError(res, 400, 'invalid_json', 'Corps JSON-RPC illisible.');
                return;
            }

            // --- Identité (amendement 1 + trust gate #3591) -------------------
            const asserted = req.headers[CALLER_IDENTITY_HEADER];
            const assertedValue = Array.isArray(asserted) ? asserted[0] : asserted;
            const context: CallerContext = { transport: 'http' };
            if (assertedValue?.trim()) {
                try {
                    const identity = resolveCallerIdentity(assertedValue.trim());
                    // Identité CANONIQUE (revue ai-01 du 29/10, bloquant 2) :
                    // `resolveCallerIdentity` compare la confiance sur une forme
                    // normalisée (machine en minuscule, workspace en basename
                    // normalisé) mais RETOURNE la forme brute. Installer la
                    // forme brute ici faisait diverger la clé de dashboard et
                    // l'identité `from` d'un simple changement de casse
                    // (`web2:ROO-EXTENSIONS` vs `web2:roo-extensions`) : deux
                    // clés pour un même workspace, donc deux writers.
                    // On installe donc la MÊME forme que celle sur laquelle
                    // la confiance a été décidée — la sémantique canonique du
                    // dépôt (`normalizeWorkspaceId`), pas un lowercase
                    // maison.
                    context.machineId = identity.machineId.toLowerCase();
                    context.workspaceId = identity.workspaceId
                        ? normalizeWorkspaceId(identity.workspaceId) || undefined
                        : undefined;
                    context.fullId = context.workspaceId
                        ? `${context.machineId}:${context.workspaceId}`
                        : context.machineId;
                } catch (err) {
                    // Identité assertée mais non trustée → refus bruyant, JAMAIS un repli silencieux.
                    sendJsonError(res, 403, 'identity_refused', err instanceof Error ? err.message : String(err));
                    return;
                }
            }

            // --- Écriture sans identité (amendement 3, default-deny) ---------
            if (!context.machineId && requiresIdentity(parsed)) {
                sendJsonError(
                    res,
                    403,
                    'identity_required',
                    `Écriture refusée : la requête ne porte pas d'identité « ${CALLER_IDENTITY_HEADER} ». ` +
                    'Sur le transport HTTP (daemon multi-clients), la résolution locale (cwd/env du daemon) ' +
                    'désigne le DAEMON, pas le client : une écriture sans identité se stamped au mauvais nom. ' +
                    `Rejouez avec l'en-tête « ${CALLER_IDENTITY_HEADER}: machine:workspace » (identité trustée ` +
                    'via ROOSYNC_TRUSTED_CALLER_IDS). #4149 F2, amendement 3. ' +
                    'La porte est en default-deny : tout appel qui n\'est pas une lecture explicitement ' +
                    'listée (outil inconnu, action inconnue, flag mutateur) exige une identité.'
                );
                return;
            }

            // --- Dispatch dans le contexte de la requête -----------------------
            await runWithCallerContext(context, () => transport.handleRequest(req, res, parsed));
        } catch (err) {
            if (!res.headersSent) {
                sendJsonError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
            } else {
                res.end();
            }
        }
    }

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, bindHost, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;

    return {
        port,
        url: `http://${bindHost}:${port}${mcpPath}`,
        close: async () => {
            // Le listener HTTP d'abord, puis le transport du SDK : le daemon
            // possède les DEUX ressources, et laisser le transport ouvert
            // garderait des handles (et le routeur de requêtes) après l'arrêt
            // — un rebind sur le même port ne serait alors pas propre.
            // Pas de closeAllConnections() : le contrat d'arrêt réellement
            // exercé est « fermer le listener puis le transport », pas une
            // supposition sur la gestion des connexions inactives (revue
            // ai-01 du 29/10).
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await transport.close();
        },
    };
}
