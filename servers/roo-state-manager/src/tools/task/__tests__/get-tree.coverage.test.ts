/**
 * Coverage tests for handleGetTaskTree — branches NOT exercised by get-tree.test.ts
 *
 * Cible les lignes non couvertes identifiées par coverage-fresh (76.21% branch):
 *  - findTaskById prefix-unique match (L130-132)
 *  - radix-tree parent reconstruction (L206-221) + index populate (L184-188)
 *  - findAbsoluteRoot orphan-parent break (L249-251)
 *  - buildTree skeleton-not-found null (L304-306) → TREE_CONSTRUCTION_FAILED (L428-435)
 *  - buildTree maxDepth guard (L292-295)
 *  - buildTree taskId-undefined defensive null (L298-301)
 *  - buildTree direct circular reference warning (L280-288)
 *  - filterTreeToTargetBranch + isOnPathToTarget sibling pruning (L363-401)
 *  - children chronological sort fallback when createdAt missing (L319-320)
 *
 * Pattern C3 (Vein D, dispatch #2800): 1 fichier = 1 PR.
 *
 * @module tools/task/__tests__/get-tree.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks (même structure que get-tree.test.ts) ───────────────────

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

import { handleGetTaskTree } from '../get-tree.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(
  taskId: string,
  overrides: Partial<ConversationSkeleton> & { parentTaskId?: string; parentId?: string } = {}
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

/** Parse le JSON retourné par le handler (format json par défaut). */
function parseResult(result: any): any {
  return JSON.parse((result.content[0] as any).text);
}

// ─────────────────── setup ───────────────────

const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureFresh.mockResolvedValue(undefined);
  mockGetStats.mockReturnValue({ totalInstructions: 1 });
  mockGetParentsForInstruction.mockResolvedValue([]);
});

