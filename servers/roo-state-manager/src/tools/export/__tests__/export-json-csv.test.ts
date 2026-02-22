/**
 * Tests unitaires pour handleExportConversationJson et handleExportConversationCsv
 *
 * Couvre :
 * - Validation : taskId manquant → throw StateManagerError
 * - Conversation introuvable → throw StateManagerError
 * - Succès sans filePath → retourne le contenu formaté
 * - Succès avec filePath → sauvegarde + confirmation
 * - Erreur service (success=false) → throw
 * - Erreur exception service → throw
 * - Options : jsonVariant, csvVariant, truncationChars, startIndex/endIndex
 * - Définitions MCP des tools
 *
 * @module tools/export/__tests__/export-json-csv.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const {
  mockGenerateSummary,
  MockTraceSummaryService,
  MockExportConfigManager,
  mockMkdir,
  mockWriteFile,
} = vi.hoisted(() => {
  const mockGenerateSummary = vi.fn();
  const MockTraceSummaryService = vi.fn().mockImplementation(() => ({
    generateSummary: mockGenerateSummary,
  }));
  const MockExportConfigManager = vi.fn().mockImplementation(() => ({}));
  const mockMkdir = vi.fn();
  const mockWriteFile = vi.fn();
  return { mockGenerateSummary, MockTraceSummaryService, MockExportConfigManager, mockMkdir, mockWriteFile };
});

vi.mock('../../../services/TraceSummaryService.js', () => ({
  TraceSummaryService: MockTraceSummaryService,
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
  ExportConfigManager: MockExportConfigManager,
}));

vi.mock('fs/promises', () => ({
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  default: {
    mkdir: (...args: any[]) => mockMkdir(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
  },
}));

import { handleExportConversationJson, exportConversationJsonTool } from '../export-conversation-json.js';
import { handleExportConversationCsv, exportConversationCsvTool } from '../export-conversation-csv.js';
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

function makeSuccessResult(content = '{"data": "value"}') {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// handleExportConversationJson
// ─────────────────────────────────────────────────────────────────────────────

describe('handleExportConversationJson', () => {

  // ============================================================
  // Validation
  // ============================================================

  describe('validation', () => {
    test('taskId manquant → lève une erreur', async () => {
      await expect(
        handleExportConversationJson({ taskId: '' }, mockGetConversationSkeleton)
      ).rejects.toThrow('taskId est requis');
    });

    test('conversation introuvable → lève une erreur avec taskId', async () => {
      mockGetConversationSkeleton.mockResolvedValue(null);

      await expect(
        handleExportConversationJson({ taskId: 'unknown-task' }, mockGetConversationSkeleton)
      ).rejects.toThrow('unknown-task');
    });
  });

  // ============================================================
  // Succès sans filePath
  // ============================================================

  describe('succès sans filePath', () => {
    test('retourne une confirmation avec statistiques', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      const result = await handleExportConversationJson(
        { taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('task-001');
      expect(result).toContain('JSON');
    });

    test('n\'appelle pas writeFile si pas de filePath', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson({ taskId: 'task-001' }, mockGetConversationSkeleton);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('utilise outputFormat=json par défaut', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson({ taskId: 'task-001' }, mockGetConversationSkeleton);

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.outputFormat).toBe('json');
    });

    test('utilise jsonVariant=light par défaut', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson({ taskId: 'task-001' }, mockGetConversationSkeleton);

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.jsonVariant).toBe('light');
    });

    test('passe jsonVariant=full quand spécifié', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson(
        { taskId: 'task-001', jsonVariant: 'full' },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.jsonVariant).toBe('full');
    });

    test('passe truncationChars à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson(
        { taskId: 'task-001', truncationChars: 2000 },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.truncationChars).toBe(2000);
    });

    test('passe startIndex et endIndex à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson(
        { taskId: 'task-001', startIndex: 5, endIndex: 20 },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.startIndex).toBe(5);
      expect(callArgs.endIndex).toBe(20);
    });
  });

  // ============================================================
  // Succès avec filePath
  // ============================================================

  describe('succès avec filePath', () => {
    test('appelle writeFile avec le contenu JSON', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('{"key": "val"}'));

      await handleExportConversationJson(
        { taskId: 'task-001', filePath: '/output/export.json' },
        mockGetConversationSkeleton
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/output/export.json', '{"key": "val"}', 'utf8');
    });

    test('crée le répertoire parent', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      await handleExportConversationJson(
        { taskId: 'task-001', filePath: '/output/dir/export.json' },
        mockGetConversationSkeleton
      );

      expect(mockMkdir).toHaveBeenCalledWith('/output/dir', { recursive: true });
    });

    test('retourne une confirmation de sauvegarde', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult());

      const result = await handleExportConversationJson(
        { taskId: 'task-001', filePath: '/output/export.json' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('/output/export.json');
    });
  });

  // ============================================================
  // Erreurs
  // ============================================================

  describe('erreurs generateSummary', () => {
    test('lève une erreur si success=false', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue({
        success: false,
        error: 'JSON service error',
        content: '',
        size: 0,
        taskId: 'task-001',
        statistics: { totalSections: 0, userMessages: 0, assistantMessages: 0, toolResults: 0, totalContentSize: 0 },
      });

      await expect(
        handleExportConversationJson({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });

    test('lève une erreur si generateSummary lève une exception', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockRejectedValue(new Error('Unexpected crash'));

      await expect(
        handleExportConversationJson({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // Définition MCP
  // ============================================================

  describe('exportConversationJsonTool', () => {
    test('name = "export_conversation_json"', () => {
      expect(exportConversationJsonTool.name).toBe('export_conversation_json');
    });

    test('description est définie', () => {
      expect(typeof exportConversationJsonTool.description).toBe('string');
      expect(exportConversationJsonTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema.required contient taskId', () => {
      expect(exportConversationJsonTool.inputSchema.required).toContain('taskId');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleExportConversationCsv
// ─────────────────────────────────────────────────────────────────────────────

describe('handleExportConversationCsv', () => {

  // ============================================================
  // Validation
  // ============================================================

  describe('validation', () => {
    test('taskId manquant → lève une erreur', async () => {
      await expect(
        handleExportConversationCsv({ taskId: '' }, mockGetConversationSkeleton)
      ).rejects.toThrow('taskId est requis');
    });

    test('conversation introuvable → lève une erreur avec taskId', async () => {
      mockGetConversationSkeleton.mockResolvedValue(null);

      await expect(
        handleExportConversationCsv({ taskId: 'unknown-csv' }, mockGetConversationSkeleton)
      ).rejects.toThrow('unknown-csv');
    });
  });

  // ============================================================
  // Succès sans filePath
  // ============================================================

  describe('succès sans filePath', () => {
    test('retourne une confirmation avec statistiques', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1,col2\nval1,val2'));

      const result = await handleExportConversationCsv(
        { taskId: 'task-001' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('task-001');
      expect(result).toContain('CSV');
    });

    test('n\'appelle pas writeFile si pas de filePath', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv({ taskId: 'task-001' }, mockGetConversationSkeleton);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('utilise outputFormat=csv par défaut', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv({ taskId: 'task-001' }, mockGetConversationSkeleton);

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.outputFormat).toBe('csv');
    });

    test('utilise csvVariant=conversations par défaut', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv({ taskId: 'task-001' }, mockGetConversationSkeleton);

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.csvVariant).toBe('conversations');
    });

    test('passe csvVariant=messages quand spécifié', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv(
        { taskId: 'task-001', csvVariant: 'messages' },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.csvVariant).toBe('messages');
    });

    test('passe csvVariant=tools quand spécifié', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv(
        { taskId: 'task-001', csvVariant: 'tools' },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.csvVariant).toBe('tools');
    });

    test('passe startIndex et endIndex à generateSummary', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv(
        { taskId: 'task-001', startIndex: 3, endIndex: 15 },
        mockGetConversationSkeleton
      );

      const callArgs = mockGenerateSummary.mock.calls[0][1];
      expect(callArgs.startIndex).toBe(3);
      expect(callArgs.endIndex).toBe(15);
    });
  });

  // ============================================================
  // Succès avec filePath
  // ============================================================

  describe('succès avec filePath', () => {
    test('appelle writeFile avec le contenu CSV', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1,col2\nrow1,row2'));

      await handleExportConversationCsv(
        { taskId: 'task-001', filePath: '/output/export.csv' },
        mockGetConversationSkeleton
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/output/export.csv', 'col1,col2\nrow1,row2', 'utf8');
    });

    test('crée le répertoire parent', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      await handleExportConversationCsv(
        { taskId: 'task-001', filePath: '/output/dir/export.csv' },
        mockGetConversationSkeleton
      );

      expect(mockMkdir).toHaveBeenCalledWith('/output/dir', { recursive: true });
    });

    test('retourne une confirmation de sauvegarde', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue(makeSuccessResult('col1\nval1'));

      const result = await handleExportConversationCsv(
        { taskId: 'task-001', filePath: '/output/export.csv' },
        mockGetConversationSkeleton
      );

      expect(result).toContain('/output/export.csv');
    });
  });

  // ============================================================
  // Erreurs
  // ============================================================

  describe('erreurs generateSummary', () => {
    test('lève une erreur si success=false', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockResolvedValue({
        success: false,
        error: 'CSV service error',
        content: '',
        size: 0,
        taskId: 'task-001',
        statistics: { totalSections: 0, userMessages: 0, assistantMessages: 0, toolResults: 0, totalContentSize: 0 },
      });

      await expect(
        handleExportConversationCsv({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });

    test('lève une erreur si generateSummary lève une exception', async () => {
      mockGetConversationSkeleton.mockResolvedValue(makeConversation());
      mockGenerateSummary.mockRejectedValue(new Error('CSV crash'));

      await expect(
        handleExportConversationCsv({ taskId: 'task-001' }, mockGetConversationSkeleton)
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // Définition MCP
  // ============================================================

  describe('exportConversationCsvTool', () => {
    test('name = "export_conversation_csv"', () => {
      expect(exportConversationCsvTool.name).toBe('export_conversation_csv');
    });

    test('description est définie', () => {
      expect(typeof exportConversationCsvTool.description).toBe('string');
      expect(exportConversationCsvTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema.required contient taskId', () => {
      expect(exportConversationCsvTool.inputSchema.required).toContain('taskId');
    });
  });
});
