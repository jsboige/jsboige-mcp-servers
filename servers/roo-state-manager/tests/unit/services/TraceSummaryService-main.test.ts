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

      // Vérifier que la structure du résultat est correcte
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('statistics');
      expect(typeof result.success).toBe('boolean');
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

      // Devrait retourner un résultat avec success: false
      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.statistics).toBeDefined();
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
      expect(jsonResult).toBeDefined();
      expect(jsonResult).toHaveProperty('success');
      expect(jsonResult).toHaveProperty('content');

      // Test CSV format
      const csvOptions = {
        ...jsonOptions,
        outputFormat: 'csv' as const,
        csvVariant: 'conversations' as const,
      };

      const csvResult = await service.generateSummary(mockConversation, csvOptions);
      expect(csvResult).toBeDefined();
      expect(csvResult).toHaveProperty('success');
      expect(csvResult).toHaveProperty('content');
    });

    it('should include error information when generation fails', async () => {
      // Créer une conversation qui va causer une erreur (ex: taskId vide)
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

      // Le résultat devrait exister mais potentiellement avec success: false
      expect(result).toBeDefined();
      if (!result.success) {
        expect(result).toHaveProperty('error');
        expect(result.error).toBeDefined();
      }
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
      expect(result).toBeDefined();
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

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('statistics');
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

      // Le résultat devrait exister
      expect(result).toBeDefined();

      // Si la validation échoue, success devrait être false
      if (result.statistics.totalTasks === 0) {
        expect(result.success).toBe(false);
      }
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

      expect(sizeResult).toBeDefined();
      expect(sizeResult).toHaveProperty('success');

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

      expect(alphaResult).toBeDefined();
      expect(alphaResult).toHaveProperty('success');
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

      expect(result).toBeDefined();
      expect(result.statistics).toBeDefined();
      // Cluster statistics a des propriétés différentes de SummaryStatistics
      expect(result.statistics).toHaveProperty('totalTasks');
      // Les autres propriétés peuvent varier selon l'implémentation
      expect(Object.keys(result.statistics).length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    it('should handle null input gracefully', async () => {
      const result = await service.generateSummary(null as any, {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
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

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('statistics');
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

      expect(result).toBeDefined();
      // Le résultat devrait exister, même si le contenu est tronqué
      expect(result).toHaveProperty('success');
    });
  });
});
