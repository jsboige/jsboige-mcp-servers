/**
 * #3151 Phase C — condensation must anchor its delta on the artifact it
 * overwrites (the GDrive file), not on the PG-primary read.
 *
 * `applyCondensedWithMerge` rewrites the GDrive markdown file wholesale. Its
 * delta ("messages on disk that weren't in our pre-condensation snapshot")
 * was computed with `readDashboardFile()`, which became PG-primary when
 * UNIFIED_STORE_DASHBOARD_READ_PG shipped. On a key where PG and the file
 * diverge, that stitches the PG view over the file and drops every message
 * that exists only on disk.
 *
 * Measured on ai-01 (2026-09-07): 15 of 63 dashboards diverged; on
 * `workspace-CoursIA` the PG journal and the file journal shared ZERO
 * messages, so one condensation from a PG-reading host would have erased
 * 23 messages belonging to three other machines.
 *
 * The mock returns a PG journal DISJOINT from the file — the divergence that
 * was actually observed — and the test asserts the disk-only message survives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Dashboard } from '../dashboard-schemas.js';

const { mockReadDashboardFromPg, mockDualWriteDashboardSync, mockDualWriteDashboardDelete } =
  vi.hoisted(() => ({
    mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
    mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
    mockDualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  dualWriteDashboardSync: mockDualWriteDashboardSync,
  dualWriteDashboardDelete: mockDualWriteDashboardDelete,
}));

// Condensation falls back to truncation when no chat client is configured
// (#1792) — the LLM is out of scope here, only the merge anchor is.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condense-anchor-');
const DISK_ONLY_ID = 'disk-only-msg-3151';

describe('condensation anchor × PG divergence (#3151)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    mockReadDashboardFromPg.mockResolvedValue(null);
    mockDualWriteDashboardSync.mockClear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    vi.clearAllMocks();
  });

  function messageIds(content: string): string[] {
    return [...content.matchAll(/\[msg: ([^\]]+)\]/g)].map(m => m[1]);
  }

  /** A PG journal that shares no message with the file — the observed fork. */
  function divergentPgDashboard(key: string): Dashboard {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `pg-only-${i}`,
      timestamp: new Date(Date.now() - (20 - i) * 60_000).toISOString(),
      author: { machineId: 'other-machine', workspace: 'other-workspace' },
      content: `PG-only message ${i}: ${'p'.repeat(2600)}`,
    }));
    return {
      type: 'workspace',
      key,
      lastModified: new Date().toISOString(),
      lastModifiedBy: { machineId: 'other-machine', workspace: 'other-workspace' },
      status: { markdown: 'pg status' },
      intercom: { messages, totalMessages: messages.length },
    };
  }

  it('keeps a disk-only message when the PG view is disjoint from the file', async () => {
    const write = await roosyncDashboard({
      action: 'write', type: 'workspace', content: 'test status', createIfNotExists: true,
    });
    const key = write.key;
    const filePath = path.join(tmpDir, 'dashboards', `${key}.md`);

    for (let i = 0; i < 4; i++) {
      await roosyncDashboard({
        action: 'append', type: 'workspace', content: `File message ${i}`, tags: ['INFO'],
      });
    }

    // A message written straight to disk by another machine — present in the
    // file, absent from PG. This is the message the defect erases.
    const onDisk = await readFile(filePath, 'utf8');
    await writeFile(
      filePath,
      `${onDisk}\n\n---\n\n### [${new Date().toISOString()}] other-machine|other-workspace\n` +
        `[msg: ${DISK_ONLY_ID}]\n\nMessage that exists only on disk`,
      'utf8'
    );
    expect(messageIds(await readFile(filePath, 'utf8'))).toContain(DISK_ONLY_ID);

    // From here the reads are PG-primary and PG disagrees with the file.
    mockReadDashboardFromPg.mockImplementation(async () => divergentPgDashboard(key));

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'Message that trips condensation', tags: ['INFO'],
    });
    expect(result.success).toBe(true);
    expect(result.condensed).toBe(true);

    // The GDrive file is what condensation rewrote: the disk-only message must
    // still be there. With the delta anchored on PG it is gone.
    expect(messageIds(await readFile(filePath, 'utf8'))).toContain(DISK_ONLY_ID);
  });
});
