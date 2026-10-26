/**
 * #2609 review (MINOR): the qualification gate itself must be measured.
 *
 * The live golden suite (tests/eval-harness/**) never runs in CI, so the
 * qualification logic it depends on is pinned HERE, in a CI-included suite
 * (tests/unit/**): a qualification that no artifact, an unexpected
 * INCONCLUSIVE or a FAIL must fail.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qualifyVerdicts,
  readVerdictArtifacts,
  writeVerdictArtifact,
  type VerdictArtifact,
} from '../../eval-harness/verdict-artifact.js';

describe('#2609 review: structured verdict artifacts', () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-verdicts-'));
    previousDir = process.env.EVAL_VERDICT_DIR;
    process.env.EVAL_VERDICT_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.EVAL_VERDICT_DIR;
    else process.env.EVAL_VERDICT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const artifact = (over: Partial<VerdictArtifact> = {}): VerdictArtifact => ({
    tool: 'roosync_search',
    scenario: 'scenario-2-decision-passage',
    verdict: 'PASS',
    reason: 'all gates measured',
    checks: [{ name: 'results.length > 0', ok: true }],
    latency_ms: 42,
    timestamp: '2026-10-26T00:00:00.000Z',
    ...over,
  });

  test('writes and reads back a structured verdict artifact', () => {
    const file = writeVerdictArtifact(artifact());
    expect(file.endsWith('roosync_search-scenario-2-decision-passage.json')).toBe(true);
    const read = readVerdictArtifacts(dir);
    expect(read).toHaveLength(1);
    expect(read[0].verdict).toBe('PASS');
    expect(read[0].checks[0].name).toBe('results.length > 0');
  });

  test('a qualification without any artifact fails: the gates measured nothing', () => {
    const report = qualifyVerdicts([]);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('measured nothing');
  });

  test('an unexpected INCONCLUSIVE fails the qualification', () => {
    const report = qualifyVerdicts([artifact({ verdict: 'INCONCLUSIVE', reason: 'storm guard active' })]);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toBe(1);
    expect(report.problems.join(' ')).toContain('INCONCLUSIVE');
  });

  test('an explicit opt-in accepts INCONCLUSIVE', () => {
    const report = qualifyVerdicts([artifact({ verdict: 'INCONCLUSIVE' })], { allowInconclusive: true });
    expect(report.ok).toBe(true);
  });

  test('a FAIL always fails the qualification', () => {
    const report = qualifyVerdicts(
      [artifact({ verdict: 'FAIL', reason: 'rubric(a) failed' })],
      { allowInconclusive: true }
    );
    expect(report.ok).toBe(false);
    expect(report.fail).toBe(1);
  });

  test('a measured PASS qualifies', () => {
    const report = qualifyVerdicts([artifact()]);
    expect(report.ok).toBe(true);
    expect(report.pass).toBe(1);
  });
});
