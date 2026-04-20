import { describe, it, expect } from 'vitest';
import { JsonMerger } from '../../../src/utils/JsonMerger.js';

describe('JsonMerger', () => {
	describe('merge — null/undefined handling', () => {
		it('should return source when target is null', () => {
			expect(JsonMerger.merge({ a: 1 }, null)).toEqual({ a: 1 });
		});

		it('should return source when target is undefined', () => {
			expect(JsonMerger.merge({ a: 1 }, undefined)).toEqual({ a: 1 });
		});

		it('should return target when source is null', () => {
			expect(JsonMerger.merge(null, { a: 1 })).toEqual({ a: 1 });
		});

		it('should return target when source is undefined', () => {
			expect(JsonMerger.merge(undefined, { a: 1 })).toEqual({ a: 1 });
		});

		it('should handle both null', () => {
			expect(JsonMerger.merge(null, null)).toBeNull();
		});
	});

	describe('merge — type mismatch', () => {
		it('should use source when types differ (string vs number)', () => {
			expect(JsonMerger.merge('hello', 42)).toBe('hello');
		});

		it('should use source when types differ (object vs array)', () => {
			expect(JsonMerger.merge({ a: 1 }, [1, 2])).toEqual({ a: 1 });
		});

		it('should use source when types differ (boolean vs string)', () => {
			expect(JsonMerger.merge(true, 'false')).toBe(true);
		});
	});

	describe('merge — primitives', () => {
		it('should replace string value', () => {
			expect(JsonMerger.merge('new', 'old')).toBe('new');
		});

		it('should replace number value', () => {
			expect(JsonMerger.merge(10, 5)).toBe(10);
		});

		it('should replace boolean value', () => {
			expect(JsonMerger.merge(false, true)).toBe(false);
		});
	});

	describe('merge — simple objects', () => {
		it('should merge source into target', () => {
			const source = { b: 2 };
			const target = { a: 1 };
			expect(JsonMerger.merge(source, target)).toEqual({ a: 1, b: 2 });
		});

		it('should override existing keys with source values', () => {
			const source = { a: 10 };
			const target = { a: 1 };
			expect(JsonMerger.merge(source, target)).toEqual({ a: 10 });
		});

		it('should add new keys and override existing', () => {
			const source = { a: 10, c: 3 };
			const target = { a: 1, b: 2 };
			expect(JsonMerger.merge(source, target)).toEqual({ a: 10, b: 2, c: 3 });
		});

		it('should merge empty source into target', () => {
			expect(JsonMerger.merge({}, { a: 1 })).toEqual({ a: 1 });
		});

		it('should merge source into empty target', () => {
			expect(JsonMerger.merge({ a: 1 }, {})).toEqual({ a: 1 });
		});
	});

	describe('merge — deep nested objects', () => {
		it('should merge nested objects recursively', () => {
			const source = { nested: { b: 2, c: 3 } };
			const target = { nested: { a: 1, b: 0 } };
			expect(JsonMerger.merge(source, target)).toEqual({
				nested: { a: 1, b: 2, c: 3 },
			});
		});

		it('should handle 3-level deep nesting', () => {
			const source = { l1: { l2: { l3: 'new' } } };
			const target = { l1: { l2: { l3: 'old', extra: 1 } } };
			expect(JsonMerger.merge(source, target)).toEqual({
				l1: { l2: { l3: 'new', extra: 1 } },
			});
		});

		it('should replace nested primitive with object', () => {
			const source = { key: { nested: true } };
			const target = { key: 'string' };
			expect(JsonMerger.merge(source, target)).toEqual({ key: { nested: true } });
		});
	});

	describe('merge — arrays (replace strategy, default)', () => {
		it('should replace target array with source array', () => {
			const source = { items: [3, 4] };
			const target = { items: [1, 2] };
			expect(JsonMerger.merge(source, target)).toEqual({ items: [3, 4] });
		});

		it('should replace with empty array', () => {
			const source = { items: [] };
			const target = { items: [1, 2, 3] };
			expect(JsonMerger.merge(source, target)).toEqual({ items: [] });
		});
	});

	describe('merge — arrays (concat strategy)', () => {
		it('should concatenate arrays', () => {
			const source = { items: [3, 4] };
			const target = { items: [1, 2] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'concat' });
			expect(result).toEqual({ items: [1, 2, 3, 4] });
		});

		it('should concat with empty source array', () => {
			const source = { items: [] };
			const target = { items: [1, 2] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'concat' });
			expect(result).toEqual({ items: [1, 2] });
		});
	});

	describe('merge — arrays (union strategy)', () => {
		it('should deduplicate identical items', () => {
			const source = { items: [2, 3] };
			const target = { items: [1, 2] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'union' });
			expect(result).toEqual({ items: [1, 2, 3] });
		});

		it('should deduplicate complex objects by JSON equality', () => {
			const source = { items: [{ a: 1 }, { b: 2 }] };
			const target = { items: [{ a: 1 }, { c: 3 }] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'union' });
			expect(result).toEqual({ items: [{ a: 1 }, { c: 3 }, { b: 2 }] });
		});

		it('should return all items when no duplicates', () => {
			const source = { items: [3, 4] };
			const target = { items: [1, 2] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'union' });
			expect(result).toEqual({ items: [1, 2, 3, 4] });
		});
	});

	describe('merge — immutability', () => {
		it('should not mutate source', () => {
			const source = { a: { b: 1 } };
			const target = { a: { c: 2 } };
			const result = JsonMerger.merge(source, target);
			result.a.b = 999;
			expect(source.a.b).toBe(1);
		});

		it('should not mutate target', () => {
			const source = { a: 2 };
			const target = { a: 1, b: 3 };
			const result = JsonMerger.merge(source, target);
			result.b = 999;
			expect(target.b).toBe(3);
		});

		it('should not mutate source arrays', () => {
			const source = { items: [1, 2] };
			const target = { items: [3, 4] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'concat' });
			result.items.push(5);
			expect(source.items).toEqual([1, 2]);
		});
	});

	describe('merge — edge cases', () => {
		it('should handle Date objects as non-plain (source wins)', () => {
			const date = new Date('2026-01-01');
			const source = { d: date };
			const target = { d: { year: 2025 } };
			const result = JsonMerger.merge(source, target);
			expect(result.d).toBe(date);
		});

		it('should handle mixed keys with symbols ignored', () => {
			const source = { a: 1 };
			const target = { b: 2 };
			const result = JsonMerger.merge(source, target);
			expect(result).toEqual({ a: 1, b: 2 });
		});

		it('should handle empty arrays with concat', () => {
			expect(JsonMerger.merge([], [], { arrayStrategy: 'concat' })).toEqual([]);
		});

		it('should handle union with all duplicates', () => {
			const source = { items: [1, 2] };
			const target = { items: [1, 2] };
			const result = JsonMerger.merge(source, target, { arrayStrategy: 'union' });
			expect(result).toEqual({ items: [1, 2] });
		});
	});
});
