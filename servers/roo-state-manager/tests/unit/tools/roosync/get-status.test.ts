/**
 * Tests for roosync_get_status tool
 *
 * Covers: parseHudDataFromDashboard (pure function),
 * buildFlags (indirectly via roosyncGetStatus),
 * status derivation (HEALTHY/WARNING/CRITICAL),
 * machine filter, resetCache, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncGetStatus,
    parseHudDataFromDashboard,
} from '../../../../src/tools/roosync/get-status.js';

const {
    mockGetRooSyncService,
    mockGetMessageManager,
    mockGetSharedStatePath,
    mockGetToolUsageSnapshot,
    mockReaddirSync,
    mockStatSync,
    mockReadFileSync,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockGetMessageManager: vi.fn(),
    mockGetSharedStatePath: vi.fn(),
    mockGetToolUsageSnapshot: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockStatSync: vi.fn(),
    mockReadFileSync: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
    RooSyncServiceError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'RooSyncServiceError';
        }
    },
}));

vi.mock('../../../../src/services/MessageManager.js', () => ({
    getMessageManager: mockGetMessageManager,
}));

vi.mock('../../../../src/utils/shared-state-path.js', () => ({
    getSharedStatePath: mockGetSharedStatePath,
}));

vi.mock('../../../../src/utils/tool-call-metrics.js', () => ({
    getToolUsageSnapshot: mockGetToolUsageSnapshot,
}));

// Partial mock — preserve existsSync/mkdirSync etc. for Logger.ensureLogDirectory()
// when this test runs in suite ordering that instantiates loggers after the mock.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        readdirSync: mockReaddirSync,
        statSync: mockStatSync,
        readFileSync: mockReadFileSync,
    };
});

function setupMocks(overrides: Record<string, any> = {}) {
    // #2318: Machine presence is now dashboard-derived, not heartbeat-derived.
    // Tests provide dashboard file contents with embedded timestamps.
    // Default: all 6 fleet machines online on dashboard.
    const dashboardOnlineMachines = overrides.dashboardOnlineMachines || ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];
    const inboxStats = overrides.inboxStats || { unread: 0, urgent: 0, by_priority: {} };
    const config = overrides.config || { machineId: 'myia-ai-01' };

    // Build dashboard content with recent timestamps for online machines
    const now = new Date();
    const dashboardContent = buildDashboardContent(dashboardOnlineMachines, now);

    const mockService = {
        loadDashboard: vi.fn().mockResolvedValue({
            machines: { 'myia-ai-01': { status: 'online', lastSync: now.toISOString() } },
            machinesArray: [{ id: 'myia-ai-01', status: 'online', lastSync: now.toISOString() }],
        }),
        getHeartbeatService: vi.fn().mockReturnValue({
            checkHeartbeats: vi.fn().mockResolvedValue({}),
            getState: vi.fn().mockReturnValue({
                onlineMachines: [],
                unknownMachines: [],
                idleMachines: [],
            }),
            getAllSchedulerMetrics: vi.fn().mockReturnValue(new Map()),
        }),
        getConfig: vi.fn().mockReturnValue(config),
        loadPendingDecisions: vi.fn().mockResolvedValue([]),
        getKnownMachineIds: vi.fn().mockReturnValue(['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1']),
    };

    mockGetRooSyncService.mockResolvedValue(mockService);

    const mockMM = {
        getInboxStats: vi.fn().mockResolvedValue(inboxStats),
    };
    mockGetMessageManager.mockReturnValue(mockMM);

    mockGetSharedStatePath.mockReturnValue('/tmp/shared');
    // Mock readdirSync to return dashboard files
    mockReaddirSync.mockReturnValue(['workspace-roo-extensions.md']);
    // Mock statSync to report files as recently modified
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() });
    // Mock readFileSync to return dashboard content with machine timestamps
    mockReadFileSync.mockReturnValue(dashboardContent);
    mockGetToolUsageSnapshot.mockReturnValue({
        sessionStartAt: now.toISOString(),
        totalCalls: 10,
        uniqueTools: 5,
        topTools: [],
        bottomTools: [],
        errorTools: [],
    });

    return mockService;
}

/**
 * Build dashboard markdown with intercom messages for specified machines.
 * Each machine gets a recent timestamp (< 8h threshold).
 */
