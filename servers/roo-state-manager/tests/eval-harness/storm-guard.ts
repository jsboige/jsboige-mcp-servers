/**
 * storm-guard.ts — Pre-flight latency/health probe for the eval harness.
 *
 * Runs once before all tool tests. If Qdrant is unhealthy or responding too
 * slowly (e.g. indexing storm — CPU ~1190%), sets STORM_ACTIVE=true so every
 * tool test short-circuits to INCONCLUSIVE instead of recording spurious FAILs.
 *
 * Expected behaviour during Qdrant indexing storm: probe latency > threshold,
 * storm guard fires, all tests return INCONCLUSIVE — this is correct.
 *
 * #2609 V2 / #4104 (split-timing): probe 2 now times the embedding call and
 * the Qdrant search SEPARATELY. A degraded embedding path (~15 s/call, Qdrant
 * healthy and fast) fires the guard as `slow_embedding` — still INCONCLUSIVE,
 * but the verdict names the embedder as the cause instead of a storm. The
 * classification logic lives in storm-guard-classification.ts (pure, CI-tested).
 *
 * @issue Epic #2609 V2
 */

import type { StormGuardResult } from './verdict.js';
import { classifyStormGuard, resolveStormGuardThresholds } from './storm-guard-classification.js';
import { handleDiagnoseSemanticIndex } from '../../src/tools/indexing/diagnose-index.tool.js';
import { getQdrantClient } from '../../src/services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../src/services/openai.js';
import type { ConversationSkeleton } from '../../src/types/conversation.js';

/** Module-level storm state — set by runStormGuard, read by tool tests. */
export let STORM_ACTIVE = false;
export let STORM_GUARD_RESULT: StormGuardResult = {
  active: false,
  probe_latency_ms: 0,
  diagnose_status: 'not_run',
  classification: 'ok',
};

/**
 * Run the storm guard probes. Sets STORM_ACTIVE and STORM_GUARD_RESULT.
 *
 * Probe 1: handleDiagnoseSemanticIndex (status !== 'healthy' → storm, unmeasured legs)
 * Probe 2: one tiny embedding (timed) + qdrant.search (timed) — each leg judged
 * against its own threshold; see storm-guard-classification.ts for precedence.
 *
 * Safe to call multiple times; uses the same singleton state.
 */
export async function runStormGuard(): Promise<StormGuardResult> {
  const thresholds = resolveStormGuardThresholds(process.env);

  let diagnoseStatus = 'unknown';
  let diagnoseErrors: string[] = [];

  // ---- Probe 1: Diagnose index health ----
  try {
    const diagnoseResult = await handleDiagnoseSemanticIndex(new Map<string, ConversationSkeleton>());
    const rawItem = diagnoseResult.content?.[0];
    const text: string = (rawItem && 'text' in rawItem) ? (rawItem as { text: string }).text : '';
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // text may not be JSON — treat as unknown
    }
    diagnoseStatus = parsed?.status ?? (diagnoseResult.isError ? 'error' : 'unknown');
    diagnoseErrors = Array.isArray(parsed?.errors) ? parsed.errors : [];
  } catch (err: any) {
    diagnoseStatus = 'probe_failed';
    diagnoseErrors = [err?.message ?? String(err)];
  }

  // ---- Probe 2: Latency probe (embedding + Qdrant search, timed separately) ----
  const collectionName = process.env.QDRANT_COLLECTION_NAME ?? 'roo_tasks_semantic_index';
  const probeStart = Date.now();
  let embeddingLatencyMs: number | undefined;
  let searchLatencyMs: number | undefined;
  let probeError: string | undefined;

  if (diagnoseStatus === 'healthy') {
    try {
      const openai = getOpenAIClient();
      const model = getEmbeddingModel();
      const embedStart = Date.now();
      const embeddingResp = await openai.embeddings.create({
        model,
        input: 'storm guard probe',
      });
      embeddingLatencyMs = Date.now() - embedStart;
      const vector = embeddingResp.data[0].embedding;

      const qdrant = getQdrantClient();
      const searchStart = Date.now();
      await qdrant.search(collectionName, { vector, limit: 1 });
      searchLatencyMs = Date.now() - searchStart;
    } catch (err: any) {
      probeError = err?.message ?? String(err);
    }
  }
  // Legacy combined figure — kept for verdict.ts compatibility.
  const probeLatencyMs = Date.now() - probeStart;

  // ---- Classification (pure — see storm-guard-classification.ts) ----
  const decision = classifyStormGuard(
    {
      diagnose_status: diagnoseStatus,
      diagnose_errors: diagnoseErrors,
      embedding_latency_ms: embeddingLatencyMs,
      search_latency_ms: searchLatencyMs,
      probe_error: probeError,
    },
    thresholds
  );

  const result: StormGuardResult = {
    active: decision.active,
    probe_latency_ms: probeLatencyMs,
    diagnose_status: diagnoseStatus,
    reason: decision.reason,
    classification: decision.classification,
    embedding_latency_ms: embeddingLatencyMs,
    search_latency_ms: searchLatencyMs,
  };

  STORM_ACTIVE = decision.active;
  STORM_GUARD_RESULT = result;
  return result;
}
