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
 * @issue Epic #2609 V1
 */

import type { StormGuardResult } from './verdict.js';
import { handleDiagnoseSemanticIndex } from '../../src/tools/indexing/diagnose-index.tool.js';
import { getQdrantClient } from '../../src/services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../src/services/openai.js';
import type { ConversationSkeleton } from '../../src/types/conversation.js';

/** Default latency threshold in ms (8 s). Override via EVAL_STORM_LATENCY_MS. */
const DEFAULT_STORM_LATENCY_MS = 8000;

/** Module-level storm state — set by runStormGuard, read by tool tests. */
export let STORM_ACTIVE = false;
export let STORM_GUARD_RESULT: StormGuardResult = {
  active: false,
  probe_latency_ms: 0,
  diagnose_status: 'not_run',
};

/**
 * Run the storm guard probes. Sets STORM_ACTIVE and STORM_GUARD_RESULT.
 *
 * Probe 1: handleDiagnoseSemanticIndex (status !== 'healthy' → INCONCLUSIVE)
 * Probe 2: one tiny embedding + qdrant.search (wall-clock > threshold → INCONCLUSIVE)
 *
 * Safe to call multiple times; uses the same singleton state.
 */
export async function runStormGuard(): Promise<StormGuardResult> {
  const stormLatencyMs =
    parseInt(process.env.EVAL_STORM_LATENCY_MS ?? String(DEFAULT_STORM_LATENCY_MS), 10) ||
    DEFAULT_STORM_LATENCY_MS;

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

  if (diagnoseStatus !== 'healthy') {
    const result: StormGuardResult = {
      active: true,
      probe_latency_ms: 0,
      diagnose_status: diagnoseStatus,
      reason: `Qdrant index not healthy (status=${diagnoseStatus}). Errors: ${diagnoseErrors.join('; ')}`,
    };
    STORM_ACTIVE = true;
    STORM_GUARD_RESULT = result;
    return result;
  }

  // ---- Probe 2: Latency probe (embedding + Qdrant search) ----
  const collectionName = process.env.QDRANT_COLLECTION_NAME ?? 'roo_tasks_semantic_index';
  const probeStart = Date.now();
  let probeLatencyMs = 0;
  let probeError: string | undefined;

  try {
    const openai = getOpenAIClient();
    const model = getEmbeddingModel();
    const embeddingResp = await openai.embeddings.create({
      model,
      input: 'storm guard probe',
    });
    const vector = embeddingResp.data[0].embedding;

    const qdrant = getQdrantClient();
    await qdrant.search(collectionName, { vector, limit: 1 });

    probeLatencyMs = Date.now() - probeStart;
  } catch (err: any) {
    probeLatencyMs = Date.now() - probeStart;
    probeError = err?.message ?? String(err);
  }

  const stormActive = probeError !== undefined || probeLatencyMs > stormLatencyMs;
  const reason = probeError
    ? `Probe failed: ${probeError}`
    : stormActive
    ? `Probe latency ${probeLatencyMs}ms > threshold ${stormLatencyMs}ms (indexing storm suspected)`
    : undefined;

  const result: StormGuardResult = {
    active: stormActive,
    probe_latency_ms: probeLatencyMs,
    diagnose_status: diagnoseStatus,
    reason,
  };

  STORM_ACTIVE = stormActive;
  STORM_GUARD_RESULT = result;
  return result;
}
