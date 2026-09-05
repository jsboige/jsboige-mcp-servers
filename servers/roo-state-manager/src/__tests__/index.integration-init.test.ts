/**
 * #3001 item 1 — Integration tests exercising the REAL RooStateManagerServer.ensureInitialized()
 *
 * The logic-replication tests in index.startup-init.test.ts (#2993(b)) validate a LOCAL
 * reconstruction of the retry gate (`buildEnsureInitialized`). They would stay green if
 * someone deleted the entire retry block from the real `ensureInitialized()` — a regression
 * that locks all 16 tools for the session.
 *
 * These tests instantiate the REAL class, mock only the heavy dependencies (StateManager,
 * background services, notifications), and exercise the actual retry path end-to-end:
 *
 * 1. Real retry after init failure → _initError cleared, stateManager returned
 * 2. Real retry failure → _initError still set, throws
 * 3. Idempotence (#3001 item 3): StateManager not recreated on retry after partial init
 * 4. Anti-reintroduction (#3001 item 2): behavioral test — re-entrance would deadlock
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// -- Neutralize process.exit / global handlers from the production module ---------------
// index.ts registers process-level handlers (uncaughtException, unhandledRejection) that
// call process.exit(1) for non-I/O errors. In tests, we mock process.exit to prevent the
// test worker from being killed. We also register a no-op unhandledRejection listener to
// suppress rejections from the _initPromise that fires when init fails.
const originalExit = process.exit.bind(process);
const rejectionHandlers: Array<(reason: unknown, promise: Promise<unknown>) => void> = [];

beforeEach(() => {
    // Prevent production code from killing the test worker.
    // Must be a no-op (not throw) — throwing from process.exit causes _fatalException
    // to fire again, creating an infinite loop that crashes the vitest worker.
    (process as any).exit = vi.fn((() => undefined) as never);
    // Swallow unhandled rejections from init promise chains
    const handler = () => { /* swallow */ };
    rejectionHandlers.push(handler);
    process.on('unhandledRejection', handler);
});

afterEach(() => {
    (process as any).exit = originalExit;
    for (const h of rejectionHandlers) {
        process.off('unhandledRejection', h);
    }
    rejectionHandlers.length = 0;
});

// -- Mocks: intercept every module that initializeAsync() dynamically imports ----------
// These are hoisted by vitest before the production module loads.

vi.mock('../config/server-config.js', () => ({
    createMcpServer: () => ({
        oninitialized: null as (() => void) | null,
        connect: vi.fn(),
        _requestHandlers: new Map(),
    }),
    SERVER_CONFIG: { name: 'test-server', version: '0.0.0' },
}));

vi.mock('../utils/logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
}));

vi.mock('../utils/server-capabilities.js', () => ({
    getServerCapabilities: () => ({
        markDegraded: vi.fn(),
        isAvailable: () => true,
    }),
}));

vi.mock('../utils/tool-call-metrics.js', () => ({
    recordToolCall: vi.fn(),
}));

// StateManager mock — controllable per-test via mockImplementation
vi.mock('../services/state-manager.service.js', () => ({
    StateManager: vi.fn(),
}));

// Background services mock
vi.mock('../services/background-services.js', () => ({
    initializeBackgroundServices: vi.fn(),
    startSkeletonRefreshWorker: vi.fn(),
    startQdrantIndexingBackgroundProcess: vi.fn(),
}));

// Notification mocks
vi.mock('../notifications/NotificationService.js', () => ({
    NotificationService: vi.fn(() => ({ loadFilterRules: vi.fn() })),
}));
vi.mock('../notifications/ToolUsageInterceptor.js', () => ({
    ToolUsageInterceptor: vi.fn(() => ({})),
}));
vi.mock('../services/MessageManager.js', () => ({
    getMessageManager: vi.fn(() => ({ startAutoArchiveDaemon: vi.fn(), startChannelReconcileDaemon: vi.fn() })),
}));

// RooSync preload mock
vi.mock('../services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(),
}));

// -- Import the REAL class (after mocks are in place) -----------------------------------

const { RooStateManagerServer } = await import('../index.js');

// Helper: get mock references for per-test configuration
async function getMocks() {
    const smMod = await import('../services/state-manager.service.js');
    const bgMod = await import('../services/background-services.js');
    return {
        StateManager: vi.mocked(smMod.StateManager),
        initializeBackgroundServices: vi.mocked(bgMod.initializeBackgroundServices),
    };
}

