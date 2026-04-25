import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';

vi.mock('../../../src/utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: vi.fn(),
	},
}));

import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
import { ExportConfigManager } from '../../../src/services/ExportConfigManager.js';

describe('ExportConfigManager', () => {
	let manager: ExportConfigManager;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(process.cwd(), 'test-export-config-' + Date.now());
		await fs.mkdir(tmpDir, { recursive: true });

		// Default: detect a storage location
		vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([
			join(tmpDir, 'tasks'),
		]);
		await fs.mkdir(join(tmpDir, 'tasks'), { recursive: true });

		manager = new ExportConfigManager();
		// Wait for async constructor
		await new Promise((r) => setTimeout(r, 50));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	describe('getConfig', () => {
		it('should return default config when no file exists', async () => {
			const config = await manager.getConfig();

			expect(config.defaults.prettyPrint).toBe(true);
			expect(config.defaults.includeContent).toBe(false);
			expect(config.defaults.compression).toBe('none');
			expect(config.templates).toBeDefined();
			expect(config.filters).toBeDefined();
		});

		it('should create config file with defaults when none exists', async () => {
			await manager.getConfig();

			const configPath = join(tmpDir, 'xml_export_config.json');
			const exists = await fs.access(configPath).then(() => true).catch(() => false);
			expect(exists).toBe(true);
		});

		it('should load existing config from file', async () => {
			const customConfig = {
				defaults: { prettyPrint: false, includeContent: true, compression: 'zip' as const },
				templates: {},
				filters: {},
			};
			const configPath = join(tmpDir, 'xml_export_config.json');
			await fs.writeFile(configPath, JSON.stringify(customConfig), 'utf-8');

			// New manager instance to force reload
			const freshManager = new ExportConfigManager();
			await new Promise((r) => setTimeout(r, 50));

			const config = await freshManager.getConfig();
			expect(config.defaults.prettyPrint).toBe(false);
			expect(config.defaults.includeContent).toBe(true);
			expect(config.defaults.compression).toBe('zip');
		});

		it('should handle BOM in config file', async () => {
			const configPath = join(tmpDir, 'xml_export_config.json');
			const bomConfig = '﻿' + JSON.stringify({
				defaults: { prettyPrint: false, includeContent: true, compression: 'none' },
				templates: {},
				filters: {},
			});
			await fs.writeFile(configPath, bomConfig, 'utf-8');

			const freshManager = new ExportConfigManager();
			await new Promise((r) => setTimeout(r, 50));

			const config = await freshManager.getConfig();
			expect(config.defaults.prettyPrint).toBe(false);
		});

		it('should return default when storage detection fails', async () => {
			vi.mocked(RooStorageDetector.detectStorageLocations).mockRejectedValue(
				new Error('No storage')
			);

			const failingManager = new ExportConfigManager();
			await new Promise((r) => setTimeout(r, 50));

			const config = await failingManager.getConfig();
			expect(config.defaults.prettyPrint).toBe(true);
		});

		it('should cache config after first load', async () => {
			const config1 = await manager.getConfig();
			const config2 = await manager.getConfig();

			expect(config1).toBe(config2); // Same reference = cached
		});
	});

	describe('updateConfig', () => {
		it('should merge partial config updates', async () => {
			await manager.getConfig();

			await manager.updateConfig({
				defaults: { prettyPrint: false, includeContent: true, compression: 'zip' },
			});

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.defaults.prettyPrint).toBe(false);
			expect(config.defaults.includeContent).toBe(true);
			expect(config.defaults.compression).toBe('zip');
		});

		it('should add new templates via update', async () => {
			await manager.getConfig();

			await manager.updateConfig({
				templates: {
					custom: { format: 'custom', fields: ['id'] },
				},
			});

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.templates.custom).toBeDefined();
			expect(config.templates.custom.format).toBe('custom');
		});

		it('should add new filters via update', async () => {
			await manager.getConfig();

			await manager.updateConfig({
				filters: {
					this_month: { startDate: 'now-30d', endDate: 'now' },
				},
			});

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.filters.this_month).toBeDefined();
		});
	});

	describe('resetConfig', () => {
		it('should reset to defaults', async () => {
			await manager.getConfig();
			await manager.updateConfig({
				defaults: { prettyPrint: false, includeContent: true, compression: 'zip' },
			});

			await manager.resetConfig();

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.defaults.prettyPrint).toBe(true);
			expect(config.defaults.includeContent).toBe(false);
		});
	});

	describe('addTemplate / removeTemplate', () => {
		it('should add a new template', async () => {
			await manager.getConfig();
			await manager.addTemplate('test_tpl', { format: 'test', fields: ['taskId'] });

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.templates.test_tpl.format).toBe('test');
		});

		it('should remove an existing template', async () => {
			await manager.getConfig();
			await manager.addTemplate('to_remove', { format: 'test', fields: ['taskId'] });

			const removed = await manager.removeTemplate('to_remove');
			expect(removed).toBe(true);

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.templates.to_remove).toBeUndefined();
		});

		it('should return false when removing non-existent template', async () => {
			await manager.getConfig();
			const removed = await manager.removeTemplate('nonexistent');
			expect(removed).toBe(false);
		});
	});

	describe('addFilter / removeFilter', () => {
		it('should add a new filter', async () => {
			await manager.getConfig();
			await manager.addFilter('today', { startDate: 'now-1d', endDate: 'now' });

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.filters.today.startDate).toBe('now-1d');
		});

		it('should remove an existing filter', async () => {
			await manager.getConfig();
			await manager.addFilter('to_remove', { mode: 'debug' });

			const removed = await manager.removeFilter('to_remove');
			expect(removed).toBe(true);

			manager.invalidateCache();
			const config = await manager.getConfig();
			expect(config.filters.to_remove).toBeUndefined();
		});

		it('should return false when removing non-existent filter', async () => {
			await manager.getConfig();
			const removed = await manager.removeFilter('nonexistent');
			expect(removed).toBe(false);
		});
	});

	describe('invalidateCache', () => {
		it('should force reload on next getConfig', async () => {
			const config1 = await manager.getConfig();
			manager.invalidateCache();
			const config2 = await manager.getConfig();

			expect(config1).not.toBe(config2); // Different reference = reloaded
		});
	});

	describe('getConfigFilePath', () => {
		it('should return the config file path', async () => {
			const path = await manager.getConfigFilePath();
			expect(path).toContain('xml_export_config.json');
		});
	});
});
