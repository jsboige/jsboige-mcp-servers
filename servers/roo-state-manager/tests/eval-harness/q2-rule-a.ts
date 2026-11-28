/**
 * q2-rule-a.ts — rubric (a) of golden scenario 2 (Epic #2609) as a pure
 * predicate, so that a CI-included suite can pin it: the live golden suite
 * (tests/eval-harness/**) never runs in CI.
 *
 * Same shape and same reason as q4-rubric.ts: the live suite grades a live
 * page, the rule itself must be pinned where CI runs
 * (tests/unit/eval/q2-rule-a.test.ts).
 *
 * #4939: the harness writes into the `user` role — a compaction summary, a
 * resume instruction, a scheduler prompt — and those turns carry the
 * coordination vocabulary a decision passage should carry. Measured 2026-11-27
 * (bench #2609, 01:37Z): on q2 the best passage WAS a compaction summary. It
 * states no human decision, so the rule excludes it by FORM, exactly like
 * machine output, never by vocabulary.
 *
 * The engine's own classification is preferred when the chunk carries it
 * (`machine_output_kind`, `harness_turn_kind`); the classifier is the fallback
 * for a chunk that carries neither.
 */

import { classifyMachineOutput, effectiveHarnessTurnKindOf } from '../../src/tools/search/search-semantic.tool.js';

export interface Q2BestChunk {
  snippet?: string;
  chunk_type?: unknown;
  machine_output_kind?: string | null;
  /** #4939: the harness envelope the engine recognised, when it carried one. */
  harness_turn_kind?: string | null;
  tool_continuation_status?: string;
}

export interface Q2HumanPassageVerdict {
  ok: boolean;
  /** What was seen: the machine kind, the harness kind, or 'prose'. */
  observed: string;
}

/**
 * Rubric (a) of q2: the best passage must be human-authored prose — not
 * machine output, not a harness-injected turn, and not of unknown tool
 * continuation.
 */
export function classifyQ2HumanPassage(bestChunk: Q2BestChunk | null | undefined): Q2HumanPassageVerdict {
  const snippet = bestChunk?.snippet ?? '';
  const machineKind = bestChunk?.machine_output_kind ?? classifyMachineOutput(bestChunk?.chunk_type, snippet);
  const harnessKind = effectiveHarnessTurnKindOf(bestChunk?.harness_turn_kind, snippet);
  // An absent chunk is not evidence: the rule grades a passage, and nothing was
  // found. The live suite carries the other gates of rubric (a) — the passage
  // floor and the known-answer vocabulary — separately; this predicate grades
  // the AUTHORSHIP only.
  const ok = !!bestChunk
    && snippet.length > 0
    && machineKind === null
    && harnessKind === null
    && bestChunk?.tool_continuation_status !== 'unknown';
  return { ok, observed: !bestChunk ? 'absent' : harnessKind ?? machineKind ?? 'prose' };
}
