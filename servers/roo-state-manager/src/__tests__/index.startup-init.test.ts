/**
 * Tests for 511396f0: MCP startup blocking fix
 *
 * Verifies:
 * 1. startBackgroundInit uses oninitialized callback (not setImmediate)
 * 2. 5s fallback fires when oninitialized is never called
 * 3. init starts immediately when oninitialized fires
 * 4. init promise resolves/rejects correctly
 * 5. ensureInitialized waits for init and re-throws errors
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

describe('511396f0 — MCP startup initialization timing', () => {

    describe('startBackgroundInit — oninitialized callback', () => {

        test('sets oninitialized on the server', () => {
            let oninitializedCallback: (() => void) | null = null;

            const mockServer = {
                _oninitialized: null as (() => void) | null,
                set oninitialized(cb: (() => void) | null) {
                    oninitializedCallback = cb;
                    this._oninitialized = cb;
                },
                get oninitialized() {
                    return this._oninitialized;
                },
            };

            // Simulate startBackgroundInit logic
            const startInit = vi.fn();
            mockServer.oninitialized = () => {
                startInit();
            };

            expect(mockServer.oninitialized).toBeInstanceOf(Function);
            expect(startInit).not.toHaveBeenCalled();
        });

        test('calls startInit when oninitialized fires', async () => {
            let capturedCallback: (() => void) | null = null;
            const startInit = vi.fn();

            // Simulate what startBackgroundInit does
            const mockServer = {
                set oninitialized(cb: (() => void) | null) {
                    capturedCallback = cb;
                },
            };
            mockServer.oninitialized = startInit;

            // Simulate SDK firing oninitialized after handshake
            expect(capturedCallback).not.toBeNull();
            capturedCallback!();

            expect(startInit).toHaveBeenCalledTimes(1);
        });
    });

    describe('startBackgroundInit — 5s fallback', () => {

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        test('fallback starts init after 5s if oninitialized never fires', () => {
            const startInit = vi.fn();
            let stateManager: unknown = null;

            // Replicate the fallback logic from startBackgroundInit
            const mockServer = {
                oninitialized: null as (() => void) | null,
            };
            mockServer.oninitialized = () => {
                startInit();
            };

            // Fallback timeout (same as production code)
            setTimeout(() => {
                if (!stateManager) {
                    startInit();
                }
            }, 5000);

            // Before 5s — no init
            vi.advanceTimersByTime(4999);
            expect(startInit).not.toHaveBeenCalled();

            // At 5s — fallback fires
            vi.advanceTimersByTime(1);
            expect(startInit).toHaveBeenCalledTimes(1);
        });

        test('fallback does NOT start init if oninitialized already fired', () => {
            const startInit = vi.fn();
            let stateManager: unknown = null;

            // Simulate oninitialized firing early
            const initPromise = new Promise<void>((resolve) => {
                startInit.mockImplementation(() => {
                    stateManager = { ready: true };
                    resolve();
                });
            });

            const mockServer = {
                oninitialized: null as (() => void) | null,
            };
            mockServer.oninitialized = () => {
                startInit();
            };

            // Fire oninitialized immediately
            mockServer.oninitialized!();

            // Fallback timeout
            setTimeout(() => {
                if (!stateManager) {
                    startInit();
                }
            }, 5000);

            // Advance past 5s — fallback should NOT fire
            vi.advanceTimersByTime(6000);

            // startInit called only once (from oninitialized), not from fallback
            expect(startInit).toHaveBeenCalledTimes(1);
        });
    });

    describe('initPromise — resolve/reject', () => {

        test('initPromise resolves when initialization succeeds', async () => {
            let _resolveInit!: () => void;
            let _rejectInit!: (error: Error) => void;

            const initPromise = new Promise<void>((resolve, reject) => {
                _resolveInit = resolve;
                _rejectInit = reject;
            });

            // Simulate successful init
            _resolveInit();

            await expect(initPromise).resolves.toBeUndefined();
        });

        test('initPromise rejects when initialization fails', async () => {
            let _resolveInit!: () => void;
            let _rejectInit!: (error: Error) => void;
            let _initError: Error | null = null;

            const initPromise = new Promise<void>((resolve, reject) => {
                _resolveInit = resolve;
                _rejectInit = reject;
            });

            // Simulate failed init
            const error = new Error('Qdrant connection failed');
            _initError = error;
            _rejectInit(error);

            await expect(initPromise).rejects.toThrow('Qdrant connection failed');
            expect(_initError).toBe(error);
        });
    });

    describe('ensureInitialized — waits and re-throws', () => {

        test('throws if init failed with stored error', async () => {
            let _initError: Error | null = new Error('StateManager creation failed');

            // Simulate ensureInitialized behavior
            const ensureInitialized = async () => {
                if (_initError) {
                    throw new Error(`MCP server initialization failed: ${_initError.message}`);
                }
            };

            await expect(ensureInitialized()).rejects.toThrow('MCP server initialization failed: StateManager creation failed');
        });

        test('returns stateManager after successful init', async () => {
            const mockStateManager = { getState: vi.fn() };
            let stateManager: unknown = null;
            let _initError: Error | null = null;
            let _resolveInit!: () => void;

            const initPromise = new Promise<void>((resolve) => {
                _resolveInit = resolve;
            });

            const ensureInitialized = async () => {
                if (!stateManager) {
                    await initPromise;
                }
                if (_initError) {
                    throw new Error(`MCP server initialization failed: ${_initError.message}`);
                }
                if (!stateManager) {
                    throw new Error('StateManager not available after initialization');
                }
                return stateManager;
            };

            // Start waiting before init completes
            const resultPromise = ensureInitialized();

            // Complete init
            stateManager = mockStateManager;
            _resolveInit();

            const result = await resultPromise;
            expect(result).toBe(mockStateManager);
        });
    });

    describe('#2993 — preload is non-fatal (transient GDrive/G: outage recovery)', () => {

        // #2993: a transient shared-state (GDrive/G:) hiccup during the RooSync
        // preload at the tail of initializeAsync() used to set _initError, which
        // ensureInitialized() then threw on EVERY subsequent call — disabling all
        // 16 tools for the entire session even after G: recovered. The preload is
        // a latency optimization, not a correctness requirement (getRooSyncService
        // is lazy and self-retries via #2017 backoff), so its failure is now caught
        // and logged as a warning rather than failing init.

        test('preload failure does NOT set _initError and init still succeeds', async () => {
            let _initError: Error | null = null;
            let _resolveInit!: () => void;
            const initPromise = new Promise<void>((resolve) => {
                _resolveInit = resolve;
            });
            const stateManager = { ready: true };

            // Replicate the tail of initializeAsync(): preload wrapped non-fatal.
            const preloadFails = new Error('ENOENT: G:\\ not mounted');
            const initializeTail = async () => {
                try {
                    throw preloadFails; // simulate the dynamic import + preload throwing
                } catch {
                    // non-fatal: warn only, do NOT set _initError
                }
                _resolveInit();
            };

            const ensureInitialized = async () => {
                await initPromise;
                if (_initError) {
                    throw new Error(`MCP server initialization failed: ${_initError.message}`);
                }
                return stateManager;
            };

            await initializeTail();
            const result = await ensureInitialized();

            // _initError was never set despite the preload throwing — init succeeded.
            expect(_initError).toBeNull();
            expect(result).toBe(stateManager);
        });

        test('preload success path is unchanged (still resolves init)', async () => {
            let _initError: Error | null = null;
            let _resolveInit!: () => void;
            const initPromise = new Promise<void>((resolve) => {
                _resolveInit = resolve;
            });
            const stateManager = { ready: true };

            const initializeTail = async () => {
                try {
                    // preload would await getRooSyncService() here — succeeds
                } catch {
                    // unreachable on success path
                }
                _resolveInit();
            };

            const ensureInitialized = async () => {
                await initPromise;
                if (_initError) {
                    throw new Error(`MCP server initialization failed: ${_initError.message}`);
                }
                return stateManager;
            };

            await initializeTail();
            const result = await ensureInitialized();

            expect(_initError).toBeNull();
            expect(result).toBe(stateManager);
        });
    });

    describe('#2993(b) — _initError recovers via one-shot retry after a transient failure', () => {

        // #2993(b): complement to fix (a). Even with the preload made non-fatal, a
        // genuine failure elsewhere in initializeAsync() (e.g. StateManager construction
        // throwing on a transient env problem) sets _initError, and the existing code
        // never cleared it. After fix (b), ensureInitialized() launches a one-shot retry
        // gated by a 30s cooldown — concurrent callers share the same retry. Success
        // clears _initError; failure leaves it set (and the cooldown resets).

        // Mirror of the production gate: retry only if cooldown elapsed AND no retry in flight.
        const COOLDOWN_MS = 30_000;

        function buildEnsureInitialized(params: {
            initialError: Error;
            retryImpl: () => Promise<{ stateManager: unknown }>;
        }) {
            let _initError: Error | null = params.initialError;
            let _resolveInit!: () => void;
            let _rejectInit!: (error: Error) => void;
            // In production the initial init failure runs through startBackgroundInit →
            // catch → _initError = error; _rejectInit(error). The harness replicates this
            // by settling the promise with the initial error (rejection), so awaiters
            // unblock immediately.
            let _initPromise = new Promise<void>((_resolve, reject) => {
                // Capture the resolve/reject for the retry path; settle the initial one.
                _resolveInit = () => {};
                _rejectInit = reject;
            });
            _rejectInit(params.initialError);
            // Swallow the unhandled rejection (it represents the logged failure).
            _initPromise.catch(() => {});
            let _initRetryPromise: Promise<void> | null = null;
            let _lastInitRetryAt = 0;
            let stateManager: unknown = null;

            const ensureInitialized = async () => {
                if (!stateManager) {
                    try {
                        await _initPromise;
                    } catch {
                        // _initError is set; retry path below handles the recovery.
                    }
                }
                if (_initError) {
                    const now = Date.now();
                    if (
                        _initRetryPromise === null &&
                        now - _lastInitRetryAt >= COOLDOWN_MS
                    ) {
                        _lastInitRetryAt = now;
                        _initPromise = new Promise<void>((resolve, reject) => {
                            _resolveInit = resolve;
                            _rejectInit = reject;
                        });
                        _initRetryPromise = params.retryImpl()
                            .then((res) => {
                                stateManager = res.stateManager;
                                _initError = null; // cleared on success only
                                _resolveInit();
                            })
                            .catch((error: Error) => {
                                _initError = error;
                                _rejectInit(error);
                            })
                            .finally(() => {
                                _initRetryPromise = null;
                            });
                        try {
                            await _initPromise;
                        } catch {
                            // Retry-side rejection — _initError carries the cause,
                            // the final check below will throw the wrapped message.
                        }
                    } else if (_initRetryPromise !== null) {
                        try {
                            await _initPromise;
                        } catch {
                            // Same as above for the concurrent-share path.
                        }
                    }
                }
                if (_initError) {
                    throw new Error(`MCP server initialization failed: ${_initError.message}`);
                }
                if (!stateManager) {
                    throw new Error('StateManager not available after initialization');
                }
                return stateManager;
            };

            return { ensureInitialized, getError: () => _initError, getLastRetryAt: () => _lastInitRetryAt };
        }

        test('successful retry clears _initError and returns stateManager', async () => {
            const initialErr = new Error('G:\\.shared-state temporarily unreachable');
            const newStateManager = { recovered: true };

            const { ensureInitialized, getError } = buildEnsureInitialized({
                initialError: initialErr,
                retryImpl: async () => {
                    // Simulate G: coming back online — retry succeeds.
                    return { stateManager: newStateManager };
                },
            });

            const result = await ensureInitialized();

            expect(result).toBe(newStateManager);
            expect(getError()).toBeNull();
        });

        test('failed retry leaves _initError set and still throws', async () => {
            const initialErr = new Error('first failure');
            const retryErr = new Error('second failure');

            const { ensureInitialized, getError } = buildEnsureInitialized({
                initialError: initialErr,
                retryImpl: async () => {
                    throw retryErr;
                },
            });

            await expect(ensureInitialized()).rejects.toThrow('MCP server initialization failed: second failure');
            expect(getError()).toBe(retryErr);
        });

        test('cooldown blocks back-to-back retries: only one retry fires per cooldown window', async () => {
            // The first call to ensureInitialized() sees _initError set, fires a retry,
            // and updates _lastInitRetryAt. A subsequent call while the retry is still
            // in flight (or right after it succeeded) must NOT fire a *second* retry
            // — either because _initRetryPromise is non-null (concurrent) or because
            // cooldown hasn't elapsed.
            //
            // We verify both: (a) the gate fires exactly once on the first call, and
            // (b) _lastInitRetryAt is updated to a recent timestamp.
            let retryCalls = 0;
            const harness = buildEnsureInitialized({
                initialError: new Error('first transient'),
                retryImpl: async () => {
                    retryCalls++;
                    return { stateManager: { ok: true } };
                },
            });

            const before = Date.now();
            await harness.ensureInitialized();
            const after = Date.now();

            expect(retryCalls).toBe(1);
            const lastRetryAt = harness.getLastRetryAt();
            expect(lastRetryAt).toBeGreaterThanOrEqual(before);
            expect(lastRetryAt).toBeLessThanOrEqual(after);
        });

        test('concurrent callers share the same retry (no duplicate firings)', async () => {
            // Two concurrent ensureInitialized() calls while _initError is set must
            // share the same _initRetryPromise — only one retryImpl invocation.
            let retryCalls = 0;
            let resolveRetry!: () => void;
            const retryReturned = new Promise<void>((resolve) => {
                resolveRetry = resolve;
            });

            const harness = buildEnsureInitialized({
                initialError: new Error('initial'),
                retryImpl: async () => {
                    retryCalls++;
                    await retryReturned;
                    return { stateManager: { ok: true } };
                },
            });

            // Fire two concurrent calls.
            const c1 = harness.ensureInitialized();
            const c2 = harness.ensureInitialized();
            // Yield so both callers reach the retry-check.
            await Promise.resolve();
            await Promise.resolve();
            // Resolve the retry.
            resolveRetry();
            const [r1, r2] = await Promise.all([c1, c2]);

            expect(retryCalls).toBe(1); // shared: only one retryImpl invocation
            expect(r1).toEqual({ ok: true });
            expect(r2).toEqual({ ok: true });
        });

        test('retry stops awaiting after init succeeds (no infinite loop)', async () => {
            const initialErr = new Error('initial');
            let resolveRetry!: () => void;
            const retryReturned = new Promise<void>((resolve) => {
                resolveRetry = resolve;
            });

            const { ensureInitialized, getError } = buildEnsureInitialized({
                initialError: initialErr,
                retryImpl: async () => {
                    await retryReturned;
                    return { stateManager: { recovered: true } };
                },
            });

            // Start the call but don't await — will hang on retry until we resolve.
            const pending = ensureInitialized();
            // Let microtasks flow so the retry kicks off.
            await Promise.resolve();
            // Now resolve the retry.
            resolveRetry();
            const result = await pending;

            expect(result).toEqual({ recovered: true });
            expect(getError()).toBeNull();
        });
    });
});

/**
 * #2993 — the guard must be asserted on the SHIPPED source, not on a copy of it.
 *
 * The pattern-replication tests above document the intended contract, but they
 * define their own local `initializeTail`/`_initError` and would keep passing if
 * someone re-added `_initError = e` inside the real catch — the gap both reviewers
 * flagged on #913. These three assertions read `src/index.ts` itself and close it.
 *
 * `initializeAsync` is private and pulls the whole server graph in, so exercising
 * it for real is out of reach from a unit test; reading the file is weaker than a
 * behavioural test, and this comment is the honest statement of that. What it does
 * buy: it fails if the guard is removed or neutered, which is the regression that
 * cost ai-01 a full session on 2026-07-28.
 *
 * Verified against both broken shapes before being proposed:
 *   - bare `await preloadRooSync()` with no try  → first assertion fails
 *   - catch that rethrows                        → second assertion fails
 */