// Minimal ServerState shape that the real code reads
function makeMockState() {
    return {
        conversationCache: new Map(),
        skeletonRefreshInterval: null as ReturnType<typeof setInterval> | null,
        qdrantIndexInterval: null as ReturnType<typeof setInterval> | null,
        lastSkeletonRefreshAt: 0,
        indexingMetrics: { totalTasks: 0 },
        isQdrantIndexingEnabled: false,
    };
}

/**
 * Simulate startBackgroundInit's catch handler: call initializeAsync, and on failure
 * set _initError + reject _initPromise — exactly what the production code does.
 *
 * IMPORTANT: _initPromise.catch(() => {}) is attached BEFORE _rejectInit to prevent
 * an unhandledRejection in the gap between rejection and the first ensureInitialized()
 * call. In production, ensureInitialized() is called within seconds (first tool call);
 * in tests the gap is longer and Node fires unhandledRejection → process.exit(1).
 */
async function simulateFailedInit(instance: InstanceType<typeof RooStateManagerServer>) {
    // Prevent unhandledRejection from the _initPromise that will be rejected below.
    (instance as any)._initPromise.catch(() => {});
    try {
        await (instance as any).initializeAsync();
    } catch (error: any) {
        (instance as any)._initError = error;
        (instance as any)._rejectInit(error);
    }
}

describe('#3001 item 1 — real ensureInitialized() retry path', () => {

    beforeEach(async () => {
        const { StateManager, initializeBackgroundServices } = await getMocks();
        StateManager.mockReset();
        initializeBackgroundServices.mockReset();
        // Default: both succeed
        StateManager.mockImplementation(() => ({
            getState: () => makeMockState(),
        }) as any);
        initializeBackgroundServices.mockResolvedValue(undefined);
    });

    test('successful retry clears _initError and returns stateManager', async () => {
        const { StateManager } = await getMocks();

        // First call: StateManager constructor throws
        StateManager.mockImplementationOnce(() => { throw new Error('transient Qdrant failure'); });

        const instance = new RooStateManagerServer();

        // Simulate the init failure (as startBackgroundInit would)
        await simulateFailedInit(instance);

        // Verify _initError is set
        expect((instance as any)._initError).not.toBeNull();
        expect((instance as any)._initError.message).toBe('transient Qdrant failure');

        // Bypass cooldown (it's 30s, but we test immediately)
        (instance as any)._lastInitRetryAt = 0;

        // Call the REAL ensureInitialized — should trigger retry
        const result = await (instance as any).ensureInitialized();

        // Retry succeeded
        expect(result).toBeDefined();
        expect((instance as any)._initError).toBeNull();
        expect((instance as any).stateManager).toBe(result);
    });

    test('failed retry leaves _initError set and throws wrapped message', async () => {
        const { StateManager } = await getMocks();

        // First call fails, retry also fails
        StateManager.mockImplementationOnce(() => { throw new Error('first failure'); });
        StateManager.mockImplementationOnce(() => { throw new Error('second failure'); });

        const instance = new RooStateManagerServer();
        await simulateFailedInit(instance);

        (instance as any)._lastInitRetryAt = 0;

        await expect(
            (instance as any).ensureInitialized()
        ).rejects.toThrow('MCP server initialization failed: second failure');

        expect((instance as any)._initError.message).toBe('second failure');
    });

    test('cooldown prevents back-to-back retry within 30s window', async () => {
        const { StateManager } = await getMocks();

        // First init fails
        StateManager.mockImplementationOnce(() => { throw new Error('first failure'); });
        // Retry also fails
        StateManager.mockImplementationOnce(() => { throw new Error('retry failure'); });

        const instance = new RooStateManagerServer();
        await simulateFailedInit(instance);

        // First retry: bypass cooldown
        (instance as any)._lastInitRetryAt = 0;
        await expect(
            (instance as any).ensureInitialized()
        ).rejects.toThrow('MCP server initialization failed: retry failure');

        // Second call immediately: cooldown should block retry
        // _initError still set, _initRetryPromise null, but cooldown hasn't elapsed
        await expect(
            (instance as any).ensureInitialized()
        ).rejects.toThrow('MCP server initialization failed: retry failure');

        // StateManager constructor called only twice (1 initial + 1 retry),
        // NOT three times (cooldown blocked the second retry)
        expect(StateManager).toHaveBeenCalledTimes(2);
    });
});

