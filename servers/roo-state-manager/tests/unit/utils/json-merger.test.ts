/**
 * Unit tests for JsonMerger
 *
 * Improves coverage for src/utils/JsonMerger.ts by testing:
 * - Edge cases with non-plain objects (Date, Map, etc.)
 * - deepClone behavior with primitives and null
 * - isPlainObject edge cases (objects with custom constructors)
 * - Deeply nested merge scenarios
 * - Array strategy: union with duplicate complex objects
 * - Mixed-type merging at nested levels
 */
import { describe, it, expect } from 'vitest';
import { JsonMerger } from '../../../src/utils/JsonMerger.js';

describe('JsonMerger - Edge Cases Coverage', () => {
  // === isPlainObject edge cases ===
  // JsonMerger.isPlainObject returns false for non-plain objects (Date, Map, etc.)
  // which causes the merge to fall through to "source wins" for type mismatches

  describe('non-plain objects (Date, Map, custom class)', () => {
    it('should overwrite when source is a Date and target is a plain object', () => {
      const source = { date: new Date('2026-01-01') };
      const target = { date: { year: 2025 } };
      const result = JsonMerger.merge(source, target);

      // Date is not a plain object, so source wins at the 'date' key
      expect(result.date).toBeInstanceOf(Date);
    });

    it('should overwrite when target is a Date and source is a plain object', () => {
      const source = { date: { year: 2026 } };
      const target = { date: new Date('2025-01-01') };
      const result = JsonMerger.merge(source, target);

      // target.date is a Date (not plain object), types differ, source wins
      expect(result.date).toEqual({ year: 2026 });
    });

    it('should treat objects with undefined constructor as plain objects', () => {
      // Objects created with Object.create(null) have undefined constructor
      const source = Object.create(null);
      source.a = 1;
      const target = Object.create(null);
      target.b = 2;

      const result = JsonMerger.merge(source, target);
      expect(result.a).toBe(1);
      expect(result.b).toBe(2);
    });

    it('should not deep-merge objects with custom class constructors', () => {
      class CustomObj {
        value = 42;
      }
      const source = { obj: new CustomObj() };
      const target = { obj: { value: 10 } };

      const result = JsonMerger.merge(source, target);
      // CustomObj has constructor !== Object and !== undefined
      // So source.obj is not a plain object -> type mismatch -> source wins
      expect(result.obj).toBeInstanceOf(CustomObj);
      expect(result.obj.value).toBe(42);
    });
  });

  // === deepClone edge cases ===

  describe('deepClone behavior', () => {
    it('should return primitives as-is (string)', () => {
      const result = JsonMerger.merge('hello', 'world');
      expect(result).toBe('hello'); // source wins for primitives
    });

    it('should return number primitives correctly', () => {
      const result = JsonMerger.merge(42, 100);
      expect(result).toBe(42);
    });

    it('should return boolean primitives correctly', () => {
      const result = JsonMerger.merge(true, false);
      expect(result).toBe(true);
    });

    it('should handle null source with nested object target', () => {
      const target = { deep: { nested: { value: 'kept' } } };
      const result = JsonMerger.merge(null, target);
      expect(result).toEqual({ deep: { nested: { value: 'kept' } } });
    });

    it('should handle null target with nested object source', () => {
      const source = { deep: { nested: { value: 'added' } } };
      const result = JsonMerger.merge(source, null);
      expect(result).toEqual({ deep: { nested: { value: 'added' } } });
    });
  });

  // === Deep nested merge with mixed types ===

  describe('deep nested merge scenarios', () => {
    it('should merge 3-level nested objects', () => {
      const source = {
        level1: {
          level2: {
            level3: { newKey: 'value' },
            existing: 'updated',
          },
        },
      };
      const target = {
        level1: {
          level2: {
            level3: { oldKey: 'old' },
            existing: 'original',
          },
        },
      };

      const result = JsonMerger.merge(source, target);
      expect(result.level1.level2.level3).toEqual({ oldKey: 'old', newKey: 'value' });
      expect(result.level1.level2.existing).toBe('updated');
    });

    it('should handle array-to-object type change at nested level', () => {
      const source = { data: { key: 'val' } };
      const target = { data: [1, 2, 3] };

      const result = JsonMerger.merge(source, target);
      // Array vs Object: types differ, source wins
      expect(result.data).toEqual({ key: 'val' });
    });

    it('should handle object-to-array type change at nested level', () => {
      const source = { data: [1, 2, 3] };
      const target = { data: { key: 'val' } };

      const result = JsonMerger.merge(source, target);
      expect(result.data).toEqual([1, 2, 3]);
    });

    it('should preserve keys only in target when source does not have them', () => {
      const source = { a: 1 };
      const target = { a: 0, b: 2, c: 3 };

      const result = JsonMerger.merge(source, target);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  // === Array strategies edge cases ===

  describe('array strategies additional coverage', () => {
    it('should handle concat with empty target array', () => {
      const source = { arr: [1, 2, 3] };
      const target = { arr: [] as number[] };
      const options = { arrayStrategy: 'concat' as const };

      const result = JsonMerger.merge(source, target, options);
      expect(result.arr).toEqual([1, 2, 3]);
    });

    it('should handle concat with empty source array', () => {
      const source = { arr: [] as number[] };
      const target = { arr: [1, 2, 3] };
      const options = { arrayStrategy: 'concat' as const };

      const result = JsonMerger.merge(source, target, options);
      expect(result.arr).toEqual([1, 2, 3]);
    });

    it('should handle union with all identical items (no duplicates added)', () => {
      const source = { arr: [1, 2, 3] };
      const target = { arr: [1, 2, 3] };
      const options = { arrayStrategy: 'union' as const };

      const result = JsonMerger.merge(source, target, options);
      expect(result.arr).toEqual([1, 2, 3]);
      expect(result.arr).toHaveLength(3);
    });

    it('should handle union with partially overlapping objects', () => {
      const source = { arr: [{ id: 1 }, { id: 3 }] };
      const target = { arr: [{ id: 1 }, { id: 2 }] };
      const options = { arrayStrategy: 'union' as const };

      const result = JsonMerger.merge(source, target, options);
      expect(result.arr).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(result.arr).toHaveLength(3);
    });

    it('should not mutate source or target arrays with concat strategy', () => {
      const source = { arr: [3, 4] };
      const target = { arr: [1, 2] };
      const sourceCopy = JSON.parse(JSON.stringify(source));
      const targetCopy = JSON.parse(JSON.stringify(target));
      const options = { arrayStrategy: 'concat' as const };

      JsonMerger.merge(source, target, options);

      expect(source).toEqual(sourceCopy);
      expect(target).toEqual(targetCopy);
    });
  });

  // === Merging with both null ===

  describe('both null/undefined', () => {
    it('should return null when both source and target are null', () => {
      const result = JsonMerger.merge(null, null);
      expect(result).toBeNull();
    });

    it('should return undefined when both source and target are undefined', () => {
      const result = JsonMerger.merge(undefined, undefined);
      expect(result).toBeUndefined();
    });
  });

  // === Complex real-world scenario ===

  describe('complex merge scenario', () => {
    it('should correctly merge a config-like object with all strategies', () => {
      const defaultConfig = {
        server: {
          host: 'localhost',
          port: 3000,
          options: { timeout: 5000, retries: 3 },
        },
        features: ['auth', 'logging'],
        metadata: {
          version: '1.0.0',
          tags: ['stable'],
        },
      };

      const userConfig = {
        server: {
          port: 8080,
          options: { timeout: 10000 },
        },
        features: ['monitoring'],
        metadata: {
          version: '2.0.0',
          tags: ['beta', 'experimental'],
        },
      };

      // Replace strategy (default)
      const replaceResult = JsonMerger.merge(userConfig, defaultConfig);
      expect(replaceResult.server.host).toBe('localhost');
      expect(replaceResult.server.port).toBe(8080);
      expect(replaceResult.server.options.timeout).toBe(10000);
      expect(replaceResult.server.options.retries).toBe(3);
      expect(replaceResult.features).toEqual(['monitoring']); // replaced
      expect(replaceResult.metadata.tags).toEqual(['beta', 'experimental']); // replaced

      // Concat strategy
      const concatResult = JsonMerger.merge(userConfig, defaultConfig, { arrayStrategy: 'concat' });
      expect(concatResult.features).toEqual(['auth', 'logging', 'monitoring']);
      expect(concatResult.metadata.tags).toEqual(['stable', 'beta', 'experimental']);

      // Union strategy
      const unionResult = JsonMerger.merge(userConfig, defaultConfig, { arrayStrategy: 'union' });
      // tags: ['stable'] U ['beta', 'experimental'] = ['stable', 'beta', 'experimental']
      expect(unionResult.metadata.tags).toEqual(['stable', 'beta', 'experimental']);
    });
  });
});
