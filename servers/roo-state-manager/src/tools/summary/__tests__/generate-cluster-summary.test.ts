/**
 * Tests unitaires pour handleGenerateClusterSummary
 *
 * Couvre :
 * - handleGenerateClusterSummary : rootTaskId manquant → erreur
 * - handleGenerateClusterSummary : tâche racine introuvable → erreur
 * - handleGenerateClusterSummary : succès avec childTaskIds explicites
 * - handleGenerateClusterSummary : succès avec findChildTasks auto-détection
 * - handleGenerateClusterSummary : succès sans enfants
 * - handleGenerateClusterSummary : erreur generateClusterSummary
 * - handleGenerateClusterSummary : options par défaut et personnalisées
 * - handleGenerateClusterSummary : tâche enfante introuvable (ignorée avec warning)
 * - generateClusterSummaryTool : définition du tool MCP
 *
 * @module tools/summary/__tests__/generate-cluster-summary.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const {
  mockGenerateClusterSummary,
  MockTraceSummaryService,
  MockExportConfigManager,
} = vi.hoisted(() => {
  const mockGenerateClusterSummary = vi.fn();
  const MockTraceSummaryService = vi.fn().mockImplementation(() => ({
    generateClusterSummary: mockGenerateClusterSummary,
  }));
  const MockExportConfigManager = vi.fn().mockImplementation(() => ({}));
  return { mockGenerateClusterSummary, MockTraceSummaryService, MockExportConfigManager };
});

// Paths resolved from src/tools/summary/__tests__/ to src/services/
vi.mock('../../../services/TraceSummaryService.js', () => ({
  TraceSummaryService: MockTraceSummaryService,
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
  ExportConfigManager: MockExportConfigManager,
}));

import { handleGenerateClusterSummary, generateClusterSummaryTool } from '../generate-cluster-summary.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(taskId: string): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      workspace: '/workspace',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    messages: [],
  } as ConversationSkeleton;
}

function makeClusterResult(content = '# Cluster Summary') {
  return {
    success: true,
    content,
    size: content.length,
    taskId: 'root-task',
    clusterMetadata: {
      totalTasks: 3,
      clusterMode: 'aggregated',
      rootTaskId: 'root-task',
    },
  };
}

// ─────────────────── setup ───────────────────

const mockGetConversationSkeleton = vi.fn();
const mockFindChildTasks = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  MockTraceSummaryService.mockImplementation(() => ({
    generateClusterSummary: mockGenerateClusterSummary,
  }));
  MockExportConfigManager.mockImplementation(() => ({}));
});

// ─────────────────── tests ───────────────────

describe('handleGenerateClusterSummary', () => {

  // ============================================================
  // Validation
  // ============================================================

  describe('validation', () => {
    test('rootTaskId manquant → retourne message d\'erreur', async () => {
      const result = await handleGenerateClusterSummary(
        { rootTaskId: '' },
        mockGetConversationSkeleton
      );
      expect(result).toContain('Erreur');
    });

    test('tâche racine introuvable → retourne message d\'erreur', async () => {
      mockGetConversationSkeleton.mockResolvedValue(null);

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'unknown-root' },
        mockGetConversationSkeleton
      );
      expect(result).toContain('Erreur');
      expect(result).toContain('unknown-root');
    });
  });

  // ============================================================
  // Succès avec childTaskIds explicites
  // ============================================================

  describe('succès avec childTaskIds explicites', () => {
    test('retourne le contenu du résumé de grappe', async () => {
      mockGetConversationSkeleton.mockImplementation((id: string) => {
        if (id === 'root') return Promise.resolve(makeConversation('root'));
        if (id === 'child-1') return Promise.resolve(makeConversation('child-1'));
        return Promise.resolve(null);
      });
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult('# Cluster Report\n\nClusters here'));

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'root', childTaskIds: ['child-1'] },
        mockGetConversationSkeleton
      );

      expect(result).toContain('# Cluster Report');
    });

    test('inclut les métadonnées dans le résultat', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'root', childTaskIds: [] },
        mockGetConversationSkeleton
      );

      expect(result).toContain('root');
    });

    test('tâche enfante introuvable → ignorée (pas d\'erreur)', async () => {
      mockGetConversationSkeleton.mockImplementation((id: string) => {
        if (id === 'root') return Promise.resolve(makeConversation('root'));
        return Promise.resolve(null); // child non trouvé
      });
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'root', childTaskIds: ['missing-child'] },
        mockGetConversationSkeleton
      );

      // Ne doit pas contenir d'erreur (tâche ignorée silencieusement)
      expect(result).not.toContain('missing-child');
    });
  });

  // ============================================================
  // Auto-détection via findChildTasks
  // ============================================================

  describe('auto-détection via findChildTasks', () => {
    test('appelle findChildTasks si pas de childTaskIds', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockFindChildTasks.mockResolvedValue([makeConversation('child-auto')]);
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton,
        mockFindChildTasks
      );

      expect(mockFindChildTasks).toHaveBeenCalledWith('root');
    });

    test('passe les enfants auto-détectés à generateClusterSummary', async () => {
      const childTask = makeConversation('child-auto');
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockFindChildTasks.mockResolvedValue([childTask]);
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton,
        mockFindChildTasks
      );

      const clusterCallArgs = mockGenerateClusterSummary.mock.calls[0];
      expect(clusterCallArgs[1]).toContainEqual(childTask);
    });
  });

  // ============================================================
  // Sans findChildTasks
  // ============================================================

  describe('sans findChildTasks', () => {
    test('passe tableau vide si pas de childTaskIds ni findChildTasks', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton
      );

      const clusterCallArgs = mockGenerateClusterSummary.mock.calls[0];
      expect(clusterCallArgs[1]).toEqual([]);
    });
  });

  // ============================================================
  // Options personnalisées
  // ============================================================

  describe('options personnalisées', () => {
    test('passe clusterMode à generateClusterSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root', clusterMode: 'detailed' },
        mockGetConversationSkeleton
      );

      const clusterOptions = mockGenerateClusterSummary.mock.calls[0][2];
      expect(clusterOptions.clusterMode).toBe('detailed');
    });

    test('passe maxClusterDepth à generateClusterSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root', maxClusterDepth: 5 },
        mockGetConversationSkeleton
      );

      const clusterOptions = mockGenerateClusterSummary.mock.calls[0][2];
      expect(clusterOptions.maxClusterDepth).toBe(5);
    });

    test('options par défaut : aggregated, Full, markdown', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue(makeClusterResult());

      await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton
      );

      const clusterOptions = mockGenerateClusterSummary.mock.calls[0][2];
      expect(clusterOptions.clusterMode).toBe('aggregated');
      expect(clusterOptions.detailLevel).toBe('Full');
      expect(clusterOptions.outputFormat).toBe('markdown');
    });
  });

  // ============================================================
  // Erreur generateClusterSummary
  // ============================================================

  describe('erreur generateClusterSummary', () => {
    test('retourne message d\'erreur si success=false', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockResolvedValue({
        success: false,
        error: 'Cluster failed',
        content: '',
        size: 0,
        taskId: 'root',
        clusterMetadata: { totalTasks: 0, clusterMode: 'aggregated', rootTaskId: 'root' },
      });

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('Erreur');
    });

    test('retourne message d\'erreur si generateClusterSummary lève une exception', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation('root'));
      mockGenerateClusterSummary.mockRejectedValue(new Error('Crash'));

      const result = await handleGenerateClusterSummary(
        { rootTaskId: 'root' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('Erreur');
    });
  });

  // ============================================================
  // generateClusterSummaryTool - définition MCP
  // ============================================================

  describe('generateClusterSummaryTool', () => {
    test('name = "generate_cluster_summary"', () => {
      expect(generateClusterSummaryTool.name).toBe('generate_cluster_summary');
    });

    test('description est définie', () => {
      expect(typeof generateClusterSummaryTool.description).toBe('string');
      expect(generateClusterSummaryTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema est un objet', () => {
      expect(typeof generateClusterSummaryTool.inputSchema).toBe('object');
    });

    test('inputSchema.properties contient rootTaskId', () => {
      const props = generateClusterSummaryTool.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('rootTaskId');
    });
  });
});
