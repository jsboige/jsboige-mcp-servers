/**
 * Tests pour PresenceManager.ts — #2121 Phase 2.1
 * Dashboard-derived presence model (HeartbeatService-backed, no disk I/O)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PresenceManager, PresenceManagerError, PresenceData } from '../PresenceManager.js';
import { HeartbeatService } from '../HeartbeatService.js';

const mockConfig = {
  machineId: 'test-machine',
  sharedPath: '/shared/path'
};

function createMockHeartbeatService(): HeartbeatService {
  const service = new HeartbeatService('/test');
  return service;
}

describe('PresenceManager', () => {
  let manager: PresenceManager;
  let heartbeatService: HeartbeatService;

  beforeEach(() => {
    heartbeatService = createMockHeartbeatService();
    manager = new PresenceManager(mockConfig as any, heartbeatService);
  });

  // ============================================================
  // PresenceManagerError
  // ============================================================

  describe('PresenceManagerError', () => {
    test('creates error with message prefix', () => {
      const err = new PresenceManagerError('test error');
      expect(err.message).toBe('[PresenceManager] test error');
      expect(err.name).toBe('PresenceManagerError');
    });

    test('creates error with code', () => {
      const err = new PresenceManagerError('test', 'SOME_CODE');
      expect(err.code).toBe('SOME_CODE');
    });
  });

  // ============================================================
  // readPresence
  // ============================================================

  describe('readPresence', () => {
    test('returns null when machine not in HeartbeatService', async () => {
      const result = await manager.readPresence('unknown-machine');
      expect(result).toBeNull();
    });

    test('returns PresenceData when machine has heartbeat', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      const result = await manager.readPresence('machine-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('machine-1');
      expect(result!.status).toBe('online');
      expect(result!.source).toBe('heartbeat');
    });
  });

  // ============================================================
  // updateCurrentPresence
  // ============================================================

  describe('updateCurrentPresence', () => {
    test('registers heartbeat for config machineId', async () => {
      const result = await manager.updateCurrentPresence();
      expect(result.success).toBe(true);

      // Verify heartbeat was registered
      const data = heartbeatService.getHeartbeatData('test-machine');
      expect(data).toBeDefined();
      expect(data!.machineId).toBe('test-machine');
    });

    test('returns success regardless of parameters', async () => {
      const result = await manager.updateCurrentPresence('offline', 'debug');
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // updatePresence (backward compat stub)
  // ============================================================

  describe('updatePresence', () => {
    test('registers heartbeat and returns success', async () => {
      const result = await manager.updatePresence('machine-1', { status: 'online' });
      expect(result.success).toBe(true);

      const data = heartbeatService.getHeartbeatData('machine-1');
      expect(data).toBeDefined();
    });
  });

  // ============================================================
  // removePresence
  // ============================================================

  describe('removePresence', () => {
    test('removes machine from HeartbeatService', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      const result = await manager.removePresence('machine-1');
      expect(result).toBe(true);

      const data = heartbeatService.getHeartbeatData('machine-1');
      expect(data).toBeUndefined();
    });
  });

  // ============================================================
  // listAllPresence
  // ============================================================

  describe('listAllPresence', () => {
    test('returns empty array when no machines registered', async () => {
      const result = await manager.listAllPresence();
      expect(result).toEqual([]);
    });

    test('returns PresenceData for all registered machines', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');

      const result = await manager.listAllPresence();
      expect(result).toHaveLength(2);
      expect(result.map(p => p.id).sort()).toEqual(['machine-1', 'machine-2']);
    });

    test('maps status correctly', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      const result = await manager.listAllPresence();
      expect(result[0].status).toBe('online');
    });
  });

  // ============================================================
  // validatePresenceUniqueness
  // ============================================================

  describe('validatePresenceUniqueness', () => {
    test('always returns valid (in-memory Map guarantees uniqueness)', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');

      const result = await manager.validatePresenceUniqueness();
      expect(result.isValid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    test('returns valid even with no machines', async () => {
      const result = await manager.validatePresenceUniqueness();
      expect(result.isValid).toBe(true);
    });
  });
});
