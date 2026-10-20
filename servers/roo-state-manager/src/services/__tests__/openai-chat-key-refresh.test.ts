/**
 * #4095 — getter semantics: the condenser client is rebuilt when its credentials
 * move in `.env`, and ONLY then.
 *
 * These tests replay the po-203 failure shape at the unit level: a client built
 * when `.env` said `key-one` must not keep presenting `key-one` after the file
 * says `key-two`. The mutant these guard against is any regression that re-freezes
 * the singleton at spawn time (drop the refresh call, or drop the print compare) —
 * each makes the rotation test see the old key on the second construction, or no
 * second construction at all.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { MockOpenAI } = vi.hoisted(() => ({
    MockOpenAI: vi.fn(),
}));

vi.mock('openai', () => ({
    default: MockOpenAI,
}));

describe('openai getters — #4095 rotation-aware rebuild', () => {
    const origEnv = { ...process.env };
    let tmpDir: string;
    let envPath: string;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        MockOpenAI.mockImplementation(function () { return { mock: true }; });
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-4095-'));
        envPath = path.join(tmpDir, '.env');
        delete process.env.VLLM_API_KEY_MEDIUM;
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
        delete process.env.OPENAI_CHAT_MODEL_ID;
        delete process.env.ZAI_API_KEY;
        delete process.env.FALLBACK_API_KEY;
        delete process.env.ZAI_BASE_URL;
        delete process.env.FALLBACK_BASE_URL;
        delete process.env.FALLBACK_LLM_MODEL_ID;
    });

    afterEach(() => {
        process.env = { ...origEnv };
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Imports both modules from ONE reset graph so the path override is the one openai.ts sees. */
    async function importModules() {
        const openai = await import('../openai.js');
        const refresh = await import('../chat-key-refresh.js');
        return { openai, refresh };
    }

    test('chat client is rebuilt with the NEW key after a rotation in .env (the po-203 class)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath); // baseline: file absent (spawn-time)

        // `.env` as it was at spawn: the first getter call applies it and builds.
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\n', 'utf8');
        const first = openai.getChatOpenAIClient();
        expect(MockOpenAI).toHaveBeenCalledTimes(1);
        expect(MockOpenAI.mock.calls[0][0]).toEqual(expect.objectContaining({ apiKey: 'key-one' }));

        // Fleet rotation rewrites the file under the running host.
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-two-much-longer\n', 'utf8');
        const second = openai.getChatOpenAIClient();
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
        expect(second).not.toBe(first);
        expect(MockOpenAI.mock.calls[1][0]).toEqual(expect.objectContaining({ apiKey: 'key-two-much-longer' }));

        // And the third call is stable again — one rebuild per rotation, not per call.
        const third = openai.getChatOpenAIClient();
        expect(third).toBe(second);
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
    });

    test('model-id rotation follows lazily WITHOUT rebuilding the client (surgical: only key/endpoint rebuild)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);

        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\nOPENAI_CHAT_MODEL_ID=m-one\n', 'utf8');
        const first = openai.getChatOpenAIClient();
        expect(openai.getLLMModelId()).toBe('m-one');

        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\nOPENAI_CHAT_MODEL_ID=m-two-longer\n', 'utf8');
        const second = openai.getChatOpenAIClient();
        expect(second).toBe(first); // key and endpoint unchanged → same instance
        expect(MockOpenAI).toHaveBeenCalledTimes(1);
        expect(openai.getLLMModelId()).toBe('m-two-longer'); // read lazily from the refreshed env
    });

    test('endpoint rotation (OPENAI_BASE_URL) rebuilds the client too', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);

        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\nOPENAI_BASE_URL=http://a/v1\n', 'utf8');
        const first = openai.getChatOpenAIClient();

        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\nOPENAI_BASE_URL=http://b-much-longer/v1\n', 'utf8');
        const second = openai.getChatOpenAIClient();
        expect(second).not.toBe(first);
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
    });

    test('fallback client is rebuilt after a ZAI key rotation (same class, cloud tier)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);

        fs.writeFileSync(envPath, 'ZAI_API_KEY=zai-one\n', 'utf8');
        const first = openai.getFallbackChatOpenAIClient();
        expect(first).not.toBeNull();
        expect(MockOpenAI.mock.calls[0][0]).toEqual(expect.objectContaining({ apiKey: 'zai-one' }));

        fs.writeFileSync(envPath, 'ZAI_API_KEY=zai-two-much-longer\n', 'utf8');
        const second = openai.getFallbackChatOpenAIClient();
        expect(second).not.toBe(first);
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
        expect(MockOpenAI.mock.calls[1][0]).toEqual(expect.objectContaining({ apiKey: 'zai-two-much-longer' }));
    });

    test('absent .env → getters behave exactly as before (refresh inert, no throw)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(path.join(tmpDir, 'no-such.env'));

        expect(openai.getFallbackChatOpenAIClient()).toBeNull();
        expect(() => openai.getChatOpenAIClient()).toThrow('No chat API key configured');
    });

    test('static .env → singleton semantics unchanged (two calls, one construction)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath); // baseline: file absent (spawn-time)
        fs.writeFileSync(envPath, 'OPENAI_API_KEY=stable-key\n', 'utf8');
        // What dotenv did at boot: the spawn-time value already sits in process.env.
        process.env.OPENAI_API_KEY = 'stable-key';

        const a = openai.getChatOpenAIClient();
        const b = openai.getChatOpenAIClient();
        expect(a).toBe(b);
        expect(MockOpenAI).toHaveBeenCalledTimes(1);
    });
});