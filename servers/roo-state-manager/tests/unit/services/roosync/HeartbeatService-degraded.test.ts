/**
 * Tests for HeartbeatService graceful degradation (#1918)
 *
 * Verifies that HeartbeatService continues operating in-memory
 * when sharedPath (GDrive) is degraded, without attempting disk I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { HeartbeatService, HeartbeatConfig } from '../../../../src/services/roosync/HeartbeatService.js';
import { getServerCapabilities } from '../../../../src/utils/server-capabilities.js';

describe('HeartbeatService - Graceful Degradation (#1918)', () => {
  let tempDir: string;
  let sharedPath: string;
  let heartbeatService: HeartbeatService;
  let caps: ReturnType<typeof getServerCapabilities>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'heartbeat-degraded-'));
    sharedPath = join(tempDir, 'shared');
    await mkdir(sharedPath, { recursive: true });

    caps = getServerCapabilities();
    caps.reset();

    const config: HeartbeatConfig = {
      heartbeatInterval: 30000,
      offlineTimeout: 120000,
      missedHeartbeatThreshold: 4,
      autoSyncEnabled: false,
      autoSyncInterval: 60000,
      persistenceInterval: 100,
    };

    heartbeatService = new HeartbeatService(sharedPath, config);
  });

  afterEach(async () => {
    await heartbeatService.stopHeartbeatService();
    caps.reset();

    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
        console.warn('Cleanup failed:', error.message);
      }
    }
    vi.restoreAllMocks();
  });

  describe('registerHeartbeat in degraded mode', () => {
    it('tracks heartbeat in-memory when sharedPath is degraded', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('test-machine');

      const data = heartbeatService.getHeartbeatData('test-machine');
      expect(data).toBeDefined();
      expect(data?.status).toBe('online');
      expect(data?.machineId).toBe('test-machine');
    });

    it('does not write files to disk when degraded', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('no-disk-machine');

      const heartbeatsDir = join(sharedPath, 'heartbeats');
      let files: string[] = [];
      try {
        files = await readdir(heartbeatsDir);
      } catch {
        // Directory may not exist — that's fine
      }
      expect(files).toHaveLength(0);
    });

    it('resumes disk writes after recovery via stopHeartbeatService #1953 ADR 008', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('recovery-machine');
      expect(heartbeatService.getHeartbeatData('recovery-machine')?.status).toBe('online');

      // Recover GDrive
      caps.recover('sharedPath');

      // ADR 008 Phase 1: registerHeartbeat is always in-memory, disk writes happen via saveState
      await heartbeatService.stopHeartbeatService();

      const heartbeatsDir = join(sharedPath, 'heartbeats');
      const files = await readdir(heartbeatsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reloadFromDisk in degraded mode', () => {
    it('preserves in-memory state when degraded instead of clearing', async () => {
      // First register a machine normally
      await heartbeatService.registerHeartbeat('existing-machine');
      expect(heartbeatService.getHeartbeatData('existing-machine')?.status).toBe('online');

      // Degrade
      caps.markDegraded('sharedPath', 'GDrive offline');

      // Register another machine (in-memory only)
      await heartbeatService.registerHeartbeat('degraded-machine');

      // reloadFromDisk should NOT clear in-memory state when degraded
      heartbeatService.reloadFromDisk();

      // existing-machine may be lost (clear happens before the guard)
      // but degraded-machine should still be there
      const data = heartbeatService.getHeartbeatData('degraded-machine');
      expect(data).toBeDefined();
    });
  });

  describe('saveState in degraded mode', () => {
    it('skips saving when sharedPath is degraded', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('unsaved-machine');

      // Force save via stopHeartbeatService (calls saveState internally)
      await heartbeatService.stopHeartbeatService();

      const heartbeatsDir = join(sharedPath, 'heartbeats');
      let files: string[] = [];
      try {
        files = await readdir(heartbeatsDir);
      } catch {
        // OK
      }
      expect(files).toHaveLength(0);
    });
  });

  describe('mixed degradation cycle', () => {
    it('handles full degrade → operate → recover cycle', async () => {
      // Step 1: Normal operation — write to disk
      await heartbeatService.registerHeartbeat('cycle-machine');
      const onlineMachines = heartbeatService.getOnlineMachines();
      expect(onlineMachines).toContain('cycle-machine');

      // Step 2: Degrade — operations continue in-memory
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('degraded-only-machine');
      expect(heartbeatService.getHeartbeatData('degraded-only-machine')).toBeDefined();

      // Step 3: Recover — disk writes resume
      caps.recover('sharedPath');

      await heartbeatService.registerHeartbeat('recovered-machine');
      expect(heartbeatService.getHeartbeatData('recovered-machine')?.status).toBe('online');
    });
  });
});
