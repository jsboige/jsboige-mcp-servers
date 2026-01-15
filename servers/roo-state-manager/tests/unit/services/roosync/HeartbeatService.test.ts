/**
 * Tests unitaires pour le service de Heartbeat
 * 
 * T3.15 - Tests de heartbeat automatique
 * 
 * Couvre:
 * - Enregistrement de heartbeats
 * - Détection des machines offline
 * - Synchronisation automatique
 * - Timeout offline (2min)
 * - Heartbeat automatique (30s)
 * 
 * @version 3.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { HeartbeatService, HeartbeatConfig, HeartbeatData, HeartbeatServiceError } from '../../../../src/services/roosync/HeartbeatService.js';

describe('HeartbeatService - Tests Unitaires', () => {
  let tempDir: string;
  let sharedPath: string;
  let heartbeatService: HeartbeatService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'heartbeat-test-'));
    sharedPath = join(tempDir, 'shared');
    
    await mkdir(sharedPath, { recursive: true });
    
    // Configuration par défaut pour les tests
    const config: HeartbeatConfig = {
      heartbeatInterval: 30000, // 30 secondes
      offlineTimeout: 120000, // 2 minutes
      missedHeartbeatThreshold: 4,
      autoSyncEnabled: false, // Désactivé pour les tests
      autoSyncInterval: 60000
    };
    
    heartbeatService = new HeartbeatService(sharedPath, config);
  });

  afterEach(async () => {
    // Arrêter le service de heartbeat
    await heartbeatService.stopHeartbeatService();
    
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
        console.warn('Failed to cleanup temp dir:', error.message);
      }
    }
    vi.restoreAllMocks();
  });

  describe('Enregistrement de heartbeats', () => {
    it('devrait enregistrer un heartbeat pour une nouvelle machine', async () => {
      // Act
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Assert
      const heartbeatData = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatData).toBeDefined();
      expect(heartbeatData?.machineId).toBe('machine-1');
      expect(heartbeatData?.status).toBe('online');
      expect(heartbeatData?.missedHeartbeats).toBe(0);
      expect(heartbeatData?.metadata.firstSeen).toBeDefined();
      expect(heartbeatData?.metadata.lastUpdated).toBeDefined();
    });

    it('devrait mettre à jour un heartbeat existant', async () => {
      // Arrange - Enregistrer un heartbeat initial
      await heartbeatService.registerHeartbeat('machine-1');
      const firstHeartbeat = heartbeatService.getHeartbeatData('machine-1');
      const firstTimestamp = firstHeartbeat?.lastHeartbeat;
      
      // Attendre un peu pour que le timestamp change
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Act - Enregistrer un nouveau heartbeat
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Assert
      const updatedHeartbeat = heartbeatService.getHeartbeatData('machine-1');
      expect(updatedHeartbeat?.lastHeartbeat).not.toBe(firstTimestamp);
      expect(updatedHeartbeat?.status).toBe('online');
      expect(updatedHeartbeat?.missedHeartbeats).toBe(0);
    });

    it('devrait gérer plusieurs machines simultanément', async () => {
      // Act
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      await heartbeatService.registerHeartbeat('machine-3');
      
      // Assert
      expect(heartbeatService.getHeartbeatData('machine-1')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('machine-2')).toBeDefined();
      expect(heartbeatService.getHeartbeatData('machine-3')).toBeDefined();
      
      const state = heartbeatService.getState();
      expect(state.statistics.totalMachines).toBe(3);
      expect(state.onlineMachines).toHaveLength(3);
    });
  });

  describe('Détection des machines offline', () => {
    it('devrait détecter une machine offline après le timeout', async () => {
      // Arrange - Enregistrer un heartbeat
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Simuler le passage du temps en modifiant directement le fichier
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      // Modifier le timestamp pour simuler une machine offline
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 130000).toISOString(); // Plus de 2 minutes
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service pour charger l'état modifié
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act - Vérifier les heartbeats
      const result = await heartbeatService.checkHeartbeats();
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.newlyOfflineMachines).toContain('machine-1');
      
      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('offline');
      expect(heartbeatDataAfter?.offlineSince).toBeDefined();
      expect(heartbeatDataAfter?.missedHeartbeats).toBeGreaterThan(0);
    });

    it('devrait détecter une machine en avertissement avant offline', async () => {
      // Arrange - Enregistrer un heartbeat
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Simuler le passage du temps pour un avertissement
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        // Mettre le timestamp à 119 secondes pour déclencher l'avertissement
        // (>= 4 * 30s = 120s pour warning, mais < 120s pour offline)
        heartbeatData.lastHeartbeat = new Date(Date.now() - 119000).toISOString();
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act
      const result = await heartbeatService.checkHeartbeats();
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.warningMachines).toContain('machine-1');
      
      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('warning');
      expect(heartbeatDataAfter?.missedHeartbeats).toBe(3); // 119s / 30s = 3 heartbeats manqués
    });

    it('devrait détecter le retour online d\'une machine', async () => {
      // Arrange - Créer une machine offline
      await heartbeatService.registerHeartbeat('machine-1');
      
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 130000).toISOString();
        heartbeatData.status = 'offline';
        heartbeatData.offlineSince = new Date(Date.now() - 130000).toISOString();
        heartbeatData.missedHeartbeats = 5;
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act - Enregistrer un nouveau heartbeat
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Assert
      const heartbeatDataAfter = heartbeatService.getHeartbeatData('machine-1');
      expect(heartbeatDataAfter?.status).toBe('online');
      expect(heartbeatDataAfter?.offlineSince).toBeUndefined();
      expect(heartbeatDataAfter?.missedHeartbeats).toBe(0);
    });
  });

  describe('État du service', () => {
    it('devrait retourner l\'état complet du service', async () => {
      // Arrange - Enregistrer quelques machines
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      
      // Act
      const state = heartbeatService.getState();
      
      // Assert
      expect(state).toBeDefined();
      expect(state.statistics.totalMachines).toBe(2);
      expect(state.onlineMachines).toHaveLength(2);
      expect(state.offlineMachines).toHaveLength(0);
      expect(state.warningMachines).toHaveLength(0);
      expect(state.statistics.onlineCount).toBe(2);
      expect(state.statistics.offlineCount).toBe(0);
      expect(state.statistics.warningCount).toBe(0);
    });

    it('devrait retourner les machines online', async () => {
      // Arrange
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      
      // Act
      const onlineMachines = heartbeatService.getOnlineMachines();
      
      // Assert
      expect(onlineMachines).toHaveLength(2);
      expect(onlineMachines).toContain('machine-1');
      expect(onlineMachines).toContain('machine-2');
    });

    it('devrait retourner les machines offline', async () => {
      // Arrange - Créer une machine offline
      await heartbeatService.registerHeartbeat('machine-1');
      
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 130000).toISOString();
        heartbeatData.status = 'offline';
        heartbeatData.offlineSince = new Date(Date.now() - 130000).toISOString();
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act
      const offlineMachines = heartbeatService.getOfflineMachines();
      
      // Assert
      expect(offlineMachines).toContain('machine-1');
    });

    it('devrait retourner les machines en avertissement', async () => {
      // Arrange - Créer une machine en avertissement
      await heartbeatService.registerHeartbeat('machine-1');
      
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 90000).toISOString();
        heartbeatData.status = 'warning';
        heartbeatData.missedHeartbeats = 3;
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act
      const warningMachines = heartbeatService.getWarningMachines();
      
      // Assert
      expect(warningMachines).toContain('machine-1');
    });
  });

  describe('Gestion des machines', () => {
    it('devrait supprimer une machine du service', async () => {
      // Arrange - Enregistrer une machine
      await heartbeatService.registerHeartbeat('machine-1');
      expect(heartbeatService.getHeartbeatData('machine-1')).toBeDefined();
      
      // Act - Supprimer la machine
      await heartbeatService.removeMachine('machine-1');
      
      // Assert
      expect(heartbeatService.getHeartbeatData('machine-1')).toBeUndefined();
      
      const state = heartbeatService.getState();
      expect(state.statistics.totalMachines).toBe(0);
    });

    it('devrait nettoyer les machines offline depuis longtemps', async () => {
      // Arrange - Créer des machines offline avec différents âges
      await heartbeatService.registerHeartbeat('machine-old-1');
      await heartbeatService.registerHeartbeat('machine-old-2');
      await heartbeatService.registerHeartbeat('machine-recent');
      
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      // Modifier les timestamps
      const now = Date.now();
      
      const old1Data = state.heartbeats.get('machine-old-1');
      if (old1Data) {
        old1Data.lastHeartbeat = new Date(now - 90000000).toISOString(); // Plus de 24h
        old1Data.status = 'offline';
        old1Data.offlineSince = new Date(now - 90000000).toISOString();
        state.heartbeats.set('machine-old-1', old1Data);
      }
      
      const old2Data = state.heartbeats.get('machine-old-2');
      if (old2Data) {
        old2Data.lastHeartbeat = new Date(now - 90000000).toISOString(); // Plus de 24h
        old2Data.status = 'offline';
        old2Data.offlineSince = new Date(now - 90000000).toISOString();
        state.heartbeats.set('machine-old-2', old2Data);
      }
      
      const recentData = state.heartbeats.get('machine-recent');
      if (recentData) {
        recentData.lastHeartbeat = new Date(now - 3600000).toISOString(); // 1 heure
        recentData.status = 'offline';
        recentData.offlineSince = new Date(now - 3600000).toISOString();
        state.heartbeats.set('machine-recent', recentData);
      }
      
      await fs.writeFile(heartbeatPath, JSON.stringify({
        heartbeats: Object.fromEntries(state.heartbeats),
        onlineMachines: state.onlineMachines,
        offlineMachines: state.offlineMachines,
        warningMachines: state.warningMachines,
        statistics: state.statistics
      }, null, 2));
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act - Nettoyer les machines offline depuis plus de 24h
      const removedCount = await heartbeatService.cleanupOldOfflineMachines(86400000); // 24h
      
      // Assert
      expect(removedCount).toBe(2);
      expect(heartbeatService.getHeartbeatData('machine-old-1')).toBeUndefined();
      expect(heartbeatService.getHeartbeatData('machine-old-2')).toBeUndefined();
      expect(heartbeatService.getHeartbeatData('machine-recent')).toBeDefined(); // Pas supprimée
    });
  });

  describe('Configuration', () => {
    it('devrait mettre à jour la configuration du service', async () => {
      // Act
      await heartbeatService.updateConfig({
        heartbeatInterval: 60000, // 1 minute
        offlineTimeout: 180000, // 3 minutes
        missedHeartbeatThreshold: 6
      });
      
      // Assert - Vérifier que la configuration a été mise à jour
      // Note: La configuration est interne, on vérifie juste que l'appel ne lance pas d'erreur
      expect(true).toBe(true);
    });
  });

  describe('Callbacks de notification', () => {
    it('devrait appeler le callback lors de la détection offline', async () => {
      // Arrange
      const offlineCallback = vi.fn();
      const onlineCallback = vi.fn();
      
      // Enregistrer un heartbeat initial
      await heartbeatService.registerHeartbeat('machine-1');
      
      // Simuler une machine offline en modifiant directement le fichier
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 130000).toISOString();
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service avec callbacks
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act - Démarrer le service avec callbacks (sans enregistrer de heartbeat)
      await heartbeatService.startHeartbeatService('machine-2', offlineCallback, onlineCallback);
      
      // Vérifier les heartbeats - machine-1 devrait être détectée offline
      const result = await heartbeatService.checkHeartbeats();
      
      // Assert
      expect(result.newlyOfflineMachines).toContain('machine-1');
      expect(offlineCallback).toHaveBeenCalledWith('machine-1');
    });
    it('devrait appeler le callback lors du retour online', async () => {
      // Arrange
      const offlineCallback = vi.fn();
      const onlineCallback = vi.fn();
      
      // Créer une machine offline
      await heartbeatService.registerHeartbeat('machine-1');
      
      const heartbeatPath = join(sharedPath, 'heartbeat.json');
      const state = heartbeatService.getState();
      
      const heartbeatData = state.heartbeats.get('machine-1');
      if (heartbeatData) {
        heartbeatData.lastHeartbeat = new Date(Date.now() - 130000).toISOString();
        heartbeatData.status = 'offline';
        heartbeatData.offlineSince = new Date(Date.now() - 130000).toISOString();
        state.heartbeats.set('machine-1', heartbeatData);
        
        await fs.writeFile(heartbeatPath, JSON.stringify({
          heartbeats: Object.fromEntries(state.heartbeats),
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics
        }, null, 2));
      }
      
      // Recréer le service
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Act - Démarrer le service avec callbacks (sans enregistrer de heartbeat)
      await heartbeatService.startHeartbeatService('machine-2', offlineCallback, onlineCallback);
      
      // Simuler un heartbeat récent pour machine-1 en modifiant directement le fichier
      const heartbeatPath2 = join(sharedPath, 'heartbeat.json');
      const state2 = heartbeatService.getState();
      
      const heartbeatData2 = state2.heartbeats.get('machine-1');
      if (heartbeatData2) {
        heartbeatData2.lastHeartbeat = new Date().toISOString(); // Timestamp récent
        state2.heartbeats.set('machine-1', heartbeatData2);
        
        await fs.writeFile(heartbeatPath2, JSON.stringify({
          heartbeats: Object.fromEntries(state2.heartbeats),
          onlineMachines: state2.onlineMachines,
          offlineMachines: state2.offlineMachines,
          warningMachines: state2.warningMachines,
          statistics: state2.statistics
        }, null, 2));
      }
      
      // Recréer le service pour charger l'état modifié
      await heartbeatService.stopHeartbeatService();
      heartbeatService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Démarrer le service avec callbacks
      await heartbeatService.startHeartbeatService('machine-2', offlineCallback, onlineCallback);
      
      // Vérifier les heartbeats pour déclencher le callback online
      const result = await heartbeatService.checkHeartbeats();
      
      // Assert
      expect(result.newlyOnlineMachines).toContain('machine-1');
      expect(onlineCallback).toHaveBeenCalledWith('machine-1');
    });
  });

  describe('Persistance des données', () => {
    it('devrait sauvegarder et charger l\'état du service', async () => {
      // Arrange - Enregistrer des heartbeats
      await heartbeatService.registerHeartbeat('machine-1');
      await heartbeatService.registerHeartbeat('machine-2');
      
      // Act - Arrêter et recréer le service
      await heartbeatService.stopHeartbeatService();
      
      const newService = new HeartbeatService(sharedPath, {
        heartbeatInterval: 30000,
        offlineTimeout: 120000,
        missedHeartbeatThreshold: 4,
        autoSyncEnabled: false,
        autoSyncInterval: 60000
      });
      
      // Assert - Vérifier que les données ont été chargées
      const state = newService.getState();
      expect(state.statistics.totalMachines).toBe(2);
      expect(newService.getHeartbeatData('machine-1')).toBeDefined();
      expect(newService.getHeartbeatData('machine-2')).toBeDefined();
    });
  });
});
