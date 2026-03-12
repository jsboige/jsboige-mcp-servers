/**
 * Smoke test for roosync_get_status
 *
 * Purpose: Validate that roosync_get_status returns fresh data after cache invalidation
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 162-176)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { roosyncGetStatus } from '../get-status.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs';
import * as path from 'path';

describe('SMOKE: roosync_get_status', () => {
  const testSharedStatePath = path.join(process.cwd(), '.shared-state-test');
  const testDashboardPath = path.join(testSharedStatePath, 'sync-dashboard.json');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Setup test environment with required env vars
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    // Ensure test directory exists
    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }

    // Reset service singleton before each test
    RooSyncService.resetInstance();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Cleanup test files
    if (fs.existsSync(testSharedStatePath)) {
      fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    }

    // Reset service singleton after each test
    RooSyncService.resetInstance();
  });

  it('should return fresh data after cache invalidation', async () => {
    // Step 1: Create initial dashboard state
    // Note: The service reads sync-dashboard.json (not dashboard.json)
    // and expects a machines object with per-machine status entries.
    const initialDashboard = {
      overallStatus: 'synced' as const,
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online' as const,
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    // Step 2: Initial call to get baseline (will cache the dashboard)
    const result1 = await roosyncGetStatus({});

    expect(result1.status).toBe('synced');
    // The service may add the local machine to the dashboard, so check at least 1
    expect(result1.machines.length).toBeGreaterThanOrEqual(1);
    const machine1 = result1.machines.find(m => m.id === 'test-machine-1');
    expect(machine1).toBeDefined();
    expect(machine1?.status).toBe('online');
    expect(machine1?.pendingDecisions).toBe(0);

    // Step 3: Modify the underlying state (simulate RooSync state change)
    const modifiedDashboard = {
      overallStatus: 'diverged' as const,
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged' as const,
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        },
        'test-machine-2': {
          status: 'online' as const,
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Step 4: Call with resetCache=true to force cache invalidation
    const result2 = await roosyncGetStatus({ resetCache: true });

    // Step 5: Verify that result2 reflects the state change (not stale cached data)
    expect(result2.status).toBe('diverged');
    expect(result2.lastSync).toBe('2026-03-11T11:00:00Z');
    // Should have at least the 2 machines from the modified dashboard
    expect(result2.machines.length).toBeGreaterThanOrEqual(2);

    const updatedMachine1 = result2.machines.find(m => m.id === 'test-machine-1');
    expect(updatedMachine1).toBeDefined();
    expect(updatedMachine1?.status).toBe('diverged');
    expect(updatedMachine1?.pendingDecisions).toBe(2);
    expect(updatedMachine1?.diffsCount).toBe(5);

    const machine2 = result2.machines.find(m => m.id === 'test-machine-2');
    expect(machine2).toBeDefined();
    expect(machine2?.status).toBe('online');

    // Verify summary reflects updated state
    expect(result2.summary?.totalDiffs).toBeGreaterThanOrEqual(5);
    expect(result2.summary?.totalPendingDecisions).toBeGreaterThanOrEqual(2);
  });

  it('should return stale data WITHOUT resetCache (validates cache behavior)', async () => {
    // This test validates that WITHOUT resetCache, the cache DOES persist
    // This is important to confirm the smoke test above is actually testing cache invalidation

    // Step 1: Create initial dashboard state
    const initialDashboard = {
      overallStatus: 'synced' as const,
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online' as const,
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    // Step 2: Initial call to populate cache
    const result1 = await roosyncGetStatus({});

    expect(result1.status).toBe('synced');
    expect(result1.machines.length).toBeGreaterThanOrEqual(1);

    // Step 3: Modify the underlying state
    const modifiedDashboard = {
      overallStatus: 'diverged' as const,
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged' as const,
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Step 4: Call WITHOUT resetCache - should return cached (stale) data
    const result2 = await roosyncGetStatus({});

    // Step 5: Verify cache persists (stale data returned)
    // The status should still be 'synced' (the cached value, not the new 'diverged')
    expect(result2.status).toBe('synced');
  });
});
