/**
 * Tests for shared-state-path.ts
 * Coverage improvement - #1110 ESM cycle fix helper
 *
 * @module utils/__tests__/shared-state-path
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

describe('getSharedStatePath', () => {
	const originalEnv = process.env.ROOSYNC_SHARED_PATH;

	beforeEach(() => {
		delete process.env.ROOSYNC_SHARED_PATH;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ROOSYNC_SHARED_PATH = originalEnv;
		} else {
			delete process.env.ROOSYNC_SHARED_PATH;
		}
	});

	test('returns ROOSYNC_SHARED_PATH when set', async () => {
		process.env.ROOSYNC_SHARED_PATH = '/some/shared/path';
		const { getSharedStatePath } = await import('../shared-state-path.js');
		expect(getSharedStatePath()).toBe('/some/shared/path');
	});

	test('throws descriptive error when ROOSYNC_SHARED_PATH is not set', async () => {
		const { getSharedStatePath } = await import('../shared-state-path.js');
		expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
	});

	test('throws error mentioning Google Drive for user guidance', async () => {
		const { getSharedStatePath } = await import('../shared-state-path.js');
		expect(() => getSharedStatePath()).toThrow(/Google Drive/);
	});

	test('returns different paths when env changes between imports', async () => {
		process.env.ROOSYNC_SHARED_PATH = '/path/one';
		const { getSharedStatePath } = await import('../shared-state-path.js');
		expect(getSharedStatePath()).toBe('/path/one');

		process.env.ROOSYNC_SHARED_PATH = '/path/two';
		expect(getSharedStatePath()).toBe('/path/two');
	});
});
