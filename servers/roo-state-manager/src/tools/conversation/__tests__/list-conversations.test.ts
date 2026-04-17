/**
 * Tests unitaires pour listConversationsTool.handler
 *
 * Couvre :
 * - Cache vide → retourne tableau vide
 * - Filtrage par workspace (normalisé)
 * - Tri : lastActivity (desc par défaut), messageCount, totalSize
 * - Tri ascendant (sortOrder: 'asc')
 * - Limit : limite les résultats de premier niveau
 * - Structure hiérarchique (parent/enfant)
 * - Extraction du premier message utilisateur depuis sequence
 * - Détection isCompleted depuis sequence (attempt_completion)
 * - listConversationsTool : définition MCP
 *
 * Note : Les features pendingSubtaskOnly et contentPattern dépendent de
 *        l'accès au filesystem (api_conversation_history.json) et ne sont
 *        pas testées ici (comportement asynchrone avec fs.readFile).
 *
 * @module tools/conversation/__tests__/list-conversations.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ─────────────────── mocks ───────────────────

const { mockScanDiskForNewTasks } = vi.hoisted(() => ({
  mockScanDiskForNewTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDiskForNewTasks(...args),
}));

// Mock fs for loadApiMessages (contentPattern/pendingSubtaskOnly)
// loadApiMessages uses `import { promises as fs } from 'fs'` internally
const { mockFsReadFile } = vi.hoisted(() => ({
  mockFsReadFile: vi.fn().mockRejectedValue(new Error('Not mocked for this test')),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: { ...actual.promises, readFile: mockFsReadFile },
    },
    promises: { ...actual.promises, readFile: mockFsReadFile },
    existsSync: actual.existsSync,
  };
});

import { listConversationsTool } from '../list-conversations.tool.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(
  taskId: string,
  overrides: Partial<ConversationSkeleton> = {}
): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      workspace: '/workspace/default',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-15T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 10,
      actionCount: 5,
      totalSize: 1024,
    },
    messages: [],
    ...overrides,
  } as ConversationSkeleton;
}

function makeCache(...skeletons: ConversationSkeleton[]): Map<string, ConversationSkeleton> {
  return new Map(skeletons.map(s => [s.taskId, s]));
}

// ─────────────────── setup ───────────────────

let emptyCache: Map<string, ConversationSkeleton>;
let storageSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  emptyCache = new Map();
  mockScanDiskForNewTasks.mockResolvedValue([]);
  // vi.spyOn works where vi.mock fails for RooStorageDetector (#1123)
  // Root cause: SkeletonCacheService (transitive dep) also imports RooStorageDetector,
  // creating a module resolution path that vi.mock() doesn't intercept for loadApiMessages.
  storageSpy = vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue(['/mock/storage']);
});

// ─────────────────── tests ───────────────────

describe('listConversationsTool.handler', () => {

  // ============================================================
  // Cache vide
  // ============================================================

  describe('cache vide', () => {
    test('retourne tableau JSON vide', async () => {
      const result = await listConversationsTool.handler({}, emptyCache);
      const text = (result.content[0] as any).text;
      const _response = JSON.parse(text);
      const parsed = _response.conversations ?? _response;
      expect(parsed).toEqual([]);
    });

    test('contenu de type text', async () => {
      const result = await listConversationsTool.handler({}, emptyCache);
      expect(result.content[0].type).toBe('text');
    });
  });

  // ============================================================
  // Filtrage par workspace
  // ============================================================

  describe('filtrage par workspace', () => {
    test('retourne seulement les tâches du workspace demandé', async () => {
      const task1 = makeConversation('task-ws1', {
        metadata: {
          workspace: '/workspace/alpha',
          mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
          messageCount: 5, actionCount: 2, totalSize: 512,
        }
      } as any);
      const task2 = makeConversation('task-ws2', {
        metadata: {
          workspace: '/workspace/beta',
          mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
          messageCount: 5, actionCount: 2, totalSize: 512,
        }
      } as any);
      const cache = makeCache(task1, task2);

      const result = await listConversationsTool.handler({ workspace: '/workspace/alpha' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(1);
      expect(parsed[0].taskId).toBe('task-ws1');
    });

    test('retourne tableau vide si workspace ne correspond à aucune tâche', async () => {
      const cache = makeCache(makeConversation('task-1'));

      const result = await listConversationsTool.handler({ workspace: '/workspace/nonexistent' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed).toEqual([]);
    });

    test('normalise les slashes dans le workspace', async () => {
      const task = makeConversation('task-1', {
        metadata: {
          workspace: 'C:\\workspace\\project',
          mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
          messageCount: 5, actionCount: 2, totalSize: 512,
        }
      } as any);
      const cache = makeCache(task);

      // Filtre avec slashes normalisés (les deux doivent matcher)
      const result = await listConversationsTool.handler({ workspace: 'C:\\workspace\\project' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(1);
    });
  });

  // ============================================================
  // Tri
  // ============================================================

  describe('tri', () => {
    function makeTaskWithDate(taskId: string, lastActivity: string, messageCount = 5, totalSize = 512) {
      return makeConversation(taskId, {
        metadata: {
          workspace: '/workspace/default',
          mode: 'code-simple', timestamp: '2026-01-01T00:00:00.000Z',
          lastActivity, createdAt: '2026-01-01T00:00:00.000Z',
          messageCount, actionCount: 2, totalSize,
        }
      } as any);
    }

    test('tri par lastActivity desc par défaut (le plus récent en premier)', async () => {
      const old = makeTaskWithDate('old-task', '2026-01-01T00:00:00.000Z');
      const recent = makeTaskWithDate('recent-task', '2026-01-20T00:00:00.000Z');
      const cache = makeCache(old, recent);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('recent-task');
      expect(parsed[1].taskId).toBe('old-task');
    });

    test('tri par lastActivity asc', async () => {
      const old = makeTaskWithDate('old-task', '2026-01-01T00:00:00.000Z');
      const recent = makeTaskWithDate('recent-task', '2026-01-20T00:00:00.000Z');
      const cache = makeCache(recent, old);

      const result = await listConversationsTool.handler({ sortBy: 'lastActivity', sortOrder: 'asc' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('old-task');
      expect(parsed[1].taskId).toBe('recent-task');
    });

    test('tri par messageCount desc', async () => {
      const few = makeTaskWithDate('few-task', '2026-01-15T00:00:00.000Z', 3);
      const many = makeTaskWithDate('many-task', '2026-01-15T00:00:00.000Z', 50);
      const cache = makeCache(few, many);

      const result = await listConversationsTool.handler({ sortBy: 'messageCount' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('many-task');
      expect(parsed[1].taskId).toBe('few-task');
    });

    test('tri par totalSize desc', async () => {
      const small = makeTaskWithDate('small-task', '2026-01-15T00:00:00.000Z', 5, 512);
      const large = makeTaskWithDate('large-task', '2026-01-15T00:00:00.000Z', 5, 10240);
      const cache = makeCache(small, large);

      const result = await listConversationsTool.handler({ sortBy: 'totalSize' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('large-task');
      expect(parsed[1].taskId).toBe('small-task');
    });
  });

  // ============================================================
  // Limit
  // ============================================================

  describe('limit', () => {
    // #1245 round 2: per_page is clamped to [10, 100] — pages of 5 are useless,
    // pages above 100 should be opt-in file redirection. These tests exercise
    // values LARGER than the clamp floor.
    test('limite les résultats au nombre demandé (above floor=10)', async () => {
      // Create 20 tasks and ask for 12 → should return 12
      const tasks = Array.from({ length: 20 }, (_, i) => makeConversation(`task-${i + 1}`));
      const cache = makeCache(...tasks);

      const result = await listConversationsTool.handler({ limit: 12 }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(12);
    });

    test('limit < 10 is respected as hard cap (#1410: floor only applies to per_page)', async () => {
      // Create 15 tasks and ask for 3 → should return 3 (limit is hard cap, not page size)
      const tasks = Array.from({ length: 15 }, (_, i) => makeConversation(`task-${i + 1}`));
      const cache = makeCache(...tasks);

      const result = await listConversationsTool.handler({ limit: 3 }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(3);
    });

    test('sans limit → default 10 (page 1) — retourne au plus 10 tâches', async () => {
      // Create 3 tasks — fewer than the default page size, so all 3 fit on page 1
      const cache = makeCache(
        makeConversation('task-1'),
        makeConversation('task-2'),
        makeConversation('task-3'),
      );

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(3);
    });
  });

  // ============================================================
  // Structure hiérarchique
  // ============================================================

  describe('structure hiérarchique', () => {
    test('les tâches enfantes sont imbriquées dans children', async () => {
      const parent = makeConversation('parent-task');
      const child = makeConversation('child-task', { parentTaskId: 'parent-task' } as any);
      const cache = makeCache(parent, child);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // parent doit être au premier niveau
      const parentNode = parsed.find((n: any) => n.taskId === 'parent-task');
      expect(parentNode).toBeDefined();
      expect(parentNode.children).toBeDefined();
      expect(parentNode.children.length).toBe(1);
      expect(parentNode.children[0].taskId).toBe('child-task');
    });

    test('les tâches enfantes ne sont pas au premier niveau', async () => {
      const parent = makeConversation('parent-task');
      const child = makeConversation('child-task', { parentTaskId: 'parent-task' } as any);
      const cache = makeCache(parent, child);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // child ne doit pas être au premier niveau
      const childAtRoot = parsed.find((n: any) => n.taskId === 'child-task');
      expect(childAtRoot).toBeUndefined();
    });

    test('tâche sans parent est au premier niveau', async () => {
      const orphan = makeConversation('orphan-task');
      const cache = makeCache(orphan);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].taskId).toBe('orphan-task');
      // Empty children are omitted from compact output (no children key = no children)
      expect(parsed[0].children).toBeUndefined();
    });
  });

  // ============================================================
  // Extraction du premier message utilisateur
  // ============================================================

  describe('extraction du premier message utilisateur', () => {
    test('extrait le premier message utilisateur depuis sequence', async () => {
      const task = makeConversation('task-with-seq') as any;
      task.sequence = [
        { role: 'user', content: 'Initial user instruction' },
        { role: 'assistant', content: 'Response' },
      ];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].firstUserMessage).toBe('Initial user instruction');
    });

    test('tronque le premier message à 900 caractères', async () => {
      // #1245 round 2: truncation bumped 300 → 900 for richer first-message context.
      // The outer toConversationSummary also applies a 700-char cap; the deeper
      // 900-char cap applies inside the sequence extractor. We assert the visible
      // cap (what the summary actually emits).
      const longContent = 'x'.repeat(1200);
      const task = makeConversation('task-long') as any;
      task.sequence = [{ role: 'user', content: longContent }];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // toConversationSummary re-truncates to 700 chars (+ boundary slack + "...")
      expect(parsed[0].firstUserMessage.length).toBeLessThanOrEqual(710);
      expect(parsed[0].firstUserMessage).toContain('...');
    });

    test('firstUserMessage est undefined si pas de sequence', async () => {
      const task = makeConversation('task-no-seq');
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].firstUserMessage).toBeUndefined();
    });
  });

  // ============================================================
  // Détection isCompleted
  // ============================================================

  describe('détection isCompleted', () => {
    test('isCompleted=true si dernier message assistant contient attempt_completion', async () => {
      const task = makeConversation('task-completed') as any;
      task.sequence = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'attempt_completion',
              input: { result: 'Task completed successfully' }
            }
          ]
        },
      ];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].isCompleted).toBe(true);
    });

    test('isCompleted=false si pas de attempt_completion', async () => {
      const task = makeConversation('task-not-completed') as any;
      task.sequence = [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'Working on it...' },
      ];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // #1245 UX: isCompleted is omitted when false (only emitted when true).
      // Treat undefined as the absence of completion.
      expect(parsed[0].isCompleted ?? false).toBe(false);
    });

    test('completionMessage extrait du résultat de attempt_completion', async () => {
      const task = makeConversation('task-with-result') as any;
      task.sequence = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'attempt_completion',
              input: { result: 'Successfully completed the task with result X' }
            }
          ]
        },
      ];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed[0].completionMessage).toContain('Successfully');
    });
  });

  // ============================================================
  // Disk scan integration (regression: new tasks after MCP startup)
  // ============================================================

  describe('disk scan integration', () => {
    test('calls scanDiskForNewTasks before listing', async () => {
      const cache = makeCache(makeConversation('existing-task'));

      await listConversationsTool.handler({}, cache);

      expect(mockScanDiskForNewTasks).toHaveBeenCalledWith(cache);
    });

    test('integrates newly discovered tasks into results', async () => {
      const cache = makeCache(makeConversation('existing-task'));
      const newTask: ConversationSkeleton = {
        taskId: 'new-disk-task',
        metadata: {
          workspace: '/workspace/default',
          mode: 'code-simple',
          timestamp: '2026-03-05T01:00:00.000Z',
          lastActivity: '2026-03-05T01:00:00.000Z',
          createdAt: '2026-03-05T01:00:00.000Z',
          messageCount: 5,
          actionCount: 2,
          totalSize: 512,
        },
        messages: [],
      } as ConversationSkeleton;

      mockScanDiskForNewTasks.mockResolvedValue([newTask]);

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // Should contain both the existing and the newly discovered task
      const taskIds = parsed.map((t: any) => t.taskId);
      expect(taskIds).toContain('existing-task');
      expect(taskIds).toContain('new-disk-task');
    });

    test('new task is added to the cache map (side effect)', async () => {
      const cache = makeCache(makeConversation('existing-task'));
      const newTask: ConversationSkeleton = {
        taskId: 'side-effect-task',
        metadata: {
          workspace: '/workspace/default',
          mode: 'code-simple',
          timestamp: '2026-03-05T01:00:00.000Z',
          lastActivity: '2026-03-05T01:00:00.000Z',
          createdAt: '2026-03-05T01:00:00.000Z',
          messageCount: 3,
          actionCount: 1,
          totalSize: 256,
        },
        messages: [],
      } as ConversationSkeleton;

      mockScanDiskForNewTasks.mockResolvedValue([newTask]);

      await listConversationsTool.handler({}, cache);

      // The cache should now contain the new task
      expect(cache.has('side-effect-task')).toBe(true);
    });

    test('scan failure does not break listing', async () => {
      const cache = makeCache(makeConversation('safe-task'));
      mockScanDiskForNewTasks.mockRejectedValue(new Error('Disk scan failed'));

      const result = await listConversationsTool.handler({}, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // Should still return the cached task
      expect(parsed.length).toBe(1);
      expect(parsed[0].taskId).toBe('safe-task');
    });
  });

  // ============================================================
  // contentPattern filter (regression #567 S1 - was untested)
  // ============================================================

  describe('contentPattern filter', () => {
    // We need to mock fs/promises for loadApiMessages used by matchesContentPattern
    // The mock is set up via vi.mock at the top of this file's scope

    test('contentPattern filters tasks matching text in messages', async () => {
      const task1 = makeConversation('task-match');
      const task2 = makeConversation('task-nomatch');
      const cache = makeCache(task1, task2);

      // task-match has "deploy" in messages, task-nomatch does not
      mockFsReadFile.mockImplementation(async (filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.includes('task-match')) {
          return JSON.stringify([
            { role: 'user', content: 'Please deploy the application' },
            { role: 'assistant', content: 'Deploying now...' }
          ]);
        }
        if (pathStr.includes('task-nomatch')) {
          return JSON.stringify([
            { role: 'user', content: 'Fix the bug' },
            { role: 'assistant', content: 'Fixed' }
          ]);
        }
        throw new Error('File not found');
      });

      const result = await listConversationsTool.handler({ contentPattern: 'deploy' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(1);
      expect(parsed[0].taskId).toBe('task-match');
    });

    test('contentPattern is case-insensitive', async () => {
      const task = makeConversation('task-ci');
      const cache = makeCache(task);

      mockFsReadFile.mockImplementation(async () => {
        return JSON.stringify([
          { role: 'user', content: 'Run the BUILD process' }
        ]);
      });

      const result = await listConversationsTool.handler({ contentPattern: 'build' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(1);
      expect(parsed[0].taskId).toBe('task-ci');
    });

    test('contentPattern handles fs errors gracefully (task excluded)', async () => {
      const task = makeConversation('task-fserr');
      const cache = makeCache(task);

      mockFsReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await listConversationsTool.handler({ contentPattern: 'test' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      // Task should be excluded (error = no match)
      expect(parsed.length).toBe(0);
    });

    test('empty contentPattern does not filter', async () => {
      const cache = makeCache(makeConversation('task-1'), makeConversation('task-2'));

      const result = await listConversationsTool.handler({ contentPattern: '  ' }, cache);
      const _response = JSON.parse((result.content[0] as any).text);
      const parsed = _response.conversations ?? _response;

      expect(parsed.length).toBe(2);
    });
  });

  // ============================================================
  // Concurrent access (regression #567 S2 - race condition)
  // ============================================================

  describe('concurrent access', () => {
    test('two simultaneous list calls do not corrupt the cache', async () => {
      const cache = makeCache(
        makeConversation('task-a'),
        makeConversation('task-b'),
        makeConversation('task-c'),
      );

      // Run two list calls in parallel
      const [result1, result2] = await Promise.all([
        listConversationsTool.handler({ sortBy: 'lastActivity' }, cache),
        listConversationsTool.handler({ sortBy: 'messageCount' }, cache),
      ]);

      const _response1 = JSON.parse((result1.content[0] as any).text);
      const parsed1 = _response1.conversations ?? _response1;
      const _response2 = JSON.parse((result2.content[0] as any).text);
      const parsed2 = _response2.conversations ?? _response2;

      // Both should return valid results with all 3 tasks
      expect(parsed1.length).toBe(3);
      expect(parsed2.length).toBe(3);

      // Cache should still be intact
      expect(cache.size).toBe(3);
    });

    test('concurrent list with disk scan adding tasks', async () => {
      const cache = makeCache(makeConversation('existing'));

      // First call: disk scan returns new-task-1
      // Second call: disk scan returns new-task-2
      let callCount = 0;
      mockScanDiskForNewTasks.mockImplementation(async () => {
        callCount++;
        return [makeConversation(`new-task-${callCount}`, {
          metadata: {
            workspace: '/workspace/default',
            mode: 'code-simple',
            timestamp: '2026-03-06T00:00:00.000Z',
            lastActivity: '2026-03-06T00:00:00.000Z',
            createdAt: '2026-03-06T00:00:00.000Z',
            messageCount: 1,
            actionCount: 0,
            totalSize: 100,
          }
        } as any)];
      });

      const [result1, result2] = await Promise.all([
        listConversationsTool.handler({}, cache),
        listConversationsTool.handler({}, cache),
      ]);

      const _response1 = JSON.parse((result1.content[0] as any).text);
      const parsed1 = _response1.conversations ?? _response1;
      const _response2 = JSON.parse((result2.content[0] as any).text);
      const parsed2 = _response2.conversations ?? _response2;

      // Both calls should succeed with valid JSON
      expect(parsed1.length).toBeGreaterThanOrEqual(1);
      expect(parsed2.length).toBeGreaterThanOrEqual(1);

      // Cache should have grown (original + new tasks from both scans)
      expect(cache.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================================
  // Définition MCP
  // ============================================================

  describe('listConversationsTool définition', () => {
    test('name = "list_conversations"', () => {
      expect(listConversationsTool.definition.name).toBe('list_conversations');
    });

    test('description est définie', () => {
      expect(typeof listConversationsTool.definition.description).toBe('string');
      expect(listConversationsTool.definition.description.length).toBeGreaterThan(0);
    });

    test('inputSchema est un objet', () => {
      expect(typeof listConversationsTool.definition.inputSchema).toBe('object');
    });

    test('inputSchema.properties contient workspace', () => {
      const props = listConversationsTool.definition.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('workspace');
    });

    test('inputSchema.properties contient limit', () => {
      const props = listConversationsTool.definition.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('limit');
    });
  });

  // ============================================================
  // #666: Claude session metadata enrichment
  // ============================================================

  describe('Claude session metadata enrichment (#666)', () => {
    test('Claude sessions with _claudeFirstUserMessage appear in firstUserMessage', async () => {
      const claudeSession = {
        ...makeConversation('claude-proj--abc123', {
          metadata: {
            workspace: '/workspace/default',
            mode: undefined as any,
            timestamp: '2026-03-01T00:00:00Z',
            lastActivity: '2026-03-10T12:00:00Z',
            createdAt: '2026-03-01T00:00:00Z',
            messageCount: 15,
            actionCount: 0,
            totalSize: 50000,
            dataSource: 'claude',
          },
        }),
        _claudeFirstUserMessage: 'Hello, can you help me fix a bug?',
        _claudeLastUserMessage: 'Thanks, that worked!',
      };

      const cache = makeCache(claudeSession as any);
      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);
      const conversations = parsed.conversations ?? parsed;

      expect(conversations).toHaveLength(1);
      expect(conversations[0].firstUserMessage).toBe('Hello, can you help me fix a bug?');
      expect(conversations[0].lastUserMessage).toBe('Thanks, that worked!');
    });

    test('Roo tasks with sequence take priority over _claude fields', async () => {
      const rooTask = {
        ...makeConversation('roo-task-1', {
          sequence: [
            { role: 'user', content: 'Roo first message' },
            { role: 'assistant', content: 'Response' },
            { role: 'user', content: 'Roo last message' },
          ] as any,
        }),
        _claudeFirstUserMessage: 'Should NOT appear',
        _claudeLastUserMessage: 'Should NOT appear either',
      };

      const cache = makeCache(rooTask as any);
      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);
      const conversations = parsed.conversations ?? parsed;

      expect(conversations).toHaveLength(1);
      expect(conversations[0].firstUserMessage).toBe('Roo first message');
      expect(conversations[0].lastUserMessage).toBe('Roo last message');
    });

    test('Claude sessions without _claude fields have no messages', async () => {
      const plainClaude = makeConversation('claude-proj--xyz', {
        metadata: {
          workspace: '/workspace/default',
          mode: undefined as any,
          timestamp: '2026-03-01T00:00:00Z',
          lastActivity: '2026-03-05T00:00:00Z',
          createdAt: '2026-03-01T00:00:00Z',
          messageCount: 0,
          actionCount: 0,
          totalSize: 1000,
          dataSource: 'claude',
        },
      });

      const cache = makeCache(plainClaude);
      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);
      const conversations = parsed.conversations ?? parsed;

      expect(conversations).toHaveLength(1);
      expect(conversations[0].firstUserMessage).toBeUndefined();
      expect(conversations[0].lastUserMessage).toBeUndefined();
    });

    test('Claude session approxMessageCount appears in metadata', async () => {
      const claudeSession = makeConversation('claude-proj--def', {
        metadata: {
          workspace: '/workspace/default',
          mode: undefined as any,
          timestamp: '2026-03-01T00:00:00Z',
          lastActivity: '2026-03-10T00:00:00Z',
          createdAt: '2026-03-01T00:00:00Z',
          messageCount: 42,
          actionCount: 0,
          totalSize: 70000,
          dataSource: 'claude',
        },
      });

      const cache = makeCache(claudeSession);
      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);
      const conversations = parsed.conversations ?? parsed;

      expect(conversations[0].metadata.messageCount).toBe(42);
    });
  });
});
