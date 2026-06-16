/**
 * verdict.ts — Structured output types for the eval harness.
 *
 * Designed for future V2 cron→dashboard pipeline:
 * - HarnessRun can be serialized to JSON and posted as a dashboard message.
 * - ToolVerdict.checks provides per-assertion granularity for debugging.
 *
 * @issue Epic #2609 V1
 */

export type VerdictOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface CheckResult {
  /** Short assertion name, e.g. "results.length > 0" */
  name: string;
  /** Whether the check passed */
  ok: boolean;
  /** Human-readable observed value (optional, for debugging) */
  observed?: string;
}

export interface ToolVerdict {
  /** Tool name, e.g. "roosync_search" */
  tool: string;
  /** The query that was sent */
  query: Record<string, unknown>;
  /** Overall verdict for this tool */
  verdict: VerdictOutcome;
  /** Human-readable reason (especially useful for INCONCLUSIVE/FAIL) */
  reason: string;
  /** Wall-clock latency of the tool call in ms */
  latency_ms: number;
  /** Per-assertion results */
  checks: CheckResult[];
  /** ISO 8601 timestamp */
  timestamp: string;
}

export interface StormGuardResult {
  /** Whether the storm guard fired (latency too high or Qdrant unhealthy) */
  active: boolean;
  /** Latency measured by the probe embedding + search in ms */
  probe_latency_ms: number;
  /** Status from handleDiagnoseSemanticIndex */
  diagnose_status: string;
  /** Reason if active */
  reason?: string;
}

export interface HarnessRun {
  /** Unique run ID (ISO timestamp + random suffix) */
  run_id: string;
  started_at: string;
  finished_at: string;
  config: {
    dual_write: boolean;
    qdrant_url: string;
    collection: string;
    embedding_model: string;
  };
  storm_guard: StormGuardResult;
  verdicts: ToolVerdict[];
  summary: {
    pass: number;
    fail: number;
    inconclusive: number;
  };
}

/**
 * Build a summary from an array of tool verdicts.
 */
export function buildSummary(verdicts: ToolVerdict[]): HarnessRun['summary'] {
  return verdicts.reduce(
    (acc, v) => {
      acc[v.verdict.toLowerCase() as 'pass' | 'fail' | 'inconclusive']++;
      return acc;
    },
    { pass: 0, fail: 0, inconclusive: 0 }
  );
}

/**
 * Print a human-readable run report to stdout.
 */
export function printRunReport(run: HarnessRun): void {
  const { summary, storm_guard, verdicts } = run;
  console.log('\n========== EVAL HARNESS RUN REPORT ==========');
  console.log(`Run ID   : ${run.run_id}`);
  console.log(`Started  : ${run.started_at}`);
  console.log(`Finished : ${run.finished_at}`);
  console.log(`Config   : Qdrant=${run.config.qdrant_url} collection=${run.config.collection}`);
  console.log(`DualWrite: ${run.config.dual_write}`);
  console.log('---');
  console.log(`Storm guard: active=${storm_guard.active} latency=${storm_guard.probe_latency_ms}ms diagnose=${storm_guard.diagnose_status}`);
  if (storm_guard.reason) console.log(`  Reason: ${storm_guard.reason}`);
  console.log('---');
  for (const v of verdicts) {
    const icon = v.verdict === 'PASS' ? 'OK' : v.verdict === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`[${icon}] ${v.tool} — ${v.reason} (${v.latency_ms}ms)`);
    for (const c of v.checks) {
      const mark = c.ok ? '  + ' : '  - ';
      const obs = c.observed ? ` [got: ${c.observed}]` : '';
      console.log(`${mark}${c.name}${obs}`);
    }
  }
  console.log('---');
  console.log(`Summary  : PASS=${summary.pass} FAIL=${summary.fail} INCONCLUSIVE=${summary.inconclusive}`);
  console.log('=============================================\n');
}
