/**
 * Smoke test for roosync_machines
 *
 * ADR 008 Phase 2: HeartbeatService is in-memory only (no disk I/O).
 * Machines are registered via registerHeartbeat(), status is derived from
 * elapsed time: ONLINE (<30min), IDLE (30-120min), UNKNOWN (>120min).
 *
 * #2639: RE-ENABLED in CI (2026-10-03). Same method as get-status.smoke: the
 *   test runs against a tmpdir ROOSYNC_SHARED_PATH it creates itself in
 *   beforeEach and removes in afterEach — no real GDrive/RooSync state is
 *   involved. The previous hardcoded `/tmp/...` path was POSIX-only and the
 *   directory lifecycle was implicit (left to the service); both are now
 *   explicit and portable via os.tmpdir().
 *
 * @module roosync/machines.smoke.test
 * @version 3.1.0 (ADR 008 Phase 2 — in-memory model; #2639 CI re-enable)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncMachines } from '../machines.js';
import { getRooSyncService } from '../../../services/lazy-roosync.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('os');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

describe('SMOKE: roosync_machines', () => {
  const testSharedStatePath = path.join(os.tmpdir(), '.shared-state-test-machines');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }
  });

  afterEach(async () => {
    const { RooSyncService } = await import('../../../services/RooSyncService.js');
    RooSyncService.resetInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    process.env = originalEnv;
    if (fs.existsSync(testSharedStatePath)) {
      fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  it('runs against the tmpdir shared state it creates (isolation contract, #2639)', async () => {
    await registerMachineWithAge('test-machine-0', 5);
    // The heartbeat store must live under ROOSYNC_SHARED_PATH (the tmpdir this
    // test created), never under a real GDrive/RooSync location.
    expect(process.env.ROOSYNC_SHARED_PATH).toBe(testSharedStatePath);
    expect(fs.existsSync(testSharedStatePath)).toBe(true);
  });

  /**
   * Register machines and manipulate their lastHeartbeat to simulate elapsed time.
   * Status is derived by checkHeartbeats() based on thresholds:
   *   ONLINE: <30min, IDLE: 30-120min, UNKNOWN: >120min
   */
  async function registerMachineWithAge(machineId: string, minutesAgo: number): Promise<void> {
    const rooSyncService = await getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    await heartbeatService.registerHeartbeat(machineId);
    const data = heartbeatService.getHeartbeatData(machineId.toLowerCase());
    if (data) {
      data.lastHeartbeat = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    }
    await heartbeatService.checkHeartbeats();
  }

  async function resetService(): Promise<void> {
    const { RooSyncService } = await import('../../../services/RooSyncService.js');
    RooSyncService.resetInstance();
  }

  it('should detect unknown machines after heartbeat timeout (status: unknown)', { timeout: 30000 }, async () => {
    await registerMachineWithAge('test-machine-1', 5);
    await registerMachineWithAge('test-machine-2', 5);

    const result1 = await roosyncMachines({ status: 'unknown', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.unknownMachines).toHaveLength(0);

    await resetService();
    await registerMachineWithAge('test-machine-1', 150);
    await registerMachineWithAge('test-machine-2', 5);

    const result2 = await roosyncMachines({ status: 'unknown', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.unknownMachines).toHaveLength(1);
    expect(result2.data.unknownMachines[0].machineId).toBe('test-machine-1');
  });

  it('should detect idle machines after threshold change (status: idle)', async () => {
    await registerMachineWithAge('test-machine-3', 5);

    const result1 = await roosyncMachines({ status: 'idle', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.idleMachines).toHaveLength(0);

    await resetService();
    await registerMachineWithAge('test-machine-3', 45);

    const result2 = await roosyncMachines({ status: 'idle', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.idleMachines).toHaveLength(1);
    expect(result2.data.idleMachines[0].machineId).toBe('test-machine-3');
  });

  it('should return all machines with fresh status (status: all)', async () => {
    await registerMachineWithAge('test-machine-4', 5);

    const result1 = await roosyncMachines({ status: 'all', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.unknownMachines).toHaveLength(0);
    expect(result1.data.idleMachines).toHaveLength(0);

    await resetService();
    await registerMachineWithAge('test-machine-4', 5);
    await registerMachineWithAge('test-machine-5', 150);
    await registerMachineWithAge('test-machine-6', 45);

    const result2 = await roosyncMachines({ status: 'all', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.unknownMachines).toHaveLength(1);
    expect(result2.data.idleMachines).toHaveLength(1);
    expect(result2.data.unknownMachines[0].machineId).toBe('test-machine-5');
    expect(result2.data.idleMachines[0].machineId).toBe('test-machine-6');
  });
});
