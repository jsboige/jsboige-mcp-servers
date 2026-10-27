/**
 * Unit tests for the PG cutover flag resolver (#4131).
 *
 * THE CONTRACT (services/unified-store/pg-flags.ts):
 *   - '1' / 'true'  → ON   (explicit, backward compatible)
 *   - '0' / 'false' → OFF  (EMERGENCY KILL-SWITCH)
 *   - unset / other → ON iff UNIFIED_STORE_PG_URL is set, else OFF
 *
 * The point of the helper: a seat that holds a PG URL is ON PG by DEFAULT.
 * Before #4131 the gates were `=== '1'`, so a seat got nothing unless
 * someone edited its gitignored .env by hand — the fix existed but was not
 * deployed (user directive 27/10: « ON corrige, on déploie, basta »).
 *
 * #2656 applies here too: `vi.unstubAllEnvs()` restores the OS-inherited
 * state, not a clean slate. Every test starts from an explicitly cleared
 * env so a host that exports UNIFIED_STORE_PG_URL in its OS env cannot
 * make a test pass or fail for the wrong reason.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const logged: { message: string; meta: unknown }[] = [];

// The logger is mocked so the "logged ONCE, value NEVER printed" contract of
// the ignored-PG-URL warning can be asserted (review NanoClaw, C2).
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    warn: (message: string, meta?: unknown) => {
      logged.push({ message, meta });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import {
  isPgFlagOn,
  hasPgUrl,
  pgFlagState,
  isPgFlagExplicitlyOn,
  isPgFlagExplicitlyOff,
  resetIgnoredPgUrlWarning,
} from '../pg-flags.js';

const FLAG = 'UNIFIED_STORE_DUAL_WRITE';

function clearEnv(): void {
  delete process.env[FLAG];
  delete process.env.UNIFIED_STORE_PG_URL;
}

describe('pg-flags — isPgFlagOn', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
  });

  test('unset flag + PG URL set → ON (the default path of the cutover)', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test('unset flag + NO PG URL → OFF (a seat without PG sees no change)', () => {
    expect(isPgFlagOn(FLAG)).toBe(false);
  });

  test("'0' → OFF even with a PG URL (the emergency kill-switch)", () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    vi.stubEnv(FLAG, '0');
    expect(isPgFlagOn(FLAG)).toBe(false);
  });

  test("'false' → OFF even with a PG URL (kill-switch, word form)", () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    vi.stubEnv(FLAG, 'false');
    expect(isPgFlagOn(FLAG)).toBe(false);
  });

  test("'1' without a PG URL → ON (the flag alone arms the gate)", () => {
    vi.stubEnv(FLAG, '1');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test("'true' → ON with a PG URL (explicit word form, backward compatible)", () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    vi.stubEnv(FLAG, 'true');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test("'true' without a PG URL → ON (the flag alone arms the gate)", () => {
    vi.stubEnv(FLAG, 'true');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test('an unrecognised value falls back to the default (ON with a PG URL)', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    vi.stubEnv(FLAG, 'yes-please');
    expect(pgFlagState(FLAG)).toBe('default');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test('an unrecognised value falls back to the default (OFF without a PG URL)', () => {
    vi.stubEnv(FLAG, 'yes-please');
    expect(isPgFlagOn(FLAG)).toBe(false);
  });

  // --- NanoClaw C1: the kill-switch is not '0'-only.
  //
  // An operator who writes "off", "no", "n", "disable" or "disabled" MEANS
  // "stop". Before this change those values fell through to the DEFAULT,
  // which ARMS the cutover when a PG URL is present — the exact opposite of
  // the intent. Every recognised "no" spelling is now an explicit OFF.
  test.each(['off', 'no', 'n', 'disable', 'disabled'])(
    "'%s' is an explicit OFF (the kill-switch is not 0-only)",
    (value) => {
      vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
      vi.stubEnv(FLAG, value);
      expect(pgFlagState(FLAG)).toBe('off');
      expect(isPgFlagExplicitlyOff(FLAG)).toBe(true);
      expect(isPgFlagExplicitlyOn(FLAG)).toBe(false);
      // The decisive one: with a PG URL present, the flag must NOT arm.
      expect(isPgFlagOn(FLAG)).toBe(false);
    },
  );

  test('the kill-switch spellings are case- and whitespace-insensitive', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    for (const value of [' OFF ', 'No', 'DISABLED', ' Disable ']) {
      vi.stubEnv(FLAG, value);
      expect(pgFlagState(FLAG)).toBe('off');
      expect(isPgFlagOn(FLAG)).toBe(false);
    }
  });

  test('an unknown value does NOT fail closed — it keeps the default', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    for (const value of ['maybe', 'yes', '2', 'enabled', 'on']) {
      vi.stubEnv(FLAG, value);
      expect(pgFlagState(FLAG)).toBe('default');
      expect(isPgFlagOn(FLAG)).toBe(true);
    }
  });

  test("case and surrounding whitespace are tolerated (' TRUE ' → ON)", () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    vi.stubEnv(FLAG, ' TRUE ');
    expect(isPgFlagOn(FLAG)).toBe(true);
  });

  test('an empty PG URL counts as no PG URL (the default resolves OFF)', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', '');
    expect(isPgFlagOn(FLAG)).toBe(false);
  });
});

describe('pg-flags — hasPgUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
    logged.length = 0;
    resetIgnoredPgUrlWarning();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
  });

  test('true when the PG URL is set', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    expect(hasPgUrl()).toBe(true);
  });

  test('false when the PG URL is unset', () => {
    expect(hasPgUrl()).toBe(false);
  });

  test('false when the PG URL is an empty string', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', '');
    expect(hasPgUrl()).toBe(false);
  });

  // --- NanoClaw C2: a placeholder URL must not arm the dual-write.
  test.each([
    'none',
    'None',
    'changeme',
    'postgres:/u:p@host:5432/db',
    'postgresql:/u:p@host',
    'mysql://u:p@host:3306/db',
    'http://host:5432/db',
    'localhost:5432',
  ])('false for the non-postgres placeholder %s', (value) => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', value);
    expect(hasPgUrl()).toBe(false);
    // And the gate it feeds must NOT be armed by a placeholder.
    expect(isPgFlagOn(FLAG)).toBe(false);
  });

  test.each([
    'postgres://u:p@host:5432/db',
    'postgresql://u:p@host:5432/db',
    'POSTGRES://u:p@host:5432/db',
    'PostgreSQL://u:p@host:5432/db',
    '  postgres://u:p@host:5432/db  ',
  ])('true for the real postgres URL %s', (value) => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', value);
    expect(hasPgUrl()).toBe(true);
  });

  test('an ignored placeholder is logged ONCE, and the value is never printed', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'none');
    expect(hasPgUrl()).toBe(false);
    expect(hasPgUrl()).toBe(false);
    expect(hasPgUrl()).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('UNIFIED_STORE_PG_URL');
    const serialized = `${logged[0].message} ${JSON.stringify(logged[0].meta)}`;
    expect(serialized).not.toContain('none');
    // The name is named, the value is masked.
    expect(JSON.stringify(logged[0].meta)).toContain('<redacted:UNIFIED_STORE_PG_URL>');
  });

  test('a real PG URL logs nothing', () => {
    vi.stubEnv('UNIFIED_STORE_PG_URL', 'postgres://u:p@host:5432/db');
    expect(hasPgUrl()).toBe(true);
    expect(logged).toHaveLength(0);
  });
});

describe('pg-flags — pgFlagState (three states)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearEnv();
  });

  // The READ gates need to tell an EXPLICIT '1' (the operator forced it) from
  // the DEFAULT (unset → the backfill marker decides) — review ms#1540.

  test("'1' and 'true' resolve to the explicit ON state", () => {
    vi.stubEnv(FLAG, '1');
    expect(pgFlagState(FLAG)).toBe('on');
    expect(isPgFlagExplicitlyOn(FLAG)).toBe(true);
    expect(isPgFlagExplicitlyOff(FLAG)).toBe(false);

    vi.stubEnv(FLAG, 'true');
    expect(pgFlagState(FLAG)).toBe('on');
  });

  test("'0' and 'false' resolve to the explicit OFF state", () => {
    vi.stubEnv(FLAG, '0');
    expect(pgFlagState(FLAG)).toBe('off');
    expect(isPgFlagExplicitlyOff(FLAG)).toBe(true);
    expect(isPgFlagExplicitlyOn(FLAG)).toBe(false);

    vi.stubEnv(FLAG, 'false');
    expect(pgFlagState(FLAG)).toBe('off');
  });

  test('an unset flag resolves to the DEFAULT state', () => {
    expect(pgFlagState(FLAG)).toBe('default');
    expect(isPgFlagExplicitlyOn(FLAG)).toBe(false);
    expect(isPgFlagExplicitlyOff(FLAG)).toBe(false);
  });

  test('an unrecognised value resolves to the DEFAULT state', () => {
    vi.stubEnv(FLAG, 'maybe');
    expect(pgFlagState(FLAG)).toBe('default');
  });

  test('case and whitespace are tolerated on both explicit states', () => {
    vi.stubEnv(FLAG, ' TRUE ');
    expect(pgFlagState(FLAG)).toBe('on');
    vi.stubEnv(FLAG, ' False ');
    expect(pgFlagState(FLAG)).toBe('off');
  });
});
