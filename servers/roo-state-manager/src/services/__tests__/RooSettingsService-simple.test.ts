/**
 * RooSettingsService — behavioural contracts (#2639).
 *
 * Replaces three existence-only assertions (`toBeDefined` / `typeof === 'function'`)
 * by the contracts the service actually owes its callers:
 *   - path of state.vscdb,
 *   - availability probe semantics,
 *   - refusal with the offending path when the database is absent,
 *   - key filtering for 'safe' vs 'full' modes,
 *   - defensive copy + temp cleanup on read,
 *   - vscdb key resolution from `targetExtension` (#2543).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

// Mock sqlite3 before importing the service
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockDbClose = vi.fn();

const mockDatabaseInstance = {
  get: mockDbGet,
  run: mockDbRun,
  close: mockDbClose,
};

const mockDatabaseCtor = vi.fn(
  (_path: string, _mode: number, callback: (err: Error | null) => void) => {
    setTimeout(() => callback(null), 0);
    return mockDatabaseInstance;
  }
);

vi.mock('sqlite3', () => ({
  default: {
    Database: mockDatabaseCtor,
    OPEN_READONLY: 1,
    OPEN_READWRITE: 2,
  },
}));

// Mock fs
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

import { existsSync, copyFileSync, promises as fsp } from 'fs';
import { DEFAULT_VSCDB_KEY, ZOO_CODE_VSCDB_KEY } from '../../utils/extension-paths.js';

const VSCDB_RELATIVE_PATH = join(
  'AppData',
  'Roaming',
  'Code',
  'User',
  'globalStorage',
  'state.vscdb'
);

/** Payload written in the fake ItemTable row, covering the three filter classes. */
const DB_BLOB = {
  autoCondenseContext: true, // sync-safe
  autoCondenseContextPercent: 80, // sync-safe
  id: 'machine-uuid', // EXCLUDED_KEYS
  taskHistory: [{ id: 't1' }], // EXCLUDED_KEYS
  someUnknownKey: 'not-listed-anywhere', // neither set
};

const SYNC_SAFE_IN_BLOB = ['autoCondenseContext', 'autoCondenseContextPercent'];
const EXCLUDED_IN_BLOB = ['id', 'taskHistory'];

describe('RooSettingsService — behavioural contracts', () => {
  let service: any;
  let RooSettingsService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    // Mock simple database response
    mockDbGet.mockImplementation(
      (_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
        callback(null, { value: JSON.stringify(DB_BLOB) });
      }
    );

    mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
      callback(null);
    });

    mockDbRun.mockImplementation(
      (_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
        callback(null);
      }
    );

    // Import here after mocking
    ({ RooSettingsService } = await import('../RooSettingsService'));
    service = new RooSettingsService();
  });

  describe('getStateDbPath()', () => {
    it('resolves state.vscdb under the user home, in VS Code globalStorage', () => {
      expect(service.getStateDbPath()).toBe(join(homedir(), VSCDB_RELATIVE_PATH));
    });

    it('is stable across calls (no time/env dependent segment)', () => {
      expect(service.getStateDbPath()).toBe(service.getStateDbPath());
      expect(service.getStateDbPath().endsWith(join('globalStorage', 'state.vscdb'))).toBe(true);
    });
  });

  describe('isAvailable()', () => {
    it('is true when state.vscdb exists, and probes exactly that path', () => {
      vi.mocked(existsSync).mockReturnValue(true);

      expect(service.isAvailable()).toBe(true);
      expect(existsSync).toHaveBeenCalledWith(service.getStateDbPath());
    });

    it('is false — without throwing — when state.vscdb is absent', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(service.isAvailable()).toBe(false);
      expect(existsSync).toHaveBeenCalledWith(service.getStateDbPath());
    });
  });

  describe('extractSettings() — missing database', () => {
    it('rejects with the database path in the message and never touches sqlite or tmp files', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(service.extractSettings()).rejects.toThrow(/state\.vscdb not found at:/);
      await expect(service.extractSettings()).rejects.toThrow(service.getStateDbPath());

      expect(copyFileSync).not.toHaveBeenCalled();
      expect(mockDatabaseCtor).not.toHaveBeenCalled();
      expect(mockDbGet).not.toHaveBeenCalled();
    });
  });

  describe('extractSettings() — filtering', () => {
    it("'safe' (default) keeps only sync-safe keys and reports honest counters", async () => {
      const result = await service.extractSettings();

      expect(Object.keys(result.settings).sort()).toEqual([...SYNC_SAFE_IN_BLOB].sort());
      for (const excluded of EXCLUDED_IN_BLOB) {
        expect(result.settings).not.toHaveProperty(excluded);
      }
      expect(result.settings).not.toHaveProperty('someUnknownKey');
      expect(result.settings.autoCondenseContextPercent).toBe(80);

      expect(result.metadata.mode).toBe('safe');
      expect(result.metadata.keysCount).toBe(SYNC_SAFE_IN_BLOB.length);
      expect(result.metadata.totalKeys).toBe(Object.keys(DB_BLOB).length);
      expect(Number.isNaN(Date.parse(result.metadata.timestamp))).toBe(false);
    });

    it("'full' drops only the machine-specific excluded keys, keeping the rest", async () => {
      const result = await service.extractSettings('full');

      for (const excluded of EXCLUDED_IN_BLOB) {
        expect(result.settings).not.toHaveProperty(excluded);
      }
      expect(result.settings.autoCondenseContext).toBe(true);
      expect(result.settings.someUnknownKey).toBe('not-listed-anywhere');

      expect(result.metadata.mode).toBe('full');
      expect(result.metadata.keysCount).toBe(
        Object.keys(DB_BLOB).length - EXCLUDED_IN_BLOB.length
      );
      expect(result.metadata.totalKeys).toBe(Object.keys(DB_BLOB).length);
    });

    it('reads a read-only defensive copy and always removes the temp file', async () => {
      await service.extractSettings();

      expect(copyFileSync).toHaveBeenCalledTimes(1);
      const [copiedFrom, copiedTo] = vi.mocked(copyFileSync).mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(copiedFrom).toBe(service.getStateDbPath());
      expect(copiedTo.startsWith(tmpdir())).toBe(true);
      expect(copiedTo).not.toBe(copiedFrom);

      // opened READONLY (1), never READWRITE (2) — a read must not lock VS Code's db
      expect(mockDatabaseCtor).toHaveBeenCalledWith(copiedTo, 1, expect.any(Function));

      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining('ItemTable'),
        [expect.any(String)],
        expect.any(Function)
      );
      // default instance resolves to one of the two known extension keys
      const [, params] = mockDbGet.mock.calls[0] as [string, string[], unknown];
      expect([DEFAULT_VSCDB_KEY, ZOO_CODE_VSCDB_KEY]).toContain(params[0]);

      expect(vi.mocked(fsp.unlink)).toHaveBeenCalledWith(copiedTo);
    });
  });

  describe('vscdb key resolution (#2543)', () => {
    it("targetExtension 'zoo' queries the Zoo Code key", async () => {
      const zooService = new RooSettingsService({ targetExtension: 'zoo' });

      await zooService.extractSettings();

      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining('ItemTable'),
        [ZOO_CODE_VSCDB_KEY],
        expect.any(Function)
      );
    });

    it('accepts a raw custom key verbatim', async () => {
      const customService = new RooSettingsService({ targetExtension: 'My.Custom.Extension' });

      await customService.extractSettings();

      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining('ItemTable'),
        ['My.Custom.Extension'],
        expect.any(Function)
      );
    });
  });
});
