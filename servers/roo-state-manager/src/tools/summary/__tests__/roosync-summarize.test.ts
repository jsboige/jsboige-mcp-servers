/**
 * Tests unitaires pour handleRooSyncSummarize
 *
 * Couvre :
 * - handleRooSyncSummarize : type manquant → erreur
 * - handleRooSyncSummarize : taskId manquant → erreur
 * - handleRooSyncSummarize : source=roo sans getter → erreur
 * - handleRooSyncSummarize : dispatch type=trace → appelle handleGenerateTraceSummary
 * - handleRooSyncSummarize : dispatch type=cluster → appelle handleGenerateClusterSummary
 * - handleRooSyncSummarize : dispatch type=synthesis → appelle handleGetConversationSynthesis
 * - handleRooSyncSummarize : source=claude → utilise ClaudeStorageDetector
 * - handleRooSyncSummarize : passage des options aux handlers (filePath, clusterMode, etc.)
 * - roosyncSummarizeTool : définition du tool MCP
 *
 * Note : handleRooSyncSummarize throws StateManagerError sur erreur de validation.
 *        Les erreurs de dispatch sont re-throwées si StateManagerError, sinon wrappées.
 *
 * @module tools/summary/__tests__/roosync-summarize.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const {
  mockHandleGenerateTraceSummary,
  mockHandleGenerateClusterSummary,
  mockHandleGetConversationSynthesis,
  mockDetectStorageLocations,
  mockAnalyzeConversation,
  mockListProjects,
} = vi.hoisted(() => {
  const mockHandleGenerateTraceSummary = vi.fn();
  const mockHandleGenerateClusterSummary = vi.fn();
  const mockHandleGetConversationSynthesis = vi.fn();
  const mockDetectStorageLocations = vi.fn();
  const mockAnalyzeConversation = vi.fn();
  const mockListProjects = vi.fn();
  return {
    mockHandleGenerateTraceSummary,
    mockHandleGenerateClusterSummary,
    mockHandleGetConversationSynthesis,
    mockDetectStorageLocations,
    mockAnalyzeConversation,
    mockListProjects,
  };
});

// Mock the sub-handlers (resolved from __tests__/ → src/tools/summary/)
vi.mock('../generate-trace-summary.tool.js', () => ({
  handleGenerateTraceSummary: mockHandleGenerateTraceSummary,
}));

vi.mock('../generate-cluster-summary.tool.js', () => ({
  handleGenerateClusterSummary: mockHandleGenerateClusterSummary,
}));

vi.mock('../get-conversation-synthesis.tool.js', () => ({
  handleGetConversationSynthesis: mockHandleGetConversationSynthesis,
}));

// Mock ClaudeStorageDetector (resolved from __tests__/ → src/utils/)
vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: mockDetectStorageLocations,
    analyzeConversation: mockAnalyzeConversation,
    listProjects: mockListProjects,
  },
}));

// Mock RooStorageDetector (resolved from __tests__/ → src/utils/)
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn().mockResolvedValue([]),
  },
}));

import { handleRooSyncSummarize, roosyncSummarizeTool } from '../roosync-summarize.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(taskId = 'task-001'): ConversationSkeleton {
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

const mockGetConversationSkeleton = vi.fn();
const mockFindChildTasks = vi.fn();

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleGenerateTraceSummary.mockResolvedValue('# Trace Summary');
  mockHandleGenerateClusterSummary.mockResolvedValue('# Cluster Summary');
  mockHandleGetConversationSynthesis.mockResolvedValue('{"synthesis": "result"}');
  mockDetectStorageLocations.mockResolvedValue([]);
  mockAnalyzeConversation.mockResolvedValue(null);
  mockListProjects.mockResolvedValue([]);
  mockGetConversationSkeleton.mockResolvedValue(makeConversation());
  mockFindChildTasks.mockResolvedValue([]);
});

// ─────────────────── tests ───────────────────

describe('handleRooSyncSummarize', () => {

  // ============================================================
  // Validation des arguments
  // ============================================================

  describe('validation des arguments', () => {
    test('type manquant → lève une erreur', async () => {
      await expect(
        handleRooSyncSummarize(
          { type: '' as any, taskId: 'task-001' },
          mockGetConversationSkeleton
        )
      ).rejects.toThrow('type est requis');
    });

    test('taskId manquant → lève une erreur', async () => {
      await expect(
        handleRooSyncSummarize(
          { type: 'trace', taskId: '' },
          mockGetConversationSkeleton
        )
      ).rejects.toThrow('taskId est requis');
    });

    test('source=roo sans getConversationSkeleton → lève une erreur', async () => {
      await expect(
        handleRooSyncSummarize({ type: 'trace', taskId: 'task-001', source: 'roo' })
      ).rejects.toThrow('getConversationSkeleton est requis');
    });
  });

  // ============================================================
  // Dispatch type=trace
  // ============================================================

  describe('dispatch type=trace', () => {
    test('appelle handleGenerateTraceSummary', async () => {
      await handleRooSyncSummarize(
        { type: 'trace', taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(mockHandleGenerateTraceSummary).toHaveBeenCalledOnce();
    });

    test('retourne le résultat de handleGenerateTraceSummary', async () => {
      mockHandleGenerateTraceSummary.mockResolvedValue('# My Trace');

      const result = await handleRooSyncSummarize(
        { type: 'trace', taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(result).toBe('# My Trace');
    });

    test('passe le getter de conversation', async () => {
      await handleRooSyncSummarize(
        { type: 'trace', taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      const callArgs = mockHandleGenerateTraceSummary.mock.calls[0];
      expect(callArgs[1]).toBe(mockGetConversationSkeleton);
    });

    test('passe les options au handler trace', async () => {
      await handleRooSyncSummarize(
        {
          type: 'trace',
          taskId: 'task-001',
          detailLevel: 'Full',
          truncationChars: 5000,
          filePath: '/output/trace.md',
        },
        mockGetConversationSkeleton
      );

      const traceArgs = mockHandleGenerateTraceSummary.mock.calls[0][0];
      expect(traceArgs.taskId).toBe('task-001');
      expect(traceArgs.detailLevel).toBe('Full');
      expect(traceArgs.truncationChars).toBe(5000);
      expect(traceArgs.filePath).toBe('/output/trace.md');
    });
  });

  // ============================================================
  // Dispatch type=cluster
  // ============================================================

  describe('dispatch type=cluster', () => {
    test('appelle handleGenerateClusterSummary', async () => {
      await handleRooSyncSummarize(
        { type: 'cluster', taskId: 'root-task' },
        mockGetConversationSkeleton
      );

      expect(mockHandleGenerateClusterSummary).toHaveBeenCalledOnce();
    });

    test('retourne le résultat de handleGenerateClusterSummary', async () => {
      mockHandleGenerateClusterSummary.mockResolvedValue('# Cluster Result');

      const result = await handleRooSyncSummarize(
        { type: 'cluster', taskId: 'root-task' },
        mockGetConversationSkeleton
      );

      expect(result).toBe('# Cluster Result');
    });

    test('passe rootTaskId au handler cluster (depuis taskId)', async () => {
      await handleRooSyncSummarize(
        { type: 'cluster', taskId: 'my-root' },
        mockGetConversationSkeleton
      );

      const clusterArgs = mockHandleGenerateClusterSummary.mock.calls[0][0];
      expect(clusterArgs.rootTaskId).toBe('my-root');
    });

    test('passe les options spécifiques cluster', async () => {
      await handleRooSyncSummarize(
        {
          type: 'cluster',
          taskId: 'root-task',
          clusterMode: 'detailed',
          maxClusterDepth: 5,
          childTaskIds: ['child-1', 'child-2'],
        },
        mockGetConversationSkeleton,
        mockFindChildTasks
      );

      const clusterArgs = mockHandleGenerateClusterSummary.mock.calls[0][0];
      expect(clusterArgs.clusterMode).toBe('detailed');
      expect(clusterArgs.maxClusterDepth).toBe(5);
      expect(clusterArgs.childTaskIds).toEqual(['child-1', 'child-2']);
    });

    test('passe findChildTasks au handler cluster', async () => {
      await handleRooSyncSummarize(
        { type: 'cluster', taskId: 'root-task' },
        mockGetConversationSkeleton,
        mockFindChildTasks
      );

      const callArgs = mockHandleGenerateClusterSummary.mock.calls[0];
      expect(callArgs[2]).toBe(mockFindChildTasks);
    });
  });

  // ============================================================
  // Dispatch type=synthesis
  // ============================================================

  describe('dispatch type=synthesis — DISABLED due to stubs #767/#768', () => {
    test('throws SYNTHESIS_DISABLED error', async () => {
      await expect(
        handleRooSyncSummarize(
          { type: 'synthesis', taskId: 'task-001' },
          mockGetConversationSkeleton
        )
      ).rejects.toThrow('disabled');
    });

    test('does NOT call handleGetConversationSynthesis', async () => {
      try {
        await handleRooSyncSummarize(
          { type: 'synthesis', taskId: 'task-001' },
          mockGetConversationSkeleton
        );
      } catch { /* expected */ }

      expect(mockHandleGetConversationSynthesis).not.toHaveBeenCalled();
    });

    test('error mentions issue 767 and suggests alternatives', async () => {
      try {
        await handleRooSyncSummarize(
          { type: 'synthesis', taskId: 'task-001' },
          mockGetConversationSkeleton
        );
        expect.unreachable('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('767');
        expect(error.message).toContain('trace');
      }
    });
  });

  // ============================================================
  // Source=claude
  // ============================================================

  describe('source=claude', () => {
    test('n\'utilise pas le getter externe pour source=claude', async () => {
      // With source=claude, it uses ClaudeStorageDetector (mocked to return empty)
      // handleGenerateTraceSummary will be called with claude-derived getter
      await handleRooSyncSummarize({ type: 'trace', taskId: 'task-001', source: 'claude' });

      expect(mockHandleGenerateTraceSummary).toHaveBeenCalledOnce();
      // The getter passed should be a function (not the external one)
      const callArgs = mockHandleGenerateTraceSummary.mock.calls[0];
      expect(typeof callArgs[1]).toBe('function');
      // It should NOT be the mockGetConversationSkeleton we didn't pass
      expect(callArgs[1]).not.toBe(mockGetConversationSkeleton);
    });

    test('getter claude retourne null si aucun stockage trouvé', async () => {
      mockDetectStorageLocations.mockResolvedValue([]);

      await handleRooSyncSummarize({ type: 'trace', taskId: 'task-001', source: 'claude' });

      // The getter should be a claude-based getter
      const callArgs = mockHandleGenerateTraceSummary.mock.calls[0];
      const claudeGetter = callArgs[1] as (id: string) => Promise<any>;
      const result = await claudeGetter('some-task-id');
      expect(result).toBeNull();
    });
  });

  // ============================================================
  // Propagation d'erreurs
  // ============================================================

  describe('propagation d\'erreurs', () => {
    test('re-throw StateManagerError depuis le handler trace', async () => {
      const { StateManagerError } = await import('../../../types/errors.js');
      const error = new StateManagerError('Trace failed', 'TRACE_FAILED', 'test', {});
      mockHandleGenerateTraceSummary.mockRejectedValue(error);

      await expect(
        handleRooSyncSummarize({ type: 'trace', taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow('Trace failed');
    });

    test('wrap les erreurs non-StateManagerError', async () => {
      mockHandleGenerateTraceSummary.mockRejectedValue(new Error('Network error'));

      await expect(
        handleRooSyncSummarize({ type: 'trace', taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // roosyncSummarizeTool - définition MCP
  // ============================================================

  describe('roosyncSummarizeTool', () => {
    test('name = "roosync_summarize"', () => {
      expect(roosyncSummarizeTool.name).toBe('roosync_summarize');
    });

    test('description est définie', () => {
      expect(typeof roosyncSummarizeTool.description).toBe('string');
      expect(roosyncSummarizeTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema est un objet', () => {
      expect(typeof roosyncSummarizeTool.inputSchema).toBe('object');
    });

    test('inputSchema.required contient type et taskId', () => {
      const required = roosyncSummarizeTool.inputSchema.required as string[];
      expect(required).toContain('type');
      expect(required).toContain('taskId');
    });

    test('inputSchema.properties contient type avec enum', () => {
      const props = roosyncSummarizeTool.inputSchema.properties as Record<string, any>;
      expect(props.type.enum).toContain('trace');
      expect(props.type.enum).toContain('cluster');
      expect(props.type.enum).toContain('synthesis');
    });
  });
});
