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
});