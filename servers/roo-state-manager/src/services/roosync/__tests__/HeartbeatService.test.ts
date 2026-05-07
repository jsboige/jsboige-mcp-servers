/**
 * Tests unitaires pour HeartbeatService
 *
 * ADR 008 Phase 2 — in-memory passive model.
 * No disk I/O, no background intervals, no GDrive writes.
 *
 * Couvre :
 * - Initialisation → état vide (no disk load)
 * - registerHeartbeat : nouvelle machine + machine existante (update)
 * - checkHeartbeats : détection IDLE/UNKNOWN/ONLINE (computed from lastHeartbeat age)
 * - getOnlineMachines / getUnknownMachines / getIdleMachines (deprecated aliases: getOfflineMachines / getWarningMachines)
 * - getHeartbeatData : défini après register, undefined avant
 * - getState : retourne copie défensive avec nouvelles clés (idleMachines, unknownMachines)
 * - removeMachine : suppression in-memory
 * - cleanupOldUnknownMachines : no-op (returns 0)
 * - stopHeartbeatService : no-op
 * - updateConfig : no-op
 * - reloadFromDisk : no-op
 *
 * @module services/roosync/__tests__/HeartbeatService.test
 * @version 4.0.0 (ADR 008 Phase 2 — in-memory only)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { HeartbeatService } from '../HeartbeatService.js';

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
});

// ─────────────────── tests ───────────────────

describe('HeartbeatService', () => {

  // ============================================================
  // Initialisation (in-memory — always empty)
  // ============================================================

  describe('initialisation', () => {
    test('état vide par défaut (pas de chargement disque)', () => {
      const service = new HeartbeatService();

      expect(service.getOnlineMachines()).toEqual([]);
      expect(service.getOfflineMachines()).toEqual([]);
      expect(service.getWarningMachines()).toEqual([]);
      expect(service.getUnknownMachines()).toEqual([]);
      expect(service.getIdleMachines()).toEqual([]);
    });

    test('accepte un sharedPath sans l\'utiliser', () => {
      const service = new HeartbeatService('/some/path');

      expect(service.getOnlineMachines()).toEqual([]);
    });

    test('accepte une config complète', () => {
      const service = new HeartbeatService('/path', {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000,
        persistenceInterval: 100,
      });

      expect(service).toBeDefined();
      expect(service.getOnlineMachines()).toEqual([]);
    });
  });

  // ============================================================
  // registerHeartbeat
  // ============================================================

  describe('registerHeartbeat', () => {
    test('enregistre une nouvelle machine avec statut online', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('new-machine');

      const data = service.getHeartbeatData('new-machine');
      expect(data).toBeDefined();
      expect(data!.machineId).toBe('new-machine');
      expect(data!.status).toBe('online');
      expect(data!.metadata.firstSeen).toBeDefined();
      expect(data!.metadata.lastUpdated).toBeDefined();
    });

    test('la nouvelle machine apparaît dans getOnlineMachines', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('machine-x');

      expect(service.getOnlineMachines()).toContain('machine-x');
    });

    test('met à jour le lastHeartbeat d\'une machine existante', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('machine-a');
      const first = service.getHeartbeatData('machine-a')!.lastHeartbeat;

      // Forcer un timestamp différent
      await new Promise(r => setTimeout(r, 5));
      await service.registerHeartbeat('machine-a');

      const updated = service.getHeartbeatData('machine-a')!;
      expect(updated.machineId).toBe('machine-a');
      expect(updated.status).toBe('online');
      // lastHeartbeat should be >= first
      expect(new Date(updated.lastHeartbeat).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
    });

    test('enregistre plusieurs machines indépendamment', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('machine-1');
      await service.registerHeartbeat('machine-2');
      await service.registerHeartbeat('machine-3');

      const online = service.getOnlineMachines();
      expect(online).toContain('machine-1');
      expect(online).toContain('machine-2');
      expect(online).toContain('machine-3');
    });

    test('normalizes machineId to lowercase', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('MyIA-AI-01');

      expect(service.getHeartbeatData('myia-ai-01')).toBeDefined();
    });

    test('accepte des métadonnées optionnelles (ignorées)', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('meta-machine', { customField: 'value' });

      expect(service.getHeartbeatData('meta-machine')).toBeDefined();
      expect(service.getHeartbeatData('meta-machine')!.status).toBe('online');
    });
  });

  // ============================================================
  // checkHeartbeats
  // ============================================================

  describe('checkHeartbeats', () => {
    test('retourne success=true et checkedAt', async () => {
      const service = new HeartbeatService();

      const result = await service.checkHeartbeats();

      expect(result.success).toBe(true);
      expect(result.checkedAt).toBeDefined();
      expect(typeof result.checkedAt).toBe('string');
    });

    test('retourne des tableaux vides si aucune machine', async () => {
      const service = new HeartbeatService();

      const result = await service.checkHeartbeats();

      expect(result.newlyUnknownMachines).toEqual([]);
      expect(result.newlyOnlineMachines).toEqual([]);
      expect(result.newlyIdleMachines).toEqual([]);
    });

    test('détecte une machine UNKNOWN (lastHeartbeat >120 min) #1953 ADR 008', async () => {
      const service = new HeartbeatService();

      // Register machine then make its heartbeat stale (>120 min = UNKNOWN)
      await service.registerHeartbeat('slow-machine');
      const hb = service.getHeartbeatData('slow-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString(); // 150 min ago

      const result = await service.checkHeartbeats();

      expect(result.newlyUnknownMachines).toContain('slow-machine');
      expect(service.getOfflineMachines()).toContain('slow-machine'); // deprecated alias
      expect(service.getUnknownMachines()).toContain('slow-machine');
      expect(service.getHeartbeatData('slow-machine')!.status).toBe('unknown');
    });

    test('détecte une machine IDLE (30-120 min) #1953 ADR 008', async () => {
      const service = new HeartbeatService();

      // Register machine then make heartbeat 45 min old → IDLE
      await service.registerHeartbeat('idle-machine');
      const hb = service.getHeartbeatData('idle-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min ago

      const result = await service.checkHeartbeats();

      expect(result.newlyIdleMachines).toContain('idle-machine');
      expect(service.getWarningMachines()).toContain('idle-machine'); // deprecated alias
      expect(service.getIdleMachines()).toContain('idle-machine');
      expect(service.getHeartbeatData('idle-machine')!.status).toBe('idle');
    });

    test('machine UNKNOWN revient online after re-registration #1953 ADR 008', async () => {
      const service = new HeartbeatService();

      // Register machine then make its heartbeat stale (>120 min)
      await service.registerHeartbeat('recovering-machine');
      const hb = service.getHeartbeatData('recovering-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString(); // 150 min ago

      // First check → detected UNKNOWN
      await service.checkHeartbeats();
      expect(service.getOfflineMachines()).toContain('recovering-machine');

      // Re-register → revient online (in-memory update)
      await service.registerHeartbeat('recovering-machine');
      expect(service.getOnlineMachines()).toContain('recovering-machine');
      expect(service.getOfflineMachines()).not.toContain('recovering-machine');
    });

    test('machine online stable reste online #1953 ADR 008', async () => {
      const service = new HeartbeatService();

      // Register with current timestamp → stays ONLINE
      await service.registerHeartbeat('stable-machine');

      const result = await service.checkHeartbeats();

      expect(result.newlyUnknownMachines).not.toContain('stable-machine');
      expect(service.getOnlineMachines()).toContain('stable-machine');
    });

    test('no status change if checkHeartbeats called on fresh machine', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('fresh-machine');
      const result = await service.checkHeartbeats();

      expect(result.newlyUnknownMachines).toEqual([]);
      expect(result.newlyIdleMachines).toEqual([]);
      expect(result.newlyOnlineMachines).toEqual([]);
      expect(service.getHeartbeatData('fresh-machine')!.status).toBe('online');
    });
  });

  // ============================================================
  // reloadFromDisk (no-op in ADR 008)
  // ============================================================

  describe('reloadFromDisk', () => {
    test('no-op: in-memory state is preserved', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('in-memory-machine');
      expect(service.getOnlineMachines()).toContain('in-memory-machine');

      service.reloadFromDisk();

      // State unchanged — reloadFromDisk is a no-op
      expect(service.getOnlineMachines()).toContain('in-memory-machine');
    });
  });

  // ============================================================
  // getHeartbeatData
  // ============================================================

  describe('getHeartbeatData', () => {
    test('retourne undefined si machine inconnue', () => {
      const service = new HeartbeatService();

      expect(service.getHeartbeatData('unknown-machine')).toBeUndefined();
    });

    test('retourne les données après registerHeartbeat', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('known-machine');

      const data = service.getHeartbeatData('known-machine');
      expect(data).toBeDefined();
      expect(data!.machineId).toBe('known-machine');
    });
  });

  // ============================================================
  // getState
  // ============================================================

  describe('getState', () => {
    test('retourne un état complet avec statistiques (ADR 008 naming)', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('stat-machine');

      const state = service.getState();
      expect(state.heartbeats).toBeDefined();
      expect(state.onlineMachines).toBeDefined();
      expect(state.idleMachines).toBeDefined();
      expect(state.unknownMachines).toBeDefined();
      expect(state.statistics).toBeDefined();
    });

    test('les listes de machines sont des copies (pas des références)', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('copy-machine');

      const state1 = service.getState();
      const state2 = service.getState();

      // Ce sont des copies différentes
      expect(state1.onlineMachines).not.toBe(state2.onlineMachines);
    });

    test('state.statistics.totalMachines correspond au nombre de machines', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('m1');
      await service.registerHeartbeat('m2');

      const state = service.getState();
      expect(state.statistics.totalMachines).toBe(2);
    });

    test('state.statistics contient onlineCount, idleCount, unknownCount', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('stat-m1');

      const state = service.getState();
      expect(state.statistics.onlineCount).toBe(1);
      expect(state.statistics.idleCount).toBe(0);
      expect(state.statistics.unknownCount).toBe(0);
    });
  });

  // ============================================================
  // removeMachine
  // ============================================================

  describe('removeMachine', () => {
    test('supprime la machine des listes', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('to-remove');
      expect(service.getOnlineMachines()).toContain('to-remove');

      await service.removeMachine('to-remove');

      expect(service.getOnlineMachines()).not.toContain('to-remove');
      expect(service.getHeartbeatData('to-remove')).toBeUndefined();
    });

    test('supprimer une machine inexistante ne throw pas', async () => {
      const service = new HeartbeatService();

      await expect(service.removeMachine('nonexistent')).resolves.not.toThrow();
    });

    test('mise à jour des statistiques après suppression', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('m1');
      await service.registerHeartbeat('m2');
      expect(service.getState().statistics.totalMachines).toBe(2);

      await service.removeMachine('m1');
      expect(service.getState().statistics.totalMachines).toBe(1);
    });
  });

  // ============================================================
  // cleanupOldUnknownMachines (no-op in ADR 008)
  // ============================================================

  describe('cleanupOldUnknownMachines', () => {
    test('retourne toujours 0 (no-op ADR 008)', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('active-machine');

      const removed = await service.cleanupOldUnknownMachines();

      expect(removed).toBe(0);
    });

    test('ne supprime aucune machine (no-op ADR 008)', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('test-artifact-machine');

      const removed = await service.cleanupOldUnknownMachines(0);

      expect(removed).toBe(0);
      expect(service.getHeartbeatData('test-artifact-machine')).toBeDefined();
    });

    test('deprecated cleanupOldOfflineMachines still works (backward compat)', async () => {
      const service = new HeartbeatService();

      const removed = await service.cleanupOldOfflineMachines();

      expect(removed).toBe(0);
    });
  });

  // ============================================================
  // stopHeartbeatService (no-op in ADR 008)
  // ============================================================

  describe('stopHeartbeatService', () => {
    test('s\'arrête sans erreur si jamais démarré', async () => {
      const service = new HeartbeatService();

      await expect(service.stopHeartbeatService()).resolves.not.toThrow();
    });

    test('no-op: ne modifie pas l\'état', async () => {
      const service = new HeartbeatService();

      await service.registerHeartbeat('persisted-machine');
      await service.stopHeartbeatService();

      // Machine still in memory (no disk write, no state change)
      expect(service.getHeartbeatData('persisted-machine')).toBeDefined();
      expect(service.getHeartbeatData('persisted-machine')!.status).toBe('online');
    });
  });

  // ============================================================
  // Configuration (no-op in ADR 008)
  // ============================================================

  describe('configuration', () => {
    test('utilise la config par défaut', () => {
      const service = new HeartbeatService();

      expect(service).toBeDefined();
    });

    test('accepte une config partielle', () => {
      const service = new HeartbeatService('/path', {
        heartbeatInterval: 5_000,
        offlineTimeout: 30_000,
      });

      expect(service).toBeDefined();
    });

    test('updateConfig est un no-op (ne throw pas)', async () => {
      const service = new HeartbeatService();

      await expect(service.updateConfig({ heartbeatInterval: 10_000 })).resolves.not.toThrow();
    });
  });

  // ============================================================
  // onStatusChange callback
  // ============================================================

  describe('onStatusChange callback', () => {
    test('appelé quand une machine passe de online à unknown', async () => {
      const service = new HeartbeatService();
      const callback = vi.fn();

      service.onStatusChange(callback);

      await service.registerHeartbeat('cb-machine');
      // Make it stale
      const hb = service.getHeartbeatData('cb-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();

      await service.checkHeartbeats();

      expect(callback).toHaveBeenCalledWith('cb-machine', 'online', 'unknown');
    });

    test('appelé quand une machine passe de unknown à online', async () => {
      const service = new HeartbeatService();
      const callback = vi.fn();

      service.onStatusChange(callback);

      await service.registerHeartbeat('cb-machine-2');
      // Make it stale → unknown
      const hb = service.getHeartbeatData('cb-machine-2')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();
      await service.checkHeartbeats();

      expect(callback).toHaveBeenCalledWith('cb-machine-2', 'online', 'unknown');

      // Re-register → online
      callback.mockClear();
      await service.registerHeartbeat('cb-machine-2');

      expect(callback).toHaveBeenCalledWith('cb-machine-2', 'unknown', 'online');
    });
  });

  // ============================================================
  // startHeartbeatService (no-op, sets callbacks)
  // ============================================================

  describe('startHeartbeatService', () => {
    test('no-op: ne throw pas', async () => {
      const service = new HeartbeatService();

      await expect(service.startHeartbeatService('local-machine')).resolves.not.toThrow();
    });

    test('enregistre les callbacks offline/online', async () => {
      const service = new HeartbeatService();
      const offlineCb = vi.fn();
      const onlineCb = vi.fn();

      await service.startHeartbeatService('local-machine', offlineCb, onlineCb);

      // Register a machine, make it stale → unknown
      await service.registerHeartbeat('remote-machine');
      const hb = service.getHeartbeatData('remote-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 150 * 60 * 1000).toISOString();

      await service.checkHeartbeats();

      expect(offlineCb).toHaveBeenCalledWith('remote-machine');
    });
  });
});
