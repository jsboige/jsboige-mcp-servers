/**
 * Tests unitaires pour handleGenerateTraceSummary
 *
 * Couvre :
 * - handleGenerateTraceSummary : taskId manquant → erreur (throw)
 * - handleGenerateTraceSummary : conversation introuvable → erreur (throw)
 * - handleGenerateTraceSummary : succès sans filePath
 * - handleGenerateTraceSummary : succès avec filePath (absolu)
 * - handleGenerateTraceSummary : succès avec filePath (relatif depuis workspace)
 * - handleGenerateTraceSummary : erreur generateSummary (throw)
 * - handleGenerateTraceSummary : options par défaut (Summary, markdown)
 * - handleGenerateTraceSummary : options personnalisées (detailLevel, truncation, etc.)
 * - generateTraceSummaryTool : définition du tool MCP
 *
 * Note : handleGenerateTraceSummary throws StateManagerError sur erreur
 *        (contrairement à handleGenerateClusterSummary qui retourne une string).
 *
 * @module tools/summary/__tests__/generate-trace-summary.test
 * @version 1.1.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const {
  mockGenerateSummary,
  MockTraceSummaryService,
  MockExportConfigManager,
  mockMkdir,
  mockWriteFile,
  mockAccess,
} = vi.hoisted(() => {
  const mockGenerateSummary = vi.fn();
  const MockTraceSummaryService = vi.fn().mockImplementation(() => ({
    generateSummary: mockGenerateSummary,
  }));
  const MockExportConfigManager = vi.fn().mockImplementation(() => ({}));
  const mockMkdir = vi.fn();
  const mockWriteFile = vi.fn();
  const mockAccess = vi.fn();
  return { mockGenerateSummary, MockTraceSummaryService, MockExportConfigManager, mockMkdir, mockWriteFile, mockAccess };
});

// Paths resolved from src/tools/summary/__tests__/ to src/services/
vi.mock('../../../services/TraceSummaryService.js', () => ({
  TraceSummaryService: MockTraceSummaryService,
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
  ExportConfigManager: MockExportConfigManager,
}));

vi.mock('fs/promises', () => ({
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  access: (...args: any[]) => mockAccess(...args),
  default: {
    mkdir: (...args: any[]) => mockMkdir(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    access: (...args: any[]) => mockAccess(...args),
  },
}));

import { handleGenerateTraceSummary, generateTraceSummaryTool } from '../generate-trace-summary.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId: 'task-001',
    metadata: {
      workspace: '/workspace/path',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    messages: [],
    ...overrides,
  } as ConversationSkeleton;
}

function makeSuccessResult(content = '# Summary content') {
  return {
    success: true,
    content,
    size: content.length,
    taskId: 'task-001',
    statistics: {
      totalSections: 3,
      userMessages: 2,
      assistantMessages: 2,
      toolResults: 1,
      totalContentSize: content.length,
      compressionRatio: 0.5,
    },
  };
}

// ─────────────────── setup ───────────────────

const mockGetConversationSkeleton = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  MockTraceSummaryService.mockImplementation(() => ({
    generateSummary: mockGenerateSummary,
  }));
  MockExportConfigManager.mockImplementation(() => ({}));
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockAccess.mockResolvedValue(undefined); // file exists
});

// ─────────────────── tests ───────────────────

describe('handleGenerateTraceSummary', () => {

  // ============================================================
  // Validation des arguments
  // ============================================================

  describe('validation des arguments', () => {
    test('taskId manquant → lève une erreur', async () => {
      await expect(
        handleGenerateTraceSummary({ taskId: '' }, mockGetConversationSkeleton)
      ).rejects.toThrow('taskId est requis');
    });

    test('conversation introuvable → lève une erreur', async () => {
      mockGetConversationSkeleton.mockResolvedValue(null);

      await expect(
        handleGenerateTraceSummary({ taskId: 'task-unknown' }, mockGetConversationSkeleton)
      ).rejects.toThrow('task-unknown');
    });
  });

  // ============================================================
  // Succès sans filePath
  // ============================================================

  describe('succès sans filePath', () => {
    test('retourne le contenu du résumé', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('# My Summary\n\nContent here'));

      const result = await handleGenerateTraceSummary(
        { taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('# My Summary');
      expect(result).toContain('Content here');
    });

    test('n\'appelle pas writeFile si pas de filePath', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('appelle generateSummary avec les options par défaut', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      const summaryCallArgs = mockGenerateSummary.mock.calls[0][1];
      expect(summaryCallArgs.detailLevel).toBe('Summary');
      expect(summaryCallArgs.outputFormat).toBe('markdown');
    });
  });

  // ============================================================
  // Options personnalisées
  // ============================================================

  describe('options personnalisées', () => {
    test('passe detailLevel à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001', detailLevel: 'Full' },
        mockGetConversationSkeleton
      );

      const summaryCallArgs = mockGenerateSummary.mock.calls[0][1];
      expect(summaryCallArgs.detailLevel).toBe('Full');
    });

    test('passe truncationChars à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001', truncationChars: 5000 },
        mockGetConversationSkeleton
      );

      const summaryCallArgs = mockGenerateSummary.mock.calls[0][1];
      expect(summaryCallArgs.truncationChars).toBe(5000);
    });

    test('passe startIndex et endIndex à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001', startIndex: 10, endIndex: 50 },
        mockGetConversationSkeleton
      );

      const summaryCallArgs = mockGenerateSummary.mock.calls[0][1];
      expect(summaryCallArgs.startIndex).toBe(10);
      expect(summaryCallArgs.endIndex).toBe(50);
    });

    test('outputFormat html est passé', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001', outputFormat: 'html' },
        mockGetConversationSkeleton
      );

      const summaryCallArgs = mockGenerateSummary.mock.calls[0][1];
      expect(summaryCallArgs.outputFormat).toBe('html');
    });
  });

  // ============================================================
  // Succès avec filePath
  // ============================================================

  describe('succès avec filePath', () => {
    test('appelle writeFile si filePath absolu fourni', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('Summary content'));

      await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: '/output/summary.md' },
        mockGetConversationSkeleton
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/output/summary.md', 'Summary content', 'utf8');
    });

    test('crée le répertoire si filePath absolu fourni', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: '/output/dir/summary.md' },
        mockGetConversationSkeleton
      );

      expect(mockMkdir).toHaveBeenCalledWith('/output/dir', { recursive: true });
    });

    test('filePath relatif avec workspace → résout depuis workspace', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation({
        metadata: { workspace: '/workspace/project', mode: 'code', timestamp: '2026-01-01' }
      } as any));
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('Content'));

      await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: 'output/summary.md' },
        mockGetConversationSkeleton
      );

      expect(mockWriteFile).toHaveBeenCalled();
      const writePath = mockWriteFile.mock.calls[0][0] as string;
      expect(writePath).toContain('workspace');
    });
  });

  // ============================================================
  // Erreur generateSummary
  // ============================================================

  describe('erreur generateSummary', () => {
    test('lève une erreur si success=false', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue({
        success: false,
        error: 'Service error',
        content: '',
        size: 0,
        taskId: 'task-001',
      });

      await expect(
        handleGenerateTraceSummary({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });

    test('lève une erreur si generateSummary lève une exception', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockRejectedValue(new Error('Unexpected crash'));

      await expect(
        handleGenerateTraceSummary({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // generateTraceSummaryTool - définition MCP
  // ============================================================

  describe('generateTraceSummaryTool', () => {
    test('name = "generate_trace_summary"', () => {
      expect(generateTraceSummaryTool.name).toBe('generate_trace_summary');
    });

    test('description est définie', () => {
      expect(typeof generateTraceSummaryTool.description).toBe('string');
      expect(generateTraceSummaryTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema est un objet', () => {
      expect(typeof generateTraceSummaryTool.inputSchema).toBe('object');
    });

    test('inputSchema.properties contient taskId', () => {
      const props = generateTraceSummaryTool.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('taskId');
    });
  });
});
