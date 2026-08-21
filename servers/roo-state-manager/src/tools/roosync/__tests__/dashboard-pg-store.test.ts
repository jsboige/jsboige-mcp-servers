/**
 * Integration tests for the roosync_dashboard tool on the PG seam
 * (#3151 Phase C).
 *
 * Drives the public tool actions (write / append / read / delete) with the
 * store service mocked, asserting:
 *   - write → GDrive file written AND dual-write synced to PG
 *   - append → journal rows dual-written after the file append
 *   - read → PG result returned when present (PG-primary), GDrive file when
 *     the PG read yields null (gate off / miss / failure)
 *   - delete → PG row deleted alongside the file
 *
 * The store module is mocked at the module boundary — the unit semantics of
 * mapping/SQL live in roosync-dashboard-store.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ─── Store service mock (module boundary) ───────────────────────────
// vi.hoisted: vi.mock factories are hoisted above every const declaration —
// the referenced doubles must be created inside vi.hoisted (vitest docs,
// "make sure there are no top level variables inside").

const {
  mockReadDashboardFromPg,
  mockDualWriteDashboardSync,
  mockDualWriteDashboardDelete,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  dualWriteDashboardSync: mockDualWriteDashboardSync,
  dualWriteDashboardDelete: mockDualWriteDashboardDelete,
}));

// #858: Mock OpenAI chat client — LLM condensation is out of scope here.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-pg-test-');

describe('roosync_dashboard × PG store (#3151 Phase C)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
    mockDualWriteDashboardDelete.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('write persists the GDrive file AND dual-writes the dashboard to PG', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: '# Status\n\nWritten via tool',
      createIfNotExists: true,
    });
    expect(result.success).toBe(true);

    // GDrive file written (legacy path intact during transition)
    const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
    expect(file).toContain('# Status');
    expect(file).toContain('Written via tool');

    // PG dual-write: one sync per writeDashboardFile call
    expect(mockDualWriteDashboardSync).toHaveBeenCalledTimes(1);
    const synced = mockDualWriteDashboardSync.mock.calls[0][0];
    expect(synced.key).toBe('workspace-test-workspace');
    expect(synced.status.markdown).toBe('# Status\n\nWritten via tool');
  });

  it('append dual-writes the journal after the file append', async () => {
    await roosyncDashboard({
      action: 'write',
      type: 'global',
      content: '# Global',
      createIfNotExists: true,
    });
    mockDualWriteDashboardSync.mockClear();

    const result = await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: '[DONE] phase C message',
    });
    expect(result.success).toBe(true);
    expect(mockDualWriteDashboardSync).toHaveBeenCalled();

    const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
    expect(synced.intercom.messages).toHaveLength(1);
    expect(synced.intercom.messages[0].content).toContain('[DONE] phase C message');
    // GDrive file also carries the message (listener compatibility #2186)
    const file = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
    expect(file).toContain('[DONE] phase C message');
  });

  it('read is PG-primary: PG content returned, file not consulted', async () => {
    mockReadDashboardFromPg.mockResolvedValueOnce({
      type: 'workspace',
      key: 'workspace-test-workspace',
      lastModified: '2026-08-21T11:00:00.000Z',
      lastModifiedBy: { machineId: 'pg-author', workspace: 'pg' },
      status: { markdown: '# From PG' },
      intercom: {
        messages: [{
          id: 'pg-author:pg:ic-20260821T1100-zzzz',
          timestamp: '2026-08-21T11:00:00.000Z',
          author: { machineId: 'pg-author', workspace: 'pg' },
          content: 'message from PG',
        }],
        totalMessages: 1,
      },
    });

    const result = await roosyncDashboard({
      action: 'read',
      type: 'workspace',
      section: 'all',
    });
    expect(result.success).toBe(true);
    expect(mockReadDashboardFromPg).toHaveBeenCalledWith('workspace-test-workspace');
    // The PG markdown wins even though the file on disk does not exist
    expect(JSON.stringify(result)).toContain('# From PG');
    expect(JSON.stringify(result)).toContain('message from PG');
  });

  it('read falls back to the GDrive file when PG yields null (gate off / miss / failure)', async () => {
    await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: '# On disk only',
      createIfNotExists: true,
    });

    // PG miss → null → GDrive path
    const result = await roosyncDashboard({
      action: 'read',
      type: 'workspace',
      section: 'status',
    });
    expect(result.success).toBe(true);
    expect(mockReadDashboardFromPg).toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('# On disk only');
  });

  it('delete mirrors the deletion to PG', async () => {
    await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: '# To delete',
      createIfNotExists: true,
    });

    // The pre-delete protection reads lastModified — fresh write would be
    // blocked. Simulate an old dashboard via the PG read path (read is
    // PG-primary), then delete.
    mockReadDashboardFromPg.mockResolvedValue({
      type: 'workspace',
      key: 'workspace-test-workspace',
      lastModified: '2020-01-01T00:00:00.000Z',
      lastModifiedBy: { machineId: 'old', workspace: 'old' },
      status: { markdown: '# old' },
      intercom: { messages: [], totalMessages: 0 },
    });

    const result = await roosyncDashboard({ action: 'delete', type: 'workspace' });
    expect(result.success).toBe(true);
    expect(mockDualWriteDashboardDelete).toHaveBeenCalledWith('workspace-test-workspace');
  });
});
