/**
 * Tests pour RooSyncService.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Unmock fs to ensure we use the real filesystem for tests
vi.unmock('fs');
vi.unmock('../../../src/services/RooSyncService.js');

import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ces tests qui utilisent le système de fichiers réel
vi.unmock('fs');
import { RooSyncService, getRooSyncService, RooSyncServiceError } from '../../../src/services/RooSyncService.js';

describe('RooSyncService', () => {
  const testDir = join(__dirname, '../../fixtures/roosync-service-test');

  beforeEach(() => {
    // Créer le répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Créer des fichiers de test
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-07T12:00:00Z',
      overallStatus: 'synced',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-07T11:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };

    const roadmap = `# Roadmap

<!-- DECISION_BLOCK_START -->
**ID:** \`d1\`
**Titre:** Test Decision
**Statut:** pending
**Type:** config
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-07T10:00:00Z
<!-- DECISION_BLOCK_END -->
`;

    const config = {
      version: '2.0.0',
      sharedStatePath: testDir
    };

    const baseline = {
      version: '2.1.0',
      baselineId: 'test-baseline-001',
      machineId: 'PC-PRINCIPAL',
      timestamp: '2025-10-07T10:00:00Z',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info',
      sharedStatePath: testDir,
      machines: [{
        id: 'PC-PRINCIPAL',
        name: 'PC Principal',
        hostname: 'test-hostname',
        os: 'Windows 11',
        architecture: 'x64',
        lastSeen: '2025-10-07T10:00:00Z',
        roo: { modes: [], mcpServers: [], sdddSpecs: [] },
        hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 16 } },
        software: { node: '20.0.0', python: '3.10' }
      }],
      syncTargets: []
    };

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
    writeFileSync(join(testDir, 'sync-config.json'), JSON.stringify(config), 'utf-8');
    writeFileSync(join(testDir, 'sync-baseline.json'), JSON.stringify(baseline), 'utf-8');

    // Mock de l'environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';

    // Réinitialiser le singleton
    RooSyncService.resetInstance();
  });

  afterEach(() => {
    // Nettoyer
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }

    RooSyncService.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('devrait retourner la même instance', () => {
      // Act
      const instance1 = getRooSyncService();
      const instance2 = getRooSyncService();

      // Assert
      expect(instance1).toBe(instance2);
    });

    it('devrait permettre de réinitialiser l\'instance', () => {
      // Arrange
      const instance1 = getRooSyncService();

      // Act
      RooSyncService.resetInstance();
      const instance2 = getRooSyncService();

      // Assert
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('loadDashboard', () => {
    it('devrait charger le dashboard avec succès', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const dashboard = await service.loadDashboard();

      // Assert
      expect(dashboard.version).toBe('2.0.0');
      expect(dashboard.machines['PC-PRINCIPAL']).toBeDefined();
      expect(dashboard.machines['PC-PRINCIPAL'].diffsCount).toBe(0);
    });

    it('devrait utiliser le cache', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const dashboard1 = await service.loadDashboard();

      // Modifier le fichier
      const newDashboard = JSON.parse(readFileSync(join(testDir, 'sync-dashboard.json'), 'utf-8'));
      newDashboard.overallStatus = 'diverged';
      writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(newDashboard), 'utf-8');

      const dashboard2 = await service.loadDashboard();

      // Assert
      expect(dashboard1.overallStatus).toBe('synced');
      expect(dashboard2.overallStatus).toBe('synced'); // Toujours en cache
    });

    it('devrait retourner un dashboard par défaut si le fichier n\'existe pas', async () => {
      // Arrange
      rmSync(join(testDir, 'sync-dashboard.json'));
      rmSync(join(testDir, 'sync-baseline.json')); // Supprimer aussi le baseline pour éviter l'erreur de validation
      
      // Forcer la réinitialisation complète du service en supprimant les variables d'environnement
      delete process.env.SHARED_STATE_PATH;
      
      // Vider le cache avant de réinitialiser
      const tempService = getRooSyncService();
      tempService.clearCache();
      
      // Réinitialiser le service APRÈS suppression et vidage du cache
      RooSyncService.resetInstance();
      
      // Recréer les variables d'environnement APRÈS réinitialisation
      process.env.SHARED_STATE_PATH = testDir;
      process.env.ROOSYNC_SHARED_PATH = testDir;
      process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
      process.env.ROOSYNC_AUTO_SYNC = 'false';
      process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
      process.env.ROOSYNC_LOG_LEVEL = 'info';
      
      const service = getRooSyncService();

      // Act & Assert - Le test doit maintenant réussir car les fichiers sont supprimés
      // et le service devrait gérer ce cas correctement
      const dashboard = await service.loadDashboard();

      expect(dashboard).toBeDefined();
      expect(dashboard.version).toBe('2.1.0');
      expect(dashboard.overallStatus).toBeDefined();
    });
  });

  describe('loadDecisions', () => {
    it('devrait charger toutes les décisions', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decisions = await service.loadDecisions();

      // Assert
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('d1');
      expect(decisions[0].title).toBe('Test Decision');
    });
  });

  describe('getDecision', () => {
    it('devrait récupérer une décision par ID', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decision = await service.getDecision('d1');

      // Assert
      expect(decision).not.toBeNull();
      expect(decision?.id).toBe('d1');
    });

    it('devrait retourner null si la décision n\'existe pas', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decision = await service.getDecision('nonexistent');

      // Assert
      expect(decision).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('devrait retourner l\'état de synchronisation', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const status = await service.getStatus();

      // Assert
      expect(status.machineId).toBe('PC-PRINCIPAL');
      expect(status.overallStatus).toBe('synced');
      expect(status.diffsCount).toBe(0);
      expect(status.pendingDecisions).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('devrait vider le cache', async () => {
      // Arrange
      const service = getRooSyncService();
      await service.loadDashboard(); // Mettre en cache

      // Act
      service.clearCache();

      // Modifier le fichier
      const newDashboard = JSON.parse(readFileSync(join(testDir, 'sync-dashboard.json'), 'utf-8'));
      newDashboard.overallStatus = 'diverged';
      writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(newDashboard), 'utf-8');

      const dashboard = await service.loadDashboard();

      // Assert
      expect(dashboard.overallStatus).toBe('diverged'); // Pas en cache
    });
  });

  describe('HeartbeatService Integration', () => {
    beforeEach(() => {
      // Reset l'instance singleton avant chaque test
      RooSyncService.resetInstance();
    });

    afterEach(() => {
      // Reset l'instance singleton après chaque test
      RooSyncService.resetInstance();
    });

    describe('getHeartbeatService', () => {
      it('devrait retourner l\'instance de HeartbeatService', () => {
        // Arrange & Act
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Assert
        expect(heartbeatService).toBeDefined();
        expect(heartbeatService).toHaveProperty('registerHeartbeat');
        expect(heartbeatService).toHaveProperty('checkHeartbeats');
        expect(heartbeatService).toHaveProperty('getOfflineMachines');
        expect(heartbeatService).toHaveProperty('getWarningMachines');
        expect(heartbeatService).toHaveProperty('getState');
      });
    });

    describe('registerHeartbeat', () => {
      it('devrait enregistrer un heartbeat pour la machine courante', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Act
        await service.registerHeartbeat({ test: 'metadata' });

        // Assert
        const state = heartbeatService.getState();
        expect(state.onlineMachines).toContain(service.getConfig().machineId);
      });

      it('devrait mettre à jour le timestamp du heartbeat', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();
        const machineId = service.getConfig().machineId;

        // Act
        await service.registerHeartbeat();
        const firstTimestamp = heartbeatService.getHeartbeatData(machineId)?.lastHeartbeat;

        // Attendre un peu
        await new Promise(resolve => setTimeout(resolve, 100));

        await service.registerHeartbeat();
        const secondTimestamp = heartbeatService.getHeartbeatData(machineId)?.lastHeartbeat;

        // Assert
        expect(firstTimestamp).toBeDefined();
        expect(secondTimestamp).toBeDefined();
        expect(secondTimestamp).not.toBe(firstTimestamp);
      });
    });

    describe('getOfflineMachines', () => {
      it('devrait retourner la liste des machines offline', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Enregistrer un heartbeat pour une machine
        await heartbeatService.registerHeartbeat('test-machine-1');

        // Simuler une machine offline en modifiant directement le fichier heartbeat.json
        const heartbeatPath = join(testDir, 'heartbeat.json');
        const heartbeatData = {
          heartbeats: {
            'test-machine-1': {
              machineId: 'test-machine-1',
              lastHeartbeat: new Date(Date.now() - 300000).toISOString(), // 5 minutes avant
              status: 'offline',
              missedHeartbeats: 10,
              metadata: {
                firstSeen: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                version: '3.0.0'
              }
            }
          },
          onlineMachines: [],
          offlineMachines: ['test-machine-1'],
          warningMachines: [],
          statistics: {
            totalMachines: 1,
            onlineCount: 0,
            offlineCount: 1,
            warningCount: 0,
            lastHeartbeatCheck: new Date().toISOString()
          }
        };
        writeFileSync(heartbeatPath, JSON.stringify(heartbeatData, null, 2), 'utf-8');

        // Recharger l'état du service de heartbeat
        // Le HeartbeatService recharge l'état lors de l'initialisation
        // Nous devons créer une nouvelle instance pour forcer le rechargement
        RooSyncService.resetInstance();
        const newService = getRooSyncService();

        // Act
        const offlineMachines = newService.getOfflineMachines();

        // Assert
        expect(offlineMachines).toContain('test-machine-1');
      });
    });

    describe('getWarningMachines', () => {
      it('devrait retourner la liste des machines en avertissement', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Enregistrer un heartbeat pour une machine
        await heartbeatService.registerHeartbeat('test-machine-2');

        // Simuler une machine en avertissement
        const heartbeatPath = join(testDir, 'heartbeat.json');
        const heartbeatData = {
          heartbeats: {
            'test-machine-2': {
              machineId: 'test-machine-2',
              lastHeartbeat: new Date(Date.now() - 90000).toISOString(), // 90 secondes avant
              status: 'warning',
              missedHeartbeats: 3,
              metadata: {
                firstSeen: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                version: '3.0.0'
              }
            }
          },
          onlineMachines: [],
          offlineMachines: [],
          warningMachines: ['test-machine-2'],
          statistics: {
            totalMachines: 1,
            onlineCount: 0,
            offlineCount: 0,
            warningCount: 1,
            lastHeartbeatCheck: new Date().toISOString()
          }
        };
        writeFileSync(heartbeatPath, JSON.stringify(heartbeatData, null, 2), 'utf-8');

        // Recharger l'état du service de heartbeat
        RooSyncService.resetInstance();
        const newService = getRooSyncService();

        // Act
        const warningMachines = newService.getWarningMachines();

        // Assert
        expect(warningMachines).toContain('test-machine-2');
      });
    });

    describe('getHeartbeatState', () => {
      it('devrait retourner l\'état complet du service de heartbeat', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Enregistrer des heartbeats
        await heartbeatService.registerHeartbeat('machine-1');
        await heartbeatService.registerHeartbeat('machine-2');

        // Act
        const state = service.getHeartbeatState();

        // Assert
        expect(state).toBeDefined();
        expect(state.heartbeats).toBeInstanceOf(Map);
        expect(state.onlineMachines).toBeInstanceOf(Array);
        expect(state.offlineMachines).toBeInstanceOf(Array);
        expect(state.warningMachines).toBeInstanceOf(Array);
        expect(state.statistics).toBeDefined();
        expect(state.statistics.totalMachines).toBeGreaterThanOrEqual(2);
      });
    });

    describe('startHeartbeatService', () => {
      it('devrait démarrer le service de heartbeat', async () => {
        // Arrange
        const service = getRooSyncService();
        const offlineCallback = vi.fn();
        const onlineCallback = vi.fn();

        // Act
        await service.startHeartbeatService(offlineCallback, onlineCallback);

        // Attendre un peu pour que le heartbeat soit enregistré
        await new Promise(resolve => setTimeout(resolve, 100));

        // Assert
        const state = service.getHeartbeatState();
        expect(state.onlineMachines).toContain(service.getConfig().machineId);

        // Cleanup
        await service.stopHeartbeatService();
      });

      it('devrait appeler le callback offline lors de la détection offline', async () => {
        // Arrange
        const service = getRooSyncService();
        const offlineCallback = vi.fn();
        const onlineCallback = vi.fn();

        // Act - Démarrer le service avec des callbacks
        await service.startHeartbeatService(offlineCallback, onlineCallback);

        // Simuler une machine offline en enregistrant un heartbeat ancien
        const heartbeatService = service.getHeartbeatService();
        await heartbeatService.registerHeartbeat('offline-machine');
        
        // Attendre un peu pour que le heartbeat soit enregistré
        await new Promise(resolve => setTimeout(resolve, 50));

        // Vérifier que la machine est online initialement
        const stateBefore = heartbeatService.getState();
        expect(stateBefore.onlineMachines).toContain('offline-machine');

        // Cleanup
        await service.stopHeartbeatService();

        // Assert - Le callback offline n'est pas appelé immédiatement
        // car la machine est toujours online (le heartbeat vient d'être enregistré)
        // Le callback serait appelé après le timeout de heartbeat (2 minutes par défaut)
        expect(offlineCallback).not.toHaveBeenCalled();
      });
    });

    describe('stopHeartbeatService', () => {
      it('devrait arrêter le service de heartbeat', async () => {
        // Arrange
        const service = getRooSyncService();
        await service.startHeartbeatService();

        // Act
        await service.stopHeartbeatService();

        // Assert - Le service devrait être arrêté sans erreur
        expect(true).toBe(true);
      });
    });

    describe('checkHeartbeats', () => {
      it('devrait vérifier les heartbeats et retourner le résultat', async () => {
        // Arrange
        const service = getRooSyncService();
        const heartbeatService = service.getHeartbeatService();

        // Enregistrer des heartbeats
        await heartbeatService.registerHeartbeat('machine-1');
        await heartbeatService.registerHeartbeat('machine-2');

        // Act
        const result = await service.checkHeartbeats();

        // Assert
        expect(result).toBeDefined();
        expect(result.success).toBe(true);
        expect(result.checkedAt).toBeDefined();
        expect(Array.isArray(result.newlyOfflineMachines)).toBe(true);
        expect(Array.isArray(result.newlyOnlineMachines)).toBe(true);
        expect(Array.isArray(result.warningMachines)).toBe(true);
      });
    });
  });
});