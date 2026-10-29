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
import { resolveCallerIdentity } from '../utils/message-helpers.js';
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

/**
 * Actions d'écriture refusées sans identité assertée.
 *
 * La liste est explicite (amendement 3 d'ai-01) : append, send, reply, amend,
 * claim, mark_read — plus les actions de gestion qui écrivent (archive,
 * bulk_*, cleanup, delete, merge, scrub).
 */
const DASHBOARD_WRITE_ACTIONS = new Set(['write', 'append', 'update', 'delete', 'merge', 'scrub']);
const MESSAGES_WRITE_ACTIONS = new Set([
    'send', 'reply', 'amend',
    'mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup',
    'attachments_delete',
]);
const MANAGE_WRITE_ACTIONS = new Set(['mark_read', 'archive']);

/**
 * La requête appelle-t-elle une écriture ?
 *
 * Le transport connaît les noms d'outils et leurs actions : c'est le seul point
 * où l'on peut refuser AVANT le dispatch, sans laisser un chemin d'écriture
 * contournable (six outils write distincts, plusieurs actions).
 */
export function isWriteCall(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const rpc = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (rpc.method !== 'tools/call') return false;
    const name = rpc.params?.name;
    const action = String(rpc.params?.arguments?.action ?? '');
    switch (name) {
        case 'roosync_dashboard':
            return DASHBOARD_WRITE_ACTIONS.has(action);
        case 'roosync_messages':
            return MESSAGES_WRITE_ACTIONS.has(action);
        case 'roosync_manage':
            return MANAGE_WRITE_ACTIONS.has(action);
        case 'roosync_claim':
        case 'roosync_send':
            return true;
        default:
            return false;
    }
}

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
                    context.machineId = identity.machineId.toLowerCase();
                    context.workspaceId = identity.workspaceId;
                    context.fullId = identity.fullId;
                } catch (err) {
                    // Identité assertée mais non trustée → refus bruyant, JAMAIS un repli silencieux.
                    sendJsonError(res, 403, 'identity_refused', err instanceof Error ? err.message : String(err));
                    return;
                }
            }

            // --- Écriture sans identité (amendement 3) ------------------------
            if (!context.machineId && isWriteCall(parsed)) {
                sendJsonError(
                    res,
                    403,
                    'identity_required',
                    `Écriture refusée : la requête ne porte pas d'identité « ${CALLER_IDENTITY_HEADER} ». ` +
                    'Sur le transport HTTP (daemon multi-clients), la résolution locale (cwd/env du daemon) ' +
                    'désigne le DAEMON, pas le client : une écriture sans identité se stamped au mauvais nom. ' +
                    `Rejouez avec l'en-tête « ${CALLER_IDENTITY_HEADER}: machine:workspace » (identité trustée ` +
                    'via ROOSYNC_TRUSTED_CALLER_IDS). #4149 F2, amendement 3.'
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
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
