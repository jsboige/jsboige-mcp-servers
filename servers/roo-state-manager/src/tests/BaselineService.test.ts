/**
 * Tests unitaires pour BaselineService
 * 
 * Tests des fonctionnalités du service de gestion des configurations de référence
 */

import { BaselineService } from '../services/BaselineService.js';
import { ConfigService } from '../services/ConfigService.js';
import { DiffDetector } from '../services/DiffDetector.js';
import { InventoryCollectorWrapper } from '../services/InventoryCollectorWrapper.js';
import { BaselineConfig, SyncDecision, MachineInventory, BaselineDifference, BaselineComparisonReport } from '../types/baseline.js';
import { BaselineServiceError } from '../types/baseline.js';

// Mock des dépendances avec Jest
jest.mock('../services/ConfigService');
jest.mock('../services/DiffDetector');
jest.mock('../services/InventoryCollectorWrapper');

// Le mock fs est déjà configuré dans setup.js

describe('BaselineService', () => {
  let baselineService: BaselineService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockDiffDetector: jest.Mocked<DiffDetector>;
  let mockInventoryCollector: jest.Mocked<InventoryCollectorWrapper>;

  beforeEach(() => {
    // Réinitialisation des mocks
    jest.clearAllMocks();
    
    // Récupérer le mock fs depuis le global
    const { mockFs } = global as any;
    
    // Création des mocks
    mockConfigService = new ConfigService() as jest.Mocked<ConfigService>;
    mockDiffDetector = new DiffDetector() as jest.Mocked<DiffDetector>;
    mockInventoryCollector = {
      collectInventory: jest.fn(),
    } as any;

    // Configuration des mocks par défaut
    mockConfigService.getBaselineServiceConfig = jest.fn().mockReturnValue({
      baselinePath: '\\test\\path\\sync-config.ref.json',
      roadmapPath: '\\test\\path\\sync-roadmap.md',
      cacheEnabled: true,
      cacheTTL: 3600,
      logLevel: 'INFO',
    });
    
    mockConfigService.getSharedStatePath = jest.fn().mockReturnValue('\\test\\path');

    // Création du service avec les mocks
    baselineService = new BaselineService(
      mockConfigService,
      mockInventoryCollector,
      mockDiffDetector
    );
  });

  describe('loadBaseline', () => {
    it('devrait charger une configuration baseline existante', async () => {
      // Arrange
      const mockBaselineConfig: BaselineConfig = {
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: { 'test-server': { enabled: true } },
            userSettings: { theme: 'dark' },
          },
          hardware: {
            cpu: 'Intel i7',
            ram: '16GB',
            disks: [{ name: 'C:', size: '500GB' }],
          },
          software: {
            powershell: '7.2.0',
            node: '18.0.0',
            python: '3.9.0',
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64',
          },
        },
      };

      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaselineConfig));

      // Act
      const result = await baselineService.loadBaseline();

      // Assert
      expect(result).toEqual(mockBaselineConfig);
      expect(mockFs.existsSync).toHaveBeenCalledWith('\\test\\path\\sync-config.ref.json');
      expect(mockFs.promises.readFile).toHaveBeenCalledWith('\\test\\path\\sync-config.ref.json', 'utf-8');
    });

    it('devrait retourner null si le fichier baseline n\'existe pas', async () => {
      // Arrange
      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(false);

      // Act
      const result = await baselineService.loadBaseline();

      // Assert
      expect(result).toBeNull();
      expect(mockFs.existsSync).toHaveBeenCalledWith('\\test\\path\\sync-config.ref.json');
      expect(mockFs.promises.readFile).not.toHaveBeenCalled();
    });

    it('devrait gérer les erreurs de lecture du fichier', async () => {
      // Arrange
      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockRejectedValue(new Error('Permission denied'));

      // Act & Assert
      await expect(baselineService.loadBaseline()).rejects.toThrow(BaselineServiceError);
    });

    it('devrait valider la configuration baseline', async () => {
      // Arrange
      const invalidConfig = {
        machineId: 'test-machine',
        // Configuration incomplète
      };

      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue(JSON.stringify(invalidConfig));

      // Act & Assert
      await expect(baselineService.loadBaseline()).rejects.toThrow(BaselineServiceError);
    });
  });

  describe('compareWithBaseline', () => {
    it('devrait comparer avec succès la configuration actuelle au baseline', async () => {
      // Arrange
      const mockBaselineConfig: BaselineConfig = {
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: { 'test-server': { enabled: true } },
            userSettings: { theme: 'dark' },
          },
          hardware: {
            cpu: 'Intel i7',
            ram: '16GB',
            disks: [{ name: 'C:', size: '500GB' }],
          },
          software: {
            powershell: '7.2.0',
            node: '18.0.0',
            python: '3.9.0',
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64',
          },
        },
      };

      const mockMachineInventory: MachineInventory = {
        machineId: 'test-machine',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code', 'ask', 'debug'],
            mcpSettings: { 'test-server': { enabled: false } },
            userSettings: { theme: 'light' },
          },
          hardware: {
            cpu: 'Intel i7',
            ram: '16GB',
            disks: [{ name: 'C:', size: '500GB' }],
          },
          software: {
            powershell: '7.2.0',
            node: '18.0.0',
            python: '3.9.0',
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64',
          },
        },
        metadata: {
          collectionDuration: 1000,
          source: 'local',
          collectorVersion: '1.0.0',
        },
      } as any;

      const mockDifferences: BaselineDifference[] = [
        {
          category: 'config',
          severity: 'WARNING',
          path: 'roo.modes',
          description: 'Modes differ',
          baselineValue: ['code', 'ask'],
          actualValue: ['code', 'ask', 'debug'],
          recommendedAction: 'Review mode configuration',
        },
      ];

      // Mock du chargement du baseline
      jest.spyOn(baselineService as any, 'loadBaseline').mockResolvedValue(mockBaselineConfig);
      
      mockInventoryCollector.collectInventory.mockResolvedValue(mockMachineInventory);
      mockDiffDetector.compareBaselineWithMachine.mockResolvedValue(mockDifferences);

      // Act
      const result = await baselineService.compareWithBaseline('test-machine');

      // Assert
      expect(result).toBeDefined();
      expect(result!.baselineMachine).toBe('test-machine');
      expect(result!.targetMachine).toBe('test-machine');
      expect(result!.differences).toEqual(mockDifferences);
      expect(result!.summary.total).toBe(1);
      expect(result!.summary.critical).toBe(0);
    });

    it('devrait retourner null si aucun baseline n\'est trouvé', async () => {
      // Arrange
      jest.spyOn(baselineService as any, 'loadBaseline').mockResolvedValue(null);

      // Act & Assert
      await expect(baselineService.compareWithBaseline('test-machine')).rejects.toThrow('Configuration baseline non disponible');
    });

    it('devrait gérer les erreurs de collecte d\'inventaire', async () => {
      // Arrange
      const mockBaselineConfig: BaselineConfig = {
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: {},
            userSettings: {},
          },
          hardware: {
            cpu: 'Intel i7',
            ram: '16GB',
            disks: [{ name: 'C:', size: '500GB' }],
          },
          software: {
            powershell: '7.2.0',
            node: '18.0.0',
            python: '3.9.0',
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64',
          },
        },
      };

      jest.spyOn(baselineService as any, 'loadBaseline').mockResolvedValue(mockBaselineConfig);
      mockInventoryCollector.collectInventory.mockResolvedValue(null);

      // Act & Assert
      await expect(baselineService.compareWithBaseline('test-machine')).rejects.toThrow('Échec collecte inventaire pour test-machine');
    });
  });

  describe('createSyncDecisions', () => {
    it('devrait créer des décisions de synchronisation', async () => {
      // Arrange
      const mockComparisonReport: BaselineComparisonReport = {
        baselineMachine: 'baseline-machine',
        targetMachine: 'target-machine',
        baselineVersion: '1.0.0',
        differences: [
          {
            category: 'config',
            severity: 'IMPORTANT',
            path: 'roo.userSettings.theme',
            description: 'Theme setting differs',
            baselineValue: 'dark',
            actualValue: 'light',
            recommendedAction: 'Sync to baseline',
          },
        ],
        summary: {
          total: 1,
          critical: 0,
          important: 1,
          warning: 0,
          info: 0,
        },
        generatedAt: new Date().toISOString(),
      };

      // Act
      const decisions = await baselineService.createSyncDecisions(mockComparisonReport, 'INFO');

      // Assert
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBeDefined();
      expect(decisions[0].machineId).toBe('target-machine');
      expect(decisions[0].status).toBe('pending');
      expect(decisions[0].severity).toBe('IMPORTANT');
      expect(decisions[0].differenceId).toBe('config-roo.userSettings.theme');
    });

    it('devrait filtrer les différences en dessous du seuil de sévérité', async () => {
      // Arrange
      const mockComparisonReport: BaselineComparisonReport = {
        baselineMachine: 'baseline-machine',
        targetMachine: 'target-machine',
        baselineVersion: '1.0.0',
        differences: [
          {
            category: 'config',
            severity: 'INFO',
            path: 'roo.userSettings.theme',
            description: 'Theme setting differs',
            baselineValue: 'dark',
            actualValue: 'light',
            recommendedAction: 'Sync to baseline',
          },
        ],
        summary: {
          total: 1,
          critical: 0,
          important: 0,
          warning: 0,
          info: 1,
        },
        generatedAt: new Date().toISOString(),
      };

      // Act - avec un seuil plus élevé
      const decisions = await baselineService.createSyncDecisions(mockComparisonReport, 'WARNING');

      // Assert
      expect(decisions).toHaveLength(0);
    });

    it('devrait gérer les différentes catégories de différences', async () => {
      // Arrange
      const mockComparisonReport: BaselineComparisonReport = {
        baselineMachine: 'baseline-machine',
        targetMachine: 'target-machine',
        baselineVersion: '1.0.0',
        differences: [
          {
            category: 'config',
            severity: 'CRITICAL',
            path: 'roo.modes',
            description: 'Missing critical mode',
            baselineValue: ['code', 'ask', 'debug'],
            actualValue: ['code', 'ask'],
            recommendedAction: 'Add debug mode',
          },
          {
            category: 'software',
            severity: 'IMPORTANT',
            path: 'software.node',
            description: 'Node.js version mismatch',
            baselineValue: '18.0.0',
            actualValue: '16.0.0',
            recommendedAction: 'Update Node.js',
          },
        ],
        summary: {
          total: 2,
          critical: 1,
          important: 1,
          warning: 0,
          info: 0,
        },
        generatedAt: new Date().toISOString(),
      };

      // Act
      const decisions = await baselineService.createSyncDecisions(mockComparisonReport);

      // Assert
      expect(decisions).toHaveLength(2);
      expect(decisions[0].category).toBe('config');
      expect(decisions[1].category).toBe('software');
    });
  });

  describe('applyDecision', () => {
    it('devrait appliquer une décision avec succès', async () => {
      // Arrange
      const decision: SyncDecision = {
        id: 'test-decision',
        machineId: 'test-machine',
        differenceId: 'diff-1',
        category: 'config',
        description: 'Apply baseline theme',
        baselineValue: 'dark',
        targetValue: 'light',
        action: 'sync_to_baseline',
        severity: 'INFO',
        status: 'approved',
        createdAt: new Date().toISOString(),
      };

      // Mock des méthodes internes
      jest.spyOn(baselineService as any, 'loadDecisionsFromRoadmap').mockResolvedValue([decision]);
      jest.spyOn(baselineService as any, 'updateDecisionInRoadmap').mockResolvedValue(undefined);
      jest.spyOn(baselineService as any, 'applyChangesToMachine').mockResolvedValue(true);

      // Act
      const result = await baselineService.applyDecision(decision.id);

      // Assert
      expect(result.success).toBe(true);
      expect(result.decisionId).toBe(decision.id);
      expect(result.message).toContain('appliquée avec succès');
    });

    it('devrait retourner une erreur si la décision n\'existe pas', async () => {
      // Arrange
      jest.spyOn(baselineService as any, 'loadDecisionsFromRoadmap').mockResolvedValue([]);

      // Act & Assert
      await expect(baselineService.applyDecision('non-existent-decision')).rejects.toThrow('non trouvée');
    });

    it('devrait retourner une erreur si la décision n\'est pas approuvée', async () => {
      // Arrange
      const decision: SyncDecision = {
        id: 'test-decision',
        machineId: 'test-machine',
        differenceId: 'diff-1',
        category: 'config',
        description: 'Apply baseline theme',
        baselineValue: 'dark',
        targetValue: 'light',
        action: 'sync_to_baseline',
        severity: 'INFO',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      jest.spyOn(baselineService as any, 'loadDecisionsFromRoadmap').mockResolvedValue([decision]);

      // Act & Assert
      await expect(baselineService.applyDecision(decision.id)).rejects.toThrow('n\'est pas approuvée');
    });

    it('devrait gérer les erreurs lors de l\'application des changements', async () => {
      // Arrange
      const decision: SyncDecision = {
        id: 'test-decision',
        machineId: 'test-machine',
        differenceId: 'diff-1',
        category: 'config',
        description: 'Apply baseline theme',
        baselineValue: 'dark',
        targetValue: 'light',
        action: 'sync_to_baseline',
        severity: 'INFO',
        status: 'approved',
        createdAt: new Date().toISOString(),
      };

      jest.spyOn(baselineService as any, 'loadDecisionsFromRoadmap').mockResolvedValue([decision]);
      jest.spyOn(baselineService as any, 'applyChangesToMachine').mockResolvedValue(false);

      // Act
      const result = await baselineService.applyDecision(decision.id);

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain('Échec de l\'application');
    });
  });

  describe('addDecisionsToRoadmap', () => {
    it('devrait ajouter des décisions au roadmap', async () => {
      // Arrange
      const decisions: SyncDecision[] = [
        {
          id: 'decision-1',
          machineId: 'test-machine',
          differenceId: 'config.test',
          category: 'config',
          description: 'Test decision',
          baselineValue: 'baseline',
          targetValue: 'target',
          action: 'sync_to_baseline',
          severity: 'INFO',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ];

      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue('# Test Roadmap\n\n');
      mockFs.promises.writeFile.mockResolvedValue(undefined);

      // Act
      await (baselineService as any).addDecisionsToRoadmap(decisions);

      // Assert
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
      expect(mockFs.promises.readFile).toHaveBeenCalledWith('\\test\\path\\sync-roadmap.md', 'utf-8');
    });

    it('devrait créer le fichier roadmap s\'il n\'existe pas', async () => {
      // Arrange
      const decisions: SyncDecision[] = [];

      const { mockFs } = global as any;
      mockFs.existsSync.mockReturnValue(false);
      mockFs.promises.writeFile.mockResolvedValue(undefined);

      // Act
      await (baselineService as any).addDecisionsToRoadmap(decisions);

      // Assert
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
    });
  });

  describe('Méthodes utilitaires', () => {
    it('devrait formater correctement une décision en Markdown', () => {
      // Arrange
      const decision: SyncDecision = {
        id: 'test-123',
        machineId: 'machine-1',
        differenceId: 'config.theme',
        category: 'config',
        description: 'Test decision',
        baselineValue: 'dark',
        targetValue: 'light',
        action: 'sync_to_baseline',
        severity: 'INFO',
        status: 'pending',
        createdAt: '2023-01-01T00:00:00.000Z',
      };

      // Act
      const result = (baselineService as any).formatDecisionToMarkdown(decision, '2023-01-01T00:00:00.000Z');

      // Assert
      expect(result).toContain('## ⏳ Décision test-123');
      expect(result).toContain('**Machine:** machine-1');
      expect(result).toContain('**Catégorie:** config');
      expect(result).toContain('**Différence:** config.theme');
      expect(result).toContain('**Sévérité:** ℹ️ INFO');
      expect(result).toContain('**Statut:** pending');
    });

    it('devrait parser correctement les décisions depuis le Markdown', () => {
      // Arrange
      const markdownContent = `
# Test Roadmap

## ⏳ Décision test-123

**Machine:** machine-1  
**Catégorie:** config  
**Différence:** config.theme  
**Sévérité:** ℹ️ INFO  
**Statut:** pending  
**Créée le:** 2023-01-01T00:00:00.000Z  
**Mise à jour le:** 2023-01-01T00:00:00.000Z

### Description
Test decision

### Différence
- **Valeur baseline:** "dark"
- **Valeur cible:** "light"

### Action requise
**Type:** sync_to_baseline

---

`;

      // Act
      const result = (baselineService as any).parseDecisionsFromMarkdown(markdownContent);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-123');
      expect(result[0].machineId).toBe('machine-1');
      expect(result[0].category).toBe('config');
      expect(result[0].differenceId).toBe('config.theme');
      expect(result[0].severity).toBe('INFO');
      expect(result[0].status).toBe('pending');
    });
  });
});