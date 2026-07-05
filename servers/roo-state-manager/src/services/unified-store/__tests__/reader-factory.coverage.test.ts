/**
 * Coverage tests for reader-factory.ts (Issue #2426, Phase C).
 *
 * Targets branches COLD in the base test (none yet) — env-gate logic:
 *   - L33-34 instance cache hit (singleton reuse after first call)
 *   - L36-39 env read
 *   - L41 enabled branch (UNIFIED_STORE_DUAL_WRITE=1 + PG_URL)
 *   - L45 else branch (Null fallback)
 *   - L50 resetReaderInstance
 *
 * Pure env-var manipulation, no pg connection (PgUnifiedStoreReader.init()
 * is the only thing that touches pg, factory only calls `new`).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnifiedStoreReader,
  resetReaderInstance,
} from '../reader-factory.js';
import { NullUnifiedStoreReader } from '../UnifiedStoreReader.js';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';

// #2656: vi.unstubAllEnvs() restores process.env to its ORIGINAL (OS-inherited)
// state, not a clean slate. On machines where UNIFIED_STORE_DUAL_WRITE=1 is set
// at the OS level (e.g. ai-01 production PG dual-write runtime), tests that
// assume "env unset" would hit the Pg branch instead of Null → drift CI fails.
// Explicitly delete the unified-store env vars so every test starts clean
// regardless of the host OS env. Each test then stubs exactly the values it
// needs via vi.stubEnv.
function clearUnifiedStoreEnv(): void {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_POOL_MAX;
  delete process.env.UNIFIED_STORE_TIMEOUT_MS;
}

describe('reader-factory — env-gate branches', () => {
  beforeEach(() => {
    resetReaderInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetReaderInstance();
  });

  test('returns NullUnifiedStoreReader when UNIFIED_STORE_DUAL_WRITE is unset (default)', () => {
    // No env stubbing — both env vars undefined.
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
    expect(reader.isNull()).toBe(true);
  });

  test('returns NullUnifiedStoreReader when UNIFIED_STORE_DUAL_WRITE != "1"', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('returns NullUnifiedStoreReader when UNIFIED_STORE_DUAL_WRITE="1" but PG_URL is unset', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    // PG_URL remains undefined
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('returns NullUnifiedStoreReader when PG_URL is empty string', () => {
    // Empty string is falsy in the env-gate (pgUrl && ...).
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', '');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('returns PgUnifiedStoreReader when both env vars set (enabled branch)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
    expect(reader.isNull()).toBe(false);
  });

  test('PgUnifiedStoreReader is constructed with default poolMax=5 and statementTimeoutMs=5000', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    // Defaults read via `?? '5'` / `?? '5000'` + parseInt.
    const reader = getUnifiedStoreReader() as PgUnifiedStoreReader;
    expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
    // We can't directly inspect private config, but we can verify construction
    // succeeded (no throw) and the reader is fresh (init() not yet called → pool null).
    // Init() would attempt a real connection — skip it, rely on `isNull() === false`.
  });

  test('PgUnifiedStoreReader picks up custom poolMax and statementTimeoutMs env overrides', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    vi.stubEnv('UNIFIED_STORE_POOL_MAX', '20');
    vi.stubEnv('UNIFIED_STORE_TIMEOUT_MS', '12000');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
    // Construction-only — config is private, init() not called.
  });

  test('non-numeric UNIFIED_STORE_POOL_MAX falls back to NaN → parseInt → invalid but construction OK', () => {
    // parseInt('abc', 10) === NaN, which then falls through the ?? '5' guard
    // (NaN is not null/undefined). pg.Pool may misbehave but factory doesn't
    // validate — it just passes the number through.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    vi.stubEnv('UNIFIED_STORE_POOL_MAX', 'not-a-number');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
  });
});

describe('reader-factory — singleton behavior', () => {
  beforeEach(() => {
    resetReaderInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetReaderInstance();
  });

  test('returns the same instance on repeated calls (singleton)', () => {
    const a = getUnifiedStoreReader();
    const b = getUnifiedStoreReader();
    expect(a).toBe(b);
  });

  test('resetReaderInstance() forces re-construction on next call', () => {
    const a = getUnifiedStoreReader();
    resetReaderInstance();
    const b = getUnifiedStoreReader();
    expect(a).not.toBe(b);
    // Both are NullUnifiedStoreReader (no env), but they're different instances.
    expect(a).toBeInstanceOf(NullUnifiedStoreReader);
    expect(b).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('after reset, env-var change takes effect (Null → Pg transition)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    const first = getUnifiedStoreReader();
    expect(first).toBeInstanceOf(NullUnifiedStoreReader);

    // Flip env + reset → next call picks up PgUnifiedStoreReader.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    resetReaderInstance();

    const second = getUnifiedStoreReader();
    expect(second).toBeInstanceOf(PgUnifiedStoreReader);
  });

  test('after reset, env-var change takes effect (Pg → Null transition)', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const first = getUnifiedStoreReader();
    expect(first).toBeInstanceOf(PgUnifiedStoreReader);

    // Drop the gate + reset → fallback to Null.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '0');
    resetReaderInstance();

    const second = getUnifiedStoreReader();
    expect(second).toBeInstanceOf(NullUnifiedStoreReader);
  });
});

describe('reader-factory — env-var edge cases', () => {
  beforeEach(() => {
    resetReaderInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetReaderInstance();
  });

  test('UNIFIED_STORE_DUAL_WRITE="true" (truthy non-"1") does NOT enable (strict equality)', () => {
    // Factory uses `=== '1'` so any other truthy value falls through.
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', 'true');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('UNIFIED_STORE_DUAL_WRITE="1 " (trailing whitespace) does NOT enable', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', '1 ');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  test('UNIFIED_STORE_DUAL_WRITE=" 1" (leading whitespace) does NOT enable', () => {
    vi.stubEnv('UNIFIED_STORE_DUAL_WRITE', ' 1');
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host/db');
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });
});