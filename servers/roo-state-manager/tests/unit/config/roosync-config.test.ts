/**
 * Tests pour roosync-config.ts
 * 
 * Ces tests vérifient la validation de la configuration RooSync
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRooSyncConfig, tryLoadRooSyncConfig, isRooSyncEnabled, RooSyncConfigError } from '../../../src/config/roosync-config.js';

describe('RooSync Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Sauvegarder l'environnement actuel
    originalEnv = { ...process.env };
    // Désactiver le mode test pour tester la validation réelle
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    // Restaurer l'environnement
    process.env = originalEnv;
  });

  describe('loadRooSyncConfig', () => {
    it('devrait charger une configuration valide', () => {
      // Arrange
      process.env.ROOSYNC_SHARED_PATH = 'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      process.env.ROOSYNC_AUTO_SYNC = 'false';
      process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
      process.env.ROOSYNC_LOG_LEVEL = 'info';

      // Act
      const config = loadRooSyncConfig();

      // Assert
      expect(config.sharedPath).toBeDefined();
      expect(config.machineId).toBe('PC-PRINCIPAL');
      expect(config.autoSync).toBe(false);
      expect(config.conflictStrategy).toBe('manual');
      expect(config.logLevel).toBe('info');
    });

    it('devrait lever une erreur si une variable est manquante', () => {
      // Arrange
      process.env.ROOSYNC_SHARED_PATH = 'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      // Nettoyer explicitement les autres variables requises
      delete process.env.ROOSYNC_MACHINE_ID;
      delete process.env.ROOSYNC_AUTO_SYNC;
      delete process.env.ROOSYNC_CONFLICT_STRATEGY;
      delete process.env.ROOSYNC_LOG_LEVEL;

      // Act & Assert
      expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
      expect(() => loadRooSyncConfig()).toThrow(/manquantes/);
    });

    it('devrait lever une erreur si conflictStrategy est invalide', () => {
      // Arrange
      process.env.ROOSYNC_SHARED_PATH = 'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      process.env.ROOSYNC_AUTO_SYNC = 'false';
      process.env.ROOSYNC_CONFLICT_STRATEGY = 'invalid-strategy';
      process.env.ROOSYNC_LOG_LEVEL = 'info';

      // Act & Assert
      expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
      expect(() => loadRooSyncConfig()).toThrow(/CONFLICT_STRATEGY invalide/);
    });
  });

  describe('tryLoadRooSyncConfig', () => {
    it('devrait retourner null si la configuration est invalide', () => {
      // Arrange
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      // Supprimer explicitement ROOSYNC_SHARED_PATH
      delete process.env.ROOSYNC_SHARED_PATH;

      // Act
      const config = tryLoadRooSyncConfig();

      // Assert
      expect(config).toBeNull();
    });

    it('devrait retourner la configuration si valide', () => {
      // Arrange
      process.env.ROOSYNC_SHARED_PATH = 'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      process.env.ROOSYNC_AUTO_SYNC = 'true';
      process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
      process.env.ROOSYNC_LOG_LEVEL = 'debug';

      // Act
      const config = tryLoadRooSyncConfig();

      // Assert
      expect(config).not.toBeNull();
      expect(config?.autoSync).toBe(true);
      expect(config?.logLevel).toBe('debug');
    });
  });

  describe('isRooSyncEnabled', () => {
    it('devrait retourner false si la configuration est invalide', () => {
      // Arrange
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      // Supprimer explicitement les variables requises
      delete process.env.ROOSYNC_SHARED_PATH;

      // Act
      const enabled = isRooSyncEnabled();

      // Assert
      expect(enabled).toBe(false);
    });

    it('devrait retourner true si la configuration est valide', () => {
      // Arrange
      process.env.ROOSYNC_SHARED_PATH = 'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      process.env.ROOSYNC_AUTO_SYNC = 'false';
      process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
      process.env.ROOSYNC_LOG_LEVEL = 'info';

      // Act
      const enabled = isRooSyncEnabled();

      // Assert
      expect(enabled).toBe(true);
    });
  });
});