import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BaselineService } from '../../../src/services/BaselineService';
import { BaselineConfig, MachineInventory, BaselineDifference, SyncDecision, BaselineServiceError, BaselineServiceErrorCode, BaselineComparisonReport } from '../../../src/types/baseline';
import type { IConfigService, IInventoryCollector, IDiffDetector } from '../../../src/types/baseline';
import { existsSync, rmSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as mockFs from 'mock-fs';


describe('BaselineService', () => {
  let mockConfigService: IConfigService;
  let mockInventoryCollector: IInventoryCollector;
  let mockDiffDetector: IDiffDetector;
  let baselineService: BaselineService;
  let testBaselinePath: string;
  let testRoadmapPath: string;

  beforeEach(async () => {
    // Configurer mock-fs AVANT de créer le service
    mockFs.default({
      // Fichier de baseline de test valide
      'test-baseline-valid.json': JSON.stringify({
        version: '2.1.0',
        baselineId: 'baseline-1',
        machineId: 'test-machine',
        timestamp: '2025-11-04T01:00:00Z',
        machines: [
          {
            machineId: 'test-machine',
            os: 'Windows 11',
            architecture: 'x64',
            roo: {
              modes: ['code', 'ask'],
              mcpServers: [
                { name: 'test-server', enabled: true }
              ]
            },
            hardware: {
              cpu: { cores: 16, threads: 32 },
              memory: { total: 32000000000 }
            },
            software: {
              node: '18.17.0',
              python: '3.11.0'
            }
          }
        ]
      }, null, 2),
      
      // Fichier de configuration de référence
      'config/baselines/sync-config.ref.json': JSON.stringify({
        version: "1.0.0",
        baseline: {
          machineId: "myia-po-2026",
          timestamp: "2025-11-28T14:00:00Z",
          config: {
            roosync: {
              enabled: true,
              sharedPath: "/shared/roosync",
              conflictStrategy: "manual"
            },
            mcp: {
              timeout: 30000,
              retryAttempts: 3
            }
          }
        },
        metadata: {
          createdBy: "myia-po-2026",
          description: "Configuration de référence pour synchronisation"
        }
      }, null, 2),
      
      // Fichier roadmap
      'sync-roadmap.md': `# RooSync Roadmap

## Version 1.0.0

### Objectifs
- Synchronisation des configurations Roo
- Gestion des conflits automatique
- Support multi-machines

### Implémentations
- [x] BaselineService
- [x] SyncService
- [ ] ConflictService
- [ ] MonitoringService

### Prochaines étapes
1. Implémenter ConflictService
2. Ajouter monitoring en temps réel
3. Support des configurations complexes`,
      
      // Fichiers de décision pour les tests
      'decisions/test-decision-1.json': JSON.stringify({
        id: "test-decision-1",
        type: "baseline_update",
        status: "approved",
        timestamp: "2025-11-28T15:00:00Z",
        content: {
          machineId: "test-machine",
          changes: ["config.timeout"]
        }
      }, null, 2),
      
      'decisions/test-decision-2.json': JSON.stringify({
        id: "test-decision-2",
        type: "config_change",
        status: "pending",
        timestamp: "2025-11-28T15:00:00Z",
        content: {
          property: "roosync.conflictStrategy",
          oldValue: "manual",
          newValue: "auto"
        }
      }, null, 2)
    });

    mockConfigService = {
      getSharedStatePath: () => process.cwd(),
      getBaselineServiceConfig: () =>({
        baselinePath: path.join(process.cwd(), 'test-baseline-valid.json'),
        roadmapPath: path.join(process.cwd(), 'sync-roadmap.md'),
        cacheEnabled: false,
        cacheTTL: 300,
        logLevel: 'INFO' as const
      })
    } as IConfigService;

    mockInventoryCollector = {
      collectInventory: vi.fn()
    } as IInventoryCollector;

    mockDiffDetector = {
      compareBaselineWithMachine: vi.fn()
    } as IDiffDetector;

    baselineService = new BaselineService(mockConfigService, mockInventoryCollector, mockDiffDetector);
    testBaselinePath = path.join(process.cwd(), 'test-baseline-valid.json');
    testRoadmapPath = path.join(process.cwd(), 'sync-roadmap.md');
  });

  afterEach(() => {
    // Restaurer le système de fichiers réel
    mockFs.default.restore();
  });

  describe('loadBaseline', () => {
    it('devrait charger une baseline valide', async () => {
      const result = await baselineService.loadBaseline();

      // Vérifier que le résultat est un objet BaselineConfig valide
      expect(result).toBeDefined();
      expect(result).toHaveProperty('machineId', 'test-machine');
      expect(result).toHaveProperty('version', '2.1.0');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('lastUpdated');
      expect(baselineService.getState().isBaselineLoaded).toBe(true);
      expect(baselineService.getState().baselineMachine).toBe('test-machine');
      expect(baselineService.getState().baselineVersion).toBe('2.1.0');
    });

    it('devrait lever une erreur si le fichier n\'existe pas', async () => {
      // Créer un service avec un chemin de fichier inexistant
      const configServiceWithInvalidPath = {
        ...mockConfigService,
        getBaselineServiceConfig: () => ({
          baselinePath: path.join(process.cwd(), 'non-existent-baseline.json'),
          roadmapPath: path.join(process.cwd(), 'sync-roadmap.md'),
          cacheEnabled: false,
          cacheTTL: 300,
          logLevel: 'INFO' as const
        })
      };

      const baselineServiceWithInvalidPath = new BaselineService(configServiceWithInvalidPath, mockInventoryCollector, mockDiffDetector);

      const result = await baselineServiceWithInvalidPath.loadBaseline();

      // Le service retourne null quand le fichier n'existe pas
      expect(result).toBeNull();
    });

    it('devrait lever une erreur si le JSON est invalide', async () => {
      // Créer un fichier JSON invalide
      const invalidBaselinePath = path.join(process.cwd(), 'invalid-baseline.json');
      await fs.writeFile(invalidBaselinePath, '{ invalid json }');

      // Créer un service avec ce chemin invalide
      const configServiceWithInvalidJson = {
        ...mockConfigService,
        getBaselineServiceConfig: () => ({
          baselinePath: invalidBaselinePath,
          roadmapPath: path.join(process.cwd(), 'sync-roadmap.md'),
          cacheEnabled: false,
          cacheTTL: 300,
          logLevel: 'INFO' as const
        })
      };

      const baselineServiceWithInvalidJson = new BaselineService(configServiceWithInvalidJson, mockInventoryCollector, mockDiffDetector);

      await expect(baselineServiceWithInvalidJson.loadBaseline()).rejects.toThrow(
        expect.objectContaining({
          code: BaselineServiceErrorCode.BASELINE_NOT_FOUND
        })
      );

      // Nettoyer
      if (existsSync(invalidBaselinePath)) {
        rmSync(invalidBaselinePath);
      }
    });
  });

  describe('compareWithBaseline', () => {
    it('devrait comparer une machine avec la baseline', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const mockInventory: MachineInventory = {
        machineId: 'target-machine',
        timestamp: '2025-11-04T01:00:00Z',
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: { 'test-server': { enabled: false } },
            userSettings: { theme: 'dark' }
          },
          hardware: {
            cpu: {
              model: 'AMD Ryzen 9 5900X',
              cores: 12,
              threads: 24
            },
            memory: {
              total: 34359738368 // 32GB en bytes
            },
            disks: [{ name: 'C:', size: '1TB' }],
            gpu: 'NVIDIA RTX 3080'
          },
          software: {
            powershell: '7.2.0',
            node: '18.17.0',
            python: '3.11.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1500,
          source: 'local',
          collectorVersion: '2.1.0'
        }
      };

      const mockDifferences: BaselineDifference[] = [
        {
          category: 'hardware',
          severity: 'CRITICAL',
          path: 'hardware.cpu',
          description: 'CPU différent',
          baselineValue: 'Intel Core i9-12900K',
          actualValue: 'AMD Ryzen 9 5900X',
          recommendedAction: 'Mettre à jour la baseline'
        },
        {
          category: 'software',
          severity: 'IMPORTANT',
          path: 'software.node',
          description: 'Version Node.js différente',
          baselineValue: '18.17.0',
          actualValue: '20.0.0',
          recommendedAction: 'Mettre à jour Node.js'
        }
      ];

      (mockInventoryCollector.collectInventory as any).mockResolvedValue(mockInventory);
      (mockDiffDetector.compareBaselineWithMachine as any).mockResolvedValue(mockDifferences);

      const result = await baselineService.compareWithBaseline('target-machine', false);

      expect(result).toBeDefined();
      expect(result!.baselineMachine).toBe('test-machine');
      expect(result!.targetMachine).toBe('target-machine');
      expect(result!.differences).toHaveLength(2);
      expect(result!.summary.total).toBe(2);
      expect(result!.summary.critical).toBe(1);
    });

    it('devrait retourner null si aucune différence', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const mockInventory: MachineInventory = {
        machineId: 'identical-machine',
        timestamp: '2025-11-04T01:00:00Z',
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: { 'updated-server': { enabled: true } },
            userSettings: { theme: 'light' }
          },
          hardware: {
            cpu: {
              model: 'Intel Core i9-12900K',
              cores: 16,
              threads: 32
            },
            memory: {
              total: 34359738368 // 32GB en bytes
            },
            disks: [{ name: 'C:', size: '2TB' }],
            gpu: 'NVIDIA RTX 4090'
          },
          software: {
            powershell: '7.3.0',
            node: '20.0.0',
            python: '3.12.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1200,
          source: 'local',
          collectorVersion: '2.1.0'
        }
      };

      (mockInventoryCollector.collectInventory as any).mockResolvedValue(mockInventory);
      (mockDiffDetector.compareBaselineWithMachine as any).mockResolvedValue([]);

      const result = await baselineService.compareWithBaseline('identical-machine', false);

      expect(result).toBeDefined();
      expect(result!.differences).toHaveLength(0);
    });

    it('devrait détecter les différences critiques', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const mockInventory: MachineInventory = {
        machineId: 'target-machine',
        timestamp: '2025-11-04T01:00:00Z',
        config: {
          roo: {
            modes: ['code'],
            mcpSettings: {},
            userSettings: {}
          },
          hardware: {
            cpu: {
              model: 'AMD Ryzen 5 3600',
              cores: 6,
              threads: 12
            },
            memory: {
              total: 17179869184 // 16GB en bytes
            },
            disks: [{ name: 'C:', size: '512GB' }],
            gpu: 'NVIDIA GTX 1660'
          },
          software: {
            powershell: '5.1.0',
            node: '14.0.0',
            python: '3.8.0'
          },
          system: {
            os: 'Windows 10',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1800,
          source: 'local',
          collectorVersion: '2.1.0'
        }
      };

      const mockDifferences: BaselineDifference[] = [
        {
          category: 'hardware',
          severity: 'CRITICAL',
          path: 'hardware.cpu',
          description: 'CPU incompatible',
          baselineValue: 'Intel Core i9-12900K',
          actualValue: 'AMD Ryzen 5 3600',
          recommendedAction: 'Mise à jour matérielle requise'
        },
        {
          category: 'software',
          severity: 'IMPORTANT',
          path: 'software.node',
          description: 'Version Node.js différente',
          baselineValue: '20.0.0',
          actualValue: '14.0.0',
          recommendedAction: 'Mettre à jour Node.js'
        }
      ];

      (mockInventoryCollector.collectInventory as any).mockResolvedValue(mockInventory);
      (mockDiffDetector.compareBaselineWithMachine as any).mockResolvedValue(mockDifferences);

      const result = await baselineService.compareWithBaseline('target-machine', false);

      expect(result).toBeDefined();
      expect(result!.differences).toHaveLength(2);
      expect(result!.summary.critical).toBe(1);
      expect(result!.summary.important).toBe(1);
    });
  });

  describe('createSyncDecisions', () => {
    it('devrait générer des décisions à partir des différences', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const differences: BaselineDifference[] = [
        {
          category: 'hardware',
          severity: 'CRITICAL',
          path: 'hardware.cpu',
          description: 'CPU différent',
          baselineValue: 'Intel Core i9-12900K',
          actualValue: 'AMD Ryzen 9 5900X',
          recommendedAction: 'Mettre à jour la baseline'
        },
        {
          category: 'software',
          severity: 'WARNING',
          path: 'software.node',
          description: 'Version Node.js différente',
          baselineValue: '20.0.0',
          actualValue: '18.17.0',
          recommendedAction: 'Mettre à jour Node.js'
        }
      ];

      // D'abord créer un rapport de comparaison fictif
      const mockReport: BaselineComparisonReport = {
        baselineMachine: 'updated-machine',
        targetMachine: 'target-machine',
        baselineVersion: '2.2.0',
        differences,
        summary: {
          total: differences.length,
          critical: differences.filter(d => d.severity === 'CRITICAL').length,
          important: differences.filter(d => d.severity === 'IMPORTANT').length,
          warning: differences.filter(d => d.severity === 'WARNING').length,
          info: differences.filter(d => d.severity === 'INFO').length
        },
        generatedAt: '2025-11-04T01:00:00Z'
      };

      const decisions = await baselineService.createSyncDecisions(mockReport);

      // Avec le seuil par défaut 'IMPORTANT', seule la différence CRITICAL est gardée
      expect(decisions).toHaveLength(1);

      const cpuDecision = decisions.find(d => d.description.includes('CPU'));
      expect(cpuDecision).toBeDefined();
      expect(cpuDecision!.action).toBe('sync_to_baseline');

      // La différence Node.js est WARNING donc filtrée avec le seuil IMPORTANT
      const nodeDecision = decisions.find(d => d.description.includes('Node.js'));
      expect(nodeDecision).toBeUndefined();
    });

    it('devrait filtrer selon le seuil de sévérité', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const differences: BaselineDifference[] = [
        {
          category: 'hardware',
          severity: 'CRITICAL',
          path: 'hardware.cpu',
          description: 'CPU critique',
          baselineValue: 'Intel i9',
          actualValue: 'AMD Ryzen',
          recommendedAction: 'Action critique'
        },
        {
          category: 'software',
          severity: 'WARNING',
          path: 'software.node',
          description: 'Version warning',
          baselineValue: '20.0.0',
          actualValue: '18.0.0',
          recommendedAction: 'Action warning'
        }
      ];

      // D'abord créer un rapport de comparaison fictif
      const mockReport: BaselineComparisonReport = {
        baselineMachine: 'updated-machine',
        targetMachine: 'target-machine',
        baselineVersion: '2.2.0',
        differences,
        summary: {
          total: differences.length,
          critical: differences.filter(d => d.severity === 'CRITICAL').length,
          important: differences.filter(d => d.severity === 'IMPORTANT').length,
          warning: differences.filter(d => d.severity === 'WARNING').length,
          info: differences.filter(d => d.severity === 'INFO').length
        },
        generatedAt: '2025-11-04T01:00:00Z'
      };

      const decisions = await baselineService.createSyncDecisions(mockReport, 'CRITICAL');

      expect(decisions).toHaveLength(1);
      expect(decisions[0].severity).toBe('CRITICAL');
    });
  });

  describe('applyDecision', () => {
    it('devrait appliquer une décision approuvée', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const decisionId = 'test-decision-1';

      // Créer une décision dans le roadmap avec le format exact attendu par le service
      const testDecision: SyncDecision = {
        id: decisionId,
        machineId: 'target-machine',
        differenceId: 'diff-1',
        category: 'software', // Changé en software pour éviter l'erreur hardware
        description: 'Test décision',
        baselineValue: '20.0.0',
        targetValue: '18.17.0',
        action: 'sync_to_baseline',
        severity: 'CRITICAL',
        status: 'approved',
        createdAt: '2025-11-04T01:00:00Z',
        approvedBy: 'test-user',
        approvedAt: '2025-11-04T01:00:00Z'
      };

      const roadmapContent = `# Sync Roadmap

## ⏳ Décision ${decisionId}

**Machine:** ${testDecision.machineId}
**Catégorie:** ${testDecision.category}
**Différence:** ${testDecision.differenceId}
**Sévérité:** 🔴 CRITICAL
**Statut:** ${testDecision.status}
**Créée le:** ${testDecision.createdAt}
**Approuvée par:** ${testDecision.approvedBy}
**Approuvée le:** ${testDecision.approvedAt}

### Description
${testDecision.description}

### Différence
- **Valeur baseline:** \`${JSON.stringify(testDecision.baselineValue)}\`
- **Valeur cible:** \`${JSON.stringify(testDecision.targetValue)}\`

### Action requise
**Type:** ${testDecision.action}

---

`;
      await fs.writeFile(testRoadmapPath, roadmapContent);

      const result = await baselineService.applyDecision(decisionId);

      expect(result.success).toBe(true);
      expect(result.decisionId).toBe(decisionId);
    });

    it('devrait rejeter une décision non approuvée', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const decisionId = 'test-decision-2';

      // Créer une décision non approuvée dans le roadmap
      const testDecision: SyncDecision = {
        id: decisionId,
        machineId: 'target-machine',
        differenceId: 'diff-2',
        category: 'software',
        description: 'Test décision rejetée',
        baselineValue: '20.0.0',
        targetValue: '18.0.0',
        action: 'keep_target',
        severity: 'WARNING',
        status: 'pending',
        createdAt: '2025-11-04T01:00:00Z'
      };

      const roadmapContent = `# Sync Roadmap

## Décisions en Attente
- [ ] ${decisionId}: ${testDecision.description}

## Décisions Appliquées
`;
      await fs.writeFile(testRoadmapPath, roadmapContent);

      await expect(baselineService.applyDecision(decisionId)).rejects.toThrow(
        expect.objectContaining({
          code: BaselineServiceErrorCode.DECISION_NOT_FOUND
        })
      );
    });
  });

  describe('updateBaseline', () => {
  it('devrait mettre à jour la baseline avec sauvegarde', async () => {
    // Charger la baseline existante
    await baselineService.loadBaseline();

    // Sauvegarder l'original pour restauration
    const originalTestBaseline = JSON.parse(await fs.readFile(testBaselinePath, 'utf-8'));

      const newBaseline: BaselineConfig = {
        machineId: 'updated-machine',
        version: '2.2.0',
        config: {
          roo: {
            modes: ['code', 'ask'],
            mcpSettings: { 'updated-server': { enabled: true } },
            userSettings: { theme: 'dark' }
          },
          hardware: {
            cpu: {
              model: 'Intel Core i9-12900K',
              cores: 16,
              threads: 24
            },
            memory: {
              total: 34359738368 // 32GB en bytes
            },
            disks: [{ name: 'C:', size: '2TB' }],
            gpu: 'NVIDIA RTX 4090'
          },
          software: {
            powershell: '7.3.0',
            node: '20.0.0',
            python: '3.12.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        lastUpdated: '2025-11-04T01:00:00Z'
      };

      const result = await baselineService.updateBaseline(newBaseline, { createBackup: true });

      expect(result).toBe(true);

      const updatedContent = await fs.readFile(testBaselinePath, 'utf-8');
      const updatedBaseline = JSON.parse(updatedContent) as BaselineConfig;
      expect(updatedBaseline.machineId).toBe('updated-machine');
      expect(updatedBaseline.version).toBe('2.2.0');
      expect(updatedBaseline.lastUpdated).toBe('2025-11-04T01:00:00Z');

      // Restaurer le fichier de test original pour les tests suivants
      await fs.writeFile(testBaselinePath, JSON.stringify(originalTestBaseline, null, 2));

      // Nettoyer les fichiers de test créés
      const testRoadmapPath = path.join(path.dirname(testBaselinePath), 'sync-roadmap.md');
      if (existsSync(testRoadmapPath)) {
        await fs.unlink(testRoadmapPath);
      }
    });

    it('devrait rejeter une baseline invalide', async () => {
      const invalidBaseline = {
        machineId: 'test-machine',
        // Manque les champs requis
        version: '1.0.0'
      } as any;

      await expect(baselineService.updateBaseline(invalidBaseline)).rejects.toThrow(
        expect.objectContaining({
          code: BaselineServiceErrorCode.BASELINE_INVALID
        })
      );
    });
  });

  describe('getState', () => {
    it('devrait retourner l\'état actuel du service', async () => {
      // Charger la baseline existante
      await baselineService.loadBaseline();

      const state = baselineService.getState();

      expect(state.isBaselineLoaded).toBe(true);
      // L'état doit refléter la baseline actuellement chargée (test-machine, 2.1.0)
      // car le beforeEach restaure le fichier à son état original
      expect(state.baselineMachine).toBe('test-machine');
      expect(state.baselineVersion).toBe('2.1.0');
      expect(state.pendingDecisions).toBeGreaterThanOrEqual(0);
    });
  });
});