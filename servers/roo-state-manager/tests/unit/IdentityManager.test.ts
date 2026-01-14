/**
 * Tests unitaires pour IdentityManager
 *
 * Tests pour la méthode checkIdentityConflict() qui bloque le démarrage
 * en cas de conflit d'identité.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IdentityManager } from '../../src/services/roosync/IdentityManager';
import { IdentityManagerError } from '../../src/types/errors';
import { PresenceManager } from '../../src/services/roosync/PresenceManager';
import { RooSyncConfig } from '../../src/config/roosync-config';
import { promises as fs } from 'fs';
import { join } from 'path';

// Mock du système de fichiers
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      readdir: vi.fn(),
      unlink: vi.fn()
    }
  };
});

describe('IdentityManager - checkIdentityConflict', () => {
  let config: RooSyncConfig;
  let presenceManager: PresenceManager;
  let identityManager: IdentityManager;
  let mockPresenceDir: string;

  beforeEach(() => {
    // Configuration de test
    config = {
      sharedPath: '/test/shared',
      machineId: 'TEST-MACHINE',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };

    mockPresenceDir = join(config.sharedPath, 'presence');

    // Mock PresenceManager
    presenceManager = {
      readPresence: vi.fn(),
      updatePresence: vi.fn(),
      removePresence: vi.fn(),
      listAllPresence: vi.fn(),
      validatePresenceUniqueness: vi.fn()
    } as any;

    identityManager = new IdentityManager(config, presenceManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Cas sans conflit', () => {
    it('devrait autoriser le démarrage si aucune présence existante', async () => {
      // Arrange
      vi.mocked(presenceManager.readPresence).mockResolvedValue(null);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).resolves.not.toThrow();
      expect(presenceManager.readPresence).toHaveBeenCalledWith('TEST-MACHINE');
    });

    it('devrait autoriser le démarrage si la présence est expirée', async () => {
      // Arrange
      const expiredPresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes
        version: '1.0.0',
        mode: 'code',
        source: 'test'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(expiredPresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).resolves.not.toThrow();
    });

    it('devrait autoriser le démarrage si la présence est hors ligne', async () => {
      // Arrange
      const offlinePresence = {
        id: 'TEST-MACHINE',
        status: 'offline' as const,
        lastSeen: new Date().toISOString(),
        version: '1.0.0',
        mode: 'code',
        source: 'test'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(offlinePresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).resolves.not.toThrow();
    });
  });

  describe('Cas avec conflit', () => {
    it('devrait bloquer le démarrage si une instance est active', async () => {
      // Arrange
      const activePresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes
        version: '1.0.0',
        mode: 'code',
        source: 'service'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(activePresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).rejects.toThrow(IdentityManagerError);

      try {
        await identityManager.checkIdentityConflict();
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityManagerError);
        if (error instanceof IdentityManagerError) {
          expect(error.code).toBe('IDENTITY_CONFLICT');
          expect(error.message).toContain('CONFLIT D\'IDENTITÉ DÉTECTÉ');
          expect(error.message).toContain('TEST-MACHINE');
        }
      }
    });

    it('devrait inclure des informations détaillées dans le message d\'erreur', async () => {
      // Arrange
      const activePresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 minute
        version: '1.0.0',
        mode: 'code',
        source: 'service'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(activePresence);

      // Act & Assert
      try {
        await identityManager.checkIdentityConflict();
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityManagerError);
        if (error instanceof IdentityManagerError) {
          expect(error.message).toContain('Dernière activité');
          expect(error.message).toContain('Source');
          expect(error.message).toContain('Mode');
          expect(error.message).toContain('Solutions possibles');
        }
      }
    });
  });

  describe('Gestion des erreurs', () => {
    it('devrait logger les erreurs non critiques sans bloquer', async () => {
      // Arrange
      vi.mocked(presenceManager.readPresence).mockRejectedValue(new Error('Erreur de lecture'));

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).resolves.not.toThrow();
    });

    it('devrait propager les IdentityManagerError', async () => {
      // Arrange
      const activePresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
        version: '1.0.0',
        mode: 'code',
        source: 'service'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(activePresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).rejects.toThrow(IdentityManagerError);
    });
  });

  describe('Seuil d\'activité', () => {
    it('devrait considérer comme active une présence de moins de 5 minutes', async () => {
      // Arrange
      const recentPresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 4 * 60 * 1000).toISOString(), // 4 minutes
        version: '1.0.0',
        mode: 'code',
        source: 'service'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(recentPresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).rejects.toThrow(IdentityManagerError);
    });

    it('devrait considérer comme expirée une présence de plus de 5 minutes', async () => {
      // Arrange
      const oldPresence = {
        id: 'TEST-MACHINE',
        status: 'online' as const,
        lastSeen: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 minutes
        version: '1.0.0',
        mode: 'code',
        source: 'service'
      };
      vi.mocked(presenceManager.readPresence).mockResolvedValue(oldPresence);

      // Act & Assert
      await expect(identityManager.checkIdentityConflict()).resolves.not.toThrow();
    });
  });
});
