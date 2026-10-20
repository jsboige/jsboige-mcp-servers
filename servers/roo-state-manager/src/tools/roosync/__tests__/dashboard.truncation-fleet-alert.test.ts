/**
 * #4095 lever 3 — a truncation fallback must not stay machine-local news.
 *
 * The [WARN] notice and the status marker land ONLY on the degraded dashboard.
 * When the condensation outage also degrades that machine's coordination, the
 * lane that dug the hole is the only one that knows. These tests pin the
 * escalation contract:
 *   (t1) direct call → a fleet [ERROR] lands on dashboards/global.md with the
 *        source key, the cloud discriminant and the archive name;
 *   (t2) rate limit → a second alert for the SAME source key within the hour
 *        is dropped (a wedged condenser truncates repeatedly; the first alert
 *        is news, the fortieth is noise);
 *   (t3) source 'global' is skipped — the notice already lands there, and
 *        re-entering the dashboard being condensed under its own lock would be
 *        a same-file race;
 *   (t4) end-to-end: a workspace dashboard condensed into truncation fallback
 *        (primary 502 ×3 → cloud 200 empty) produces the fleet [ERROR] on
 *        global.md without failing the append.
 *
 * @module tools/roosync/__tests__/dashboard.truncation-fleet-alert
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  alertFleetTruncationFallback,
  resetTruncationAlertLimiterForTest,
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

const testTmpBase = path.join(os.tmpdir(), 'dashboard-truncation-fleet-alert-');

describe('#4095 lever 3 — fleet escalation of truncation fallbacks', { timeout: 60000 }, () => {
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
    resetTruncationAlertLimiterForTest();
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  function globalPath(): string {
    return path.join(tmpDir, 'dashboards', 'global.md');
  }

  async function readGlobal(): Promise<string> {
    return readFile(globalPath(), 'utf8');
  }

  /** The alert is fire-and-forget from the condensation path — poll until it lands. */
  async function pollGlobalFor(marker: string, timeoutMs = 10000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const md = await readGlobal();
        if (md.includes(marker)) return md;
      } catch { /* global.md not written yet */ }
      if (Date.now() > deadline) {
        throw new Error(`fleet alert marker "${marker}" never landed in global.md within ${timeoutMs}ms`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  it('(t1) direct call → [ERROR] on global.md naming source, cloud discriminant and archive', async () => {
    await alertFleetTruncationFallback({
      sourceKey: 'workspace-test-machine-test-workspace',
      machineId: 'test-machine',
      archivedCount: 7,
      fallbackError: 'empty-content',
      circuitBreaker: '3/3 OPEN',
      archiveBasename: 'workspace-test-machine-test-workspace-2026-10-20T21-30-00-fallback.md',
    });

    const md = await pollGlobalFor('[ERROR] Condensation truncation fallback');
    expect(md).toContain('workspace-test-machine-test-workspace');
    expect(md).toContain('empty-content');
    expect(md).toContain('3/3 OPEN');
    expect(md).toContain('archive/workspace-test-machine-test-workspace-2026-10-20T21-30-00-fallback.md');
    expect(md).toContain('test-machine');
    // Canonical tag persisted (#4003) so priority readers key on ERROR.
    expect(md).toContain('ERROR');
  });

  it('(t2) rate limit → a second alert for the same source key within the hour is dropped', async () => {
    const base = {
      sourceKey: 'workspace-test-machine-test-workspace',
      machineId: 'test-machine',
      fallbackError: 'empty-content',
      circuitBreaker: '3/3 OPEN',
      archiveBasename: 'a-fallback.md',
    };
    await alertFleetTruncationFallback({ ...base, archivedCount: 5 });
    await alertFleetTruncationFallback({ ...base, archivedCount: 9 });

    const md = await pollGlobalFor('[ERROR] Condensation truncation fallback');
    // Exactly one alert: the second (archivedCount=9) never landed.
    expect(md).toContain('5 messages archived WITHOUT LLM summary');
    expect(md).not.toContain('9 messages archived WITHOUT LLM summary');
    expect(md.match(/\[ERROR\] Condensation truncation fallback/g)?.length).toBe(1);
  });

  it('(t3) source key "global" is skipped — no global.md is ever created by the alert', async () => {
    await alertFleetTruncationFallback({
      sourceKey: 'global',
      machineId: 'test-machine',
      archivedCount: 5,
      fallbackError: 'empty-content',
      circuitBreaker: '3/3 OPEN',
      archiveBasename: 'g-fallback.md',
    });
    // Give the (skipped) fire-and-forget path a moment to prove absence.
    await new Promise(r => setTimeout(r, 300));
    await expect(readGlobal()).rejects.toThrow();
  });

  it('(t4) end-to-end: workspace dashboard condensed into truncation → fleet [ERROR] lands on global.md', async () => {
    // Primary present but every attempt fails with HTTP 502; cloud answers
    // 200 with an empty completion — the fallback-truncated shape.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('502 Bad Gateway'), { status: 502 }));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });

    // Fill a WORKSPACE dashboard (not global) until it condenses by truncation.
    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let condensed = false;
    for (let i = 0; i < 20 && !condensed; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: `${filler} message-${i}`,
      });
      condensed = !!(result as any).condensed
        && (result as any).condenseDiagnostic?.some((d: any) => d.outcome === 'fallback-truncated');
    }
    expect(condensed).toBe(true);

    // The escalation is fire-and-forget: poll global.md for the fleet alert.
    const md = await pollGlobalFor('[ERROR] Condensation truncation fallback');
    expect(md).toContain('test-machine');
    expect(md).toContain('archive/');
  });
});
