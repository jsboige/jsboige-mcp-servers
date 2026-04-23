/**
 * Tests unitaires pour roosync_heartbeat
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roosyncHeartbeat, HeartbeatArgsSchema, HeartbeatResultSchema } from '../../../../src/tools/roosync/heartbeat.js';
import { roosyncHeartbeatStatus } from '../../../../src/tools/roosync/heartbeat-status.js';
import { roosyncHeartbeatService } from '../../../../src/tools/roosync/heartbeat-service.js';
import { HeartbeatServiceError } from '../../../../src/services/roosync/HeartbeatService.js';

// Mock des fonctions dépendantes
vi.mock('../../../../src/tools/roosync/heartbeat-status.js');
vi.mock('../../../../src/tools/roosync/heartbeat-service.js');
vi.mock('../../../../src/services/roosync/HeartbeatService.js');

describe('HeartbeatArgsSchema', () => {
  describe('Validation des actions valides', () => {
    it('devrait valider action="status"', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'status',
        filter: 'online',
        includeHeartbeats: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('status');
        expect(result.data.filter).toBe('online');
        expect(result.data.includeHeartbeats).toBe(true);
      }
    });

    it('devrait valider action="register"', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'register',
        machineId: 'test-machine-001',
        metadata: { role: 'worker', version: '1.0.0' }
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('register');
        expect(result.data.machineId).toBe('test-machine-001');
        expect(result.data.metadata).toEqual({ role: 'worker', version: '1.0.0' });
      }
    });

    it('devrait valider action="start"', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'start',
        machineId: 'test-machine-002',
        enableAutoSync: true,
        heartbeatInterval: 30000,
        offlineTimeout: 60000
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('start');
        expect(result.data.enableAutoSync).toBe(true);
        expect(result.data.heartbeatInterval).toBe(30000);
        expect(result.data.offlineTimeout).toBe(60000);
      }
    });

    it('devrait valider action="stop"', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'stop',
        machineId: 'test-machine-003',
        saveState: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('stop');
        expect(result.data.saveState).toBe(true);
      }
    });
  });

  describe('Rejection des actions invalides', () => {
    it('devrait rejeter action inconnue', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'unknown' as any
      });
      expect(result.success).toBe(false);
    });

    it('devrait rejeter filter invalide', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'status',
        filter: 'invalid' as any
      });
      expect(result.success).toBe(false);
    });

    it('devrait valider heartbeatInterval positif ou nul', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'start',
        machineId: 'test-machine',
        heartbeatInterval: 0
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.heartbeatInterval).toBe(0);
      }
    });

    it('devrait rejeter heartbeatInterval négatif', () => {
      const result = HeartbeatArgsSchema.safeParse({
        action: 'start',
        machineId: 'test-machine',
        heartbeatInterval: -1
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('HeartbeatResultSchema', () => {
  it('devrait valider un résultat de status complet', () => {
    const result = HeartbeatResultSchema.safeParse({
      success: true,
      action: 'status',
      timestamp: '2026-04-23T08:00:00.000Z',
      message: 'État récupéré avec succès',
      data: {
        machines: [
          { id: 'machine-1', status: 'online', lastSeen: '2026-04-23T07:55:00.000Z' }
        ]
      }
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(true);
      expect(result.data.action).toBe('status');
      expect(result.data.data).toHaveProperty('machines');
    }
  });

  it('devrait valider un résultat minimal', () => {
    const result = HeartbeatResultSchema.safeParse({
      success: false,
      action: 'register',
      timestamp: '2026-04-23T08:00:00.000Z',
      message: 'Échec de l\'enregistrement'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.message).toBe('Échec de l\'enregistrement');
      expect(result.data.data).toBeUndefined();
    }
  });
});

describe('roosyncHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Action "status"', () => {
    it('devrait appeler roosyncHeartbeatStatus avec les bons paramètres', async () => {
      // Mock de la réponse de roosyncHeartbeatStatus
      const mockStatusResult = {
        success: true,
        machines: [
          { id: 'machine-1', status: 'online' },
          { id: 'machine-2', status: 'offline' }
        ]
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValueOnce(mockStatusResult);

      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'online',
        includeHeartbeats: true,
        forceCheck: true
      });

      expect(roosyncHeartbeatStatus).toHaveBeenCalledWith({
        filter: 'online',
        includeHeartbeats: true,
        forceCheck: true,
        includeChanges: undefined
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe('status');
      expect(result.data).toEqual(mockStatusResult);
    });

    it('devrait traiter une erreur venant de heartbeat-status', async () => {
      const error = new Error('Erreur de status');
      vi.mocked(roosyncHeartbeatStatus).mockRejectedValueOnce(error);

      await expect(roosyncHeartbeat({
        action: 'status'
      })).rejects.toThrow(HeartbeatServiceError);
    });
  });

  describe('Action "register"', () => {
    it('devrait appeler roosyncHeartbeatService avec les bons paramètres', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Heartbeat enregistré avec succès',
        result: { machineId: 'test-machine', registeredAt: '2026-04-23T08:00:00.000Z' }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValueOnce(mockServiceResult);

      const result = await roosyncHeartbeat({
        action: 'register',
        machineId: 'test-machine-001',
        metadata: { role: 'worker', version: '1.2.0' }
      });

      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'register',
        machineId: 'test-machine-001',
        metadata: { role: 'worker', version: '1.2.0' },
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: undefined
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe('register');
    });
  });

  describe('Action "start"', () => {
    it('devrait appeler roosyncHeartbeatService avec les paramètres de démarrage', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service démarré',
        result: { serviceId: 'heartbeat-service-001' }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValueOnce(mockServiceResult);

      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine-002',
        enableAutoSync: true,
        heartbeatInterval: 60000,
        offlineTimeout: 120000
      });

      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'start',
        machineId: 'test-machine-002',
        metadata: undefined,
        enableAutoSync: true,
        heartbeatInterval: 60000,
        offlineTimeout: 120000,
        saveState: undefined
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe('start');
    });
  });

  describe('Action "stop"', () => {
    it('devrait appeler roosyncHeartbeatService avec les paramètres d\'arrêt', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service arrêté',
        result: { stoppedAt: '2026-04-23T08:00:00.000Z' }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValueOnce(mockServiceResult);

      const result = await roosyncHeartbeat({
        action: 'stop',
        machineId: 'test-machine-003',
        saveState: true
      });

      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'stop',
        machineId: 'test-machine-003',
        metadata: undefined,
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: true
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe('stop');
    });
  });

  describe('Action inconnue', () => {
    it('devrait lancer une HeartbeatServiceError pour une action inconnue', async () => {
      await expect(roosyncHeartbeat({
        action: 'unknown' as any
      })).rejects.toThrow(HeartbeatServiceError);
    });
  });

  describe('Gestion des erreurs', () => {
    it('devrait convertir les erreurs générales en HeartbeatServiceError', async () => {
      const error = new Error('Erreur générale');
      vi.mocked(roosyncHeartbeatStatus).mockRejectedValueOnce(error);

      await expect(roosyncHeartbeat({
        action: 'status'
      })).rejects.toThrow(HeartbeatServiceError);
    });

    it('devrait relancer les HeartbeatServiceError sans les transformer', async () => {
      const error = new HeartbeatServiceError('Erreur spécifique', 'TEST_ERROR');
      vi.mocked(roosyncHeartbeatStatus).mockRejectedValueOnce(error);

      await expect(roosyncHeartbeat({
        action: 'status'
      })).rejects.toThrow(HeartbeatServiceError);
    });
  });

  describe('Timestamp', () => {
    it('devrait générer un timestamp valide pour chaque action', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Test réussi',
        result: {}
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValueOnce(mockServiceResult);

      const result = await roosyncHeartbeat({
        action: 'status'
      });

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(new Date(result.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});