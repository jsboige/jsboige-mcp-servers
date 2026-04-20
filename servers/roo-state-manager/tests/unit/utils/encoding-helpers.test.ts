import { describe, it, expect } from 'vitest';
import { stripBOM, parseJSONWithoutBOM } from '../../../src/utils/encoding-helpers';

describe('encoding-helpers', () => {
	describe('stripBOM', () => {
		it('should return content unchanged when no BOM present', () => {
			expect(stripBOM('hello world')).toBe('hello world');
		});

		it('should strip UTF-8 BOM from content', () => {
			expect(stripBOM('\uFEFFhello')).toBe('hello');
		});

		it('should handle BOM-only content', () => {
			expect(stripBOM('\uFEFF')).toBe('');
		});

		it('should handle empty string', () => {
			expect(stripBOM('')).toBe('');
		});

		it('should not strip BOM that is not at the beginning', () => {
			const content = 'hello\uFEFFworld';
			expect(stripBOM(content)).toBe(content);
		});

		it('should strip only one BOM character', () => {
			expect(stripBOM('\uFEFF\uFEFFhello')).toBe('\uFEFFhello');
		});

		it('should handle BOM with JSON content', () => {
			const bomJson = '\uFEFF{"key": "value", "num": 42}';
			expect(stripBOM(bomJson)).toBe('{"key": "value", "num": 42}');
		});

		it('should handle BOM with multiline content', () => {
			const content = '\uFEFFline1\nline2\nline3';
			expect(stripBOM(content)).toBe('line1\nline2\nline3');
		});
	});

	describe('parseJSONWithoutBOM', () => {
		it('should parse valid JSON without BOM', () => {
			expect(parseJSONWithoutBOM('{"name":"test"}')).toEqual({ name: 'test' });
		});

		it('should parse JSON with BOM', () => {
			expect(parseJSONWithoutBOM('\uFEFF{"name":"test"}')).toEqual({ name: 'test' });
		});

		it('should throw SyntaxError for invalid JSON', () => {
			expect(() => parseJSONWithoutBOM('not json')).toThrow(SyntaxError);
		});

		it('should parse arrays', () => {
			expect(parseJSONWithoutBOM('[1,2,3]')).toEqual([1, 2, 3]);
		});

		it('should parse JSON with BOM and nested objects', () => {
			const json = '\uFEFF{"a":{"b":[1,2]},"c":null}';
			expect(parseJSONWithoutBOM(json)).toEqual({ a: { b: [1, 2] }, c: null });
		});

		it('should respect generic type parameter', () => {
			interface TestType { id: number; label: string }
			const result = parseJSONWithoutBOM<TestType>('{"id":1,"label":"x"}');
			expect(result.id).toBe(1);
			expect(result.label).toBe('x');
		});

		it('should parse empty object', () => {
			expect(parseJSONWithoutBOM('{}')).toEqual({});
		});

		it('should parse boolean and number values', () => {
			expect(parseJSONWithoutBOM('{"flag":true,"count":0}')).toEqual({ flag: true, count: 0 });
		});
	});
});
