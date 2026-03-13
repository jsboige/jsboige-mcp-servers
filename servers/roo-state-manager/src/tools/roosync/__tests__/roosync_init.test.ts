/**
 * Tests pour roosync_init.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { InitArgsSchema, InitResultSchema, roosyncInit } from '../roosync_init.js';

// Mock all external dependencies
const { mockGetConfig, mockExistsSync, mockMkdirSync, mockWriteFileSync, mockReadFileSync, mockUnlinkSync, mockReadJSONFileSyncWithoutBOM } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockExistsSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockReadJSONFileSyncWithoutBOM: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig
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

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: mockExistsSync,
		mkdirSync: mockMkdirSync,
		writeFileSync: mockWriteFileSync,
		readFileSync: mockReadFileSync,
		unlinkSync: mockUnlinkSync
	};
});

vi.mock('../../../utils/encoding-helpers.js', () => ({
	readJSONFileSyncWithoutBOM: mockReadJSONFileSyncWithoutBOM,
	readFileSyncWithoutBOM: vi.fn((path: string) => ''),
	stripBOM: vi.fn((s: string) => s)
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	})),
	Logger: class {}
}));

describe('roosync_init', () => {
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

	describe('InitArgsSchema', () => {
		test('accepts empty input (all optional)', () => {
			const result = InitArgsSchema.parse({});
			expect(result).toBeDefined();
		});

		test('accepts force boolean', () => {
			const result = InitArgsSchema.parse({ force: true });
			expect(result.force).toBe(true);
		});

		test('accepts createRoadmap boolean', () => {
			const result = InitArgsSchema.parse({ createRoadmap: false });
			expect(result.createRoadmap).toBe(false);
		});

		test('accepts both parameters', () => {
			const result = InitArgsSchema.parse({ force: true, createRoadmap: true });
			expect(result.force).toBe(true);
			expect(result.createRoadmap).toBe(true);
		});

		test('rejects non-boolean force', () => {
			expect(() => InitArgsSchema.parse({ force: 'yes' })).toThrow();
		});

		test('rejects non-boolean createRoadmap', () => {
			expect(() => InitArgsSchema.parse({ createRoadmap: 42 })).toThrow();
		});
	});

	describe('InitResultSchema', () => {
		test('validates a complete result', () => {
			const result = InitResultSchema.parse({
				success: true,
				machineId: 'test-machine',
				sharedPath: '/shared/path',
				filesCreated: ['dashboard.json'],
				filesSkipped: ['roadmap.md'],
				message: 'Init complete'
			});
			expect(result.success).toBe(true);
			expect(result.filesCreated).toHaveLength(1);
		});

		test('rejects missing required fields', () => {
			expect(() => InitResultSchema.parse({ success: true })).toThrow();
		});
	});

	// ============================================================
	// roosyncInit function
	// ============================================================

	describe('roosyncInit', () => {
		test('creates shared directory when it does not exist', async () => {
			// First call: sharedPath doesn't exist; subsequent calls: dashboard/roadmap/rollback don't exist
			mockExistsSync.mockReturnValue(false);

			const result = await roosyncInit({});

			expect(result.success).toBe(true);
			expect(result.machineId).toBe('test-machine');
			expect(mockMkdirSync).toHaveBeenCalled();
		});

		test('skips shared directory when it exists', async () => {
			// sharedPath exists, dashboard doesn't, roadmap doesn't, rollback doesn't
			mockExistsSync.mockImplementation((path: string) => {
				if (path === '/shared/path') return true;
				return false;
			});

			const result = await roosyncInit({});

			expect(result.success).toBe(true);
			expect(result.filesSkipped).toContain('/shared/path/ (d\u00e9j\u00e0 existant)');
		});

		test('creates dashboard when force is true even if exists', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'test-machine': {} }
			});

			const result = await roosyncInit({ force: true });

			expect(result.success).toBe(true);
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		test('skips roadmap when createRoadmap is false', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await roosyncInit({ createRoadmap: false });

			expect(result.success).toBe(true);
			// Roadmap should not appear in created or skipped
			const hasRoadmap = result.filesCreated.some(f => f.includes('roadmap'));
			expect(hasRoadmap).toBe(false);
		});

		test('returns filesCreated and filesSkipped arrays', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await roosyncInit({});

			expect(Array.isArray(result.filesCreated)).toBe(true);
			expect(Array.isArray(result.filesSkipped)).toBe(true);
		});

		test('adds machine to existing dashboard if not registered', async () => {
			mockExistsSync.mockImplementation((path: string) => {
				if (typeof path === 'string' && path.includes('sync-dashboard.json')) return true;
				if (path === '/shared/path') return true;
				return false;
			});
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'other-machine': { status: 'online' } },
				lastUpdate: '2026-01-01'
			});

			const result = await roosyncInit({});

			expect(result.success).toBe(true);
			// Should have written dashboard with added machine
			expect(result.filesCreated).toContain('sync-dashboard.json (machine ajout\u00e9e)');
		});

		test('message includes force warning when force is true', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await roosyncInit({ force: true });

			expect(result.message).toContain('force');
		});
	});
});
