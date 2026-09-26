/**
 * #2719 — Silent condensation: the notice and the append return must not read
 * as success when no LLM summary was produced (ask CoursIA 25/09 20:10Z,
 * dispatch ai-01 26/09: "le message le dit et nomme l'archive ; le retour
 * expose l'échec du résumé ; condensed reste true").
 *
 * Companion of dashboard.fallback-cloud.test.ts (which pins the outcome
 * labels); this file pins the OBSERVABILITY contracts:
 *   (t1) primary 502 ×3 → cloud 200 empty → fallback-truncated:
 *        - intercom notice is the [WARN] FALLBACK TRUNCATION one, names the
 *          archive, and the success claim "résumé LLM généré" appears NOWHERE;
 *        - the append return exposes `summaryFailed: true` with `condensed: true`
 *          and the diagSuffix "truncation fallback" in the message.
 *   (t2) primary down → cloud salvages → the CONDENSATION notice says
 *        "résumé généré via fallback cloud" (degraded provenance), not the
 *        plain primary claim; `summaryFailed` is absent.
 *   (t3) primary ok → the notice keeps the plain "résumé LLM généré" claim;
 *        `summaryFailed` is absent.
 *   (t4) #1233 review follow-up (ai-01 non-blocking points 2+3): STATUS leg salvaged
 *        by the cloud while the SUMMARY came from the primary → the notice says
 *        "Statut mis à jour via fallback cloud" (same algebra as the outcome, which
 *        is `fallback-cloud`), keeps the honest "résumé LLM généré" claim for the
 *        summary, and the append message carries a neutral "[cloud fallback: ...]"
 *        marker (no ⚠️: nothing was lost).
 *
 * @module tools/roosync/__tests__/dashboard.condensation-notice
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();
const mockFallbackModelId = vi.fn(() => 'glm-4.7-flash');

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => mockFallbackModelId(),
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condensation-notice-');

describe('#2719 condensation notice honesty (silent summary failure)', { timeout: 30000 }, () => {
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

  async function readDashboardFile(): Promise<string> {
    return readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
  }

  it('(t1) primary 502 ×3 → cloud 200 empty → notice names the archive, no success claim, summaryFailed: true, condensed: true', async () => {
    // Primary present but every attempt fails with HTTP 502 (CoursIA 25/09 shape:
    // 3 summary attempts, all 502).
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('502 Bad Gateway'), { status: 502 }));
    // Cloud fallback reachable but answers HTTP 200 with a 0-byte completion.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });

    const result = await fillUntilCondensed();

    // Return: the failure is a structured top-level field, condensed stays true.
    expect(result.condensed).toBe(true);
    expect(result.summaryFailed).toBe(true);
    expect(result.message).toContain('truncation fallback');
    const truncated = result.condenseDiagnostic.filter((d: any) => d.outcome === 'fallback-truncated');
    expect(truncated.length).toBeGreaterThanOrEqual(1);
    // lastError carries the PRIMARY's 502; the cloud leg's empty-content answer
    // is discriminated in the fallback archive frontmatter (checked below).
    expect(truncated[0].llm.summary.finalOutcome).toBe('error');
    expect(truncated[0].llm.summary.attempts).toBeGreaterThanOrEqual(2);

    // Intercom: the [WARN] FALLBACK TRUNCATION notice is the posted message,
    // it names the archive, and the success claim appears nowhere.
    const md = await readDashboardFile();
    expect(md).toContain('FALLBACK TRUNCATION');
    expect(md).toContain('archive/');
    expect(md).not.toContain('résumé LLM généré');
    expect(md).not.toContain('CONDENSATION-SUMMARY');

    // The cloud leg's 200/0-byte answer is discriminated in the archive
    // frontmatter (CoursIA shape), not in the call-level lastError.
    const archiveFiles = await readdir(path.join(tmpDir, 'dashboards', 'archive'));
    const fallbackArchives = archiveFiles.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', fallbackArchives[0]),
      'utf8',
    );
    expect(archiveContent).toContain('empty-content');
  });

  it('(t2) primary down → cloud salvages → notice says "via fallback cloud", summaryFailed absent', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '## Cloud summary\n\nSalvaged by z.ai.' } }],
    });

    const result = await fillUntilCondensed();

    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'fallback-cloud')).toBe(true);
    expect(result.summaryFailed).toBeUndefined();
    // #1233 follow-up point 3: the cloud salvage is visible in the primary
    // tool-result message, not only in condenseDiagnostic[].outcome.
    expect(result.message).toContain('[cloud fallback: primary LLM down, condensation salvaged by cloud');

    const md = await readDashboardFile();
    expect(md).toContain('résumé généré via fallback cloud');
    // The plain primary-success claim must not coexist with the degraded one.
    expect(md).not.toContain('résumé LLM généré');
  });

  it('(t3) primary ok → notice keeps the plain success claim, summaryFailed absent', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: '## Primary summary\n\nCondensed by local vLLM.' } }],
    });

    const result = await fillUntilCondensed();

    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'condensed')).toBe(true);
    expect(result.summaryFailed).toBeUndefined();
    expect(result.message).not.toContain('cloud fallback');

    const md = await readDashboardFile();
    expect(md).toContain('résumé LLM généré (');
    expect(md).not.toContain('via fallback cloud');
  });

  it('(t4) status leg salvaged by cloud, summary from primary → notice carries the status provenance, message carries the cloud marker', async () => {
    // Route the PRIMARY by prompt: the summary leg (system prompt "synthèse de
    // communications inter-agents") succeeds on the primary, the status leg
    // ("synthèse de dashboards de coordination") fails — the cloud fallback
    // answers the status. This is the divergent-legs shape the #1233 review
    // pointed at: outcome = fallback-cloud while the summary is a primary success.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockImplementation(async (req: any) => {
      const sys = req?.messages?.[0]?.content ?? '';
      if (sys.includes('synthèse de communications inter-agents')) {
        return { choices: [{ message: { content: '## Primary summary\n\nSummary leg succeeded on the primary.' } }] };
      }
      throw Object.assign(new Error('502 Bad Gateway (status leg)'), { status: 502 });
    });
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '## Statut évolutif\n\n- Élément durable conservé.' } }],
    });

    const result = await fillUntilCondensed();

    // The pass IS degraded (a leg ran on the cloud), nothing was lost.
    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'fallback-cloud')).toBe(true);
    expect(result.summaryFailed).toBeUndefined();
    expect(result.message).toContain('[cloud fallback: primary LLM down, condensation salvaged by cloud');

    const md = await readDashboardFile();
    // Point 2: the notice's status line carries its own cloud provenance — the
    // notice and the outcome now agree on this divergent-legs shape.
    expect(md).toContain('Statut mis à jour via fallback cloud');
    // The summary really came from the primary: the plain claim is honest here.
    expect(md).toContain('résumé LLM généré (');
    expect(md).not.toContain('résumé généré via fallback cloud');
  });
});
