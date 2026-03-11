/**
 * Tests pour collect-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { CollectConfigArgsSchema, roosyncCollectConfig } from '../collect-config.js';

// Mock RooSyncService
const { mockGetConfig, mockCollectConfig } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockCollectConfig: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		getConfigSharingService: vi.fn(() => ({
			collectConfig: mockCollectConfig
		}))
	}))
}));

vi.mock('../../../types/errors.js', () => ({
	ConfigSharingServiceError: class extends Error {
		code: string;
		details: any;
		constructor(message: string, code: string, details?: any) {
			super(message);
			this.name = 'ConfigSharingServiceError';
			this.code = code;
			this.details = details;
		}
	},
	ConfigSharingServiceErrorCode: {
		COLLECTION_FAILED: 'COLLECTION_FAILED'
	}
}));

describe('collect-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({
			machineId: 'test-machine',
			sharedPath: '/shared/path'
		});
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('CollectConfigArgsSchema', () => {
		test('accepts empty input (all optional)', () => {
			const result = CollectConfigArgsSchema.parse({});
			expect(result).toBeDefined();
		});

		test('accepts targets array', () => {
			const result = CollectConfigArgsSchema.parse({ targets: ['modes', 'mcp'] });
			expect(result.targets).toEqual(['modes', 'mcp']);
		});

		test('accepts dryRun boolean', () => {
			const result = CollectConfigArgsSchema.parse({ dryRun: true });
			expect(result.dryRun).toBe(true);
		});

		test('accepts both parameters', () => {
			const result = CollectConfigArgsSchema.parse({ targets: ['profiles'], dryRun: false });
			expect(result.targets).toEqual(['profiles']);
			expect(result.dryRun).toBe(false);
		});

		test('rejects non-array targets', () => {
			expect(() => CollectConfigArgsSchema.parse({ targets: 'modes' })).toThrow();
		});

		test('rejects non-boolean dryRun', () => {
			expect(() => CollectConfigArgsSchema.parse({ dryRun: 'yes' })).toThrow();
		});
	});

	// ============================================================
	// roosyncCollectConfig function
	// ============================================================

	describe('roosyncCollectConfig', () => {
		test('returns success with package info', async () => {
			mockCollectConfig.mockResolvedValue({
				filesCount: 5,
				packagePath: '/shared/path/packages/test-package.zip',
				totalSize: 1024,
				manifest: { modes: ['default'], mcp: ['win-cli'] }
			});

			const result = await roosyncCollectConfig({});

			expect(result.status).toBe('success');
			expect(result.packagePath).toContain('test-package.zip');
			expect(result.totalSize).toBe(1024);
		});

		test('uses default targets when not specified', async () => {
			mockCollectConfig.mockResolvedValue({
				filesCount: 2,
				packagePath: '/shared/path/pkg.zip',
				totalSize: 512,
				manifest: {}
			});

			await roosyncCollectConfig({});

			expect(mockCollectConfig).toHaveBeenCalledWith({
				targets: ['modes', 'mcp'],
				dryRun: false
			});
		});

		test('passes custom targets', async () => {
			mockCollectConfig.mockResolvedValue({
				filesCount: 1,
				packagePath: '/shared/path/pkg.zip',
				totalSize: 256,
				manifest: {}
			});

			await roosyncCollectConfig({ targets: ['profiles'] });

			expect(mockCollectConfig).toHaveBeenCalledWith({
				targets: ['profiles'],
				dryRun: false
			});
		});

		test('passes dryRun flag', async () => {
			mockCollectConfig.mockResolvedValue({
				filesCount: 0,
				packagePath: '',
				totalSize: 0,
				manifest: {}
			});

			await roosyncCollectConfig({ dryRun: true });

			expect(mockCollectConfig).toHaveBeenCalledWith({
				targets: ['modes', 'mcp'],
				dryRun: true
			});
		});

		test('throws ConfigSharingServiceError on failure', async () => {
			mockCollectConfig.mockRejectedValue(new Error('Collection failed'));

			await expect(roosyncCollectConfig({})).rejects.toThrow('Collection failed');
		});

		test('message includes file count', async () => {
			mockCollectConfig.mockResolvedValue({
				filesCount: 7,
				packagePath: '/shared/path/pkg.zip',
				totalSize: 2048,
				manifest: {}
			});

			const result = await roosyncCollectConfig({});

			expect(result.message).toContain('7');
		});
	});
});
