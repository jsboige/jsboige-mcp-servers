/**
 * #833 Sprint C3 — ExportConfigManager branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `ExportConfigManager.test.ts` (21 tests) covers getConfig (cache hit,
 * valid file, BOM, absent→default, no-storage→default), updateConfig (partial
 * merge), resetConfig, invalidateCache, template/filter CRUD, and the two error
 * codes. It leaves a cluster of genuine conditional branches cold:
 *
 * - `validateConfig` private method (L192-221): **never invoked anywhere in the
 *   source** (no internal caller — getConfig/mergeWithDefaults bypass it). Its 7
 *   boolean branches are entirely cold: non-object/null config (L195-197),
 *   defaults missing/non-object (L200-202), prettyPrint/includeContent
 *   non-boolean (L205-206), compression enum violation (L207), templates/filters
 *   missing (L212-214), valid (L217), defensive catch (L218-220).
 * - `getConfig` **corrupted-JSON arm** (L109-117): fileError catch when `access`
 *   succeeds but `readFile` returns malformed JSON → JSON.parse throws → default
 *   + saveConfig. Base only exercises the readFile-reject (ENOENT) path.
 * - `saveConfig` **non-Error rejection** (L170, L173): a non-Error reject hits
 *   the `String(error)` arm and `error: undefined` passthrough — base "Disk full"
 *   uses `new Error(...)` so both arms are cold.
 * - `getConfigFilePath` (L226-228): never called in base; both the cached-path
 *   (truthy `configPath`) and re-init (`await getConfigPath()`) arms are cold.
 * - constructor `initializeConfigPath` **detect-throws catch** (L63-65): base
 *   always has detectStorageLocations resolve (to array); the rejection arm that
 *   logs and leaves configPath null is cold.
 * - `addTemplate`/`addFilter` **writeFile invocation** (L243, L267): base asserts
 *   the post-state but never that saveConfig wrote to disk for these.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `ExportConfigManager.ts`. Reuses the established mock pattern (RooStorageDetector
 * + fs/promises hoisted mocks).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks ───────────────────

const mockDetectStorageLocations = vi.fn();

vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: (...args: any[]) => mockDetectStorageLocations(...args),
  },
}));

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
  },
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}));

import { ExportConfigManager } from '../ExportConfigManager.js';
import { ExportConfigManagerError, ExportConfigManagerErrorCode } from '../../types/errors.js';

// ─────────────────── helpers ───────────────────

const MOCK_STORAGE_PATH = '/mock/home/.vscode/tasks/some-task-id';

const VALID_CONFIG = {
  defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
  templates: {},
  filters: {},
};

function makeManager(): ExportConfigManager {
  return new ExportConfigManager();
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectStorageLocations.mockResolvedValue([MOCK_STORAGE_PATH]);
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

describe('ExportConfigManager — branch coverage (#833 C3, source-grounded)', () => {

  // ============================================================
  // validateConfig — private, never called in source (L192-221)
  // ============================================================
  describe('validateConfig — private validation branches (L192-221)', () => {
    test('rejects non-object config (L195-197)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig('not-an-object')).toBe(false);
      expect((mgr as any).validateConfig(42)).toBe(false);
    });

    test('rejects null config (L195-197)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig(null)).toBe(false);
    });

    test('rejects config with missing defaults section (L200-202)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({ templates: {}, filters: {} })).toBe(false);
    });

    test('rejects config with non-object defaults (L200-202)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({ defaults: 'oops', templates: {}, filters: {} })).toBe(false);
    });

    test('rejects non-boolean prettyPrint (L205)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({
        defaults: { prettyPrint: 'yes', includeContent: false, compression: 'none' },
        templates: {}, filters: {},
      })).toBe(false);
    });

    test('rejects non-boolean includeContent (L206)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({
        defaults: { prettyPrint: true, includeContent: 'no', compression: 'none' },
        templates: {}, filters: {},
      })).toBe(false);
    });

    test('rejects compression outside the enum (L207)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({
        defaults: { prettyPrint: true, includeContent: false, compression: 'gzip' },
        templates: {}, filters: {},
      })).toBe(false);
    });

    test('rejects config with missing templates section (L212)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({
        defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
        filters: {},
      })).toBe(false);
    });

    test('rejects config with missing filters section (L213-214)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig({
        defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
        templates: {},
      })).toBe(false);
    });

    test('accepts a fully valid config (L217)', async () => {
      const mgr = makeManager();
      expect((mgr as any).validateConfig(VALID_CONFIG)).toBe(true);
    });

    test('catches an exception thrown by a getter and returns false (L218-220)', async () => {
      const mgr = makeManager();
      // A config whose `defaults` access throws → the try/catch returns false.
      const throwing: any = {};
      Object.defineProperty(throwing, 'defaults', {
        get() { throw new Error('boom'); },
        enumerable: true,
      });
      expect((mgr as any).validateConfig(throwing)).toBe(false);
    });
  });

  // ============================================================
  // getConfig — corrupted-JSON arm (L109-117)
  // ============================================================
  describe('getConfig — corrupted JSON falls back to default + save (L109-117)', () => {
    test('malformed JSON in an existing file → default config persisted (L98, L109-117)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('{ this is not valid json,,,');
      mockWriteFile.mockClear();

      const mgr = makeManager();
      const config = await mgr.getConfig();

      // fileError catch (JSON.parse throws) → default + saveConfig (L112-115).
      expect(config.defaults.prettyPrint).toBe(true);
      expect(config.defaults.includeContent).toBe(false);
      expect(mockWriteFile).toHaveBeenCalled();
      // The saved content is the default config snapshot.
      const saved = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(saved.defaults.compression).toBe('none');
    });
  });

  // ============================================================
  // saveConfig — non-Error rejection (L170, L173)
  // ============================================================
  describe('saveConfig — non-Error rejection coercion (L170, L173)', () => {
    test('a non-Error reject becomes a CONFIG_SAVE_FAILED with String(error) + undefined cause', async () => {
      const mgr = makeManager();
      await mgr.getConfig(); // loads default (triggers one save already)
      mgr.invalidateCache();

      // Reject writeFile with a plain string — not an Error instance.
      mockWriteFile.mockRejectedValue('plain disk failure');

      // Trigger a re-save via resetConfig → saveConfig → catch.
      let caught: unknown;
      try {
        await mgr.resetConfig();
      } catch (err) {
        caught = err;
      }
      // L170: String('plain disk failure') === 'plain disk failure' (non-Error arm).
      expect(caught).toBeInstanceOf(ExportConfigManagerError);
      expect((caught as ExportConfigManagerError).code).toBe(ExportConfigManagerErrorCode.CONFIG_SAVE_FAILED);
      expect((caught as ExportConfigManagerError).message).toContain('plain disk failure');
      // L173: cause is undefined when the original is not an Error.
      expect((caught as ExportConfigManagerError).cause).toBeUndefined();
    });

    test('an Error reject keeps the original Error as cause (L170, L173 truthy arm)', async () => {
      const mgr = makeManager();
      await mgr.getConfig();
      mgr.invalidateCache();

      const diskErr = new Error('ENOENT disk');
      mockWriteFile.mockRejectedValue(diskErr);

      let caught: unknown;
      try {
        await mgr.resetConfig();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ExportConfigManagerError);
      expect((caught as ExportConfigManagerError).cause).toBe(diskErr);
    });
  });

  // ============================================================
  // getConfigFilePath — both arms (L226-228)
  // ============================================================
  describe('getConfigFilePath — cached vs re-init (L226-228)', () => {
    test('returns the cached configPath after a load (truthy arm, L226)', async () => {
      const mgr = makeManager();
      await mgr.getConfig(); // populates configPath via initializeConfigPath
      const detected = mockDetectStorageLocations.mock.calls.length;

      const filePath = await mgr.getConfigFilePath();
      // Path is built from storage dir + CONFIG_FILE_NAME (L61).
      expect(filePath).toContain('xml_export_config.json');
      // Cached: detectStorageLocations NOT called again for this lookup.
      expect(mockDetectStorageLocations.mock.calls.length).toBe(detected);
    });

    test('re-initializes when configPath is still null (await getConfigPath arm, L227)', async () => {
      // Fresh manager whose constructor's fire-and-forget initializeConfigPath
      // resolved to an empty storage list → configPath stays null until getConfigPath.
      mockDetectStorageLocations.mockResolvedValue([MOCK_STORAGE_PATH]);
      const mgr = makeManager();
      // getConfigFilePath falls through to getConfigPath → initializeConfigPath again.
      const filePath = await mgr.getConfigFilePath();
      expect(filePath).toContain('xml_export_config.json');
    });

    test('throws NO_STORAGE_DETECTED when no storage is ever found (L76-81)', async () => {
      mockDetectStorageLocations.mockResolvedValue([]);
      const mgr = makeManager();
      await expect(mgr.getConfigFilePath()).rejects.toMatchObject({
        code: ExportConfigManagerErrorCode.NO_STORAGE_DETECTED,
      });
    });
  });

  // ============================================================
  // constructor initializeConfigPath — detect-throws catch (L63-65)
  // ============================================================
  describe('constructor initializeConfigPath — detect-throws catch (L63-65)', () => {
    test('detectStorageLocations rejection leaves configPath null without throwing (L63-65)', async () => {
      mockDetectStorageLocations.mockRejectedValue(new Error('detector crashed'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Constructor must NOT throw despite the detector rejection.
      const mgr = makeManager();
      // Give the fire-and-forget init a tick to settle.
      await new Promise(r => setTimeout(r, 0));

      // configPath stayed null → getConfigFilePath surfaces NO_STORAGE_DETECTED.
      await expect(mgr.getConfigFilePath()).rejects.toMatchObject({
        code: ExportConfigManagerErrorCode.NO_STORAGE_DETECTED,
      });
      // The catch logged the initialization error (L64).
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  // ============================================================
  // addTemplate / addFilter — writeFile invocation (L243, L267)
  // ============================================================
  describe('addTemplate / addFilter — persist via saveConfig (L243, L267)', () => {
    test('addTemplate writes the updated config to disk (L243)', async () => {
      const mgr = makeManager();
      await mgr.getConfig();
      mockWriteFile.mockClear();

      await mgr.addTemplate('persisted', { format: 'fmt', fields: ['a'] });

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(saved.templates.persisted).toEqual({ format: 'fmt', fields: ['a'] });
    });

    test('addFilter writes the updated config to disk (L267)', async () => {
      const mgr = makeManager();
      await mgr.getConfig();
      mockWriteFile.mockClear();

      await mgr.addFilter('persisted_filter', { mode: 'debug-simple' });

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(saved.filters.persisted_filter).toEqual({ mode: 'debug-simple' });
    });
  });
});
