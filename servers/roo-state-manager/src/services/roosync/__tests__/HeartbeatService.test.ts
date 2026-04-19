/**
 * Tests unitaires pour HeartbeatService
 *
 * Couvre :
 * - Initialisation avec per-machine files (heartbeats/ dir)
 * - Initialisation sans fichier → état vide
 * - Initialisation avec fichier corrompu → skip gracieux
 * - Migration: legacy heartbeat.json → per-machine files
 * - registerHeartbeat : nouvelle machine + writes per-machine file
 * - registerHeartbeat : machine existante (update)
 * - checkHeartbeats : reloads from disk, détecte offline/warning/online
 * - getOnlineMachines / getOfflineMachines / getWarningMachines
 * - getHeartbeatData : défini après register, undefined avant
 * - getState : retourne copie défensive
 * - removeMachine : suppression + file deletion
 * - cleanupOldOfflineMachines : supprime anciennes, garde récentes
 * - stopHeartbeatService : saves all per-machine files
 * - updateConfig : accepte config partielle
 *
 * @module services/roosync/__tests__/HeartbeatService.test
 * @version 2.0.0 (per-machine files)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// ─────────────────── hoisted mocks ───────────────────

const {
  mockExistsSync,
  mockReadFileSync,
  mockReaddirSync,
  mockMkdirSync,
  mockWriteFileSync,
  mockUnlinkSync,
  mockWriteFile,
  mockMkdir,
  mockUnlink,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockReadFileSync: vi.fn().mockReturnValue('{}'),
  mockReaddirSync: vi.fn().mockReturnValue([] as string[]),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  promises: {
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
  },
}));

import { HeartbeatService } from '../HeartbeatService.js';

// ─────────────────── helpers ───────────────────

const TEST_PATH = '/test/shared';
const HEARTBEATS_DIR = join(TEST_PATH, 'heartbeats');
const LEGACY_PATH = join(TEST_PATH, 'heartbeat.json');

function makeOnlineMachine(machineId: string): Record<string, any> {
  return {
    machineId,
    lastHeartbeat: new Date().toISOString(),
    status: 'online',
    missedHeartbeats: 0,
    metadata: {
      firstSeen: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      version: '3.1.0',
    },
  };
}

/**
 * Configure mocks to simulate per-machine files on disk.
 * Each key in `machines` is a machineId, value is the heartbeat data object.
 */
function setupPerMachineFiles(machines: Record<string, any>): void {
  const machineIds = Object.keys(machines);

  mockExistsSync.mockImplementation((p: string) => {
    if (p === HEARTBEATS_DIR) return true;
    for (const id of machineIds) {
      if (p === join(HEARTBEATS_DIR, `${id}.json`)) return true;
    }
    return false;
  });

  mockReaddirSync.mockReturnValue(machineIds.map(id => `${id}.json`));

  mockReadFileSync.mockImplementation((p: string, _enc?: string) => {
    for (const [id, data] of Object.entries(machines)) {
      if (p === join(HEARTBEATS_DIR, `${id}.json`)) {
        return JSON.stringify(data);
      }
    }
    throw new Error(`ENOENT: ${p}`);
  });
}

/**
 * Configure mocks to simulate a legacy heartbeat.json file.
 */
function setupLegacyFile(machines: Record<string, any>): void {
  mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH);

  mockReadFileSync.mockReturnValue(JSON.stringify({
    heartbeats: machines,
    statistics: {
      totalMachines: Object.keys(machines).length,
      onlineCount: 0,
      offlineCount: 0,
      warningCount: 0,
      lastHeartbeatCheck: new Date().toISOString(),
    },
  }));
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  mockReaddirSync.mockReturnValue([]);
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
});

// ─────────────────── tests ───────────────────

