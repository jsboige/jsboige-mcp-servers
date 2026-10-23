/**
 * #4095 lever 2 — probe semantics: `probeChatKeyState` reports served vs
 * resolved fingerprints so a coordination cycle can detect a rotation the
 * served singleton has not picked up (<1 cycle after the fleet rotates).
 *
 * The contract under test has two halves:
 *   - HONESTY: inSync===false exactly when the singleton predates the current
 *     credentials; inSync===null while nothing is served (no false alarm on a
 *     cold host); inSync===true once built and current.
 *   - SAFETY: the probe never emits key VALUES — only env var names and hex
 *     prints (8-hex pair, 12-hex key) — and never builds a client itself.
 *
 * The mutant these guard against is any regression that freezes the probe on
 * the served print (drop the refresh call → inSync stays true after a
 * rotation), or that leaks the credential into the probe output.
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

describe('probeChatKeyState — #4095 lever 2 served-fingerprint probe', () => {
    const origEnv = { ...process.env };
    let tmpDir: string;
    let envPath: string;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        MockOpenAI.mockImplementation(function () { return { mock: true }; });
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-4095-probe-'));
        envPath = path.join(tmpDir, '.env');
        for (const k of [
            'VLLM_API_KEY_MEDIUM', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CHAT_MODEL_ID',
            'ZAI_API_KEY', 'FALLBACK_API_KEY', 'ZAI_BASE_URL', 'FALLBACK_BASE_URL', 'FALLBACK_LLM_MODEL_ID',
        ]) delete process.env[k];
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

    test('no key anywhere → nulls across the board, inSync null (cold host, no false alarm)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(path.join(tmpDir, 'no-such.env'));

        const probe = openai.probeChatKeyState();
        expect(probe.primary.keyPrint).toBeNull();
        expect(probe.primary.source).toBeNull();
        expect(probe.primary.resolvedPrint).toBeNull();
        expect(probe.primary.servedPrint).toBeNull();
        expect(probe.primary.inSync).toBeNull();
        expect(probe.fallback.keyPrint).toBeNull();
        expect(probe.fallback.source).toBeNull();
        expect(probe.fallback.inSync).toBeNull();
        // A probe on a cold host builds nothing.
        expect(MockOpenAI).not.toHaveBeenCalled();
    });

    test('key resolved, client NOT built → servedPrint null + inSync null; keyPrint is 12-hex; source is the NAME', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\n', 'utf8');

        const probe = openai.probeChatKeyState();
        expect(probe.primary.source).toBe('VLLM_API_KEY_MEDIUM');
        expect(probe.primary.keyPrint).toMatch(/^[0-9a-f]{12}$/);
        expect(probe.primary.resolvedPrint).toMatch(/^[0-9a-f]{8}$/);
        expect(probe.primary.servedPrint).toBeNull();
        // "Not built yet" is not a drift — the first build will use the fresh key.
        expect(probe.primary.inSync).toBeNull();
        expect(MockOpenAI).not.toHaveBeenCalled();
    });

    test('client built and current → servedPrint === resolvedPrint, inSync true (both legs)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\nZAI_API_KEY=zai-one\n', 'utf8');

        openai.getChatOpenAIClient();
        openai.getFallbackChatOpenAIClient();
        const probe = openai.probeChatKeyState();
        expect(probe.primary.servedPrint).toBe(probe.primary.resolvedPrint);
        expect(probe.primary.inSync).toBe(true);
        expect(probe.fallback.source).toBe('ZAI_API_KEY');
        expect(probe.fallback.servedPrint).toBe(probe.fallback.resolvedPrint);
        expect(probe.fallback.inSync).toBe(true);
    });

    test('rotation in .env not yet picked up → primary.inSync FALSE (the drift the probe exists for)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\n', 'utf8');
        openai.getChatOpenAIClient(); // builds with key-one

        // Fleet rotation rewrites the file under the running host — no getter
        // call in between: this is exactly the window the probe must expose.
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-two-much-longer\n', 'utf8');
        const probe = openai.probeChatKeyState();
        expect(probe.primary.inSync).toBe(false);
        expect(probe.primary.servedPrint).not.toBe(probe.primary.resolvedPrint);
        expect(probe.primary.source).toBe('VLLM_API_KEY_MEDIUM');

        // SAFETY: names and hex prints only — the values appear nowhere.
        const serialized = JSON.stringify(probe);
        expect(serialized).not.toContain('key-one');
        expect(serialized).not.toContain('key-two');
        // The probe observed without building: still exactly one construction.
        expect(MockOpenAI).toHaveBeenCalledTimes(1);
    });

    test('getter heals the drift the probe reported (probe → getter → probe)', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-one\n', 'utf8');
        openai.getChatOpenAIClient();
        fs.writeFileSync(envPath, 'VLLM_API_KEY_MEDIUM=key-two-much-longer\n', 'utf8');
        expect(openai.probeChatKeyState().primary.inSync).toBe(false);

        openai.getChatOpenAIClient(); // rotation-aware rebuild (lever 1)
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
        const probe = openai.probeChatKeyState();
        expect(probe.primary.inSync).toBe(true);
        expect(probe.primary.servedPrint).toBe(probe.primary.resolvedPrint);
    });

    test('fallback leg: ZAI rotation detected; unconfigured fallback reports nulls without null client', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'ZAI_API_KEY=zai-one\n', 'utf8');
        openai.getFallbackChatOpenAIClient();

        fs.writeFileSync(envPath, 'ZAI_API_KEY=zai-two-much-longer\n', 'utf8');
        const probe = openai.probeChatKeyState();
        expect(probe.fallback.inSync).toBe(false);
        expect(probe.fallback.servedPrint).not.toBe(probe.fallback.resolvedPrint);
        expect(probe.fallback.source).toBe('ZAI_API_KEY');
        const serialized = JSON.stringify(probe);
        expect(serialized).not.toContain('zai-one');
        expect(serialized).not.toContain('zai-two');

        // Primary leg untouched by a fallback-only rotation.
        expect(probe.primary.inSync).toBeNull(); // never built in this test
    });

    test('OPENAI_API_KEY second-chance source is reported by NAME', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath);
        fs.writeFileSync(envPath, 'OPENAI_API_KEY=openai-key\n', 'utf8');

        const probe = openai.probeChatKeyState();
        expect(probe.primary.source).toBe('OPENAI_API_KEY');
        expect(probe.primary.keyPrint).toMatch(/^[0-9a-f]{12}$/);
        expect(JSON.stringify(probe)).not.toContain('openai-key');
    });

    // #4317 (criterion 1, probe half): the ai-01 shape — ZAI_API_KEY commented out
    // of `.env` while the process lives. The refresh must CUT the stale key (it only
    // ever set keys before), the probe must then resolve the fallback leg from
    // FALLBACK_API_KEY, and the rotation-aware rebuild must fire on the next getter.
    test('#4317 — ZAI_API_KEY removed from .env: probe source flips to FALLBACK_API_KEY, client rebuilds', async () => {
        const { openai, refresh } = await importModules();
        refresh.setChatEnvPathForTest(envPath); // baseline: file absent (spawn-time)
        fs.writeFileSync(envPath, 'ZAI_API_KEY=zai-one\nFALLBACK_API_KEY=f1-short\n', 'utf8');
        openai.getFallbackChatOpenAIClient(); // builds under the z.ai key
        expect(openai.probeChatKeyState().fallback.source).toBe('ZAI_API_KEY');

        // The operator's single edit — no getter, probe or refresh in between.
        fs.writeFileSync(envPath, '# ZAI_API_KEY=zai-one\nFALLBACK_API_KEY=f1-much-longer\n', 'utf8');

        const probe = openai.probeChatKeyState(); // the probe's own refresh performs the cut
        expect(probe.fallback.source).toBe('FALLBACK_API_KEY');
        expect(process.env.ZAI_API_KEY).toBeUndefined();
        expect(probe.fallback.inSync).toBe(false); // served singleton predates the move

        // Lever 1 fires on the next getter: the client rebuilds on the fallback key.
        const second = openai.getFallbackChatOpenAIClient();
        expect(second).not.toBeNull();
        expect(MockOpenAI).toHaveBeenCalledTimes(2);
        expect(MockOpenAI.mock.calls[1][0]).toEqual(expect.objectContaining({ apiKey: 'f1-much-longer' }));
        expect(openai.probeChatKeyState().fallback.inSync).toBe(true);
    });
});
