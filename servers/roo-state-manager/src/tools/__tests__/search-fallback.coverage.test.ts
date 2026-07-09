/**
 * Coverage tests for handleSearchTasksSemanticFallback
 *
 * Cible les branches NON couvertes par les 4 fichiers de test existants
 * (search-fallback.test.ts, *.tool.test.ts ×2, *-root.test.ts) — mesurées à
 * 75% branch malgré la couverture happy-path. Pattern C3 (Vein D, dispatch #2800).
 *
 * Lacunes ciblées (coverage-fresh) :
 *  - L120-124 : succès correspondance PARTIELLE (allWordsMatch / specialMatch 'user message')
 *  - L105-114 : logique de matching multi-mots (allWordsMatch)
 *  - L26-28   : truncateMessage chemin "message long" (start/[...]/end)
 *  - L19-21   : truncateMessage early-return (message falsy)
 *  - L136-138 : defaults metadata (title/messageCount/lastActivity manquants)
 *  - L92,82-83: global search sequence ?? [] (skeleton sans sequence) + DEBUG ternary
 *  - L163     : specific search sequence ?? []
 *  - L156-158 : specific search conversation_id absent → throw GenericError
 *
 * @module tools/__tests__/search-fallback.coverage
 */

import { describe, test, expect } from 'vitest';
import { handleSearchTasksSemanticFallback } from '../search-fallback.tool.js';

// ─────────────────── helpers ───────────────────

/** Shape local LocalConversationSkeleton (non exporté) — construit via cast. */
function makeSkeleton(
  taskId: string,
  opts: {
    title?: string;
    messageCount?: number;
    lastActivity?: string;
    sequence?: Array<{ role: string; content: string; timestamp?: string }>;
    metadata?: Record<string, unknown>;
  } = {}
): any {
  return {
    taskId,
    metadata: {
      title: opts.title ?? `Task ${taskId}`,
      messageCount: opts.messageCount ?? 0,
      lastActivity: opts.lastActivity ?? '',
      ...(opts.metadata ?? {}),
    },
    sequence: opts.sequence ?? [],
  };
}

function makeCache(...skeletons: any[]): Map<string, any> {
  return new Map(skeletons.map(s => [s.taskId, s]));
}

// ─────────────────── tests ───────────────────

