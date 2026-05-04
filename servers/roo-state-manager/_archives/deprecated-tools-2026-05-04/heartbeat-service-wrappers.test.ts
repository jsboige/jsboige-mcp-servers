/**
 * Tests for start-heartbeat-service and stop-heartbeat-service tools
 *
 * Both are deprecated wrappers. Covers: start/stop lifecycle,
 * config update, error handling, metadata
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncStartHeartbeatService,
    startHeartbeatServiceToolMetadata,
} from '../../../../src/tools/roosync/start-heartbeat-service.js';
import {
    roosyncStopHeartbeatService,
    stopHeartbeatServiceToolMetadata,
} from '../../../../src/tools/roosync/stop-heartbeat-service.js';

const {
    mockGetRooSyncService,
    mockStartHeartbeatService,
    mockStopHeartbeatService,
    mockUpdateConfig,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockStartHeartbeatService: vi.fn(),
    mockStopHeartbeatService: vi.fn(),
    mockUpdateConfig: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
    HeartbeatServiceError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'HeartbeatServiceError';
        }
    },
}));

function setupService() {
    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            startHeartbeatService: mockStartHeartbeatService,
            stopHeartbeatService: mockStopHeartbeatService,
            updateConfig: mockUpdateConfig,
        }),
    });
}

describe('start-heartbeat-service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('starts heartbeat with default config', async () => {
        mockStartHeartbeatService.mockResolvedValue(undefined);
        const result = await roosyncStartHeartbeatService({
            machineId: 'myia-po-2025',
        });
        expect(result.success).toBe(true);
        expect(result.machineId).toBe('myia-po-2025');
        expect(result.config.heartbeatInterval).toBe(30000);
        expect(result.config.offlineTimeout).toBe(120000);
        expect(result.config.autoSyncEnabled).toBe(true);
        expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('starts with custom intervals', async () => {
        mockStartHeartbeatService.mockResolvedValue(undefined);
        mockUpdateConfig.mockResolvedValue(undefined);
        const result = await roosyncStartHeartbeatService({
            machineId: 'myia-po-2025',
            heartbeatInterval: 60000,
            offlineTimeout: 300000,
            enableAutoSync: false,
        });
        expect(result.config.heartbeatInterval).toBe(60000);
        expect(result.config.offlineTimeout).toBe(300000);
        expect(result.config.autoSyncEnabled).toBe(false);
        expect(mockUpdateConfig).toHaveBeenCalled();
    });

    it('updates config only when custom values provided', async () => {
        mockStartHeartbeatService.mockResolvedValue(undefined);
        await roosyncStartHeartbeatService({
            machineId: 'myia-po-2025',
        });
        expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it('wraps unexpected errors in HeartbeatServiceError', async () => {
        mockStartHeartbeatService.mockRejectedValue(new Error('Crash'));
        await expect(roosyncStartHeartbeatService({ machineId: 'test' }))
            .rejects.toThrow('Crash');
    });

    it('re-throws HeartbeatServiceError as-is', async () => {
        const { HeartbeatServiceError } = await import('../../../../src/services/lazy-roosync.js');
        mockStartHeartbeatService.mockRejectedValue(new HeartbeatServiceError('Custom', 'CUSTOM'));
        await expect(roosyncStartHeartbeatService({ machineId: 'test' }))
            .rejects.toThrow('Custom');
    });

    it('has correct metadata', () => {
        expect(startHeartbeatServiceToolMetadata.name).toBe('roosync_start_heartbeat_service');
        expect(startHeartbeatServiceToolMetadata.inputSchema.required).toContain('machineId');
    });
});

describe('stop-heartbeat-service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('stops heartbeat service with default saveState', async () => {
        mockStopHeartbeatService.mockResolvedValue(undefined);
        const result = await roosyncStopHeartbeatService({});
        expect(result.success).toBe(true);
        expect(result.stateSaved).toBe(true);
        expect(result.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('stops with saveState=false', async () => {
        mockStopHeartbeatService.mockResolvedValue(undefined);
        const result = await roosyncStopHeartbeatService({ saveState: false });
        expect(result.stateSaved).toBe(false);
    });

    it('wraps unexpected errors', async () => {
        mockStopHeartbeatService.mockRejectedValue(new Error('Stop failed'));
        await expect(roosyncStopHeartbeatService({}))
            .rejects.toThrow('Stop failed');
    });

    it('re-throws HeartbeatServiceError', async () => {
        const { HeartbeatServiceError } = await import('../../../../src/services/lazy-roosync.js');
        mockStopHeartbeatService.mockRejectedValue(new HeartbeatServiceError('Custom', 'CUSTOM'));
        await expect(roosyncStopHeartbeatService({}))
            .rejects.toThrow('Custom');
    });

    it('has correct metadata', () => {
        expect(stopHeartbeatServiceToolMetadata.name).toBe('roosync_stop_heartbeat_service');
        expect(stopHeartbeatServiceToolMetadata.inputSchema.properties.saveState).toBeDefined();
    });
});
