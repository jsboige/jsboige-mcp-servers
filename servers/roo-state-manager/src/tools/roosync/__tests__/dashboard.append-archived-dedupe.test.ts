/**
 * #3276 + #3782 — an explicit messageId that a condensation already ARCHIVED
 * is deduplicated like a live one.
 *
 * Measured on ai-01 (04/11): the stall detector re-posts the same daily id
 * (`stall-detector-<host>-<digest>-<day>`). Once a condensation had archived
 * the first copy, the re-post passed the live-only check, landed in the GDrive
 * file and stayed archived in PG (the journal upsert never clears
 * archived_at): invisible to PG-primary fleet reads, visible in the file, and
 * a [DASHBOARD-FORK] alert on every re-post.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const fetchArchived = vi.hoisted(() => vi.fn<(key: string) => Promise<Set<string> | null>>());

vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/unified-store/roosync-dashboard-store.js')>();
  return { ...actual, fetchArchivedDashboardMessageIds: fetchArchived };
});

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';

const ARCHIVED_ID = 'stall-detector-MYIA-PO-2024-8df9b710d2e6-20761';

async function intercomIds(): Promise<string[]> {
  const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
  return ((read.data?.intercom?.messages ?? []) as Array<{ id: string }>).map(m => m.id);
}

describe('append dedupe on an archived explicit messageId (#3276/#3782)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    process.env.CONDENSE_DETACHED = '0';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-archived-dedupe-'));
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    resetCondenseCircuitBreaker();
    fetchArchived.mockReset();
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.CONDENSE_DETACHED;
  });

  it('skips a re-post whose id a condensation archived, and says why', async () => {
    fetchArchived.mockResolvedValue(new Set([ARCHIVED_ID, 'other-archived']));
    const before = await intercomIds();

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'daily note', messageId: ARCHIVED_ID });

    expect(r.success).toBe(true);
    expect(r.deduplicated).toBe(true);
    expect(r.message).toContain('archivé par une condensation');
    expect(fetchArchived).toHaveBeenCalledWith('global');
    expect(await intercomIds()).toEqual(before);
  });

  it('appends an explicit id that is neither live nor archived', async () => {
    fetchArchived.mockResolvedValue(new Set(['other-archived']));

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'fresh', messageId: 'fresh-id-1' });

    expect(r.deduplicated).toBeUndefined();
    expect(await intercomIds()).toContain('fresh-id-1');
  });

  it('appends when the tombstone lookup has no answer (no PG half, failure, timeout)', async () => {
    fetchArchived.mockResolvedValue(null);

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'kept', messageId: ARCHIVED_ID });

    expect(r.deduplicated).toBeUndefined();
    expect(await intercomIds()).toContain(ARCHIVED_ID);
  });

  it('rollback lever DASHBOARD_APPEND_ARCHIVED_DEDUPE=0 restores the live-only check', async () => {
    vi.stubEnv('DASHBOARD_APPEND_ARCHIVED_DEDUPE', '0');
    fetchArchived.mockResolvedValue(new Set([ARCHIVED_ID]));

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'kept', messageId: ARCHIVED_ID });

    expect(r.deduplicated).toBeUndefined();
    expect(fetchArchived).not.toHaveBeenCalled();
    expect(await intercomIds()).toContain(ARCHIVED_ID);
  });

  it('an append without an explicit id never pays the tombstone lookup', async () => {
    fetchArchived.mockResolvedValue(new Set([ARCHIVED_ID]));

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'auto id' });

    expect(r.success).toBe(true);
    expect(r.deduplicated).toBeUndefined();
    expect(fetchArchived).not.toHaveBeenCalled();
  });

  it('a live duplicate is still answered by the live check, without the lookup', async () => {
    fetchArchived.mockResolvedValue(new Set());
    await roosyncDashboard({ action: 'append', type: 'global', content: 'A', messageId: 'live-id' });
    fetchArchived.mockClear();

    const r = await roosyncDashboard({ action: 'append', type: 'global', content: 'A', messageId: 'live-id' });

    expect(r.deduplicated).toBe(true);
    expect(r.message).toContain('déjà présent');
    expect(fetchArchived).not.toHaveBeenCalled();
  });
});
