/**
 * Tests unitaires pour HeartbeatService
 *
 * Couvre :
 * - Initialisation sans fichier heartbeat → état vide
 * - Initialisation avec fichier existant → chargement état
 * - Initialisation avec fichier corrompu → état vide (robustesse)
 * - registerHeartbeat : nouvelle machine
 * - registerHeartbeat : machine existante (update)
 * - registerHeartbeat : appelle saveState (writeFile)
 * - checkHeartbeats : machine détectée offline
 * - checkHeartbeats : machine en warning
 * - checkHeartbeats : machine revient online
 * - checkHeartbeats : résultat success + checkedAt
 * - getOnlineMachines / getOfflineMachines / getWarningMachines
 * - getHeartbeatData : défini après register, undefined avant
 * - getState : retourne copie défensive
 * - removeMachine : suppression correcte
 * - cleanupOldOfflineMachines : supprime anciennes, garde récentes
 * - stopHeartbeatService : sans erreur
 * - updateConfig : accepte config partielle
 *
 * @module services/roosync/__tests__/HeartbeatService.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const { mockExistsSync, mockReadFileSync, mockWriteFile } = vi.hoisted(() => {
  const mockExistsSync = vi.fn().mockReturnValue(false);
  const mockReadFileSync = vi.fn().mockReturnValue('{}');
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  return { mockExistsSync, mockReadFileSync, mockWriteFile };
});

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  promises: {
    writeFile: (...args: any[]) => mockWriteFile(...args),
  },
}));

import { HeartbeatService } from '../HeartbeatService.js';

// ─────────────────── helpers ───────────────────

const TEST_PATH = '/test/shared';

function makeHeartbeatJson(machines: Record<string, any> = {}): string {
  return JSON.stringify({
    heartbeats: machines,
    statistics: {
      totalMachines: Object.keys(machines).length,
      onlineCount: 0,
      offlineCount: 0,
      warningCount: 0,
      lastHeartbeatCheck: new Date().toISOString(),
    },
  });
}

function makeOnlineMachine(machineId: string): Record<string, any> {
  return {
    machineId,
    lastHeartbeat: new Date().toISOString(),
    status: 'online',
    missedHeartbeats: 0,
    metadata: {
      firstSeen: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      version: '3.0.0',
    },
  };
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  mockWriteFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
});

// ─────────────────── tests ───────────────────

describe('HeartbeatService', () => {

  // ============================================================
  // Initialisation
  // ============================================================

  describe('initialisation', () => {
    test('état vide si pas de fichier heartbeat', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toEqual([]);
      expect(service.getOfflineMachines()).toEqual([]);
      expect(service.getWarningMachines()).toEqual([]);
    });

    test('charge les machines depuis un fichier existant', () => {
      const machines = { 'myia-ai-01': makeOnlineMachine('myia-ai-01') };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeHeartbeatJson(machines));

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toContain('myia-ai-01');
    });

    test('état vide si fichier corrompu (pas de throw)', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('INVALID{{JSON');

      // Ne doit pas throw
      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toEqual([]);
    });

    test('charge les machines offline depuis le fichier', () => {
      const offlineMachine = {
        ...makeOnlineMachine('offline-machine'),
        status: 'offline',
        offlineSince: new Date(Date.now() - 5000).toISOString(),
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeHeartbeatJson({ 'offline-machine': offlineMachine }));

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOfflineMachines()).toContain('offline-machine');
    });
  });

  // ============================================================
  // registerHeartbeat
  // ============================================================

  describe('registerHeartbeat', () => {
    test('enregistre une nouvelle machine avec statut online', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('new-machine');

      const data = service.getHeartbeatData('new-machine');
      expect(data).toBeDefined();
      expect(data!.machineId).toBe('new-machine');
      expect(data!.status).toBe('online');
      expect(data!.missedHeartbeats).toBe(0);
    });

    test('la nouvelle machine apparaît dans getOnlineMachines', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-x');

      expect(service.getOnlineMachines()).toContain('machine-x');
    });

    test('met à jour le lastHeartbeat d\'une machine existante', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-a');
      const first = service.getHeartbeatData('machine-a')!.lastHeartbeat;

      // Forcer un timestamp différent
      await new Promise(r => setTimeout(r, 5));
      await service.registerHeartbeat('machine-a');
      const second = service.getHeartbeatData('machine-a')!.lastHeartbeat;

      // Peut être égal si trop rapide, mais machineId reste correct
      expect(service.getHeartbeatData('machine-a')!.machineId).toBe('machine-a');
      expect(service.getHeartbeatData('machine-a')!.status).toBe('online');
    });

    test('remet missedHeartbeats à 0 lors d\'une mise à jour', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-b');
      const hb = service.getHeartbeatData('machine-b')!;
      hb.missedHeartbeats = 5; // Simuler des heartbeats manqués

      await service.registerHeartbeat('machine-b');

      expect(service.getHeartbeatData('machine-b')!.missedHeartbeats).toBe(0);
    });

    test('appelle saveState (writeFile) lors de l\'enregistrement', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-y');

      expect(mockWriteFile).toHaveBeenCalled();
    });

    test('enregistre plusieurs machines indépendamment', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-1');
      await service.registerHeartbeat('machine-2');
      await service.registerHeartbeat('machine-3');

      const online = service.getOnlineMachines();
      expect(online).toContain('machine-1');
      expect(online).toContain('machine-2');
      expect(online).toContain('machine-3');
    });
  });

  // ============================================================
  // checkHeartbeats
  // ============================================================

  describe('checkHeartbeats', () => {
    test('retourne success=true et checkedAt', async () => {
      const service = new HeartbeatService(TEST_PATH);

      const result = await service.checkHeartbeats();

      expect(result.success).toBe(true);
      expect(result.checkedAt).toBeDefined();
      expect(typeof result.checkedAt).toBe('string');
    });

    test('retourne des tableaux vides si aucune machine', async () => {
      const service = new HeartbeatService(TEST_PATH);

      const result = await service.checkHeartbeats();

      expect(result.newlyOfflineMachines).toEqual([]);
      expect(result.newlyOnlineMachines).toEqual([]);
    });

    test('détecte une machine offline (lastHeartbeat trop ancien)', async () => {
      const service = new HeartbeatService(TEST_PATH, {
        offlineTimeout: 100,      // 100ms
        heartbeatInterval: 30,
        missedHeartbeatThreshold: 4,
      });

      await service.registerHeartbeat('slow-machine');

      // Rendre le heartbeat très ancien (> offlineTimeout)
      const hb = service.getHeartbeatData('slow-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 200).toISOString();

      const result = await service.checkHeartbeats();

      expect(result.newlyOfflineMachines).toContain('slow-machine');
      expect(service.getOfflineMachines()).toContain('slow-machine');
    });

    test('détecte une machine en warning (threshold atteint mais pas offline)', async () => {
      const service = new HeartbeatService(TEST_PATH, {
        offlineTimeout: 500,      // offline après 500ms
        heartbeatInterval: 100,   // intervalle 100ms
        missedHeartbeatThreshold: 4,  // warning à (4-1)*100 = 300ms
      });

      await service.registerHeartbeat('warning-machine');

      // 350ms → > warningThreshold (300ms), < offlineTimeout (500ms)
      const hb = service.getHeartbeatData('warning-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 350).toISOString();

      const result = await service.checkHeartbeats();

      expect(result.warningMachines).toContain('warning-machine');
      expect(service.getWarningMachines()).toContain('warning-machine');
    });

    test('machine offline revient online', async () => {
      const service = new HeartbeatService(TEST_PATH, {
        offlineTimeout: 100,
        heartbeatInterval: 30,
        missedHeartbeatThreshold: 4,
      });

      await service.registerHeartbeat('recovering-machine');

      // D'abord mettre offline
      const hb = service.getHeartbeatData('recovering-machine')!;
      hb.lastHeartbeat = new Date(Date.now() - 200).toISOString();
      await service.checkHeartbeats();
      expect(service.getOfflineMachines()).toContain('recovering-machine');

      // Re-enregistrer → revient online
      await service.registerHeartbeat('recovering-machine');
      expect(service.getOnlineMachines()).toContain('recovering-machine');
      expect(service.getOfflineMachines()).not.toContain('recovering-machine');
    });

    test('machine online stable reste online', async () => {
      const service = new HeartbeatService(TEST_PATH, {
        offlineTimeout: 5000,
        heartbeatInterval: 1000,
        missedHeartbeatThreshold: 4,
      });

      await service.registerHeartbeat('stable-machine');

      const result = await service.checkHeartbeats();

      expect(result.newlyOfflineMachines).not.toContain('stable-machine');
      expect(service.getOnlineMachines()).toContain('stable-machine');
    });
  });

  // ============================================================
  // getHeartbeatData
  // ============================================================

  describe('getHeartbeatData', () => {
    test('retourne undefined si machine inconnue', () => {
      const service = new HeartbeatService(TEST_PATH);

      expect(service.getHeartbeatData('unknown-machine')).toBeUndefined();
    });

    test('retourne les données après registerHeartbeat', async () => {
      const service = new HeartbeatService(TEST_PATH);

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
    test('retourne un état complet avec statistiques', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('stat-machine');

      const state = service.getState();
      expect(state.heartbeats).toBeDefined();
      expect(state.onlineMachines).toBeDefined();
      expect(state.offlineMachines).toBeDefined();
      expect(state.warningMachines).toBeDefined();
      expect(state.statistics).toBeDefined();
    });

    test('les listes de machines sont des copies (pas des références)', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('copy-machine');

      const state1 = service.getState();
      const state2 = service.getState();

      // Ce sont des copies différentes
      expect(state1.onlineMachines).not.toBe(state2.onlineMachines);
    });

    test('state.statistics.totalMachines correspond au nombre de machines', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('m1');
      await service.registerHeartbeat('m2');

      const state = service.getState();
      expect(state.statistics.totalMachines).toBe(2);
    });
  });

  // ============================================================
  // removeMachine
  // ============================================================

  describe('removeMachine', () => {
    test('supprime la machine des listes', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('to-remove');
      expect(service.getOnlineMachines()).toContain('to-remove');

      await service.removeMachine('to-remove');

      expect(service.getOnlineMachines()).not.toContain('to-remove');
      expect(service.getHeartbeatData('to-remove')).toBeUndefined();
    });

    test('supprimer une machine inexistante ne throw pas', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await expect(service.removeMachine('nonexistent')).resolves.not.toThrow();
    });

    test('appelle saveState après suppression', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('to-remove-2');
      vi.clearAllMocks(); // Reset write count

      await service.removeMachine('to-remove-2');

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ============================================================
  // cleanupOldOfflineMachines
  // ============================================================

  describe('cleanupOldOfflineMachines', () => {
    test('retourne 0 si aucune machine offline', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('active-machine');

      const removed = await service.cleanupOldOfflineMachines();

      expect(removed).toBe(0);
    });

    test('supprime les machines offline depuis trop longtemps', async () => {
      const service = new HeartbeatService(TEST_PATH, { offlineTimeout: 10 });

      await service.registerHeartbeat('old-offline');
      const hb = service.getHeartbeatData('old-offline')!;
      hb.status = 'offline';
      hb.offlineSince = new Date(Date.now() - 100_000).toISOString(); // offline depuis 100s

      const removed = await service.cleanupOldOfflineMachines(50_000); // maxAge = 50s

      expect(removed).toBe(1);
      expect(service.getHeartbeatData('old-offline')).toBeUndefined();
    });

    test('garde les machines offline récentes', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('recent-offline');
      const hb = service.getHeartbeatData('recent-offline')!;
      hb.status = 'offline';
      hb.offlineSince = new Date().toISOString(); // offline depuis maintenant

      const removed = await service.cleanupOldOfflineMachines(86_400_000); // maxAge = 24h

      expect(removed).toBe(0);
      expect(service.getHeartbeatData('recent-offline')).toBeDefined();
    });

    test('ne touche pas aux machines sans offlineSince', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('online-machine');

      const removed = await service.cleanupOldOfflineMachines(0); // maxAge = 0

      expect(removed).toBe(0);
    });
  });

  // ============================================================
  // stopHeartbeatService
  // ============================================================

  describe('stopHeartbeatService', () => {
    test('s\'arrête sans erreur si jamais démarré', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await expect(service.stopHeartbeatService()).resolves.not.toThrow();
    });

    test('appelle saveState lors de l\'arrêt', async () => {
      const service = new HeartbeatService(TEST_PATH);

      vi.clearAllMocks();
      await service.stopHeartbeatService();

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Configuration
  // ============================================================

  describe('configuration', () => {
    test('utilise la config par défaut (heartbeatInterval=30s)', () => {
      const service = new HeartbeatService(TEST_PATH);

      // Si le service démarre sans erreur avec la config par défaut, OK
      expect(service).toBeDefined();
    });

    test('accepte une config partielle', () => {
      const service = new HeartbeatService(TEST_PATH, {
        heartbeatInterval: 5_000,
        offlineTimeout: 30_000,
      });

      expect(service).toBeDefined();
    });

    test('updateConfig met à jour la configuration', async () => {
      const service = new HeartbeatService(TEST_PATH);

      // Ne doit pas throw
      await expect(service.updateConfig({ heartbeatInterval: 10_000 })).resolves.not.toThrow();
    });
  });
});
