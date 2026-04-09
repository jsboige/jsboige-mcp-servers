/**
 * Tests pour get-status.ts — Option B compact status (#1206)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { GetStatusArgsSchema, GetStatusResultSchema, roosyncGetStatus } from '../get-status.js';

const { mockGetConfig, mockLoadDashboard, mockGetHeartbeatService, mockLoadPendingDecisions } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockLoadDashboard: vi.fn(),
  mockGetHeartbeatService: vi.fn(),
  mockLoadPendingDecisions: vi.fn()
}));

const { mockGetInboxStats } = vi.hoisted(() => ({
  mockGetInboxStats: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: mockGetConfig,
    loadDashboard: mockLoadDashboard,
    loadPendingDecisions: mockLoadPendingDecisions,
    getHeartbeatService: mockGetHeartbeatService
  })),
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message); this.name = 'RooSyncServiceError'; this.code = code;
    }
  },
  RooSyncService: { resetInstance: vi.fn() }
}));

vi.mock('../../../services/MessageManager.js', () => ({
  getMessageManager: vi.fn(() => ({
    getInboxStats: mockGetInboxStats
  }))
}));

describe('get-status (Option B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
    mockLoadDashboard.mockResolvedValue({
      overallStatus: 'synced',
      lastUpdate: new Date().toISOString(),
      machines: {
        'ai-01': { status: 'online', lastSync: '2026-04-08', pendingDecisions: 0, diffsCount: 0 }
      }
    });
    mockGetHeartbeatService.mockReturnValue({
      checkHeartbeats: vi.fn(),
      getState: vi.fn(() => ({
        onlineMachines: ['ai-01', 'po-2023'],
        offlineMachines: [],
        warningMachines: []
      }))
    });
    mockGetInboxStats.mockResolvedValue({ unread: 0, urgent: 0, by_priority: {} });
    mockLoadPendingDecisions.mockResolvedValue([]);
  });

  describe('GetStatusArgsSchema', () => {
    test('accepts empty input', () => {
      const result = GetStatusArgsSchema.parse({});
      expect(result).toBeDefined();
    });

    test('accepts machineFilter', () => {
      const result = GetStatusArgsSchema.parse({ machineFilter: 'po-2023' });
      expect(result.machineFilter).toBe('po-2023');
    });

    test('accepts resetCache', () => {
      const result = GetStatusArgsSchema.parse({ resetCache: true });
      expect(result.resetCache).toBe(true);
    });

    test('no longer accepts includeDetails (removed in Option B)', () => {
      // includeDetails was removed — extra properties are stripped
      const result = GetStatusArgsSchema.parse({ includeDetails: true });
      expect((result as any).includeDetails).toBeUndefined();
    });
  });

  describe('GetStatusResultSchema', () => {
    test('validates HEALTHY result', () => {
      const result = GetStatusResultSchema.parse({
        status: 'HEALTHY',
        machines: { online: 6, offline: 0, total: 6 },
        inbox: { unread: 0, urgent: 0 },
        decisions: { pending: 0 },
        dashboards: { active: 1 },
        flags: [],
        lastUpdated: '2026-04-08T00:00:00Z'
      });
      expect(result.status).toBe('HEALTHY');
    });

    test('validates CRITICAL result with flags', () => {
      const result = GetStatusResultSchema.parse({
        status: 'CRITICAL',
        machines: { online: 4, offline: 2, total: 6 },
        inbox: { unread: 15, urgent: 2 },
        decisions: { pending: 3 },
        dashboards: { active: 1 },
        flags: ['OFFLINE:po-2025', 'INBOX_URGENT:2', 'DECISIONS_PENDING:3'],
        lastUpdated: '2026-04-08T00:00:00Z'
      });
      expect(result.status).toBe('CRITICAL');
      expect(result.flags).toHaveLength(3);
    });

    test('rejects old status values', () => {
      expect(() => GetStatusResultSchema.parse({
        status: 'synced',
        machines: { online: 6, offline: 0, total: 6 },
        inbox: { unread: 0, urgent: 0 },
        decisions: { pending: 0 },
        dashboards: { active: 1 },
        flags: [],
        lastUpdated: '2026-04-08T00:00:00Z'
      })).toThrow();
    });
  });

  describe('roosyncGetStatus', () => {
    test('returns HEALTHY when all machines online and no issues', async () => {
      const recentSync = new Date().toISOString();
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: new Date().toISOString(),
        machines: {
          'ai-01': { status: 'online', lastSync: recentSync, pendingDecisions: 0, diffsCount: 0 }
        }
      });

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('HEALTHY');
      expect(result.machines.total).toBeGreaterThanOrEqual(1);
      expect(result.flags).toHaveLength(0);
    });

    test('returns CRITICAL when machines offline', async () => {
      mockGetHeartbeatService.mockReturnValue({
        checkHeartbeats: vi.fn(),
        getState: vi.fn(() => ({
          onlineMachines: ['ai-01'],
          offlineMachines: ['po-2025'],
          warningMachines: []
        }))
      });

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('CRITICAL');
      expect(result.machines.offline).toBe(1);
      expect(result.flags).toContain('OFFLINE:po-2025');
    });

    test('returns CRITICAL when urgent messages', async () => {
      mockGetInboxStats.mockResolvedValue({ unread: 3, urgent: 1, by_priority: { URGENT: 1 } });

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('CRITICAL');
      expect(result.flags).toContain('INBOX_URGENT:1');
    });

    test('returns WARNING when >5 unread messages', async () => {
      mockGetInboxStats.mockResolvedValue({ unread: 8, urgent: 0, by_priority: {} });

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('WARNING');
    });

    test('includes DECISIONS_PENDING flag', async () => {
      mockLoadPendingDecisions.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);

      const result = await roosyncGetStatus({});

      expect(result.flags).toContain('DECISIONS_PENDING:2');
      expect(result.decisions.pending).toBe(2);
    });

    test('includes INBOX_OVERFLOW flag when >10 unread', async () => {
      mockGetInboxStats.mockResolvedValue({ unread: 15, urgent: 0, by_priority: {} });

      const result = await roosyncGetStatus({});

      expect(result.flags).toContain('INBOX_OVERFLOW:15_unread');
    });

    test('includes HEARTBEAT_STALE flag', async () => {
      mockGetHeartbeatService.mockReturnValue({
        checkHeartbeats: vi.fn(),
        getState: vi.fn(() => ({
          onlineMachines: ['ai-01'],
          offlineMachines: [],
          warningMachines: ['po-2023']
        }))
      });

      const result = await roosyncGetStatus({});

      expect(result.flags).toContain('HEARTBEAT_STALE:po-2023');
    });

    test('throws when machine not found', async () => {
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: '2026-01-01T00:00:00Z',
        machines: { 'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 } }
      });

      await expect(roosyncGetStatus({ machineFilter: 'nonexistent' })).rejects.toThrow('non trouvée');
    });

    test('succeeds when machine found', async () => {
      const recentSync = new Date().toISOString();
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: new Date().toISOString(),
        machines: { 'ai-01': { status: 'online', lastSync: recentSync, pendingDecisions: 0, diffsCount: 0 } }
      });

      const result = await roosyncGetStatus({ machineFilter: 'ai-01' });
      expect(result).toBeDefined();
    });

    test('gracefully handles dashboard load failure', async () => {
      mockLoadDashboard.mockRejectedValue(new Error('GDrive down'));

      const result = await roosyncGetStatus({});

      expect(result).toBeDefined();
      expect(result.machines.total).toBeGreaterThanOrEqual(0);
    });

    test('gracefully handles heartbeat failure', async () => {
      mockGetHeartbeatService.mockReturnValue({
        checkHeartbeats: vi.fn().mockRejectedValue(new Error('heartbeat error')),
        getState: vi.fn()
      });

      const result = await roosyncGetStatus({});

      expect(result).toBeDefined();
    });
  });
});
