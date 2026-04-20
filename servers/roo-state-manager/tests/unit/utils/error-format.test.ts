import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatErrorForResponse, formatErrorForLog } from '../../../src/utils/error-format';

describe('error-format', () => {
	const originalEnv = process.env.MCP_INCLUDE_STACKS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.MCP_INCLUDE_STACKS;
		} else {
			process.env.MCP_INCLUDE_STACKS = originalEnv;
		}
	});

	describe('formatErrorForResponse', () => {
		it('should format Error instance as message only by default', () => {
			const err = new Error('test error');
			const result = formatErrorForResponse(err);
			expect(result).toBe('test error');
			expect(result).not.toContain('Stack:');
		});

		it('should format non-Error value as string', () => {
			expect(formatErrorForResponse('string error')).toBe('string error');
			expect(formatErrorForResponse(42)).toBe('42');
			expect(formatErrorForResponse(null)).toBe('null');
			expect(formatErrorForResponse(undefined)).toBe('undefined');
		});

		it('should include stack trace when MCP_INCLUDE_STACKS=1', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const err = new Error('debug error');
			const result = formatErrorForResponse(err);
			expect(result).toContain('debug error');
			expect(result).toContain('Stack:');
			expect(result).toContain('Error: debug error');
		});

		it('should not include stack for non-Error even with MCP_INCLUDE_STACKS=1', () => {
			process.env.MCP_INCLUDE_STACKS = '1';
			const result = formatErrorForResponse('plain string');
			expect(result).toBe('plain string');
			expect(result).not.toContain('Stack:');
		});

		it('should handle Error without stack', () => {
			const err = new Error('no stack');
			delete err.stack;
			process.env.MCP_INCLUDE_STACKS = '1';
			const result = formatErrorForResponse(err);
			expect(result).toBe('no stack');
		});

		it('should not include stack when MCP_INCLUDE_STACKS is not "1"', () => {
			process.env.MCP_INCLUDE_STACKS = '0';
			const err = new Error('test');
			const result = formatErrorForResponse(err);
			expect(result).toBe('test');
			expect(result).not.toContain('Stack:');
		});
	});

	describe('formatErrorForLog', () => {
		it('should always include message and stack for Error', () => {
			const err = new Error('log error');
			const result = formatErrorForLog(err);
			expect(result.message).toBe('log error');
			expect(result.stack).toBeDefined();
			expect(result.stack).toContain('Error: log error');
		});

		it('should truncate stack to 3 lines', () => {
			const err = new Error('long stack');
			const result = formatErrorForLog(err);
			const stackLines = result.stack!.split(' | ');
			expect(stackLines.length).toBeLessThanOrEqual(3);
		});

		it('should handle non-Error values', () => {
			expect(formatErrorForLog('string').message).toBe('string');
			expect(formatErrorForLog('string').stack).toBeUndefined();
			expect(formatErrorForLog(42).message).toBe('42');
			expect(formatErrorForLog(null).message).toBe('null');
		});

		it('should handle Error without stack', () => {
			const err = new Error('no stack');
			delete err.stack;
			const result = formatErrorForLog(err);
			expect(result.message).toBe('no stack');
			expect(result.stack).toBeUndefined();
		});
	});
});
