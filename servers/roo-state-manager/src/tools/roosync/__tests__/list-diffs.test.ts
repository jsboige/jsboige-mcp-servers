/**
 * Tests pour list-diffs.ts
 * Issue #492 - Couverture de l'outil roosync_list_diffs
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { roosyncListDiffs, ListDiffsArgsSchema } from '../list-diffs.js';

// Mock RooSyncService
const { mockListDiffs, mockGetRooSyncService } = vi.hoisted(() => {
	const mockListDiffs = vi.fn();
	return {
		mockListDiffs,
		mockGetRooSyncService: vi.fn(() => ({
			listDiffs: mockListDiffs,
		})),
	};
});

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: mockGetRooSyncService,
	RooSyncServiceError: class RooSyncServiceError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'RooSyncServiceError';
			this.code = code;
		}
	},
}));

describe('list-diffs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('ListDiffsArgsSchema', () => {
		test('accepts empty input (defaults)', () => {
			const result = ListDiffsArgsSchema.parse({});
			expect(result.filterType).toBe('all');
		});

		test('accepts valid filterType values', () => {
			for (const filterType of ['all', 'config', 'files', 'settings']) {
				const result = ListDiffsArgsSchema.parse({ filterType });
				expect(result.filterType).toBe(filterType);
			}
		});

		test('rejects invalid filterType', () => {
			expect(() => ListDiffsArgsSchema.parse({ filterType: 'invalid' })).toThrow();
		});
	});

	// ============================================================
	// roosyncListDiffs
	// ============================================================

	describe('roosyncListDiffs', () => {
		test('returns diffs with severity', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 2,
				diffs: [
					{ type: 'config', path: '/mcp.json', description: 'MCP config diff', machines: ['ai-01', 'po-2023'] },
					{ type: 'hardware', path: '/inventory', description: 'RAM diff', machines: ['ai-01'] },
				],
			});

			const result = await roosyncListDiffs({ filterType: 'all' });
			expect(result.totalDiffs).toBe(2);
			expect(result.diffs[0].severity).toBe('high'); // config = high
			expect(result.diffs[1].severity).toBe('medium'); // hardware = medium
			expect(result.filterApplied).toBe('all');
		});

		test('maps config type to high severity', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 1,
				diffs: [{ type: 'config', path: '/test', description: 'Config', machines: [] }],
			});

			const result = await roosyncListDiffs({ filterType: 'config' });
			expect(result.diffs[0].severity).toBe('high');
		});

		test('maps hardware type to medium severity', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 1,
				diffs: [{ type: 'hardware', path: '/test', description: 'HW', machines: [] }],
			});

			const result = await roosyncListDiffs({ filterType: 'all' });
			expect(result.diffs[0].severity).toBe('medium');
		});

		test('maps software type to medium severity', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 1,
				diffs: [{ type: 'software', path: '/test', description: 'SW', machines: [] }],
			});

			const result = await roosyncListDiffs({ filterType: 'all' });
			expect(result.diffs[0].severity).toBe('medium');
		});

		test('maps unknown type to low severity', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 1,
				diffs: [{ type: 'other', path: '/test', description: 'Other', machines: [] }],
			});

			const result = await roosyncListDiffs({ filterType: 'all' });
			expect(result.diffs[0].severity).toBe('low');
		});

		test('handles empty diff list', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 0,
				diffs: [],
			});

			const result = await roosyncListDiffs({ filterType: 'all' });
			expect(result.totalDiffs).toBe(0);
			expect(result.diffs).toEqual([]);
		});

		test('passes filterType to service', async () => {
			mockListDiffs.mockResolvedValueOnce({
				totalDiffs: 0,
				diffs: [],
			});

			await roosyncListDiffs({ filterType: 'config' });
			expect(mockListDiffs).toHaveBeenCalledWith('config');
		});

		test('throws RooSyncServiceError on service error', async () => {
			mockListDiffs.mockRejectedValueOnce(new Error('Connection failed'));
			await expect(roosyncListDiffs({ filterType: 'all' }))
				.rejects.toThrow('Erreur lors du listing');
		});
	});
});
