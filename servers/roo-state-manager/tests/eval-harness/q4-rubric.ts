/**
 * q4-rubric.ts — rubric (a) of golden scenario 4 (Epic #2609) as a pure
 * predicate, so that a CI-included suite can pin it: tests/eval-harness/**
 * never runs in CI (tests/unit/eval/q4-rubric.test.ts).
 *
 * RX133 (user, 2026-11-01, option c): a request is excluded by its FORM, never
 * by a substring. The form is the passage floor: under 100 chars a chunk is not
 * a passage, whatever it says, so a bare request ("Représente moi stp tous les
 * arbitrages en détail…", 73 c) never counts. Above the floor a chunk is a
 * passage even when it quotes a request. The former substring rule rejected a
 * 298-char analysis for quoting « REdétaille les arbitrages stp » (live run on
 * ai-01, 2026-11-01): the measuring rule produced the false negative it was
 * meant to catch.
 *
 * The engine applies the same principle to its ranking (request malus in
 * search-semantic.tool.ts). The rule is written here again, not imported: the
 * harness must not grade the engine's request handling with the engine's own
 * request classifier.
 */

import { classifyMachineOutput } from '../../src/tools/search/search-semantic.tool.js';

/** Epic #2609 rubric (a): a passage is at least this long; a shorter chunk is a fragment or a bare request. */
export const PASSAGE_FLOOR_CHARS = 100;

const DECISION_VOCABULARY = /arbitrage|décision|decision|en attente|pending|ouverte?/i;

export interface RubricChunk {
  snippet?: string;
  chunk_type?: unknown;
  machine_output_kind?: string | null;
  tool_continuation_status?: string;
}

export interface RubricGroup {
  taskId?: string;
  chunks?: RubricChunk[];
}

/** A human-authored passage about a decision: long enough, not machine output, on topic. */
export function isHumanDecisionPassage(chunk: RubricChunk | undefined): boolean {
  const snippet = chunk?.snippet ?? '';
  return snippet.length >= PASSAGE_FLOOR_CHARS
    && (chunk?.machine_output_kind ?? classifyMachineOutput(chunk?.chunk_type, snippet)) === null
    && chunk?.tool_continuation_status !== 'unknown'
    && DECISION_VOCABULARY.test(snippet);
}

/** Rubric (a): at least 2 decision passages, from at least 2 conversations, in the top 3 groups. */
export function decisionPassagesInTop3(results: RubricGroup[] | undefined): { ok: boolean; passages: RubricGroup[] } {
  const passages = (results ?? []).slice(0, 3).filter(r => isHumanDecisionPassage(r?.chunks?.[0]));
  const ok = passages.length >= 2 && new Set(passages.map(r => r.taskId)).size >= 2;
  return { ok, passages };
}
