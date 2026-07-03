/**
 * Coverage complement for shared-state-path.ts (#833, Sprint C3)
 *
 * The base suite (shared-state-path.test.ts, 6 tests) covers `getSharedStatePath`
 * (env-var resolution + simple .env fallback + throw). It leaves 3 clusters cold:
 *   1. `readFromDotenv` parsing branches (L22-47): comment/empty/no-=/key-mismatch
 *      line skips, single+double quote stripping, empty-value→null, readFileSync-throw catch.
 *   2. `tryGetSharedStatePath` (L83-89): #1918 safe variant — success returns string,
 *      failure catches → null. Entirely cold (base never calls it).
 *   3. `isSharedPathAccessible` (L95-103): #1918 GDrive probe — null-path→false,
 *      existsSync true/false, existsSync-throw catch. Entirely cold.
 *
 * Method: matches the base suite's dynamic-import + vi.doMock('fs') + vi.resetModules
 * pattern (required because the module reads fs at call time, not import time).
 * Named fs imports in source (L15) → vi.doMock intercepts correctly (no bypass).
 *
 * @module utils/__tests__/shared-state-path.coverage
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Helper: dynamically import the module after mocking fs with the desired
 * existsSync / readFileSync behavior. Mirrors the base suite pattern.
 */
async function importWithFsMock(opts: {
    existsSync?: (path: string | URL) => boolean;
    readFileSync?: (...args: unknown[]) => string;
}) {
    vi.doMock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
            ...actual,
            ...(opts.existsSync !== undefined ? { existsSync: opts.existsSync } : {}),
            ...(opts.readFileSync !== undefined ? { readFileSync: opts.readFileSync } : {}),
        };
    });
    return await import('../shared-state-path.js');
}

describe('readFromDotenv — parsing branches (via getSharedStatePath .env fallback)', () => {
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

    test('skips comment lines (L30 startsWith "#") and finds the valid line', async () => {
        // L30: `if (trimmed.startsWith('#') || !trimmed) continue;` — comment arm
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => '# this is a comment\nROOSYNC_SHARED_PATH=/after/comment\n',
        });
        expect(getSharedStatePath()).toBe('/after/comment');
    });

    test('skips empty lines (L30 !trimmed arm)', async () => {
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => '\n   \nROOSYNC_SHARED_PATH=/after/blank\n',
        });
        expect(getSharedStatePath()).toBe('/after/blank');
    });

    test('skips lines without "=" (L32 eqIndex === -1)', async () => {
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => 'NO_EQUALS_HERE\nROOSYNC_SHARED_PATH=/after/noeq\n',
        });
        expect(getSharedStatePath()).toBe('/after/noeq');
    });

    test('skips lines where key !== ROOSYNC_SHARED_PATH (L34)', async () => {
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => 'OTHER_KEY=whatever\nROOSYNC_SHARED_PATH=/after/mismatch\n',
        });
        expect(getSharedStatePath()).toBe('/after/mismatch');
    });

    test('strips surrounding double quotes (L37-39)', async () => {
        // L37: value.startsWith('"') && value.endsWith('"')
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => 'ROOSYNC_SHARED_PATH="/quoted/double"\n',
        });
        expect(getSharedStatePath()).toBe('/quoted/double');
    });

    test('strips surrounding single quotes (L38-39)', async () => {
        // L38: value.startsWith("'") && value.endsWith("'")
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => "ROOSYNC_SHARED_PATH='/quoted/single'\n",
        });
        expect(getSharedStatePath()).toBe('/quoted/single');
    });

    test('empty value → readFromDotenv returns null (L41 value || null) → getSharedStatePath throws', async () => {
        // L41: `return value || null;` — empty string is falsy → null
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => 'ROOSYNC_SHARED_PATH=\n',
        });
        expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });

    test('readFileSync throws → catch (L43-45) → returns null → getSharedStatePath throws', async () => {
        // L43-45: catch block swallows the error, returns null
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => {
                throw new Error('EACCES: permission denied');
            },
        });
        expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });

    test('.env existsSync false → readFromDotenv returns null at L26 (early return)', async () => {
        // L26: `if (!existsSync(envPath)) return null;` — exercised via the throw path
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => false,
        });
        expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });

    test('.env has content but NO ROOSYNC_SHARED_PATH line → loop exhausts → returns null (b19 L42)', async () => {
        // The for-loop iterates all lines, none match key L34 → loop completes normally
        // (b19[0]) → falls through to `return null;` at L46 → getSharedStatePath throws.
        const { getSharedStatePath } = await importWithFsMock({
            existsSync: () => true,
            readFileSync: () => 'OTHER_KEY=foo\nANOTHER=bar\n',
        });
        expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });
});

describe('tryGetSharedStatePath — #1918 safe variant (L83-89)', () => {
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

    test('returns the path string when getSharedStatePath succeeds (L84-85)', async () => {
        // L84-85: try { return getSharedStatePath(); } — success arm
        process.env.ROOSYNC_SHARED_PATH = '/safe/resolved/path';
        const { tryGetSharedStatePath } = await import('../shared-state-path.js');
        expect(tryGetSharedStatePath()).toBe('/safe/resolved/path');
    });

    test('returns null when getSharedStatePath throws (L86-87 catch)', async () => {
        // L86-87: catch { return null; } — no env var AND no .env → throws → caught
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return { ...actual, existsSync: () => false };
        });
        const { tryGetSharedStatePath } = await import('../shared-state-path.js');
        expect(tryGetSharedStatePath()).toBeNull();
    });
});

describe('isSharedPathAccessible — #1918 GDrive probe (L95-103)', () => {
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

    test('returns false when shared path cannot be resolved (L96-97 null → false)', async () => {
        // tryGetSharedStatePath() → null → `if (!sharedPath) return false;`
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return { ...actual, existsSync: () => false };
        });
        const { isSharedPathAccessible } = await import('../shared-state-path.js');
        expect(isSharedPathAccessible()).toBe(false);
    });

    test('returns true when path resolves and existsSync succeeds (L98-99)', async () => {
        // Env var set (path resolves without .env) → existsSync(sharedPath) === true
        process.env.ROOSYNC_SHARED_PATH = '/some/online/path';
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return { ...actual, existsSync: () => true };
        });
        const { isSharedPathAccessible } = await import('../shared-state-path.js');
        expect(isSharedPathAccessible()).toBe(true);
    });

    test('returns false when path resolves but existsSync returns false (L99)', async () => {
        process.env.ROOSYNC_SHARED_PATH = '/some/offline/path';
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return { ...actual, existsSync: () => false };
        });
        const { isSharedPathAccessible } = await import('../shared-state-path.js');
        expect(isSharedPathAccessible()).toBe(false);
    });

    test('returns false when existsSync throws (L100-101 catch)', async () => {
        // L100-101: catch { return false; } — existsSync throws (e.g. permission)
        process.env.ROOSYNC_SHARED_PATH = '/some/protected/path';
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: () => {
                    throw new Error('EACCES');
                },
            };
        });
        const { isSharedPathAccessible } = await import('../shared-state-path.js');
        expect(isSharedPathAccessible()).toBe(false);
    });
});
