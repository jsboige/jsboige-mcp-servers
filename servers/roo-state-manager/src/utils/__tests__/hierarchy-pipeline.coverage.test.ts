/**
 * hierarchy-pipeline.coverage.test.ts - Coverage complement for hierarchy-pipeline.ts
 *
 * Source-grounded targets (pre-PR baseline file-scoped: L=90.75% / B=83.02% / F=100%):
 *
 * REACHABLE cold branches covered below:
 * - L102: subError catch arm (sub-task readFile throws inside for-loop)
 * - L107: dirError catch arm (findTaskFiles throws)
 * - L133: !task.content truthy arm (hasTaskTags: content is falsy: null/undefined/empty)
 * - L147: return false else-arm (hasTaskTags: content is neither string nor Array)
 * - L206: findTaskFiles catch arm (scanDirectory throws)
 * - L227: fileStat.isDirectory() else-arm (entry is neither file nor directory)
 * - L232: scanDirectory catch arm (readDirectory throws)
 * - L244: isTaskFile || chain last arm (filename matches NONE of ui_messages/task/conversation)
 *
 * UNREACHABLE branches documented via test.skip with source-grounded evidence per #1936:
 * - L256: readDirectory catch arm. The try block L253-255 unconditionally
 *   returns `['ui_messages.json', 'task_metadata.json']` — there is no I/O code
 *   in the try block (the function is documented as a stub simulating readdir
 *   for tests). The catch L256-258 can ONLY fire if the try block throws, which
 *   is impossible at source level (a `return [...]` cannot throw a synchronous
 *   error). To make L256 reachable without modifying source, we would need to
 *   hijack the return statement, which is not a coverage-test concern — the
 *   branch is structurally unreachable-defensive. Per no-deletion-without-proof,
 *   source stays + skip-with-evidence documented.
 *
 * Already-covered branches (no new tests needed):
 * - L34 (stat.isFile() false → []): covered by existing 'n est pas un fichier' test
 * - L43-48 (JSON.parse catch → []): covered by existing 'JSON invalide' test
 * - L51 (!Array.isArray() → []): covered by existing 'pas un tableau' test
 * - L62 (extractionResult.instructions || []): covered by existing 'null/empty' tests
 * - L119 (outer catch parentError): covered by existing 'readFile parent échoue' test
 * - L158 (subTasks.length > 0): covered by existing 'sous-tâches' + 'sans sous-tâches' tests
 * - L173 (!task.content): covered by existing 'content est null' test
 * - L184-189 (textItem branch): covered by existing content-array tests
 * - L193 ('Tâche sans titre' fallback): covered by existing 'sans balises' test
 *
 * Discipline:
 * - 0 source touched (add-only)
 * - Each test names its source line anchor (anti-churn #1936)
 * - Private methods accessed via `as any` cast to drive cold arms
 * - Source-level structural-unreachable branches documented via skip-with-evidence
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Reuse existing mock pattern (hoisted fs/promises mock)
const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readFile: (...args: any[]) => mockReadFile(...args)
}));

// Reuse existing mock pattern (MessageExtractionCoordinator)
const mockExtractFromMessages = vi.fn();

vi.mock('../message-extraction-coordinator.js', () => ({
  MessageExtractionCoordinator: vi.fn().mockImplementation(() => ({
    extractFromMessages: mockExtractFromMessages
  }))
}));

import { HierarchyPipeline } from '../hierarchy-pipeline.js';
import { MessageExtractionCoordinator } from '../message-extraction-coordinator.js';

describe('hierarchy-pipeline — coverage complement', () => {
  let pipeline: HierarchyPipeline;
  let mockCoordinator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCoordinator = { extractFromMessages: mockExtractFromMessages };
    pipeline = new HierarchyPipeline(mockCoordinator as MessageExtractionCoordinator);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ============================================================
  // SKIP-WITH-EVIDENCE: L256 readDirectory catch arm structurally unreachable
  // ============================================================

  describe('readDirectory — catch arm (L256) SKIP-WITH-EVIDENCE', () => {
    test.skip('L256: readDirectory catch arm is structurally unreachable-defensive', () => {
      // SKIP-WITH-EVIDENCE per anti-churn #1936:
      //
      // Source L251-259:
      //   private async readDirectory(directory: string): Promise<string[]> {
      //     try {
      //       return ['ui_messages.json', 'task_metadata.json'];  // L254-255
      //     } catch (error) {
      //       throw new GenericError(...);  // L257-258
      //     }
      //   }
      //
      // The try block contains ONLY a `return [...]` literal — no synchronous
      // operation that can throw, no I/O call. In JavaScript, an array literal
      // evaluation cannot throw under normal conditions (no Object.defineProperty
      // trap, no Proxy trap configured on Array.prototype here). The catch at
      // L256 can ONLY fire if:
      //   (a) `return [...]` somehow throws (impossible without explicit trap)
      //   (b) Source is modified to add real I/O inside the try
      //
      // Therefore L256 is GENUINELY UNREACHABLE for any input that does not
      // modify source. Per no-deletion-without-proof, source stays + the
      // defensive try/catch is preserved. If a future PR moves the stub I/O
      // into the try block, this test should be replaced with a real assertion
      // driving the catch arm (e.g. by making readdir throw).
      expect(true).toBe(true);
    });
  });

  // ============================================================
  // analyzeTaskHierarchy — sub-task readFile throws (L102)
  // ============================================================

  describe('analyzeTaskHierarchy — sub-task readFile throws (L102)', () => {
    test('should WARN and skip when sub-task readFile throws (L102 catch arm)', async () => {
      const parentTask = { content: '<task>Parent task</task>' };

      // Parent readFile succeeds
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));

      // stat succeeds for entries
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });

      // First sub-task readFile throws → L102 catch
      mockReadFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      // Second sub-task readFile succeeds but no task tags
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags here' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent_task.json');

      // Parent task preserved; failing sub-task skipped
      expect(result.parentTask).toEqual(parentTask);
      expect(result.subTasks).toHaveLength(0);
      // L103 console.warn was called
      expect(console.warn).toHaveBeenCalled();
    });

    test('should include a successful sub-task even when another throws (L102 continue semantics)', async () => {
      const parentTask = { content: '<task>Parent task</task>' };
      const goodSubTask = { content: '<task>Good sub task</task>' };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      // First sub-task throws (L102 catch)
      mockReadFile.mockRejectedValueOnce(new Error('EBUSY'));
      // Second sub-task succeeds
      mockReadFile.mockResolvedValueOnce(JSON.stringify(goodSubTask));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');
      expect(result.subTasks).toHaveLength(1);
      expect(result.subTasks[0].task).toEqual(goodSubTask);
    });
  });

  // ============================================================
  // analyzeTaskHierarchy — findTaskFiles throws (L107)
  // ============================================================

  describe('analyzeTaskHierarchy — findTaskFiles throws (L107)', () => {
    test('should WARN and return parent-only hierarchy when findTaskFiles throws (L107 catch)', async () => {
      const parentTask = { content: '<task>Parent task</task>' };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));

      // To trigger L107 catch, findTaskFiles itself must throw (not return []).
      // findTaskFiles has its own try/catch L201-209 that swallows errors silently,
      // so we override it directly to force a throw.
      const pAny = pipeline as any;
      const realFindTaskFiles = pAny.findTaskFiles;
      pAny.findTaskFiles = vi.fn().mockRejectedValue(new Error('findTaskFiles EACCES'));

      try {
        const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');

        // Parent preserved, subTasks empty, hierarchy built from parent only
        expect(result.parentTask).toEqual(parentTask);
        expect(result.subTasks).toEqual([]);
        expect(result.hierarchy).toContain('Tâche Parent');
        // L108 console.warn was called with dir context
        expect(console.warn).toHaveBeenCalled();
      } finally {
        pAny.findTaskFiles = realFindTaskFiles;
      }
    });
  });

  // ============================================================
  // hasTaskTags — content is falsy (L133) / neither string nor Array (L147)
  // ============================================================

  describe('hasTaskTags — content shape edge cases (L133, L147)', () => {
    test('should return false when content is null (L133 !task.content truthy)', () => {
      expect((pipeline as any).hasTaskTags({ content: null })).toBe(false);
    });

    test('should return false when content is empty string (L133 !task.content truthy)', () => {
      // !task.content is true for empty string (falsy)
      expect((pipeline as any).hasTaskTags({ content: '' })).toBe(false);
    });

    test('should return false when content key is absent (L133 !task.content truthy)', () => {
      expect((pipeline as any).hasTaskTags({})).toBe(false);
    });

    test('should return false when content is undefined (L133 !task.content truthy)', () => {
      expect((pipeline as any).hasTaskTags({ content: undefined })).toBe(false);
    });

    test('should return false when content is a number (L147 fallback else-arm)', () => {
      // typeof 'number' — not string, not Array → falls through to L149 return false
      expect((pipeline as any).hasTaskTags({ content: 42 })).toBe(false);
    });

    test('should return false when content is a boolean (L147 fallback else-arm)', () => {
      expect((pipeline as any).hasTaskTags({ content: true })).toBe(false);
    });

    test('should return false when content is a plain object (L147 fallback else-arm)', () => {
      // Object is not string, not Array.isArray → fallback false
      expect((pipeline as any).hasTaskTags({ content: { foo: 'bar' } })).toBe(false);
    });
  });

  // ============================================================
  // findTaskFiles — scanDirectory throws (L206)
  // ============================================================

  describe('findTaskFiles — scanDirectory throws (L206 catch)', () => {
    test('should return [] and warn when scanDirectory throws (L206 catch)', async () => {
      const pAny = pipeline as any;
      const realScan = pAny.scanDirectory;
      pAny.scanDirectory = vi.fn().mockRejectedValue(new Error('scan IO error'));

      try {
        const result = await pAny.findTaskFiles('/some/dir');
        expect(result).toEqual([]);
        // L207 console.error called
        expect(console.error).toHaveBeenCalled();
      } finally {
        pAny.scanDirectory = realScan;
      }
    });
  });

  // ============================================================
  // scanDirectory — entry shape edge cases (L227 else arm)
  // ============================================================

  describe('scanDirectory — entry is neither file nor directory (L227 else arm)', () => {
    test('should skip entries where stat says neither isFile nor isDirectory (L227 else)', async () => {
      const pAny = pipeline as any;

      // readDirectory returns a single entry
      pAny.readDirectory = vi.fn().mockResolvedValue(['special-entry']);

      // stat reports NEITHER isFile() NOR isDirectory() (broken symlink, deleted entry)
      mockStat.mockResolvedValue({
        isFile: () => false,
        isDirectory: () => false,
      });

      // We mock isTaskFile to return true so the entry would otherwise be considered.
      const realIsTaskFile = pAny.isTaskFile;
      pAny.isTaskFile = vi.fn().mockReturnValue(true);

      try {
        const result = await pAny.scanDirectory('/some/dir');
        // Entry was skipped via L227 else (L228-229 recursive path not taken) → []
        expect(result).toEqual([]);
        expect(mockStat).toHaveBeenCalled();
      } finally {
        pAny.isTaskFile = realIsTaskFile;
      }
    });

    test('should recurse when entry is a directory (L227 else-if true arm)', async () => {
      const pAny = pipeline as any;

      // readDirectory returns: ['subdir'] at top, [] inside subdir
      pAny.readDirectory = vi.fn().mockImplementation((dir: string) => {
        if (dir === '/some/dir') return Promise.resolve(['subdir']);
        if (dir.endsWith('subdir')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      // stat reports entry as a DIRECTORY
      mockStat.mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      });

      const result = await pAny.scanDirectory('/some/dir');
      // Recursion ran (subdir scanned, empty) → files = []
      expect(result).toEqual([]);
      expect(mockStat).toHaveBeenCalled();
    });
  });

  // ============================================================
  // scanDirectory — readDirectory throws inside try (L232 catch)
  // ============================================================

  describe('scanDirectory — readDirectory throws (L232 catch arm)', () => {
    test('should log error and return [] when readDirectory throws (L232 catch)', async () => {
      const pAny = pipeline as any;
      const realReadDirectory = pAny.readDirectory;
      pAny.readDirectory = vi.fn().mockRejectedValue(new Error('readdir EACCES'));

      try {
        const result = await pAny.scanDirectory('/some/dir');
        expect(result).toEqual([]);
        // L233 console.error called
        expect(console.error).toHaveBeenCalled();
      } finally {
        pAny.readDirectory = realReadDirectory;
      }
    });
  });

  // ============================================================
  // isTaskFile — filename pattern matching (L244 || chain arms)
  // ============================================================

  describe('isTaskFile — pattern matching (L244 || chain arms)', () => {
    test('should return false for filename matching NONE of the 3 patterns (L244 else arm)', () => {
      // filename includes neither ui_messages, task, nor conversation
      expect((pipeline as any).isTaskFile('settings.json')).toBe(false);
    });

    test('should return false for random.json (L244 else arm)', () => {
      expect((pipeline as any).isTaskFile('random.json')).toBe(false);
    });

    test('should return true when filename includes ui_messages (L244 first || arm)', () => {
      expect((pipeline as any).isTaskFile('ui_messages.json')).toBe(true);
    });

    test('should return true when filename includes "task" but not ui_messages (L244 second || arm)', () => {
      // 'task_metadata.json' contains 'task' but NOT 'ui_messages' or 'conversation'
      expect((pipeline as any).isTaskFile('task_metadata.json')).toBe(true);
    });

    test('should return true when filename includes "conversation" only (L244 third || arm)', () => {
      // 'conversation_log.json' — contains 'conversation' but NOT 'task' or 'ui_messages'
      expect((pipeline as any).isTaskFile('conversation_log.json')).toBe(true);
    });
  });
});
