/**
 * Tests pour IdentityService.ts
 * Issue #492 - Couverture du service d'identité
 *
 * @module services/roosync/__tests__/IdentityService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAccess, mockReadFile, mockReaddir } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		access: mockAccess,
		readFile: mockReadFile,
		readdir: mockReaddir
	},
	access: mockAccess,
	readFile: mockReadFile,
	readdir: mockReaddir
}));

import { IdentityService } from '../IdentityService.js';

describe('IdentityService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Singleton
	// ============================================================

	describe('singleton', () => {
		test('getInstance returns same instance', () => {
			const a = IdentityService.getInstance();
			const b = IdentityService.getInstance();
			expect(a).toBe(b);
		});
	});

	// ============================================================
	// validateIdentityProtection - shared path missing
	// ============================================================

	describe('validateIdentityProtection - missing path', () => {
		test('returns empty checks when shared path does not exist', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/fake/path', 'test-machine');
			expect(result.machineId).toBe('test-machine');
			expect(result.sharedPath).toBe('/fake/path');
			expect(result.checks.registryFile).toBe(false);
			expect(result.checks.identityRegistry).toBe(false);
			expect(result.checks.presenceFiles).toBe(false);
			expect(result.checks.dashboardFile).toBe(false);
			expect(result.checks.configFiles).toBe(false);
			expect(result.logs.some(l => l.includes('ERROR'))).toBe(true);
		});
	});

	// ============================================================
	// validateIdentityProtection - all files present
	// ============================================================

	describe('validateIdentityProtection - all present', () => {
		beforeEach(() => {
			// Shared path exists
			mockAccess.mockResolvedValue(undefined);
		});

		test('detects machine registry file', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: { 'test-machine': {} } });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({ identities: {} });
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({ status: 'ok' });
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'test-machine' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.registryFile).toBe(true);
			expect(result.logs.some(l => l.includes('Machine registry found'))).toBe(true);
		});

		test('detects identity conflicts', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: {} });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({
						identities: {
							'machine-a': { status: 'ok' },
							'machine-b': { status: 'conflict' }
						}
					});
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({});
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'test-machine' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.identityRegistry).toBe(true);
			expect(result.details.conflicts).toEqual(['machine-b']);
			expect(result.logs.some(l => l.includes('Identity conflicts detected'))).toBe(true);
		});

		test('detects presence files', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: {} });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({ identities: {} });
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({});
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'test-machine' });
				}
				if (filePath.includes('machine1.json')) {
					return JSON.stringify({ id: 'machine-1' });
				}
				if (filePath.includes('machine2.json')) {
					return JSON.stringify({ id: 'machine-2' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue(['machine1.json', 'machine2.json']);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.presenceFiles).toBe(true);
			expect(result.details.presence).toHaveLength(2);
			expect(result.logs.some(l => l.includes('2 presence files found'))).toBe(true);
		});

		test('detects dashboard file', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: {} });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({ identities: {} });
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({ version: '1.0', machines: [] });
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'test-machine' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.dashboardFile).toBe(true);
			expect(result.details.dashboard).toBeDefined();
		});

		test('detects config files with matching machineId', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: {} });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({ identities: {} });
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({});
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'test-machine' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.configFiles).toBe(true);
			expect(result.logs.some(l => l.includes('matches machine ID'))).toBe(true);
		});

		test('warns on config machineId mismatch', async () => {
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return JSON.stringify({ machines: {} });
				}
				if (filePath.includes('.identity-registry.json')) {
					return JSON.stringify({ identities: {} });
				}
				if (filePath.includes('sync-dashboard.json')) {
					return JSON.stringify({});
				}
				if (filePath.includes('sync-config.json')) {
					return JSON.stringify({ machineId: 'other-machine' });
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.logs.some(l => l.includes('mismatch'))).toBe(true);
		});
	});

	// ============================================================
	// validateIdentityProtection - file read errors
	// ============================================================

	describe('validateIdentityProtection - read errors', () => {
		test('handles JSON parse errors gracefully', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockImplementation(async (filePath: string) => {
				if (filePath.includes('.machine-registry.json')) {
					return 'invalid json{{{';
				}
				throw new Error('Not found');
			});
			mockReaddir.mockResolvedValue([]);

			const service = IdentityService.getInstance();
			const result = await service.validateIdentityProtection('/shared', 'test-machine');
			expect(result.checks.registryFile).toBe(true); // File exists
			expect(result.logs.some(l => l.includes('Error reading machine registry'))).toBe(true);
		});
	});
});