describe('#3001 item 3 — idempotence guards on retry', () => {

    beforeEach(async () => {
        const { StateManager, initializeBackgroundServices } = await getMocks();
        StateManager.mockReset();
        initializeBackgroundServices.mockReset();
        StateManager.mockImplementation(() => ({
            getState: () => makeMockState(),
        }) as any);
        initializeBackgroundServices.mockResolvedValue(undefined);
    });

    test('StateManager is NOT recreated on retry when already constructed', async () => {
        const { StateManager, initializeBackgroundServices } = await getMocks();

        let ctorCalls = 0;
        StateManager.mockImplementation(() => {
            ctorCalls++;
            return { getState: () => makeMockState() } as any;
        });

        // First init: StateManager created OK, but bg services throw
        initializeBackgroundServices.mockImplementationOnce(() => {
            throw new Error('bg services transient failure');
        });

        const instance = new RooStateManagerServer();
        await simulateFailedInit(instance);

        // StateManager WAS created (ctorCalls=1), but init failed in bg services
        expect(ctorCalls).toBe(1);
        expect((instance as any).stateManager).not.toBeNull();
        expect((instance as any)._initError.message).toBe('bg services transient failure');

        // Retry
        (instance as any)._lastInitRetryAt = 0;
        const result = await (instance as any).ensureInitialized();

        // StateManager was NOT recreated — ctorCalls still 1
        expect(ctorCalls).toBe(1);
        expect(result).toBe((instance as any).stateManager);
        expect((instance as any)._initError).toBeNull();
    });

    test('bg services initialized flag prevents re-execution on subsequent retries', async () => {
        const { initializeBackgroundServices } = await getMocks();

        let bgCalls = 0;
        initializeBackgroundServices.mockImplementation(() => {
            bgCalls++;
            return Promise.resolve();
        });

        const instance = new RooStateManagerServer();

        // Successful init
        await (instance as any).initializeAsync();
        expect(bgCalls).toBe(1);
        expect((instance as any)._bgServicesInitialized).toBe(true);

        // Call initializeAsync again (simulating a spurious retry)
        await (instance as any).initializeAsync();

        // bg services NOT called again — guarded by _bgServicesInitialized
        expect(bgCalls).toBe(1);
    });

    test('bg services re-executed on retry when previous attempt threw (flag not set)', async () => {
        const { initializeBackgroundServices } = await getMocks();

        let bgCalls = 0;
        initializeBackgroundServices.mockImplementationOnce(() => {
            bgCalls++;
            throw new Error('first bg failure');
        });
        initializeBackgroundServices.mockImplementationOnce(() => {
            bgCalls++;
            return Promise.resolve();
        });

        const instance = new RooStateManagerServer();
        await simulateFailedInit(instance);

        // bg services WAS called once (and failed)
        expect(bgCalls).toBe(1);
        expect((instance as any)._bgServicesInitialized).toBe(false);

        // Retry
        (instance as any)._lastInitRetryAt = 0;
        await (instance as any).ensureInitialized();

        // bg services called again — previous attempt failed so flag was not set
        expect(bgCalls).toBe(2);
        expect((instance as any)._bgServicesInitialized).toBe(true);
    });
});

