/**
 * #3782 guard (a2) — append on an absent dashboard file must not create an
 * empty shell when the PG journal is alive.
 *
 * Drives the public `append` action with the store module mocked at the
 * boundary (same harness as dashboard-pg-store.test.ts), covering the four
 * discriminating cases of the GO (issuecomment-5797429924):
 *
 *   1. key that never existed (PG empty)      → normal creation, no warning
 *   2. key that disappeared (PG rich+recent)  → O_EXCL hydration, zero shells
 *   3. PG unreachable                          → normal creation + WARN
 *   4. EEXIST race — file back during probe   → append goes to the file back
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockReadDashboardFromPg,
  mockDualWriteDashboardSync,
  mockDualWriteDashboardDelete,
  mockDualWriteDashboardSyncChecked,
  mockDualWriteDashboardDeleteChecked,
  mockGetDashboardPgReader,
  mockProbe,
  mockGetDashboardRetirement,
  mockListRetiredDashboardKeys,
  mockRetireDashboardKeyChecked,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  mockDualWriteDashboardSyncChecked: vi.fn().mockResolvedValue({ ok: true }),
  mockDualWriteDashboardDeleteChecked: vi.fn().mockResolvedValue({ ok: true }),
  mockGetDashboardPgReader: vi.fn().mockReturnValue(null),
  mockProbe: vi.fn().mockResolvedValue({ kind: 'empty' }),
  mockGetDashboardRetirement: vi.fn().mockResolvedValue(null),
  mockListRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  mockRetireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  dualWriteDashboardSync: mockDualWriteDashboardSync,
  dualWriteDashboardDelete: mockDualWriteDashboardDelete,
  dualWriteDashboardSyncChecked: mockDualWriteDashboardSyncChecked,
  dualWriteDashboardDeleteChecked: mockDualWriteDashboardDeleteChecked,
  getDashboardPgReader: mockGetDashboardPgReader,
  probeDashboardJournalForHydration: mockProbe,
  getDashboardRetirement: mockGetDashboardRetirement,
  listRetiredDashboardKeys: mockListRetiredDashboardKeys,
  retireDashboardKeyChecked: mockRetireDashboardKeyChecked,
  // #3782 locks-off-Drive : couche PG → 'unavailable' (hôte sans PG — fallback fichier).
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  // #3782 tombstones : pas d'histoire PG archivée → null (fail-open).
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
  mapDashboardToRows: vi.fn(),
  mapRowsToDashboard: vi.fn(),
  backfillDashboardToStore: vi.fn(),
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
import type { Dashboard } from '../dashboard-schemas.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-guard-a-test-');
const KEY = 'workspace-guard-a';

function richPgDashboard(): Dashboard {
  return {
    type: 'workspace',
    key: KEY,
    lastModified: '2026-09-23T00:00:00.000Z',
    lastModifiedBy: { machineId: 'other-machine', workspace: 'other-ws' },
    status: { markdown: '# Status historique\n' },
    intercom: {
      messages: [
        {
          id: 'old-1',
          timestamp: '2026-09-23T00:01:00.000Z',
          author: { machineId: 'other-machine', workspace: 'other-ws' },
          content: 'PREMIER MESSAGE REHYDRATE',
        },
        {
          id: 'old-2',
          timestamp: '2026-09-23T00:02:00.000Z',
          author: { machineId: 'other-machine', workspace: 'other-ws' },
          content: 'SECOND MESSAGE REHYDRATE',
        },
      ],
      totalMessages: 2,
    },
  };
}

describe('roosync_dashboard append × #3782 guard (a2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'guard-a';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
    mockDualWriteDashboardDelete.mockReset().mockResolvedValue(undefined);
    mockDualWriteDashboardSyncChecked.mockReset().mockResolvedValue({ ok: true });
    mockDualWriteDashboardDeleteChecked.mockReset().mockResolvedValue({ ok: true });
    mockProbe.mockReset().mockResolvedValue({ kind: 'empty' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('1. clé jamais existée (PG vide) → création normale, aucun warning garde', async () => {
    mockProbe.mockResolvedValueOnce({ kind: 'empty' });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'NOUVEAU MESSAGE SUR CLE NEUVE',
    });

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(1);
    expect(result.warning).toBeUndefined();

    const file = await readFile(path.join(tmpDir, 'dashboards', `${KEY}.md`), 'utf8');
    expect(file).toContain('NOUVEAU MESSAGE SUR CLE NEUVE');
    expect(file).not.toContain('PREMIER MESSAGE REHYDRATE');
  });

  it('2. clé disparue (PG riche) → hydratation O_EXCL, zéro coquille', async () => {
    mockProbe.mockResolvedValueOnce({ kind: 'disappeared', dashboard: richPgDashboard(), rows: 2 });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'MESSAGE NEUF APRES HYDRATATION',
    });

    expect(result.success).toBe(true);
    // 2 rehydrated + 1 new — the shell path would report 1.
    expect(result.messageCount).toBe(3);
    expect(result.warning).toMatch(/guard-a/);
    expect(result.warning).toMatch(/2 messages/);

    // Zero shells: the canonical file carries the rehydrated history AND the
    // new message, in one Intercom section.
    const file = await readFile(path.join(tmpDir, 'dashboards', `${KEY}.md`), 'utf8');
    expect(file).toContain('PREMIER MESSAGE REHYDRATE');
    expect(file).toContain('SECOND MESSAGE REHYDRATE');
    expect(file).toContain('MESSAGE NEUF APRES HYDRATATION');
    expect(file).toContain('# Status historique');
    expect((file.match(/## Intercom \(\d+ messages\)/g) ?? []).length).toBe(1);
  });

  it('3. PG injoignable → création normale + WARN qui nomme le cas', async () => {
    mockProbe.mockResolvedValueOnce({ kind: 'unreachable' });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'MESSAGE NEUF PG DOWN',
    });

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(1);
    expect(result.warning).toMatch(/guard-a/);
    expect(result.warning).toMatch(/PG injoignable/);

    const file = await readFile(path.join(tmpDir, 'dashboards', `${KEY}.md`), 'utf8');
    expect(file).toContain('MESSAGE NEUF PG DOWN');
  });

  it('4. course EEXIST — fichier réapparu pendant la sonde → append au fichier de retour', async () => {
    // The file reappears DURING the probe: exactly the race window between
    // readDashboardFile (null) and the 'wx' hydration write. The probe mock
    // writes the returning file as its side effect.
    const returnedFileContent = [
      '---',
      'type: workspace',
      'lastModified: 2026-09-23T01:00:00.000Z',
      'lastModifiedBy:',
      '  machineId: other-machine',
      '  workspace: other-ws',
      'totalMessages: 1',
      '---',
      '',
      '## Status',
      '',
      '# Status du fichier revenu',
      '',
      '## Intercom (1 messages)',
      '',
      '### [2026-09-23T01:01:00.000Z] other-machine|other-ws',
      '[msg: back-1]',
      '',
      'MESSAGE DU FICHIER REVENU',
      '',
    ].join('\n');

    mockProbe.mockImplementationOnce(async () => {
      await mkdir(path.join(tmpDir, 'dashboards'), { recursive: true });
      await writeFile(path.join(tmpDir, 'dashboards', `${KEY}.md`), returnedFileContent, 'utf8');
      return { kind: 'disappeared', dashboard: richPgDashboard(), rows: 2 };
    });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'MESSAGE NEUF SUR FICHIER RETOUR',
    });

    expect(result.success).toBe(true);
    // 1 from the file that came back + 1 new — NOT the 2 PG rows.
    expect(result.messageCount).toBe(2);
    expect(result.warning).toMatch(/EEXIST/);

    const file = await readFile(path.join(tmpDir, 'dashboards', `${KEY}.md`), 'utf8');
    expect(file).toContain('MESSAGE DU FICHIER REVENU');
    expect(file).toContain('MESSAGE NEUF SUR FICHIER RETOUR');
    // The hydration payload must NOT have replaced the returning file.
    expect(file).not.toContain('PREMIER MESSAGE REHYDRATE');
  });
});