describe('handleGetTaskTree — coverage des branches', () => {

  // ============================================================
  // findTaskById : prefix match UNIQUE (L130-132)
  // ============================================================
  describe('findTaskById prefix-unique', () => {
    test('un préfixe court matching exactement UNE tâche résout vers cette tâche', async () => {
      const cache = makeCache(makeConversation('abcdef1234567890-task'));

      const result = await handleGetTaskTree(
        { conversation_id: 'abcdef', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = parseResult(result);
      // La racine résolue est la tâche dont l'ID commence par le préfixe
      expect(parsed.root_task.taskId).toBe('abcdef1234567890-task');
    });
  });

  // ============================================================
  // radix-tree : parent reconstruit via getParentsForInstruction (L206-221)
  // ============================================================
  describe('radix-tree parent reconstruction', () => {
    test('une tâche sans parent statique obtient un parent via le radix tree', async () => {
      const orphan = makeConversation('orphan-child', {
        metadata: {
          workspace: '/ws', mode: 'code-simple',
          timestamp: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-15T12:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z', messageCount: 3, actionCount: 1, totalSize: 256,
          title: 'Une instruction assez longue pour dépasser le seuil radix',
        },
      });
      const radixParent = makeConversation('radix-parent');
      const cache = makeCache(orphan, radixParent);

      mockGetParentsForInstruction.mockResolvedValue([{ taskId: 'radix-parent' }]);

      const result = await handleGetTaskTree(
        { conversation_id: 'orphan-child', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      // Le radix tree a reconstruit la relation : la racine devient radix-parent
      const parsed = parseResult(result);
      expect(parsed.root_task.taskId).toBe('radix-parent');
      expect(JSON.stringify(parsed.tree)).toContain('orphan-child');
    });
  });

  // ============================================================
  // radix-tree : peuplement de l'index depuis childTaskInstructionPrefixes (L184-188)
  // ============================================================
  describe('index populate from childTaskInstructionPrefixes', () => {
    test('index vide → peuplement à la volée via addInstruction', async () => {
      const task = makeConversation('task-with-prefixes', {
        childTaskInstructionPrefixes: ['abc-prefix-123'],
        metadata: {
          workspace: '/ws', mode: 'code-simple',
          timestamp: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-15T12:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z', messageCount: 3, actionCount: 1, totalSize: 256,
          title: 'Task with child prefixes',
        },
      });
      const cache = makeCache(task);

      // 1er appel (détection index vide) → 0 ; 2e appel (post-populate) → 1
      mockGetStats.mockReturnValueOnce({ totalInstructions: 0 })
        .mockReturnValueOnce({ totalInstructions: 1 });

      await handleGetTaskTree(
        { conversation_id: 'task-with-prefixes', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      expect(mockAddInstruction).toHaveBeenCalledWith('task-with-prefixes', 'abc-prefix-123');
    });
  });

  // ============================================================
  // findAbsoluteRoot orphan break (L249-251) + buildTree not-found (L304-306)
  //   → TREE_CONSTRUCTION_FAILED (L428-435)
  // ============================================================
  describe('orphan parent reference', () => {
    test('parentTaskId pointant vers une tâche absente → TREE_CONSTRUCTION_FAILED', async () => {
      // La cible déclare un parent qui n'existe PAS dans le cache
      const target = makeConversation('target-task', { parentTaskId: 'missing-parent' });
      const cache = makeCache(target);

      await expect(
        handleGetTaskTree(
          { conversation_id: 'target-task', output_format: 'json' },
          cache,
          mockEnsureFresh
        )
      ).rejects.toThrow(/Could not build tree|TREE_CONSTRUCTION_FAILED/i);
    });
  });

  // ============================================================
  // buildTree maxDepth guard (L292-295)
  // ============================================================
  describe('maxDepth guard', () => {
    test('max_depth=1 élague les enfants au-delà de la profondeur 0', async () => {
      const parent = makeConversation('parent-d');
      const child = makeConversation('child-d', { parentTaskId: 'parent-d' });
      const cache = makeCache(parent, child);

      const result = await handleGetTaskTree(
        { conversation_id: 'parent-d', max_depth: 1, output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = parseResult(result);
      const rootNode = parsed.tree[0];
      // L'enfant à profondeur 1 est pruné par le garde-fou (children undefined)
      expect(rootNode.children).toBeUndefined();
      expect(rootNode.taskId).toBe('parent-d');
    });
  });

  // ============================================================
  // buildTree taskId undefined defensive null (L298-301)
  // ============================================================
  describe('taskId undefined defensive', () => {
    test('un enfant avec taskId undefined est pruné sans casser la construction', async () => {
      const parentTask = makeConversation('parent-host');
      // child fantôme : parentTaskId déclaré mais taskId absent
      const ghost = { parentTaskId: 'parent-host' } as unknown as ConversationSkeleton;
      ghost.taskId = undefined as unknown as string;
      const cache = makeCache(parentTask, ghost);

      // L'arbre se construit (le fantôme est droppé), pas de throw
      const result = await handleGetTaskTree(
        { conversation_id: 'parent-host', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = parseResult(result);
      expect(parsed.root_task.taskId).toBe('parent-host');
      expect(parsed.metadata.total_nodes).toBe(1);
    });
  });

  // ============================================================
  // buildTree direct circular reference warning (L280-288)
  // ============================================================
  describe('direct circular reference', () => {
    test('une tâche dont le parent est aussi son enfant ne provoque pas de boucle infinie', async () => {
      // A se déclare enfant de A (self-loop) → childrenMap[A] = [A], parentTaskId=A
      const selfRef = makeConversation('self-ref-task', { parentTaskId: 'self-ref-task' });
      const cache = makeCache(selfRef);

      const result = await handleGetTaskTree(
        { conversation_id: 'self-ref-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      // Pas de boucle infinie : l'arbre se construit avec un seul nœud
      const parsed = parseResult(result);
      expect(parsed.root_task.taskId).toBe('self-ref-task');
      expect(parsed.metadata.total_nodes).toBe(1);
    });
  });

  // ============================================================
  // filterTreeToTargetBranch + isOnPathToTarget (L363-401)
  // ============================================================
  describe('filterTreeToTargetBranch (include_siblings=false, cible avec enfants)', () => {
    test('les siblings hors-chemin vers la cible sont élagués', async () => {
      // root → [mid, uncle] ; mid → target ; target → leaf ; uncle → cousin (hors chemin)
      const root = makeConversation('root-r');
      const mid = makeConversation('mid-r', { parentTaskId: 'root-r' });
      const uncle = makeConversation('uncle-r', { parentTaskId: 'root-r' });
      const target = makeConversation('target-r', { parentTaskId: 'mid-r' });
      const leaf = makeConversation('leaf-r', { parentTaskId: 'target-r' });
      const cousin = makeConversation('cousin-r', { parentTaskId: 'uncle-r' });
      const cache = makeCache(root, mid, uncle, target, leaf, cousin);

      const result = await handleGetTaskTree(
        { conversation_id: 'target-r', include_siblings: false, output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const treeStr = JSON.stringify(parseResult(result));
      // Le chemin vers la cible est conservé
      expect(treeStr).toContain('root-r');
      expect(treeStr).toContain('mid-r');
      expect(treeStr).toContain('target-r');
      expect(treeStr).toContain('leaf-r'); // sous-arbre de la cible conservé
      // uncle et cousin (hors chemin) sont élagués par filterTreeToTargetBranch
      expect(treeStr).not.toContain('uncle-r');
      expect(treeStr).not.toContain('cousin-r');
    });
  });

  // ============================================================
  // radix-tree : erreur de recherche gérée gracieusement (L224-226, catch)
  // ============================================================
  describe('radix-tree error handling', () => {
    test('une erreur de getParentsForInstruction ne casse pas la construction', async () => {
      const orphan = makeConversation('radix-err-task', {
        metadata: {
          workspace: '/ws', mode: 'code-simple',
          timestamp: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-15T12:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z', messageCount: 2, actionCount: 0, totalSize: 128,
          title: 'Instruction longue enough for radix lookup',
        },
      });
      const cache = makeCache(orphan);

      mockGetParentsForInstruction.mockRejectedValue(new Error('radix boom'));

      // Le catch avale l'erreur → l'arbre se construit quand même (orphan devient racine)
      const result = await handleGetTaskTree(
        { conversation_id: 'radix-err-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = parseResult(result);
      expect(parsed.root_task.taskId).toBe('radix-err-task');
    });
  });

  // ============================================================
  // radix-tree : instruction trop courte, skip (L228-229, else branch)
  // ============================================================
  describe('radix-tree instruction too short', () => {
    test('une tâche sans parent avec une instruction courte skip la recherche radix', async () => {
      const short = makeConversation('short-title-task', {
        metadata: {
          workspace: '/ws', mode: 'code-simple',
          timestamp: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-15T12:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z', messageCount: 1, actionCount: 0, totalSize: 64,
          title: 'court', // ≤ 10 chars → branche else (skip radix)
        },
      });
      const cache = makeCache(short);

      const result = await handleGetTaskTree(
        { conversation_id: 'short-title-task', output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      // Pas de recherche radix (instruction trop courte), l'arbre se construit quand même
      expect(mockGetParentsForInstruction).not.toHaveBeenCalled();
      const parsed = parseResult(result);
      expect(parsed.root_task.taskId).toBe('short-title-task');
    });
  });

  // ============================================================
  // markdown format : récursion enfants (L478-481)
  // ============================================================
  describe('markdown format avec enfants', () => {
    test('un arbre parent-enfant en markdown inclut les titres enfants', async () => {
      const parent = makeConversation('md-parent');
      const child = makeConversation('md-child', { parentTaskId: 'md-parent' });
      const cache = makeCache(parent, child);

      const result = await handleGetTaskTree(
        { conversation_id: 'md-parent', output_format: 'markdown' },
        cache,
        mockEnsureFresh
      );

      const text = (result.content[0] as any).text;
      // Les deux niveaux sont rendus (récursion dans formatTreeMarkdown)
      expect(text).toContain('md-parent');
      expect(text).toContain('md-child');
    });
  });

  // ============================================================
  // children chronological sort fallback (L319-320)
  // ============================================================
  describe('children sort fallback', () => {
    test('un enfant sans createdAt ne casse pas le tri chronologique', async () => {
      const parent = makeConversation('sort-parent');
      // Deux enfants, dont un SANS createdAt (déclenche le fallback `|| 0`)
      const childA = makeConversation('child-a-sort', { parentTaskId: 'sort-parent' });
      const childB = makeConversation('child-b-sort', {
        parentTaskId: 'sort-parent',
        metadata: {
          workspace: '/ws', mode: 'code-simple',
          timestamp: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-15T12:00:00.000Z',
          // createdAt délibérément absent
          messageCount: 2, actionCount: 0, totalSize: 128, title: 'Child B',
        } as any,
      });
      const cache = makeCache(parent, childA, childB);

      const result = await handleGetTaskTree(
        { conversation_id: 'sort-parent', include_siblings: true, output_format: 'json' },
        cache,
        mockEnsureFresh
      );

      const parsed = parseResult(result);
      const rootNode = parsed.tree[0];
      // Les deux enfants sont présents (le tri ne drop rien)
      expect(rootNode.children).toBeDefined();
      expect(rootNode.children.length).toBe(2);
    });
  });
});
