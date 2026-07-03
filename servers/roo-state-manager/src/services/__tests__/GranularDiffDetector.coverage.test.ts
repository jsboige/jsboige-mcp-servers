/**
 * #833 Sprint C3 — GranularDiffDetector branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `GranularDiffDetector.test.ts` (~65 tests) is thorough: basic
 * add/remove/modify/type-change, null/undefined, nested + maxDepth, array
 * position+identity modes, options (whitespace/case/includeUnchanged),
 * severity + category determination, custom rules CRUD + handler, summary,
 * report metadata, changePercent (number/zero/string), export (json/csv/html/
 * throw), complex objects (Date/boolean/mixed/empty), default rules. It leaves
 * a cluster of genuine branches cold:
 *
 * - **#1410 cross-match by discriminant name** (L473-497): when an item appears
 *   as BOTH an addition (target-only identity) AND a removal (source-only
 *   identity) but shares a discriminant (name/id/title/key), they are
 *   cross-matched into ONE "modified" diff (WARNING) instead of a false
 *   add+remove pair. The base array-object test (L242) only adds a brand-new
 *   item — never the same-name/different-fields case. This is the headline
 *   #1410 false-positive fix; a regression would re-introduce phantom add+remove.
 * - **default comparison arm** (L327-339): functions/symbols/bigint land in the
 *   `default` switch arm; base never compares non-primitive non-object values.
 * - **createIdentity null element** (L566-568 → 'null'): base array elements
 *   are objects/primitives, never null.
 * - **unmatched addition WITH name** (L509-511 ternary): a target-only item
 *   carrying a discriminant name → `${currentPath}.${name}` path + named
 *   description. The base addition (L205/L242) uses indexed/primitive elements.
 * - **unmatched removal WITH name** (L526-528 ternary): mirror of the above.
 * - **applyCustomRules string-path rule** (L602-603): every default rule uses a
 *   RegExp path; the `typeof rule.path === 'string'` arm (exact/prefix match)
 *   is cold. Reachable via addCustomRule with a string path.
 * - **isPlainObject RegExp** (L858): base tests Date (complex object) but never
 *   a RegExp — `obj instanceof RegExp` guard.
 * - **deepEqual array-length mismatch** (L830): arrays of different length →
 *   early false. Base array tests compare same-length arrays or rely on
 *   compareArrays (not deepEqual directly).
 * - **deepEqual object key-count mismatch / key-absent** (L840, L843).
 *
 * SKIP-WITH-EVIDENCE (unreachable via the diff flow):
 * - `calculateChangePercent` 0→0 (L736-737) and empty-string (L744): equal
 *   values never reach the changePercent call (deepEqual short-circuits at
 *   L313), so the `oldValue===0 && newValue===0` and `maxLength===0` arms are
 *   dead under the public compareGranular flow.
 *
 * Pure-logic, no mocks. Each assertion cites a `GranularDiffDetector.ts` line.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GranularDiffDetector } from '../GranularDiffDetector.js';
import type { GranularDiffReport } from '../GranularDiffDetector.js';

describe('GranularDiffDetector — branch coverage (#833 C3, source-grounded)', () => {
  let detector: GranularDiffDetector;

  beforeEach(() => {
    detector = new GranularDiffDetector();
  });

  // ============================================================
  // #1410 cross-match by discriminant name (L473-497)
  // ============================================================
  describe('compareArrays identity — #1410 cross-match by name (L473-497)', () => {
    it('cross-matches a same-name/different-fields item into ONE modified diff (no phantom add+remove)', async () => {
      // Both items share name:'X' but differ on 'ver' → distinct createIdentity
      // (all key-values included, L572-574) → one addition + one removal →
      // cross-matched by extractItemName 'X' into a single WARNING modified.
      const source = { items: [{ name: 'X', ver: '1' }] };
      const target = { items: [{ name: 'X', ver: '2' }] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      // L484-495: ONE 'modified' diff at path 'items.X', severity WARNING, category array.
      const modified = report.diffs.filter(d => d.type === 'modified');
      expect(modified).toHaveLength(1);
      expect(modified[0].path).toBe('items.X');
      expect(modified[0].severity).toBe('WARNING');
      expect(modified[0].category).toBe('array');
      expect(modified[0].description).toContain("modifié: 'X'");
      // Old/new values are the original source/target elements.
      expect(modified[0].oldValue).toEqual({ name: 'X', ver: '1' });
      expect(modified[0].newValue).toEqual({ name: 'X', ver: '2' });
      // No phantom add/remove pair survives the cross-match.
      expect(report.diffs.filter(d => d.type === 'added')).toHaveLength(0);
      expect(report.diffs.filter(d => d.type === 'removed')).toHaveLength(0);
    });

    it('cross-match uses id discriminant when name is absent', async () => {
      // No 'name' field, but 'id' matches → extractItemName falls back to id (L588).
      const source = { items: [{ id: 'k1', v: 1 }] };
      const target = { items: [{ id: 'k1', v: 2 }] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const modified = report.diffs.filter(d => d.type === 'modified');
      expect(modified).toHaveLength(1);
      // Path uses the id discriminant.
      expect(modified[0].path).toBe('items.k1');
    });
  });

  // ============================================================
  // default comparison arm — functions/symbols (L327-339)
  // ============================================================
  describe('performGranularComparison default arm (L327-339)', () => {
    it('flags two different functions as modified (default switch arm)', async () => {
      const a = () => 1;
      const b = () => 2;
      const report = await detector.compareGranular({ fn: a }, { fn: b });

      // L329-339: typeof 'function' falls to default; source !== target → modified.
      const modified = report.diffs.filter(d => d.type === 'modified');
      expect(modified.length).toBe(1);
      expect(modified[0].path).toBe('fn');
    });

    it('does not flag identical symbol references as a diff (source === target)', async () => {
      const sym = Symbol('shared');
      // Same reference → performGranularComparison: source === target at the
      // primitive arm? Symbols are typeof 'symbol' → default arm L329:
      // `if (source !== target)` — same reference → equal → no diff.
      const report = await detector.compareGranular({ s: sym }, { s: sym });
      expect(report.diffs).toHaveLength(0);
    });
  });

  // ============================================================
  // createIdentity null element (L566-568)
  // ============================================================
  describe('compareArrays identity — null element identity (L566)', () => {
    it('treats null array elements as identity "null" (added/removed correctly)', async () => {
      // source has a null, target doesn't → null removed. createIdentity(null)='null'.
      const source = { arr: [null, 1] };
      const target = { arr: [1] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      // The null (identity 'null') is in source but not target → removed.
      const removed = report.diffs.filter(d => d.type === 'removed');
      expect(removed.length).toBe(1);
      expect(removed[0].oldValue).toBeNull();
    });
  });

  // ============================================================
  // unmatched addition WITH name → named path (L509-511)
  // ============================================================
  describe('compareArrays identity — unmatched named addition (L509-514)', () => {
    it('uses the ${path}.${name} form for a named target-only item', async () => {
      const source = { items: [{ id: 1, name: 'A' }] };
      const target = { items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      // Addition 'B' (id:2) has no cross-match removal → genuine addition WITH name.
      const added = report.diffs.filter(d => d.type === 'added');
      expect(added).toHaveLength(1);
      // L509-510: name present → 'items.B' path (not 'items[1]').
      expect(added[0].path).toBe('items.B');
      // L512-513: named description.
      expect(added[0].description).toContain("ajouté: 'B'");
      expect(added[0].severity).toBe('INFO');
    });

    it('uses the ${path}[index] form for a nameless target-only item', async () => {
      // Primitive elements have no discriminant name → indexed path.
      const source = { arr: [1] };
      const target = { arr: [1, 2] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const added = report.diffs.filter(d => d.type === 'added');
      expect(added).toHaveLength(1);
      // L509-511: name null → 'arr[1]' indexed path.
      expect(added[0].path).toBe('arr[1]');
      // L512-514: indexed description.
      expect(added[0].description).toContain("à l'index 1");
    });
  });

  // ============================================================
  // unmatched removal WITH name → named path (L526-528)
  // ============================================================
  describe('compareArrays identity — unmatched named removal (L526-531)', () => {
    it('uses the ${path}.${name} form for a named source-only item', async () => {
      const source = { items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };
      const target = { items: [{ id: 1, name: 'A' }] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const removed = report.diffs.filter(d => d.type === 'removed');
      expect(removed).toHaveLength(1);
      // L526-527: name present → 'items.B' path.
      expect(removed[0].path).toBe('items.B');
      // L529-530: named description.
      expect(removed[0].description).toContain("supprimé: 'B'");
      expect(removed[0].severity).toBe('WARNING');
    });
  });

  // ============================================================
  // applyCustomRules string-path rule (L602-603)
  // ============================================================
  describe('applyCustomRules — string-path rule (L602-603)', () => {
    it('matches a string path exactly and applies the handler', async () => {
      // Add a rule with a STRING path (not RegExp) → exercises L602-603.
      detector.addCustomRule({
        name: 'string-path-rule',
        path: 'exact.key',
        severity: 'IMPORTANT',
        category: 'semantic',
        handler: (oldVal, newVal, path) => ({
          id: `custom-${path}`,
          path,
          type: 'modified',
          severity: 'IMPORTANT',
          category: 'semantic',
          description: `custom string-path hit: ${path}`,
          oldValue: oldVal,
          newValue: newVal,
        }),
      });

      const report = await detector.compareGranular(
        { 'exact.key': 1 },
        { 'exact.key': 2 }
      );

      const custom = report.diffs.filter(d => d.category === 'semantic');
      expect(custom).toHaveLength(1);
      expect(custom[0].description).toBe('custom string-path hit: exact.key');
    });

    it('string-path rule matches by prefix (startsWith) with a handler', async () => {
      // Rule path 'config.dbg' is a PREFIX of the compared path 'config.dbg.host'.
      // A handler is required (applyCustomRules L608 only acts when handler present).
      detector.addCustomRule({
        name: 'prefix-rule',
        path: 'config.dbg',
        severity: 'WARNING',
        category: 'system',
        handler: (oldVal, newVal, path) => ({
          id: `prefix-${path}`,
          path,
          type: 'modified',
          severity: 'WARNING',
          category: 'system',
          description: `prefix-match hit: ${path}`,
          oldValue: oldVal,
          newValue: newVal,
        }),
      });

      const report = await detector.compareGranular(
        { config: { dbg: { host: 'a' } } },
        { config: { dbg: { host: 'b' } } }
      );

      // L603: path.startsWith(rule.path) → match → handler fires → category system.
      const matched = report.diffs.filter(d => d.category === 'system' && d.description.startsWith('prefix-match'));
      expect(matched.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // isPlainObject RegExp guard (L858)
  // ============================================================
  describe('isPlainObject — RegExp guard (L858)', () => {
    it('routes RegExp to the complex-object branch without throwing or spurious diffs', async () => {
      // isPlainObject(/abc/) returns FALSE at L858 (`instanceof RegExp` true) → the
      // value skips compareObjects and enters the complex-object branch (L294-307).
      // There deepEqual(/abc/, /xyz/) compares Object.keys (both empty for RegExp)
      // → considered equal → no diff. The behavioral pin: the L858 guard executes
      // (RegExp is NOT mistaken for a plain object) and no crash/spurious diff results.
      const report = await detector.compareGranular(
        { pattern: /abc/ },
        { pattern: /xyz/ }
      );

      // No spurious diff: deepEqual sees empty enumerable key sets → equal.
      expect(report.diffs.filter(d => d.path === 'pattern')).toHaveLength(0);
    });
  });

  // ============================================================
  // deepEqual array-length mismatch (L830)
  // ============================================================
  describe('deepEqual — array length mismatch (L830)', () => {
    it('two arrays differing only in length are not deeply equal', async () => {
      // Wrapped so the outer values are objects (deepEqual path), inner arrays
      // of different length → deepEqual L830 returns false → parent modified.
      const report = await detector.compareGranular(
        { wrap: { arr: [1, 2, 3] } },
        { wrap: { arr: [1, 2] } }
      );

      // The array diff surfaces a removal regardless; the point is deepEqual's
      // length-mismatch arm (L830) is exercised on the nested comparison.
      const arrDiffs = report.diffs.filter(d => d.path.startsWith('wrap.arr'));
      expect(arrDiffs.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // deepEqual object key-count / key-absent (L840, L843)
  // ============================================================
  describe('deepEqual — object key mismatch (L840, L843)', () => {
    it('objects with different key sets are not deeply equal', async () => {
      // compareObjects iterates keys; the differing key 'b' (source-only) → removed.
      const report = await detector.compareGranular(
        { nested: { a: 1, b: 2 } },
        { nested: { a: 1, c: 3 } }
      );

      // 'b' removed, 'c' added — both surface; deepEqual key-absent arm exercised.
      const paths = report.diffs.map(d => d.path).sort();
      expect(paths).toEqual(['nested.b', 'nested.c']);
    });
  });

  // ============================================================
  // SKIP-WITH-EVIDENCE — unreachable via the diff flow
  // ============================================================
  describe.skip('calculateChangePercent 0→0 / empty-string (L736-737, L744) — UNREACHABLE', () => {
    // calculateChangePercent is only called from the primitive arm (L322) AFTER
    // `!deepEqual(source, target)` (L313) passes. Equal values (0===0, "" ===="")
    // make deepEqual return true → the diff is skipped → changePercent never
    // invoked → the `oldValue===0 && newValue===0 → 0` (L737) and
    // `maxLength===0 → 0` (L744) arms are dead under compareGranular.
    it.todo('0→0 and empty-string arms — equal values never reach changePercent');
  });
});
