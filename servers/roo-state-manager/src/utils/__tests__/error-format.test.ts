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
	});
});
