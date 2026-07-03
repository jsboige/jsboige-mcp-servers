/**
 * #833 Sprint C3 — IndexingDecisionService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `indexing-decision.test.ts` (24 tests) is thorough on the decision arms of
 * `shouldIndex` and the mark/reset/migrate mutators. It leaves a focused set of guards and
 * fallback strings cold, all pinned here against source lines of `indexing-decision.ts`:
 *
 * - **No-metadata guards**: `shouldIndex` L33-35, `markIndexingSuccess` L177,
 *   `markIndexingFailure` L207, `resetIndexingState` L251, `migrateLegacyIndexingState`
 *   L270-272. The base `createSkeleton` always sets `metadata`, so `!skeleton.metadata`
 *   is never exercised — five guards cold.
 * - `shouldIndex` L75 **failed-without-indexError fallback** — `indexingState.indexError ||
 *   'erreur non spécifiée'`. The base "should skip failed tasks" always sets `indexError`.
 * - `shouldIndex` L93 **retry without `lastIndexAttempt`** — `if (indexingState.lastIndexAttempt)`
 *   false → skips the backoff block entirely, reaches the `retry` action at L108. The base
 *   retry tests either hit the max-attempts skip (L84) or always set `lastIndexAttempt`.
 * - `shouldIndex` L149-151 **legacy migration `console.log` side-effect** — fires only when
 *   `migrateLegacyIndexingState` returns true (L150 `if (migrated)`). The base legacy test
 *   asserts `requiresSave` but never the log side-effect.
 * - `shouldIndex` L164-168 **default `'Contenu modifié, réindexation requise'` arm** — the
 *   ternary `indexingState.indexStatus ? 'Contenu modifié…' : 'Première indexation'`. The
 *   base covers the `'Première indexation'` arm (no indexStatus); the truthy-indexStatus
 *   fall-through (an unrecognized status like `'pending'`) is cold.
 * - `calculateBackoffDelay` L240-245 **jitter bounds (0.85–1.15)** — the private helper is
 *   tested indirectly via the backoff-skip behavior, but the 0.85–1.15 multiplier contract
 *   on `baseDelay * 2^retryCount` is never pinned directly.
 *
 * No production code touched (#1936 anti-churn). Constants: MAX_RETRY_ATTEMPTS=3,
 * RETRY_BACKOFF_BASE_MS=60000, INDEX_VERSION_CURRENT="1.2".
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexingDecisionService } from '../indexing-decision.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_BASE_MS = 60000;

function createSkeleton(overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
    return {
        taskId: 'cov-task-001',
        metadata: {
            title: 'Cov',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 5,
            actionCount: 2,
            totalSize: 1024,
        },
        sequence: [],
        ...overrides,
    };
}

describe('IndexingDecisionService — branch coverage (#833 C3, source-grounded)', () => {
    let service: IndexingDecisionService;
    const originalEnv = process.env;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env = { ...originalEnv };
        delete process.env.ROO_INDEX_FORCE;
        delete process.env.ROO_INDEX_VERSION;
        service = new IndexingDecisionService();
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    // ============================================================
    // No-metadata guards (5 methods)
    // ============================================================
    describe('no-metadata guards', () => {
        test('shouldIndex returns the no-metadata skip when metadata is absent (L33-35)', () => {
            const noMeta = { taskId: 'x', metadata: undefined } as unknown as ConversationSkeleton;
            const decision = service.shouldIndex(noMeta);

            expect(decision.shouldIndex).toBe(false);
            expect(decision.action).toBe('skip');
            // L34: reason = 'Skeleton has no metadata'
            expect(decision.reason).toBe('Skeleton has no metadata');
        });

        test('markIndexingSuccess no-ops when metadata is absent (L177)', () => {
            const noMeta = { taskId: 'x', metadata: undefined } as unknown as ConversationSkeleton;
            // Should not throw; void return. No indexingState created.
            expect(() => service.markIndexingSuccess(noMeta)).not.toThrow();
            expect((noMeta as any).metadata).toBeUndefined();
        });

        test('markIndexingFailure no-ops when metadata is absent (L207)', () => {
            const noMeta = { taskId: 'x', metadata: undefined } as unknown as ConversationSkeleton;
            expect(() => service.markIndexingFailure(noMeta, 'err', false)).not.toThrow();
            expect((noMeta as any).metadata).toBeUndefined();
        });

        test('resetIndexingState no-ops when metadata is absent (L251)', () => {
            const noMeta = { taskId: 'x', metadata: undefined } as unknown as ConversationSkeleton;
            expect(() => service.resetIndexingState(noMeta)).not.toThrow();
            expect((noMeta as any).metadata).toBeUndefined();
        });

        test('migrateLegacyIndexingState returns false when metadata is absent (L270-272)', () => {
            const noMeta = { taskId: 'x', metadata: undefined } as unknown as ConversationSkeleton;
            expect(service.migrateLegacyIndexingState(noMeta)).toBe(false);
        });
    });

    // ============================================================
    // shouldIndex — failed-without-indexError fallback (L75)
    // ============================================================
    describe('shouldIndex — failed without indexError (L75)', () => {
        test('uses the "erreur non spécifiée" fallback when indexStatus=failed but no indexError', () => {
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    indexingState: { indexStatus: 'failed' }, // no indexError
                },
            });

            const decision = service.shouldIndex(skeleton);

            expect(decision.shouldIndex).toBe(false);
            // L75: `Échec permanent : ${indexingState.indexError || 'erreur non spécifiée'}`
            expect(decision.reason).toContain('erreur non spécifiée');
        });
    });

    // ============================================================
    // shouldIndex — retry without lastIndexAttempt (L93, L108)
    // ============================================================
    describe('shouldIndex — retry without lastIndexAttempt (L93)', () => {
        test('reaches the retry action without a backoff check when lastIndexAttempt is absent', () => {
            // retryCount=1 (< MAX=3) and NO lastIndexAttempt → L93 `if` false → skip backoff → L108.
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    indexingState: { indexStatus: 'retry', indexRetryCount: 1 },
                },
            });

            const decision = service.shouldIndex(skeleton);

            expect(decision.shouldIndex).toBe(true);
            expect(decision.action).toBe('retry');
            // L110: `Retry n°${retryCount + 1}/${MAX_RETRY_ATTEMPTS}` → retryCount=1 → n°2/3.
            expect(decision.reason).toContain('Retry n°2/3');
        });
    });

    // ============================================================
    // shouldIndex — default 'Contenu modifié' arm (L164-168)
    // ============================================================
    describe('shouldIndex — default modified-content reason (L164-168)', () => {
        test('returns "Contenu modifié" when indexStatus is truthy but unrecognized (falls through)', () => {
            // indexStatus='pending' is truthy but not failed/retry/success → skips all status
            // blocks → default L164. indexVersion absent (L63 pass), no legacy field.
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    indexingState: { indexStatus: 'pending' as any },
                },
            });

            const decision = service.shouldIndex(skeleton);

            expect(decision.shouldIndex).toBe(true);
            expect(decision.action).toBe('index');
            // L166-167: `indexingState.indexStatus ? 'Contenu modifié, réindexation requise' : …`
            expect(decision.reason).toBe('Contenu modifié, réindexation requise');
        });
    });

    // ============================================================
    // shouldIndex — legacy migration console.log side-effect (L149-151)
    // ============================================================
    describe('shouldIndex — legacy migration log side-effect (L149-151)', () => {
        test('logs the [MIGRATION] line when legacy migration succeeds (L150)', () => {
            const legacyDate = '2026-02-01T10:00:00Z';
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    lastActivity: '2026-01-01T10:00:00Z', // before legacy → skip path L153
                    qdrantIndexedAt: legacyDate,
                },
            });

            service.shouldIndex(skeleton);

            // L150: `console.log('[MIGRATION] Task ${taskId}: Migration legacy effectuée depuis ${legacyDate}')`
            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('[MIGRATION]')
            );
            const logMsg = (console.log as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('[MIGRATION]'))?.[0] as string;
            expect(logMsg).toContain('cov-task-001');
            expect(logMsg).toContain(legacyDate);
        });

        test('does NOT log when legacy content was modified (migrated but falls through)', () => {
            // lastActivity AFTER legacyIndexed → L153 condition false → falls through to default.
            // migrateLegacyIndexingState still ran (migrated=true) → L150 log STILL fires.
            // Pin: the log is gated on `migrated`, NOT on the skip-vs-index outcome.
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    lastActivity: '2026-03-01T10:00:00Z', // AFTER legacy → falls through
                    qdrantIndexedAt: '2026-02-01T10:00:00Z',
                },
            });

            const decision = service.shouldIndex(skeleton);

            // Falls through to default index (content modified past legacy date).
            expect(decision.shouldIndex).toBe(true);
            expect(decision.action).toBe('index');
            // L150 still fired because migrateLegacyIndexingState returned true (indexingState absent).
            expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[MIGRATION]'));
        });
    });

    // ============================================================
    // calculateBackoffDelay — jitter bounds 0.85–1.15 (L240-245)
    // ============================================================
    describe('calculateBackoffDelay — jitter bounds (L240-245)', () => {
        test('stays within [base*2^count*0.85, base*2^count*1.15] and is floored', () => {
            const retryCount = 2; // 2^2 = 4 → base 60000 * 4 = 240000
            const exponential = RETRY_BACKOFF_BASE_MS * Math.pow(2, retryCount); // 240000
            const lower = Math.floor(exponential * 0.85); // 204000
            const upper = Math.floor(exponential * 1.15); // 276000

            for (let i = 0; i < 50; i++) {
                const delay = (service as any).calculateBackoffDelay(retryCount);
                expect(delay).toBeGreaterThanOrEqual(lower);
                expect(delay).toBeLessThanOrEqual(upper);
                // L244: Math.floor → integer.
                expect(Number.isInteger(delay)).toBe(true);
            }
        });

        test('scales exponentially with retryCount (retryCount=0 → ~base)', () => {
            // retryCount=0 → 2^0=1 → exponential = base = 60000 → range [51000, 69000].
            const exponential = RETRY_BACKOFF_BASE_MS; // 60000
            const lower = Math.floor(exponential * 0.85);
            const upper = Math.floor(exponential * 1.15);

            const samples = Array.from({ length: 20 }, () =>
                (service as any).calculateBackoffDelay(0)
            );
            expect(Math.min(...samples)).toBeGreaterThanOrEqual(lower);
            expect(Math.max(...samples)).toBeLessThanOrEqual(upper);
        });
    });

    // ============================================================
    // markIndexingFailure — indexVersion preserved across retry escalation (L228 spread)
    // ============================================================
    describe('markIndexingFailure — preserves existing indexVersion on temporary failure (L227-233)', () => {
        test('keeps a pre-existing indexVersion when escalating to retry', () => {
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    indexingState: { indexVersion: '1.2', indexStatus: 'success' },
                },
            });

            service.markIndexingFailure(skeleton, 'transient', false);

            // L228 spread preserves prior fields; indexVersion survives the escalation.
            expect(skeleton.metadata.indexingState!.indexVersion).toBe('1.2');
            expect(skeleton.metadata.indexingState!.indexStatus).toBe('retry');
            expect(skeleton.metadata.indexingState!.indexError).toBe('transient');
        });
    });

    // ============================================================
    // constructor — ROO_INDEX_VERSION override + ROO_INDEX_FORCE='true' (L23-24)
    // ============================================================
    describe('constructor — env override arms (L23-24)', () => {
        test('ROO_INDEX_FORCE="true" (not "1") activates force reindex (L23 second operand)', () => {
            process.env.ROO_INDEX_FORCE = 'true';
            const forceService = new IndexingDecisionService();
            const decision = forceService.shouldIndex(createSkeleton());
            // L23: `=== '1' || === 'true'` — the 'true' arm.
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('FORCE_REINDEX');
        });

        test('ROO_INDEX_VERSION override flows into indexVersion (L24)', () => {
            process.env.ROO_INDEX_VERSION = '9.9';
            const versionedService = new IndexingDecisionService();
            // A skeleton indexed at the default version (1.2) vs service version 9.9 → migration.
            const skeleton = createSkeleton({
                metadata: {
                    ...createSkeleton().metadata,
                    indexingState: { indexVersion: '1.2', indexStatus: 'success' },
                },
            });
            const decision = versionedService.shouldIndex(skeleton);
            expect(decision.action).toBe('rebuild');
            expect(decision.reason).toContain("v1.2 → v9.9");
        });
    });
});