describe('#2993 — preload guard asserted on the real index.ts source', () => {

    const source = readFileSync(
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'utf-8'
    );

    test('the preload call sits inside a try/catch', () => {
        expect(source).toMatch(
            /try\s*\{[\s\S]{0,400}?await preloadRooSync\(\);[\s\S]{0,400}?\}\s*catch/
        );
    });

    test('the catch swallows the failure — no rethrow, no _initError', () => {
        const catchBlock = source.match(
            /await preloadRooSync\(\);[\s\S]*?\}\s*catch\s*\([\s\S]*?\)\s*\{([\s\S]*?)\n\s*\}/
        );
        expect(catchBlock).not.toBeNull();
        const body = catchBlock![1];

        expect(body).toMatch(/logger\.warn/);
        expect(body).not.toMatch(/\bthrow\b/);
        expect(body).not.toMatch(/_initError/);
    });

    test('genuine initialization failures still set _initError', () => {
        // The guard must stay narrow: it neutralises the preload only. A real
        // StateManager failure must keep failing loudly.
        expect(source).toMatch(/this\._initError\s*=/);
    });
});

/**
 * #2993(c) — initializeNotificationSystem must NOT re-enter ensureInitialized().
 *
 * ai-01 #914 CHANGES_REQUESTED found the deadlock: initializeAsync (L278) calls
 * initializeNotificationSystem (L322), which called ensureInitialized (L370).
 * Today harmless (stateManager truthy → the _initPromise await is skipped; _initError
 * null → no throw), but once an _initError retry path exists (#914's whole purpose),
 * the re-entrant call awaits _initPromise — which only resolves when this very
 * initializeAsync() finishes, and it is blocked at that call = circular wait. The
 * regime flips from "throws on every call" (diagnosable) to "never responds"
 * (indistinguishable from a dead machine).
 *
 * Fix (c): initializeNotificationSystem is only ever called from initializeAsync (L278),
 * where this.stateManager is already constructed (L265). Use it directly — no gate.
 *
 * Like the preload guard above, this is asserted on the SHIPPED source because
 * initializeNotificationSystem is private and pulls the notification graph in; a
 * behavioural test is out of reach. The source read is weaker but fails the moment
 * the re-entrant call is re-added, which is the regression that deadlocks the fleet
 * once #914 (or any retry) lands.
 */
