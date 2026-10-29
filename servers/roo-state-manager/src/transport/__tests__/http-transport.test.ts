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
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpTransport, type HttpTransportHandle } from '../http-transport.js';
import { getLocalMachineId, getLocalWorkspaceId } from '../../utils/message-helpers.js';

const API_KEY = 'test-key-4149';
const MCP_PATH = '/mcp';

let handle: HttpTransportHandle;
let baseUrl: string;
const savedTrusted = process.env.ROOSYNC_TRUSTED_CALLER_IDS;

/**
 * Serveur MCP de test : un outil `roosync_test_identity` qui AWAIT une
 * frontière (setTimeout) AVANT de lire l'identité — c'est ce qui force
 * l'entrelacement de deux requêtes dans la fenêtre où une variable de module
 * aurait fuité d'un client vers l'autre.
 */
function buildServer(): Server {
    const server = new Server(
        { name: 'rsm-http-transport-test', version: '0.0.0' },
        { capabilities: { tools: {} } }
    );
    server.setRequestHandler(CallToolRequestSchema, async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify({
                        machineId: getLocalMachineId(),
                        workspaceId: getLocalWorkspaceId(),
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

describe('#4149 F2 — transport HTTP du daemon RSM', () => {
    beforeAll(async () => {
        process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-web2,myia-po-2024';
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
        });

        it('refuse une identité non trustée (ROOSYNC_TRUSTED_CALLER_IDS)', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }), { as: 'myia-inconnue:roo-extensions' });
            expect(res.status).toBe(403);
            expect(res.json?.error).toBe('identity_refused');
        });

        it('laisse passer une écriture avec une identité trustée', async () => {
            const res = await post(toolCall('roosync_dashboard', { action: 'append', type: 'workspace' }), { as: 'myia-web2:roo-extensions' });
            expect(res.status).toBe(200);
        });

        it('une lecture sans identité reste autorisée (résolution locale)', async () => {
            const res = await post(toolCall('roosync_test_identity'), { as: null });
            expect(res.status).toBe(200);
            const payload = JSON.parse(res.json.result.content[0].text);
            expect(payload.machineId).toBe(getLocalMachineId());
        });

        it('l’identité assertée remplace l’identité du process', async () => {
            const res = await post(toolCall('roosync_test_identity'), { as: 'myia-web2:roo-extensions' });
            expect(res.status).toBe(200);
            const payload = JSON.parse(res.json.result.content[0].text);
            expect(payload.machineId).toBe('myia-web2');
            expect(payload.workspaceId).toBe('roo-extensions');
        });

        it('deux identités entrelacées voit chacune la sienne (AsyncLocalStorage)', async () => {
            const [first, second] = await Promise.all([
                post(toolCall('roosync_test_identity', {}, 11), { as: 'myia-web2:roo-extensions' }),
                post(toolCall('roosync_test_identity', {}, 12), { as: 'myia-po-2024:coursia' }),
            ]);
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            const firstPayload = JSON.parse(first.json.result.content[0].text);
            const secondPayload = JSON.parse(second.json.result.content[0].text);
            expect(firstPayload.machineId).toBe('myia-web2');
            expect(firstPayload.workspaceId).toBe('roo-extensions');
            expect(secondPayload.machineId).toBe('myia-po-2024');
            expect(secondPayload.workspaceId).toBe('coursia');
        });
    });
});
