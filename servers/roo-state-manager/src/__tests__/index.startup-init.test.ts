/**
 * Tests for #1817: MCP startup blocking fix
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

describe('#1817 — MCP startup initialization timing', () => {

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
        // 15 tools for the entire session even after G: recovered. The preload is
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
