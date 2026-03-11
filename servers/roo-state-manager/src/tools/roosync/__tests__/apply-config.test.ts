/**
 * Tests pour apply-config.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { ApplyConfigArgsSchema, roosyncApplyConfig } from '../apply-config.js';

// Mock RooSyncService
const { mockApplyConfig, mockGetConfigVersion } = vi.hoisted(() => ({
	mockApplyConfig: vi.fn(),
	mockGetConfigVersion: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfigService: () => ({
			getConfigVersion: mockGetConfigVersion
		}),
		getConfigSharingService: () => ({
			applyConfig: mockApplyConfig
		})
	})),
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'RooSyncServiceError';
			this.code = code;
		}
	}
}));

describe('apply-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApplyConfig.mockResolvedValue({
			success: true,
			filesApplied: ['modes.json'],
			backupPath: '/backup/path',
			errors: []
		});
		mockGetConfigVersion.mockResolvedValue('1.0.0');
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('ApplyConfigArgsSchema', () => {
		test('accepts empty input (all optional)', () => {
			const result = ApplyConfigArgsSchema.parse({});
			expect(result).toBeDefined();
		});

		test('accepts valid version string', () => {
			const result = ApplyConfigArgsSchema.parse({ version: '1.2.3' });
			expect(result.version).toBe('1.2.3');
		});

		test('accepts latest as version', () => {
			const result = ApplyConfigArgsSchema.parse({ version: 'latest' });
			expect(result.version).toBe('latest');
		});

		test('accepts valid machineId', () => {
			const result = ApplyConfigArgsSchema.parse({ machineId: 'myia-ai-01' });
			expect(result.machineId).toBe('myia-ai-01');
		});

		test('accepts valid targets: modes, mcp, profiles', () => {
			for (const target of ['modes', 'mcp', 'profiles']) {
				const result = ApplyConfigArgsSchema.parse({ targets: [target] });
				expect(result.targets).toEqual([target]);
			}
		});

		test('accepts mcp:serverName target', () => {
			const result = ApplyConfigArgsSchema.parse({ targets: ['mcp:roo-state-manager'] });
			expect(result.targets).toEqual(['mcp:roo-state-manager']);
		});

		test('accepts multiple valid targets', () => {
			const result = ApplyConfigArgsSchema.parse({ targets: ['modes', 'mcp', 'mcp:win-cli'] });
			expect(result.targets).toHaveLength(3);
		});

		test('rejects invalid target', () => {
			expect(() => ApplyConfigArgsSchema.parse({ targets: ['invalid'] })).toThrow();
		});

		test('rejects mcp: with empty server name', () => {
			expect(() => ApplyConfigArgsSchema.parse({ targets: ['mcp:'] })).toThrow();
		});

		test('rejects mcp: with whitespace-only server name', () => {
			expect(() => ApplyConfigArgsSchema.parse({ targets: ['mcp:   '] })).toThrow();
		});

		test('accepts backup and dryRun booleans', () => {
			const result = ApplyConfigArgsSchema.parse({ backup: false, dryRun: true });
			expect(result.backup).toBe(false);
			expect(result.dryRun).toBe(true);
		});

		test('accepts all parameters together', () => {
			const result = ApplyConfigArgsSchema.parse({
				version: '2.0.0',
				machineId: 'myia-po-2023',
				targets: ['modes', 'mcp:win-cli'],
				backup: true,
				dryRun: false
			});
			expect(result.version).toBe('2.0.0');
			expect(result.machineId).toBe('myia-po-2023');
			expect(result.targets).toHaveLength(2);
		});
	});

	// ============================================================
	// roosyncApplyConfig function
	// ============================================================

	describe('roosyncApplyConfig', () => {
		test('returns success on service success', async () => {
			const result = await roosyncApplyConfig({ targets: ['modes'] });
			expect(result.status).toBe('success');
			expect(result.filesApplied).toEqual(['modes.json']);
		});

		test('returns error status on service failure', async () => {
			mockApplyConfig.mockResolvedValueOnce({
				success: false,
				filesApplied: [],
				errors: ['Config not found']
			});

			const result = await roosyncApplyConfig({});
			expect(result.status).toBe('error');
		});

		test('defaults backup to true', async () => {
			await roosyncApplyConfig({});
			expect(mockApplyConfig).toHaveBeenCalledWith(
				expect.objectContaining({ backup: true })
			);
		});

		test('defaults dryRun to false', async () => {
			await roosyncApplyConfig({});
			expect(mockApplyConfig).toHaveBeenCalledWith(
				expect.objectContaining({ dryRun: false })
			);
		});

		test('throws on service exception', async () => {
			mockApplyConfig.mockRejectedValueOnce(new Error('Network error'));

			await expect(roosyncApplyConfig({})).rejects.toThrow('application de la configuration');
		});
	});
});
