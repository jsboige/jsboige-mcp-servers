/**
 * Coverage complement for ZooTaskExtractor — #833 Sprint C3.
 *
 * Add-only, tests-only. Targets the cold error / fallback arms that the
 * nominal suite (zoo-task-extractor.test.ts) never enters:
 *  - readdir catch → continue                                  (L76-78)
 *  - per-task extractSingleTask throw → errors.push            (L84-89, err.message arm)
 *  - extractAll outer catch, non-Error throw → String(err)     (L94, String arm)
 *  - history_item empty task → `|| undefined`                  (L156)
 *  - history_item read failure → optional catch               (L157-159)
 *  - metadata numeric-field `|| 0` fallbacks                   (L172-174)
 *  - skeleton.truncatedInstruction > 500 → slice(0,500)+'...'  (L193-195)
 *  - skeleton enrichment throw → metadata-only fallback catch  (L206-208)
 *
 * Mock strategy is identical to the nominal suite: mock fs/promises,
 * ZooStorageDetector and RooStorageDetector; keep the real toUnifiedTask /
 * computeStorageTier (no unified-task.js mock).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockReaddir, mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

vi.mock('../../../utils/zoo-storage-detector.js', () => ({
  ZooStorageDetector: {
    detectStorageLocations: vi.fn(),
    getStatsForPath: vi.fn(),
    getStorageStats: vi.fn(),
    isZooCodePath: vi.fn(),
    validateCustomPath: vi.fn(),
  },
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    analyzeConversation: vi.fn(),
  },
}));

import { ZooTaskExtractor } from '../zoo-task-extractor.js';
import { ZooStorageDetector } from '../../../utils/zoo-storage-detector.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';

const mockZoo = vi.mocked(ZooStorageDetector);
const mockRoo = vi.mocked(RooStorageDetector);

const ZOO_LOCATION = 'C:/Users/test/AppData/Roaming/Code/User/globalStorage/zoocodeorganization.zoo-code';
const TASK_ID = '019d20bb-b7b7-721a-9306-7412f23e85aa';

const makeTaskMetadata = (overrides: Record<string, any> = {}) => ({
  messageCount: 42,
  dataSource: `${ZOO_LOCATION}/tasks/${TASK_ID}`,
  lastActivity: '2026-03-24T16:48:00.039Z',
  workspace: 'd:/Dev/roo-extensions',
  actionCount: 5,
  totalSize: 98252,
  createdAt: '2026-03-24T16:44:26.446Z',
  ...overrides,
});

const makeHistoryItem = (overrides: Record<string, any> = {}) => ({
  number: 1,
  task: 'Lis le fichier et corrige le bug',
  id: TASK_ID,
  ts: 1775689528719,
  ...overrides,
});

/** One task directory listed under the location's `tasks/` dir. */
const oneTaskDir = () =>
  mockReaddir.mockResolvedValue([{ name: TASK_ID, isDirectory: () => true } as any] as any);

describe('ZooTaskExtractor — coverage complement (#833)', () => {
  let extractor: ZooTaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new ZooTaskExtractor();
  });

  describe('extractAll — error & fallback arms', () => {
    test('swallows a readdir failure on a location and continues (L76-78)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await extractor.extractAll();

      // The `catch { continue }` skips the location silently — no task, no error.
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.source).toBe('zoo-code');
    });

    test('records a per-task failure in errors[] and keeps running (L84-89)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      // A non-string `workspace` is truthy, so `workspace.trim()` (L162) throws a
      // TypeError inside extractSingleTask → caught at extractAll's per-task catch.
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata({ workspace: 123 })))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      const result = await extractor.extractAll();

      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].taskId).toBe(TASK_ID);
      // err instanceof Error → err.message arm of L87.
      expect(result.errors[0].message).toMatch(/trim is not a function/i);
    });

    test('stringifies a non-Error top-level rejection (L94, String(err) arm)', async () => {
      // Reject with a bare string (not an Error) → `String(err)` arm of L94.
      mockZoo.detectStorageLocations.mockRejectedValue('detector exploded');

      const result = await extractor.extractAll();

      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Zoo extraction failed: detector exploded');
    });

    test('leaves title undefined when history_item.task is empty (L156)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem({ task: '' })));
      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll();

      // ''.substring(0,100) === '' → `'' || undefined` → undefined.
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBeUndefined();
    });

    test('treats a history_item read failure as optional and still extracts (L157-159)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata())) // task_metadata OK
        .mockRejectedValueOnce(new Error('ENOENT: history_item.json')); // history read fails
      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll();

      // history_item.json is optional — the catch swallows and extraction proceeds.
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(TASK_ID);
      expect(result.errors).toHaveLength(0);
    });

    test('defaults numeric metadata fields to 0 when absent (L172-174)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      // JSON.stringify drops undefined-valued keys → the fields are absent →
      // `metadata.<field> || 0` right-arm fires for all three.
      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify(makeTaskMetadata({ messageCount: undefined, actionCount: undefined, totalSize: undefined })),
        )
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));
      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll();

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].messageCount).toBe(0);
    });

    test('truncates a skeleton instruction longer than 500 chars (L193-195)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));
      const longInstruction = 'x'.repeat(600);
      mockRoo.analyzeConversation.mockResolvedValue({
        taskId: TASK_ID,
        metadata: { lastActivity: '2026-03-24T16:48:00.039Z' },
        truncatedInstruction: longInstruction,
      } as any);

      const result = await extractor.extractAll();

      // > 500 → slice(0,500) + '...'  →  length 503, trailing ellipsis.
      expect(result.tasks[0].instruction).toHaveLength(503);
      expect(result.tasks[0].instruction!.endsWith('...')).toBe(true);
    });

    test('falls back to metadata-only when skeleton enrichment throws (L206-208)', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      oneTaskDir();
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));
      mockRoo.analyzeConversation.mockRejectedValue(new Error('corrupted api_conversation_history'));

      const result = await extractor.extractAll();

      // The enrichment catch swallows — the metadata-only task is still returned.
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(TASK_ID);
      expect(result.tasks[0].source).toBe('zoo-code');
      expect(result.errors).toHaveLength(0);
    });
  });
});
