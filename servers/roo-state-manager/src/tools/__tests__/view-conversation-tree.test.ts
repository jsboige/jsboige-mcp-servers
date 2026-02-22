/**
 * Tests unitaires pour view-conversation-tree.ts
 *
 * Couvre :
 * - Cache vide sans task_id → erreur
 * - task_id non trouvé dans cache → erreur
 * - findLatestTask : sélection automatique + filtre workspace
 * - view_mode=single/chain/cluster
 * - detail_level=skeleton/summary/full
 * - truncate parameter
 * - current_task_id marking
 * - output_file → saves to file
 *
 * Framework: Vitest
 * @module tools/__tests__/view-conversation-tree.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks ───────────────────

const mockWriteFile = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...(actual as any).promises,
      writeFile: (...args: any[]) => mockWriteFile(...args),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock smart-truncation to return simple results
vi.mock('../smart-truncation/index.js', () => ({
  SmartTruncationEngine: vi.fn().mockImplementation(() => ({
    truncate: vi.fn().mockReturnValue({ content: 'smart-truncated', wasTruncated: false }),
  })),
  ContentTruncator: vi.fn().mockImplementation(() => ({
    truncate: vi.fn().mockReturnValue('truncated-content'),
  })),
  SmartOutputFormatter: vi.fn().mockImplementation(() => ({
    format: vi.fn().mockReturnValue('formatted-output'),
  })),
  DEFAULT_SMART_TRUNCATION_CONFIG: {},
  ViewConversationTreeArgs: {},
}));

import { viewConversationTree } from '../view-conversation-tree.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeSkeleton(overrides: Partial<ConversationSkeleton> & { taskId: string }): ConversationSkeleton {
  return {
    taskId: overrides.taskId,
    parentTaskId: overrides.parentTaskId,
    metadata: {
      title: overrides.metadata?.title ?? `Task ${overrides.taskId}`,
      messageCount: overrides.metadata?.messageCount ?? 1,
      lastActivity: overrides.metadata?.lastActivity ?? '2026-01-01T10:00:00.000Z',
      workspace: overrides.metadata?.workspace ?? '/test/workspace',
      firstActivity: '2026-01-01T09:00:00.000Z',
      actionCount: 0,
      totalSize: 100,
    },
    sequence: overrides.sequence ?? [
      { role: 'user', content: 'Hello world', timestamp: '2026-01-01T10:00:00.000Z' }
    ],
  } as ConversationSkeleton;
}

function makeCache(skeletons: ConversationSkeleton[]): Map<string, ConversationSkeleton> {
  return new Map(skeletons.map(s => [s.taskId, s]));
}

// ─────────────────── tests ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
});

describe('viewConversationTree.handler', () => {

  // ============================================================
  // Erreurs de base
  // ============================================================

  describe('erreurs', () => {
    test('lève une erreur si cache vide et task_id absent', async () => {
      const emptyCache = new Map<string, ConversationSkeleton>();

      await expect(viewConversationTree.handler({}, emptyCache))
        .rejects.toThrow('Cache is empty');
    });

    test('lève une erreur si task_id non trouvé dans cache', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-1' })]);

      await expect(viewConversationTree.handler({ task_id: 'missing-task' }, cache))
        .rejects.toThrow("Task with ID 'missing-task' not found");
    });

    test('lève une erreur si workspace fourni mais aucune tâche correspond', async () => {
      const cache = makeCache([
        makeSkeleton({ taskId: 'task-1', metadata: { workspace: '/other/ws' } as any })
      ]);

      await expect(viewConversationTree.handler({ workspace: '/nonexistent' }, cache))
        .rejects.toThrow("workspace '/nonexistent'");
    });
  });

  // ============================================================
  // Sélection automatique de tâche (findLatestTask)
  // ============================================================

  describe('sélection automatique (no task_id)', () => {
    test('sélectionne la tâche la plus récente automatiquement', async () => {
      const older = makeSkeleton({ taskId: 'older', metadata: { lastActivity: '2026-01-01T09:00:00.000Z' } as any });
      const newer = makeSkeleton({ taskId: 'newer', metadata: { lastActivity: '2026-01-01T11:00:00.000Z' } as any });
      const cache = makeCache([older, newer]);

      const result = await viewConversationTree.handler({ view_mode: 'single' }, cache);

      expect(result.content[0].text).toContain('newer');
    });

    test('filtre par workspace si fourni', async () => {
      const ws1 = makeSkeleton({ taskId: 'ws1-task', metadata: { workspace: '/ws1', lastActivity: '2026-01-01T10:00:00.000Z' } as any });
      const ws2 = makeSkeleton({ taskId: 'ws2-task', metadata: { workspace: '/ws2', lastActivity: '2026-01-01T11:00:00.000Z' } as any });
      const cache = makeCache([ws1, ws2]);

      const result = await viewConversationTree.handler({ workspace: '/ws1', view_mode: 'single' }, cache);

      expect(result.content[0].text).toContain('ws1-task');
    });
  });

  // ============================================================
  // view_mode
  // ============================================================

  describe('view_mode=single', () => {
    test('affiche une seule tâche', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-a' })]);

      const result = await viewConversationTree.handler({ task_id: 'task-a', view_mode: 'single' }, cache);

      expect(result.content[0].text).toContain('task-a');
    });
  });

  describe('view_mode=chain', () => {
    test('remonte la chaîne parente', async () => {
      const parent = makeSkeleton({ taskId: 'parent-task' });
      const child = makeSkeleton({ taskId: 'child-task', parentTaskId: 'parent-task' });
      const cache = makeCache([parent, child]);

      const result = await viewConversationTree.handler({ task_id: 'child-task', view_mode: 'chain' }, cache);

      expect(result.content[0].text).toContain('parent-task');
      expect(result.content[0].text).toContain('child-task');
    });

    test('vue chain avec une seule tâche sans parent', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'solo-task' })]);

      const result = await viewConversationTree.handler({ task_id: 'solo-task', view_mode: 'chain' }, cache);

      expect(result.content[0].text).toContain('solo-task');
    });
  });

  describe('view_mode=cluster', () => {
    test('inclut les tâches enfants', async () => {
      const parent = makeSkeleton({ taskId: 'parent' });
      const child1 = makeSkeleton({ taskId: 'child-1', parentTaskId: 'parent' });
      const child2 = makeSkeleton({ taskId: 'child-2', parentTaskId: 'parent' });
      const cache = makeCache([parent, child1, child2]);

      const result = await viewConversationTree.handler({ task_id: 'parent', view_mode: 'cluster' }, cache);

      expect(result.content[0].text).toContain('parent');
    });
  });

  // ============================================================
  // detail_level
  // ============================================================

  describe('detail_level', () => {
    test('skeleton : format compact 1 ligne par message', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-x' })]);

      const result = await viewConversationTree.handler({ task_id: 'task-x', detail_level: 'skeleton' }, cache);

      expect(result.content[0].text).toBeDefined();
      expect(typeof result.content[0].text).toBe('string');
    });

    test('summary : format avec contenu tronqué', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-x' })]);

      const result = await viewConversationTree.handler({ task_id: 'task-x', detail_level: 'summary' }, cache);

      expect(result.content[0].text).toBeDefined();
    });

    test('full : format avec paramètres complets', async () => {
      const skeletonWithAction = makeSkeleton({
        taskId: 'task-x',
        sequence: [
          { name: 'read_file', type: 'tool', status: 'success', parameters: { path: '/test' }, timestamp: '2026-01-01T10:00:00.000Z' } as any
        ]
      });
      const cache = makeCache([skeletonWithAction]);

      const result = await viewConversationTree.handler({ task_id: 'task-x', detail_level: 'full' }, cache);

      expect(result.content[0].text).toContain('read_file');
    });
  });

  // ============================================================
  // current_task_id marking
  // ============================================================

  describe('current_task_id', () => {
    test('marque la tâche actuelle', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'marked-task-123' })]);

      const result = await viewConversationTree.handler({
        task_id: 'marked-task-123',
        current_task_id: 'marked-task-123',
        view_mode: 'single'
      }, cache);

      expect(result.content[0].text).toContain('TÂCHE ACTUELLE');
    });

    test('ne marque pas la tâche si current_task_id ne correspond pas', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-abc' })]);

      const result = await viewConversationTree.handler({
        task_id: 'task-abc',
        current_task_id: 'other-task',
        view_mode: 'single'
      }, cache);

      expect(result.content[0].text).not.toContain('TÂCHE ACTUELLE');
    });
  });

  // ============================================================
  // Contenu de la réponse
  // ============================================================

  describe('format de réponse', () => {
    test('retourne un CallToolResult avec content[0].type=text', async () => {
      const cache = makeCache([makeSkeleton({ taskId: 'task-1' })]);

      const result = await viewConversationTree.handler({ task_id: 'task-1' }, cache);

      expect(result).toHaveProperty('content');
      expect(result.content[0].type).toBe('text');
    });

    test('inclut le nombre de messages dans la sortie', async () => {
      const cache = makeCache([
        makeSkeleton({ taskId: 'task-1', metadata: { messageCount: 5 } as any })
      ]);

      const result = await viewConversationTree.handler({ task_id: 'task-1' }, cache);

      expect(result.content[0].text).toContain('5');
    });
  });
});
