/**
 * #3962 pistes 2-3 — leg independence + per-key truncation counter.
 *
 * Piste 2 (the cascade): the #2719 pass deadline was clamped into the CLOUD leg
 * only; the primary ran unclamped at 720s ×3 attempts. A hung vLLM therefore
 * burned the shared 165s budget BEFORE the rescue tier got a turn — the cloud
 * inherited a starved window and truncated in cascade. These tests pin:
 *   (t1) computePrimaryAttemptTimeoutMs math — no-deadline passthrough, clamp to
 *        (deadline − cloud reserve), refusal under the skip floor, env override;
 *   (t2) the cascade repro — engine-side hang longer than the primary's clamped
 *        slice must NOT starve the cloud leg: with the fix the primary is cut at
 *        its deadline-derived timeout and the cloud salvages the pass on the
 *        reserved budget (before the fix: primary runs to the engine cut, the
 *        cloud inherits < skip-floor and the pass truncates);
 *   (t3) piste 3 — a per-key host counter accumulates across truncations and
 *        rides the status marker, the archive frontmatter and the fleet alert.
 *
 * @module tools/roosync/__tests__/dashboard.leg-budget
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  resetTruncationAlertLimiterForTest,
  computePrimaryAttemptTimeoutMs,
  getFallbackTruncationCounters,
  resetFallbackTruncationCountersForTest,
  buildStatusFallbackMarker,
} from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => 'glm-5.3-flash',
}));

/** SDK timeout class — isLLMTimeoutError matches on constructor.name (#3012). */
class APIConnectionTimeoutError extends Error {
  constructor(message = 'Request timed out.') {
    super(message);
    this.name = 'APIConnectionTimeoutError';
  }
}

const testTmpBase = path.join(os.tmpdir(), 'dashboard-leg-budget-');

