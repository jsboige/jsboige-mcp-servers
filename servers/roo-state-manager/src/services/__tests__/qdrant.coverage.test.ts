/**
 * #833 Sprint C3 — qdrant.ts branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `qdrant.test.ts` (19 tests) covers the happy paths well: singleton
 * (get/reset/undefined-env), timeout env+default, getCollectionSize
 * (points_count/undefined→0/error→1/default-name/env-name), isLargeCollection
 * (>5M / <=5M / exactly-5M boundary).
 *
 * It leaves a cluster of subtle `||`-vs-`??` and `parseInt`-permissiveness branches
 * cold, however — each one a regression trap if the defensive operator were ever
 * "modernized" to its nullish-coalescing twin:
 *
 * - **`parseInt(process.env.QDRANT_TIMEOUT_MS || '15000')` (L43)**: base tests
 *   `'30000'` (env) and absent (default 15000). Never tests:
 *   - `QDRANT_TIMEOUT_MS = 'garbage'` (truthy non-numeric) → `||` keeps it → `parseInt`
 *     returns **NaN** (the `||` does NOT guard against non-numeric, only falsy).
 *   - `QDRANT_TIMEOUT_MS = ''` (empty string) → `'' || '15000'` → 15000 (`||` catches
 *     empty; `??` would NOT — empty is not nullish). The deliberate `||` choice.
 *   - `QDRANT_TIMEOUT_MS = '15000abc'` → parseInt parses partially → 15000.
 * - **`collection?.points_count || 0` (L72)**: base tests points_count present and
 *   `{}` (undefined). Never tests:
 *   - `collection = null` → the `?.` optional-chain short-circuits → undefined → `|| 0`.
 *   - `points_count = 0` → `0 || 0` → 0 (pin the `||` contract at the zero boundary;
 *     `??` would behave identically here, but the guard is `||`).
 *   - `points_count = null` → `null || 0` → 0.
 * - **`QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index'` (L68)**: base tests
 *   default + env-set. Never tests empty-string `''` → `||` falls to default (`??` would
 *   keep `''` → a collection named '' would be queried).
 * - **console.log side-effects (L47, L60)**: format never pinned. getQdrantClient logs
 *   `Qdrant client initialized with URL: <url>, timeout: <N>ms`; resetQdrantClient logs
 *   `Qdrant client reset.`. A change in either message is undetected by the base.
 *
 * SKIP (evidence): `testQdrantConnection` (L8-25) is a private debug helper, NOT
 * exported — it cannot be imported or invoked. It is dead in the test surface. Its
 * `fetch` call and `apiKey || ''` (L16) are unreachable via the public API.
 *
 * Strategy: same vi.mock pattern as the base (mock QdrantClient constructor, dynamic
 * import, resetQdrantClient in beforeEach). console.log spied per-test. No production
 * code touched (#1936 anti-churn).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockQdrantClient = { getCollection: vi.fn() };

vi.mock('@qdrant/js-client-rest', () => ({
    QdrantClient: vi.fn(() => mockQdrantClient),
}));

describe('qdrant — branch coverage (#833 C3, source-grounded)', () => {
    let getQdrantClient: () => any;
    let resetQdrantClient: () => void;
    let getCollectionSize: () => Promise<number>;
    let isLargeCollection: () => Promise<boolean>;
    let MockedQdrantClient: ReturnType<typeof vi.fn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        mockQdrantClient.getCollection.mockReset();
        process.env.QDRANT_URL = 'https://qdrant.example.com';
        process.env.QDRANT_API_KEY = 'test-key';
        delete process.env.QDRANT_TIMEOUT_MS;
        delete process.env.QDRANT_COLLECTION_NAME;

        const qdrantModule = await import('../qdrant.js');
        const qdrantClientModule = await import('@qdrant/js-client-rest');
        getQdrantClient = qdrantModule.getQdrantClient;
        resetQdrantClient = qdrantModule.resetQdrantClient;
        getCollectionSize = qdrantModule.getCollectionSize;
        isLargeCollection = qdrantModule.isLargeCollection;
        MockedQdrantClient = qdrantClientModule.QdrantClient;

        resetQdrantClient();
        (MockedQdrantClient as ReturnType<typeof vi.fn>).mockClear();

        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    // ============================================================
    // L43 — parseInt permissiveness + || vs ?? on QDRANT_TIMEOUT_MS
    // ============================================================
    describe('QDRANT_TIMEOUT_MS resolution — || guard + parseInt (L43)', () => {
        test('garbage non-numeric value passes the || guard and parseInt yields NaN (L43 — || does not guard non-numeric)', () => {
            // 'garbage' is truthy → || keeps it → parseInt('garbage') === NaN.
            // This documents that the || guard only catches FALSY (absent/empty), not non-numeric.
            process.env.QDRANT_TIMEOUT_MS = 'garbage';
            resetQdrantClient();
            getQdrantClient();

            const configArg = (MockedQdrantClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(configArg.timeout).toBeNaN();
        });

        test('empty-string "" falls back to 15000 because || (not ??) — empty is falsy (L43)', () => {
            // '' is falsy → '' || '15000' → '15000' → 15000.
            // If modernized to ??, '' (not nullish) would survive → parseInt('') === NaN.
            process.env.QDRANT_TIMEOUT_MS = '';
            resetQdrantClient();
            getQdrantClient();

            const configArg = (MockedQdrantClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(configArg.timeout).toBe(15000);
        });

        test('partial-numeric "15000abc" parses permissively to 15000 (L43 parseInt)', () => {
            // parseInt stops at the first non-numeric char → 15000.
            process.env.QDRANT_TIMEOUT_MS = '15000abc';
            resetQdrantClient();
            getQdrantClient();

            const configArg = (MockedQdrantClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(configArg.timeout).toBe(15000);
        });

        test('a legit numeric override still wins over the default (L43 first operand)', () => {
            process.env.QDRANT_TIMEOUT_MS = '45000';
            resetQdrantClient();
            getQdrantClient();

            const configArg = (MockedQdrantClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(configArg.timeout).toBe(45000);
        });
    });

    // ============================================================
    // L72 — collection?. optional chain + || on points_count
    // ============================================================
    describe('getCollectionSize — collection?. + points_count || (L72)', () => {
        test('collection=null short-circuits the ?. chain → 0 (L72 collection?.points_count)', async () => {
            // The base only tests {points_count:N} and {} (undefined). getCollection returning
            // null itself is cold — the ?. protects it.
            mockQdrantClient.getCollection.mockResolvedValue(null);

            const size = await getCollectionSize();

            expect(size).toBe(0);
        });

        test('points_count=0 yields 0 — || contract at the zero boundary (L72)', async () => {
            // 0 || 0 → 0. Both || and ?? give 0 here, but the guard is ||; pin the zero case.
            mockQdrantClient.getCollection.mockResolvedValue({ points_count: 0 });

            const size = await getCollectionSize();

            expect(size).toBe(0);
        });

        test('points_count=null → null || 0 → 0 (L72 ||)', async () => {
            mockQdrantClient.getCollection.mockResolvedValue({ points_count: null });

            const size = await getCollectionSize();

            expect(size).toBe(0);
        });
    });

    // ============================================================
    // L68 — QDRANT_COLLECTION_NAME || default — empty-string fallback
    // ============================================================
    describe('QDRANT_COLLECTION_NAME — || vs ?? on empty string (L68)', () => {
        test('empty-string "" falls back to the default collection name (L68 — || catches empty)', async () => {
            // '' is falsy → '' || 'roo_tasks_semantic_index' → default.
            // If modernized to ??, '' would survive → getCollection('') would be called (bug).
            process.env.QDRANT_COLLECTION_NAME = '';
            mockQdrantClient.getCollection.mockResolvedValue({ points_count: 1 });

            await getCollectionSize();

            expect(mockQdrantClient.getCollection).toHaveBeenCalledWith('roo_tasks_semantic_index');
            expect(mockQdrantClient.getCollection).not.toHaveBeenCalledWith('');
        });
    });

    // ============================================================
    // L47 — getQdrantClient console.log format pin
    // ============================================================
    describe('getQdrantClient console.log side-effect (L47)', () => {
        test('logs "Qdrant client initialized with URL: <url>, timeout: <N>ms" on first init (L47)', () => {
            process.env.QDRANT_URL = 'https://my-qdrant.example.com';
            process.env.QDRANT_TIMEOUT_MS = '42000';
            resetQdrantClient();
            getQdrantClient();

            // The format string is load-bearing for ops grep — pin it exactly.
            const msg = consoleLogSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
            expect(msg).toContain('Qdrant client initialized with URL: https://my-qdrant.example.com, timeout: 42000ms');
        });

        test('does NOT log the init message on a second call (singleton — L35 if !client guard)', () => {
            getQdrantClient();
            consoleLogSpy.mockClear(); // clear after first init

            getQdrantClient(); // singleton path — no re-init, no log

            expect(consoleLogSpy).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // L60 — resetQdrantClient console.log
    // ============================================================
    describe('resetQdrantClient console.log side-effect (L60)', () => {
        test('logs "Qdrant client reset." (L60)', () => {
            resetQdrantClient();

            const msg = consoleLogSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
            expect(msg).toContain('Qdrant client reset.');
        });
    });

    // ============================================================
    // isLargeCollection — boundary coherence via getCollectionSize error-path (L83 ← L66-75)
    // ============================================================
    describe('isLargeCollection — error-path propagation (L82-84 via L66-75)', () => {
        test('returns false when getCollectionSize degrades to 1 on error (L74 default → L84 size > 5M is false)', async () => {
            // getCollectionSize returns 1 on error (L74) → 1 > 5_000_000 is false.
            // This pins that an unreachable collection is NOT treated as "large".
            mockQdrantClient.getCollection.mockRejectedValue(new Error('down'));

            const result = await isLargeCollection();

            expect(result).toBe(false);
        });
    });
});
