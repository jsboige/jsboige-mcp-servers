/**
 * verdict-artifact.ts — #2609 review (MINOR): the golden gates must leave a
 * MEASURABLE trace.
 *
 * Before this module, every INCONCLUSIVE branch of the live eval suite
 * asserted a tautology and returned: the vitest run stayed green without ever
 * measuring the gate. And tests/eval-harness/** is excluded from CI
 * (vitest.config.ci.ts), so nothing turned a textual verdict into a distinct
 * process state — a gate that does not measure is a false gate.
 *
 * The verdict is now written as a STRUCTURED artifact (one JSON file per
 * scenario), and qualify-verdicts.ts turns those artifacts into an exit code:
 * no artifact, any FAIL, and any unexpected INCONCLUSIVE fail the
 * qualification.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, VerdictOutcome } from './verdict.js';

export interface VerdictArtifact {
  /** Tool under test, e.g. "roosync_search" */
  tool: string;
  /** Golden scenario id, e.g. "scenario-2-decision-passage" */
  scenario: string;
  /** PASS | FAIL | INCONCLUSIVE */
  verdict: VerdictOutcome;
  /** Why (mandatory for FAIL / INCONCLUSIVE) */
  reason: string;
  /** Per-assertion results */
  checks: CheckResult[];
  /** Wall-clock latency of the measured call in ms */
  latency_ms: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

export const VERDICT_DIR_ENV = 'EVAL_VERDICT_DIR';
export const DEFAULT_VERDICT_DIR_NAME = '.eval-verdicts';

/** Directory the verdict artifacts are written to / read from. */
export function verdictDir(): string {
  return process.env[VERDICT_DIR_ENV] || join(process.cwd(), DEFAULT_VERDICT_DIR_NAME);
}

/** Write one verdict artifact (JSON) and return its path. */
export function writeVerdictArtifact(artifact: VerdictArtifact): string {
  const dir = verdictDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${artifact.tool}-${artifact.scenario}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2), 'utf8');
  return file;
}

/** Read every verdict artifact of a directory (empty when the dir is absent). */
export function readVerdictArtifacts(dir: string = verdictDir()): VerdictArtifact[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as VerdictArtifact);
}

export interface QualificationReport {
  /** true only when every measured artifact is PASS (or an opted-in INCONCLUSIVE) */
  ok: boolean;
  /** Number of artifacts read */
  measured: number;
  pass: number;
  fail: number;
  inconclusive: number;
  /** Human-readable reasons why the qualification failed */
  problems: string[];
}

/**
 * Turn verdict artifacts into a qualification decision.
 *
 * - no artifact at all -> NOT qualified (the gates measured nothing)
 * - any FAIL -> NOT qualified
 * - any INCONCLUSIVE -> NOT qualified, unless the caller explicitly opts in
 *   (a documented environment outage), because an unmeasured gate is not a
 *   passing gate.
 */
export function qualifyVerdicts(
  artifacts: VerdictArtifact[],
  options: { allowInconclusive?: boolean } = {}
): QualificationReport {
  const problems: string[] = [];
  if (artifacts.length === 0) {
    problems.push('no verdict artifact found: the golden gates measured nothing on this run');
  }
  let pass = 0;
  let fail = 0;
  let inconclusive = 0;
  for (const artifact of artifacts) {
    if (artifact.verdict === 'PASS') {
      pass++;
      continue;
    }
    if (artifact.verdict === 'FAIL') {
      fail++;
      problems.push(`${artifact.tool}/${artifact.scenario}: FAIL - ${artifact.reason}`);
      continue;
    }
    inconclusive++;
    if (!options.allowInconclusive) {
      problems.push(`${artifact.tool}/${artifact.scenario}: INCONCLUSIVE - ${artifact.reason}`);
    }
  }
  return { ok: problems.length === 0, measured: artifacts.length, pass, fail, inconclusive, problems };
}
