/**
 * TESTS UNITAIRES - TraceSummaryService (Méthodes principales)
 * Tests pour generateSummary et generateClusterSummary
 *
 * Note: Ces tests se concentrent sur les interfaces publiques et les comportements observables,
 * en mockant les dépendances externes (SummaryGenerator, ContentClassifier).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TraceSummaryService } from '../../../src/services/TraceSummaryService.js';
import { ConversationSkeleton, MessageSkeleton } from '../../../src/types/conversation.js';
import { ExportConfigManager } from '../../../src/services/ExportConfigManager.js';

describe('TraceSummaryService - Main Methods', () => {
  let service: TraceSummaryService;
  let mockExportConfigManager: ExportConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Créer un mock pour ExportConfigManager
    mockExportConfigManager = {
      getExportConfig: vi.fn().mockReturnValue({
        outputFormat: 'markdown',
        detailLevel: 'Summary',
      }),
    } as any;

    service = new TraceSummaryService(mockExportConfigManager);
  });

  describe('generateSummary - Interface and Error Handling', () => {
    it('should return a SummaryResult structure with all required fields', async () => {
      const mockConversation: ConversationSkeleton = {
        taskId: 'test-task-123',
        parentTaskId: null,
        metadata: {
          title: 'Test Task',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 10,
          actionCount: 5,
          totalSize: 2048,
        },
        sequence: [
          {
            role: 'user',
            content: 'Test user message',
            timestamp: '2024-01-01T09:00:00Z',
          } as MessageSkeleton,
          {
            role: 'assistant',
            content: 'Test assistant response',
            timestamp: '2024-01-01T09:01:00Z',
          } as MessageSkeleton,
        ],
      };

      const options = {
        detailLevel: 'Summary' as const,
        truncationChars: 1000,
        compactStats: true,
        includeCss: false,
        generateToc: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateSummary(mockConversation, options);

      // Contrat de succès (TraceSummaryService.ts:221-230) : success true,
      // contenu non vide, pas de champ erreur sur le chemin nominal.
      expect(result.success).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
      expect(result).toHaveProperty('statistics');
      expect(typeof result.content).toBe('string');
      expect(typeof result.statistics).toBe('object');
    });

    it('should handle invalid conversation gracefully', async () => {
      const invalidConversation = null as any;

      const options = {
        detailLevel: 'Summary' as const,
        truncationChars: 1000,
        compactStats: true,
        includeCss: false,
        generateToc: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateSummary(invalidConversation, options);

      // Contrat d'échec (TraceSummaryService.ts:133-138) : success false,
      // contenu vidé, statistics vides ET message d'erreur non vide.
      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(typeof result.error).toBe('string');
      expect(result.error!.length).toBeGreaterThan(0);
    });

    it('should accept different output formats', async () => {
      const mockConversation: ConversationSkeleton = {
        taskId: 'test-task-formats',
        parentTaskId: null,
        metadata: {
          title: 'Test Task Formats',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 1024,
        },
        sequence: [],
      };

      // Test JSON format
      const jsonOptions = {
        detailLevel: 'Full' as const,
        truncationChars: 1000,
        compactStats: false,
        includeCss: false,
        generateToc: false,
        outputFormat: 'json' as const,
        jsonVariant: 'light' as const,
      };

      const jsonResult = await service.generateSummary(mockConversation, jsonOptions);
      // Contrat JSON (TraceSummaryService.ts:221-230) : le contenu est du
      // JSON qui se parse et rend un objet non vide — pas une chaîne libre.
      expect(jsonResult.success).toBe(true);
      const parsedJson = JSON.parse(jsonResult.content) as Record<string, unknown>;
      expect(Object.keys(parsedJson).length).toBeGreaterThan(0);

      // Test CSV format
      const csvOptions = {
        ...jsonOptions,
        outputFormat: 'csv' as const,
        csvVariant: 'conversations' as const,
      };

      const csvResult = await service.generateSummary(mockConversation, csvOptions);
      // Contrat CSV variant conversations (TraceSummaryService.ts:426-430) :
      // en-tête à 9 colonnes connues + une ligne de données par conversation.
      expect(csvResult.success).toBe(true);
      const csvLines = csvResult.content.trim().split('\n');
      expect(csvLines[0]).toContain('taskId');
      expect(csvLines[0]).toContain('firstUserMessage');
      expect(csvLines).toHaveLength(2);
      expect(csvLines[1]).toContain('test-task-formats');
    });

    it('should degrade gracefully on malformed metadata (nominal result, no error)', async () => {
      // Conversation aux métadonnées malformées (taskId vide, dates invalides,
      // compteurs négatifs) : la génération ne lève PAS — TraceSummaryService
      // ne valide que la présence de la conversation (catch : TraceSummaryService.ts:133-138,
      // uniquement sur null/undefined). Le markdown est rendu avec des valeurs
      // dégradées. Contrat mesuré par sonde (2026-10-03) : succès nominal.
      const problematicConversation: ConversationSkeleton = {
        taskId: '',
        parentTaskId: null,
        metadata: {
          title: '',
          lastActivity: 'invalid-date',
          createdAt: 'invalid-date',
          messageCount: -1,
          actionCount: -1,
          totalSize: -1,
        },
        sequence: [],
      };

      const options = {
        detailLevel: 'Full' as const,
        truncationChars: 1000,
        compactStats: false,
        includeCss: false,
        generateToc: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateSummary(problematicConversation, options);

      // Dégradation gracieuse : contenu rendu, pas de champ erreur. Le contrat
      // d'échec (success:false + error) est couvert par le test null-input.
      expect(result.success).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('generateClusterSummary - Interface and Validation', () => {
    it('should return a ClusterSummaryResult structure with all required fields', async () => {
      const rootTask: ConversationSkeleton = {
        taskId: 'root-task',
        parentTaskId: null,
        metadata: {
          title: 'Root Task',
          lastActivity: '2024-01-01T12:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 10,
          actionCount: 5,
          totalSize: 2048,
        },
        sequence: [],
      };

      const childTask1: ConversationSkeleton = {
        taskId: 'child-task-1',
        parentTaskId: 'root-task',
        metadata: {
          title: 'Child Task 1',
          lastActivity: '2024-01-01T11:00:00Z',
          createdAt: '2024-01-01T10:00:00Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 1024,
        },
        sequence: [],
      };

      const options = {
        sortBy: 'chronology' as const,
        includeTimeline: true,
        includeTableOfContents: true,
        includeComparativeAnalysis: true,
        compactStats: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateClusterSummary(
        rootTask,
        [childTask1],
        options
      );

      // Vérifier que la structure du résultat est correcte
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('statistics');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.content).toBe('string');
      expect(typeof result.statistics).toBe('object');
    });

    it('should handle empty child tasks array', async () => {
      const rootTask: ConversationSkeleton = {
        taskId: 'root-task-no-children',
        parentTaskId: null,
        metadata: {
          title: 'Root Task No Children',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 1024,
        },
        sequence: [],
      };

      const options = {
        sortBy: 'chronology' as const,
        includeTimeline: false,
        includeTableOfContents: false,
        includeComparativeAnalysis: false,
        compactStats: true,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateClusterSummary(
        rootTask,
        [],
        options
      );

      // Contrat mesuré : children vide → succès nominal, la grappe se
      // réduit au root (totalTasks 1).
      expect(result.success).toBe(true);
      expect(result.statistics.totalTasks).toBe(1);
    });

    it('should handle invalid root task gracefully', async () => {
      const invalidRootTask: ConversationSkeleton = {
        taskId: '',
        parentTaskId: null,
        metadata: {
          title: '',
          lastActivity: '',
          createdAt: '',
          messageCount: -1,
          actionCount: -1,
          totalSize: -1,
        },
        sequence: [],
      };

      const options = {
        sortBy: 'chronology' as const,
        includeTimeline: false,
        includeTableOfContents: false,
        includeComparativeAnalysis: false,
        compactStats: true,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateClusterSummary(
        invalidRootTask,
        [],
        options
      );

      // Contrat d'échec mesuré (ClusterSummaryService.ts:89-95, sonde
      // 2026-10-03) : root sans taskId → success false, statistics vides
      // (totalTasks 0) ET message d'erreur nominatif.
      expect(result.success).toBe(false);
      expect(result.statistics.totalTasks).toBe(0);
      expect(result.error).toBe('Root task is required and must have a taskId');
    });

    it('should accept different sort options', { timeout: 30000 }, async () => {
      const rootTask: ConversationSkeleton = {
        taskId: 'root-task-sort',
        parentTaskId: null,
        metadata: {
          title: 'Root Task Sort',
          lastActivity: '2024-01-01T12:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 10,
          actionCount: 5,
          totalSize: 5000,
        },
        sequence: [],
      };

      const childTask: ConversationSkeleton = {
        taskId: 'child-task',
        parentTaskId: 'root-task-sort',
        metadata: {
          title: 'Child Task',
          lastActivity: '2024-01-01T11:00:00Z',
          createdAt: '2024-01-01T10:00:00Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 1024,
        },
        sequence: [],
      };

      // Test sortBy: 'size'
      const sizeOptions = {
        sortBy: 'size' as const,
        includeTimeline: false,
        includeTableOfContents: false,
        includeComparativeAnalysis: false,
        compactStats: true,
        outputFormat: 'markdown' as const,
      };

      const sizeResult = await service.generateClusterSummary(
        rootTask,
        [childTask],
        sizeOptions
      );

      // Contrat nominal mesuré : tri par taille sur root + enfant →
      // succès, les 2 tâches comptées.
      expect(sizeResult.success).toBe(true);
      expect(sizeResult.statistics.totalTasks).toBe(2);

      // Test sortBy: 'alphabetical'
      const alphaOptions = {
        ...sizeOptions,
        sortBy: 'alphabetical' as const,
      };

      const alphaResult = await service.generateClusterSummary(
        rootTask,
        [childTask],
        alphaOptions
      );

      expect(alphaResult.success).toBe(true);
      expect(alphaResult.statistics.totalTasks).toBe(2);
    });

    it('should include cluster statistics in result', async () => {
      const rootTask: ConversationSkeleton = {
        taskId: 'root-task-stats',
        parentTaskId: null,
        metadata: {
          title: 'Root Task Stats',
          lastActivity: '2024-01-01T12:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 15,
          actionCount: 7,
          totalSize: 3072,
        },
        sequence: [],
      };

      const childTask: ConversationSkeleton = {
        taskId: 'child-task-stats',
        parentTaskId: 'root-task-stats',
        metadata: {
          title: 'Child Task Stats',
          lastActivity: '2024-01-01T11:00:00Z',
          createdAt: '2024-01-01T10:00:00Z',
          messageCount: 8,
          actionCount: 3,
          totalSize: 1536,
        },
        sequence: [],
      };

      const options = {
        sortBy: 'chronology' as const,
        includeTimeline: true,
        includeTableOfContents: false,
        includeComparativeAnalysis: false,
        compactStats: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateClusterSummary(
        rootTask,
        [childTask],
        options
      );

      // Cluster statistics a des propriétés différentes de SummaryStatistics.
      // Contrat mesuré : root + 1 enfant → totalTasks 2.
      expect(result.statistics.totalTasks).toBe(2);
      expect(Object.keys(result.statistics).length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    it('should handle null input gracefully', async () => {
      const result = await service.generateSummary(null as any, {});

      expect(result.success).toBe(false);
      // Contrat d'échec (TraceSummaryService.ts:133-138) : message d'erreur
      // non vide, pas seulement présent.
      expect(typeof result.error).toBe('string');
      expect(result.error!.length).toBeGreaterThan(0);
    });

    it('should handle missing options parameter', async () => {
      const mockConversation: ConversationSkeleton = {
        taskId: 'test-task-no-options',
        parentTaskId: null,
        metadata: {
          title: 'Test Task',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 1024,
        },
        sequence: [],
      };

      // Ne pas passer d'options - devrait utiliser les défauts
      const result = await service.generateSummary(mockConversation);

      // Contrat mesuré : les défauts rendent le summary nominal.
      expect(result.success).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('should handle very large content sizes', async () => {
      const largeContent = 'x'.repeat(10000000); // 10 MB

      const mockConversation: ConversationSkeleton = {
        taskId: 'large-content-task',
        parentTaskId: null,
        metadata: {
          title: 'Large Content Task',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 10000000,
        },
        sequence: [
          {
            role: 'user',
            content: largeContent,
            timestamp: '2024-01-01T09:00:00Z',
          } as MessageSkeleton,
        ],
      };

      const options = {
        detailLevel: 'Summary' as const,
        truncationChars: 1000,
        compactStats: true,
        includeCss: false,
        generateToc: false,
        outputFormat: 'markdown' as const,
      };

      const result = await service.generateSummary(mockConversation, options);

      // Contrat de troncation mesuré : le summary d'un message de 10 MB
      // rend un contenu compact (~581 chars), jamais la charge entière.
      expect(result.success).toBe(true);
      expect(result.content.length).toBeLessThan(100_000);
    });
  });
});
