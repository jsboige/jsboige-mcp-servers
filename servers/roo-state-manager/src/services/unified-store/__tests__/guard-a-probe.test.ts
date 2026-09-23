/**
 * #3782 guard (a) — unit tests for probeDashboardJournalForHydration.
 *
 * The probe is the decision input of the append guard: ungated by
 * UNIFIED_STORE_DASHBOARD_READ_PG (unlike readDashboardFromPg), bounded by a
 * race timeout, never throwing. Reader factory mocked at the module boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockGetRooSyncDashboard, mockIsNull } = vi.hoisted(() => ({
  mockGetRooSyncDashboard: vi.fn().mockResolvedValue(null),
  mockIsNull: vi.fn().mockReturnValue(false),
}));

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: mockIsNull,
    getRooSyncDashboard: mockGetRooSyncDashboard,
  }),
  resetReaderInstance: vi.fn(),
}));

import { probeDashboardJournalForHydration } from '../roosync-dashboard-store.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';

function dashRow(content = ''): RooSyncDashboardRow {
  return {
    key: 'workspace-probe',
    type: 'workspace',
    machine_id: null,
    workspace: 'probe',
    content,
    status_json: {
      lastModified: '2026-09-23T00:00:00.000Z',
      lastModifiedBy: { machineId: 'm', workspace: 'w' },
      totalMessages: 1,
    },
    updated_at: '2026-09-23T00:00:00.000Z',
    version: 1,
  };
}

function msgRow(createdAt: string, id = 'pg-1'): RooSyncDashboardMessageRow {
  return {
    id: 1,
    dashboard_key: 'workspace-probe',
    message_id: id,
    author_machine: 'm',
    author_workspace: 'w',
    content: 'contenu journal',
    tags: [],
    team_stage: null,
    reply_to: null,
    acknowledged_at: null,
    archived_at: null,
    created_at: createdAt,
  };
}

describe('probeDashboardJournalForHydration (#3782 guard a)', () => {
  beforeEach(() => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    mockIsNull.mockReset().mockReturnValue(false);
    mockGetRooSyncDashboard.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    vi.useRealTimers();
  });

  it('pg-off quand le dual-write est inactif — aucun appel reader', async () => {
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result).toEqual({ kind: 'pg-off' });
    expect(mockGetRooSyncDashboard).not.toHaveBeenCalled();
  });

  it("pg-off quand le reader est Null (URL absente de l'usine)", async () => {
    mockIsNull.mockReturnValueOnce(true);
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result).toEqual({ kind: 'pg-off' });
  });

  it('empty quand PG ne porte aucune row pour la clé', async () => {
    mockGetRooSyncDashboard.mockResolvedValueOnce(null);
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result).toEqual({ kind: 'empty' });
  });

  it('unreachable quand le reader jette (PG down)', async () => {
    mockGetRooSyncDashboard.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result).toEqual({ kind: 'unreachable' });
  });

  it('unreachable quand le reader dépasse le plafond de course (jamais bloqué)', async () => {
    vi.useFakeTimers();
    // Never resolves — a hung pool.
    mockGetRooSyncDashboard.mockReturnValueOnce(new Promise(() => {}) as never);
    const pending = probeDashboardJournalForHydration('workspace-probe');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result).toEqual({ kind: 'unreachable' });
  });

  it('disappeared quand un message date de moins de 6 h (status vide)', async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    mockGetRooSyncDashboard.mockResolvedValueOnce({
      dashboard: dashRow(''),
      messages: [msgRow(recent, 'recent-1')],
    });
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result.kind).toBe('disappeared');
    if (result.kind === 'disappeared') {
      expect(result.rows).toBe(1);
      expect(result.dashboard.intercom.messages[0].id).toBe('recent-1');
    }
  });

  it('disappeared quand le status est non vide (messages anciens)', async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    mockGetRooSyncDashboard.mockResolvedValueOnce({
      dashboard: dashRow('# Status vivant'),
      messages: [msgRow(old, 'old-1')],
    });
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result.kind).toBe('disappeared');
  });

  it('stale quand le status est vide et tous les messages sont anciens', async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    mockGetRooSyncDashboard.mockResolvedValueOnce({
      dashboard: dashRow(''),
      messages: [msgRow(old, 'old-1'), msgRow(old, 'old-2')],
    });
    const result = await probeDashboardJournalForHydration('workspace-probe');
    expect(result).toEqual({ kind: 'stale', rows: 2 });
  });
});
