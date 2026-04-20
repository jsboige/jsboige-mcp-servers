import { describe, it, expect } from 'vitest';
import { normalizePath } from '../../../src/utils/path-normalizer';

describe('path-normalizer', () => {
	describe('normalizePath', () => {
		it('should normalize Windows backslashes to forward slashes', () => {
			expect(normalizePath('C:\\Users\\test\\file.txt')).toBe('c:/users/test/file.txt');
		});

		it('should remove trailing slashes', () => {
			expect(normalizePath('/path/to/dir/')).toBe('/path/to/dir');
		});

		it('should remove multiple trailing slashes', () => {
			expect(normalizePath('/path/to/dir///')).toBe('/path/to/dir');
		});

		it('should convert to lowercase', () => {
			expect(normalizePath('/PATH/TO/FILE')).toBe('/path/to/file');
		});

		it('should handle empty string', () => {
			expect(normalizePath('')).toBe('');
		});

		it('should handle already normalized path', () => {
			expect(normalizePath('/already/normalized')).toBe('/already/normalized');
		});

		it('should handle mixed slashes', () => {
			expect(normalizePath('C:/Users\\test/path\\file')).toBe('c:/users/test/path/file');
		});

		it('should handle root path', () => {
			expect(normalizePath('/')).toBe('');
		});

		it('should handle single segment', () => {
			expect(normalizePath('folder')).toBe('folder');
		});

		it('should handle UNC path', () => {
			expect(normalizePath('\\\\server\\share\\path')).toBe('//server/share/path');
		});
	});
});
