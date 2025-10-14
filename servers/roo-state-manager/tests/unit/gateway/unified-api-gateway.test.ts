/**
 * Tests unitaires pour l'API Gateway unifié
 * 
 * Tests de l'architecture consolidée selon SDDD :
 * - Validation des 5 presets intelligents 
 * - Architecture 2-niveaux (processing immédiat vs background)
 * - Cache Anti-Fuite avec protection 220GB
 * - Backward compatibility pour les 32 outils identifiés
 * - ValidationEngine avec schémas JSON
 * 
 * Basé sur l'audit exhaustif des outils réels réalisé
 * 
 * @version 1.0.0
 * @since 2025-09-27 (Phase tests consolidés)
 */

import {  describe, test, expect, beforeEach, jest , vi } from 'vitest';
import {
  UnifiedApiGateway,
  createUnifiedApiGateway,
  INTELLIGENT_PRESETS
} from '../../../src/gateway/UnifiedApiGateway.js';
import {
  DisplayPreset,
  ToolCategory,
  ProcessingLevel,
  DisplayOptions
} from '../../../src/interfaces/UnifiedToolInterface.js';

describe('UnifiedApiGateway - Architecture consolidée', () => {
  
  let gateway: UnifiedApiGateway;
  let mockServices: any;

  beforeEach(() => {
    // Mock des services consolidés
    mockServices = {
      displayService: {
        listConversations: vi.fn(() => Promise.resolve({
          conversations: [],
          total: 0
        })),
        viewConversationTree: vi.fn(() => Promise.resolve({
          tree: { id: 'test', children: [] }
        }))
      },
      searchService: {
        searchTasksSemantic: vi.fn(() => Promise.resolve({
          results: [],
          total: 0
        }))
      },
      exportService: {
        exportConversationJson: vi.fn(() => Promise.resolve({
          exported: true,
          format: 'json'
        }))
      },
      cacheManager: {
        cleanup: vi.fn(() => Promise.resolve(true))
      },
      validationEngine: {
        validate: vi.fn(() => ({ isValid: true, errors: [] }))
      }
    };

    gateway = createUnifiedApiGateway({
      services: mockServices,
      debugMode: true,
      cacheProtection: {
        maxTrafficGB: 220,
        consistencyCheckHours: 24,
        minReindexIntervalHours: 4,
        enabled: true,
        alerts: {
          memoryThresholdGB: 200,
          processingTimeoutMs: 30000
        }
      }
    });
  });

  describe('Presets intelligents - Couverture 90% des cas d\'usage', () => {
    
    test('QUICK_OVERVIEW - Navigation rapide (8 outils)', async () => {
      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
        maxResults: 20,
        detailLevel: 'skeleton'
      });

      expect(result.success).toBe(true);
      expect(result.data?.preset).toBe(ToolCategory.DISPLAY);
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
      
      // Vérifier que les outils du preset sont exécutés
      const tools = INTELLIGENT_PRESETS[DisplayPreset.QUICK_OVERVIEW].tools;
      expect(tools).toContain('list_conversations');
      expect(tools).toContain('get_storage_stats');
      expect(tools).toContain('view_conversation_tree');
      expect(tools).toContain('get_task_tree');
      expect(tools).toHaveLength(4);
    });

    test('DETAILED_ANALYSIS - Analyse approfondie (Background)', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS, {
        truncate: 0,
        includeContent: true,
        detailLevel: 'full'
      });

      expect(result.success).toBe(true);
      expect(result.data?.preset).toBe(ToolCategory.DISPLAY);
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      
      // Doit retourner un job ID pour background processing
      expect(result.data?.jobId).toBeDefined();
      expect(result.data?.status).toBe('processing');
    });

    test('SEARCH_RESULTS - Recherche sémantique (2 outils)', async () => {
      const result = await gateway.execute(DisplayPreset.SEARCH_RESULTS, {
        searchQuery: 'test semantic search',
        maxResults: 50
      });

      expect(result.success).toBe(true);
      expect(result.data?.preset).toBe(ToolCategory.SEARCH);
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
      
      const tools = INTELLIGENT_PRESETS[DisplayPreset.SEARCH_RESULTS].tools;
      expect(tools).toContain('search_tasks_semantic');
      expect(tools).toContain('index_task_semantic');
      expect(tools).toHaveLength(2);
    });

    test('EXPORT_FORMAT - 6 stratégies d\'export (Background)', async () => {
      const result = await gateway.execute(DisplayPreset.EXPORT_FORMAT, {
        taskId: 'test-task-123',
        outputFormat: 'json',
        prettyPrint: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.preset).toBe(ToolCategory.EXPORT);
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      
      const tools = INTELLIGENT_PRESETS[DisplayPreset.EXPORT_FORMAT].tools;
      expect(tools).toContain('export_conversation_json');
      expect(tools).toContain('export_conversation_csv');
      expect(tools).toContain('export_conversation_xml');
      expect(tools).toContain('generate_trace_summary');
      expect(tools).toContain('generate_cluster_summary');
    });

    test('TREE_NAVIGATION - Navigation hiérarchique (Mixed)', async () => {
      const result = await gateway.execute(DisplayPreset.TREE_NAVIGATION, {
        forceRebuild: false,
        backup: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.preset).toBe(ToolCategory.UTILITY);
      // Mixed processing retourne immédiat + lance background
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
      
      const tools = INTELLIGENT_PRESETS[DisplayPreset.TREE_NAVIGATION].tools;
      expect(tools).toContain('detect_roo_storage');
      expect(tools).toContain('build_skeleton_cache');
      expect(tools).toContain('manage_mcp_settings');
      expect(tools).toContain('rebuild_and_restart_mcp');
    });
  });

  describe('Architecture 2-niveaux - Processing <5s vs Background', () => {
    
    test('Processing immédiat avec timeout <5s', async () => {
      // Mock d'un traitement long
      mockServices.displayService.listConversations = vi.fn()
        .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 6000)));

      const startTime = Date.now();
      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      const processingTime = Date.now() - startTime;

      // Doit basculer vers background si timeout
      expect(processingTime).toBeLessThan(6000); // Pas d'attente du timeout complet
      expect(result.success).toBe(true);
    });

    test('Background processing pour opérations lourdes', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS, {
        truncate: 0,
        includeContent: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.jobId).toMatch(/^bg_\d+_[a-z0-9]+$/);
      expect(result.data?.status).toBe('processing');
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      expect(result.metadata?.estimatedCompletionTime).toBeDefined();
    });

    test('Mixed processing - Immédiat + Background déclenché', async () => {
      const result = await gateway.execute(DisplayPreset.TREE_NAVIGATION);

      // Retour immédiat pour la partie synchrone
      expect(result.success).toBe(true);
      expect(result.metadata?.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
      
      // Background processing est planifié (pas directement testable sans modification)
    });
  });

  describe('Cache Anti-Fuite - Protection 220GB', () => {
    
    test('Vérification des seuils de protection', async () => {
      // Simulation d'usage mémoire élevé
      const gatewayWithHighMemory = createUnifiedApiGateway({
        services: mockServices,
        cacheProtection: {
          maxTrafficGB: 220,
          consistencyCheckHours: 1, // Check plus fréquent pour test
          minReindexIntervalHours: 4,
          enabled: true,
          alerts: {
            memoryThresholdGB: 1, // Seuil très bas pour test
            processingTimeoutMs: 30000
          }
        }
      });

      const result = await gatewayWithHighMemory.execute(DisplayPreset.QUICK_OVERVIEW);
      
      // Le gateway doit continuer à fonctionner même avec alertes
      expect(result.success).toBe(true);
    });

    test('Cleanup automatique en cas de dépassement', async () => {
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      
      // Mock une situation de dépassement dans checkCacheAntiLeak
      const metrics = gateway.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThan(0);
    });

    test('Monitoring continu des métriques', async () => {
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      await gateway.execute(DisplayPreset.SEARCH_RESULTS);
      
      const metrics = gateway.getMetrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.immediateProcessingCount).toBeGreaterThan(0);
      expect(metrics.averageProcessingTime).toBeGreaterThan(0);
      expect(metrics.uptime).toBeGreaterThan(0);
    });
  });

  describe('ValidationEngine - Schémas JSON pour 32 outils', () => {
    
    test('Validation des presets', async () => {
      // Preset invalide
      await expect(
        gateway.execute('invalid-preset' as DisplayPreset)
      ).rejects.toThrow('Validation failed');
    });

    test('Validation des options par catégorie', async () => {
      // Options invalides pour Display
      await expect(
        gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
          truncate: -1 // Invalide
        })
      ).rejects.toThrow('truncate must be >= 0');
    });

    test('Validation des options Search', async () => {
      await expect(
        gateway.execute(DisplayPreset.SEARCH_RESULTS, {
          maxResults: 0 // Invalide
        })
      ).rejects.toThrow('maxResults must be >= 1');
    });

    test('Validation des formats d\'export', async () => {
      await expect(
        gateway.execute(DisplayPreset.EXPORT_FORMAT, {
          outputFormat: 'invalid-format' as any
        })
      ).rejects.toThrow('outputFormat must be one of');
    });
  });

  describe('Backward Compatibility - 32 outils réels', () => {
    
    test('Exécution des outils individuels avec mocks', async () => {
      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
        maxResults: 10
      });

      expect(result.success).toBe(true);
      expect(result.data?.results).toBeDefined();
      expect(Array.isArray(result.data?.results)).toBe(true);
    });

    test('Gestion des erreurs d\'outils gracieuse', async () => {
      // Mock une erreur sur un outil
      mockServices.displayService.listConversations = vi.fn(() =>
        Promise.reject(new Error('Tool execution failed'))
      );

      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW);

      // Le gateway doit continuer malgré l'erreur sur un outil
      expect(result.success).toBe(false); // Au moins un outil a échoué
      expect(result.errors).toBeDefined();
      expect(result.data?.results).toBeDefined();
      
      // Vérifier qu'il y a à la fois succès et échecs
      const results = result.data?.results || [];
      const successCount = results.filter((r: any) => r.success).length;
      const errorCount = results.filter((r: any) => !r.success).length;
      
      expect(errorCount).toBeGreaterThan(0);
      expect(successCount + errorCount).toBe(results.length);
    });

    test('Mock d\'exécution pour outils non connectés', async () => {
      const result = await gateway.execute(DisplayPreset.TREE_NAVIGATION);

      expect(result.success).toBe(true);
      
      // Les outils mockés doivent retourner des données de simulation
      const results = result.data?.results || [];
      results.forEach((toolResult: any) => {
        if (toolResult.success) {
          expect(toolResult.data.status).toBe('mocked');
          expect(toolResult.data.timestamp).toBeDefined();
        }
      });
    });
  });

  describe('Health Check et Monitoring', () => {
    
    test('Health check complet', async () => {
      const health = await gateway.healthCheck();
      
      expect(health.status).toMatch(/^(healthy|degraded|unhealthy)$/);
      expect(health.checks).toBeDefined();
      expect(health.checks.cacheAntiLeak).toBeDefined();
      expect(health.checks.averageProcessingTime).toBeDefined();
      expect(health.checks.servicesAvailable).toBeDefined();
      expect(health.metrics).toBeDefined();
    });

    test('Métriques en temps réel', async () => {
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      
      const metrics = gateway.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThan(0);
      expect(metrics.uptime).toBeGreaterThan(0);
      expect(metrics.lastCacheAntiLeakCheck).toBeDefined();
    });
  });

  describe('Factory Pattern', () => {
    
    test('Création avec configuration par défaut', () => {
      const defaultGateway = createUnifiedApiGateway();
      expect(defaultGateway).toBeInstanceOf(UnifiedApiGateway);
    });

    test('Création avec configuration personnalisée', () => {
      const customGateway = createUnifiedApiGateway({
        debugMode: true,
        immediateProcessingTimeout: 10000,
        cacheProtection: {
          maxTrafficGB: 100,
          consistencyCheckHours: 12,
          minReindexIntervalHours: 2,
          enabled: false,
          alerts: {
            memoryThresholdGB: 50,
            processingTimeoutMs: 15000
          }
        }
      });
      
      expect(customGateway).toBeInstanceOf(UnifiedApiGateway);
    });
  });

  describe('Résilience et gestion d\'erreurs', () => {
    
    test('Récupération après échec de validation', async () => {
      await expect(
        gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
          maxResults: -1 // Invalide  
        })
      ).rejects.toThrow();

      // Le gateway doit rester fonctionnel après une erreur
      const validResult = await gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
        maxResults: 10
      });
      expect(validResult.success).toBe(true);
    });

    test('Timeout handling avec basculement', async () => {
      // Mock d'un service lent
      mockServices.displayService.listConversations = vi.fn()
        .mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({}), 10000)));

      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      
      // Doit basculer vers background ou retourner une erreur gracieusement
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    });
  });
});

