/**
 * #4090 — condensation must not stitch an id-less message beside itself.
 *
 * External watchdog scripts (embedding_watchdog.ps1 / vllm_watchdog.ps1) append
 * `### [ts] machine|workspace` blocks straight into the dashboard file with NO
 * `[msg:]` line. parseDashboardMarkdown synthesizes a FRESH id for such blocks
 * on every parse, so applyCondensedWithMerge's id-based delta mistook the same
 * block (re-read from the file after the condensation window) for a concurrent
 * append and stitched a duplicate beside itself. Measured on the global
 * dashboard 05-06/10/2026: every watchdog alert landed twice, same millisecond,
 * distinct ic- ids, while the watchdog log showed a single append per alert.
 *
 * Reproduction, file-only (no PG view — that is how the live fleet hits it):
 * fill the file to just under the condensation threshold with MCP appends,
 * write a watchdog-shaped id-less block straight into the file (as the schtask
 * does), then one more MCP append trips the condensation. The snapshot parsed
 * the id-less block under one synthesized id; the post-condensation re-read
 * parses the same block under another — with the id-only delta that false
 * "concurrent append" is stitched beside the kept copy.
 *
 * Byte calibration: estimateDashboardSize (the actual gate) counts
 * 200 + status + Σ(110 + content). Fillers are sized so every intermediate
 * append stays under the threshold (no premature condensation) while
 * watchdog + trigger push it over.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockReadDashboardFromPg, mockProbeHydration, mockDualWriteDashboardSync, mockDualWriteDashboardDelete } =
  vi.hoisted(() => ({
    mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
    mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
    mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
    mockDualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  isDashboardPgPrimary: vi.fn().mockReturnValue(false),
  readDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  readDashboardFromPg: mockReadDashboardFromPg,
  probeDashboardJournalForHydration: mockProbeHydration,
  dualWriteDashboardSync: mockDualWriteDashboardSync,
  dualWriteDashboardDelete: mockDualWriteDashboardDelete,
  getDashboardRetirement: vi.fn().mockResolvedValue(null),
  listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
}));

// Truncation fallback path — no LLM in scope, the stitch is what is tested.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condense-idless-');
const WATCHDOG_BODY = '**[ERROR][WATCHDOG] Backend embeddings DOWN — chemin semantique fleet coupe. Qdrant: UP';
const TRIGGER_CONTENT = 'Message that trips condensation';
// Mirrors MAX_DASHBOARD_SIZE_BYTES * 0.92 (dashboard.ts) — keep in sync.
const THRESHOLD = Math.floor(50 * 1024 * 0.92);

describe('condensation stitch × id-less messages (#4090)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    mockReadDashboardFromPg.mockResolvedValue(null);
    mockDualWriteDashboardSync.mockClear();
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    vi.clearAllMocks();
  });

  it('keeps a pre-existing id-less watchdog block exactly once across condensation', async () => {
    const write = await roosyncDashboard({
      action: 'write', type: 'workspace', content: 'test status', createIfNotExists: true,
    });
    const key = write.key;
    const filePath = path.join(tmpDir, 'dashboards', `${key}.md`);

    // Fillers: every intermediate append must stay under the threshold, and
    // watchdog + trigger must push the LAST append over it.
    const statusBytes = Buffer.byteLength('test status', 'utf8');
    const overhead = 200 + statusBytes;
    const watchdogBytes = 110 + Buffer.byteLength(WATCHDOG_BODY, 'utf8');
    const triggerBytes = 110 + Buffer.byteLength(TRIGGER_CONTENT, 'utf8');
    const N = 15;
    const fillerBudget = THRESHOLD - overhead - Math.floor((watchdogBytes + triggerBytes) / 2);
    const fillerLen = Math.max(0, Math.floor(fillerBudget / N) - 110);
    for (let i = 0; i < N; i++) {
      const prefix = `Filler ${i} `;
      const content = prefix + 'x'.repeat(Math.max(0, fillerLen - prefix.length));
      await roosyncDashboard({ action: 'append', type: 'workspace', content, tags: ['INFO'] });
    }

    // The watchdog writes its block straight into the file — no [msg:] line.
    const before = await readFile(filePath, 'utf8');
    await writeFile(
      filePath,
      `${before}\n\n---\n\n### [${new Date().toISOString()}] myia-ai-01|qdrant-watchdog\n\n${WATCHDOG_BODY}`,
      'utf8'
    );

    // One more MCP append trips the condensation. The watchdog block is among
    // the most recent messages → keep window.
    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: TRIGGER_CONTENT, tags: ['INFO'],
    });
    expect(result.success).toBe(true);
    expect(result.condensed).toBe(true);

    // With the id-only delta, the re-read block (fresh synthesized id) looks
    // like a concurrent append and lands BESIDE its kept copy: occurrences
    // would be 2 (the measured production defect).
    const after = await readFile(filePath, 'utf8');
    const occurrences = after.split(WATCHDOG_BODY).length - 1;
    expect(occurrences).toBe(1);
  });
});
