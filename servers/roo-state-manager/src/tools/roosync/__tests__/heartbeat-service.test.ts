/**
 * Tests unitaires pour roosyncHeartbeatService
 *
 * Couvre heartbeat-service.ts :
 * - action=register : nouvelle machine, machine existante, machineId manquant, retrieval failed
 * - action=start : succès, avec/sans config interval, machineId manquant
 * - action=stop : succès avec saveState=true/false
 * - Gestion erreurs : propagation HeartbeatServiceError, wrapping générique
 *
 * @module tools/roosync/__tests__/heartbeat-service.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

// ─────────────────── mocks ───────────────────

const mockGetHeartbeatData = vi.fn();
const mockRegisterHeartbeat = vi.fn();
const mockUpdateConfig = vi.fn();
const mockStartHeartbeatService = vi.fn();
const mockStopHeartbeatService = vi.fn();

const mockGetHeartbeatService = vi.fn(() => ({
  getHeartbeatData: mockGetHeartbeatData,
  registerHeartbeat: mockRegisterHeartbeat,
  updateConfig: mockUpdateConfig,
  startHeartbeatService: mockStartHeartbeatService,
  stopHeartbeatService: mockStopHeartbeatService
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: mockGetHeartbeatService
  }))
}));

vi.mock('../../../services/roosync/HeartbeatService.js', () => ({
  HeartbeatServiceError: class HeartbeatServiceError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'HeartbeatServiceError';
    }
  }
}));

// ─────────────────── import SUT après mocks ───────────────────

import { roosyncHeartbeatService } from '../heartbeat-service.js';

// ─────────────────── helpers ───────────────────

const makeHeartbeatData = (overrides: Record<string, any> = {}) => ({
  machineId: 'myia-ai-01',
  lastHeartbeat: '2026-02-22T10:00:00.000Z',
  status: 'online' as const,
  missedHeartbeats: 0,
  metadata: { firstSeen: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-02-22T10:00:00.000Z', version: '1.0' },
  ...overrides
});

// ─────────────────── tests ───────────────────

describe('roosyncHeartbeatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisterHeartbeat.mockResolvedValue(undefined);
    mockUpdateConfig.mockResolvedValue(undefined);
    mockStartHeartbeatService.mockResolvedValue(undefined);
    mockStopHeartbeatService.mockResolvedValue(undefined);
    // Par défaut: machine existante
    mockGetHeartbeatData.mockReturnValue(makeHeartbeatData());
  });

  // ============================================================
  // action = 'register'
  // ============================================================

  describe('action=register', () => {
    test('retourne success=true pour une nouvelle machine', async () => {
      // Première appel (existingData): null → nouvelle machine
      // Deuxième appel (updatedData): les données
      mockGetHeartbeatData
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeHeartbeatData());

      const result = await roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01' });

      expect(result.success).toBe(true);
      expect(result.result.action).toBe('register');
    });

    test('isNewMachine=true si la machine n\'existait pas', async () => {
      mockGetHeartbeatData
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeHeartbeatData());

      const result = await roosyncHeartbeatService({ action: 'register', machineId: 'myia-new' });

      expect((result.result as any).isNewMachine).toBe(true);
    });

    test('isNewMachine=false si la machine existait déjà', async () => {
      mockGetHeartbeatData
        .mockReturnValueOnce(makeHeartbeatData())   // existingData
        .mockReturnValueOnce(makeHeartbeatData());  // updatedData

      const result = await roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01' });

      expect((result.result as any).isNewMachine).toBe(false);
    });

    test('retourne le machineId dans le résultat', async () => {
      mockGetHeartbeatData
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeHeartbeatData({ machineId: 'myia-po-2025' }));

      const result = await roosyncHeartbeatService({ action: 'register', machineId: 'myia-po-2025' });

      expect((result.result as any).machineId).toBe('myia-po-2025');
    });

    test('retourne le timestamp du heartbeat enregistré', async () => {
      const ts = '2026-02-22T10:00:00.000Z';
      mockGetHeartbeatData
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeHeartbeatData({ lastHeartbeat: ts }));

      const result = await roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01' });

      expect((result.result as any).timestamp).toBe(ts);
    });

    test('passe les métadonnées optionnelles à registerHeartbeat', async () => {
      mockGetHeartbeatData
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeHeartbeatData());
      const meta = { version: '2.0', platform: 'win32' };

      await roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01', metadata: meta });

      expect(mockRegisterHeartbeat).toHaveBeenCalledWith('myia-ai-01', meta);
    });

    test('lève HeartbeatServiceError si machineId manquant', async () => {
      await expect(roosyncHeartbeatService({ action: 'register' }))
        .rejects.toBeInstanceOf(HeartbeatServiceError);
    });

    test('code HEARTBEAT_MISSING_MACHINE_ID si machineId manquant', async () => {
      try {
        await roosyncHeartbeatService({ action: 'register' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('HEARTBEAT_MISSING_MACHINE_ID');
      }
    });

    test('lève HeartbeatServiceError si updatedData est null après enregistrement', async () => {
      mockGetHeartbeatData.mockReturnValue(null); // Toujours null

      await expect(roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01' }))
        .rejects.toBeInstanceOf(HeartbeatServiceError);
    });
  });

  // ============================================================
  // action = 'start'
  // ============================================================

  describe('action=start', () => {
    test('retourne success=true', async () => {
      const result = await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' });

      expect(result.success).toBe(true);
      expect(result.result.action).toBe('start');
    });

    test('retourne le machineId dans le résultat', async () => {
      const result = await roosyncHeartbeatService({ action: 'start', machineId: 'myia-po-2025' });

      expect((result.result as any).machineId).toBe('myia-po-2025');
    });

    test('config par défaut : heartbeatInterval=30000, offlineTimeout=120000', async () => {
      const result = await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' });

      const config = (result.result as any).config;
      expect(config.heartbeatInterval).toBe(30000);
      expect(config.offlineTimeout).toBe(120000);
      expect(config.autoSyncEnabled).toBe(true);
    });

    test('NE PAS appeler updateConfig si aucun interval/timeout fourni', async () => {
      await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' });

      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    test('appelle updateConfig si heartbeatInterval fourni', async () => {
      await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01', heartbeatInterval: 5000 });

      expect(mockUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({
        heartbeatInterval: 5000
      }));
    });

    test('appelle updateConfig si offlineTimeout fourni', async () => {
      await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01', offlineTimeout: 60000 });

      expect(mockUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({
        offlineTimeout: 60000
      }));
    });

    test('appelle startHeartbeatService avec machineId', async () => {
      await roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' });

      expect(mockStartHeartbeatService).toHaveBeenCalledWith(
        'myia-ai-01',
        expect.any(Function),
        expect.any(Function)
      );
    });

    test('enableAutoSync=false est respecté dans la config', async () => {
      const result = await roosyncHeartbeatService({
        action: 'start',
        machineId: 'myia-ai-01',
        enableAutoSync: false,
        heartbeatInterval: 5000
      });

      const config = (result.result as any).config;
      expect(config.autoSyncEnabled).toBe(false);
    });

    test('lève HeartbeatServiceError si machineId manquant', async () => {
      await expect(roosyncHeartbeatService({ action: 'start' }))
        .rejects.toBeInstanceOf(HeartbeatServiceError);
    });

    test('code HEARTBEAT_MISSING_MACHINE_ID si machineId manquant pour start', async () => {
      try {
        await roosyncHeartbeatService({ action: 'start' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('HEARTBEAT_MISSING_MACHINE_ID');
      }
    });
  });

  // ============================================================
  // action = 'stop'
  // ============================================================

  describe('action=stop', () => {
    test('retourne success=true', async () => {
      const result = await roosyncHeartbeatService({ action: 'stop' });

      expect(result.success).toBe(true);
      expect(result.result.action).toBe('stop');
    });

    test('stateSaved=true par défaut', async () => {
      const result = await roosyncHeartbeatService({ action: 'stop' });

      expect((result.result as any).stateSaved).toBe(true);
    });

    test('stateSaved=false si saveState=false', async () => {
      const result = await roosyncHeartbeatService({ action: 'stop', saveState: false });

      expect((result.result as any).stateSaved).toBe(false);
    });

    test('retourne un stoppedAt en ISO 8601', async () => {
      const result = await roosyncHeartbeatService({ action: 'stop' });

      expect((result.result as any).stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('appelle stopHeartbeatService', async () => {
      await roosyncHeartbeatService({ action: 'stop' });

      expect(mockStopHeartbeatService).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // gestion d'erreurs
  // ============================================================

  describe('gestion d\'erreurs', () => {
    test('propage HeartbeatServiceError sans wrapping (register)', async () => {
      const original = new HeartbeatServiceError('Service down', 'SERVICE_DOWN');
      mockRegisterHeartbeat.mockRejectedValue(original);
      mockGetHeartbeatData.mockReturnValueOnce(null);

      let caught: any;
      try {
        await roosyncHeartbeatService({ action: 'register', machineId: 'myia-ai-01' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(original);
    });

    test('wrap les erreurs génériques (start)', async () => {
      mockStartHeartbeatService.mockRejectedValue(new Error('unexpected'));

      await expect(roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' }))
        .rejects.toBeInstanceOf(HeartbeatServiceError);
    });

    test('wrap les erreurs génériques (stop)', async () => {
      mockStopHeartbeatService.mockRejectedValue(new Error('stop failed'));

      await expect(roosyncHeartbeatService({ action: 'stop' }))
        .rejects.toBeInstanceOf(HeartbeatServiceError);
    });

    test('message wrapping contient l\'action', async () => {
      mockStartHeartbeatService.mockRejectedValue(new Error('timeout'));

      await expect(roosyncHeartbeatService({ action: 'start', machineId: 'myia-ai-01' }))
        .rejects.toThrow('start');
    });
  });
});
