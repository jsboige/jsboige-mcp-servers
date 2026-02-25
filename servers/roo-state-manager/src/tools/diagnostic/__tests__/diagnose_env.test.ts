/**
 * Tests pour diagnose_env.ts
 * Issue #492 - Couverture du diagnostic environnement
 *
 * @module tools/diagnostic/__tests__/diagnose_env
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAccess } = vi.hoisted(() => ({
	mockAccess: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		access: mockAccess,
		constants: { R_OK: 4, W_OK: 2 }
	},
	access: mockAccess,
	constants: { R_OK: 4, W_OK: 2 }
}));

vi.mock('os', () => ({
	default: {
		hostname: vi.fn(() => 'test-hostname'),
		uptime: vi.fn(() => 3600),
		totalmem: vi.fn(() => 8589934592),
		freemem: vi.fn(() => 4294967296)
	},
	hostname: vi.fn(() => 'test-hostname'),
	uptime: vi.fn(() => 3600),
	totalmem: vi.fn(() => 8589934592),
	freemem: vi.fn(() => 4294967296)
}));

// Must import after mock
import { diagnoseEnv } from '../diagnose_env.js';

describe('diagnoseEnv', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns report with system info', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe('text');

		const report = JSON.parse(result.content[0].text);
		expect(report.system).toBeDefined();
		expect(report.system.platform).toBe(process.platform);
		expect(report.system.nodeVersion).toBe(process.version);
		expect(report.system.hostname).toBeTruthy();
	});

	test('includes environment variables check', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.envVars).toBeDefined();
		expect(report.envVars.hasPath).toBe(true);
		expect(report.envVars.cwd).toBeTruthy();
	});

	test('includes timestamp', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.timestamp).toBeTruthy();
		// Verify it's a valid ISO string
		expect(new Date(report.timestamp).getTime()).not.toBeNaN();
	});

	test('reports OK status when all directories accessible', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.status).toBe('OK');
	});

	test('reports WARNING status when directory is inaccessible', async () => {
		const enoent = Object.assign(new Error('Not found'), { code: 'ENOENT' });
		mockAccess.mockRejectedValue(enoent);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.status).toBe('WARNING');
	});

	test('includes directory status for critical dirs', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.directories).toBeDefined();
		expect(report.directories['.']).toBeDefined();
	});

	test('reports missing files', async () => {
		// First calls for directories succeed, then file checks fail
		let callCount = 0;
		mockAccess.mockImplementation(async () => {
			callCount++;
			// Directories are 5 calls, files are 2 calls after
			if (callCount > 5) {
				throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
			}
		});
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.status).toBe('WARNING');
	});

	test('includes system memory info', async () => {
		mockAccess.mockResolvedValue(undefined);
		const result = await diagnoseEnv();
		const report = JSON.parse(result.content[0].text);
		expect(report.system.totalMemory).toBeGreaterThan(0);
		expect(report.system.freeMemory).toBeGreaterThan(0);
		expect(report.system.uptime).toBeGreaterThan(0);
	});
});
