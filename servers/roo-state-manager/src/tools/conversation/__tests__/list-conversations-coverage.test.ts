/**
 * Tests de couverture additionnels pour list-conversations.tool.ts
 *
 * Issue #734 — Couverture module conversation-browser > 70%
 *
 * Couvre les chemins non testés :
 * - source: 'claude' → scanClaudeSessions (ClaudeStorageDetector retourne [])
 * - source: 'all'    → combinaison Roo cache + Claude scan
 * - contentPattern   → matchesContentPattern via loadApiMessages mocké
 * - pendingSubtaskOnly → hasPendingSubtask + detectPendingSubtaskInMessages
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ─────────────────── mocks (hoisted) ───────────────────

const { mockScanDisk, mockFsReadFile, mockDetectClaudeLocations } = vi.hoisted(() => ({
  mockScanDisk: vi.fn().mockResolvedValue([]),
  mockFsReadFile: vi.fn().mockRejectedValue(new Error('readFile: not mocked')),
  mockDetectClaudeLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDisk(...args),
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: (...args: any[]) => mockDetectClaudeLocations(...args),
    analyzeConversation: vi.fn(),
  },
}));

// Mock `fs` (utilisé via `import { promises as fs } from 'fs'` dans la source)
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

// ─────────────────── helper ───────────────────

function makeSkeleton(
  taskId: string,
  lastActivity = '2026-01-15T12:00:00.000Z'
): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      workspace: '/workspace/test',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
      lastActivity,
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 512,
    },
    messages: [],
  } as ConversationSkeleton;
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockScanDisk.mockResolvedValue([]);
  mockDetectClaudeLocations.mockResolvedValue([]);
  mockFsReadFile.mockRejectedValue(new Error('readFile: not mocked'));
  // vi.spyOn works where vi.mock fails for RooStorageDetector (#1123)
  vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue(['/mock/storage']);
});

// ─────────────────── tests ───────────────────

describe('source: claude', () => {
  /**
   * Couvre scanClaudeSessions quand ClaudeStorageDetector retourne [].
   * Lignes ~366-383 (incluseClaude branch) + lignes ~964-1090 (scanClaudeSessions).
   */
  test('source=claude retourne liste vide si ClaudeStorageDetector.detectStorageLocations retourne []', async () => {
    mockDetectClaudeLocations.mockResolvedValue([]);
    const emptyCache: Map<string, ConversationSkeleton> = new Map();

    const result = await listConversationsTool.handler({ source: 'claude' }, emptyCache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations).toEqual([]);
    // Roo disk scan ne doit PAS être appelé quand source='claude'
    expect(mockScanDisk).not.toHaveBeenCalled();
    // ClaudeStorageDetector DOIT être appelé
    expect(mockDetectClaudeLocations).toHaveBeenCalled();
  });

  test('source=all inclut les tâches Roo du cache et tente le scan Claude', async () => {
    mockDetectClaudeLocations.mockResolvedValue([]);
    const cache: Map<string, ConversationSkeleton> = new Map([
      ['roo-task-1', makeSkeleton('roo-task-1')],
    ]);

    const result = await listConversationsTool.handler({ source: 'all' }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    // Au moins le cache Roo (1 tâche) est inclus
    expect(conversations.length).toBeGreaterThanOrEqual(1);
    // Le cache Roo est parcouru (disk scan appelé)
    expect(mockScanDisk).toHaveBeenCalled();
    // La tâche Roo est bien dans les résultats
    const taskIds = conversations.map((c: any) => c.taskId);
    expect(taskIds).toContain('roo-task-1');
  });
});

describe('contentPattern', () => {
  /**
   * Couvre matchesContentPattern + loadApiMessages + extractTextFromMessage.
   * Lignes ~439-457 (contentPattern filter) + 655-711 (matchesContentPattern + extractTextFromMessage).
   */
  test('contentPattern inclut seulement les tâches dont les messages contiennent le motif', async () => {
    const taskA = makeSkeleton('task-match');
    const taskB = makeSkeleton('task-no-match');
    const cache = new Map([
      ['task-match', taskA],
      ['task-no-match', taskB],
    ]);

    // task-match → messages contenant 'hello world'
    // task-no-match → messages sans ce texte
    mockFsReadFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes('task-match')) {
        return Promise.resolve(JSON.stringify([
          { role: 'user', content: 'hello world, this is a test message' },
          { role: 'assistant', content: 'Sure!' },
        ]));
      }
      return Promise.resolve(JSON.stringify([
        { role: 'user', content: 'something unrelated' },
      ]));
    });

    const result = await listConversationsTool.handler({ contentPattern: 'hello world' }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations.length).toBe(1);
    expect(conversations[0].taskId).toBe('task-match');
  });

  test('contentPattern retourne tableau vide si aucun message ne correspond', async () => {
    const cache = new Map([['task-x', makeSkeleton('task-x')]]);

    mockFsReadFile.mockResolvedValue(JSON.stringify([
      { role: 'user', content: 'totally different content' },
    ]));

    const result = await listConversationsTool.handler({ contentPattern: 'xyz-not-found-123' }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations).toEqual([]);
  });
});

describe('pendingSubtaskOnly', () => {
  /**
   * Couvre hasPendingSubtask + detectPendingSubtaskInMessages.
   * Lignes ~415-433 (pendingSubtaskOnly filter) + 642-650 (hasPendingSubtask) + 1092-1126 (detectPendingSubtaskInMessages).
   */
  test('pendingSubtaskOnly=true conserve la tâche avec sous-tâche en attente', async () => {
    const cache = new Map([
      ['task-pending', makeSkeleton('task-pending')],
      ['task-done', makeSkeleton('task-done')],
    ]);

    mockFsReadFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes('task-pending')) {
        // L'assistant a émis une instruction <new_task> sans completion suivante
        return Promise.resolve(JSON.stringify([
          { role: 'user', content: 'Do something' },
          { role: 'assistant', content: 'Sure, <new_task>subtask instructions</new_task>' },
        ]));
      }
      // task-done : instruction suivie d'une completion
      return Promise.resolve(JSON.stringify([
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'Sure, <new_task>subtask instructions</new_task>' },
        { role: 'user', content: '[new_task completed] result here' },
      ]));
    });

    const result = await listConversationsTool.handler({ pendingSubtaskOnly: true }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations.length).toBe(1);
    expect(conversations[0].taskId).toBe('task-pending');
  });

  test('pendingSubtaskOnly=true retourne tableau vide si toutes les sous-tâches sont complétées', async () => {
    const cache = new Map([['task-complete', makeSkeleton('task-complete')]]);

    mockFsReadFile.mockResolvedValue(JSON.stringify([
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Sure, <new_task>instructions</new_task>' },
      { role: 'user', content: '[new_task completed]' },
    ]));

    const result = await listConversationsTool.handler({ pendingSubtaskOnly: true }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations).toEqual([]);
  });

  test('pendingSubtaskOnly=true exclut la tâche si aucune instruction new_task trouvée', async () => {
    const cache = new Map([['task-no-subtask', makeSkeleton('task-no-subtask')]]);

    mockFsReadFile.mockResolvedValue(JSON.stringify([
      { role: 'user', content: 'Just a normal task' },
      { role: 'assistant', content: 'Done!' },
    ]));

    const result = await listConversationsTool.handler({ pendingSubtaskOnly: true }, cache);

    const text = (result.content[0] as any).text;
    const response = JSON.parse(text);
    const conversations = response.conversations ?? response;

    expect(conversations).toEqual([]);
  });
});
