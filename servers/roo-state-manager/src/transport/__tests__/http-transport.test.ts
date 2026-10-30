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
import { startHttpTransport, requiresIdentity, type HttpTransportHandle } from '../http-transport.js';
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
    // -------------------------------------------------------------- *
    // ms#1578, bloquant 1 : le corps TABLEAU (batch JSON-RPC).
    // Le SDK MCP accepte les tableaux et dispatche chaque élément ;
    // un tableau n'a pas de `.method`, il était donc classé « lecture »
    // et la porte d'identité était SAUTÉE (les écritures passaient à
    // l'identité du daemon).
    // -------------------------------------------------------------- *
    describe('batch JSON-RPC — default-deny (revue ms#1578, bloquant 1)', () => {
        it('classe un batch de lectures pures comme lecture (niveau classification)', () => {
            expect(
                requiresIdentity([
                    toolCall('roosync_get_status', {}, 2),
                    toolCall('roosync_claim', { action: 'list' }, 3),
                ])
            ).toBe(false);
        });

        it('classe un batch contenant une écriture comme ÉCRITURE (niveau classification)', () => {
            expect(
                requiresIdentity([
                    toolCall('roosync_get_status', {}, 2),
                    toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }, 3),
                ])
            ).toBe(true);
        });

        it('un batch de lectures pures passe sans identité et dispatche chaque élément', async () => {
            const res = await post(
                [toolCall('roosync_get_status', {}, 2), toolCall('roosync_claim', { action: 'list' }, 3)],
                { as: null }
            );
            expect(res.status).toBe(200);
            expect(dispatched.map((d) => d.name)).toEqual(['roosync_get_status', 'roosync_claim']);
        });

        it('un batch contenant une écriture est refusé 403 et ne dispatche RIEN', async () => {
            const res = await post(
                [toolCall('roosync_get_status', {}, 2), toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }, 3)],
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('un batch dont un élément est un outil inconnu est refusé 403 (zero dispatch)', async () => {
            const res = await post(
                [toolCall('roosync_outil_qui_nexiste_pas', { action: 'write' }, 2)],
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------- *
    // ms#1578, bloquant 2 : quatre « lectures » écrivent réellement.
    // Le default-deny porte sur le COMPORTEMENT, pas sur l'intitulé
    // de l'action (revue po-2028 du 30/10).
    // -------------------------------------------------------------- *
    describe('lectures qui écrivent réellement (revue ms#1578, bloquant 2)', () => {
        const writingReads: Array<[string, Record<string, unknown>]> = [
            // refresh-dashboard.ts : exécute un script PowerShell qui écrit
            // dans le store partagé (`outputDir` surchargeable par l'appelant).
            ['roosync_refresh_dashboard', { baseline: 'myia-ai-01' }],
            // dashboard.ts:6278 → handleRefresh → même script.
            ['roosync_dashboard', { action: 'refresh' }],
            // baseline.ts : writeFileSync(outputPath) au chemin de l'appelant.
            ['roosync_baseline', { action: 'export' }],
            // AttachmentManager.getAttachment : copie le fichier côté HÔTE
            // vers `targetPath`.
            ['roosync_attachments', { action: 'get', uuid: 'x', targetPath: 'C:/tmp/x' }],
        ];

        for (const [tool, args] of writingReads) {
            it(`refuse ${tool} sans identité et ne le dispatche pas`, async () => {
                const res = await post(toolCall(tool, args), { as: null });
                expect(res.status).toBe(403);
                expect(res.json?.error).toBe('identity_required');
                expect(dispatched).toHaveLength(0);
            });
        }

        it('une identité trustée suffit pour ces quatre écritures (le garde est la porte)', async () => {
            for (const [tool, args] of writingReads) {
                const res = await post(toolCall(tool, args), { as: 'myia-web2:roo-extensions' });
                expect(res.status).toBe(200);
            }
            expect(dispatched.map((d) => d.name)).toEqual(writingReads.map(([t]) => t));
        });
    });

    // Re-review ms#1578 (ai-01, 30/10 12:37Z) — **alias vers l'écriture** :
    // `roosync_messages(action:"attachments_get")` forwarde VERBATIM vers
    // `roosyncAttachments({action:"get", targetPath})` (messages.ts:450), le
    // handler que B2 venait de reclasser en ÉCRITURE parce qu'il COPIE le
    // fichier côté HÔTE du daemon vers un chemin fourni par l'appelant
    // (roosync-attachments.tool.ts:291-305). `targetPath` n'étant pas dans
    // `MUTATING_ARG_FLAGS`, une requête porteuse du bearer mais sans
    // `x-roosync-as` écrivait un fichier à un chemin arbitraire sur l'hôte.
    // -------------------------------------------------------------- *
    describe('alias vers une écriture — la porte porte sur le CHEMIN, pas sur l\'intitulé', () => {
        const ATTACHMENT_GET = {
            action: 'attachments_get',
            uuid: 'att-uuid',
            targetPath: 'C:/tmp/attachment-copy.bin',
        };

        it('refuse roosync_messages(action=attachments_get, targetPath) sans identité et ne le dispatche pas', async () => {
            const res = await post(toolCall('roosync_messages', ATTACHMENT_GET), { as: null });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('une identité trustée suffit pour cet alias (le garde est la porte, pas l\'outil)', async () => {
            const res = await post(toolCall('roosync_messages', ATTACHMENT_GET), {
                as: 'myia-web2:roo-extensions',
            });
            expect(res.status).toBe(200);
            expect(dispatched.map((d) => d.name)).toEqual(['roosync_messages']);
        });

        it('SANS targetPath, attachments_get reste une lecture (mode inline, aucune copie)', async () => {
            // Frontière du correctif : sans `targetPath`, le handler renvoie
            // le contenu DANS la réponse (roosync-attachments.tool.ts:285) —
            // aucune écriture sur l'hôte. La lecture reste donc sans
            // identité (le flag porte sur la PRÉSENCE du chemin).
            const res = await post(
                toolCall('roosync_messages', { action: 'attachments_get', uuid: 'att-uuid' }),
                { as: null }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('refuse analyze_roosync_problems(cleanupStale) sans identité et ne le dispatche pas', async () => {
            // Réécrit le fichier analysé SUR PLACE (analyze_problems.ts:302).
            const res = await post(
                toolCall('analyze_roosync_problems', { cleanupStale: true }),
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('refuse analyze_roosync_problems(generateReport) sans identité et ne le dispatche pas', async () => {
            // ÉCRIT un rapport dans le store partagé et PURGE les anciens
            // (analyze_problems.ts:333 et :347).
            const res = await post(
                toolCall('analyze_roosync_problems', { generateReport: true }),
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('une identité trustée suffit pour ces deux écritures', async () => {
            for (const args of [{ cleanupStale: true }, { generateReport: true }]) {
                const res = await post(toolCall('analyze_roosync_problems', args), {
                    as: 'myia-web2:roo-extensions',
                });
                expect(res.status).toBe(200);
            }
            expect(dispatched.map((d) => d.name)).toEqual([
                'analyze_roosync_problems',
                'analyze_roosync_problems',
            ]);
        });

        // --- Même famille, AUTRE outillage : le flag est propre à l'outil ---
        // `diagnose_conversation_bom` est classé lecture pure, mais
        // `fix_found=true` RÉÉCRIT les fichiers scannés (retrait du BOM —
        // diagnose-conversation-bom.tool.ts:68-76). Le flag est donc
        // mutateur POUR CET OUTIL, et seulement pour lui.
        it('refuse diagnose_conversation_bom(fix_found) sans identité et ne le dispatche pas', async () => {
            const res = await post(
                toolCall('diagnose_conversation_bom', { fix_found: true }),
                { as: null }
            );
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_required');
            expect(dispatched).toHaveLength(0);
        });

        it('diagnose_conversation_bom SANS flag reste une lecture sans identité', async () => {
            const res = await post(toolCall('diagnose_conversation_bom', {}), { as: null });
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('diagnose_conversation_bom(fix_found=false) reste une lecture (flag inactif)', async () => {
            const res = await post(
                toolCall('diagnose_conversation_bom', { fix_found: false }),
                { as: null }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });

        it('une identité trustée suffit pour diagnose_conversation_bom(fix_found)', async () => {
            const res = await post(toolCall('diagnose_conversation_bom', { fix_found: true }), {
                as: 'myia-web2:roo-extensions',
            });
            expect(res.status).toBe(200);
            expect(dispatched.map((d) => d.name)).toEqual(['diagnose_conversation_bom']);
        });

        it('NON-sur-blocage : fix_found reste inerte pour la détection de stockage', async () => {
            // `roosync_storage_management(action="storage")` est une lecture :
            // l'action ne relaie `fix_found` que via `action="maintenance"`
            // (storage-management.ts:187), et `maintenance` est déjà en
            // écriture (default-deny). Un flag GLOBAL aurait fait échouer
            // cette détection en 403 — le map par outil l'évite.
            const res = await post(
                toolCall('roosync_storage_management', { action: 'storage', fix_found: true }),
                { as: null }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });
    });

    // §3c — arbitrage du coordinateur (re-review du 30/10 17:51Z). Le corps de
    // PR soutenait que `filePath` est un argument de LECTURE pour
    // `conversation_browser` ; c'est faux, c'est un chemin de sauvegarde.
    // Une entrée GLOBALE ferme donc les TROIS sites d'écriture d'un coup.
    // -------------------------------------------------------------- *
    describe('§3c — filePath est un chemin de SAUVEGARDE, pas de lecture', () => {
        const savingCalls: Array<[string, Record<string, unknown>]> = [
            // export-data.ts:651-652 / :719-723 — writeFile au chemin fourni.
            ['export_data', { filePath: 'C:/tmp/export.json' }],
            // task/export.ts:407-408 — saveXmlToFile / writeFile.
            ['task_export', { taskId: 'task-1', filePath: 'C:/tmp/task.json' }],
            // generate-trace-summary.tool.ts:198-202 (mkdir + writeFile) et
            // get-conversation-synthesis.tool.ts:380 (writeFile).
            [
                'conversation_browser',
                { action: 'summarize', taskId: 'task-1', filePath: 'C:/tmp/summary.md' },
            ],
        ];

        for (const [tool, args] of savingCalls) {
            it(`refuse ${tool}(filePath) sans identité et ne le dispatche pas`, async () => {
                const res = await post(toolCall(tool, args), { as: null });
                expect(res.status).toBe(403);
                expect(res.json?.error).toBe('identity_required');
                expect(dispatched).toHaveLength(0);
            });
        }

        it('une identité trustée suffit pour ces trois écritures (le garde est la porte)', async () => {
            for (const [tool, args] of savingCalls) {
                const res = await post(toolCall(tool, args), {
                    as: 'myia-web2:roo-extensions',
                });
                expect(res.status).toBe(200);
            }
            expect(dispatched.map((d) => d.name)).toEqual(savingCalls.map(([t]) => t));
        });

        it('conversation_browser(action=summarize) SANS filePath reste une lecture', async () => {
            // Frontière du correctif : sans `filePath`, la synthèse est rendue
            // DANS la réponse — aucune écriture. La lecture reste donc sans
            // identité (le flag porte sur la PRÉSENCE du chemin).
            const res = await post(
                toolCall('conversation_browser', { action: 'summarize', taskId: 'task-1' }),
                { as: null }
            );
            expect(res.status).toBe(200);
            expect(dispatched).toHaveLength(1);
        });
    });

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
