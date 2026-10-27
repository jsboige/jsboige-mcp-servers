/**
 * #4131 G-B lot 2 (B4) — dashboard key listing from PG.
 *
 * `listRooSyncDashboardKeysFromPg` feeds handleList and the health presence
 * view when the dashboard read gate is on:
 *   - gate off / reader null / PG failure / hang past the dedicated budget
 *     (#4304) → null (the caller falls back to the GDrive listing — never
 *     "0 dashboards", #3459);
 *   - an empty array is a VALID answer (store reachable, no rows) — distinct
 *     from null;
 *   - keys of invalid shape (pre-pilot data faults measured by the divergence
 *     probe 14/10: empty 'workspace-', bare prefixes) are filtered — a
 *     data-cleanup concern, not dashboards.
 *
 * `isValidDashboardKeyShape` is covered directly (pure).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

let readerIsNull = false;

const mockListRooSyncDashboardKeys = vi.fn().mockResolvedValue([]);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => readerIsNull,
    listRooSyncDashboardKeys: mockListRooSyncDashboardKeys,
  }),
  resetReaderInstance: vi.fn(),
}));

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({}),
  resetWriterInstance: vi.fn(),
}));

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

import {
  listRooSyncDashboardKeysFromPg,
  isValidDashboardKeyShape,
} from '../roosync-dashboard-store.js';

beforeEach(() => {
  vi.clearAllMocks();
  readerIsNull = false;
  mockListRooSyncDashboardKeys.mockReset().mockResolvedValue([]);
  // Gate on by default — every listing test runs under the read gate; the
  // gate-off contract has its own dedicated test.
  process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
});

afterEach(() => {
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
  vi.useRealTimers();
});

// ─── Shape guard (pure) ─────────────────────────────────────────────────────

describe('isValidDashboardKeyShape', () => {
  test('accepts the three canonical shapes', () => {
    expect(isValidDashboardKeyShape('global')).toBe(true);
    expect(isValidDashboardKeyShape('machine-myia-po-2024')).toBe(true);
    expect(isValidDashboardKeyShape('workspace-CoursIA')).toBe(true);
  });

  test('accepts fork copies and worktree keys (suffixes are legitimate)', () => {
    expect(isValidDashboardKeyShape('workspace-CoursIA (1)')).toBe(true);
    expect(isValidDashboardKeyShape('workspace-wt-worker-3f')).toBe(true);
    expect(isValidDashboardKeyShape('machine-myia-po-2027 (2)')).toBe(true);
  });

  test('rejects the empty-prefix faults measured by the divergence probe (14/10)', () => {
    expect(isValidDashboardKeyShape('workspace-')).toBe(false);
    expect(isValidDashboardKeyShape('machine-')).toBe(false);
    expect(isValidDashboardKeyShape('')).toBe(false);
  });

  test('rejects foreign shapes', () => {
    expect(isValidDashboardKeyShape('global-x')).toBe(false);
    expect(isValidDashboardKeyShape('dashboard-foo')).toBe(false);
    expect(isValidDashboardKeyShape('C:/dev/CoursIA')).toBe(false);
  });
});

// ─── listRooSyncDashboardKeysFromPg — null / list contract ──────────────────

describe('listRooSyncDashboardKeysFromPg', () => {
  test('gate off → null, reader never called (GDrive listing stands)', async () => {
    // #4131: "gate off" is now the explicit kill-switch — the ABSENCE of the
    // flag means "follow the default", i.e. ON when a PG URL is configured.
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '0';
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toBeNull();
    expect(mockListRooSyncDashboardKeys).not.toHaveBeenCalled();
  });

  test('gate unset + no PG URL → null, reader never called (a seat without PG sees no change)', async () => {
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_PG_URL;
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toBeNull();
    expect(mockListRooSyncDashboardKeys).not.toHaveBeenCalled();
  });

  test('reader null → null (fail-open to GDrive)', async () => {
    readerIsNull = true;
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toBeNull();
    expect(mockListRooSyncDashboardKeys).not.toHaveBeenCalled();
  });

  test('valid keys pass through, shape faults are filtered out', async () => {
    mockListRooSyncDashboardKeys.mockResolvedValue([
      'workspace-',
      'machine-MYIA-PO-2027', // broken-case row: valid SHAPE (case is a data concern, not shape)
      'workspace-CoursIA',
      'global',
      'machine-',
      '',
    ]);
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toEqual([
      'machine-MYIA-PO-2027',
      'workspace-CoursIA',
      'global',
    ]);
  });

  test('empty array is a valid answer (store reachable, no rows) — NOT null', async () => {
    mockListRooSyncDashboardKeys.mockResolvedValue([]);
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toEqual([]);
  });

  test('PG rejection → null + warn (caller falls back to GDrive)', async () => {
    mockListRooSyncDashboardKeys.mockRejectedValue(new Error('PG down'));
    await expect(listRooSyncDashboardKeysFromPg()).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('key list failed'),
      expect.objectContaining({ error: 'Error: PG down' })
    );
  });

  test('hang past the dedicated key-list budget → null (bounded race, #3782/#4304)', async () => {
    vi.useFakeTimers();
    mockListRooSyncDashboardKeys.mockReturnValue(new Promise<string[]>(() => {}));
    const pending = listRooSyncDashboardKeysFromPg();
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('key list timed out')
    );
  });

  // #4304 — mesuré #4291 : sous charge (rebuild inbox G:), la réponse PG du
  // key-list atterrit APRÈs la course à 3 s héritée des lookups retraite, et
  // chaque timeout paie un listing GDrive complet. Le key-list n'est pas sur
  // le chemin de chaque appel dashboard (contrairement aux lookups retraite) :
  // il a son propre budget, assez large pour tenir la contention mesurée.
  test('#4304: réponse PG plus lente que la course retraite (3s) mais dans le budget dédié → clés servies, pas de repli GDrive', async () => {
    vi.useFakeTimers();
    let resolveList!: (keys: string[]) => void;
    const slowAnswer = new Promise<string[]>((resolve) => { resolveList = resolve; });
    mockListRooSyncDashboardKeys.mockReturnValue(slowAnswer);
    const pending = listRooSyncDashboardKeysFromPg();
    // La charge mesurée : la réponse atterrit après l'ancienne échéance de 3 s…
    await vi.advanceTimersByTimeAsync(3000);
    resolveList(['workspace-roo-extensions', 'global']);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual(['workspace-roo-extensions', 'global']);
  });
});
