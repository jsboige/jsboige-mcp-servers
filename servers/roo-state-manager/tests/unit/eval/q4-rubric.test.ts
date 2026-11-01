/**
 * #2609 scenario 4, RX133 (user 2026-11-01, option c): the measuring rule is
 * pinned HERE, in a CI-included suite, because the live golden suite
 * (tests/eval-harness/**) never runs in CI.
 *
 * Two decisions are pinned:
 *  - rubric (a) excludes a request by its FORM (the passage floor), never by a
 *    substring: the former rule rejected a 298-char analysis for quoting
 *    « REdétaille les arbitrages stp »;
 *  - scenario 4 is a SET of wordings that differ only by their wording.
 */

import { describe, test, expect } from 'vitest';
import {
  PASSAGE_FLOOR_CHARS,
  decisionPassagesInTop3,
  isHumanDecisionPassage,
  type RubricGroup,
} from '../../eval-harness/q4-rubric.js';
import { CROSS_CONVERSATION_QUERIES, CROSS_CONVERSATION_QUERY } from '../../eval-harness/golden-queries.js';

// Shape of the analysis the substring rule rejected on the live page (ai-01, 2026-11-01).
const ANALYSIS_QUOTING_A_REQUEST =
  'Clear signal: with `exclude_tool_results`, structure improves (7 context groups, 4 machines) '
  + 'but top snippets are user **questions** ("REdétaille les arbitrages stp") while the actual '
  + 'decision passages sit lower in the pool.';
// The live rank-1 request of 2026-11-01 (73 chars).
const BARE_REQUEST = 'Représente moi stp tous les arbitrages en détail avec tes recommandations';
const DECISION_PASSAGE =
  'Décision user du 27/10 sur RX126 : option (a). Les machines de la flotte appellent l\'embedder '
  + 'directement sur le réseau local, et IIS ne sert plus qu\'aux accès externes.';
const OFF_TOPIC_PROSE =
  'J\'ai filé à vllm un nouveau token HF, fais le toi envoyer par lui puis relance le conteneur '
  + 'quand le téléchargement du modèle est fini.';

const group = (taskId: string, snippet: string, extra: Record<string, unknown> = {}): RubricGroup =>
  ({ taskId, chunks: [{ snippet, chunk_type: 'message_exchange', ...extra }] });

describe('#2609 q4 rubric (a): a request is excluded by its form, never by a substring (RX133)', () => {
  test('a passage that quotes a request still counts (the 298-char false negative)', () => {
    expect(ANALYSIS_QUOTING_A_REQUEST.length).toBeGreaterThanOrEqual(PASSAGE_FLOOR_CHARS);
    expect(ANALYSIS_QUOTING_A_REQUEST).toMatch(/REdétaille les arbitrages stp/);
    expect(isHumanDecisionPassage({ snippet: ANALYSIS_QUOTING_A_REQUEST, chunk_type: 'message_exchange' })).toBe(true);
  });

  test('a bare request under the passage floor never counts', () => {
    expect(BARE_REQUEST.length).toBeLessThan(PASSAGE_FLOOR_CHARS);
    expect(isHumanDecisionPassage({ snippet: BARE_REQUEST, chunk_type: 'message_exchange' })).toBe(false);
  });

  test('the floor is the form: 99 chars do not count, 100 chars do', () => {
    const at = (n: number) => ('arbitrage ' + 'x'.repeat(200)).slice(0, n);
    expect(isHumanDecisionPassage({ snippet: at(PASSAGE_FLOOR_CHARS - 1) })).toBe(false);
    expect(isHumanDecisionPassage({ snippet: at(PASSAGE_FLOOR_CHARS) })).toBe(true);
  });

  test('a decision passage counts', () => {
    expect(isHumanDecisionPassage({ snippet: DECISION_PASSAGE, chunk_type: 'message_exchange' })).toBe(true);
  });

  test('machine output never counts, by marker or by the engine label', () => {
    const toolResult = '[tool_result] Result: ' + DECISION_PASSAGE;
    expect(isHumanDecisionPassage({ snippet: toolResult, chunk_type: 'message_exchange' })).toBe(false);
    expect(isHumanDecisionPassage({ snippet: DECISION_PASSAGE, chunk_type: 'tool_interaction' })).toBe(false);
    expect(isHumanDecisionPassage({ snippet: DECISION_PASSAGE, machine_output_kind: 'json' })).toBe(false);
  });

  test('a chunk of an unknown tool continuation never counts', () => {
    expect(isHumanDecisionPassage({ snippet: DECISION_PASSAGE, tool_continuation_status: 'unknown' })).toBe(false);
  });

  test('a long passage off the topic does not count', () => {
    expect(OFF_TOPIC_PROSE.length).toBeGreaterThanOrEqual(PASSAGE_FLOOR_CHARS);
    expect(isHumanDecisionPassage({ snippet: OFF_TOPIC_PROSE })).toBe(false);
  });

  test('a missing chunk does not count', () => {
    expect(isHumanDecisionPassage(undefined)).toBe(false);
    expect(isHumanDecisionPassage({})).toBe(false);
  });
});

