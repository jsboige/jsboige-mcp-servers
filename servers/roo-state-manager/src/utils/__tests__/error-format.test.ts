/**
 * Tests for error-format utility
 * @module utils/__tests__/error-format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatErrorForResponse, formatErrorForLog } from '../error-format.js';

describe('error-format', () => {
	const originalEnv = process.env.MCP_INCLUDE_STACKS;

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.MCP_INCLUDE_STACKS = originalEnv;
		} else {
			delete process.env.MCP_INCLUDE_STACKS;
		}
	});

	describe('formatErrorForResponse', () => {
		it('returns message only by default (no stack trace)', () => {
			delete process.env.MCP_INCLUDE_STACKS;
			const error = new Error('test error');
			error.stack = 'Error: test error\n    at test.js:1:1\n    at main.js:5:3';

			const result = formatErrorForResponse(error);
			expect(result).toBe('test error');
			expect(result).not.toContain('Stack:');
			expect(result).not.toContain('at test.js');
		});

		it('includes stack trace when MCP_INCLUDE_STACKS=1', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const error = new Error('debug error');
			error.stack = 'Error: debug error\n    at debug.js:10:5';

			const result = formatErrorForResponse(error);
			expect(result).toContain('debug error');
			expect(result).toContain('Stack:');
			expect(result).toContain('at debug.js:10:5');
		});

		it('handles non-Error values', () => {
			delete process.env.MCP_INCLUDE_STACKS;
			expect(formatErrorForResponse('string error')).toBe('string error');
			expect(formatErrorForResponse(42)).toBe('42');
			expect(formatErrorForResponse(null)).toBe('null');
			expect(formatErrorForResponse(undefined)).toBe('undefined');
		});

		it('returns message only when MCP_INCLUDE_STACKS is set but not "1"', () => {
			process.env.MCP_INCLUDE_STACKS = '0';
			const error = new Error('test');
			error.stack = 'Error: test\n    at test.js:1:1';

			const result = formatErrorForResponse(error);
			expect(result).toBe('test');
			expect(result).not.toContain('Stack:');
		});

		it('returns message only when error has no stack', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const error = new Error('no stack');
			error.stack = undefined as any;

			const result = formatErrorForResponse(error);
			expect(result).toBe('no stack');
			expect(result).not.toContain('Stack:');
		});
	});

	describe('formatErrorForLog', () => {
		it('always includes stack (truncated to 3 lines, joined with |)', () => {
			const error = new Error('log error');
			error.stack = 'Error: log error\n    at a.js:1:1\n    at b.js:2:2\n    at c.js:3:3\n    at d.js:4:4';

			const result = formatErrorForLog(error);
			expect(result.message).toBe('log error');
			// slice(0, 3) takes: "Error: log error", "    at a.js:1:1", "    at b.js:2:2"
			// joined with " | "
			expect(result.stack).toContain('at a.js:1:1');
			expect(result.stack).toContain('at b.js:2:2');
			// c.js is at index 3, excluded by slice(0, 3)
			expect(result.stack).not.toContain('at c.js:3:3');
			expect(result.stack).not.toContain('at d.js:4:4');
		});

		it('handles non-Error values', () => {
			expect(formatErrorForLog('string').message).toBe('string');
			expect(formatErrorForLog('string').stack).toBeUndefined();
			expect(formatErrorForLog(null).message).toBe('null');
			expect(formatErrorForLog(undefined).stack).toBeUndefined();
		});

		it('handles error without stack', () => {
			const error = new Error('no stack');
			error.stack = undefined as any;
			const result = formatErrorForLog(error);
			expect(result.message).toBe('no stack');
			expect(result.stack).toBeUndefined();
		});

		it('handles stack with fewer than 3 lines', () => {
			const error = new Error('short stack');
			error.stack = 'Error: short stack';

			const result = formatErrorForLog(error);
			expect(result.message).toBe('short stack');
			expect(result.stack).toBe('Error: short stack');
		});

		it('handles stack with 2 lines', () => {
			const error = new Error('two lines');
			error.stack = 'Error: two lines\n    at a.js:1:1';

			const result = formatErrorForLog(error);
			expect(result.stack).toContain('at a.js:1:1');
			expect(result.stack).toContain(' | ');
		});

		it('handles stack with empty lines', () => {
			const error = new Error('gappy stack');
			error.stack = 'Error: gappy stack\n\n    at a.js:1:1\n    at b.js:2:2';

			const result = formatErrorForLog(error);
			expect(result.stack).toBeDefined();
			expect(result.stack).not.toContain('at b.js:2:2');
		});

		it('handles stack with CRLF line endings', () => {
			const error = new Error('crlf stack');
			error.stack = 'Error: crlf stack\r\n    at a.js:1:1\r\n    at b.js:2:2\r\n    at c.js:3:3';

			const result = formatErrorForLog(error);
			expect(result.stack).toBeDefined();
			expect(result.stack).toContain('at a.js:1:1');
		});
	});

	describe('Error subclass properties', () => {
		it('handles TypeError with correct message', () => {
			const error = new TypeError('not a function');
			const result = formatErrorForResponse(error);
			expect(result).toBe('not a function');
			expect(formatErrorForLog(error).message).toBe('not a function');
		});

		it('handles RangeError', () => {
			const error = new RangeError('out of range');
			expect(formatErrorForResponse(error)).toBe('out of range');
			expect(formatErrorForLog(error).message).toBe('out of range');
		});

		it('handles AggregateError', () => {
			const inner1 = new Error('inner1');
			const inner2 = new Error('inner2');
			const error = new AggregateError([inner1, inner2], 'aggregate failure');

			expect(formatErrorForResponse(error)).toBe('aggregate failure');
			expect(formatErrorForLog(error).message).toBe('aggregate failure');
		});

		it('handles custom Error subclass with extra properties', () => {
			class CustomError extends Error {
				constructor(
					message: string,
					public code: string,
				) {
					super(message);
					this.name = 'CustomError';
				}
			}
			const error = new CustomError('custom fail', 'E_CUSTOM');
			expect(formatErrorForResponse(error)).toBe('custom fail');
			expect(formatErrorForLog(error).message).toBe('custom fail');
		});

		it('handles thrown plain object with message', () => {
			const thrown = { message: 'plain object error' };
			expect(formatErrorForResponse(thrown)).toBe('[object Object]');
			expect(formatErrorForLog(thrown).message).toBe('[object Object]');
		});
	});

	describe('Symbol and BigInt as error values', () => {
		it('handles Symbol as error argument', () => {
			expect(formatErrorForResponse(Symbol('test'))).toBe('Symbol(test)');
			expect(formatErrorForLog(Symbol('test')).message).toBe('Symbol(test)');
		});

		it('handles BigInt as error argument', () => {
			expect(formatErrorForResponse(BigInt(9007199254740991))).toBe('9007199254740991');
			expect(formatErrorForLog(BigInt(42)).message).toBe('42');
		});

		it('handles function as error argument', () => {
			function myFunc() {}
			expect(typeof formatErrorForResponse(myFunc)).toBe('string');
			expect(formatErrorForLog(myFunc).message).toContain('myFunc');
		});

		it('handles boolean true/false', () => {
			expect(formatErrorForResponse(true)).toBe('true');
			expect(formatErrorForResponse(false)).toBe('false');
			expect(formatErrorForLog(true).message).toBe('true');
		});
	});

	describe('process.env.MCP_INCLUDE_STACKS mutation mid-call', () => {
		it('reads env at call time, not import time', () => {
			delete process.env.MCP_INCLUDE_STACKS;
			const error = new Error('mutated env');
			error.stack = 'Error: mutated env\n    at a.js:1:1';

			expect(formatErrorForResponse(error)).not.toContain('Stack:');

			process.env.MCP_INCLUDE_STACKS = '1';
			expect(formatErrorForResponse(error)).toContain('Stack:');

			delete process.env.MCP_INCLUDE_STACKS;
			expect(formatErrorForResponse(error)).not.toContain('Stack:');
		});
	});

	describe('formatErrorForResponse stack format', () => {
		it('formats stack with double newline separator', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const error = new Error('format check');
			error.stack = 'Error: format check\n    at a.js:1:1';

			const result = formatErrorForResponse(error);
			expect(result).toBe('format check\n\nStack:\nError: format check\n    at a.js:1:1');
		});

		it('preserves original stack content unchanged', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const error = new Error('preserve');
			const originalStack = 'Error: preserve\n    at a.js:1:1\n    at b.js:2:2';
			error.stack = originalStack;

			const result = formatErrorForResponse(error);
			expect(result).toContain(originalStack);
		});
	});
});
