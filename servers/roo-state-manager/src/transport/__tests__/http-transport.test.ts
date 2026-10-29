/**
 * Tests du transport HTTP du daemon RSM — #4149 F2, phase 0.
 *
 * Couvre les garde-fous de la revue ai-01 (29/10) :
 * 1. bind loopback only + clé bearer obligatoire (fail-closed au démarrage) ;
 * 2. 401 sans bearer / avec un bearer faux ;
 * 3. identité trustée (`ROOSYNC_TRUSTED_CALLER_IDS`) → 403 si non trustée ;
 * 4. écriture sans identité sur HTTP → refus bruyant (amendement 3) ;
 * 5. lecture sans identité → autorisée (résolution locale) ;
 * 6. DEUX identités entrelacées → chacune voit la sienne (AsyncLocalStorage,
 *    amendement 2 : identité par requête, jamais par process).
 *
 * Revue ai-01 du 29/10 (bloquant 1) — **default-deny** : l'ancienne table
 * listait les actions d'écriture et laissait passer tout le reste. Ces
 * tests rejouent les TROIS trous nommés (roosync_harmonization,
 * roosync_indexing, roosync_manage bulk_ et cleanup), plus l'outil inconnu et
 * l'action inconnue, et vérifient que la requête refusée **n'est jamais
 * dispatchée** (handler témoin, aucune écriture partagée).
 *
 * Revue ai-01 du 29/10 (bloquant 2) puis ms#1578 (défaut 3) — **identité
 * canonique** : les graphies acceptées d'un même workspace doivent produire
 * la MÊME destination (clé de dashboard / identité `from`), et rester isolées
 * en concurrence. La sémantique de référence est celle de la DESTINATION du
 * dépôt : `buildDashboardKey` préserve la casse (`workspace-CoursIA`), une
 * entrée lane de ROOSYNC_TRUSTED_CALLER_IDS en est la graphie enregistrée.
 *
 * Revue ms#1578 (défauts 1 et 2) : `roosync_claim` n'est plus pure-read
 * (claim/release/extend écrivent active-claims.json) et
 * `roosync_messages(action:"message", mark_as_read:true)` mute l'état du
 * message — les deux passent par la porte d'identité.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpTransport, type HttpTransportHandle } from '../http-transport.js';
import { getLocalMachineId, getLocalWorkspaceId } from '../../utils/message-helpers.js';
import { buildDashboardKey } from '../../tools/roosync/dashboard.js';

const API_KEY = 'test-key-4149';
const MCP_PATH = '/mcp';

let handle: HttpTransportHandle;
let baseUrl: string;
const savedTrusted = process.env.ROOSYNC_TRUSTED_CALLER_IDS;

/** Appels effectivement dispatchés au handler témoin (aucune écriture partagée). */
interface DispatchRecord {
    name: string;
    args: Record<string, unknown>;
}
let dispatched: DispatchRecord[] = [];

/**
 * Serveur MCP de test : handler TÉMOIN qui AWAIT une frontière (setTimeout)
 * AVANT de lire l'identité — c'est ce qui force l'entrelacement de deux
 * requêtes dans la fenêtre où une variable de module aurait fuité d'un
 * client vers l'autre. Il ENREGISTRE aussi chaque appel reçu : un refus
 * doit signifier « jamais dispatché », pas seulement « erreur renvoyée ».
 */
function buildServer(): Server {
    const server = new Server(
        { name: 'rsm-http-transport-test', version: '0.0.0' },
        { capabilities: { tools: {} } }
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = String(request.params?.name ?? '');
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        dispatched.push({ name, args });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify({
                        machineId: getLocalMachineId(),
                        workspaceId: getLocalWorkspaceId(),
                        fullId: `${getLocalMachineId()}:${getLocalWorkspaceId()}`,
                    }),
                },
            ],
        };
    });
    return server;
}

