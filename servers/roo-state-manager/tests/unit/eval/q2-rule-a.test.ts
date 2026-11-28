/**
 * #4939 — rubric (a) of golden scenario 2 (Epic #2609), pinned in a CI-INCLUDED
 * suite.
 *
 * The live golden suite (tests/eval-harness/**) never runs in CI, so the rule
 * that grades it must be pinned where CI runs. Same reason and same shape as
 * tests/unit/eval/q4-rubric.test.ts.
 *
 * What this pins:
 *  - a machine output is never a human passage (the historical rule);
 *  - a HARNESS-INJECTED turn (compaction summary, resume instruction,
 *    scheduler prompt) is never a human passage either — the harness writes
 *    into the `user` role and those turns carry the coordination vocabulary a
 *    decision passage should carry;
 *  - the exclusion is by FORM, never by vocabulary: a human sentence naming the
 *    compaction still counts;
 *  - the rollback switch covers the WHOLE rule, carried kind included.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { classifyQ2HumanPassage } from '../../eval-harness/q2-rule-a.js';

// Opens with the exact envelope the harness writes (see
// HARNESS_TURN_OPENINGS in src/tools/search/search-semantic.tool.ts).
const COMPACTION_SUMMARY =
  'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation. The arbitrations read '
  + 'from the evidence files are unchanged, and the decision on the cadence remains open.';
const RESUME_PROMPT =
  'Continue the conversation from where it left off without asking the user any further '
  + 'questions. Resume directly — no apology, no recap of what you were doing.';
const SCHEDULED_PROMPT =
  'Run this single MCP tool call and report the result: roosync_dashboard read workspace';
const DECISION_PASSAGE =
  'Décision user du 27/10 sur RX126 : option (a). Les machines de la flotte appellent '
  + 'l embedder directement sur le réseau local, et IIS ne sert plus qu aux accès externes.';
const PROSE_NAMING_COMPACTION =
  'La compaction du contexte ne change rien à l arbitrage du 27/11 : la décision reste '
  + 'l option (a), et la mesure du budget d archives a été reprise depuis le fichier de preuve.';

describe('#4939 q2 rubric (a): the best passage must be human-authored prose', () => {
  afterEach(() => {
    delete process.env.SEMANTIC_HARNESS_TURN_MALUS;
  });

  test('an ordinary decision passage counts', () => {
    const verdict = classifyQ2HumanPassage({ snippet: DECISION_PASSAGE, chunk_type: 'message_exchange' });
    expect(verdict.ok).toBe(true);
    expect(verdict.observed).toBe('prose');
  });

  test('machine output never counts, by marker or by the engine label', () => {
    const toolResult = '[tool_result] Result: ' + DECISION_PASSAGE;
    expect(classifyQ2HumanPassage({ snippet: toolResult, chunk_type: 'message_exchange' }).ok).toBe(false);
    expect(classifyQ2HumanPassage({ snippet: DECISION_PASSAGE, chunk_type: 'tool_interaction' }).ok).toBe(false);
    expect(classifyQ2HumanPassage({ snippet: DECISION_PASSAGE, machine_output_kind: 'json' }).ok).toBe(false);
  });

  test('a compaction summary never counts, by the fallback classifier', () => {
    const verdict = classifyQ2HumanPassage({ snippet: COMPACTION_SUMMARY, chunk_type: 'message_exchange' });
    expect(verdict.ok).toBe(false);
    expect(verdict.observed).toBe('compaction_summary');
  });

  test('a resume instruction and a scheduler prompt never count either', () => {
    expect(classifyQ2HumanPassage({ snippet: RESUME_PROMPT, chunk_type: 'message_exchange' }).ok).toBe(false);
    expect(classifyQ2HumanPassage({ snippet: SCHEDULED_PROMPT, chunk_type: 'message_exchange' }).ok).toBe(false);
  });

  test('a compaction summary never counts, by the kind the engine carried', () => {
    const verdict = classifyQ2HumanPassage({
      snippet: DECISION_PASSAGE,
      chunk_type: 'message_exchange',
      harness_turn_kind: 'compaction_summary',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.observed).toBe('compaction_summary');
  });

  test('a chunk of an unknown tool continuation never counts', () => {
    expect(classifyQ2HumanPassage({ snippet: DECISION_PASSAGE, tool_continuation_status: 'unknown' }).ok).toBe(false);
  });

  test('a human sentence naming the compaction still counts (the negative witness)', () => {
    expect(classifyQ2HumanPassage({ snippet: PROSE_NAMING_COMPACTION, chunk_type: 'message_exchange' }).ok).toBe(true);
  });

  test('rollback: the switch covers the whole rule — the fallback excludes nothing', () => {
    process.env.SEMANTIC_HARNESS_TURN_MALUS = '0';
    const verdict = classifyQ2HumanPassage({ snippet: COMPACTION_SUMMARY, chunk_type: 'message_exchange' });
    expect(verdict.ok).toBe(true);
    expect(verdict.observed).toBe('prose');
  });

  test('rollback: the carried kind is not honoured either (the policy is whole or absent)', () => {
    process.env.SEMANTIC_HARNESS_TURN_MALUS = '0';
    expect(classifyQ2HumanPassage({
      snippet: DECISION_PASSAGE,
      chunk_type: 'message_exchange',
      harness_turn_kind: 'compaction_summary',
    }).ok).toBe(true);
  });

  test('an absent chunk never counts', () => {
    expect(classifyQ2HumanPassage(null).ok).toBe(false);
    expect(classifyQ2HumanPassage(undefined).ok).toBe(false);
  });
});