describe('handleSearchTasksSemanticFallback — coverage des branches', () => {

  // ============================================================
  // Correspondance PARTIELLE : specialMatch 'user message' (L117-124)
  // ============================================================
  describe('partial match — specialMatch "user message"', () => {
    test('"user message" matche "User message 1 ..." via specialMatch', async () => {
      const cache = makeCache(makeSkeleton('task-1', {
        sequence: [{ role: 'user', content: 'User message 1 with extra content' }],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'user message' },
        cache
      );

      expect(result.isError).toBe(false);
      expect(result.content.length).toBe(1);
      expect((result.content[0] as any).taskId).toBe('task-1');
    });
  });

  // ============================================================
  // Correspondance PARTIELLE : allWordsMatch multi-mots (L105-124)
  // ============================================================
  describe('partial match — allWordsMatch', () => {
    test('tous les mots de la requête (>1 char) présents → match', async () => {
      const cache = makeCache(makeSkeleton('task-words', {
        sequence: [{ role: 'assistant', content: 'gamma alpha delta beta epsilon' }],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'alpha beta' },
        cache
      );

      expect(result.content.length).toBe(1);
      expect((result.content[0] as any).taskId).toBe('task-words');
    });

    test('un mot de la requête absent → pas de match partiel', async () => {
      const cache = makeCache(makeSkeleton('task-nomatch', {
        sequence: [{ role: 'assistant', content: 'gamma alpha only' }],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'alpha zzzz' },
        cache
      );

      expect(result.content.length).toBe(0);
    });
  });

  // ============================================================
  // truncateMessage : message long (L26-28)
  // ============================================================
  describe('truncateMessage — message long', () => {
    test('un contenu de >4 lignes est tronqué avec [...]', async () => {
      const longContent = 'line0 query\nline1\nline2\nline3\nline4\nline5';
      const cache = makeCache(makeSkeleton('task-long', {
        sequence: [{ role: 'user', content: longContent }],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'query' },
        cache
      );

      expect(result.content.length).toBe(1);
      const match = (result.content[0] as any).match;
      expect(match).toContain('[...]');
      expect(match).toContain('line0 query');
      expect(match).toContain('line5');
    });
  });

  // ============================================================
  // truncateMessage : early-return message falsy (L19-21)
  // ============================================================
  describe('truncateMessage — early return', () => {
    test('un contenu vide avec requête vide déclenche le early-return', async () => {
      // ''.includes('') === true → match exact → truncateMessage('', 2) → !message → return ''
      const cache = makeCache(makeSkeleton('task-empty', {
        sequence: [{ role: 'user', content: '' }],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { search_query: '' },
        cache
      );

      // Le match se produit (includes('') toujours vrai), truncateMessage retourne ''
      expect(result.content.length).toBe(1);
    });
  });

  // ============================================================
  // Defaults metadata (L136-138) : champs manquants
  // ============================================================
  describe('metadata defaults', () => {
    test('metadata sans title/messageCount/lastActivity → valeurs par défaut', async () => {
      const cache = makeCache({
        taskId: 'task-bare',
        metadata: {}, // aucun champ
        sequence: [{ role: 'user', content: 'findme here' }],
      });

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'findme' },
        cache
      );

      expect(result.content.length).toBe(1);
      const meta = (result.content[0] as any).metadata;
      expect(meta.task_title).toBe('Task task-bare'); // || `Task ${taskId}`
      expect(meta.message_count).toBe(0);             // || 0
      expect(meta.last_activity).toBe('');             // || ''
    });
  });

  // ============================================================
  // Global search : skeleton sans sequence (L92, L82-83 DEBUG)
  // ============================================================
  describe('global search — skeleton sans sequence', () => {
    test('une conversation sans sequence ne crashe pas et ne matche pas', async () => {
      const cache = makeCache({
        taskId: 'task-no-seq',
        metadata: { title: 'NoSeq' },
        sequence: undefined, // déclenche `sequence ?? []` (L92) + ternary DEBUG (L82-83)
      });

      const result = await handleSearchTasksSemanticFallback(
        { search_query: 'anything' },
        cache
      );

      expect(result.isError).toBe(false);
      expect(result.content.length).toBe(0);
    });
  });

  // ============================================================
  // Specific search : conversation_id absent → throw (L156-158)
  // ============================================================
  describe('specific search — not found', () => {
    test('conversation_id non présent dans le cache → throw', async () => {
      const cache = makeCache(makeSkeleton('exists'));

      await expect(
        handleSearchTasksSemanticFallback(
          { conversation_id: 'ghost-id', search_query: 'x' },
          cache
        )
      ).rejects.toThrow(/not found in cache/i);
    });
  });

  // ============================================================
  // Specific search : sequence ?? [] (L163) + match (L167-172)
  // ============================================================
  describe('specific search — within conversation', () => {
    test('match exact dans une conversation spécifique', async () => {
      const cache = makeCache(makeSkeleton('conv-1', {
        sequence: [
          { role: 'user', content: 'irrelevant preamble' },
          { role: 'assistant', content: 'the answer is forty-two' },
        ],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { conversation_id: 'conv-1', search_query: 'forty-two' },
        cache
      );

      expect(result.content.length).toBe(1);
      expect((result.content[0] as any).taskId).toBe('conv-1');
    });

    test('conversation sans sequence → résultats vides (sequence ?? [])', async () => {
      const cache = makeCache({
        taskId: 'conv-noseq',
        metadata: { title: 'C' },
        sequence: undefined,
      });

      const result = await handleSearchTasksSemanticFallback(
        { conversation_id: 'conv-noseq', search_query: 'x' },
        cache
      );

      expect(result.isError).toBe(false);
      expect(result.content.length).toBe(0);
    });

    test('max_results plafonne le nombre de résultats', async () => {
      const cache = makeCache(makeSkeleton('conv-cap', {
        sequence: [
          { role: 'user', content: 'hit a' },
          { role: 'user', content: 'hit b' },
          { role: 'user', content: 'hit c' },
        ],
      }));

      const result = await handleSearchTasksSemanticFallback(
        { conversation_id: 'conv-cap', search_query: 'hit', max_results: 2 },
        cache
      );

      expect(result.content.length).toBe(2);
    });
  });
});
