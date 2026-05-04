/**
 * Tests for roosync_diagnose tool
 *
 * Covers: action=test, action=env, action=reset (confirm/clearCache),
 * action=debug, action=health, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncDiagnose } from '../../../../src/tools/roosync/diagnose.js';

// Hoisted mocks — accessible in both vi.mock factories and test body
const {
    mockFsAccess,
    mockResetInstance,
    mockGetInstance,
    mockLoadDashboard,
    mockGetConfig,
    mockClearCache,
    mockGetRooSyncService,
    mockGetCacheTierStats,
} = vi.hoisted(() => ({
    mockFsAccess: vi.fn(),
    mockResetInstance: vi.fn(),
    mockGetInstance: vi.fn(),
    mockLoadDashboard: vi.fn(),
    mockGetConfig: vi.fn(),
    mockClearCache: vi.fn(),
    mockGetRooSyncService: vi.fn(),
    mockGetCacheTierStats: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
    access: mockFsAccess,
    constants: { R_OK: 4, W_OK: 2 },
}));

// Mock os — source uses `import * as os from 'os'` which binds named exports
vi.mock('os', () => ({
    hostname: vi.fn(() => 'test-host'),
    uptime: vi.fn(() => 3600),
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
    freemem: vi.fn(() => 8 * 1024 * 1024 * 1024),
}));

// Mock path — source uses `import * as path from 'path'`
vi.mock('path', () => ({
    resolve: vi.fn((...args: string[]) => args.join('/')),
}));

// Mock lazy-roosync
vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    RooSyncService: {
        resetInstance: mockResetInstance,
        getInstance: mockGetInstance,
    },
    getRooSyncService: mockGetRooSyncService,
}));

// Mock skeleton-cache.service
vi.mock('../../../../src/services/skeleton-cache.service.js', () => ({
    SkeletonCacheService: {
        getInstance: () => ({
            getCacheTierStats: mockGetCacheTierStats,
        }),
    },
}));

describe('roosync_diagnose tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('action=test', () => {
        it('returns success with default message', async () => {
            const result = await roosyncDiagnose({ action: 'test' });
            expect(result.success).toBe(true);
            expect(result.action).toBe('test');
            expect(result.message).toContain('Test minimal');
            expect(result.data?.testMessage).toBe('Test minimal OK');
            expect(result.data?.mcpStatus).toBe('OK');
        });

        it('uses custom message when provided', async () => {
            const result = await roosyncDiagnose({ action: 'test', message: 'Custom test' });
            expect(result.data?.testMessage).toBe('Custom test');
        });

        it('includes timestamp', async () => {
            const result = await roosyncDiagnose({ action: 'test' });
            expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('action=env', () => {
        it('returns system info', async () => {
            const result = await roosyncDiagnose({ action: 'env' });
            expect(result.success).toBe(true);
            expect(result.action).toBe('env');
            expect(result.data?.system?.platform).toBe(process.platform);
            expect(result.data?.system?.hostname).toBe('test-host');
        });

        it('returns OK when all directories accessible', async () => {
            const result = await roosyncDiagnose({ action: 'env' });
            expect(result.message).toContain('OK');
        });

        it('returns WARNING when directories missing', async () => {
            mockFsAccess.mockRejectedValue({ code: 'ENOENT' });
            const result = await roosyncDiagnose({ action: 'env' });
            expect(result.message).toContain('WARNING');
        });
    });

    describe('action=reset', () => {
        it('requires confirmation', async () => {
            const result = await roosyncDiagnose({ action: 'reset', confirm: false });
            expect(result.success).toBe(false);
            expect(result.message).toContain('confirmer');
        });

        it('resets service when confirmed', async () => {
            mockGetInstance.mockResolvedValue({
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            mockGetRooSyncService.mockResolvedValue({
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            const result = await roosyncDiagnose({ action: 'reset', confirm: true });
            expect(result.success).toBe(true);
            expect(result.message).toContain('réinitialisée');
            expect(mockResetInstance).toHaveBeenCalled();
        });

        it('clears cache when clearCache=true', async () => {
            mockGetInstance.mockResolvedValue({
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            mockGetRooSyncService.mockResolvedValue({
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
                clearCache: mockClearCache,
            });
            const result = await roosyncDiagnose({ action: 'reset', confirm: true, clearCache: true });
            expect(result.success).toBe(true);
            expect(mockClearCache).toHaveBeenCalled();
        });
    });

    describe('action=debug', () => {
        it('resets instance and loads dashboard', async () => {
            mockGetInstance.mockResolvedValue({
                loadDashboard: mockLoadDashboard.mockResolvedValue({ status: 'OK' }),
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            const result = await roosyncDiagnose({ action: 'debug' });
            expect(result.success).toBe(true);
            expect(result.message).toContain('debuggé');
            expect(mockResetInstance).toHaveBeenCalled();
        });

        it('hides dashboard when verbose=false', async () => {
            mockGetInstance.mockResolvedValue({
                loadDashboard: mockLoadDashboard.mockResolvedValue({ status: 'OK' }),
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            const result = await roosyncDiagnose({ action: 'debug', verbose: false });
            expect(result.data?.debugInfo?.dashboard).toContain('verbose');
        });

        it('shows dashboard when verbose=true', async () => {
            mockGetInstance.mockResolvedValue({
                loadDashboard: mockLoadDashboard.mockResolvedValue({ status: 'OK', machines: [] }),
                getConfig: mockGetConfig.mockReturnValue({ machineId: 'test-machine' }),
            });
            const result = await roosyncDiagnose({ action: 'debug', verbose: true });
            expect(result.data?.debugInfo?.dashboard).toBeDefined();
            expect(result.data?.debugInfo?.dashboard).not.toContain('verbose');
        });
    });

    describe('action=health', () => {
        it('returns skeleton cache tier stats', async () => {
            mockGetCacheTierStats.mockReturnValue({
                tier1_roo: 100,
                tier2_claude: 50,
                tier3_archives: 25,
                total: 175,
                config: { enableClaudeTier: true, enableArchiveTier: true },
            });
            const result = await roosyncDiagnose({ action: 'health' });
            expect(result.success).toBe(true);
            expect(result.data?.tiers?.tier1_roo?.count).toBe(100);
            expect(result.data?.tiers?.tier2_claude?.enabled).toBe(true);
            expect(result.data?.tiers?.tier3_archives?.count).toBe(25);
            expect(result.data?.totalSkeletons).toBe(175);
        });

        it('shows disabled tiers correctly', async () => {
            mockGetCacheTierStats.mockReturnValue({
                tier1_roo: 80,
                tier2_claude: 0,
                tier3_archives: 0,
                total: 80,
                config: { enableClaudeTier: false, enableArchiveTier: false },
            });
            const result = await roosyncDiagnose({ action: 'health' });
            expect(result.data?.tiers?.tier2_claude?.enabled).toBe(false);
            expect(result.data?.tiers?.tier3_archives?.enabled).toBe(false);
        });
    });

    describe('error handling', () => {
        it('wraps errors with action context', async () => {
            // Force an error in health action
            mockGetCacheTierStats.mockImplementation(() => {
                throw new Error('Cache corrupt');
            });
            await expect(roosyncDiagnose({ action: 'health' })).rejects.toThrow('health');
            await expect(roosyncDiagnose({ action: 'health' })).rejects.toThrow('Cache corrupt');
        });
    });
});
