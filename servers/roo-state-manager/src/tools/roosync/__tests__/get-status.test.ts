/**
 * Tests pour get-status.ts — Option B compact status (#1206)
 * Updated #1365: Use real machine IDs (myia-*) to match isKnownMachine filter.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { GetStatusArgsSchema, GetStatusResultSchema, roosyncGetStatus } from '../get-status.js';

const { mockGetConfig, mockLoadDashboard, mockGetHeartbeatService, mockLoadPendingDecisions, mockGetKnownMachineIds } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockLoadDashboard: vi.fn(),
  mockGetHeartbeatService: vi.fn(),
  mockLoadPendingDecisions: vi.fn(),
  mockGetKnownMachineIds: vi.fn()
}));

const { mockGetInboxStats } = vi.hoisted(() => ({
  mockGetInboxStats: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: mockGetConfig,
    loadDashboard: mockLoadDashboard,
    loadPendingDecisions: mockLoadPendingDecisions,
    getHeartbeatService: mockGetHeartbeatService,
    getKnownMachineIds: mockGetKnownMachineIds
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

// #1953 / #2318: Mock dashboard-activity utils.
// extractMachineActivity returns machines that appear on dashboards.
// Tests can override via mockExtractMachineActivity.mockReturnValue(...)
const { mockExtractMachineActivity, mockIsRecentlyActive } = vi.hoisted(() => ({
  mockExtractMachineActivity: vi.fn(() => {
    // Default: all 6 fleet machines are "seen" on dashboard (online)
    const map = new Map<string, string>();
    const now = new Date().toISOString();
    map.set('myia-ai-01', now);
    map.set('myia-po-2023', now);
    map.set('myia-po-2024', now);
    map.set('myia-po-2025', now);
    map.set('myia-po-2026', now);
    map.set('myia-web1', now);
    return map;
  }),
  mockIsRecentlyActive: vi.fn(() => true)
}));

vi.mock('../../../utils/dashboard-activity.js', () => ({
  crossCheckWithDashboard: vi.fn((state: any) => ({
    ...state,
    overrides: []
  })),
  extractMachineActivity: mockExtractMachineActivity,
  isRecentlyActive: mockIsRecentlyActive
}));

describe('get-status (Option B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({ machineId: 'myia-ai-01', sharedPath: '/shared' });
    mockLoadDashboard.mockResolvedValue({
      overallStatus: 'synced',
      lastUpdate: new Date().toISOString(),
      machines: {
        'myia-ai-01': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
        'myia-po-2023': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
        'myia-po-2024': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
        'myia-po-2025': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
        'myia-po-2026': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
        'myia-web1': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 }
      }
    });
    mockGetHeartbeatService.mockReturnValue({
      checkHeartbeats: vi.fn(),
      getState: vi.fn(() => ({
        onlineMachines: [],
        unknownMachines: [],
        idleMachines: []
      })),
      getAllSchedulerMetrics: vi.fn().mockReturnValue(new Map())
    });
    mockGetInboxStats.mockResolvedValue({ unread: 0, urgent: 0, by_priority: {} });
    mockLoadPendingDecisions.mockResolvedValue([]);
    mockGetKnownMachineIds.mockReturnValue(['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1']);
  });

  describe('GetStatusArgsSchema', () => {
    test('accepts empty input', () => {
      const result = GetStatusArgsSchema.parse({});
      expect(result).toBeDefined();
    });

    test('accepts machineFilter', () => {
      const result = GetStatusArgsSchema.parse({ machineFilter: 'myia-po-2023' });
      expect(result.machineFilter).toBe('myia-po-2023');
    });

    test('accepts resetCache', () => {
      const result = GetStatusArgsSchema.parse({ resetCache: true });
      expect(result.resetCache).toBe(true);
    });

    test('accepts includeDetails (re-added for tool usage telemetry)', () => {
      const result = GetStatusArgsSchema.parse({ includeDetails: true });
      expect(result.includeDetails).toBe(true);
    });
  });

  describe('GetStatusResultSchema', () => {
    test('validates HEALTHY result', () => {
      const result = GetStatusResultSchema.parse({
        status: 'HEALTHY',
        machines: { online: 6, unknown: 0, total: 6 },
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
        machines: { online: 4, unknown: 2, total: 6 },
        inbox: { unread: 15, urgent: 2 },
        decisions: { pending: 3 },
        dashboards: { active: 1 },
        flags: ['UNKNOWN:myia-po-2025', 'INBOX_URGENT:2', 'DECISIONS_PENDING:3'],
        lastUpdated: '2026-04-08T00:00:00Z'
      });
      expect(result.status).toBe('CRITICAL');
      expect(result.flags).toHaveLength(3);
    });

    test('rejects old status values', () => {
      expect(() => GetStatusResultSchema.parse({
        status: 'synced',
        machines: { online: 6, unknown: 0, total: 6 },
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
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: new Date().toISOString(),
        machines: {
          'myia-ai-01': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 }
        }
      });

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('HEALTHY');
      expect(result.machines.total).toBeGreaterThanOrEqual(1);
      expect(result.flags).toHaveLength(0);
    });

    test('returns CRITICAL when machines unknown', async () => {
      // #2318: Only ai-01 seen on dashboard. po-2025 not seen → UNKNOWN from registry.
      const map = new Map<string, string>();
      map.set('myia-ai-01', new Date().toISOString());
      mockExtractMachineActivity.mockReturnValue(map);

      const result = await roosyncGetStatus({});

      expect(result.status).toBe('CRITICAL');
      expect(result.machines.unknown).toBeGreaterThanOrEqual(1);
      expect(result.flags).toContain('UNKNOWN:myia-po-2025');
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
      // #2318: po-2023 not seen on dashboard, but in registry → UNKNOWN, flagged
      const map = new Map<string, string>();
      map.set('myia-ai-01', new Date().toISOString());
      mockExtractMachineActivity.mockReturnValue(map);

      const result = await roosyncGetStatus({});

      expect(result.flags).toContain('UNKNOWN:myia-po-2023');
    });

    test('throws when machine not found', async () => {
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: '2026-01-01T00:00:00Z',
        machines: { 'myia-ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 } }
      });

      await expect(roosyncGetStatus({ machineFilter: 'nonexistent' })).rejects.toThrow('non trouvée');
    });

    test('succeeds when machine found', async () => {
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: new Date().toISOString(),
        machines: { 'myia-ai-01': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 } }
      });

      const result = await roosyncGetStatus({ machineFilter: 'myia-ai-01' });
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

  describe('#1365 orphan test entry filtering', () => {
    test('excludes orphan test machines from unknown count', async () => {
      // Simulates real scenario: real machines online + 3 test artifacts unknown
      mockGetHeartbeatService.mockReturnValue({
        checkHeartbeats: vi.fn(),
        getState: vi.fn(() => ({
          onlineMachines: ['myia-ai-01', 'myia-po-2023', 'myia-po-2024'],
          unknownMachines: ['test-machine', 'persistent-machine', 'machine-2'],
          idleMachines: []
        }))
      });

      const result = await roosyncGetStatus({});

      // Orphan test machines should NOT trigger CRITICAL
      expect(result.status).toBe('HEALTHY');
      expect(result.machines.unknown).toBe(0);
      expect(result.flags).not.toContain('UNKNOWN:test-machine');
      expect(result.flags).not.toContain('UNKNOWN:persistent-machine');
    });

    test('excludes orphan test machines from dashboard total', async () => {
      mockLoadDashboard.mockResolvedValue({
        overallStatus: 'synced',
        lastUpdate: new Date().toISOString(),
        machines: {
          'myia-ai-01': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
          'myia-po-2023': { status: 'online', lastSync: new Date().toISOString(), pendingDecisions: 0, diffsCount: 0 },
          'test-machine': { status: 'unknown', lastSync: '2025-01-01', pendingDecisions: 0, diffsCount: 0 }
        }
      });
      // Only 2 real machines in registry (test-machine is not a known fleet machine)
      mockGetKnownMachineIds.mockReturnValue(['myia-ai-01', 'myia-po-2023']);
      // Dashboard activity: 2 real machines + test-machine (filtered by isKnownMachine)
      const map = new Map<string, string>();
      const now = new Date().toISOString();
      map.set('myia-ai-01', now);
      map.set('myia-po-2023', now);
      map.set('test-machine', now);
      mockExtractMachineActivity.mockReturnValue(map);

      const result = await roosyncGetStatus({});

      // Total should be 2 real machines (from registry), not 3 (test-machine filtered)
      expect(result.machines.total).toBe(2);
    });

    test('excludes orphan warning machines from status derivation', async () => {
      mockGetHeartbeatService.mockReturnValue({
        checkHeartbeats: vi.fn(),
        getState: vi.fn(() => ({
          onlineMachines: ['myia-ai-01'],
          unknownMachines: [],
          idleMachines: ['test-machine']  // Orphan, should be filtered
        }))
      });

      const result = await roosyncGetStatus({});

      // test-machine warning should NOT trigger WARNING status
      expect(result.status).toBe('HEALTHY');
      expect(result.flags).not.toContain('HEARTBEAT_STALE:test-machine');
    });

    test('still detects real unknown machines correctly', async () => {
      // #2318: Only ai-01 on dashboard. po-2025 not seen (real unknown).
      // test-machine appears on dashboard but isKnownMachine filters it out.
      const map = new Map<string, string>();
      map.set('myia-ai-01', new Date().toISOString());
      map.set('test-machine', new Date().toISOString());  // Filtered by isKnownMachine
      mockExtractMachineActivity.mockReturnValue(map);

      const result = await roosyncGetStatus({});

      // Should be CRITICAL from real unknown machine only
      expect(result.status).toBe('CRITICAL');
      expect(result.machines.unknown).toBeGreaterThanOrEqual(1);
      expect(result.flags).toContain('UNKNOWN:myia-po-2025');
      expect(result.flags).not.toContain('UNKNOWN:test-machine');
    });
  });
});
