/**
 * Smoke test for roosync_storage_management
 *
 * Purpose: Validate that roosync_storage_management returns fresh data after state changes
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * #2639: RE-ENABLED in CI (2026-10-04). Isolation is MOCK-BASED, not tmpdir-based:
 *   the tool delegates to RooStorageDetector/ZooStorageDetector, which scan real
 *   machine paths (GDrive, home dirs) through a 5-minute global cache and expose no
 *   env routing — a tmpdir ROOSYNC_SHARED_PATH never reaches them. Both detectors
 *   (and handleMaintenance) are therefore mocked, the established CI pattern
 *   (baseline.test.ts #2967, 15+ files). The #564 freshness pattern is preserved:
 *   the mock state changes between two calls and the second result must reflect it.
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 162-176)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the real-machine detectors — no real GDrive/home storage is involved (#2639)
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectRooStorage: vi.fn(),
    getStorageStats: vi.fn(),
    getWorkspaceBreakdown: vi.fn()
  }
}));
vi.mock('../../../utils/zoo-storage-detector.js', () => ({
  ZooStorageDetector: {
    getStorageStats: vi.fn()
  }
}));
vi.mock('../../maintenance/maintenance.js', () => ({
  handleMaintenance: vi.fn()
}));

import { roosyncStorageManagement } from '../storage-management.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
import { ZooStorageDetector } from '../../../utils/zoo-storage-detector.js';
import { handleMaintenance } from '../../maintenance/maintenance.js';

const rooDetect = vi.mocked(RooStorageDetector.detectRooStorage);
const rooStats = vi.mocked(RooStorageDetector.getStorageStats);
const rooBreakdown = vi.mocked(RooStorageDetector.getWorkspaceBreakdown);
const zooStats = vi.mocked(ZooStorageDetector.getStorageStats);
const maintenanceMock = vi.mocked(handleMaintenance);

describe('SMOKE: roosync_storage_management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Deterministic timestamps: two mocked calls resolve in <1ms, so real clocks
    // could stamp both with the same millisecond and flake the freshness asserts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T01:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves every storage read from the mocks, never the real detectors (isolation contract, #2639)', async () => {
    rooDetect.mockResolvedValue({ found: true, locations: [] } as any);
    zooStats.mockResolvedValue({ totalLocations: 0, totalConversations: 0, totalSize: 0 } as any);
    rooStats.mockResolvedValue({ totalLocations: 0, totalConversations: 0, totalSize: 0 } as any);
    rooBreakdown.mockResolvedValue({});

    await roosyncStorageManagement({ action: 'storage', storageAction: 'detect' });

    expect(rooDetect).toHaveBeenCalledTimes(1);
    expect(zooStats).not.toHaveBeenCalled(); // detect path reads Roo only
  });

  it('should detect storage location changes (action: storage, subAction: detect)', async () => {
    // Step 1: initial detection (baseline)
    rooDetect.mockResolvedValue({
      found: false,
      locations: []
    } as any);

    const result1 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'detect'
    });

    expect(result1.success).toBe(true);
    expect(result1.action).toBe('storage');
    expect(result1.subAction).toBe('detect');
    expect(result1.data).toMatchObject({ found: false });

    // Step 2: modify the underlying state (a location appears)
    vi.advanceTimersByTime(10);
    rooDetect.mockResolvedValue({
      found: true,
      locations: ['D:/tmp/.test-storage/tasks']
    } as any);

    // Step 3: second call must reflect the new state, not a stale cached response
    const result2 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'detect'
    });

    expect(result2.success).toBe(true);
    expect(result2.timestamp).not.toBe(result1.timestamp);
    expect(result2.data).toMatchObject({
      found: true,
      locations: ['D:/tmp/.test-storage/tasks']
    });
  });

  it('should return fresh stats after workspace changes (action: storage, subAction: stats)', async () => {
    // Step 1: initial stats (baseline, one workspace, no Zoo)
    rooStats.mockResolvedValue({
      totalLocations: 1,
      totalConversations: 5,
      totalSize: 100
    } as any);
    zooStats.mockResolvedValue({
      totalLocations: 0,
      totalConversations: 0,
      totalSize: 0
    } as any);
    rooBreakdown.mockResolvedValue({ 'workspace-1': { conversationCount: 5 } } as any);

    const result1 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'stats'
    });

    expect(result1.success).toBe(true);
    expect(result1.subAction).toBe('stats');
    expect(result1.data).toMatchObject({
      totalLocations: 1,
      totalConversations: 5,
      totalSize: 100,
      totalWorkspaces: 1,
      roo: { totalConversations: 5 }
    });
    // Zoo absent from the enhanced payload when it reports zero locations (#2429)
    expect(result1.data).not.toHaveProperty('zooCode');

    // Step 2: modify the underlying state (more workspaces + Zoo appears)
    vi.advanceTimersByTime(10);
    rooStats.mockResolvedValue({
      totalLocations: 2,
      totalConversations: 8,
      totalSize: 300
    } as any);
    zooStats.mockResolvedValue({
      totalLocations: 1,
      totalConversations: 2,
      totalSize: 50
    } as any);
    rooBreakdown.mockResolvedValue({
      'workspace-1': { conversationCount: 5 },
      'workspace-2': { conversationCount: 3 }
    } as any);

    // Step 3: second call must reflect the new state (fresh stats, not cached)
    const result2 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'stats'
    });

    expect(result2.success).toBe(true);
    expect(result2.timestamp).not.toBe(result1.timestamp);
    expect(result2.data).toMatchObject({
      totalLocations: 2,
      totalConversations: 8,
      totalSize: 300,
      totalWorkspaces: 2,
      zooCode: { totalLocations: 1 }
    });
  });

  it('should handle maintenance operations without stale cache (action: maintenance, subAction: cache_rebuild)', async () => {
    const conversationCache = new Map();
    const state = {} as any;

    // Step 1: initial cache_rebuild (baseline)
    maintenanceMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ rebuilt: 1, tasks: ['task-1'] }) }]
    } as any);

    const result1 = await roosyncStorageManagement(
      {
        action: 'maintenance',
        maintenanceAction: 'cache_rebuild',
        force_rebuild: true
      },
      conversationCache,
      state
    );

    expect(result1.success).toBe(true);
    expect(result1.action).toBe('maintenance');
    expect(result1.subAction).toBe('cache_rebuild');
    expect(result1.data).toMatchObject({ rebuilt: 1 });

    // force_rebuild must be passed through to the maintenance handler
    expect(maintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cache_rebuild', force_rebuild: true }),
      conversationCache,
      state
    );

    // Step 2: modify the underlying task data
    vi.advanceTimersByTime(10);
    maintenanceMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ rebuilt: 2, tasks: ['task-1', 'task-2'] }) }]
    } as any);

    // Step 3: second rebuild must reflect the new state
    const result2 = await roosyncStorageManagement(
      {
        action: 'maintenance',
        maintenanceAction: 'cache_rebuild',
        force_rebuild: true
      },
      conversationCache,
      state
    );

    expect(result2.success).toBe(true);
    expect(result2.timestamp).not.toBe(result1.timestamp);
    expect(result2.data).toMatchObject({ rebuilt: 2, tasks: ['task-1', 'task-2'] });
  });
});
