/**
 * Tests pour roosync_init.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { InitArgsSchema, InitResultSchema, roosyncInit } from '../roosync_init.js';

// Mock all external dependencies
const { mockGetConfig, mockExistsSync, mockMkdirSync, mockWriteFileSync, mockReadFileSync, mockUnlinkSync, mockCopyFileSync, mockReadJSONFileSyncWithoutBOM, mockExecAsync } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockExistsSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockCopyFileSync: vi.fn(),
	mockReadJSONFileSyncWithoutBOM: vi.fn(),
	mockExecAsync: vi.fn()
}));

// #2406 review (ms#1392): the inventory section reaches sync-config.json —
// the module builds execAsync = promisify(exec) at import time, so mock 'util'.
vi.mock('util', () => ({
	promisify: () => mockExecAsync
}));
vi.mock('child_process', () => ({
	exec: vi.fn()
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
		unlinkSync: mockUnlinkSync,
		copyFileSync: mockCopyFileSync
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

		test('#2406 review: force backs up the shared dashboard before overwriting it', async () => {
			// ms#1392 : avec force:true, sync-dashboard.json (partagé, lu par
			// BaselineManager) est écrasé par un modèle à une machine — une
			// sauvegarde .bak horodatée doit précéder l'écrasement.
			mockExistsSync.mockReturnValue(true);
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'test-machine': {} }
			});

			const result = await roosyncInit({ force: true });

			expect(result.success).toBe(true);
			// (sous force, la roadmap est sauvegardée aussi — cf. test dédié ;
			// ici on cible le backup du dashboard précisément)
			const dashboardBackup = mockCopyFileSync.mock.calls
				.map((c, i) => ({ src: String(c[0]), dest: String(c[1]), order: mockCopyFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.src.includes('sync-dashboard.json'));
			expect(dashboardBackup).toBeDefined();
			expect(dashboardBackup!.src).toContain('sync-dashboard.json');
			expect(dashboardBackup!.dest).toMatch(/sync-dashboard\.bak-.*\.json/);
			const dashboardWrite = mockWriteFileSync.mock.calls
				.map((c, i) => ({ path: String(c[0]), order: mockWriteFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.path.includes('sync-dashboard.json'));
			// L'écrasement suit la sauvegarde, pas l'inverse
			expect(dashboardBackup!.order).toBeLessThan(dashboardWrite!.order);
			expect(result.filesCreated.some(f => f.includes('sauvegarde avant force'))).toBe(true);
		});

		test('no backup when force is false (dashboard untouched)', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'test-machine': {} },
				lastUpdate: '2026-01-01'
			});

			await roosyncInit({});

			expect(mockCopyFileSync).not.toHaveBeenCalled();
		});

		test('#2406 review: force backs up sync-config.json before the inventory reset', async () => {
			// ms#1392 : sous force, syncConfig repart de { machines: {} } —
			// l'inventaire de TOUTES les autres machines serait perdu sans
			// sauvegarde préalable (même famille que le dashboard).
			mockExistsSync.mockImplementation((p: unknown) =>
				typeof p === 'string' &&
				(p === '/shared/path' ||
					p.endsWith('Get-MachineInventory.ps1') ||
					p.endsWith('inventory.json') ||
					p.includes('sync-dashboard.json') ||
					p.includes('sync-config.json'))
			);
			mockExecAsync.mockResolvedValue({ stdout: '/tmp/inventory.json\n', stderr: '' });
			mockReadFileSync.mockReturnValue(JSON.stringify({
				inventory: { os: 'test-os' },
				timestamp: '2026-10-07T00:00:00Z',
				paths: { home: '/home/test' }
			}));
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'test-machine': {} }
			});

			const result = await roosyncInit({ force: true });

			expect(result.success).toBe(true);
			const backup = mockCopyFileSync.mock.calls
				.map((c, i) => ({ src: String(c[0]), order: mockCopyFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.src.includes('sync-config.json'));
			expect(backup).toBeDefined();
			const write = mockWriteFileSync.mock.calls
				.map((c, i) => ({ path: String(c[0]), order: mockWriteFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.path.includes('sync-config.json'));
			expect(write).toBeDefined();
			// La sauvegarde précède l'écrasement, pas l'inverse
			expect(backup!.order).toBeLessThan(write!.order);
			expect(result.filesCreated.filter(f => f.includes('sauvegarde avant force')).length).toBeGreaterThanOrEqual(2);
		});

		test('#2406 review: force backs up sync-roadmap.md before template rewrite', async () => {
			// ms#1392 : sous force, la roadmap est réécrite depuis le
			// template — sauvegarde préalable, même famille que le dashboard.
			mockExistsSync.mockImplementation((p: unknown) =>
				typeof p === 'string' &&
				(p === '/shared/path' ||
					p.includes('sync-dashboard.json') ||
					p.includes('sync-roadmap.md'))
			);
			mockReadJSONFileSyncWithoutBOM.mockReturnValue({
				machines: { 'test-machine': {} }
			});

			const result = await roosyncInit({ force: true });

			expect(result.success).toBe(true);
			const backup = mockCopyFileSync.mock.calls
				.map((c, i) => ({ src: String(c[0]), order: mockCopyFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.src.includes('sync-roadmap.md'));
			expect(backup).toBeDefined();
			expect(mockCopyFileSync.mock.calls.some(c => /sync-roadmap\.bak-.*\.md/.test(String(c[1])))).toBe(true);
			const write = mockWriteFileSync.mock.calls
				.map((c, i) => ({ path: String(c[0]), order: mockWriteFileSync.mock.invocationCallOrder[i] }))
				.find(c => c.path.includes('sync-roadmap.md'));
			expect(write).toBeDefined();
			// La sauvegarde précède l'écrasement, pas l'inverse
			expect(backup!.order).toBeLessThan(write!.order);
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
