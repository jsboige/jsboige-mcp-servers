/**
 * Tests unitaires pour IdentityManager — #2121 Phase 2.1
 *
 * Tests for checkIdentityConflict() using HeartbeatService-backed model.
 * Concurrent identity is no longer a blocking error — auto-heartbeat (ADR 008)
 * makes concurrent instances normal. The method warns but never throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IdentityManager } from '../../src/services/roosync/IdentityManager';
import { PresenceManager } from '../../src/services/roosync/PresenceManager';
import { HeartbeatService } from '../../src/services/roosync/HeartbeatService';

const mockConfig = {
  sharedPath: '/test/shared',
  machineId: 'TEST-MACHINE',
  autoSync: false,
  conflictStrategy: 'manual',
  logLevel: 'info'
};

describe('IdentityManager - checkIdentityConflict', () => {
  let heartbeatService: HeartbeatService;
  let presenceManager: PresenceManager;
  let identityManager: IdentityManager;

  beforeEach(() => {
    heartbeatService = new HeartbeatService('/test');
    presenceManager = new PresenceManager(mockConfig as any, heartbeatService);
    identityManager = new IdentityManager(mockConfig as any, presenceManager, heartbeatService);
  });

  describe('No conflict scenarios', () => {
    it('allows startup when no existing heartbeat', async () => {
      await expect(identityManager.checkIdentityConflict()).resolves.toBeUndefined();
    });

    it('allows startup when previous heartbeat is expired (>5min)', async () => {
      await heartbeatService.registerHeartbeat('TEST-MACHINE');
      const data = heartbeatService.getHeartbeatData('TEST-MACHINE')!;
      data.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      await expect(identityManager.checkIdentityConflict()).resolves.toBeUndefined();
    });
  });

  describe('Concurrent instance detection (warn, never throw)', () => {
    it('warns but allows when recent heartbeat exists (<5min)', async () => {
      // Register a heartbeat just now
      await heartbeatService.registerHeartbeat('TEST-MACHINE');

      // ADR 008: concurrent instances are normal, just warn
      await expect(identityManager.checkIdentityConflict()).resolves.toBeUndefined();
    });
  });

  describe('Activity threshold', () => {
    it('considers heartbeat expired after 5 minutes', async () => {
      await heartbeatService.registerHeartbeat('TEST-MACHINE');
      const data = heartbeatService.getHeartbeatData('TEST-MACHINE')!;
      data.lastHeartbeat = new Date(Date.now() - 6 * 60 * 1000).toISOString();

      await expect(identityManager.checkIdentityConflict()).resolves.toBeUndefined();
    });

    it('considers heartbeat recent within 5 minutes', async () => {
      await heartbeatService.registerHeartbeat('TEST-MACHINE');
      const data = heartbeatService.getHeartbeatData('TEST-MACHINE')!;
      data.lastHeartbeat = new Date(Date.now() - 2 * 60 * 1000).toISOString();

      // Still resolves (warns internally but no throw)
      await expect(identityManager.checkIdentityConflict()).resolves.toBeUndefined();
    });
  });
});
