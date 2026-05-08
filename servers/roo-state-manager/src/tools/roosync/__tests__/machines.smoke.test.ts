/**
 * Smoke test for roosync_machines
 *
 * ADR 008 Phase 2: offline/warning removed, only unknown/idle/all.
 *
 * @module roosync/machines.smoke.test
 * @version 2.0.0 (ADR 008 Phase 2)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncMachines } from '../machines.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
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
  const testHeartbeatsDir = path.join(testSharedStatePath, 'heartbeats');
  let originalEnv: NodeJS.ProcessEnv;

  function makeHeartbeatData(
    machineId: string,
    status: 'online' | 'unknown' | 'idle',
    minutesAgo: number = 0
  ): Record<string, any> {
    const now = Date.now();
    const lastHeartbeat = new Date(now - minutesAgo * 60 * 1000).toISOString();
    return {
      machineId,
      lastHeartbeat,
      status,
      metadata: { firstSeen: lastHeartbeat, lastUpdated: new Date(now).toISOString(), version: '4.0.0' },
    };
  }

  function writeHeartbeatFiles(machines: Record<string, any>): void {
    if (!fs.existsSync(testHeartbeatsDir)) {
      fs.mkdirSync(testHeartbeatsDir, { recursive: true });
    }
    for (const [machineId, data] of Object.entries(machines)) {
      fs.writeFileSync(path.join(testHeartbeatsDir, `${machineId}.json`), JSON.stringify(data, null, 2));
    }
  }

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';
    RooSyncService.resetInstance();
    if (!fs.existsSync(testSharedStatePath)) fs.mkdirSync(testSharedStatePath, { recursive: true });
  });

  afterEach(async () => {
    RooSyncService.resetInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    if (fs.existsSync(testSharedStatePath)) fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('should detect unknown machines after heartbeat timeout (status: unknown)', async () => {
    const initialMachines = {
      'test-machine-1': makeHeartbeatData('test-machine-1', 'online'),
      'test-machine-2': makeHeartbeatData('test-machine-2', 'online'),
    };
    writeHeartbeatFiles(initialMachines);

    const result1 = await roosyncMachines({ status: 'unknown', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.unknownMachines).toHaveLength(0);

    const modifiedMachines = {
      ...initialMachines,
      'test-machine-1': makeHeartbeatData('test-machine-1', 'unknown', 20),
    };
    writeHeartbeatFiles(modifiedMachines);
    RooSyncService.resetInstance();

    const result2 = await roosyncMachines({ status: 'unknown', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.unknownMachines).toHaveLength(1);
    expect(result2.data.unknownMachines[0].machineId).toBe('test-machine-1');
  });

  it('should detect idle machines after threshold change (status: idle)', async () => {
    const initialMachines = {
      'test-machine-3': makeHeartbeatData('test-machine-3', 'online'),
    };
    writeHeartbeatFiles(initialMachines);

    const result1 = await roosyncMachines({ status: 'idle', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.idleMachines).toHaveLength(0);

    const modifiedMachines = {
      'test-machine-3': makeHeartbeatData('test-machine-3', 'idle', 8),
    };
    writeHeartbeatFiles(modifiedMachines);
    RooSyncService.resetInstance();

    const result2 = await roosyncMachines({ status: 'idle', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.idleMachines).toHaveLength(1);
    expect(result2.data.idleMachines[0].machineId).toBe('test-machine-3');
  });

  it('should return all machines with fresh status (status: all)', async () => {
    const initialMachines = {
      'test-machine-4': makeHeartbeatData('test-machine-4', 'online'),
    };
    writeHeartbeatFiles(initialMachines);

    const result1 = await roosyncMachines({ status: 'all', includeDetails: true });
    expect(result1.success).toBe(true);
    expect(result1.data.unknownMachines).toHaveLength(0);
    expect(result1.data.idleMachines).toHaveLength(0);

    const modifiedMachines = {
      ...initialMachines,
      'test-machine-5': makeHeartbeatData('test-machine-5', 'unknown', 12),
      'test-machine-6': makeHeartbeatData('test-machine-6', 'idle', 7),
    };
    writeHeartbeatFiles(modifiedMachines);
    RooSyncService.resetInstance();

    const result2 = await roosyncMachines({ status: 'all', includeDetails: true });
    expect(result2.success).toBe(true);
    expect(result2.data.unknownMachines).toHaveLength(1);
    expect(result2.data.idleMachines).toHaveLength(1);
    expect(result2.data.unknownMachines[0].machineId).toBe('test-machine-5');
    expect(result2.data.idleMachines[0].machineId).toBe('test-machine-6');
  });
});
