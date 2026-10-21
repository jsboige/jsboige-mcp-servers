/**
 * #4293 — roosync_dashboard action=read face à un store partagé absent, PG vivant.
 *
 * La garde #3459 coupait la lecture AVANT `readDashboardFile` (PG-premier).
 * Ce fichier épingle les quatre cas :
 *   1. G: OK  + PG OK   → la clé est servie (fichier) ;
 *   2. G: absent + PG OK → PG sert le dashboard ;
 *   3. G: absent + PG KO → erreur explicite, jamais « aucun dashboard » ;
 *   4. G: absent + drapeau off → erreur de garde #3459 inchangée.
 *
 * Le store PG est entièrement doublé ; la moitié GDrive reste réelle (tmpdir).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

const {
  mockGetDashboardPgReader,
  mockReadDashboardFromPg,
} = vi.hoisted(() => ({
  mockGetDashboardPgReader: vi.fn(),
  mockReadDashboardFromPg: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  readDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  probeDashboardJournalForHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  dualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
  dualWriteDashboardSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  getDashboardPgReader: mockGetDashboardPgReader,
  getDashboardRetirement: vi.fn().mockResolvedValue(null),
  listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  readDashboardSharedLock: vi.fn().mockResolvedValue(null),
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
  isDashboardPgPrimary: vi.fn().mockReturnValue(false),
}));

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';
import type { Dashboard } from '../dashboard-schemas.js';

const storePath = path.join(os.tmpdir(), `rsm-4293-dashboard-${process.pid}`);
const dashboardsDir = path.join(storePath, 'dashboards');
const key = 'workspace-test-ws';
const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DASHBOARD_PG_PRIMARY',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function seedDashboardFile(marker: string): void {
  mkdirSync(dashboardsDir, { recursive: true });
  writeFileSync(
    path.join(dashboardsDir, `${key}.md`),
    `---
type: workspace
lastModified: 2026-10-20T12:00:00.000Z
---

## Status

${marker}

## Intercom (0 messages)

*Aucun message.*
`,
    'utf8'
  );
}

function pgDashboard(marker: string): Dashboard {
  return {
    type: 'workspace',
    key,
    lastModified: '2026-10-20T12:00:00.000Z',
    lastModifiedBy: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    status: { markdown: marker },
    intercom: { messages: [], totalMessages: 0 },
  };
}

const fakeReader = { isNull: () => false };

const readArgs = { action: 'read' as const, type: 'workspace' as const, workspace: 'test-ws', section: 'all' as const };

beforeEach(() => {
  savedEnv = {};
  for (const envKey of WATCHED_ENV) savedEnv[envKey] = process.env[envKey];
  process.env.ROOSYNC_SHARED_PATH = storePath;
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://test@localhost:5432/test';
  rmSync(storePath, { recursive: true, force: true });
  mockGetDashboardPgReader.mockReset().mockReturnValue(fakeReader);
  mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  rmSync(storePath, { recursive: true, force: true });
  for (const envKey of WATCHED_ENV) {
    if (savedEnv[envKey] === undefined) delete process.env[envKey];
    else process.env[envKey] = savedEnv[envKey];
  }
});

describe('#4293 — dashboard read, store absent + PG', () => {
  it('cas 1 — G: OK + PG OK : le fichier sert la lecture', async () => {
    seedDashboardFile('*Statut fichier — cas 1*');

    const result = await roosyncDashboard(readArgs) as any;

    expect(result.success).toBe(true);
    expect(result.markdownContent).toContain('Statut fichier — cas 1');
  });

  it('cas 2 — G: absent + PG OK : PG sert le dashboard, la garde ne bloque pas', async () => {
    mockReadDashboardFromPg.mockResolvedValue(pgDashboard('*Statut servi par PG*'));

    const result = await roosyncDashboard(readArgs) as any;

    expect(result.success).toBe(true);
    expect(result.markdownContent).toContain('Statut servi par PG');
    expect(result.message ?? '').not.toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('cas 3 — G: absent + PG en échec : erreur explicite, jamais « aucun dashboard »', async () => {
    mockReadDashboardFromPg.mockResolvedValue(null);

    const result = await roosyncDashboard(readArgs) as any;

    expect(result.success).toBe(false);
    expect(result.message).toContain('PostgreSQL n\'a pas servi');
    expect(result.message).toContain('magasin partagé');
    expect(result.message).not.toContain('createIfNotExists');
  });

  it('cas 4 — G: absent + drapeau off : erreur de garde #3459 inchangée', async () => {
    mockGetDashboardPgReader.mockReturnValue(null);

    const result = await roosyncDashboard(readArgs) as any;

    expect(result.success).toBe(false);
    expect(result.message).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(result.message).not.toContain('PostgreSQL n\'a pas servi');
  });
});