/**
 * Tests pour IdentityManager.ts — #2121 Phase 2.1
 * Dashboard-derived identity model (HeartbeatService-backed, no disk I/O)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { IdentityManager, IdentitySource } from '../IdentityManager.js';
import { PresenceManager } from '../PresenceManager.js';
import { HeartbeatService } from '../HeartbeatService.js';

const mockConfig = {
  machineId: 'test-machine',
  sharedPath: '/shared/path'
};

function createMocks() {
  const heartbeatService = new HeartbeatService('/test');
  const presenceManager = new PresenceManager(mockConfig as any, heartbeatService);
  return { heartbeatService, presenceManager };
}

describe('IdentityManager', () => {
  let manager: IdentityManager;
  let heartbeatService: HeartbeatService;
  let presenceManager: PresenceManager;

  beforeEach(() => {
    ({ heartbeatService, presenceManager } = createMocks());
    manager = new IdentityManager(mockConfig as any, presenceManager, heartbeatService);
  });

  // ============================================================
  // collectAllIdentities
  // ============================================================

  describe('collectAllIdentities', () => {
    test('includes config identity by default', async () => {
      const identities = await manager.collectAllIdentities();
      expect(identities.has('test-machine')).toBe(true);
      expect(identities.get('test-machine')?.source).toBe('config');
    });

    test('includes heartbeat identities', async () => {
      await heartbeatService.registerHeartbeat('machine-a');
      await heartbeatService.registerHeartbeat('machine-b');

      const identities = await manager.collectAllIdentities();
      expect(identities.has('machine-a')).toBe(true);
      expect(identities.has('machine-b')).toBe(true);
      expect(identities.get('machine-a')?.source).toBe('heartbeat');
    });

    test('config identity takes priority over heartbeat', async () => {
      await heartbeatService.registerHeartbeat('test-machine');

      const identities = await manager.collectAllIdentities();
      // test-machine is in both config and heartbeat — config wins
      expect(identities.get('test-machine')?.source).toBe('config');
    });

    test('includes presence identities from PresenceManager', async () => {
      // Register via heartbeat (PresenceManager reads from HeartbeatService)
      await heartbeatService.registerHeartbeat('presence-machine');

      const identities = await manager.collectAllIdentities();
      expect(identities.has('presence-machine')).toBe(true);
    });

    test('returns correct identity count', async () => {
      await heartbeatService.registerHeartbeat('machine-a');
      await heartbeatService.registerHeartbeat('machine-b');

      const identities = await manager.collectAllIdentities();
      // test-machine (config) + machine-a + machine-b = 3
      expect(identities.size).toBe(3);
    });
  });

  // ============================================================
  // validateIdentities
  // ============================================================

  describe('validateIdentities', () => {
    test('returns valid when no conflicts', async () => {
      const result = await manager.validateIdentities();
      expect(result.isValid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    test('returns valid even with multiple machines', async () => {
      await heartbeatService.registerHeartbeat('machine-a');
      await heartbeatService.registerHeartbeat('machine-b');

      const result = await manager.validateIdentities();
      expect(result.isValid).toBe(true);
    });

    test('includes empty orphaned array', async () => {
      const result = await manager.validateIdentities();
      expect(result.orphaned).toEqual([]);
    });

    test('includes recommendations array', async () => {
      const result = await manager.validateIdentities();
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(result.recommendations).toContain('No identity issues detected');
    });
  });

  // ============================================================
  // getPrimaryIdentity
  // ============================================================

  describe('getPrimaryIdentity', () => {
    test('returns config identity with correct machineId', () => {
      const identity = manager.getPrimaryIdentity();
      expect(identity.machineId).toBe('test-machine');
      expect(identity.source).toBe('config');
      expect(identity.status).toBe('valid');
    });

    test('returns valid timestamps', () => {
      const identity = manager.getPrimaryIdentity();
      expect(identity.firstSeen).toBeTruthy();
      expect(identity.lastSeen).toBeTruthy();
      expect(new Date(identity.firstSeen).getTime()).not.toBeNaN();
    });

    test('includes configPath metadata', () => {
      const identity = manager.getPrimaryIdentity();
      expect(identity.metadata?.configPath).toBeDefined();
    });
  });

  // ============================================================
  // syncIdentityRegistry (deprecated no-op)
  // ============================================================

  describe('syncIdentityRegistry', () => {
    test('completes without error (no-op)', async () => {
      await expect(manager.syncIdentityRegistry()).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // cleanupIdentities (deprecated no-op)
  // ============================================================

  describe('cleanupIdentities', () => {
    test('returns empty results when nothing to clean', async () => {
      const result = await manager.cleanupIdentities();
      expect(result.removed).toEqual([]);
      expect(result.resolved).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    test('returns empty even with options', async () => {
      const result = await manager.cleanupIdentities({
        removeOrphaned: true,
        resolveConflicts: true,
        dryRun: true
      });
      expect(result.removed).toEqual([]);
      expect(result.resolved).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  // ============================================================
  // checkIdentityConflict
  // ============================================================

  describe('checkIdentityConflict', () => {
    test('passes when no existing heartbeat', async () => {
      await expect(manager.checkIdentityConflict()).resolves.toBeUndefined();
    });

    test('passes when previous heartbeat is expired (>5min)', async () => {
      // Register a heartbeat, then backdate it
      await heartbeatService.registerHeartbeat('test-machine');
      const data = heartbeatService.getHeartbeatData('test-machine')!;
      data.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      await expect(manager.checkIdentityConflict()).resolves.toBeUndefined();
    });

    test('warns but passes when recent heartbeat exists (<5min)', async () => {
      await heartbeatService.registerHeartbeat('test-machine');

      // Should not throw — concurrent instances are normal with auto-heartbeat
      await expect(manager.checkIdentityConflict()).resolves.toBeUndefined();
    });
  });
});