describe('#2609 q4 rubric (a): two passages from two conversations in the top 3', () => {
  test('passes with a decision passage and an analysis that quotes a request, from two tasks', () => {
    const page = [group('A', DECISION_PASSAGE), group('B', ANALYSIS_QUOTING_A_REQUEST), group('C', OFF_TOPIC_PROSE)];
    const { ok, passages } = decisionPassagesInTop3(page);
    expect(ok).toBe(true);
    expect(passages.map(p => p.taskId)).toEqual(['A', 'B']);
  });

  test('fails when both passages come from the same conversation', () => {
    const page = [group('A', DECISION_PASSAGE), group('A', ANALYSIS_QUOTING_A_REQUEST), group('C', OFF_TOPIC_PROSE)];
    expect(decisionPassagesInTop3(page).ok).toBe(false);
  });

  test('a passage below rank 3 does not count', () => {
    const page = [group('A', DECISION_PASSAGE), group('B', BARE_REQUEST), group('C', OFF_TOPIC_PROSE), group('D', ANALYSIS_QUOTING_A_REQUEST)];
    expect(decisionPassagesInTop3(page).ok).toBe(false);
  });

  test('fails when the bare request takes a top-3 slot instead of a passage', () => {
    const page = [group('A', BARE_REQUEST), group('B', DECISION_PASSAGE), group('C', OFF_TOPIC_PROSE)];
    expect(decisionPassagesInTop3(page).ok).toBe(false);
  });

  test('an empty or absent page fails', () => {
    expect(decisionPassagesInTop3([]).ok).toBe(false);
    expect(decisionPassagesInTop3(undefined).ok).toBe(false);
  });
});

describe('#2609 scenario 4 is a set of wordings (RX133)', () => {
  test('holds 3 or 4 wordings with distinct scenario ids and distinct queries', () => {
    expect(CROSS_CONVERSATION_QUERIES.length).toBeGreaterThanOrEqual(3);
    expect(CROSS_CONVERSATION_QUERIES.length).toBeLessThanOrEqual(4);
    expect(new Set(CROSS_CONVERSATION_QUERIES.map(g => g.scenario)).size).toBe(CROSS_CONVERSATION_QUERIES.length);
    expect(new Set(CROSS_CONVERSATION_QUERIES.map(g => g.query.args.search_query)).size).toBe(CROSS_CONVERSATION_QUERIES.length);
  });

  test('the historical query comes first and keeps its scenario id', () => {
    expect(CROSS_CONVERSATION_QUERIES[0].scenario).toBe('scenario-4-cross-conversation');
    expect(CROSS_CONVERSATION_QUERIES[0].query).toBe(CROSS_CONVERSATION_QUERY);
  });

  test('only the wording varies: every other argument equals the historical query', () => {
    const { search_query: _historical, ...historicalRest } = CROSS_CONVERSATION_QUERY.args;
    for (const { query } of CROSS_CONVERSATION_QUERIES) {
      const { search_query, ...rest } = query.args;
      expect(typeof search_query).toBe('string');
      expect(rest).toEqual(historicalRest);
      expect(query.tool).toBe(CROSS_CONVERSATION_QUERY.tool);
    }
  });
});
