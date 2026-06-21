/**
 * Tests for RooSettingsService vscdb key resolution via `targetExtension`.
 *
 * Validates #2543 Phase 1(a) — the constructor override that routes
 * `targetExtension:'zoo'` to the Zoo-Code vscdb key. Prior to this file,
 * NO test covered the non-default key path (grep for `targetExtension`/
 * `zoo`/`ZOO_CODE` across all RooSettingsService*.test.ts = 0 hits).
 *
 * Strategy: mock sqlite3 and assert the key bound as the SQL `?` parameter
 * inside the real `SELECT ... WHERE key = ?` query. This exercises actual
 * production behaviour (key resolution flows into the query), not just an
 * internal field, so it survives private-field renames.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the SQL params passed to the mocked sqlite3 driver so we can
// assert which vscdb key the service actually queried with.
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockDbClose = vi.fn();

vi.mock('sqlite3', () => {
  const Database = vi.fn((_path: string, _mode: number, callback: (err: Error | null) => void) => {
    setTimeout(() => callback(null), 0);
    return { get: mockDbGet, run: mockDbRun, close: mockDbClose };
  });
  return {
    default: {
      Database,
      OPEN_READONLY: 1,
      OPEN_READWRITE: 2,
    },
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    copyFileSync: vi.fn(),
    promises: {
      ...actual.promises,
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { existsSync } from 'fs';
import {
  DEFAULT_VSCDB_KEY,
  ZOO_CODE_VSCDB_KEY,
} from '../../utils/extension-paths.js';

describe('RooSettingsService — vscdb key resolution (targetExtension)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    // db.get(callback) returns a minimal settings blob so extractSettings()
    // completes and we can read back the bound key from mockDbGet calls.
    mockDbGet.mockImplementation(
      (_sql: string, _params: unknown[], cb: (err: Error | null, row?: { value: string }) => void) => {
        cb(null, { value: '{}' });
      },
    );
    mockDbClose.mockImplementation((cb: (err: Error | null) => void) => cb(null));
    mockDbRun.mockImplementation((_sql: string, _params: unknown[], cb: (err: Error | null) => void) => cb(null));
  });

  /**
   * The key bound as the 2nd SQL parameter (after the value/column ordering).
   * readFromVscdb runs: `SELECT value FROM ItemTable WHERE key = ?` with
   * [this.vscdbKey] — so params[0] is the resolved key.
   */
  const boundKey = (): string => {
    const call = mockDbGet.mock.calls.find((c) => /ItemTable/i.test(String(c[0])));
    return call ? String(call[1]?.[0]) : '';
  };

  it('uses ZOO_CODE_VSCDB_KEY when targetExtension is "zoo"', async () => {
    const { RooSettingsService } = await import('../RooSettingsService');
    const svc = new RooSettingsService({ targetExtension: 'zoo' });
    await svc.extractSettings('safe');

    expect(boundKey()).toBe(ZOO_CODE_VSCDB_KEY);
    expect(boundKey()).not.toBe(DEFAULT_VSCDB_KEY);
  });

  it('uses a custom raw key when targetExtension is a non-roo string', async () => {
    const { RooSettingsService } = await import('../RooSettingsService');
    const customKey = 'SomePublisher.some-extension';
    const svc = new RooSettingsService({ targetExtension: customKey });
    await svc.extractSettings('safe');

    expect(boundKey()).toBe(customKey);
  });

  it('uses the default Roo key when targetExtension is "roo"', async () => {
    const { RooSettingsService } = await import('../RooSettingsService');
    const svc = new RooSettingsService({ targetExtension: 'roo' });
    await svc.extractSettings('safe');

    expect(boundKey()).toBe(DEFAULT_VSCDB_KEY);
  });

  it('uses the default Roo key when no targetExtension is provided', async () => {
    const { RooSettingsService } = await import('../RooSettingsService');
    const svc = new RooSettingsService();
    await svc.extractSettings('safe');

    expect(boundKey()).toBe(DEFAULT_VSCDB_KEY);
  });
});
