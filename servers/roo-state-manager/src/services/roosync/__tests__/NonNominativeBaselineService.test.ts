/**
 * Tests pour NonNominativeBaselineService.ts
 * Issue #492 - Couverture des services RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockReadFile, mockWriteFile, mockMkdir, mockAccess } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockAccess: vi.fn()
}));

const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn()
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: mockExistsSync,
		promises: {
			readFile: mockReadFile,
			writeFile: mockWriteFile,
			mkdir: mockMkdir,
			access: mockAccess
		}
	};
});

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}))
}));

vi.mock('../../../utils/encoding-helpers.js', () => ({
	readJSONFileWithoutBOM: vi.fn()
}));

import { NonNominativeBaselineService } from '../NonNominativeBaselineService.js';

describe('NonNominativeBaselineService', () => {
	let service: NonNominativeBaselineService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		service = new NonNominativeBaselineService('/shared/path');
	});

	// ============================================================
	// generateMachineHash
	// ============================================================

	describe('generateMachineHash', () => {
		test('generates a 16-char hex string', () => {
			const hash = service.generateMachineHash('test-machine');
			expect(hash).toHaveLength(16);
			expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
		});

		test('generates deterministic hash for same input', () => {
			const hash1 = service.generateMachineHash('test-machine');
			const hash2 = service.generateMachineHash('test-machine');
			expect(hash1).toBe(hash2);
		});

		test('generates different hashes for different inputs', () => {
			const hash1 = service.generateMachineHash('machine-a');
			const hash2 = service.generateMachineHash('machine-b');
			expect(hash1).not.toBe(hash2);
		});

		test('includes salt in hash computation', () => {
			// Same machineId but different service instance should give same hash
			// (salt is constant 'roosync-salt-2024')
			const service2 = new NonNominativeBaselineService('/other/path');
			const hash1 = service.generateMachineHash('test');
			const hash2 = service2.generateMachineHash('test');
			expect(hash1).toBe(hash2);
		});
	});

	// ============================================================
	// createBaseline
	// ============================================================

	describe('createBaseline', () => {
		test('creates baseline with correct structure', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const baseline = await service.createBaseline(
				'Test Baseline',
				'Description for testing',
				[{
					profileId: 'p1',
					category: 'roo-core' as any,
					configuration: { modes: ['code'] },
					priority: 100,
					description: 'Roo core config'
				}]
			);

			expect(baseline.name).toBe('Test Baseline');
			expect(baseline.description).toBe('Description for testing');
			expect(baseline.version).toBe('1.0.0');
			expect(baseline.profiles).toHaveLength(1);
			expect(baseline.baselineId).toMatch(/^baseline-/);
		});

		test('creates baseline with aggregation rules', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const baseline = await service.createBaseline('B', 'D', []);

			expect(baseline.aggregationRules).toBeDefined();
			expect(baseline.aggregationRules.conflictResolution).toBe('highest_priority');
		});

		test('creates baseline with metadata timestamps', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			const before = new Date().toISOString();
			const baseline = await service.createBaseline('B', 'D', []);
			const after = new Date().toISOString();

			expect(baseline.metadata.createdAt >= before).toBe(true);
			expect(baseline.metadata.createdAt <= after).toBe(true);
			expect(baseline.metadata.status).toBe('active');
		});

		test('saves baseline to file', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);

			await service.createBaseline('B', 'D', []);

			expect(mockWriteFile).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Constructor initialization
	// ============================================================

	describe('constructor', () => {
		test('initializes with correct paths', () => {
			const svc = new NonNominativeBaselineService('/test/path');
			// Service should be created without throwing
			expect(svc).toBeDefined();
		});

		test('initializes state with empty values', () => {
			const svc = new NonNominativeBaselineService('/test/path');
			// The hash function should work immediately
			const hash = svc.generateMachineHash('test');
			expect(hash).toBeDefined();
		});
	});
});
