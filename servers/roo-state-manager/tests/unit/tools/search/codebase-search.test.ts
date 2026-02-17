import { describe, it, expect } from 'vitest';
import { getWorkspaceCollectionName, getWorkspaceCollectionVariants } from '../../../../src/tools/search/search-codebase.tool.js';

describe('codebase_search - path normalization', () => {
	describe('getWorkspaceCollectionName', () => {
		it('should return ws- prefixed hash', () => {
			const name = getWorkspaceCollectionName('d:\\roo-extensions');
			expect(name).toMatch(/^ws-[0-9a-f]{16}$/);
		});

		it('should produce consistent results for same input', () => {
			const name1 = getWorkspaceCollectionName('d:\\roo-extensions');
			const name2 = getWorkspaceCollectionName('d:\\roo-extensions');
			expect(name1).toBe(name2);
		});

		it('should clean double-escaped backslashes', () => {
			// MCP JSON parsing can produce double backslashes
			const withDouble = getWorkspaceCollectionName('d:\\\\roo-extensions');
			const withSingle = getWorkspaceCollectionName('d:\\roo-extensions');
			expect(withDouble).toBe(withSingle);
		});

		it('should remove trailing separators', () => {
			const withTrailing = getWorkspaceCollectionName('d:\\roo-extensions\\');
			const withoutTrailing = getWorkspaceCollectionName('d:\\roo-extensions');
			expect(withTrailing).toBe(withoutTrailing);
		});

		it('should remove trailing forward slashes', () => {
			const withTrailing = getWorkspaceCollectionName('d:/roo-extensions/');
			const withoutTrailing = getWorkspaceCollectionName('d:/roo-extensions');
			expect(withTrailing).toBe(withoutTrailing);
		});
	});

	describe('getWorkspaceCollectionVariants', () => {
		it('should return multiple variants', () => {
			const variants = getWorkspaceCollectionVariants('d:\\roo-extensions');
			expect(variants.length).toBeGreaterThan(1);
		});

		it('should all be ws- prefixed', () => {
			const variants = getWorkspaceCollectionVariants('d:\\roo-extensions');
			for (const v of variants) {
				expect(v).toMatch(/^ws-[0-9a-f]{16}$/);
			}
		});

		it('should include both case and separator variants', () => {
			const variants = getWorkspaceCollectionVariants('D:\\Roo-Extensions');
			// Should have at least: original, lowercase, forward-slash, lowercase+forward-slash
			expect(variants.length).toBeGreaterThanOrEqual(4);
		});

		it('should have no duplicates', () => {
			const variants = getWorkspaceCollectionVariants('d:\\roo-extensions');
			const unique = new Set(variants);
			expect(unique.size).toBe(variants.length);
		});

		it('should include primary collection name', () => {
			const primary = getWorkspaceCollectionName('d:\\roo-extensions');
			const variants = getWorkspaceCollectionVariants('d:\\roo-extensions');
			expect(variants).toContain(primary);
		});

		it('should handle forward-slash input', () => {
			const variants = getWorkspaceCollectionVariants('d:/roo-extensions');
			expect(variants.length).toBeGreaterThan(1);
			// Should include backslash variant too
			const backslashPrimary = getWorkspaceCollectionName('d:\\roo-extensions');
			expect(variants).toContain(backslashPrimary);
		});
	});
});