describe('#3962 — leg budget independence + truncation counter', { timeout: 120000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    // #3962 hermeticity: seat .env carries FALLBACK_API_FORMAT since the 23/10 fleet gesture
    delete process.env.FALLBACK_API_FORMAT;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    resetTruncationAlertLimiterForTest();
    resetCondenseCircuitBreaker();
    resetFallbackTruncationCountersForTest();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('(t1) computePrimaryAttemptTimeoutMs — clamp to deadline minus the cloud reserve, refuse under the skip floor', () => {
    // No pass deadline (tests, non-condensation callers) → base timeout as-is.
    expect(computePrimaryAttemptTimeoutMs(720000)).toBe(720000);

    // Deadline 300s out, reserve 35s: the primary may spend at most 265s.
    const t0 = Date.now();
    const clamped = computePrimaryAttemptTimeoutMs(720000, t0 + 300000);
    expect(clamped).not.toBeNull();
    expect(clamped!).toBeLessThanOrEqual(300000 - 35000);
    expect(clamped!).toBeGreaterThan(300000 - 35000 - 2000); // ≈ exactly the available slice

    // Deadline 20s out with the default 35s reserve: the reserve is already
    // invaded — the primary must refuse (null), leaving the cloud the budget.
    expect(computePrimaryAttemptTimeoutMs(720000, Date.now() + 20000)).toBeNull();

    // Env override: reserve 0 restores a plain deadline clamp.
    process.env.CONDENSE_CLOUD_RESERVE_MS = '0';
    const noReserve = computePrimaryAttemptTimeoutMs(720000, Date.now() + 20000);
    expect(noReserve).not.toBeNull();
    expect(noReserve!).toBeLessThanOrEqual(20000);
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;

    // Invalid env value falls back to the default reserve (35s).
    process.env.CONDENSE_CLOUD_RESERVE_MS = 'not-a-number';
    expect(computePrimaryAttemptTimeoutMs(720000, Date.now() + 20000)).toBeNull();
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
  });

  it('(t1b) buildStatusFallbackMarker — host counter rides the marker only when given', () => {
    const legs = { primary: 'Request timed out. (…) :5002', cloud: 'empty-content' };
    const without = buildStatusFallbackMarker('2026-10-21T00:00:00.000Z', 9, legs);
    expect(without).toContain('fallback-truncated');
    expect(without).not.toContain('host:');

    const withCounter = buildStatusFallbackMarker('2026-10-21T00:00:00.000Z', 9, legs, {
      count: 4,
      firstAt: '2026-10-18T00:00:00.000Z',
    });
    expect(withCounter).toContain('host: 4 truncations since 2026-10-18T00:00:00.000Z');
  });

  it('(t2) cascade repro — a primary hang longer than its clamped slice must not starve the cloud leg', async () => {
    // Budget: 50s pass deadline, 35s cloud reserve → the primary's slice is ~15s.
    // The mock engine "hangs" 45s (the #3962 ~86s engine cut, scaled down): with
    // the fix the SDK per-request timeout (clamped to ~15s) cuts first and the
    // cloud salvages on the reserve; WITHOUT the fix the primary runs the full
    // 45s, the cloud inherits ~5s (< skip floor) and the pass truncates.
    process.env.CONDENSE_PASS_DEADLINE_MS = '50000';
    // Pins the piste 2 mechanism at the historical fixed reserve: since piste 4 the
    // default is prompt-sized (dashboard.claudish-fallback.test.ts c2), which on this
    // scaled-down 50s pass would leave the primary no slice at all.
    process.env.CONDENSE_CLOUD_RESERVE_MS = '35000';

    const primaryTimeouts: Array<number | undefined> = [];
    const cloudTimeouts: Array<number | undefined> = [];
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockImplementation(async (_body: unknown, options?: { timeout?: number }) => {
      primaryTimeouts.push(options?.timeout);
      // Engine-side hang: the socket stays open until the ENGINE cuts (45s) —
      // but the SDK's per-request timeout fires earlier when clamped below it.
      const sdkTimeout = options?.timeout ?? 720000;
      await new Promise(r => setTimeout(r, Math.min(sdkTimeout, 45000)));
      throw new APIConnectionTimeoutError();
    });
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockImplementation(async (_body: unknown, options?: { timeout?: number }) => {
      cloudTimeouts.push(options?.timeout);
      return { choices: [{ message: { content: 'Résumé cloud de secours — synthèse complète des messages archivés.' } }] };
    });

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let outcomes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: `${filler} message-${i}`,
      }) as { condensed?: boolean; condenseDiagnostic?: Array<{ outcome: string }> };
      if (result.condensed) {
        outcomes = (result.condenseDiagnostic ?? []).map(d => d.outcome);
        break;
      }
    }

    // THE mechanism: every primary attempt was deadline-clamped (~15s), never the
    // 720s ceiling — the hang cannot outlast the primary's own slice.
    expect(primaryTimeouts.length).toBeGreaterThan(0);
    for (const t of primaryTimeouts) {
      expect(t).toBeDefined();
      expect(t!).toBeLessThanOrEqual(15500);
    }
    // The cloud leg ran (both parallel paths salvaged by the same mock) with a
    // window that still fits a minimum viable attempt (≥ 30s floor).
    expect(cloudTimeouts.length).toBeGreaterThan(0);
    for (const t of cloudTimeouts) {
      expect(t).toBeDefined();
      expect(t!).toBeGreaterThanOrEqual(30000);
    }
    // And the pass did NOT truncate — the rescue tier had its reserved budget.
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes).not.toContain('fallback-truncated');
    const counters = getFallbackTruncationCounters();
    expect(counters.filter(c => c.count > 0)).toHaveLength(0);
  });

  it('(t3) per-key host counter — accumulates across truncations, rides marker/frontmatter/fleet alert', async () => {
    // Primary 502 (retryable) ×3, cloud 200 empty → truncation, twice.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('502 Bad Gateway'), { status: 502 }));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });

    const wsPath = (): string =>
      path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md');

    const driveOneTruncation = async (): Promise<void> => {
      const filler = 'X'.repeat(3000);
      for (let i = 0; i < 20; i++) {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: `${filler} message-${i}`,
        }) as { condensed?: boolean; condenseDiagnostic?: Array<{ outcome: string }> };
        const truncated = result.condensed
          && (result.condenseDiagnostic ?? []).some(d => d.outcome === 'fallback-truncated');
        if (truncated) return;
      }
      throw new Error('dashboard never condensed into truncation within 20 appends');
    };

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    await driveOneTruncation();

    // First truncation: counter = 1, marker carries it, fleet alert carries it.
    let counters = getFallbackTruncationCounters();
    expect(counters).toHaveLength(1);
    expect(counters[0].key).toBe('workspace-test-workspace');
    expect(counters[0].count).toBe(1);
    expect(counters[0].firstAt).toBe(counters[0].lastAt);

    let md = await readFile(wsPath(), 'utf8');
    expect(md).toContain('host: 1 truncation since');

    const globalMd = await new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      let settled = false;
      const tick = (): void => {
        readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8').then(
          content => {
            if (settled) return;
            if (content.includes('Host counter: 1 truncation')) {
              settled = true;
              resolve(content);
            }
          },
          () => undefined
        ).finally(() => {
          if (settled) return;
          if (Date.now() > deadline) {
            settled = true;
            reject(new Error('fleet alert never landed'));
          } else {
            setTimeout(tick, 100);
          }
        });
      };
      tick();
    });
    expect(globalMd).toContain('Host counter: 1 truncation on this key');

    // Archive frontmatter carries the ordinal too.
    const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    const archives = (await readdir(archiveDir)).filter(f => f.endsWith('-fallback.md'));
    expect(archives).toHaveLength(1);
    const archiveMd = await readFile(path.join(archiveDir, archives[0]), 'utf8');
    expect(archiveMd).toContain('hostTruncationCount: 1');

    // Second truncation: counter accumulates, marker re-stamped at 2.
    await driveOneTruncation();
    counters = getFallbackTruncationCounters();
    expect(counters).toHaveLength(1);
    expect(counters[0].count).toBe(2);
    // ISO timestamps sort lexicographically — lastAt cannot predate firstAt.
    expect(counters[0].lastAt >= counters[0].firstAt).toBe(true);
    md = await readFile(wsPath(), 'utf8');
    expect(md).toContain('host: 2 truncations since');
    expect(md.match(/lastCondense: fallback-truncated/g)?.length).toBe(1); // at most one marker
  });
});
