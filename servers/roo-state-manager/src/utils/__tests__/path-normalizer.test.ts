/**
 * Tests pour path-normalizer.ts
 * Issue #492 - Couverture des utilitaires non testés
 *
 * @module utils/__tests__/path-normalizer
 */

import { describe, test, expect } from 'vitest';
import { normalizePath } from '../path-normalizer.js';

describe('normalizePath', () => {
	// ============================================================
	// Basic normalization
	// ============================================================

	describe('basic normalization', () => {
		test('returns empty string for empty input', () => {
			expect(normalizePath('')).toBe('');
		});

		test('returns empty string for falsy input', () => {
			expect(normalizePath(undefined as any)).toBe('');
			expect(normalizePath(null as any)).toBe('');
		});

		test('normalizes simple unix path', () => {
			expect(normalizePath('/home/user/project')).toBe('/home/user/project');
		});

		test('normalizes simple windows path', () => {
			expect(normalizePath('C:\\Users\\MYIA\\project')).toBe('c:/users/myia/project');
		});
	});

	// ============================================================
	// Backslash conversion
	// ============================================================

	describe('backslash conversion', () => {
		test('converts all backslashes to forward slashes', () => {
			expect(normalizePath('a\\b\\c\\d')).toBe('a/b/c/d');
		});

		test('handles mixed slashes', () => {
			expect(normalizePath('a/b\\c/d\\e')).toBe('a/b/c/d/e');
		});

		test('handles consecutive backslashes', () => {
			expect(normalizePath('a\\\\b')).toBe('a//b');
		});
	});

	// ============================================================
	// Trailing slash removal
	// ============================================================

	describe('trailing slash removal', () => {
		test('removes trailing forward slash', () => {
			expect(normalizePath('/path/to/dir/')).toBe('/path/to/dir');
		});

		test('removes trailing backslash (after conversion)', () => {
			expect(normalizePath('C:\\path\\to\\dir\\')).toBe('c:/path/to/dir');
		});

		test('does not remove single slash', () => {
			expect(normalizePath('/')).toBe('');
		});

		test('keeps path without trailing slash unchanged', () => {
			expect(normalizePath('/path/to/file.txt')).toBe('/path/to/file.txt');
		});
	});

	// ============================================================
	// Case normalization
	// ============================================================

	describe('case normalization', () => {
		test('converts to lowercase', () => {
			expect(normalizePath('/Path/TO/File')).toBe('/path/to/file');
		});

		test('lowercases Windows drive letter', () => {
			expect(normalizePath('D:\\Roo-Extensions')).toBe('d:/roo-extensions');
		});

		test('lowercases file extensions', () => {
			expect(normalizePath('/path/FILE.TXT')).toBe('/path/file.txt');
		});
	});

	// ============================================================
	// Cross-platform comparison
	// ============================================================

	describe('cross-platform comparison', () => {
		test('same path on different platforms normalizes equally', () => {
			const unix = normalizePath('/home/user/project');
			const windows = normalizePath('\\home\\user\\project');
			expect(unix).toBe(windows);
		});

		test('Windows path with drive normalizes consistently', () => {
			const a = normalizePath('C:\\Users\\MYIA\\roo-extensions');
			const b = normalizePath('c:/users/myia/roo-extensions');
			expect(a).toBe(b);
		});
	});
});
