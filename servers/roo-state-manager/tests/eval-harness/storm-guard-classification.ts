/**
 * storm-guard-classification.ts — Pure classification logic for the storm guard.
 *
 * Split out of storm-guard.ts (#2609/#4104, dispatch c.22 item 5) so it carries
 * NO service imports and can be unit-tested under the CI config
 * (tests/eval-harness/** is CI-excluded; tests/unit/** is not).
 *
 * Why: the legacy probe measured ONE combined wall-clock around
 * embedding-create + qdrant.search against a single threshold. A degraded
 * embedding path (~15 s/call with a perfectly healthy Qdrant) and a genuine
 * indexing storm both fired "storm" — the operator could not tell whether to
 * wait out the storm or fix the embedder. This module classifies the two
 * legs independently.
 *
 * @issue Epic #2609 V2, #4104
 */

/** Verdict of the guard. Ordered by decision precedence. */
export type StormClassification = 'ok' | 'storm' | 'slow_embedding' | 'probe_failed';

/**
 * Measured probe inputs. `undefined` legs = not measured (probe 1
 * short-circuited before probe 2, or that leg threw).
 */
export interface StormGuardProbeInput {
  /** Status from handleDiagnoseSemanticIndex ('healthy' | anything else). */
  diagnose_status: string;
  /** Errors reported by the diagnose probe, for the reason string. */
  diagnose_errors?: string[];
  /** Wall-clock of the openai.embeddings.create leg alone, in ms. */
  embedding_latency_ms?: number;
  /** Wall-clock of the qdrant.search leg alone, in ms. */
  search_latency_ms?: number;
  /** Error message if either probe-2 leg threw. */
  probe_error?: string;
}

/** Thresholds in ms; each leg is judged independently. */
export interface StormGuardThresholds {
  search_ms: number;
  embedding_ms: number;
}

export interface StormGuardDecision {
  classification: StormClassification;
  /** Whether tool tests must short-circuit to INCONCLUSIVE. */
  active: boolean;
  /** Human-readable justification when active. */
  reason?: string;
}

/**
 * Default search-leg threshold (8 s) — unchanged from the legacy combined
 * probe. Override via EVAL_STORM_SEARCH_MS (or legacy EVAL_STORM_LATENCY_MS).
 */
export const DEFAULT_STORM_SEARCH_MS = 8000;

/**
 * Default embedding-leg threshold (15 s) — calibrated on the observed
 * degraded-embedding episodes (dispatch #2609 c.22 item 5: "~15 s, Qdrant
 * sain"). Override via EVAL_STORM_EMBEDDING_MS.
 */
export const DEFAULT_STORM_EMBEDDING_MS = 15000;

/** Resolve thresholds from an env-like record. Pure; pass process.env at the edge. */
export function resolveStormGuardThresholds(
  env: Record<string, string | undefined> = {}
): StormGuardThresholds {
  const searchRaw = env.EVAL_STORM_SEARCH_MS ?? env.EVAL_STORM_LATENCY_MS;
  const embedRaw = env.EVAL_STORM_EMBEDDING_MS;
  return {
    search_ms: parseInt(searchRaw ?? '', 10) || DEFAULT_STORM_SEARCH_MS,
    embedding_ms: parseInt(embedRaw ?? '', 10) || DEFAULT_STORM_EMBEDDING_MS,
  };
}

/**
 * Classify the probe outcome. Decision precedence:
 *
 * 1. probe_error      → probe_failed (active)
 * 2. diagnose unhealthy → storm (active) — definitively a Qdrant problem
 * 3. search leg slow  → storm (active)
 * 4. embedding leg slow (search fast) → slow_embedding (active) — embedder
 *    degraded, NOT an indexing storm; tests still short-circuit because every
 *    roosync_search pays the embedding cost, but the operator knows the fix
 *    target is the embedder path, not Qdrant.
 * 5. otherwise        → ok
 *
 * Threshold comparisons are strictly greater-than, matching the legacy `>`
 * semantics on the combined probe.
 */
export function classifyStormGuard(
  input: StormGuardProbeInput,
  thresholds: StormGuardThresholds
): StormGuardDecision {
  // 1. Either probe-2 leg threw — attribute honestly.
  if (input.probe_error) {
    return {
      classification: 'probe_failed',
      active: true,
      reason: `Probe failed: ${input.probe_error}`,
    };
  }

  // 2. Qdrant index unhealthy — real Qdrant problem, no point probing latency.
  if (input.diagnose_status !== 'healthy') {
    const errors = input.diagnose_errors?.length
      ? ` Errors: ${input.diagnose_errors.join('; ')}`
      : '';
    return {
      classification: 'storm',
      active: true,
      reason: `Qdrant index not healthy (status=${input.diagnose_status}).${errors}`,
    };
  }

  const embedMs = input.embedding_latency_ms ?? 0;
  const searchMs = input.search_latency_ms ?? 0;
  const searchSlow = searchMs > thresholds.search_ms;
  const embedSlow = embedMs > thresholds.embedding_ms;

  // 3. Search leg slow — storm signature dominates, even if embedding is slow too.
  if (searchSlow) {
    const both = embedSlow ? ` (embedding path slow too: ${embedMs}ms > ${thresholds.embedding_ms}ms)` : '';
    return {
      classification: 'storm',
      active: true,
      reason: `Qdrant search latency ${searchMs}ms > threshold ${thresholds.search_ms}ms (indexing storm suspected)${both}`,
    };
  }

  // 4. Embedding leg slow, search fast, Qdrant healthy — the case the legacy
  //    combined probe could not tell apart from a storm.
  if (embedSlow) {
    return {
      classification: 'slow_embedding',
      active: true,
      reason: `Embedding path slow: ${embedMs}ms > threshold ${thresholds.embedding_ms}ms, Qdrant search fast (${searchMs}ms <= ${thresholds.search_ms}ms) and healthy — embedder degraded, not an indexing storm`,
    };
  }

  // 5. Healthy and fast.
  return { classification: 'ok', active: false };
}