async function post(
    body: unknown,
    options: { key?: string | null; as?: string | null } = {}
): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (options.key !== null) headers.authorization = `Bearer ${options.key ?? API_KEY}`;
    if (options.as !== null && options.as !== undefined) headers['x-roosync-as'] = options.as;
    const response = await fetch(`${baseUrl}${MCP_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = undefined;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, json, text };
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rsm-http-transport-test', version: '0.0.0' },
    },
};

function toolCall(name: string, args: Record<string, unknown> = {}, id = 2): unknown {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

/** Payload d'identité rendu par le handler témoin. */
function identityOf(res: { json: any }): { machineId: string; workspaceId: string; fullId: string } {
    return JSON.parse(res.json.result.content[0].text);
}

describe('#4149 F2 — transport HTTP du daemon RSM', () => {
    beforeAll(async () => {
        // myia-web3 n'a qu'une entrée LANE ("myia-web3:CoursIA") : c'est ce
        // qui permet de tester l'épinglage de la graphie ENREGISTRÉE — une
        // entrée machine matcherait toujours en premier et masquerait le
        // comportement lane (ms#1578, défaut 3).
        process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-web2,myia-po-2024,myia-web3:CoursIA';
        handle = await startHttpTransport({
            server: buildServer(),
            port: 0, // port libre
            apiKey: API_KEY,
            path: MCP_PATH,
        });
        baseUrl = `http://127.0.0.1:${handle.port}`;
    });

    afterAll(async () => {
        await handle?.close();
        if (savedTrusted === undefined) delete process.env.ROOSYNC_TRUSTED_CALLER_IDS;
        else process.env.ROOSYNC_TRUSTED_CALLER_IDS = savedTrusted;
    });

    beforeEach(() => {
        dispatched = [];
    });

    describe('démarrage fail-closed', () => {
        it('refuse de démarrer sans clé bearer', async () => {
            await expect(
                startHttpTransport({ server: buildServer(), port: 0, apiKey: '' })
            ).rejects.toThrow(/ROOSYNC_HTTP_API_KEY/);
        });

        it('refuse un bind non-loopback', async () => {
            await expect(
                startHttpTransport({ server: buildServer(), port: 0, apiKey: API_KEY, bindHost: '0.0.0.0' })
            ).rejects.toThrow(/loopback/);
        });
    });

    describe('authentification bearer', () => {
        it('401 sans en-tête Authorization', async () => {
            const res = await post(INITIALIZE, { key: null });
            expect(res.status).toBe(401);
            expect(res.json?.error).toBe('unauthorized');
        });

        it('401 avec une clé fausse', async () => {
            const res = await post(INITIALIZE, { key: 'mauvaise-cle' });
            expect(res.status).toBe(401);
            expect(res.json?.error).toBe('unauthorized');
        });

        it('200 sur initialize authentifié', async () => {
            const res = await post(INITIALIZE);
            expect(res.status).toBe(200);
            expect(res.json?.result?.serverInfo?.name).toBe('rsm-http-transport-test');
        });
    });

    describe('identité de requête', () => {
        it('refuse une écriture sans identité (amendement 3)', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }), { as: null });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(res.text).toContain('Écriture refusée');
            expect(dispatched).toHaveLength(0);
        });

        it('refuse une identité non trustée (ROOSYNC_TRUSTED_CALLER_IDS)', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }), { as: 'myia-inconnue:roo-extensions' });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_refused');
            expect(dispatched).toHaveLength(0);
        });

        it('laisse passer une écriture avec une identité trustée', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }), { as: 'myia-web2:roo-extensions' });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
            expect(dispatched[0].name).toBe('roosync_dashboard');
        });

        it('une lecture sans identité reste autorisée (résolution locale)', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: null });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
            const payload = identityOf(res);
            expect(payload.machineId).toBe(getLocalMachineId());
            expect(payload.workspaceId).toBe(getLocalWorkspaceId());
        });

        it('l’identité assertée remplace l’identité du process', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: 'myia-web2:roo-extensions' });
            expect(res.status).toBe(200);
            const payload = identityOf(res);
            expect(payload.machineId).toBe('myia-web2');
            expect(payload.workspaceId).toBe('roo-extensions');
        });

        it('deux identités entrelacées voit chacune la sienne (AsyncLocalStorage)', async () => {
            const [first, second] = await Promise.all([
                post(toolCall('roosync_inventory', { type: 'status' }, 11), { as: 'myia-web2:roo-extensions' }),
                post(toolCall('roosync_inventory', { type: 'status' }, 12), { as: 'myia-po-2024:coursia' }),
            ]);
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            const firstPayload = identityOf(first);
            const secondPayload = identityOf(second);
            expect(firstPayload.machineId).toBe('myia-web2');
            expect(firstPayload.workspaceId).toBe('roo-extensions');
            expect(secondPayload.machineId).toBe('myia-po-2024');
            expect(secondPayload.workspaceId).toBe('coursia');
        });
    });

    // ------------------------------------------------------------------ *
    // Bloquant 1 de la revue ai-01 (29/10) : default-deny.
    // ------------------------------------------------------------------ *
    describe('default-deny — rien ne passe sans identité sauf lecture listée', () => {
        const unclassifiedWrites: Array<[string, string, Record<string, unknown>]> = [
            ['roosync_harmonization', 'create', { campaign_id: 'hc-test-1' }],
            ['roosync_harmonization', 'dispatch', { campaign_id: 'hc-test-1' }],
            ['roosync_indexing', 'index', {}],
            ['roosync_indexing', 'rebuild', {}],
            ['roosync_indexing', 'repair_gaps', {}],
            ['roosync_manage', 'bulk_mark_read', { from: 'myia-po-2024' }],
            ['roosync_manage', 'bulk_archive', { from: 'myia-po-2024' }],
            ['roosync_manage', 'cleanup', { before_date: '2026-01-01T00:00:00Z' }],
        ];

        for (const [tool, action, args] of unclassifiedWrites) {
            it(`refuse ${tool}(action=${action}) sans identité et ne le dispatche pas`, async () => {
                const res = await post(toolCall(tool, { action, ...args }), { as: null });
                expect(res.status).toBe(403);
                expect(res.json?.error).toBe('identity_required');
                expect(dispatched).toHaveLength(0);
            });
        }

        it('refuse un outil INCONNU sans identité (pas d\'autorité d\'écriture acquise)', async () => {
            const res = await post(toolCall('roosync_outil_qui_nexiste_pas', { action: 'write' }), { as: null });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('refuse une action INCONNUE d\'un outil connu sans identité', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'wipe', type: 'workspace' }), { as: null });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('refuse une LECTURE qui porte un flag mutateur (resetCache)', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status', resetCache: true }), { as: null });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        // -------------------------------------------------------------- *
        // ms#1578, défaut 1 : roosync_claim n'est plus pure-read.
        // claim/release/extend écrivent active-claims.json — le verrou
        // d'issue est une écriture partagée, elle exige une identité.
        // -------------------------------------------------------------- *
        for (const action of ['claim', 'release', 'extend'] as const) {
            it(`refuse roosync_claim(action=${action}) sans identité et ne le dispatche pas`, async () => {
                const res = await post(toolCall('roosync_claim', { action, issue: 4149 }), { as: null });
                expect(res.status).toBe(403);
                expect(res.json?.error).toBe('identity_required');
                expect(dispatched).toHaveLength(0);
            });
        }

        it('roosync_claim(list) et roosync_claim(check) restent des lectures sans identité', async () => {
            const list = await post(toolCall('roosync_claim', { action: 'list' }), { as: null });
            expect(list.status).toBe(200);
            const check = await post(toolCall('roosync_claim', { action: 'check', issue: 4149 }), { as: null });
            expect(check.status).toBe(200);
            expect(dispatched).toHaveLength(2);
            expect(dispatched.map((d) => d.args.action)).toEqual(['list', 'check']);
        });

        it('une identité trustée suffit pour roosync_claim(action=claim)', async () => {
            const res = await post(toolCall('roosync_claim', { action: 'claim', issue: 4149 }), { as: 'myia-web2:roo-extensions' });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
            expect(dispatched[0].name).toBe('roosync_claim');
        });

        // -------------------------------------------------------------- *
        // ms#1578, défaut 2 : mark_as_read:true mute l'état du message.
        // `roosync_messages(action:"message")` est une lecture, mais le
        // flag en fait une écriture — idem sur le legacy roosync_read.
        // -------------------------------------------------------------- *
        it('refuse roosync_messages(action=message, mark_as_read=true) sans identité', async () => {
            const res = await post(
                toolCall('roosync_messages', { action: 'message', message_id: 'm-1', mark_as_read: true }),
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('refuse la graphie camelCase markAsRead=true et le legacy roosync_read', async () => {
            const camel = await post(
                toolCall('roosync_messages', { action: 'message', message_id: 'm-1', markAsRead: true }),
                { as: null }
            );
            expect(camel.status).toBe(403);
            expect(camel.json?.error).toBe('identity_required');
            const legacy = await post(
                toolCall('roosync_read', { mode: 'message', message_id: 'm-1', mark_as_read: true }),
                { as: null }
            );
            expect(legacy.status).toBe(403);
            expect(legacy.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('roosync_messages(action=message) sans mark_as_read reste une lecture sans identité', async () => {
            const absent = await post(toolCall('roosync_messages', { action: 'message', message_id: 'm-1' }), { as: null });
            expect(absent.status).toBe(200);
            const inactive = await post(
                toolCall('roosync_messages', { action: 'message', message_id: 'm-1', mark_as_read: false }),
                { as: null }
            );
            expect(inactive.status).toBe(200);
            expect(dispatched).toHaveLength(2);
        });

        it('une identité trustée suffit pour mark_as_read=true (le garde est la porte, pas l\'outil)', async () => {
            const res = await post(
                toolCall('roosync_messages', { action: 'message', message_id: 'm-1', mark_as_read: true }),
                { as: 'myia-web2:roo-extensions' }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('laisse passer une lecture supportée sans identité', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: null });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('laisse passer une lecture supportée avec un flag mutateur explicitement faux', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status', resetCache: false }), { as: null });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('une identité trustée suffit pour une action d\'écriture (le garde est la porte, pas l\'outil)', async () => {
            const res = await post(
                toolCall('roosync_manage', { action: 'bulk_mark_read', from: 'myia-po-2024' }),
                { as: 'myia-web2:roo-extensions' }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });
    });

    // ------------------------------------------------------------------ *
    // Bloquant 2 de la revue ai-01 (29/10), précisé par ms#1578 (défaut 3) :
    // identité canonique. La sémantique de référence est la DESTINATION du
    // dépôt — buildDashboardKey préserve la casse (workspace-CoursIA) — et
    // non plus une forme lowercasée.
    // ------------------------------------------------------------------ *
    describe('identité canonique — même destination quelle que soit la graphie', () => {
        it('une entrée LANE épingle la graphie ENREGISTRÉE, même assertée en minuscules', async () => {
            // Env de confiance : "myia-web3:CoursIA" (graphie enregistrée).
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: 'myia-web3:coursia' });
            expect(res.status).toBe(200);
            const payload = identityOf(res);
            expect(payload.workspaceId).toBe('CoursIA');
            expect(payload.fullId).toBe('myia-web3:CoursIA');
        });

        it('une entrée LANE épingle la graphie enregistrée aussi en forme chemin', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: 'myia-web3:c:\\dev\\coursia' });
            expect(res.status).toBe(200);
            expect(identityOf(res).workspaceId).toBe('CoursIA');
        });

        it('les trois graphies produisent la MÊME destination RÉELLE (buildDashboardKey du dépôt)', async () => {
            const spellings = [
                'myia-web3:CoursIA',
                'myia-web3:coursia',
                'myia-web3:c:\\dev\\coursia',
            ];
            const keys: string[] = [];
            for (const as of spellings) {
                const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as });
                expect(res.status).toBe(200);
                const payload = identityOf(res);
                expect(payload.fullId).toBe('myia-web3:CoursIA');
                // Destination calculée par la VRAIE fonction du dépôt — pas
                // une copie du présumé : c'est elle qui décide où l'identité
                // atterrit (l'ancien lowercasing installait `coursia` et la
                // fourquait vers workspace-coursia, une clé fantôme).
                keys.push(buildDashboardKey('workspace', payload.machineId, payload.workspaceId));
            }
            expect(keys).toEqual(['workspace-CoursIA', 'workspace-CoursIA', 'workspace-CoursIA']);
        });

        it('une entrée MACHINE installe le basename de l\'assertion, casse préservée', async () => {
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: 'myia-web2:C:\\dev\\roo-extensions' });
            expect(res.status).toBe(200);
            const payload = identityOf(res);
            expect(payload.workspaceId).toBe('roo-extensions');
            expect(buildDashboardKey('workspace', payload.machineId, payload.workspaceId)).toBe('workspace-roo-extensions');
        });

        it('entrée MACHINE : la casse assertée est installée telle quelle — l\'épinglage est le rôle de l\'entrée lane', async () => {
            // myia-po-2024 est une entrée MACHINE (toute lane de la machine
            // passe) : sans entrée lane, la graphie assertée fait foi. C'est
            // le levier opérateur documenté — pour une destination à casse
            // significative, enregistrer l'entrée lane "machine:CoursIA",
            // qui épingle la graphie pour toutes les assertions.
            const res = await post(toolCall('roosync_inventory', { type: 'status' }), { as: 'myia-po-2024:COURSIA' });
            expect(res.status).toBe(200);
            expect(identityOf(res).workspaceId).toBe('COURSIA');
        });

        it('deux identités canoniques concurrentes restent isolées', async () => {
            const [first, second] = await Promise.all([
                post(toolCall('roosync_inventory', { type: 'status' }, 21), { as: 'myia-web2:ROO-EXTENSIONS' }),
                post(toolCall('roosync_inventory', { type: 'status' }, 22), { as: 'myia-web3:coursia' }),
            ]);
            // myia-web2 = entrée machine : basename de l'assertion, casse
            // préservée. myia-web3 = entrée lane : graphie enregistrée.
            expect(identityOf(first).fullId).toBe('myia-web2:ROO-EXTENSIONS');
            expect(identityOf(second).fullId).toBe('myia-web3:CoursIA');
        });
    });

    // ------------------------------------------------------------------ *
    // Suivi de la revue : contrat d'arrêt (close/rebind), pas de
    // closeAllConnections sur spéculation.
    // ------------------------------------------------------------------ *
    describe('cycle de vie — close puis rebind', () => {
        it('ferme le listener ET le transport, puis permet un rebind sur le même port', async () => {
            const first = await startHttpTransport({
                server: buildServer(),
                port: 0,
                apiKey: API_KEY,
                path: MCP_PATH,
            });
            const port = first.port;
            const firstUrl = `http://127.0.0.1:${port}`;
            const init = await fetch(`${firstUrl}${MCP_PATH}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    authorization: `Bearer ${API_KEY}`,
                },
                body: JSON.stringify(INITIALIZE),
            });
            expect(init.status).toBe(200);

            await first.close();

            // Le port est libéré : un nouveau daemon peut s'y installer.
            const second = await startHttpTransport({
                server: buildServer(),
                port,
                apiKey: API_KEY,
                path: MCP_PATH,
            });
            try {
                expect(second.port).toBe(port);
                const res = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream',
                        authorization: `Bearer ${API_KEY}`,
                    },
                    body: JSON.stringify(INITIALIZE),
                });
                expect(res.status).toBe(200);
            } finally {
                await second.close();
            }
        });
    });
});
