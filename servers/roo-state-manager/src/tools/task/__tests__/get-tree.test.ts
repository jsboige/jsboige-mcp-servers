/**
 * Tests unitaires pour handleGetTaskTree
 *
 * Couvre :
 * - Cache vide → retourne message "Arbre Vide"
 * - conversation_id non trouvé → throw StateManagerError
 * - Ambiguïté ID préfixe (plusieurs matches) → throw StateManagerError
 * - Succès : format JSON (défaut)
 * - Succès : format ascii-tree
 * - Succès : format markdown
 * - Succès : format hierarchical
 * - include_siblings=false : tâche feuille (pas d'enfants)
 * - Hiérarchie parent-enfant via parentTaskId
 * - current_task_id : marquage isCurrentTask
 * - getTaskTreeTool : définition MCP
 *
 * @module tools/task/__tests__/get-tree.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const { mockGetStats, mockGetParentsForInstruction, mockAddInstruction } = vi.hoisted(() => {
  const mockGetStats = vi.fn().mockReturnValue({ totalInstructions: 1 });
  const mockGetParentsForInstruction = vi.fn().mockResolvedValue([]);
  const mockAddInstruction = vi.fn();
  return { mockGetStats, mockGetParentsForInstruction, mockAddInstruction };
});

vi.mock('../../../utils/task-instruction-index.js', () => ({
  globalTaskInstructionIndex: {
    getStats: mockGetStats,
    getParentsForInstruction: mockGetParentsForInstruction,
    addInstruction: mockAddInstruction,
  },
}));

import { handleGetTaskTree, getTaskTreeTool } from '../get-tree.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(
  taskId: string,
  overrides: Partial<ConversationSkeleton> & { parentTaskId?: string } = {}
): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      workspace: '/workspace/default',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-15T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 512,
      title: `Task ${taskId}`,
    },
    messages: [],
    ...overrides,
  } as unknown as ConversationSkeleton;
}

function makeCache(...skeletons: ConversationSkeleton[]): Map<string, ConversationSkeleton> {
  return new Map(skeletons.map(s => [s.taskId, s]));
}

// ─────────────────── setup ───────────────────

const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureFresh.mockResolvedValue(undefined);
  mockGetStats.mockReturnValue({ totalInstructions: 1 });
  mockGetParentsForInstruction.mockResolvedValue([]);
});

// ─────────────────── tests ───────────────────

describe('handleGetTaskTree', () => {

  // ============================================================
  // Cache vide
  // ============================================================

  describe('cache vide', () => {
    test('retourne message "Arbre de Tâches Vide"', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'any-id' },
        new Map(),
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      expect(text).toContain('Vide');
    });

    test('appelle ensureSkeletonCacheIsFresh', async () => {
      await handleGetTaskTree(
        { conversation_id: 'any-id' },
        new Map(),
        mockEnsureFresh
      );

      expect(mockEnsureFresh).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Erreurs
  // ============================================================

  describe('erreurs', () => {
    test('conversation_id non trouvé → throw StateManagerError', async () => {
      const cache = makeCache(makeConversation('existing-task'));

      await expect(
        handleGetTaskTree(
          { conversation_id: 'nonexistent-id' },
          cache,
          mockEnsureFresh
        )
      ).rejects.toThrow('nonexistent-id');
    });

    test('conversation_id ambigu (plusieurs préfixes) → throw StateManagerError', async () => {
      // IDs qui partagent le même préfixe
      const cache = makeCache(
        makeConversation('abc123-task-1'),
        makeConversation('abc123-task-2'),
      );

      await expect(
        handleGetTaskTree(
          { conversation_id: 'abc123' },
          cache,
          mockEnsureFresh
        )
      ).rejects.toThrow(/Ambiguous|ambiguous|abc123/i);
    });
  });

  // ============================================================
  // Format JSON (défaut)
  // ============================================================

  describe('format JSON', () => {
    test('retourne un objet JSON valide', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('JSON contient conversation_id', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.conversation_id).toBe('root-task');
    });

    test('JSON contient tree', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.tree).toBeDefined();
      expect(Array.isArray(parsed.tree)).toBe(true);
    });

    test('format JSON par défaut si output_format absent', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);
      expect(parsed.conversation_id).toBe('root-task');
    });
  });

  // ============================================================
  // Format ascii-tree
  // ============================================================

  describe('format ascii-tree', () => {
    test('retourne du texte non-JSON (arbre ASCII)', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'ascii-tree' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      expect(typeof text).toBe('string');
      // Should not parse as JSON
      expect(() => JSON.parse(text)).toThrow();
    });
  });

  // ============================================================
  // Format markdown
  // ============================================================

  describe('format markdown', () => {
    test('contient des titres markdown (#)', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'markdown' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      expect(text).toMatch(/#\s/);
    });
  });

  // ============================================================
  // Format hierarchical
  // ============================================================

  describe('format hierarchical', () => {
    test('retourne du contenu textuel non-JSON', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'root-task', output_format: 'hierarchical' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Hiérarchie parent-enfant
  // ============================================================

  describe('hiérarchie parent-enfant', () => {
    test('nœud enfant est inclus dans l\'arbre', async () => {
      const parent = makeConversation('parent-task');
      const child = makeConversation('child-task', { parentTaskId: 'parent-task' });
      const cache = makeCache(parent, child);

      const result = await handleGetTaskTree(
        { conversation_id: 'parent-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      const treeText = JSON.stringify(parsed);
      expect(treeText).toContain('child-task');
    });
  });

  // ============================================================
  // include_siblings=false sur tâche feuille
  // ============================================================

  describe('include_siblings=false', () => {
    test('tâche feuille (sans enfants) : retourne seulement ce nœud', async () => {
      const task = makeConversation('leaf-task');
      const cache = makeCache(task);

      const result = await handleGetTaskTree(
        { conversation_id: 'leaf-task', include_siblings: false, output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.conversation_id).toBe('leaf-task');
    });
  });

  // ============================================================
  // current_task_id
  // ============================================================

  describe('current_task_id', () => {
    test('la tâche actuelle est marquée isCurrentTask=true', async () => {
      const task = makeConversation('current-abc123');
      const cache = makeCache(task);

      const result = await handleGetTaskTree(
        { conversation_id: 'current-abc123', current_task_id: 'current-abc123', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      const rootNode = parsed.tree[0];
      expect(rootNode.metadata.isCurrentTask).toBe(true);
    });

    test('sans current_task_id → isCurrentTask=false', async () => {
      const task = makeConversation('task-xyz');
      const cache = makeCache(task);

      const result = await handleGetTaskTree(
        { conversation_id: 'task-xyz', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = JSON.parse((result.content[0] as any).text);
      const rootNode = parsed.tree[0];
      expect(rootNode.metadata.isCurrentTask).toBe(false);
    });
  });

  // ============================================================
  // getTaskTreeTool - définition MCP
  // ============================================================

  describe('getTaskTreeTool', () => {
    test('name = "get_task_tree"', () => {
      expect(getTaskTreeTool.name).toBe('get_task_tree');
    });

    test('description est définie', () => {
      expect(typeof getTaskTreeTool.description).toBe('string');
      expect(getTaskTreeTool.description.length).toBeGreaterThan(0);
    });

    test('inputSchema est un objet', () => {
      expect(typeof getTaskTreeTool.inputSchema).toBe('object');
    });

    test('inputSchema.required contient conversation_id', () => {
      expect(getTaskTreeTool.inputSchema.required).toContain('conversation_id');
    });

    test('inputSchema.properties contient output_format', () => {
      const props = getTaskTreeTool.inputSchema.properties as Record<string, any>;
      expect(props).toHaveProperty('output_format');
    });
  });
});
