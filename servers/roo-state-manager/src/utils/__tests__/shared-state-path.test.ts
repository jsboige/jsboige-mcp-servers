/**
 * Tests for shared-state-path.ts
 * Coverage: env var resolution + .env fallback (#1628)
 *
 * @module utils/__tests__/shared-state-path
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

describe('getSharedStatePath', () => {
    const originalEnv = process.env.ROOSYNC_SHARED_PATH;

    beforeEach(() => {
        delete process.env.ROOSYNC_SHARED_PATH;
        vi.resetModules();
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.ROOSYNC_SHARED_PATH = originalEnv;
        } else {
            delete process.env.ROOSYNC_SHARED_PATH;
        }
        vi.restoreAllMocks();
    });

    test('returns ROOSYNC_SHARED_PATH when set via env var', async () => {
        process.env.ROOSYNC_SHARED_PATH = '/some/shared/path';
        const { getSharedStatePath } = await import('../shared-state-path.js');
        expect(getSharedStatePath()).toBe('/some/shared/path');
    });

    test('falls back to .env file when env var is not set', async () => {
        // The real .env file exists in the project with ROOSYNC_SHARED_PATH set.
        // When env var is deleted, the fallback should read from it.
        const { getSharedStatePath } = await import('../shared-state-path.js');
        const result = getSharedStatePath();
        // Should return a non-empty path from .env (not throw)
        expect(result).toBeTruthy();
        expect(result).not.toBe('');
        // Should also cache it in process.env
        expect(process.env.ROOSYNC_SHARED_PATH).toBe(result);
    });

    test('env var takes precedence over .env file', async () => {
        process.env.ROOSYNC_SHARED_PATH = '/env-var-path';
        const { getSharedStatePath } = await import('../shared-state-path.js');
        expect(getSharedStatePath()).toBe('/env-var-path');
    });

    test('returns different paths when env changes between calls', async () => {
        process.env.ROOSYNC_SHARED_PATH = '/path/one';
        const { getSharedStatePath } = await import('../shared-state-path.js');
        expect(getSharedStatePath()).toBe('/path/one');

        process.env.ROOSYNC_SHARED_PATH = '/path/two';
        expect(getSharedStatePath()).toBe('/path/two');
    });

    test('throws descriptive error when .env file is missing', async () => {
        // Mock existsSync to simulate missing .env file
        vi.doMock('fs', async () => {
            const actual = await vi.importActual('fs');
            return {
                ...actual,
                existsSync: () => false,
            };
        });

        const { getSharedStatePath } = await import('../shared-state-path.js');
        expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });

    test('error mentions Google Drive for user guidance', async () => {
        vi.doMock('fs', async () => {
            const actual = await vi.importActual('fs');
            return {
                ...actual,
                existsSync: () => false,
            };
        });

        const { getSharedStatePath } = await import('../shared-state-path.js');
        expect(() => getSharedStatePath()).toThrow(/Google Drive/);
    });
});
