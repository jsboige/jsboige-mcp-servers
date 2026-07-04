/**
 * #833 Sprint C3 — openai.ts branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `openai.test.ts` (33 tests) is thorough for the functions it covers:
 * getEmbeddingModel (default/env/empty), getEmbeddingDimensions (default/custom/
 * non-numeric/zero/negative/valid-int), getOpenAIClient (no-key/EMBEDDING_KEY/
 * OPENAI_KEY-fallback/preference/baseURL/singleton), and the #2719 fallback client
 * (null/ZAI/fallback-key/baseURL-override/cap-60s/singleton/reset).
 *
 * It leaves a SUBSTANTIAL cluster cold, however — two entire exported functions are
 * never exercised, plus several env-var fallback arms:
 *
 * - **`getChatOpenAIClient` (L61-87) — ENTIRELY UNTESTED**: not a single test calls it.
 *   Cold: L64 `OPENAI_API_KEY || EMBEDDING_API_KEY` precedence (OPENAI wins, EMBEDDING
 *   fallback — the REVERSE of getOpenAIClient), L65-71 no-key-throws ('No chat API key
 *   configured' / OPENAI_API_KEY_MISSING / ChatOpenAIClient), L80-84 config
 *   (maxRetries=0 + hardcoded timeout=1800000, no env override), singleton, reset.
 * - **`getLLMModelId` (L93-94) — ENTIRELY UNTESTED**: default 'qwen3.6-35b-a3b' +
 *   OPENAI_CHAT_MODEL_ID override.
 * - **`EMBEDDING_TIMEOUT_MS` override (L48)**: base always tests the 15000 default,
 *   never a custom timeout via env.
 * - **`EMBEDDING_API_BASE_URL || undefined` empty-string (L44)**: base tests unset→
 *   undefined and set→URL; empty-string '' → undefined (|| vs ??) is cold.
 * - **`getEmbeddingDimensions` empty-string (L21)**: base tests '0'/'-100'/'not-a-number'
 *   but never '' → `'' || '1536'` → 1536.
 * - **`getFallbackChatOpenAIClient` FALLBACK_BASE_URL arm (L121)**: 3-way fallback
 *   `ZAI_BASE_URL || FALLBACK_BASE_URL || default`. Base tests ZAI_BASE_URL override
 *   + default; the MIDDLE arm (FALLBACK_BASE_URL without ZAI_BASE_URL) is cold.
 * - **`getFallbackChatOpenAIClient` timeout below cap (L129)**: base tests the cap
 *   (120000→60000); a below-cap value (30000 default, or sub-60k override) passing
 *   through Math.min unchanged is cold.
 *
 * Strategy: same vi.hoisted MockOpenAI pattern as the base (default export mock),
 * dynamic import + vi.resetModules per test. No production code touched (#1936 anti-churn).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockOpenAI } = vi.hoisted(() => ({
    MockOpenAI: vi.fn(),
}));

vi.mock('openai', () => ({
    default: MockOpenAI,
}));

describe('openai — branch coverage (#833 C3, source-grounded)', () => {
    const origEnv = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        // Clear all relevant env vars so each test controls its own state.
        delete process.env.EMBEDDING_MODEL;
        delete process.env.EMBEDDING_DIMENSIONS;
        delete process.env.EMBEDDING_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.EMBEDDING_API_BASE_URL;
        delete process.env.EMBEDDING_TIMEOUT_MS;
        delete process.env.OPENAI_CHAT_MODEL_ID;
        delete process.env.ZAI_API_KEY;
        delete process.env.FALLBACK_API_KEY;
        delete process.env.ZAI_BASE_URL;
        delete process.env.FALLBACK_BASE_URL;
        delete process.env.FALLBACK_LLM_MODEL_ID;
        delete process.env.FALLBACK_TIMEOUT_MS;
    });

    afterEach(() => {
        process.env = { ...origEnv };
    });

    // ============================================================
    // getEmbeddingDimensions — empty-string (L21)
    // ============================================================
    describe('getEmbeddingDimensions — empty string (L21)', () => {
        test('empty-string "" falls back to default 1536 because || (not ??)', async () => {
            // '' is falsy → '' || '1536' → 1536. If modernized to ??, '' survives → parseInt('') = NaN → 1536 (same result, but via a different path). Pin the || contract.
            process.env.EMBEDDING_DIMENSIONS = '';
            const { getEmbeddingDimensions } = await import('../openai.js');
            expect(getEmbeddingDimensions()).toBe(1536);
        });
    });

    // ============================================================
    // getOpenAIClient (default export) — EMBEDDING_TIMEOUT_MS + empty baseURL (L44, L48)
    // ============================================================
    describe('getOpenAIClient — timeout + baseURL edges (L44, L48)', () => {
        test('EMBEDDING_TIMEOUT_MS override flows to the client config (L48)', async () => {
            process.env.EMBEDDING_API_KEY = 'key';
            process.env.EMBEDDING_TIMEOUT_MS = '45000';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const mod = await import('../openai.js');
            mod.default();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ timeout: 45000 }),
            );
        });

        test('empty-string EMBEDDING_API_BASE_URL → undefined (L44 || undefined, not ??)', async () => {
            // '' is falsy → '' || undefined → undefined. If ?? were used, '' would survive as baseURL (bug).
            process.env.EMBEDDING_API_KEY = 'key';
            process.env.EMBEDDING_API_BASE_URL = '';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const mod = await import('../openai.js');
            mod.default();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ baseURL: undefined }),
            );
        });
    });

    // ============================================================
    // getChatOpenAIClient (L61-87) — ENTIRELY UNTESTED in base
    // ============================================================
    describe('getChatOpenAIClient — cold function (L61-87)', () => {
        test('throws OPENAI_API_KEY_MISSING when neither OPENAI_API_KEY nor EMBEDDING_API_KEY set (L65-71)', async () => {
            const { getChatOpenAIClient } = await import('../openai.js');
            expect(() => getChatOpenAIClient()).toThrow('No chat API key configured');
        });

        test('uses OPENAI_API_KEY when set (L64 first operand — precedence)', async () => {
            process.env.OPENAI_API_KEY = 'chat-key';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient } = await import('../openai.js');
            const client = getChatOpenAIClient();

            expect(client).toBeDefined();
            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: 'chat-key' }),
            );
        });

        test('falls back to EMBEDDING_API_KEY when OPENAI_API_KEY unset (L64 second operand)', async () => {
            // REVERSE precedence vs getOpenAIClient: chat prefers OPENAI_API_KEY, embed prefers EMBEDDING_API_KEY.
            process.env.EMBEDDING_API_KEY = 'embed-key';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient } = await import('../openai.js');
            getChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: 'embed-key' }),
            );
        });

        test('prefers OPENAI_API_KEY over EMBEDDING_API_KEY when both set (L64 precedence)', async () => {
            process.env.OPENAI_API_KEY = 'chat-wins';
            process.env.EMBEDDING_API_KEY = 'embed-loses';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient } = await import('../openai.js');
            getChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: 'chat-wins' }),
            );
        });

        test('config: maxRetries=0 + hardcoded timeout=1800000 (L80-84)', async () => {
            // #1497: chat disables SDK retries (caller handles its own). timeout is hardcoded 30min (no env override).
            process.env.OPENAI_API_KEY = 'key';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient } = await import('../openai.js');
            getChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({
                    maxRetries: 0,
                    timeout: 1800000,
                }),
            );
        });

        test('timeout is hardcoded — ignores a hypothetical EMBEDDING_TIMEOUT_MS override (L83 vs L48)', async () => {
            // getChatOpenAIClient does NOT read EMBEDDING_TIMEOUT_MS (unlike getOpenAIClient L48).
            // Pin that the chat timeout stays 1800000 even when the embed timeout env is set.
            process.env.OPENAI_API_KEY = 'key';
            process.env.EMBEDDING_TIMEOUT_MS = '45000';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient } = await import('../openai.js');
            getChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ timeout: 1800000 }),
            );
        });

        test('returns singleton on repeat calls (L62 if !chatOpenai guard)', async () => {
            process.env.OPENAI_API_KEY = 'key';
            const instance = { singleton: true };
            MockOpenAI.mockImplementation(function () { return instance; });

            const { getChatOpenAIClient } = await import('../openai.js');
            const first = getChatOpenAIClient();
            const second = getChatOpenAIClient();

            expect(first).toBe(second);
            expect(MockOpenAI).toHaveBeenCalledTimes(1);
        });

        test('resetChatOpenAIClient clears the singleton (#864, L148)', async () => {
            process.env.OPENAI_API_KEY = 'key';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getChatOpenAIClient, resetChatOpenAIClient } = await import('../openai.js');
            getChatOpenAIClient();
            expect(MockOpenAI).toHaveBeenCalledTimes(1);

            resetChatOpenAIClient();
            getChatOpenAIClient();
            expect(MockOpenAI).toHaveBeenCalledTimes(2);
        });
    });

    // ============================================================
    // getLLMModelId (L93-94) — ENTIRELY UNTESTED in base
    // ============================================================
    describe('getLLMModelId — cold function (L93-94)', () => {
        test('returns default qwen3.6-35b-a3b when env not set (L94)', async () => {
            const { getLLMModelId } = await import('../openai.js');
            expect(getLLMModelId()).toBe('qwen3.6-35b-a3b');
        });

        test('returns custom model from OPENAI_CHAT_MODEL_ID (L94)', async () => {
            process.env.OPENAI_CHAT_MODEL_ID = 'gpt-4o-mini';
            const { getLLMModelId } = await import('../openai.js');
            expect(getLLMModelId()).toBe('gpt-4o-mini');
        });

        test('empty-string OPENAI_CHAT_MODEL_ID falls back to default (L94 ||)', async () => {
            process.env.OPENAI_CHAT_MODEL_ID = '';
            const { getLLMModelId } = await import('../openai.js');
            expect(getLLMModelId()).toBe('qwen3.6-35b-a3b');
        });
    });

    // ============================================================
    // getFallbackChatOpenAIClient — FALLBACK_BASE_URL arm + below-cap timeout (L121, L129)
    // ============================================================
    describe('getFallbackChatOpenAIClient — 3-way baseURL + timeout-below-cap (L121, L129)', () => {
        test('FALLBACK_BASE_URL arm: used when ZAI_BASE_URL unset (L121 middle operand)', async () => {
            // 3-way fallback: ZAI_BASE_URL || FALLBACK_BASE_URL || default.
            // Base tests ZAI_BASE_URL (first) + default (third). The MIDDLE arm is cold.
            process.env.FALLBACK_API_KEY = 'k';
            process.env.FALLBACK_BASE_URL = 'https://fallback.endpoint/v1';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getFallbackChatOpenAIClient } = await import('../openai.js');
            getFallbackChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ baseURL: 'https://fallback.endpoint/v1' }),
            );
        });

        test('ZAI_BASE_URL still wins over FALLBACK_BASE_URL when both set (L121 precedence)', async () => {
            process.env.FALLBACK_API_KEY = 'k';
            process.env.ZAI_BASE_URL = 'https://zai.wins/v1';
            process.env.FALLBACK_BASE_URL = 'https://fallback.loses/v1';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getFallbackChatOpenAIClient } = await import('../openai.js');
            getFallbackChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ baseURL: 'https://zai.wins/v1' }),
            );
        });

        test('below-cap timeout passes through Math.min unchanged (L129)', async () => {
            // Math.min(15000, 60000) = 15000 — below-cap value is NOT raised to the cap.
            process.env.ZAI_API_KEY = 'k';
            process.env.FALLBACK_TIMEOUT_MS = '15000';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getFallbackChatOpenAIClient } = await import('../openai.js');
            getFallbackChatOpenAIClient();

            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ timeout: 15000 }),
            );
        });

        test('default timeout 30000 (FALLBACK_TIMEOUT_MS unset) passes through under cap (L122 + L129)', async () => {
            process.env.ZAI_API_KEY = 'k';
            MockOpenAI.mockImplementation(function () { return { mock: true }; });

            const { getFallbackChatOpenAIClient } = await import('../openai.js');
            getFallbackChatOpenAIClient();

            // Math.min(30000, 60000) = 30000.
            expect(MockOpenAI).toHaveBeenCalledWith(
                expect.objectContaining({ timeout: 30000 }),
            );
        });
    });
});
