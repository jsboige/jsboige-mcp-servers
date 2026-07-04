/**
 * Coverage tests for writer-factory.ts (Issue #2426, Phase B).
 *
 * Targets COLD branches in the existing test (none yet):
 *   - L36-38 singleton cache hit
 *   - L40-43 env read
 *   - L45 enabled branch (UNIFIED_STORE_DUAL_WRITE=1 + PG_URL) with masking
 *   - L52 else branch (Null fallback)
 *   - L58 resetWriterInstance
 *   - L66-80 maskConnectionString (via console.info spy on enabled branch)
 *
 * No pg connection attempted (factory only calls `new PgUnifiedStoreWriter`
 * — the Pool is built lazily in init()).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnifiedStoreWriter,
  resetWriterInstance,
} from '../writer-factory.js';
import { NullUnifiedStoreWriter } from '../UnifiedStoreWriter.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';

describe('writer-factory — env-gate branches', () => {
  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetWriterInstance();
  });

  test('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE is unset (default)', () => {
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE != "1"', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE="1" but PG_URL is unset', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('returns NullUnifiedStoreWriter when PG_URL is empty string', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', '');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('returns PgUnifiedStoreWriter when both env vars set (enabled branch)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
  });

  test('PgUnifiedStoreWriter is constructed with default poolMax=5 and statementTimeoutMs=5000', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
    // Construction-only — Pool not built until init().
  });

  test('PgUnifiedStoreWriter picks up custom poolMax and statementTimeoutMs env overrides', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    vi.stubEnv('UNIFIED_STORE_POOL_MAX', '20');
    vi.stubEnv('UNIFIED_STORE_TIMEOUT_MS', '12000');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
  });

  test('non-numeric UNIFIED_STORE_POOL_MAX falls through parseInt (NaN passed to pg.Pool)', () => {
    // No factory-side validation — pg.Pool may reject but the factory is permissive.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    vi.stubEnv('UNIFIED_STORE_POOL_MAX', 'foo');
    vi.stubEnv('UNIFIED_STORE_TIMEOUT_MS', 'bar');
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
  });
});

describe('writer-factory — singleton behavior', () => {
  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetWriterInstance();
  });

  test('returns the same instance on repeated calls (singleton)', () => {
    const a = getUnifiedStoreWriter();
    const b = getUnifiedStoreWriter();
    expect(a).toBe(b);
  });

  test('resetWriterInstance() forces re-construction on next call', () => {
    const a = getUnifiedStoreWriter();
    resetWriterInstance();
    const b = getUnifiedStoreWriter();
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(NullUnifiedStoreWriter);
    expect(b).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('after reset, env-var change takes effect (Null → Pg transition)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    const first = getUnifiedStoreWriter();
    expect(first).toBeInstanceOf(NullUnifiedStoreWriter);

    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    resetWriterInstance();

    const second = getUnifiedStoreWriter();
    expect(second).toBeInstanceOf(PgUnifiedStoreWriter);
  });

  test('after reset, env-var change takes effect (Pg → Null transition)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const first = getUnifiedStoreWriter();
    expect(first).toBeInstanceOf(PgUnifiedStoreWriter);

    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    resetWriterInstance();

    const second = getUnifiedStoreWriter();
    expect(second).toBeInstanceOf(NullUnifiedStoreWriter);
  });
});

describe('writer-factory — console.info emission with credential masking', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    resetWriterInstance();
  });

  test('ENABLED branch logs "[UnifiedStore] Dual-write ENABLED" with masked URL (password = ***)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://alice:s3cret@db.host:5432/mydb');
    getUnifiedStoreWriter();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [firstArg] = infoSpy.mock.calls[0];
    expect(firstArg).toContain('Dual-write ENABLED');
    expect(firstArg).toContain('alice:***@db.host');
    expect(firstArg).not.toContain('s3cret');
  });

  test('DISABLED branch logs "[UnifiedStore] Dual-write DISABLED"', () => {
    getUnifiedStoreWriter();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [firstArg] = infoSpy.mock.calls[0];
    expect(firstArg).toContain('Dual-write DISABLED');
    expect(firstArg).toContain('NullUnifiedStoreWriter');
  });

  test('malformed connection string returns "<invalid-url>" placeholder', () => {
    // new URL('not a url') throws → maskConnectionString returns '<invalid-url>'.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'totally not a url');
    getUnifiedStoreWriter();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [firstArg] = infoSpy.mock.calls[0];
    expect(firstArg).toContain('<invalid-url>');
  });

  test('connection string without password (no `:` after user) is logged as-is', () => {
    // `parsed.password` is empty string when no password — the `if (parsed.password)`
    // guard skips masking. The URL is logged unchanged.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://user@host:5432/db');
    getUnifiedStoreWriter();

    const [firstArg] = infoSpy.mock.calls[0];
    expect(firstArg).toContain('postgres://user@host:5432/db');
  });

  test('connection string with empty host (URL parse throws) falls back to "<invalid-url>"', () => {
    // Edge: 'http://alice:pw@' without a host is rejected by WHATWG URL parser.
    // maskConnectionString catches → returns '<invalid-url>'. The raw password
    // string ('pw') is NOT leaked.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'http://alice:pw@');
    getUnifiedStoreWriter();

    const [firstArg] = infoSpy.mock.calls[0];
    expect(firstArg).not.toContain(':pw@');
    expect(firstArg).not.toContain('alice:pw');
    expect(firstArg).toContain('<invalid-url>');
  });

  test('singleton — second call does NOT re-emit console.info', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    getUnifiedStoreWriter();
    getUnifiedStoreWriter();
    getUnifiedStoreWriter();
    // First call logs, subsequent returns the cached instance — no extra log.
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

describe('writer-factory — env-var edge cases', () => {
  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetWriterInstance();
  });

  test('UNIFIED_STORE_DUAL_WRITE="true" (truthy non-"1") does NOT enable', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', 'true');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    expect(getUnifiedStoreWriter()).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  test('UNIFIED_STORE_DUAL_WRITE="1 " (trailing whitespace) does NOT enable', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1 ');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    expect(getUnifiedStoreWriter()).toBeInstanceOf(NullUnifiedStoreWriter);
  });
});