describe('#3292 — auto-archive daemon must not be hostage to notifications', () => {
    // The daemon start used to live INSIDE initializeNotificationSystem(), after
    // the NOTIFICATIONS_ENABLED gate. A machine disabling notifications (or a
    // NotificationService init failure) silently lost inbox rotation and the
    // shared pool grew again. It now runs as its own init step.

    beforeEach(async () => {
        const { StateManager, initializeBackgroundServices } = await getMocks();
        StateManager.mockReset();
        initializeBackgroundServices.mockReset();
        StateManager.mockImplementation(() => ({
            getState: () => makeMockState(),
        }) as any);
        initializeBackgroundServices.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.NOTIFICATIONS_ENABLED;
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.MESSAGE_AUTO_ARCHIVE_ENABLED;
    });

    async function daemonStartMock() {
        const mmMod = await import('../services/MessageManager.js');
        const getMessageManager = vi.mocked(mmMod.getMessageManager);
        const startAutoArchiveDaemon = vi.fn();
        getMessageManager.mockReturnValue({ startAutoArchiveDaemon } as any);
        return startAutoArchiveDaemon;
    }

    test('daemon starts with NOTIFICATIONS_ENABLED=false', async () => {
        process.env.NOTIFICATIONS_ENABLED = 'false';
        process.env.ROOSYNC_SHARED_PATH = 'X:\\tmp';
        const startAutoArchiveDaemon = await daemonStartMock();

        const instance = new RooStateManagerServer();
        await (instance as any).initializeAsync();

        expect(startAutoArchiveDaemon).toHaveBeenCalledTimes(1);
    });

    test('daemon starts with notifications on (no behavior change)', async () => {
        process.env.ROOSYNC_SHARED_PATH = 'X:\\tmp';
        const startAutoArchiveDaemon = await daemonStartMock();

        const instance = new RooStateManagerServer();
        await (instance as any).initializeAsync();

        expect(startAutoArchiveDaemon).toHaveBeenCalledTimes(1);
    });

    test('MESSAGE_AUTO_ARCHIVE_ENABLED=false still opts out', async () => {
        process.env.ROOSYNC_SHARED_PATH = 'X:\\tmp';
        process.env.MESSAGE_AUTO_ARCHIVE_ENABLED = 'false';
        const startAutoArchiveDaemon = await daemonStartMock();

        const instance = new RooStateManagerServer();
        await (instance as any).initializeAsync();

        expect(startAutoArchiveDaemon).not.toHaveBeenCalled();
    });

    test('missing ROOSYNC_SHARED_PATH skips the daemon (no throw)', async () => {
        delete process.env.ROOSYNC_SHARED_PATH;
        const startAutoArchiveDaemon = await daemonStartMock();

        const instance = new RooStateManagerServer();
        await expect((instance as any).initializeAsync()).resolves.toBeUndefined();

        expect(startAutoArchiveDaemon).not.toHaveBeenCalled();
    });
});

describe('#3001 item 2 — behavioral anti-reintroduction guard', () => {
    // The source-regex tests in index.startup-init.test.ts (#2993(c) + PR #923) guard
    // against re-adding `await this.ensureInitialized()` in initializeAsync or
    // initializeNotificationSystem. This test exercises the REAL code path to
    // verify that the current (non-re-entrant) code completes without deadlock.
    //
    // If someone re-introduced the re-entrant call, initializeAsync would await
    // _initPromise — which only resolves when initializeAsync itself returns —
    // creating a circular wait that hangs forever.

    beforeEach(async () => {
        const { StateManager, initializeBackgroundServices } = await getMocks();
        StateManager.mockReset();
        initializeBackgroundServices.mockReset();
        StateManager.mockImplementation(() => ({
            getState: () => makeMockState(),
        }) as any);
        initializeBackgroundServices.mockResolvedValue(undefined);
    });

    test('real initializeAsync completes without deadlock (no re-entrant ensureInitialized)', async () => {
        const instance = new RooStateManagerServer();

        // initializeAsync should complete promptly — no re-entrant gate call to deadlock on.
        const winner = await Promise.race([
            (instance as any).initializeAsync().then(() => 'done' as const),
            new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
        ]);

        expect(winner).toBe('done');
        expect((instance as any).stateManager).not.toBeNull();
    });

    test('simulated re-entrance during retry WOULD deadlock (proves the guard has teeth)', async () => {
        // The deadlock only manifests when _initError is set and a retry is in flight.
        // On first init (no _initError), a re-entrant ensureInitialized() would just
        // return stateManager immediately — no hang. But during a RETRY:
        //   ensureInitialized fires initializeAsync → initializeNotificationSystem
        //   → (re-entrant) ensureInitialized → sees _initError → awaits _initPromise
        //   → _initPromise only resolves when initializeAsync finishes → blocked at
        //   the re-entrant call = circular wait.
        const { StateManager } = await getMocks();

        // First init fails to set _initError
        StateManager.mockImplementationOnce(() => { throw new Error('transient'); });

        const instance = new RooStateManagerServer();
        await simulateFailedInit(instance);

        // Monkey-patch: simulate the OLD re-entrant code that #918 removed
        (instance as any).initializeNotificationSystem = async function () {
            await this.ensureInitialized(); // re-entrant call
        };

        // Retry: ensureInitialized fires initializeAsync again, which calls
        // the monkey-patched initializeNotificationSystem → re-entrant ensureInitialized
        // → awaits _initPromise (held by the retry) → circular wait.
        (instance as any)._lastInitRetryAt = 0;

        const winner = await Promise.race([
            (instance as any).ensureInitialized()
                .then(() => 'done' as const)
                .catch(() => 'error' as const),
            new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
        ]);

        expect(winner).toBe('timeout');
    });
});
