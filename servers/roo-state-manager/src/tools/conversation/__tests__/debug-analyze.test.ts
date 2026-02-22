/**
 * Tests unitaires pour debugAnalyzeTool
 *
 * Couvre debug-analyze.tool.ts :
 * - handler : skeleton trouvé, skeleton non trouvé
 * - definition : nom, description, inputSchema
 *
 * @module tools/conversation/__tests__/debug-analyze.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect } from 'vitest';
import { debugAnalyzeTool } from '../debug-analyze.tool.js';
import { GenericErrorCode } from '../../../types/errors.js';

describe('debugAnalyzeTool', () => {
  const mockSkeleton = {
    taskId: 'task-1',
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { created: '2026-01-01T00:00:00.000Z' }
  } as any;

  // ── handler ──

  describe('handler', () => {
    test('retourne le JSON du skeleton si trouvé dans le cache', async () => {
      const cache = new Map([['task-1', mockSkeleton]]);
      const result = await debugAnalyzeTool.handler({ taskId: 'task-1' }, cache);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify(mockSkeleton, null, 2));
    });

    test('retourne le JSON du bon skeleton parmi plusieurs', async () => {
      const skeleton2 = { taskId: 'task-2', messages: [] } as any;
      const cache = new Map([
        ['task-1', mockSkeleton],
        ['task-2', skeleton2]
      ]);
      const result = await debugAnalyzeTool.handler({ taskId: 'task-2' }, cache);

      expect(result.content[0].text).toBe(JSON.stringify(skeleton2, null, 2));
    });

    test('le JSON est formaté avec indent 2', async () => {
      const cache = new Map([['task-1', { a: 1 } as any]]);
      const result = await debugAnalyzeTool.handler({ taskId: 'task-1' }, cache);

      expect(result.content[0].text).toContain('\n  "a": 1');
    });

    test('lève GenericError si taskId non trouvé dans le cache', async () => {
      const cache = new Map<string, any>();

      await expect(debugAnalyzeTool.handler({ taskId: 'missing-task' }, cache))
        .rejects.toThrow("Task with ID 'missing-task' not found in cache.");
    });

    test('lève GenericError avec code INVALID_ARGUMENT', async () => {
      const cache = new Map<string, any>();

      try {
        await debugAnalyzeTool.handler({ taskId: 'not-found' }, cache);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe(GenericErrorCode.INVALID_ARGUMENT);
      }
    });

    test('lève une erreur si le cache est vide', async () => {
      const cache = new Map<string, any>();

      await expect(debugAnalyzeTool.handler({ taskId: 'any-id' }, cache))
        .rejects.toThrow();
    });
  });

  // ── definition ──

  describe('definition', () => {
    test('contient le bon nom d\'outil', () => {
      expect(debugAnalyzeTool.definition.name).toBe('debug_analyze_conversation');
    });

    test('contient une description', () => {
      expect(typeof debugAnalyzeTool.definition.description).toBe('string');
      expect(debugAnalyzeTool.definition.description.length).toBeGreaterThan(0);
    });

    test('inputSchema requiert taskId', () => {
      expect(debugAnalyzeTool.definition.inputSchema.required).toContain('taskId');
    });

    test('inputSchema définit la propriété taskId', () => {
      const props = debugAnalyzeTool.definition.inputSchema.properties as any;
      expect(props.taskId).toBeDefined();
      expect(props.taskId.type).toBe('string');
    });
  });
});
