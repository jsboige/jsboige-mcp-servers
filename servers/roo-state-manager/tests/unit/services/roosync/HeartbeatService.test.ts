/**
 * Tests unitaires pour le service de Heartbeat
 *
 * ADR 008 Phase 2 — in-memory passive model.
 * No disk I/O, no background intervals, no GDrive writes.
 *
 * Couvre:
 * - Enregistrement de heartbeats (in-memory)
 * - Detection des machines IDLE/UNKNOWN (computed from lastHeartbeat age)
 * - Etat du service (getState, getOnlineMachines, etc.)
 * - Gestion des machines (removeMachine)
 * - Configuration (updateConfig — no-op)
 * - Callbacks de notification (onStatusChange)
 * - startHeartbeatService / stopHeartbeatService (no-ops)
 * - cleanupOldOfflineMachines (no-op — returns 0)
 *
 * @version 4.0.0 (ADR 008 Phase 2)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeartbeatService, HeartbeatConfig } from '../../../../src/services/roosync/HeartbeatService.js';

describe('HeartbeatService - Tests Unitaires', () => {
  let heartbeatService: HeartbeatService;

  beforeEach(() => {
    const config: HeartbeatConfig = {
      heartbeatInterval: 30000,
      offlineTimeout: 120000,
      missedHeartbeatThreshold: 4,
      autoSyncEnabled: false,
      autoSyncInterval: 60000
    };

    heartbeatService = new HeartbeatService(undefined, config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Enregistrement de heartbeats', () => {
    it('devrait enregistrer un heartbeat pour une nouvelle machine', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      const heartbeatData = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatData).toBeDefined();
      expect(heartbeatData?.machineId).toBe('machine-1');
      expect(heartbeatData?.status).toBe('online');
      expect(heartbeatData?.metadata.firstSeen).toBeDefined();
      expect(heartbeatData?.metadata.lastUpdated).toBeDefined();
    });

    it('devrait mettre a jour un heartbeat existant', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      const firstHeartbeat = heartbeatService.getHeartbeatData('machine-1');
      const firstTimestamp = firstHeartbeat?.lastHeartbeat;

      // Attendre un peu pour que le timestamp change
      await new Promise(resolve => setTimeout(resolve, 50));

      await heartbeatService.registerHeartbeat('machine-1');

      const updatedHeartbeat = heartbeatService.getHeartbeatData('machine-1');
      expect(updatedHeartbeat?.lastHeartbeat).not.toBe(firstTimestamp);
      expect(updatedHeartbeat?.status).toBe('online');
    });

    it('devrait gerer plusieurs machines simultanement', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      await heartbeatService.registerHeartbeat('machine-3');

      expect(heartbeatService.getHeartbeatData('machine-1')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('machine-2')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('machine-3')).toBeDefined();

      const state = heartbeatService.getState();
      expect(state.statistics.totalMachines).toBe(3);
      expect(state.onlineMachines).toHaveLength(3);
    });
  });

  describe('Detection des machines offline/idle/unknown', () => {
    it('devrait detecter une machine UNKNOWN (>120 min sans heartbeat)', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      // Simuler le passage du temps: lastHeartbeat > 120 min → UNKNOWN
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString(); // 150 min

      const result = await heartbeatService.checkHeartbeats();

      expect(result.success).toBe(true);
      expect(result.newlyUnknownMachines).toContain('machine-1');

      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('unknown');
    });

    it('devrait detecter une machine IDLE (30-120 min sans heartbeat)', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      // IDLE threshold: 30-120 min
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min

      const result = await heartbeatService.checkHeartbeats();

      expect(result.success).toBe(true);
      expect(result.newlyIdleMachines).toContain('machine-1');

      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('idle');
    });

    it('devrait detecter le retour online d\'une machine', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      // Make stale → UNKNOWN
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();
      await heartbeatService.checkHeartbeats();
      expect(heartbeatService.getHeartbeatData('machine-1')?.status).toBe('unknown');

      // Re-register → online
      await heartbeatService.registerHeartbeat('machine-1');

      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('online');
    });
  });

  describe('Etat du service', () => {
    it('devrait retourner l\'etat complet du service', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');

      const state = heartbeatService.getState();

      expect(state).toBeDefined();
      expect(state.statistics.totalMachines).toBe(2);
      expect(state.onlineMachines).toHaveLength(2);
      expect(state.unknownMachines).toHaveLength(0);
      expect(state.idleMachines).toHaveLength(0);
      expect(state.statistics.onlineCount).toBe(2);
      expect(state.statistics.unknownCount).toBe(0);
      expect(state.statistics.idleCount).toBe(0);
    });

    it('devrait retourner les machines online', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');

      const onlineMachines = heartbeatService.getOnlineMachines();

      expect(onlineMachines).toHaveLength(2);
      expect(onlineMachines).toContain('machine-1');
      expect(onlineMachines).toContain('machine-2');
    });

    it('devrait retourner les machines UNKNOWN via getUnknownMachines', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      // Make stale → UNKNOWN
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();
      await heartbeatService.checkHeartbeats();

      expect(heartbeatService.getUnknownMachines()).toContain('machine-1');
    });

    it('devrait retourner les machines IDLE via getIdleMachines', async () => {
      await heartbeatService.registerHeartbeat('machine-1');

      // Make idle → IDLE
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      await heartbeatService.checkHeartbeats();

      expect(heartbeatService.getIdleMachines()).toContain('machine-1');
    });
  });

  describe('Gestion des machines', () => {
    it('devrait supprimer une machine du service', async () => {
      await heartbeatService.registerHeartbeat('machine-1');
      expect(heartbeatService.getHeartbeatData('machine-1')).toBeDefined();

      await heartbeatService.removeMachine('machine-1');

      expect(heartbeatService.getHeartbeatData('machine-1')).toBeUndefined();

      const state = heartbeatService.getState();
      expect(state.statistics.totalMachines).toBe(0);
    });

    it('cleanupOldUnknownMachines est un no-op (retourne 0)', async () => {
      await heartbeatService.registerHeartbeat('myia-old-1');
      await heartbeatService.registerHeartbeat('myia-old-2');
      await heartbeatService.registerHeartbeat('myia-recent');

      const removedCount = await heartbeatService.cleanupOldUnknownMachines(86400000);

      // ADR 008: cleanupOldUnknownMachines is a no-op, always returns 0
      expect(removedCount).toBe(0);
      // All machines remain
      expect(heartbeatService.getHeartbeatData('myia-old-1')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('myia-old-2')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('myia-recent')).toBeDefined();
    });

    it('cleanupOldUnknownMachines returns 0 (no-op ADR 008)', async () => {
      const removedCount = await heartbeatService.cleanupOldUnknownMachines(86400000);
      expect(removedCount).toBe(0);
    });
  });

  describe('Configuration', () => {
    it('updateConfig est un no-op (ne throw pas)', async () => {
      await heartbeatService.updateConfig({});

      // No-op — just verify no throw
      expect(true).toBe(true);
    });
  });

  describe('Callbacks de notification', () => {
    it('devrait appeler le callback lors de la detection UNKNOWN', async () => {
      const offlineCallback = vi.fn();
      const onlineCallback = vi.fn();

      await heartbeatService.registerHeartbeat('machine-1');

      // Set up callbacks via startHeartbeatService
      await heartbeatService.startHeartbeatService('machine-2', offlineCallback, onlineCallback);

      // Make machine-1 stale → UNKNOWN
      const hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();

      const result = await heartbeatService.checkHeartbeats();

      expect(result.newlyUnknownMachines).toContain('machine-1');
      expect(offlineCallback).toHaveBeenCalledWith('machine-1');
    });

    it('devrait appeler le callback lors du retour online', async () => {
      const offlineCallback = vi.fn();
      const onlineCallback = vi.fn();

      await heartbeatService.registerHeartbeat('machine-1');

      // Make it stale → UNKNOWN
      let hb = heartbeatService.getHeartbeatData('machine-1')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();
      await heartbeatService.checkHeartbeats();
      expect(heartbeatService.getHeartbeatData('machine-1')?.status).toBe('unknown');

      // Set up callbacks
      await heartbeatService.startHeartbeatService('machine-2', offlineCallback, onlineCallback);

      // Re-register → online triggers callback
      await heartbeatService.registerHeartbeat('machine-1');

      expect(onlineCallback).toHaveBeenCalledWith('machine-1');
    });
  });

  describe('In-memory model (ADR 008)', () => {
    it('les donnees ne persistent pas entre instances (pas de disque)', async () => {
      // Register machines in first instance
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      await heartbeatService.stopHeartbeatService();

      // New instance starts empty (no disk persistence)
      const newService = new HeartbeatService(undefined, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });

      const state = newService.getState();
      expect(state.statistics.totalMachines).toBe(0);
      expect(newService.getHeartbeatData('machine-1')).toBeUndefined();
      expect(newService.getHeartbeatData('machine-2')).toBeUndefined();
    });

    it('startHeartbeatService et stopHeartbeatService sont des no-ops', async () => {
      await heartbeatService.startHeartbeatService('test-machine');
      await heartbeatService.registerHeartbeat('test-machine');
      expect(heartbeatService.getHeartbeatData('test-machine')).toBeDefined();

      await heartbeatService.stopHeartbeatService();

      // Machine still in memory (stop is no-op)
      expect(heartbeatService.getHeartbeatData('test-machine')).toBeDefined();
    });
  });
});
