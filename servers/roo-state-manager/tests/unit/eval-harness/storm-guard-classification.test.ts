/**
 * storm-guard-classification.test.ts — Unit tests for the pure storm-guard
 * classifier (#2609 V2 / #4104).
 *
 * Lives under tests/unit/ so it runs under BOTH the unit and CI configs —
 * tests/eval-harness/** is CI-excluded, but this module is import-free and
 * pure, so the split lets the classification contract be pinned in CI.
 *
 * @issue Epic #2609 V2, #4104
 */

import { describe, it, expect } from 'vitest';
import {
  classifyStormGuard,
  resolveStormGuardThresholds,
  DEFAULT_STORM_SEARCH_MS,
  DEFAULT_STORM_EMBEDDING_MS,
} from '../../eval-harness/storm-guard-classification.js';

const TH = { search_ms: 8000, embedding_ms: 15000 };
const healthy = { diagnose_status: 'healthy' };

describe('classifyStormGuard — decision precedence', () => {
  it('probe error wins over everything → probe_failed, active', () => {
    const d = classifyStormGuard(
      { ...healthy, probe_error: 'connect ETIMEDOUT', embedding_latency_ms: 20000 },
      TH
    );
    expect(d.classification).toBe('probe_failed');
    expect(d.active).toBe(true);
    expect(d.reason).toContain('connect ETIMEDOUT');
  });

  it('unhealthy Qdrant (probe 1) → storm even with unmeasured legs', () => {
    const d = classifyStormGuard(
      { diagnose_status: 'degraded', diagnose_errors: ['optimizers degraded'] },
      TH
    );
    expect(d.classification).toBe('storm');
    expect(d.active).toBe(true);
    expect(d.reason).toContain('status=degraded');
    expect(d.reason).toContain('optimizers degraded');
  });

  it('healthy diagnose is a prerequisite — non-healthy status never classifies slow_embedding', () => {
    const d = classifyStormGuard(
      { diagnose_status: 'error', embedding_latency_ms: 20000, search_latency_ms: 100 },
      TH
    );
    expect(d.classification).toBe('storm');
  });
});

describe('classifyStormGuard — the gap #2609 c.22 item 5 closes', () => {
  it('slow embedding path (~15 s), healthy fast Qdrant → slow_embedding, NOT storm', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: 15001, search_latency_ms: 120 },
      TH
    );
    expect(d.classification).toBe('slow_embedding');
    expect(d.active).toBe(true); // still short-circuits: every search pays the embedding cost
    expect(d.reason).toContain('embedder degraded');
    expect(d.reason).toContain('not an indexing storm');
  });

  it('slow search (storm signature), fast embedding → storm', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: 300, search_latency_ms: 8001 },
      TH
    );
    expect(d.classification).toBe('storm');
    expect(d.active).toBe(true);
    expect(d.reason).toContain('indexing storm');
  });

  it('both legs slow → storm dominates (search leg decides)', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: 20000, search_latency_ms: 12000 },
      TH
    );
    expect(d.classification).toBe('storm');
    expect(d.reason).toContain('embedding path slow too');
  });

  it('both legs fast → ok, inactive, no reason', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: 900, search_latency_ms: 40 },
      TH
    );
    expect(d.classification).toBe('ok');
    expect(d.active).toBe(false);
    expect(d.reason).toBeUndefined();
  });
});

describe('classifyStormGuard — boundaries (strictly greater-than, legacy semantics)', () => {
  it('embedding exactly at threshold does NOT fire', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: TH.embedding_ms, search_latency_ms: 100 },
      TH
    );
    expect(d.classification).toBe('ok');
  });

  it('search exactly at threshold does NOT fire', () => {
    const d = classifyStormGuard(
      { ...healthy, embedding_latency_ms: 1000, search_latency_ms: TH.search_ms },
      TH
    );
    expect(d.classification).toBe('ok');
  });
});

describe('resolveStormGuardThresholds', () => {
  it('defaults: search 8000 ms, embedding 15000 ms', () => {
    expect(resolveStormGuardThresholds({})).toEqual({
      search_ms: DEFAULT_STORM_SEARCH_MS,
      embedding_ms: DEFAULT_STORM_EMBEDDING_MS,
    });
    expect(DEFAULT_STORM_SEARCH_MS).toBe(8000);
    expect(DEFAULT_STORM_EMBEDDING_MS).toBe(15000);
  });

  it('legacy EVAL_STORM_LATENCY_MS still overrides the search threshold (compat)', () => {
    expect(resolveStormGuardThresholds({ EVAL_STORM_LATENCY_MS: '5000' }).search_ms).toBe(5000);
  });

  it('EVAL_STORM_SEARCH_MS takes precedence over the legacy variable', () => {
    expect(
      resolveStormGuardThresholds({ EVAL_STORM_SEARCH_MS: '4000', EVAL_STORM_LATENCY_MS: '9000' })
        .search_ms
    ).toBe(4000);
  });

  it('EVAL_STORM_EMBEDDING_MS overrides the embedding threshold', () => {
    expect(resolveStormGuardThresholds({ EVAL_STORM_EMBEDDING_MS: '12000' }).embedding_ms).toBe(12000);
  });

  it('invalid values fall back to defaults (legacy `|| DEFAULT` behaviour)', () => {
    expect(
      resolveStormGuardThresholds({ EVAL_STORM_SEARCH_MS: 'not-a-number', EVAL_STORM_EMBEDDING_MS: '' })
    ).toEqual({ search_ms: 8000, embedding_ms: 15000 });
  });
});