describe('#2993(c) — no re-entrant ensureInitialized() from initializeNotificationSystem', () => {

    const source = readFileSync(
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'utf-8'
    );

    test('initializeNotificationSystem does not call ensureInitialized()', () => {
        // Isolate the method body so the assertion is scoped, not repo-wide. Match the
        // actual call form (`await this.ensureInitialized()`) — the method's comments
        // reference the symbol by name, so a bare substring match would false-positive.
        const method = source.match(/private async initializeNotificationSystem\(\)[\s\S]*?\n    \}/);
        expect(method).not.toBeNull();
        const body = method![0];
        expect(body).not.toMatch(/await\s+this\.ensureInitialized\(\)/);
    });

    test('the notification step reads this.stateManager directly (the non-re-entrant path)', () => {
        const method = source.match(/private async initializeNotificationSystem\(\)[\s\S]*?\n    \}/);
        expect(method).not.toBeNull();
        const body = method![0];
        // Direct ref, not a gate call — with a defensive null guard (the caller invariant).
        expect(body).toMatch(/const sm = this\.stateManager/);
        expect(body).toMatch(/if \(!sm\)/);
    });

    describe('logic replication — why re-entrance deadlocks once a retry exists', () => {
        // Models the #914 retry shape (not yet in main) to document WHY the structural
        // fix in (c) matters. The re-entrant ensureInitialized() consults _initPromise;
        // under a one-shot retry that promise is settled only by the retry's own success,
        // which is blocked at the re-entrant call. Direct stateManager access breaks the cycle.

        test('re-entrant gate hangs when _initPromise is held by the caller (the #914 deadlock)', async () => {
            const stateManager = { getState: vi.fn() };
            const _initPromise = new Promise<void>(() => { /* never settles: retry blocked */ });
            const _initError: Error | null = new Error('transient');
            const _initRetryPromise: Promise<unknown> | null = Promise.resolve(); // retry in flight

            // The retry-era ensureInitialized gate (models #914's added branch).
            const ensureInitialized = async () => {
                if (!stateManager) await _initPromise;
                if (_initError && _initRetryPromise !== null) await _initPromise; // ← circular wait
                if (_initError) throw new Error('locked');
                return stateManager;
            };

            // OLD L370: const sm = await this.ensureInitialized();
            const oldNotificationStep = async () => ensureInitialized();

            const winner = await Promise.race([
                oldNotificationStep().then(() => 'done' as const),
                new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
            ]);
            // OLD shape hangs → timeout wins. This is the deadlock #914 would ship without (c).
            expect(winner).toBe('timeout');
        });

        test('direct stateManager access completes regardless of _initPromise/_initError (the fix)', async () => {
            const state = { conversationCache: {} };
            const stateManager = { getState: vi.fn(() => state) };
            const _initPromise = new Promise<void>(() => { /* never settles — irrelevant now */ });
            const _initError: Error | null = new Error('transient');

            // FIXED L370: const sm = this.stateManager; — no gate, no await.
            const fixedNotificationStep = async () => {
                const sm = stateManager;
                if (!sm) throw new Error('invariant');
                return sm.getState();
            };

            const winner = await Promise.race([
                fixedNotificationStep().then((s) => { expect(s).toBe(state); return 'done' as const; }),
                new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
            ]);
            expect(winner).toBe('done');
            // _initError being set no longer blocks the notification step.
            expect(_initError).not.toBeNull();
        });
    });
});