function buildDashboardContent(machines: string[], timestamp: Date): string {
    const lines = ['# Dashboard\n', '## Status\nActive\n', '## Intercom\n'];
    for (const machine of machines) {
        lines.push(`### [${timestamp.toISOString()}] ${machine}|roo-extensions`);
        lines.push('[INFO] Test message');
        lines.push('---');
    }
    return lines.join('\n');
}

describe('roosync_get_status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('parseHudDataFromDashboard', () => {
        it('returns empty arrays when no intercom section', () => {
            const result = parseHudDataFromDashboard('# Dashboard\nSome content');
            expect(result.activeClaims).toEqual([]);
            expect(result.activeStages).toEqual([]);
        });

        it('returns empty when intercom has no messages', () => {
            const content = '## Intercom\n*Aucun message.*\n';
            const result = parseHudDataFromDashboard(content);
            expect(result.activeClaims).toEqual([]);
        });

        it('parses CLAIMED messages within 2 hours', () => {
            const recent = new Date(Date.now() - 3600000).toISOString();
            const content = `## Intercom\n### [${recent}] myia-po-2023|roo-extensions\n[CLAIMED] #1843 — starting work\n---\n`;
            const result = parseHudDataFromDashboard(content);
            expect(result.activeClaims).toHaveLength(1);
            expect(result.activeClaims[0].machineId).toBe('myia-po-2023');
            expect(result.activeClaims[0].issue).toBe('#1843');
        });

        it('ignores CLAIMED messages older than 2 hours', () => {
            const old = new Date(Date.now() - 3 * 3600000).toISOString();
            const content = `## Intercom\n### [${old}] myia-po-2023|roo-extensions\n[CLAIMED] #1843 — starting work\n---\n`;
            const result = parseHudDataFromDashboard(content);
            expect(result.activeClaims).toHaveLength(0);
        });

        it('parses pipeline stage tags', () => {
            const recent = new Date(Date.now() - 1800000).toISOString();
            const content = `## Intercom\n### [${recent}] myia-ai-01|roo-extensions\n[EXEC] Working on tests\n---\n`;
            const result = parseHudDataFromDashboard(content);
            expect(result.activeStages).toHaveLength(1);
            expect(result.activeStages[0].stage).toBe('EXEC');
            expect(result.activeStages[0].machineId).toBe('myia-ai-01');
        });

        it('parses multiple stages in one message', () => {
            const recent = new Date(Date.now() - 600000).toISOString();
            const content = `## Intercom\n### [${recent}] myia-po-2024|roo-extensions\n[PLAN] Planning\n[VERIFY] Verifying\n---\n`;
            const result = parseHudDataFromDashboard(content);
            expect(result.activeStages).toHaveLength(2);
        });
    });

    describe('status derivation', () => {
        it('returns HEALTHY when all online, no urgent, low unread', async () => {
            setupMocks();
            const result = await roosyncGetStatus({});
            expect(result.status).toBe('HEALTHY');
        });

        it('returns CRITICAL when machines offline (not seen on dashboard)', async () => {
            // #2318: Only ai-01 is online (on dashboard). web1 is not seen → UNKNOWN.
            setupMocks({
                dashboardOnlineMachines: ['myia-ai-01'],
            });
            const result = await roosyncGetStatus({});
            expect(result.status).toBe('CRITICAL');
            expect(result.flags).toContain('UNKNOWN:myia-web1');
        });

        it('returns CRITICAL when urgent messages', async () => {
            setupMocks({
                inboxStats: { unread: 1, urgent: 1, by_priority: { URGENT: 1 } },
            });
            const result = await roosyncGetStatus({});
            expect(result.status).toBe('CRITICAL');
            expect(result.flags).toContain('INBOX_URGENT:1');
        });

        it('returns WARNING when high unread count', async () => {
            setupMocks({
                inboxStats: { unread: 12, urgent: 0, by_priority: {} },
            });
            const result = await roosyncGetStatus({});
            expect(result.status).toBe('WARNING');
            expect(result.flags).toContain('INBOX_OVERFLOW:12_unread');
        });

        it('returns HEALTHY when all known machines are on dashboard', async () => {
            // #2318: All 6 fleet machines on dashboard → HEALTHY (no unknown from registry)
            setupMocks({
                dashboardOnlineMachines: ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'],
            });
            const result = await roosyncGetStatus({});
            expect(result.status).toBe('HEALTHY');
            expect(result.machines.online).toBe(6);
            expect(result.machines.unknown).toBe(0);
        });
    });

    describe('machine filtering', () => {
        it('filters out non-myia machines from dashboard activity (#1365)', async () => {
            // #2318: Dashboard contains test-machine entries, but isKnownMachine filters them.
            setupMocks({
                dashboardOnlineMachines: ['myia-ai-01', 'test-machine', 'persistent-machine'],
            });
            const result = await roosyncGetStatus({});
            expect(result.machines.online).toBe(1);
        });
    });

    describe('machineFilter', () => {
        it('accepts valid machine filter', async () => {
            // All machines online on dashboard → HEALTHY with filter
            setupMocks({
                dashboardOnlineMachines: ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'],
            });
            const result = await roosyncGetStatus({ machineFilter: 'myia-ai-01' });
            expect(result.status).toBe('HEALTHY');
        });

        it('throws on unknown machine filter', async () => {
            setupMocks();
            await expect(roosyncGetStatus({ machineFilter: 'unknown-machine' }))
                .rejects.toThrow('non trouvée');
        });
    });

    describe('pending decisions', () => {
        it('flags DECISIONS_PENDING when decisions exist', async () => {
            const mockService = setupMocks();
            mockService.loadPendingDecisions.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
            const result = await roosyncGetStatus({});
            expect(result.decisions.pending).toBe(2);
            expect(result.flags).toContain('DECISIONS_PENDING:2');
        });
    });

    describe('resetCache', () => {
        it('resets service when resetCache=true', async () => {
            setupMocks();
            const mockReset = vi.fn();
            vi.doMock('../../../../src/services/RooSyncService.js', () => ({
                RooSyncService: { resetInstance: mockReset },
            }));
            // Just verify the function doesn't throw
            const result = await roosyncGetStatus({ resetCache: true });
            expect(result).toBeDefined();
        });
    });

    describe('includeDetails', () => {
        it('includes toolUsage when includeDetails=true', async () => {
            setupMocks();
            const result = await roosyncGetStatus({ includeDetails: true });
            expect(result.toolUsage).toBeDefined();
            expect(result.toolUsage!.totalCalls).toBe(10);
        });

        it('omits toolUsage when includeDetails not set', async () => {
            setupMocks();
            const result = await roosyncGetStatus({});
            expect(result.toolUsage).toBeUndefined();
        });
    });

    describe('detail=full (HUD)', () => {
        it('includes HUD data when detail=full and dashboard readable', async () => {
            setupMocks();
            const recent = new Date(Date.now() - 600000).toISOString();
            mockReadFileSync.mockReturnValue(`## Intercom\n### [${recent}] myia-po-2023|roo-extensions\n[CLAIMED] #1843\n---\n`);
            const result = await roosyncGetStatus({ detail: 'full' });
            expect(result.hud).toBeDefined();
            expect(result.hud!.activeClaims).toHaveLength(1);
        });

        it('returns undefined HUD when dashboard read fails', async () => {
            setupMocks();
            mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
            const result = await roosyncGetStatus({ detail: 'full' });
            expect(result.hud).toBeUndefined();
        });
    });

    describe('error handling', () => {
        it('re-throws RooSyncServiceError as-is', async () => {
            const { RooSyncServiceError } = await import('../../../../src/services/lazy-roosync.js');
            mockGetRooSyncService.mockRejectedValue(new RooSyncServiceError('Service init failed', 'INIT_ERROR'));
            await expect(roosyncGetStatus({})).rejects.toThrow('Service init failed');
        });

        it('wraps unknown errors in RooSyncServiceError', async () => {
            mockGetRooSyncService.mockRejectedValue(new Error('Unexpected crash'));
            await expect(roosyncGetStatus({})).rejects.toThrow('Unexpected crash');
        });
    });
});