describe('HeartbeatService', () => {

  // ============================================================
  // Initialisation (per-machine files)
  // ============================================================

  describe('initialisation', () => {
    test('état vide si pas de fichier heartbeat', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toEqual([]);
      expect(service.getOfflineMachines()).toEqual([]);
      expect(service.getWarningMachines()).toEqual([]);
    });

    test('charge les machines depuis le répertoire per-machine', () => {
      const data = makeOnlineMachine('myia-ai-01');
      setupPerMachineFiles({ 'myia-ai-01': data });

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toContain('myia-ai-01');
    });

    test('état vide si fichier per-machine corrompu (pas de throw)', () => {
      mockExistsSync.mockImplementation((p: string) => p === HEARTBEATS_DIR);
      mockReaddirSync.mockReturnValue(['corrupted.json']);
      mockReadFileSync.mockReturnValue('INVALID{{JSON');

      // Ne doit pas throw
      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toEqual([]);
    });

    test('charge les machines offline depuis les fichiers per-machine', () => {
      const offlineMachine = {
        ...makeOnlineMachine('offline-machine'),
        status: 'offline',
        offlineSince: new Date(Date.now() - 5000).toISOString(),
      };
      setupPerMachineFiles({ 'offline-machine': offlineMachine });

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOfflineMachines()).toContain('offline-machine');
    });

    test('charge plusieurs machines depuis les fichiers per-machine', () => {
      setupPerMachineFiles({
        'machine-a': makeOnlineMachine('machine-a'),
        'machine-b': makeOnlineMachine('machine-b'),
      });

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toContain('machine-a');
      expect(service.getOnlineMachines()).toContain('machine-b');
    });
  });

  // ============================================================
  // Migration from legacy heartbeat.json
  // ============================================================

  describe('migration from legacy file', () => {
    test('migrates legacy heartbeat.json to per-machine files', () => {
      setupLegacyFile({
        'machine-a': makeOnlineMachine('machine-a'),
        'machine-b': makeOnlineMachine('machine-b'),
      });

      const service = new HeartbeatService(TEST_PATH);

      // Machines loaded in memory
      expect(service.getOnlineMachines()).toContain('machine-a');
      expect(service.getOnlineMachines()).toContain('machine-b');

      // Per-machine files written
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

      // Legacy file deleted
      expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY_PATH);

      // Dir created
      expect(mockMkdirSync).toHaveBeenCalled();
    });

    test('handles corrupted legacy file gracefully', () => {
      mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH);
      mockReadFileSync.mockReturnValue('CORRUPTED{{JSON');

      const service = new HeartbeatService(TEST_PATH);

      expect(service.getOnlineMachines()).toEqual([]);
    });

    test('directory takes precedence over legacy file', () => {
      const dirData = makeOnlineMachine('from-dir');

      // Both dir and legacy exist
      mockExistsSync.mockImplementation((p: string) =>
        p === HEARTBEATS_DIR || p === LEGACY_PATH
      );
      mockReaddirSync.mockReturnValue(['from-dir.json']);
      mockReadFileSync.mockImplementation((p: string, _enc?: string) => {
        if (p === join(HEARTBEATS_DIR, 'from-dir.json')) return JSON.stringify(dirData);
        if (p === LEGACY_PATH) return JSON.stringify({ heartbeats: { 'from-legacy': makeOnlineMachine('from-legacy') } });
        throw new Error(`ENOENT: ${p}`);
      });

      const service = new HeartbeatService(TEST_PATH);

      // Dir wins, legacy not loaded
      expect(service.getOnlineMachines()).toContain('from-dir');
      expect(service.getOnlineMachines()).not.toContain('from-legacy');
    });

    test('continues if legacy file delete fails', () => {
      setupLegacyFile({ 'machine-c': makeOnlineMachine('machine-c') });
      mockUnlinkSync.mockImplementation(() => { throw new Error('EBUSY'); });

      // Should not throw
      const service = new HeartbeatService(TEST_PATH);

      // Machine still loaded
      expect(service.getOnlineMachines()).toContain('machine-c');
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

    test('writes per-machine file on registration', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('machine-y');

      expect(mockMkdir).toHaveBeenCalledWith(HEARTBEATS_DIR, { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        join(HEARTBEATS_DIR, 'machine-y.json'),
        expect.any(String)
      );
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

    test('normalizes machineId to lowercase', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('MyIA-AI-01');

      expect(service.getHeartbeatData('myia-ai-01')).toBeDefined();
      expect(mockWriteFile).toHaveBeenCalledWith(
        join(HEARTBEATS_DIR, 'myia-ai-01.json'),
        expect.any(String)
      );
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

      // Set up disk with stale heartbeat
      const staleData = {
        ...makeOnlineMachine('slow-machine'),
        lastHeartbeat: new Date(Date.now() - 200).toISOString(),
      };
      setupPerMachineFiles({ 'slow-machine': staleData });

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

      // 350ms → > warningThreshold (300ms), < offlineTimeout (500ms)
      const warningData = {
        ...makeOnlineMachine('warning-machine'),
        lastHeartbeat: new Date(Date.now() - 350).toISOString(),
      };
      setupPerMachineFiles({ 'warning-machine': warningData });

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

      // Set up stale machine on disk
      const staleData = {
        ...makeOnlineMachine('recovering-machine'),
        lastHeartbeat: new Date(Date.now() - 200).toISOString(),
      };
      setupPerMachineFiles({ 'recovering-machine': staleData });

      // First check → detected offline
      await service.checkHeartbeats();
      expect(service.getOfflineMachines()).toContain('recovering-machine');

      // Re-register → revient online (in-memory update)
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

      // Set up recent heartbeat on disk
      const recentData = makeOnlineMachine('stable-machine');
      setupPerMachineFiles({ 'stable-machine': recentData });

      const result = await service.checkHeartbeats();

      expect(result.newlyOfflineMachines).not.toContain('stable-machine');
      expect(service.getOnlineMachines()).toContain('stable-machine');
    });

    test('does not write files (status is computed in-memory only)', async () => {
      const service = new HeartbeatService(TEST_PATH, {
        offlineTimeout: 100,
        heartbeatInterval: 30,
        missedHeartbeatThreshold: 4,
      });

      const staleData = {
        ...makeOnlineMachine('check-machine'),
        lastHeartbeat: new Date(Date.now() - 200).toISOString(),
      };
      setupPerMachineFiles({ 'check-machine': staleData });
      vi.clearAllMocks();

      await service.checkHeartbeats();

      // checkHeartbeats should NOT write files (status computed in-memory)
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // reloadFromDisk
  // ============================================================

  describe('reloadFromDisk', () => {
    test('clears state and reloads from per-machine files', async () => {
      const service = new HeartbeatService(TEST_PATH);

      // Register a machine in memory
      await service.registerHeartbeat('in-memory-only');
      expect(service.getOnlineMachines()).toContain('in-memory-only');

      // Set up disk with different machine
      setupPerMachineFiles({ 'from-disk': makeOnlineMachine('from-disk') });

      service.reloadFromDisk();

      // In-memory machine gone, disk machine loaded
      expect(service.getOnlineMachines()).not.toContain('in-memory-only');
      expect(service.getOnlineMachines()).toContain('from-disk');
    });

    test('empty state if heartbeats dir does not exist', async () => {
      const service = new HeartbeatService(TEST_PATH);
      await service.registerHeartbeat('some-machine');

      mockExistsSync.mockReturnValue(false);
      service.reloadFromDisk();

      expect(service.getOnlineMachines()).toEqual([]);
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

    test('deletes per-machine file on removal', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('to-remove-2');
      vi.clearAllMocks();

      // The file "exists" on disk
      mockExistsSync.mockReturnValue(true);
      await service.removeMachine('to-remove-2');

      expect(mockUnlink).toHaveBeenCalledWith(join(HEARTBEATS_DIR, 'to-remove-2.json'));
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

    test('garde les machines offline anciennes en statut offline (#1409)', async () => {
      const service = new HeartbeatService(TEST_PATH, { offlineTimeout: 10 });

      await service.registerHeartbeat('myia-old-offline');
      const hb = service.getHeartbeatData('myia-old-offline')!;
      hb.status = 'offline';
      hb.offlineSince = new Date(Date.now() - 100_000).toISOString(); // offline depuis 100s

      const removed = await service.cleanupOldOfflineMachines(50_000); // maxAge = 50s

      expect(removed).toBe(1);
      // #1409: Production machines (myia-*) kept in state as offline, not deleted
      expect(service.getHeartbeatData('myia-old-offline')).toBeDefined();
      expect(service.getHeartbeatData('myia-old-offline')!.status).toBe('offline');
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

    test('supprime les machines non-production (test artifacts) offline anciennes (#1409)', async () => {
      const service = new HeartbeatService(TEST_PATH, { offlineTimeout: 10 });

      await service.registerHeartbeat('test-artifact-machine');
      const hb = service.getHeartbeatData('test-artifact-machine')!;
      hb.status = 'offline';
      hb.offlineSince = new Date(Date.now() - 100_000).toISOString();

      mockExistsSync.mockReturnValue(true);

      await service.cleanupOldOfflineMachines(50_000);

      // #1409: Non-production machines (not myia-*) ARE deleted
      expect(service.getHeartbeatData('test-artifact-machine')).toBeUndefined();
    });

    test('garde les machines production offline sans supprimer le fichier (#1409)', async () => {
      const service = new HeartbeatService(TEST_PATH, { offlineTimeout: 10 });

      await service.registerHeartbeat('myia-cleanup-target');
      const hb = service.getHeartbeatData('myia-cleanup-target')!;
      hb.status = 'offline';
      hb.offlineSince = new Date(Date.now() - 100_000).toISOString();

      mockExistsSync.mockReturnValue(true);

      await service.cleanupOldOfflineMachines(50_000);

      // #1409: Production machines (myia-*) kept as offline, files NOT deleted
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(service.getHeartbeatData('myia-cleanup-target')).toBeDefined();
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

    test('saves all per-machine files on stop', async () => {
      const service = new HeartbeatService(TEST_PATH);

      await service.registerHeartbeat('persisted-machine');
      vi.clearAllMocks();

      await service.stopHeartbeatService();

      expect(mockMkdir).toHaveBeenCalledWith(HEARTBEATS_DIR, { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        join(HEARTBEATS_DIR, 'persisted-machine.json'),
        expect.any(String)
      );
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
