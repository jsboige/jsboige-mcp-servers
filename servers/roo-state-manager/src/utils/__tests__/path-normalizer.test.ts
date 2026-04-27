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

		// ============================================================
		// UNC paths
		// ============================================================

		describe('UNC paths', () => {
			test('normalizes UNC path with backslashes', () => {
				expect(normalizePath('\\\\server\\share\\path')).toBe('//server/share/path');
			});

			test('normalizes UNC path with forward slashes', () => {
				expect(normalizePath('//server/share/path')).toBe('//server/share/path');
			});

			test('normalizes UNC root only', () => {
				expect(normalizePath('\\\\server\\share')).toBe('//server/share');
			});
		});

		// ============================================================
		// Trailing dots and spaces (Windows-specific edge cases)
		// ============================================================

		describe('trailing dots and spaces', () => {
			test('preserves trailing dots in directory name', () => {
				expect(normalizePath('C:\\path\\dir.')).toBe('c:/path/dir.');
			});

			test('preserves trailing spaces in directory name', () => {
				expect(normalizePath('C:\\path\\dir ')).toBe('c:/path/dir ');
			});

			test('handles multiple trailing dots', () => {
				expect(normalizePath('/path/dir...')).toBe('/path/dir...');
			});
		});

		// ============================================================
		// Multi-trailing-slash
		// ============================================================

		describe('multi-trailing-slash removal', () => {
			test('removes multiple trailing slashes', () => {
				expect(normalizePath('/path/to/dir///')).toBe('/path/to/dir');
			});

			test('removes multiple trailing backslashes after conversion', () => {
				expect(normalizePath('C:\\path\\\\\\')).toBe('c:/path');
			});
		});

		// ============================================================
		// Unicode paths
		// ============================================================

		describe('Unicode paths', () => {
			test('handles CJK characters', () => {
				expect(normalizePath('/用户/项目/文件')).toBe('/用户/项目/文件');
			});

			test('handles emoji in paths', () => {
				expect(normalizePath('/home/📦/project')).toBe('/home/📦/project');
			});

			test('handles French accented characters (lowercased)', () => {
				expect(normalizePath('C:\\Utilisateur\\Données')).toBe('c:/utilisateur/données');
			});

			test('handles mixed Unicode and ASCII', () => {
				expect(normalizePath('/home/café/project')).toBe('/home/café/project');
			});
		});

		// ============================================================
		// ~ home prefix
		// ============================================================

		describe('~ home prefix', () => {
			test('preserves tilde in path (no expansion)', () => {
				expect(normalizePath('~/project/src')).toBe('~/project/src');
			});

			test('preserves tilde with backslashes', () => {
				expect(normalizePath('~\\project\\src')).toBe('~/project/src');
			});
		});

		// ============================================================
		// . and .. segments
		// ============================================================

		describe('. and .. segments', () => {
			test('preserves . segments (no resolution)', () => {
				expect(normalizePath('/path/./to/file')).toBe('/path/./to/file');
			});

			test('preserves .. segments (no resolution)', () => {
				expect(normalizePath('/path/../other')).toBe('/path/../other');
			});

			test('preserves mixed . and .. segments', () => {
				expect(normalizePath('/a/./b/../c')).toBe('/a/./b/../c');
			});
		});

		// ============================================================
		// Long Windows paths (>260 chars)
		// ============================================================

		describe('long Windows paths', () => {
			test('handles path longer than 260 characters', () => {
				const longSegment = 'a'.repeat(260);
				const input = `C:\\path\\${longSegment}\\file.txt`;
				const result = normalizePath(input);
				expect(result).toContain(longSegment);
				expect(result.startsWith('c:/path/')).toBe(true);
			});

			test('handles \\\\?\\ prefix', () => {
				expect(normalizePath('\\\\?\\C:\\very\\long\\path')).toBe('//?/c:/very/long/path');
			});
		});

		// ============================================================
		// file:/// URL
		// ============================================================

		describe('file:/// URL', () => {
			test('preserves file:/// URL structure', () => {
				expect(normalizePath('file:///C:/Users/project')).toBe('file:///c:/users/project');
			});

			test('preserves file:// URL', () => {
				expect(normalizePath('file://server/share')).toBe('file://server/share');
			});
		});
	});
});
