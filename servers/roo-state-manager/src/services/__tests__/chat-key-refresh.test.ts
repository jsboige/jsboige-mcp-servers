/**
 * #4095 — chat-key-refresh: the stat-guarded `.env` refresh that lets a vLLM key
 * rotation reach a long-lived condenser without a manual `roosync_diagnose reload`.
 *
 * The invariant under test is the one the po-203 incident violated on the way in:
 * a key that a rotation moved in `.env` MUST land in `process.env`, and a key the
 * HOST set at boot must NEVER be overwritten from the file (#2719 — inverting that
 * precedence is how the reload re-pointed EMBEDDING_API_BASE_URL on ai-01).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * readFileSync control for the mid-write test below. An ESM namespace cannot be
 * spied on (`vi.spyOn(fs, …)` throws "module namespace is not configurable"), so
 * the module is mocked with a pass-through that throws once, on demand, on the
 * `.env` read only. Everything else in this file sees the real `fs`.
 */
const mockFsState = vi.hoisted(() => ({ throwOnNextEnvRead: false }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        readFileSync: ((...args: unknown[]) => {
            if (mockFsState.throwOnNextEnvRead && String(args[0]).endsWith('.env')) {
                mockFsState.throwOnNextEnvRead = false;
                throw new Error('EBUSY: resource busy or locked (mid-write)');
            }
            return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.readFileSync,
    };
});

describe('chat-key-refresh — rotation detection, host-owned guard, allowlist', () => {
    const origEnv = { ...process.env };
    let tmpDir: string;

    beforeEach(() => {
        vi.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-key-refresh-'));
        delete process.env.VLLM_API_KEY_MEDIUM;
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
        delete process.env.OPENAI_CHAT_MODEL_ID;
        delete process.env.ZAI_API_KEY;
        delete process.env.FALLBACK_API_KEY;
        delete process.env.ZAI_BASE_URL;
        delete process.env.FALLBACK_BASE_URL;
        delete process.env.FALLBACK_LLM_MODEL_ID;
        delete process.env.ROOSYNC_SHARED_PATH;
    });

    afterEach(() => {
        process.env = { ...origEnv };
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function envFile(name: string, content: string): string {
        const p = path.join(tmpDir, name);
        fs.writeFileSync(p, content, 'utf8');
        return p;
    }

    test('a rotation in .env lands in process.env on the next call (the #4095 fix)', async () => {
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        const p = path.join(tmpDir, '.env');
        setChatEnvPathForTest(p); // baseline: file does not exist yet
        process.env.VLLM_API_KEY_MEDIUM = 'key-v1';

        fs.writeFileSync(p, 'VLLM_API_KEY_MEDIUM=key-v2-longer\n', 'utf8');

        expect(refreshChatKeyEnvIfChanged()).toEqual(['VLLM_API_KEY_MEDIUM']);
        expect(process.env.VLLM_API_KEY_MEDIUM).toBe('key-v2-longer');
    });

    test('unchanged file → no-op (stat-guard keeps it cheap and test-inert)', async () => {
        const p = envFile('.env', 'OPENAI_API_KEY=k1\n');
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        setChatEnvPathForTest(p);

        // First call after a baseline identical to the file: nothing moved.
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);

        // And once a change HAS been applied, it is not re-applied on the next call.
        fs.writeFileSync(p, 'OPENAI_API_KEY=k2-longer\n', 'utf8');
        expect(refreshChatKeyEnvIfChanged()).toEqual(['OPENAI_API_KEY']);
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);
        expect(process.env.OPENAI_API_KEY).toBe('k2-longer');
    });

    test('a key the HOST set at boot is never overwritten from .env (#2719 invariant)', async () => {
        const p = path.join(tmpDir, '.env');
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        // Same module instance as the one chat-key-refresh imports (one resetModules
        // above, no further reset): the host-env snapshot is shared.
        const { captureHostEnvKeys } = await import('../host-env-snapshot.js');
        captureHostEnvKeys({ RSM_HOST_ENV_KEYS: 'VLLM_API_KEY_MEDIUM' } as NodeJS.ProcessEnv);

        process.env.VLLM_API_KEY_MEDIUM = 'host-value';
        setChatEnvPathForTest(p); // baseline: file absent (its arrival is the "change")
        fs.writeFileSync(p, 'VLLM_API_KEY_MEDIUM=from-file-longer\nOPENAI_API_KEY=from-file-too\n', 'utf8');

        // The host-owned key must survive the refresh; the free one must move.
        expect(refreshChatKeyEnvIfChanged()).toEqual(['OPENAI_API_KEY']);
        expect(process.env.VLLM_API_KEY_MEDIUM).toBe('host-value');
        expect(process.env.OPENAI_API_KEY).toBe('from-file-too');
    });

    test('absent .env → inert, never throws (host-env-only seat, CI runner)', async () => {
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        setChatEnvPathForTest(path.join(tmpDir, 'no-such.env'));
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);
        expect(process.env.VLLM_API_KEY_MEDIUM).toBeUndefined();
    });

    test('a .env that appears after a missing baseline is picked up', async () => {
        const p = path.join(tmpDir, '.env');
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        setChatEnvPathForTest(p);
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);

        fs.writeFileSync(p, 'ZAI_API_KEY=z1\n', 'utf8');
        expect(refreshChatKeyEnvIfChanged()).toEqual(['ZAI_API_KEY']);
        expect(process.env.ZAI_API_KEY).toBe('z1');
    });

    test('a read that fails mid-write does not swallow the change (lastStat stamps only after success)', async () => {
        const p = path.join(tmpDir, '.env');
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        setChatEnvPathForTest(p); // baseline: file does not exist yet

        // The writer lands the new content...
        fs.writeFileSync(p, 'OPENAI_API_KEY=key-after-midwrite\n', 'utf8');

        // ...and this first look hits it while it is unreadable (mid-write).
        // One thrown read must NOT consume the change: stamping the baseline
        // before the read would make the next call skip this same stat and the
        // rotation would only be seen at the file's NEXT write.
        mockFsState.throwOnNextEnvRead = true; // the first look reads mid-write
        expect(refreshChatKeyEnvIfChanged()).toEqual([]);
        expect(process.env.OPENAI_API_KEY).toBeUndefined();

        // Same stat as the failed look — the retry must still land the key.
        expect(refreshChatKeyEnvIfChanged()).toEqual(['OPENAI_API_KEY']);
        expect(process.env.OPENAI_API_KEY).toBe('key-after-midwrite');
    });

    test('keys outside the condensation set are never touched, even when .env moves', async () => {
        const p = envFile('.env', 'ROOSYNC_SHARED_PATH=/tmp/elsewhere\nEMBEDDING_API_KEY=embed-key\n');
        const { setChatEnvPathForTest, refreshChatKeyEnvIfChanged } = await import('../chat-key-refresh.js');
        setChatEnvPathForTest(p);
        process.env.ROOSYNC_SHARED_PATH = '/the/real/store';

        expect(refreshChatKeyEnvIfChanged()).toEqual([]);
        expect(process.env.ROOSYNC_SHARED_PATH).toBe('/the/real/store');
        expect(process.env.EMBEDDING_API_KEY).toBeUndefined();
    });

    test('every CHAT_ENV_KEYS entry is a key config-reload is also allowed to move (drift guard)', async () => {
        const { CHAT_ENV_KEYS } = await import('../chat-key-refresh.js');
        const { RELOADABLE_ENV_KEYS } = await import('../config-reload.js');
        const reloadable = new Set<string>(RELOADABLE_ENV_KEYS);
        const orphans = CHAT_ENV_KEYS.filter((k) => !reloadable.has(k));
        expect(orphans).toEqual([]);
    });
});