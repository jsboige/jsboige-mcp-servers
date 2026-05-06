/**
 * Tests for HeartbeatService graceful degradation (#1918)
 *
 * ADR 008 Phase 2: HeartbeatService is purely in-memory.
 * All operations work regardless of sharedPath/GDrive state.
 * No disk I/O ever, so degradation has no effect on functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeartbeatService, HeartbeatConfig } from '../../../../src/services/roosync/HeartbeatService.js';
import { getServerCapabilities } from '../../../../src/utils/server-capabilities.js';

describe('HeartbeatService - Graceful Degradation (#1918)', () => {
  let heartbeatService: HeartbeatService;
  let caps: ReturnType<typeof getServerCapabilities>;

  beforeEach(() => {
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

    heartbeatService = new HeartbeatService('/test/shared', config);
  });

  afterEach(() => {
    caps.reset();
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

    it('does not attempt disk I/O (ADR 008: no disk writes ever)', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('no-disk-machine');

      // ADR 008: No disk writes, machine is in-memory regardless of degradation
      expect(heartbeatService.getHeartbeatData('no-disk-machine')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('no-disk-machine')?.status).toBe('online');
    });

    it('in-memory state preserved after recovery — no disk needed #1953 ADR 008', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('recovery-machine');
      expect(heartbeatService.getHeartbeatData('recovery-machine')?.status).toBe('online');

      // Recover GDrive (irrelevant for ADR 008 but tests the cycle)
      caps.recover('sharedPath');

      // stopHeartbeatService is a no-op in ADR 008
      await heartbeatService.stopHeartbeatService();

      // Machine still in memory — never left
      expect(heartbeatService.getHeartbeatData('recovery-machine')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('recovery-machine')?.status).toBe('online');
    });
  });

  describe('reloadFromDisk in degraded mode', () => {
    it('preserves in-memory state (reloadFromDisk is no-op in ADR 008)', async () => {
      await heartbeatService.registerHeartbeat('existing-machine');
      expect(heartbeatService.getHeartbeatData('existing-machine')?.status).toBe('online');

      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('degraded-machine');

      // reloadFromDisk is a no-op in ADR 008 — state preserved
      heartbeatService.reloadFromDisk();

      const dataExisting = heartbeatService.getHeartbeatData('existing-machine');
      const dataDegraded = heartbeatService.getHeartbeatData('degraded-machine');
      expect(dataExisting).toBeDefined();
      expect(dataDegraded).toBeDefined();
    });
  });

  describe('saveState in degraded mode', () => {
    it('no disk writes regardless of degradation (ADR 008 no-op)', async () => {
      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('unsaved-machine');

      // stopHeartbeatService is a no-op — no disk writes
      await heartbeatService.stopHeartbeatService();

      // Machine still in memory
      expect(heartbeatService.getHeartbeatData('unsaved-machine')).toBeDefined();
    });
  });

  describe('mixed degradation cycle', () => {
    it('handles full degrade → operate → recover cycle', async () => {
      await heartbeatService.registerHeartbeat('cycle-machine');
      const onlineMachines = heartbeatService.getOnlineMachines();
      expect(onlineMachines).toContain('cycle-machine');

      caps.markDegraded('sharedPath', 'GDrive offline');

      await heartbeatService.registerHeartbeat('degraded-only-machine');
      expect(heartbeatService.getHeartbeatData('degraded-only-machine')).toBeDefined();

      caps.recover('sharedPath');

      await heartbeatService.registerHeartbeat('recovered-machine');
      expect(heartbeatService.getHeartbeatData('recovered-machine')?.status).toBe('online');
    });
  });
});
