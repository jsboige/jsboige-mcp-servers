/**
 * #833 Sprint C3 — ConfigDiffService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `ConfigDiffService.test.ts` (9 tests) covers the happy paths of the
 * deep-compare recursion (object add/delete/modify, nested objects, positional
 * array add+modify, secret→critical, delete→warning). It leaves a cluster of
 * genuine conditional branches cold:
 *
 * - Cas 1 **type mismatch** (L32-35): `typeof baseline !== typeof current`
 *   produces a modify change — base always compares same-typed values.
 * - Cas 2 **null handling** (L38): `baseline === null` and `current === null`
 *   arms — base always pairs same-nulliness values, so the null short-circuit
 *   that prevents recursing into a null is never exercised.
 * - Cas 3 **array delete** (L53-55): `i >= current.length` → delete — base
 *   only exercises array add (L50-52) and element modify (L57), never a
 *   shrinking array.
 * - Cas 4 **array-vs-object fallthrough**: a baseline array vs a current plain
 *   object (both `typeof 'object'`, neither null, not both Array.isArray) skips
 *   Cas 3 and reaches the object-key loop (L64-80) — never exercised.
 * - `calculateSeverity` **'info' default** (L107): the add/modify non-secret
 *   arm is exercised by base "added keys" but its severity is never asserted.
 * - `calculateSeverity` **regex members** (L98): base only triggers 'key'
 *   (via `apiKey`); the password/token/auth/secret/credential variants are cold.
 * - `compare` **sourceVersion/targetVersion params** (L12): base never passes
 *   custom version labels; the param passthrough into DiffResult is unasserted.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `ConfigDiffService.ts`.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ConfigDiffService } from '../ConfigDiffService.js';

describe('ConfigDiffService — branch coverage (#833 C3, source-grounded)', () => {
  let service: ConfigDiffService;

  beforeEach(() => {
    service = new ConfigDiffService();
  });

  // ============================================================
  // Cas 1 — type mismatch (L32-35)
  // ============================================================
  describe('deepCompare Cas 1 — type mismatch (L32-35)', () => {
    test('different typeof (number vs string) yields a modify with both values (L32-34)', () => {
      const report = service.compare({ port: 8080 }, { port: '8080' });
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0]).toMatchObject({
        type: 'modify',
        path: ['port'],
        oldValue: 8080,
        newValue: '8080',
      });
      expect(report.summary.modified).toBe(1);
    });

    test('undefined vs object at root yields a single modify (L32-34)', () => {
      // baseline undefined (typeof 'undefined') vs current object (typeof 'object').
      const report = service.compare(undefined, { a: 1 });
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0].type).toBe('modify');
      expect(report.changes[0].oldValue).toBeUndefined();
    });

    test('type mismatch recurses through nested path (L32 within nested key)', () => {
      const baseline = { cfg: { n: 5 } };
      const current = { cfg: { n: [1, 2] } }; // number vs object at cfg.n
      const report = service.compare(baseline, current);
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0]).toMatchObject({
        type: 'modify',
        path: ['cfg', 'n'],
        oldValue: 5,
      });
    });
  });

  // ============================================================
  // Cas 2 — null handling (L38)
  // ============================================================
  describe('deepCompare Cas 2 — null short-circuit (L38)', () => {
    test('baseline null vs current object yields a modify, does NOT recurse (L38, L39-41)', () => {
      // baseline === null → Cas 2 short-circuit: null !== {a:1} → modify at root.
      const report = service.compare(null, { a: 1 });
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0].type).toBe('modify');
      expect(report.changes[0].newValue).toEqual({ a: 1 });
    });

    test('current null vs baseline object yields a modify (L38 current===null arm)', () => {
      // current === null arm of the L38 disjunction: object !== null → modify.
      const report = service.compare({ a: 1 }, null);
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0].type).toBe('modify');
      expect(report.changes[0].oldValue).toEqual({ a: 1 });
    });

    test('both null → no change (L39 baseline !== current is false)', () => {
      const report = service.compare(null, null);
      expect(report.changes).toHaveLength(0);
    });
  });

  // ============================================================
  // Cas 3 — array delete (L53-55)
  // ============================================================
  describe('deepCompare Cas 3 — array shrink/delete (L53-55)', () => {
    test('shrinking an array yields delete changes for removed tail elements (L53-55)', () => {
      const report = service.compare({ list: [1, 2, 3] }, { list: [1] });
      // index 1 deleted (2), index 2 deleted (3)
      expect(report.summary.deleted).toBe(2);
      const dels = report.changes.filter(c => c.type === 'delete');
      expect(dels).toHaveLength(2);
      expect(dels.map(c => c.path)).toEqual([['list', '1'], ['list', '2']]);
      expect(dels.map(c => c.oldValue)).toEqual([2, 3]);
      // Array deletion severity is 'warning' (L103-105) — pin it for the array path.
      expect(dels.every(c => c.severity === 'warning')).toBe(true);
    });
  });

  // ============================================================
  // Cas 4 — array-vs-object fallthrough (L46 false → L64-80)
  // ============================================================
  describe('deepCompare Cas 4 — array-vs-object fallthrough (L46, L64-80)', () => {
    test('baseline array vs current object reaches the object-key loop (L64-80)', () => {
      // typeof both 'object', neither null, NOT both Array.isArray → Cas 3 skipped,
      // falls into Cas 4: Object.keys(['x']) = ['0'], Object.keys({...}) = ['a'].
      // Key '0' in baseline (array) but not in current → delete; 'a' in current not in baseline → add.
      const report = service.compare(['x'], { a: 1 });
      const types = report.changes.map(c => c.type).sort();
      expect(types).toEqual(['add', 'delete']);
      const del = report.changes.find(c => c.type === 'delete');
      expect(del?.path).toEqual(['0']);
      expect(del?.oldValue).toBe('x');
      const add = report.changes.find(c => c.type === 'add');
      expect(add?.path).toEqual(['a']);
      expect(add?.newValue).toBe(1);
    });

    test('object vs baseline array recurses per-key (L77-78 on the intersect)', () => {
      // Both have key '0' (array index vs object key) → recurse into deepCompare.
      const report = service.compare(['x'], { 0: 'y' });
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0]).toMatchObject({ type: 'modify', path: ['0'], oldValue: 'x', newValue: 'y' });
    });
  });

  // ============================================================
  // calculateSeverity — 'info' default + regex members (L98, L107)
  // ============================================================
  describe('calculateSeverity — info default + sensitive-key regex members (L98-107)', () => {
    test('a non-secret add yields severity info (L107, exercised-not-asserted in base)', () => {
      const report = service.compare({ a: 1 }, { a: 1, b: 2 });
      const addChange = report.changes.find(c => c.type === 'add');
      expect(addChange?.severity).toBe('info');
    });

    test.each([
      ['password', 'dbPassword'],
      ['token', 'authToken'],
      ['secret', 'clientSecret'],
      ['auth', 'authProvider'],
      ['credential', 'awsCredentials'],
    ] as const)('sensitive key "%s" (via %s) → critical severity (L98 regex)', (_member, key) => {
      const report = service.compare({ [key]: 'old' }, { [key]: 'new' });
      expect(report.changes).toHaveLength(1);
      expect(report.changes[0].severity).toBe('critical');
    });

    test('sensitive regex is case-insensitive (TOKEN upper matches, L98 /i flag)', () => {
      const report = service.compare({ API_TOKEN: 'a' }, { API_TOKEN: 'b' });
      expect(report.changes[0].severity).toBe('critical');
    });

    test('a plain modify (non-secret, non-delete) yields info (L107)', () => {
      const report = service.compare({ port: 1 }, { port: 2 });
      expect(report.changes[0].severity).toBe('info');
    });
  });

  // ============================================================
  // compare — sourceVersion/targetVersion passthrough (L12)
  // ============================================================
  describe('compare — version-label passthrough (L12, L18-19)', () => {
    test('default version labels are "local" / "baseline" (L12 defaults)', () => {
      const report = service.compare({}, {});
      expect(report.sourceVersion).toBe('local');
      expect(report.targetVersion).toBe('baseline');
    });

    test('custom source/target labels flow into the DiffResult (L18-19)', () => {
      const report = service.compare({}, {}, 'machine-po2026', 'fleet-baseline-v3');
      expect(report.sourceVersion).toBe('machine-po2026');
      expect(report.targetVersion).toBe('fleet-baseline-v3');
    });

    test('summary.conflicts is always 0 and timestamp is ISO (L25, L17)', () => {
      const report = service.compare({ a: 1 }, { a: 2 });
      expect(report.summary.conflicts).toBe(0);
      expect(typeof report.timestamp).toBe('string');
      expect(() => new Date(report.timestamp).toISOString()).not.toThrow();
    });

    test('every change carries a uuid id (L85 addChange)', () => {
      // Contract (L85): id is whatever uuidv4() returns. The global test setup
      // mocks uuid to a fixed 'test-uuid-...' sentinel, so assert the id is a
      // unique non-empty string per change — not the real uuid format.
      const report = service.compare({ a: 1, b: 2 }, { a: 3, b: 4, c: 5 });
      expect(report.changes.length).toBeGreaterThan(1);
      for (const c of report.changes) {
        expect(typeof c.id).toBe('string');
        expect(c.id.length).toBeGreaterThan(0);
      }
      // Each change gets its own id (uuidv4 called per addChange).
      const ids = report.changes.map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
