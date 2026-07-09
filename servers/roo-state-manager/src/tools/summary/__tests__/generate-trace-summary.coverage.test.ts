/**
 * Coverage tests for handleGenerateTraceSummary
 *
 * Cible les branches NON couvertes par generate-trace-summary.test.ts (18 tests).
 * Pattern C3 (Vein D, dispatch #2800) : 1 fichier = 1 PR.
 *
 * Lacunes ciblées (fresh measure, 94.3% stmts / 83.3% branch) :
 *  - L185-189 : filePath RELATIF + conversation SANS workspace → fallback CWD
 *    (le test existant couvre relatif+workspace et absolu, mais jamais relatif sans workspace)
 *  - L213     : `fileExists ? '✅ OUI' : '❌ NON'` → branche NON (fs.access fail)
 *  - L221     : `compressionRatio ? ... : ''` → branche '' (ratio absent)
 *  - L227-234 : file write error catch → FILE_WRITE_FAILED (fs.writeFile reject)
 *  - L244     : catch externe non-Error → `String(e)` (getConversationSkeleton reject non-Error)
 *
 * Réutilise le pattern mock hoisted du test existant (TraceSummaryService, ExportConfigManager, fs/promises).
 *
 * @module tools/summary/__tests__/generate-trace-summary.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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

import { handleGenerateTraceSummary } from '../generate-trace-summary.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

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

function makeSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    content: '# Summary',
    statistics: {
      totalSections: 1,
      userMessages: 2,
      assistantMessages: 3,
      toolResults: 4,
      totalContentSize: 2048,
      compressionRatio: 2.5,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() efface les mockImplementation → ré-établir (cf. test existant L106-109)
  MockTraceSummaryService.mockImplementation(() => ({
    generateSummary: mockGenerateSummary,
  }));
  MockExportConfigManager.mockImplementation(() => ({}));
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockAccess.mockResolvedValue(undefined); // file exists
  mockGenerateSummary.mockResolvedValue(makeSuccessResult());
});

describe('handleGenerateTraceSummary — coverage branches', () => {

  // ============================================================
  // L185-189 : filePath relatif + SANS workspace → fallback CWD
  // ============================================================
  describe('filePath relatif sans workspace (L185-189)', () => {

    test('conversation sans metadata.workspace → résolution fallback CWD', async () => {
      const conv = makeConversation({ metadata: { mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z' } as any });
      const getSkeleton = vi.fn().mockResolvedValue(conv);

      const result = await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: 'relative/output.md' },
        getSkeleton
      );

      expect(typeof result).toBe('string');
      // Le fichier a bien été écrit (writeFile appelé)
      expect(mockWriteFile).toHaveBeenCalled();
      // Le résultat mentionne le chemin résolu
      expect(result).toContain('Chemin absolu résolu');
    });

    test('conversation avec workspace vide (whitespace) → fallback CWD', async () => {
      const conv = makeConversation({ metadata: { workspace: '   ', mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z' } as any });
      const getSkeleton = vi.fn().mockResolvedValue(conv);

      const result = await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: 'out.md' },
        getSkeleton
      );

      expect(mockWriteFile).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  // ============================================================
  // L213 : fileExists '❌ NON' (fs.access fail après write)
  // ============================================================
  describe('fileExists branche NON (L213)', () => {

    test('fs.access rejette après écriture → "❌ NON"', async () => {
      const conv = makeConversation();
      const getSkeleton = vi.fn().mockResolvedValue(conv);
      mockAccess.mockRejectedValue(new Error('access denied'));

      const result = await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: '/abs/path/out.md' },
        getSkeleton
      );

      expect(result).toContain('❌ NON');
    });
  });

  // ============================================================
  // L221 : compressionRatio absent → ligne filtrée
  // ============================================================
  describe('compressionRatio absent (L221 branche "")', () => {

    test('statistics sans compressionRatio → ligne ratio omise', async () => {
      const conv = makeConversation();
      const getSkeleton = vi.fn().mockResolvedValue(conv);
      mockGenerateSummary.mockResolvedValue(makeSuccessResult({ statistics: {
        totalSections: 1, userMessages: 1, assistantMessages: 1, toolResults: 0, totalContentSize: 100,
        // compressionRatio absent
      } }));

      const result = await handleGenerateTraceSummary(
        { taskId: 'task-001', filePath: '/abs/path/out.md' },
        getSkeleton
      );

      // La ligne ratio ne doit pas apparaître (filtrée par .filter)
      expect(result).not.toContain('Ratio de compression');
    });
  });

  // ============================================================
  // L227-234 : file write error → FILE_WRITE_FAILED
  // ============================================================
  describe('file write error (L227-234)', () => {

    test('fs.writeFile rejette → StateManagerError FILE_WRITE_FAILED', async () => {
      const conv = makeConversation();
      const getSkeleton = vi.fn().mockResolvedValue(conv);
      mockWriteFile.mockRejectedValue(new Error('disk full'));

      await expect(
        handleGenerateTraceSummary(
          { taskId: 'task-001', filePath: '/abs/path/out.md' },
          getSkeleton
        )
      ).rejects.toThrow(/Erreur lors de l'écriture du fichier|FILE_WRITE_FAILED/i);
    });
  });

  // ============================================================
  // L244 : catch externe non-Error (getConversationSkeleton reject non-Error)
  // ============================================================
  describe('catch externe non-Error (L244)', () => {

    test('getConversationSkeleton rejette une valeur non-Error → "Erreur inconnue"', async () => {
      const getSkeleton = vi.fn().mockRejectedValue('raw failure string');

      await expect(
        handleGenerateTraceSummary(
          { taskId: 'task-001' },
          getSkeleton
        )
      ).rejects.toThrow(/Erreur inconnue|SUMMARY_FAILED/i);
    });
  });
});
