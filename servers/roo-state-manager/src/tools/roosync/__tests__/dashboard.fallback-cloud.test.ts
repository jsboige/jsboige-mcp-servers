/**
 * #2719 — Cloud fallback condensation telemetry.
 *
 * The cloud fallback client (`getFallbackChatOpenAIClient` / `cloudCondenseOnce`)
 * was implemented in a prior PR but the top-level `CondenseAttemptInfo.outcome`
 * did not distinguish a condensation *salvaged by the cloud* from a clean primary
 * success — both were labelled `'condensed'`. Acceptance criterion #2 of #2719
 * requires the telemetry to distinguish `fallback-cloud` from `fallback-truncated`.
 *
 * This file covers the three acceptance paths (#2719 criterion #6 a/b/c):
 *   (a) primary down → cloud fallback succeeds → outcome `fallback-cloud`
 *   (b) primary down AND cloud down → outcome `fallback-truncated` (graceful degradation)
 *   (c) primary ok → outcome `condensed` (fallback NOT flagged as used)
 *
 * The existing `dashboard.test.ts` suite mocks `getFallbackChatOpenAIClient: () => null`
 * (inert), so it never exercises the fallback-success path — hence a dedicated file.
 *
 * @module tools/roosync/__tests__/dashboard.fallback-cloud
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';

// Primary chat client + create — lazy indirection so each test can swap behaviour.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client + create.
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  // #2719: per-test configurable via mockGetFallbackClient (null = inert, like prod-unprovisioned).
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => 'glm-4.7-flash',
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-cloud-');

describe('#2719 cloud-fallback condensation telemetry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    // Default: primary unavailable, no fallback configured (inert).
    mockGetPrimaryClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    mockPrimaryCreate.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackCreate.mockReset();
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  /**
   * Fill the dashboard past the 92% preemptive-condense threshold until a
   * condensation pass fires, returning the first result that condensed.
   * Each message is ~3 KB; ~16 messages reliably cross the 50 KB dashboard cap.
   */
  async function fillUntilCondensed(): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let condensedResult: any = null;
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: `${filler} message-${i}`,
      });
      if ((result as any).condensed && !condensedResult) {
        condensedResult = result;
      }
    }
    expect(condensedResult).not.toBeNull();
    return condensedResult;
  }

  it('(a) primary down → cloud fallback succeeds → outcome `fallback-cloud` (#2719 criterion #2/#6a)', async () => {
    // Primary client present but its create rejects (vLLM endpoint down).
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM 192.168.0.47:5002 connection refused'));
    // Cloud fallback client present + its create resolves with a real summary.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '## Cloud summary\n\nArchived traffic salvaged by z.ai.' } }],
    });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client must actually have been called.
    expect(mockFallbackCreate).toHaveBeenCalled();
    // And the per-call stats must record the fallback was used.
    for (const pass of cloudPasses) {
      expect(pass.llm).toBeDefined();
      const usedFallback = pass.llm.summary?.fallbackUsed === true || pass.llm.status?.fallbackUsed === true;
      expect(usedFallback).toBe(true);
    }
  });

  it('(b) primary down AND cloud down → outcome `fallback-truncated` (graceful degradation, #2719 criterion #6b)', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    // Cloud fallback client present but its create ALSO rejects.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockRejectedValue(new Error('z.ai 503 unavailable'));

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // No pass should be labelled fallback-cloud when the cloud also failed.
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });

  it('(c) primary ok → outcome `condensed` (fallback NOT flagged, #2719 criterion #6c)', async () => {
    // Primary succeeds — the cloud client is configured but must NOT be used.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: '## Primary summary\n\nCondensed by local vLLM.' } }],
    });
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const condensedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'condensed',
    );
    expect(condensedPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client was available but the primary succeeded, so it stays idle.
    expect(mockFallbackCreate).not.toHaveBeenCalled();
    // No condensed pass should be mislabelled as fallback-cloud.
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });
});