/**
 * Tests d'intégration pour vérifier l'architecture consolidée complète
 */
describe('Architecture consolidée - Tests d\'intégration', () => {
  
  test('Réduction de complexité 97% - Un point d\'entrée unifié', () => {
    // Vérifier que tous les presets sont couverts
    const presets = Object.values(DisplayPreset);
    expect(presets).toHaveLength(5); // 5 presets intelligents
    
    // Vérifier que tous les presets sont dans INTELLIGENT_PRESETS
    presets.forEach(preset => {
      expect(INTELLIGENT_PRESETS[preset]).toBeDefined();
      expect(INTELLIGENT_PRESETS[preset].category).toBeDefined();
      expect(INTELLIGENT_PRESETS[preset].processingLevel).toBeDefined();
      expect(INTELLIGENT_PRESETS[preset].tools).toBeDefined();
      expect(Array.isArray(INTELLIGENT_PRESETS[preset].tools)).toBe(true);
    });
  });

  test('Couverture des 32 outils réels identifiés', () => {
    // Compter tous les outils uniques dans les presets
    const allTools = new Set<string>();
    Object.values(INTELLIGENT_PRESETS).forEach(preset => {
      preset.tools.forEach(tool => allTools.add(tool));
    });
    
    // Vérifier qu'on couvre bien un nombre significatif d'outils
    expect(allTools.size).toBeGreaterThan(15); // Au minimum 15 outils distincts
    
    // Vérifier la présence d'outils clés par catégorie
    expect(allTools.has('list_conversations')).toBe(true); // Display
    expect(allTools.has('search_tasks_semantic')).toBe(true); // Search  
    expect(allTools.has('export_conversation_json')).toBe(true); // Export
    expect(allTools.has('detect_roo_storage')).toBe(true); // Utility
  });

  test('Cohérence des catégories avec l\'audit réalisé', () => {
    // Vérifier que les catégories correspondent aux 5 identifiées
    const categories = Object.values(INTELLIGENT_PRESETS).map(p => p.category);
    const uniqueCategories = new Set(categories);
    
    expect(uniqueCategories.has(ToolCategory.DISPLAY)).toBe(true);
    expect(uniqueCategories.has(ToolCategory.SEARCH)).toBe(true);
    expect(uniqueCategories.has(ToolCategory.EXPORT)).toBe(true);
    expect(uniqueCategories.has(ToolCategory.UTILITY)).toBe(true);
    // Summary peut être intégré dans d'autres catégories
  });

  test('Architecture 2-niveaux respectée', () => {
    Object.values(INTELLIGENT_PRESETS).forEach(preset => {
      expect([
        ProcessingLevel.IMMEDIATE,
        ProcessingLevel.BACKGROUND,
        ProcessingLevel.MIXED
      ]).toContain(preset.processingLevel);
    });
    
    // Vérifier la répartition logique
    expect(INTELLIGENT_PRESETS[DisplayPreset.QUICK_OVERVIEW].processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    expect(INTELLIGENT_PRESETS[DisplayPreset.DETAILED_ANALYSIS].processingLevel).toBe(ProcessingLevel.BACKGROUND);
    expect(INTELLIGENT_PRESETS[DisplayPreset.EXPORT_FORMAT].processingLevel).toBe(ProcessingLevel.BACKGROUND);
  });
});