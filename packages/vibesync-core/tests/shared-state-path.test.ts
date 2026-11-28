/**
 * Unit tests for the trunk's shared-state path resolver (#4886 S2 grain 4).
 *
 * THE CONTRACT (packages/vibesync-core/src/utils/shared-state-path.ts):
 *   - `getSharedStatePath()` reads process.env.ROOSYNC_SHARED_PATH, then the
 *     fallback registered by `registerDotenvFallback()` (#1628), then throws;
 *   - with no reader registered the trunk is environment-only — a package
 *     consumer cannot pick up a stray `.env` from wherever the package lives;
 *   - the store is never assumed present: `assertSharedStoreAccessible` fails
 *     closed (#3459) and `ensureStoreSubdir` never creates an absent root.
 *
 * The RSM-side #1628 reader (parsing the seat's own `.env`) is covered where it
 * lives: servers/roo-state-manager/src/utils/__tests__/shared-state-path*.test.ts.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const warn = vi.fn();

vi.mock('@vibesync/core/utils/logger', () => ({
  createLogger: () => ({ warn, info: () => {}, error: () => {}, debug: () => {} }),
}));

// `fs` is mocked with PURE spies so a probe never touches the disk: the contract
// is about what the module does with existsSync/mkdirSync answers, not about the
// filesystem. `vi.fn(actual.x)` would delegate to the real function — and
// `mockReset()` restores that delegation — which is how the CI runner came to
// refuse a real `mkdir('/trunk/shared-state')` that Windows had silently created.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), mkdirSync: vi.fn() };
});

import {
  getSharedStatePath,
  tryGetSharedStatePath,
  isSharedPathAccessible,
  assertSharedStoreAccessible,
  ensureStoreSubdir,
  registerDotenvFallback,
  SharedStoreInaccessibleError,
} from '../src/utils/shared-state-path.js';

const ENV = 'ROOSYNC_SHARED_PATH';
const STORE = '/trunk/shared-state';

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[ENV];
  delete process.env[ENV];
  registerDotenvFallback(null);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(mkdirSync).mockReset();
  warn.mockReset();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = originalEnv;
  registerDotenvFallback(null);
});

describe('getSharedStatePath — resolution order', () => {
  test('returns the env var without consulting the fallback', () => {
    process.env[ENV] = STORE;
    const reader = vi.fn(() => '/from/dotenv');
    registerDotenvFallback(reader);
    expect(getSharedStatePath()).toBe(STORE);
    expect(reader).not.toHaveBeenCalled();
  });

  test('consults the registered fallback when the env var is absent, and caches the value', () => {
    const reader = vi.fn(() => '/from/dotenv');
    registerDotenvFallback(reader);
    expect(getSharedStatePath()).toBe('/from/dotenv');
    expect(reader).toHaveBeenCalledTimes(1);
    expect(process.env[ENV]).toBe('/from/dotenv');
  });

  test('the fallback is consulted again once the cached value is gone (lazy, not import-time)', () => {
    const reader = vi.fn(() => '/first');
    registerDotenvFallback(reader);
    expect(getSharedStatePath()).toBe('/first');
    delete process.env[ENV];
    reader.mockReturnValue('/second');
    expect(getSharedStatePath()).toBe('/second');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  test('with no reader registered the trunk is environment-only and throws', () => {
    expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    expect(() => getSharedStatePath()).toThrow(/Google Drive/);
  });

  test('a reader that finds nothing leaves the env unset and throws', () => {
    registerDotenvFallback(() => null);
    expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    expect(process.env[ENV]).toBeUndefined();
  });

  test('registering null clears a previous reader', () => {
    registerDotenvFallback(() => '/from/dotenv');
    expect(getSharedStatePath()).toBe('/from/dotenv');
    delete process.env[ENV];
    registerDotenvFallback(null);
    expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH');
  });
});

describe('tryGetSharedStatePath — safe variant (#1918)', () => {
  test('returns the resolved path', () => {
    process.env[ENV] = STORE;
    expect(tryGetSharedStatePath()).toBe(STORE);
  });

  test('returns null instead of throwing', () => {
    expect(tryGetSharedStatePath()).toBeNull();
  });
});

describe('isSharedPathAccessible — GDrive probe (#1918)', () => {
  test('true when the resolved path exists', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockImplementation((p) => p === STORE);
    expect(isSharedPathAccessible()).toBe(true);
  });

  test('false when the resolved path is absent', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockReturnValue(false);
    expect(isSharedPathAccessible()).toBe(false);
  });

  test('false when nothing resolves', () => {
    expect(isSharedPathAccessible()).toBe(false);
  });

  test('false when the probe throws (permission denied)', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(isSharedPathAccessible()).toBe(false);
  });
});

describe('assertSharedStoreAccessible — fail closed (#3459)', () => {
  test('returns the path when the store root exists', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockReturnValue(true);
    expect(assertSharedStoreAccessible()).toBe(STORE);
  });

  test('throws SharedStoreInaccessibleError when the root is missing', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockReturnValue(false);
    let error: unknown;
    try {
      assertSharedStoreAccessible();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
    expect((error as SharedStoreInaccessibleError).storePath).toBe(STORE);
    expect((error as SharedStoreInaccessibleError).cause).toBe('store-absent');
  });

  test('throws with a null storePath when nothing resolves', () => {
    let error: unknown;
    try {
      assertSharedStoreAccessible();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
    expect((error as SharedStoreInaccessibleError).storePath).toBeNull();
  });

  test('a throwing probe is reported as store-absent for that path', () => {
    process.env[ENV] = STORE;
    vi.mocked(existsSync).mockImplementation(() => {
      throw new Error('EACCES');
    });
    let error: unknown;
    try {
      assertSharedStoreAccessible();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
    expect((error as SharedStoreInaccessibleError).storePath).toBe(STORE);
  });
});

describe('ensureStoreSubdir — the one sanctioned writer (#3459)', () => {
  test('an absent root is skipped, never created, and the WARN names the target', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(ensureStoreSubdir(STORE, 'dashboards')).toBe('skipped-store-absent');
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(join(STORE, 'dashboards'));
  });

  test('a present root gets the subdirectory, recursively', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(ensureStoreSubdir(STORE, 'dashboards', 'archive')).toBe('ensured');
    expect(mkdirSync).toHaveBeenCalledWith(join(STORE, 'dashboards', 'archive'), { recursive: true });
  });

  test('no segments means the root itself', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(ensureStoreSubdir(STORE)).toBe('ensured');
    expect(mkdirSync).toHaveBeenCalledWith(STORE, { recursive: true });
  });

  test('mkdir errors on a present root propagate', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    expect(() => ensureStoreSubdir(STORE, 'x')).toThrow('ENOSPC');
  });
});
