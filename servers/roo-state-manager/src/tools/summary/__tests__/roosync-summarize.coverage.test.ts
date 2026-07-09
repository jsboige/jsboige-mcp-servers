/**
 * Coverage tests for handleRooSyncSummarize
 *
 * Cible les branches NON couvertes par roosync-summarize.test.ts (24 tests) et
 * tests/unit/tools/summary/roosync-summarize.test.ts (17 tests) = 41 tests.
 *
 * **Gap fresh measure (89.88% stmts / 82.92% branch, le plus gros de Lane C)** :
 *  - extractClaudeProjectName (L244 taskId sans prefix 'claude-', L248-250 sans '--')
 *  - createConversationGetter('claude') : L268 locations empty fallback,
 *    L270-279 loop + skeleton found/return + null→continue→return null
 *  - createChildTasksFinder('claude') : L299-327 (locations loop, analyzeConversation, filter)
 *  - L371 maxContentLength synthesis=5000 vs trace/cluster=2000
 *  - L412 catch externe non-Error → 'Erreur inconnue'
 *
 * **Commentaire** : les sub-handlers moqués avec mockResolvedValue n'invoquent
 * JAMAIS les closures createConversationGetter/createChildTasksFinder (elles sont
 * passées en arg mais ignorées). Ici on reconfigure les mocks avec mockImplementation
 * qui appellent réellement le getter/finder passé → exerce les branches internes.
 *
 * **SKIP (dead code, anti-busy-work #2083)** : L281-286 createConversationGetter('roo')
 * et L323-326 createChildTasksFinder('roo') — branches `throw 'Roo source requires
 * external cache injection'` JAMAIS appelées depuis handleRooSyncSummarize (le handler
 * utilise les getters injectés pour source=roo, n'appelle jamais les factories avec 'roo').
 *
 * Pattern C3 (Vein D, dispatch #2800) : 1 fichier = 1 PR.
 *
 * @module tools/summary/__tests__/roosync-summarize.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../generate-trace-summary.tool.js', () => ({
  handleGenerateTraceSummary: mockHandleGenerateTraceSummary,
}));

vi.mock('../generate-cluster-summary.tool.js', () => ({
  handleGenerateClusterSummary: mockHandleGenerateClusterSummary,
}));

vi.mock('../get-conversation-synthesis.tool.js', () => ({
  handleGetConversationSynthesis: mockHandleGetConversationSynthesis,
}));

// Mock ClaudeStorageDetector (resolu depuis __tests__/ → src/utils/ = 3 niveaux)
vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: mockDetectStorageLocations,
    analyzeConversation: mockAnalyzeConversation,
    listProjects: mockListProjects,
  },
}));

import { handleRooSyncSummarize } from '../roosync-summarize.tool.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Sub-handlers default : retournent un résumé simple (peu importe le getter)
  mockHandleGenerateTraceSummary.mockResolvedValue('# trace summary');
  mockHandleGenerateClusterSummary.mockResolvedValue('# cluster summary');
  mockHandleGetConversationSynthesis.mockResolvedValue('# synthesis summary');
  mockDetectStorageLocations.mockResolvedValue([]);
  mockAnalyzeConversation.mockResolvedValue(null);
  mockListProjects.mockResolvedValue([]);
});

describe('handleRooSyncSummarize — coverage branches Claude source', () => {

  // ============================================================
  // extractClaudeProjectName + createConversationGetter('claude')
  // ============================================================
  describe('source=claude getter (L268-280, extractClaudeProjectName L244/L248-250)', () => {

    test('sub-handler invoque le getter → skeleton trouvé et retourné (L276-277)', async () => {
      // Le mock trace APPELLE le getter passé → exerce createConversationGetter
      mockHandleGenerateTraceSummary.mockImplementation(
        async (_args: any, getter: any) => {
          const skel = await getter('claude-proj1--sess-uuid');
          return JSON.stringify({ got: !!skel });
        }
      );
      // Une location matchant le projectName extrait
      mockDetectStorageLocations.mockResolvedValue([
        { projectName: 'proj1', projectPath: '/c/proj1' },
      ]);
      mockAnalyzeConversation.mockResolvedValue({ taskId: 'claude-proj1--sess-uuid', metadata: {} });

      const result = await handleRooSyncSummarize({
        type: 'trace',
        taskId: 'claude-proj1--sess-uuid',
        source: 'claude',
      });

      const parsed = JSON.parse(result);
      expect(parsed.got).toBe(true);
      expect(mockAnalyzeConversation).toHaveBeenCalled();
    });

    test('getter : taskId sans prefix "claude-" (L244) + sans "--" (L248-250)', async () => {
      mockHandleGenerateTraceSummary.mockImplementation(
        async (_args: any, getter: any) => {
          const skel = await getter('bare-id-no-dash'); // sans 'claude-', sans '--'
          return JSON.stringify({ got: !!skel });
        }
      );
      // Pas de location matchante → fallback allLocations (vide ici) → return null
      mockDetectStorageLocations.mockResolvedValue([]);

      const result = await handleRooSyncSummarize({
        type: 'trace',
        taskId: 'bare-id-no-dash',
        source: 'claude',
      });

      // getter retourne null (aucune location), mais ne throw pas
      const parsed = JSON.parse(result);
      expect(parsed.got).toBe(false);
    });

    test('getter : locations vides → fallback allLocations (L268) puis return null', async () => {
      mockHandleGenerateTraceSummary.mockImplementation(
        async (_args: any, getter: any) => {
          const skel = await getter('claude-proj--uuid');
          return JSON.stringify({ got: !!skel });
        }
      );
      mockDetectStorageLocations.mockResolvedValue([]); // aucune location

      const result = await handleRooSyncSummarize({
        type: 'trace',
        taskId: 'claude-proj--uuid',
        source: 'claude',
      });

      const parsed = JSON.parse(result);
      expect(parsed.got).toBe(false);
    });

    test('getter : skeleton null sur location 1, trouvé sur location 2 (boucle L270-279)', async () => {
      mockHandleGenerateTraceSummary.mockImplementation(
        async (_args: any, getter: any) => {
          const skel = await getter('claude-proj--uuid');
          return JSON.stringify({ got: !!skel });
        }
      );
      // 2 locations matchant projectName='proj' → la boucle itère 2 fois
      mockDetectStorageLocations.mockResolvedValue([
        { projectName: 'proj', projectPath: '/c/proj1' },
        { projectName: 'proj', projectPath: '/c/proj2' },
      ]);
      // location 1 → null (continue), location 2 → skeleton (return)
      mockAnalyzeConversation.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ taskId: 'found', metadata: {} });

      const result = await handleRooSyncSummarize({
        type: 'trace',
        taskId: 'claude-proj--uuid',
        source: 'claude',
      });

      const parsed = JSON.parse(result);
      expect(parsed.got).toBe(true);
    });
  });

  // ============================================================
  // L371 maxContentLength synthesis=5000 vs trace=2000
  // ============================================================
  describe('maxContentLength (L371)', () => {

    test('type=synthesis source=claude → maxContentLength=5000 passé', async () => {
      let capturedMax: number | undefined;
      mockHandleGetConversationSynthesis.mockImplementation(
        async (_args: any, getter: any) => {
          // Invoque le getter → déclenche analyzeConversation avec les options
          await getter('claude-proj--uuid');
          return 'synthesis';
        }
      );
      mockDetectStorageLocations.mockResolvedValue([
        { projectName: 'proj', projectPath: '/c/proj' },
      ]);
      mockAnalyzeConversation.mockImplementation(
        async (_id: string, _p: string, opts?: any) => {
          capturedMax = opts?.maxContentLength;
          return { taskId: 'x', metadata: { dataSource: 'claude' } };
        }
      );

      await handleRooSyncSummarize({
        type: 'synthesis',
        taskId: 'claude-proj--uuid',
        source: 'claude',
      });

      expect(capturedMax).toBe(5000); // L371 branche synthesis
    });

    test('type=trace source=claude → maxContentLength=2000 (branche else L371)', async () => {
      let capturedMax: number | undefined;
      mockHandleGenerateTraceSummary.mockImplementation(
        async (_args: any, getter: any) => { await getter('claude-proj--uuid'); return 'trace'; }
      );
      mockDetectStorageLocations.mockResolvedValue([
        { projectName: 'proj', projectPath: '/c/proj' },
      ]);
      mockAnalyzeConversation.mockImplementation(
        async (_id: string, _p: string, opts?: any) => {
          capturedMax = opts?.maxContentLength;
          return { taskId: 'x', metadata: { dataSource: 'claude' } };
        }
      );

      await handleRooSyncSummarize({
        type: 'trace',
        taskId: 'claude-proj--uuid',
        source: 'claude',
      });

      expect(capturedMax).toBe(2000); // L371 branche non-synthesis
    });
  });

  // ============================================================
  // createChildTasksFinder('claude') (L297-327)
  // ============================================================
  describe('createChildTasksFinder claude (L299-322)', () => {

    test('cluster source=claude → findChildTasks invoqué, boucle locations/projects', async () => {
      mockHandleGenerateClusterSummary.mockImplementation(
        async (_args: any, _getter: any, finder: any) => {
          const children = await finder('claude-root--uuid');
          return JSON.stringify({ count: children.length });
        }
      );
      mockDetectStorageLocations.mockResolvedValue([{ path: '/c/base' }]);
      mockListProjects.mockResolvedValue(['proj1']);
      // analyzeConversation('dummy', projectPath) → skeleton avec dataSource
      mockAnalyzeConversation.mockResolvedValue({ metadata: { dataSource: 'claude' } });

      const result = await handleRooSyncSummarize({
        type: 'cluster',
        taskId: 'claude-root--uuid',
        source: 'claude',
      });

      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(0); // allTasks vide (impl simplifiée)
      expect(mockListProjects).toHaveBeenCalledWith('/c/base');
    });

    test('cluster : analyzeConversation reject → catch interne (L316-318) swallowed', async () => {
      mockHandleGenerateClusterSummary.mockImplementation(
        async (_args: any, _getter: any, finder: any) => {
          const children = await finder('claude-root--uuid');
          return JSON.stringify({ count: children.length });
        }
      );
      mockDetectStorageLocations.mockResolvedValue([{ path: '/c/base' }]);
      mockListProjects.mockResolvedValue(['proj1']);
      // analyzeConversation rejette → catch interne avale l'erreur, allTasks vide
      mockAnalyzeConversation.mockRejectedValue(new Error('parse failed'));

      const result = await handleRooSyncSummarize({
        type: 'cluster',
        taskId: 'claude-root--uuid',
        source: 'claude',
      });

      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(0); // catch swallowed → pas de crash
    });
  });

  // ============================================================
  // L449-453 / L495-499 : outputFormat=json type-injection
  // ============================================================
  describe('outputFormat=json type-injection (L449-453, L495-499)', () => {

    test('trace + outputFormat=json → parsed.type="trace" injecté', async () => {
      mockHandleGenerateTraceSummary.mockResolvedValue(JSON.stringify({ summary: 'x' }));

      const result = await handleRooSyncSummarize(
        { type: 'trace', taskId: 'task-1', outputFormat: 'json' },
        vi.fn().mockResolvedValue(null) // source=roo (défaut) requiert getter injecté
      );

      const parsed = JSON.parse(result);
      expect(parsed.type).toBe('trace');
    });

    test('cluster + outputFormat=json → parsed.type="cluster" injecté', async () => {
      mockHandleGenerateClusterSummary.mockResolvedValue(JSON.stringify({ summary: 'y' }));

      const result = await handleRooSyncSummarize(
        { type: 'cluster', taskId: 'task-1', outputFormat: 'json' },
        vi.fn().mockResolvedValue(null),
        vi.fn().mockResolvedValue([])
      );

      const parsed = JSON.parse(result);
      expect(parsed.type).toBe('cluster');
    });
  });

  // ============================================================
  // L412 catch externe non-Error
  // ============================================================
  describe('catch externe non-Error (L412)', () => {

    test('sub-handler reject avec string brute → SUMMARIZE_FAILED + "Erreur inconnue"', async () => {
      // source=roo nécessite getConversationSkeleton injecté ; le throw vient du sub-handler
      mockHandleGenerateTraceSummary.mockRejectedValue('raw non-error' as never);

      await expect(
        handleRooSyncSummarize(
          { type: 'trace', taskId: 'task-1' },
          vi.fn().mockResolvedValue(null)
        )
      ).rejects.toThrow(/Erreur inconnue|SUMMARIZE_FAILED/i);
    });
  });
});
