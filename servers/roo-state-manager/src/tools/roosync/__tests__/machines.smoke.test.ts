/**
 * Smoke test for roosync_machines
 *
 * Purpose: Validate that roosync_machines returns fresh data after heartbeat state changes
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 88-95)
 * @see src/services/roosync/HeartbeatService.ts - Per-machine file architecture (v3.1.0)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncMachines } from '../machines.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs';
import * as path from 'path';

// Unmock modules that jest.setup.js mocks globally.
// Smoke tests need real filesystem and real RooSyncService (not mocks).
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

describe('SMOKE: roosync_machines', () => {
  // Use unique directory per test file to avoid ENOTEMPTY cleanup errors
  const testSharedStatePath = path.join(process.cwd(), '.shared-state-test-machines');
  const testHeartbeatsDir = path.join(testSharedStatePath, 'heartbeats');
  let originalEnv: NodeJS.ProcessEnv;

  /**
   * Helper: Create a HeartbeatData object with proper structure
   * Matches the format expected by HeartbeatService v3.1.0 per-machine files
   */
  function makeHeartbeatData(
    machineId: string,
    status: 'online' | 'offline' | 'warning',
    minutesAgo: number = 0
  ): Record<string, any> {
    const now = Date.now();
    const lastHeartbeat = new Date(now - minutesAgo * 60 * 1000).toISOString();

    const data: Record<string, any> = {
      machineId,
      lastHeartbeat,
      status,
      missedHeartbeats: 0,
      metadata: {
        firstSeen: lastHeartbeat,
        lastUpdated: new Date(now).toISOString(),
        version: '3.1.0',
      },
    };

    // For offline machines, include offlineSince timestamp
    // (HeartbeatService sets this when marking a machine as offline)
    if (status === 'offline') {
      data.offlineSince = lastHeartbeat;
      data.missedHeartbeats = Math.floor(minutesAgo / 5); // ~5 min heartbeat interval
    }

    return data;
  }

  /**
   * Helper: Write per-machine heartbeat files
   * HeartbeatService v3.1.0 uses heartbeats/{machineId}.json files instead of heartbeat.json
   */
  function writeHeartbeatFiles(machines: Record<string, any>): void {
    if (!fs.existsSync(testHeartbeatsDir)) {
      fs.mkdirSync(testHeartbeatsDir, { recursive: true });
    }

    for (const [machineId, data] of Object.entries(machines)) {
      const heartbeatPath = path.join(testHeartbeatsDir, `${machineId}.json`);
      fs.writeFileSync(heartbeatPath, JSON.stringify(data, null, 2));
    }
  }

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Setup test environment with required env vars
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    // Reset RooSyncService singleton to pick up new env vars
    // (HeartbeatService inside RooSyncService uses ROOSYNC_SHARED_PATH from constructor)
    RooSyncService.resetInstance();

    // Ensure test directory exists
    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test files
    if (fs.existsSync(testSharedStatePath)) {
      fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    }

    // Reset RooSyncService singleton to restore original state
    RooSyncService.resetInstance();

    // Restore original environment
    process.env = originalEnv;
  });

  it('should detect offline machines after heartbeat timeout (status: offline)', async () => {
    // Step 1: Create initial heartbeat state with all machines online
    const initialMachines = {
      'test-machine-1': makeHeartbeatData('test-machine-1', 'online'),
      'test-machine-2': makeHeartbeatData('test-machine-2', 'online'),
    };

    writeHeartbeatFiles(initialMachines);

    // Step 2: Initial call to get baseline (should show no offline machines)
    const result1 = await roosyncMachines({ status: 'offline', includeDetails: true });

    expect(result1.success).toBe(true);
    expect(result1.data).toBeDefined();
    expect(result1.data.offlineMachines).toHaveLength(0); // No offline machines initially

    // Step 3: Modify the underlying state (simulate machine going offline)
    const modifiedMachines = {
      ...initialMachines,
      'test-machine-1': makeHeartbeatData('test-machine-1', 'offline', 20), // 20 minutes ago
    };

    writeHeartbeatFiles(modifiedMachines);

    // Step 4: Second call to get offline machines with details
    const result2 = await roosyncMachines({ status: 'offline', includeDetails: true });

    // Step 5: Verify that result2 reflects the state change (fresh offline list, not cached)
    expect(result2.success).toBe(true);
    expect(result2.data.offlineMachines).toHaveLength(1);
    expect(result2.data.offlineMachines[0].machineId).toBe('test-machine-1');

    // This validates that offline machines are read fresh from heartbeat state,
    // not from stale cached data that would show 0 offline machines
  });

  it('should detect warning machines after threshold change (status: warning)', async () => {
    // Step 1: Create initial heartbeat state with all machines healthy
    const initialMachines = {
      'test-machine-3': makeHeartbeatData('test-machine-3', 'online'),
    };

    writeHeartbeatFiles(initialMachines);

    // Step 2: Initial call to get baseline (should show no warning machines)
    const result1 = await roosyncMachines({ status: 'warning', includeDetails: true });

    expect(result1.success).toBe(true);
    expect(result1.data.warningMachines).toBeDefined();
    expect(result1.data.warningMachines).toHaveLength(0); // No warning machines initially

    // Step 3: Modify the underlying state (simulate machine entering warning state)
    const modifiedMachines = {
      'test-machine-3': makeHeartbeatData('test-machine-3', 'warning', 8), // 8 minutes ago
    };

    writeHeartbeatFiles(modifiedMachines);

    // Step 4: Second call to get warning machines with details
    const result2 = await roosyncMachines({ status: 'warning', includeDetails: true });

    // Step 5: Verify that result2 reflects the state change (fresh warning list, not cached)
    expect(result2.success).toBe(true);
    expect(result2.data.warningMachines).toHaveLength(1);
    expect(result2.data.warningMachines[0].machineId).toBe('test-machine-3');

    // This validates that warning machines are read fresh from heartbeat state,
    // not returning stale cached results
  });

  it('should return all machines with fresh status (status: all)', async () => {
    // Step 1: Create initial heartbeat state
    const initialMachines = {
      'test-machine-4': makeHeartbeatData('test-machine-4', 'online'),
    };

    writeHeartbeatFiles(initialMachines);

    // Step 2: Initial call to get baseline (no offline or warning machines)
    const result1 = await roosyncMachines({ status: 'all', includeDetails: true });

    expect(result1.success).toBe(true);
    expect(result1.data.offlineMachines).toHaveLength(0);
    expect(result1.data.warningMachines).toHaveLength(0);

    // Step 3: Modify the underlying state (add more machines with different statuses)
    const modifiedMachines = {
      ...initialMachines,
      'test-machine-5': makeHeartbeatData('test-machine-5', 'offline', 12),
      'test-machine-6': makeHeartbeatData('test-machine-6', 'warning', 7),
    };

    writeHeartbeatFiles(modifiedMachines);

    // Step 4: Second call to get all machines
    const result2 = await roosyncMachines({ status: 'all', includeDetails: true });

    // Step 5: Verify that result2 reflects the state change
    expect(result2.success).toBe(true);
    // With status: 'all', we get both offlineMachines and warningMachines
    expect(result2.data.offlineMachines).toHaveLength(1);
    expect(result2.data.warningMachines).toHaveLength(1);

    // Verify machine IDs are correct
    expect(result2.data.offlineMachines[0].machineId).toBe('test-machine-5');
    expect(result2.data.warningMachines[0].machineId).toBe('test-machine-6');

    // This validates that the machine list is computed fresh from heartbeat state,
    // not showing stale list that would only have 1 machine
  });
});
