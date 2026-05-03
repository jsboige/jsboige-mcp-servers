/**
 * Disk persistence coverage for cache-manager.ts
 * Targets: persistEntry, removeFromDisk, saveToDisk (private methods)
 * Lines 551-571 in cache-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheManager } from '../cache-manager.js';
import { promises as fs } from 'fs';

vi.mock('../../services/ConfigDiffService.js', () => ({
	ConfigDiffService: class MockConfigDiffService {
		compare() { return { summary: { added: 0, modified: 0, deleted: 0 } }; }
	}
}));

describe('CacheManager — Disk Persistence', () => {
	const tmpDir = `/tmp/cache-test-${Date.now()}`;
	let cm: CacheManager;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		if (cm) await cm.close();
		vi.useRealTimers();
		// Cleanup temp dir
		try { await fs.rm(tmpDir, { recursive: true }); } catch {}
	});

	it('persists entries to disk when persistToDisk is true', async () => {
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('test-key', { data: 'hello' });
		await cm.set('another-key', 'world');

		// saveToDisk should have written files
		const files = await fs.readdir(tmpDir);
		expect(files.length).toBeGreaterThanOrEqual(1);
		expect(files.some(f => f.includes('test-key'))).toBe(true);
	});

	it('persists entry as JSON with metadata', async () => {
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('key1', 'value1');

		const files = await fs.readdir(tmpDir);
		expect(files).toContain('key1.json');

		const entry = JSON.parse(await fs.readFile(`${tmpDir}/key1.json`, 'utf-8'));
		expect(entry.data).toBe('value1');
		expect(entry.version).toBe('1.0.0');
		expect(entry).toHaveProperty('timestamp');
	});

	it('removes entry from disk on invalidation', async () => {
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('to-remove', 'data', ['dep1']);

		const filesBefore = await fs.readdir(tmpDir);
		expect(filesBefore.some(f => f.includes('to-remove'))).toBe(true);

		await cm.invalidateByDependency('dep1');

		const filesAfter = await fs.readdir(tmpDir);
		expect(filesAfter.some(f => f.includes('to-remove'))).toBe(false);
	});

	it('handles special characters in keys for disk file names', async () => {
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('key:with:colons/and/slashes', 'data');

		const files = await fs.readdir(tmpDir);
		// Special chars replaced with _
		const entryFile = files.find(f => f.includes('key_with_colons'));
		expect(entryFile).toBeDefined();
	});

	it('does not persist when persistToDisk is false (default)', async () => {
		cm = new CacheManager({
			persistToDisk: false,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('no-persist', 'data');

		// cacheDir may not even exist since nothing was written
		try {
			const files = await fs.readdir(tmpDir);
			expect(files.some(f => f.includes('no-persist'))).toBe(false);
		} catch {
			// Dir doesn't exist = correct behavior
		}
	});

	it('gracefully handles write errors in persistEntry', async () => {
		const readOnlyDir = '/nonexistent/path/that/cannot/be/created';
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: readOnlyDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		// Should not throw even if disk write fails
		await expect(cm.set('fail-key', 'data')).resolves.toBeUndefined();
	});

	it('gracefully handles unlink errors in removeFromDisk', async () => {
		cm = new CacheManager({
			persistToDisk: true,
			cacheDir: tmpDir,
			maxSize: 1024 * 1024,
			maxAge: 60000,
			cleanupInterval: 10000
		});

		await cm.set('will-delete', 'data', ['dep-delete']);

		// Manually remove the file so unlink fails
		const files = await fs.readdir(tmpDir);
		for (const f of files) {
			if (f.includes('will-delete')) {
				await fs.unlink(`${tmpDir}/${f}`);
			}
		}

		// Should not throw even if file already gone
		await expect(cm.invalidateByDependency('dep-delete')).resolves.toBe(1);
	});
});
