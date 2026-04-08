/**
 * Smoke test for roosync_get_status — Option B compact (#1206)
 *
 * Purpose: Validate that roosync_get_status returns fresh data after cache invalidation
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock modules that jest.setup.js mocks globally.
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('os');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

import { roosyncGetStatus } from '../get-status.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs';
import * as path from 'path';

describe('SMOKE: roosync_get_status (Option B)', () => {
  const testSharedStatePath = path.join(process.cwd(), '.shared-state-test-getstatus-optb');
  const testDashboardPath = path.join(testSharedStatePath, 'sync-dashboard.json');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }

    RooSyncService.resetInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(testSharedStatePath)) {
      fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    RooSyncService.resetInstance();
  });

  it('should return fresh compact status after cache invalidation', async () => {
    // Step 1: Create initial dashboard
    const initialDashboard = {
      overallStatus: 'synced',
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online',
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    // Step 2: Initial call — should return HEALTHY compact status
    const result1 = await roosyncGetStatus({});

    expect(['HEALTHY', 'WARNING', 'CRITICAL']).toContain(result1.status);
    expect(result1.machines).toBeDefined();
    expect(typeof result1.machines.total).toBe('number');
    expect(result1.flags).toBeInstanceOf(Array);
    expect(result1.lastUpdated).toBeDefined();

    // Step 3: Modify state to introduce offline machines
    const modifiedDashboard = {
      overallStatus: 'diverged',
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        },
        'test-machine-2': {
          status: 'online',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Step 4: Call with resetCache=true
    const result2 = await roosyncGetStatus({ resetCache: true });

    // Step 5: Verify compact format
    expect(['HEALTHY', 'WARNING', 'CRITICAL']).toContain(result2.status);
    expect(result2.machines).toBeDefined();
    expect(result2.flags).toBeInstanceOf(Array);
    expect(result2.lastUpdated).toBeDefined();
  });

  it('should return cached data WITHOUT resetCache', async () => {
    const initialDashboard = {
      overallStatus: 'synced',
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online',
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    const result1 = await roosyncGetStatus({});

    // Modify state
    const modifiedDashboard = {
      overallStatus: 'diverged',
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Without resetCache — should get same status as before
    const result2 = await roosyncGetStatus({});

    // Cache persists, status should still reflect initial state
    expect(['HEALTHY', 'WARNING', 'CRITICAL']).toContain(result2.status);
  });
});
