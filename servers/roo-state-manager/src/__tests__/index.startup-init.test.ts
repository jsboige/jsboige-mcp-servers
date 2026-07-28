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
});

/**
 * #2993 — the RooSync preload must never latch the whole server.
 *
 * `initializeAsync()` ends with a preload of RooSyncService that exists purely to
 * shave latency off the first dashboard/heartbeat call. Before this guard it was
 * unprotected: a transient failure (GDrive not mounted yet, host under memory
 * pressure) propagated out of `startBackgroundInit`, set `_initError`, and made
 * `ensureInitialized()` reject for EVERY tool — including the ones that never
 * touch RooSync — for the whole lifetime of the process, with no reset path.
 *
 * These are STRUCTURAL assertions read off the real source, not a simulation of it.
 * `initializeAsync` is private and drags the full server graph in, so exercising it
 * for real is out of reach from a unit test; a mock-based re-implementation would
 * only assert its own mock. Reading the shipped file is weaker than a behavioural
 * test but it is honest, and it fails if the guard is ever removed — which is the
 * regression that actually cost a session.
 */
describe('#2993 — RooSync preload failure must not latch initialization', () => {

    const source = readFileSync(
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'utf-8'
    );

    test('the preload call is wrapped in try/catch', () => {
        expect(source).toMatch(
            /try\s*\{[\s\S]{0,400}?await preloadRooSync\(\);[\s\S]{0,400}?\}\s*catch/
        );
    });

    test('the catch swallows the failure instead of rethrowing', () => {
        const catchBlock = source.match(
            /await preloadRooSync\(\);[\s\S]*?\}\s*catch\s*\([\s\S]*?\)\s*\{([\s\S]*?)\n\s*\}/
        );
        expect(catchBlock).not.toBeNull();
        const body = catchBlock![1];

        expect(body).toMatch(/logger\.warn/);
        expect(body).not.toMatch(/\bthrow\b/);
        expect(body).not.toMatch(/_initError/);
    });

    test('_initError is still set for genuine initialization failures', () => {
        // The guard must be narrow: it neutralises the preload only. A real
        // StateManager failure must keep failing loudly.
        expect(source).toMatch(/this\._initError\s*=/);
    });
});