/**
 * #3001 item 2 — guard against re-introducing ensureInitialized() re-entrance from initializeAsync.
 *
 * #918 removed the only re-entrant path that ever existed (initializeAsync →
 * initializeNotificationSystem → ensureInitialized). #2993(c) guards the *callee*
 * (initializeNotificationSystem must not call ensureInitialized). This block guards the
 * *caller*: initializeAsync itself must never await this.ensureInitialized() — a direct call
 * there awaits _initPromise, which only resolves when initializeAsync returns, so the call is
 * blocked at itself = circular wait = the server never responds, indistinguishable from a dead
 * machine. That failure regime cost a full session on 2026-07-28.
 *
 * Little code for the highest-value lock in this file: the failure is silent and total.
 *
 * Like the #2993(c) guards above, this is asserted on the SHIPPED source because
 * initializeAsync is private and pulls the whole server graph in; a behavioural test is out of
 * reach. The source read is weaker than exercising the code, but it fails the moment the
 * re-entrant call is re-added directly in initializeAsync — the regression that deadlocks the
 * fleet.
 */
describe('#3001 item 2 — initializeAsync must not re-enter ensureInitialized()', () => {

    const source = readFileSync(
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'utf-8'
    );

    test('initializeAsync does not directly call ensureInitialized()', () => {
        // Isolate the method body so the assertion is scoped, not repo-wide. The call form is
        // `await this.ensureInitialized()` (comments reference the symbol by name, so a bare
        // substring match would false-positive — the same care #2993(c) took).
        const method = source.match(/private async initializeAsync\(\)[\s\S]*?\n    \}/);
        expect(method).not.toBeNull();
        const body = method![0];
        expect(body).not.toMatch(/await\s+this\.ensureInitialized\(\)/);
    });
});
