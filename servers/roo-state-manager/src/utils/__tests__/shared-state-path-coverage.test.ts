/**
 * Coverage extension for shared-state-path.ts
 * Targets: tryGetSharedStatePath, isSharedPathAccessible, .env edge cases
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

describe('shared-state-path coverage extension', () => {
	const originalEnv = process.env.ROOSYNC_SHARED_PATH;

	beforeEach(() => {
		delete process.env.ROOSYNC_SHARED_PATH;
		vi.resetModules();
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ROOSYNC_SHARED_PATH = originalEnv;
		} else {
			delete process.env.ROOSYNC_SHARED_PATH;
		}
		vi.restoreAllMocks();
	});

	describe('tryGetSharedStatePath', () => {
		test('returns path when env var is set', async () => {
			process.env.ROOSYNC_SHARED_PATH = '/try/path';
			const { tryGetSharedStatePath } = await import('../shared-state-path.js');
			expect(tryGetSharedStatePath()).toBe('/try/path');
		});

		test('returns null when no path available', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return { ...actual, existsSync: () => false };
			});
			const { tryGetSharedStatePath } = await import('../shared-state-path.js');
			expect(tryGetSharedStatePath()).toBeNull();
		});
	});

	describe('isSharedPathAccessible', () => {
		test('returns true when path exists on disk', async () => {
			process.env.ROOSYNC_SHARED_PATH = '/accessible/path';
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return { ...actual, existsSync: (p: string) => p === '/accessible/path' };
			});
			const { isSharedPathAccessible } = await import('../shared-state-path.js');
			expect(isSharedPathAccessible()).toBe(true);
		});

		test('returns false when path is not on disk', async () => {
			process.env.ROOSYNC_SHARED_PATH = '/missing/path';
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return { ...actual, existsSync: () => false };
			});
			const { isSharedPathAccessible } = await import('../shared-state-path.js');
			expect(isSharedPathAccessible()).toBe(false);
		});

		test('returns false when no path configured', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return { ...actual, existsSync: () => false };
			});
			const { isSharedPathAccessible } = await import('../shared-state-path.js');
			expect(isSharedPathAccessible()).toBe(false);
		});
	});

	describe('.env edge cases', () => {
		test('handles quoted values in .env file', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => 'ROOSYNC_SHARED_PATH="/quoted/path"\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/quoted/path');
		});

		test('handles single-quoted values in .env file', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => "ROOSYNC_SHARED_PATH='/single/quoted'\n",
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/single/quoted');
		});

		test('skips comment lines in .env file', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => '# This is a comment\nROOSYNC_SHARED_PATH=/after/comment\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/after/comment');
		});

		test('skips empty lines in .env file', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => '\n\nROOSYNC_SHARED_PATH=/after/blanks\n\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/after/blanks');
		});

		test('returns null when .env key has empty value', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => 'ROOSYNC_SHARED_PATH=\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH');
		});

		test('skips lines without equals sign', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => 'NOEQUALSSIGN\nROOSYNC_SHARED_PATH=/valid\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/valid');
		});

		test('skips non-matching keys', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => 'OTHER_KEY=/other\nROOSYNC_SHARED_PATH=/correct\n',
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(getSharedStatePath()).toBe('/correct');
		});

		test('handles readFileSync throwing gracefully', async () => {
			vi.doMock('fs', async () => {
				const actual = await vi.importActual('fs');
				return {
					...actual,
					existsSync: () => true,
					readFileSync: () => { throw new Error('permission denied'); },
				};
			});
			const { getSharedStatePath } = await import('../shared-state-path.js');
			expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH');
		});
	});
});
