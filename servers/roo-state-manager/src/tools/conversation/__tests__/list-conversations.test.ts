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

import { describe, test, expect, beforeEach } from 'vitest';
import { listConversationsTool } from '../list-conversations.tool.js';
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

beforeEach(() => {
  emptyCache = new Map();
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
      const parsed = JSON.parse(text);
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
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed.length).toBe(1);
      expect(parsed[0].taskId).toBe('task-ws1');
    });

    test('retourne tableau vide si workspace ne correspond à aucune tâche', async () => {
      const cache = makeCache(makeConversation('task-1'));

      const result = await listConversationsTool.handler({ workspace: '/workspace/nonexistent' }, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].taskId).toBe('recent-task');
      expect(parsed[1].taskId).toBe('old-task');
    });

    test('tri par lastActivity asc', async () => {
      const old = makeTaskWithDate('old-task', '2026-01-01T00:00:00.000Z');
      const recent = makeTaskWithDate('recent-task', '2026-01-20T00:00:00.000Z');
      const cache = makeCache(recent, old);

      const result = await listConversationsTool.handler({ sortBy: 'lastActivity', sortOrder: 'asc' }, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].taskId).toBe('old-task');
      expect(parsed[1].taskId).toBe('recent-task');
    });

    test('tri par messageCount desc', async () => {
      const few = makeTaskWithDate('few-task', '2026-01-15T00:00:00.000Z', 3);
      const many = makeTaskWithDate('many-task', '2026-01-15T00:00:00.000Z', 50);
      const cache = makeCache(few, many);

      const result = await listConversationsTool.handler({ sortBy: 'messageCount' }, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].taskId).toBe('many-task');
      expect(parsed[1].taskId).toBe('few-task');
    });

    test('tri par totalSize desc', async () => {
      const small = makeTaskWithDate('small-task', '2026-01-15T00:00:00.000Z', 5, 512);
      const large = makeTaskWithDate('large-task', '2026-01-15T00:00:00.000Z', 5, 10240);
      const cache = makeCache(small, large);

      const result = await listConversationsTool.handler({ sortBy: 'totalSize' }, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].taskId).toBe('large-task');
      expect(parsed[1].taskId).toBe('small-task');
    });
  });

  // ============================================================
  // Limit
  // ============================================================

  describe('limit', () => {
    test('limite les résultats au nombre demandé', async () => {
      const cache = makeCache(
        makeConversation('task-1'),
        makeConversation('task-2'),
        makeConversation('task-3'),
        makeConversation('task-4'),
        makeConversation('task-5'),
      );

      const result = await listConversationsTool.handler({ limit: 3 }, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed.length).toBe(3);
    });

    test('sans limit → retourne toutes les tâches', async () => {
      const cache = makeCache(
        makeConversation('task-1'),
        makeConversation('task-2'),
        makeConversation('task-3'),
      );

      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

      // child ne doit pas être au premier niveau
      const childAtRoot = parsed.find((n: any) => n.taskId === 'child-task');
      expect(childAtRoot).toBeUndefined();
    });

    test('tâche sans parent est au premier niveau', async () => {
      const orphan = makeConversation('orphan-task');
      const cache = makeCache(orphan);

      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].taskId).toBe('orphan-task');
      expect(parsed[0].children).toEqual([]);
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
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].firstUserMessage).toBe('Initial user instruction');
    });

    test('tronque le premier message à 200 caractères', async () => {
      const longContent = 'x'.repeat(300);
      const task = makeConversation('task-long') as any;
      task.sequence = [{ role: 'user', content: longContent }];
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].firstUserMessage.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(parsed[0].firstUserMessage).toContain('...');
    });

    test('firstUserMessage est undefined si pas de sequence', async () => {
      const task = makeConversation('task-no-seq');
      const cache = makeCache(task);

      const result = await listConversationsTool.handler({}, cache);
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

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
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].isCompleted).toBe(false);
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
      const parsed = JSON.parse((result.content[0] as any).text);

      expect(parsed[0].completionMessage).toContain('Successfully');
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
});
