/**
 * Coverage complement for export-project-xml.ts (#833 C3)
 *
 * The nominal suite (export-project-xml.test.ts, #492) covers the happy paths:
 *   - startDate/endDate filters with tasks carrying `lastActivity`
 *   - error handler via `throw new Error(...)` (instanceof Error arm)
 *
 * This add-only file covers the 3 cold BRANCHES the nominal suite leaves out:
 *   - L87/L94: `lastActivity || createdAt || ''` data-resolution chain — the
 *     `createdAt` fallback arm and the `''` (no-date) fallback arm are never
 *     taken because every nominal fixture sets `lastActivity`.
 *   - L127: `error instanceof Error ? error.message : String(error)` — the
 *     `String(error)` arm (non-Error throw) is never taken.
 *
 * Source-grounded: every assertion cites the source line whose branch it exercises.
 * Tests-only, 0 source change.
 *
 * @module tools/export/__tests__/export-project-xml.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleExportProjectXml } from '../export-project-xml.js';

describe('handleExportProjectXml — coverage complement (#833 C3)', () => {
	const mockXmlService = {
		generateProjectXml: vi.fn(),
		saveXmlToFile: vi.fn()
	};
	const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
		mockEnsureFresh.mockResolvedValue(undefined);
		mockXmlService.generateProjectXml.mockReturnValue('<p/>');
		mockXmlService.saveXmlToFile.mockResolvedValue(undefined);
	});

	// ============================================================
	// L87 data-resolution chain: `lastActivity || createdAt || ''`
	// The `createdAt` fallback arm — task has NO lastActivity but HAS createdAt.
	// ============================================================
	describe('startDate filter — createdAt fallback arm (L87)', () => {
		test('uses createdAt when lastActivity is absent (old task filtered out)', async () => {
			const cache = new Map();
			// Fixture: only `createdAt` set (no lastActivity) → exercises the
			// `lastActivity || createdAt` fallback arm at L87.
			cache.set('old', {
				taskId: 'old',
				metadata: { workspace: '/proj', createdAt: '2025-01-01' }
			});
			cache.set('new', {
				taskId: 'new',
				metadata: { workspace: '/proj', createdAt: '2026-06-01' }
			});

			await handleExportProjectXml(
				{ projectPath: '/proj', startDate: '2026-01-01' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			// createdAt 2025-01-01 < startDate 2026-01-01 → filtered out.
			// createdAt 2026-06-01 >= startDate → kept. Proves createdAt is the
			// resolved date (not lastActivity which is absent here).
			const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
			expect(passedTasks.length).toBe(1);
			expect(passedTasks[0].taskId).toBe('new');
		});
	});

	// ============================================================
	// L87 data-resolution chain: the `''` (no-date) fallback arm.
	// Task has neither lastActivity nor createdAt → new Date('') = Invalid Date.
	// Invalid Date < new Date(startDate) evaluates to false → task is KEPT.
	// ============================================================
	describe('startDate filter — empty-string fallback arm (L87)', () => {
		test('keeps task with no date fields (Invalid Date comparison is false)', async () => {
			const cache = new Map();
			// Fixture: no lastActivity, no createdAt → resolves to '' at L87.
			cache.set('dateless', {
				taskId: 'dateless',
				metadata: { workspace: '/proj' }
			});

			await handleExportProjectXml(
				{ projectPath: '/proj', startDate: '2026-01-01' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			// new Date('') is Invalid Date; `Invalid Date < valid Date` is false,
			// so the task is NOT filtered out by the startDate guard.
			const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
			expect(passedTasks.length).toBe(1);
			expect(passedTasks[0].taskId).toBe('dateless');
		});
	});

	// ============================================================
	// L94 data-resolution chain (endDate): `createdAt` fallback arm.
	// Symmetric to the startDate createdAt coverage above.
	// ============================================================
	describe('endDate filter — createdAt fallback arm (L94)', () => {
		test('uses createdAt when lastActivity is absent (new task filtered out)', async () => {
			const cache = new Map();
			cache.set('old', {
				taskId: 'old',
				metadata: { workspace: '/proj', createdAt: '2025-01-01' }
			});
			cache.set('new', {
				taskId: 'new',
				metadata: { workspace: '/proj', createdAt: '2026-06-01' }
			});

			await handleExportProjectXml(
				{ projectPath: '/proj', endDate: '2025-12-31' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			// createdAt 2026-06-01 > endDate 2025-12-31 → filtered out.
			// createdAt 2025-01-01 <= endDate → kept. Proves createdAt resolved.
			const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
			expect(passedTasks.length).toBe(1);
			expect(passedTasks[0].taskId).toBe('old');
		});
	});

	// ============================================================
	// L127: `error instanceof Error ? error.message : String(error)`
	// The `String(error)` arm — a non-Error value is thrown.
	// ============================================================
	describe('error handler — non-Error throw → String(error) arm (L127)', () => {
		test('formats a thrown string via String()', async () => {
			const cache = new Map();
			// Throwing a bare string (not an Error) → instanceof Error is false
			// → the `String(error)` arm at L127 is taken.
			mockXmlService.generateProjectXml.mockImplementation(() => {
				throw 'raw string failure';
			});

			const result = await handleExportProjectXml(
				{ projectPath: '/proj' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			// String('raw string failure') === 'raw string failure'.
			expect(result.content[0].text).toContain('raw string failure');
			expect(result.content[0].text).toContain('Erreur');
		});

		test('formats a thrown object via String()', async () => {
			const cache = new Map();
			// Throwing a non-Error object → String(obj) → '[object Object]'.
			mockXmlService.generateProjectXml.mockImplementation(() => {
				throw { code: 42, detail: 'boom' };
			});

			const result = await handleExportProjectXml(
				{ projectPath: '/proj' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			// String({code:42}) === '[object Object]'.
			expect(result.content[0].text).toContain('[object Object]');
		});

		test('formats a thrown number via String()', async () => {
			const cache = new Map();
			// Throwing a number → String(500) === '500'.
			mockXmlService.generateProjectXml.mockImplementation(() => {
				throw 500;
			});

			const result = await handleExportProjectXml(
				{ projectPath: '/proj' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			expect(result.content[0].text).toContain('500');
		});
	});

	// ============================================================
	// Edge: metadata?.lastActivity with `?.` — metadata itself absent.
	// Belt-and-suspenders for the L87 `?.` optional-chain + '' fallback.
	// ============================================================
	describe('startDate filter — metadata absent (L87 optional-chain)', () => {
		test('keeps task whose metadata is undefined', async () => {
			const cache = new Map();
			// metadata undefined → skeleton.metadata?.lastActivity is undefined,
			// createdAt undefined → resolves to '' at L87 → Invalid Date → kept.
			cache.set('nometa', { taskId: 'nometa' });

			await handleExportProjectXml(
				{ projectPath: '/proj', startDate: '2026-01-01' },
				cache,
				mockXmlService as any,
				mockEnsureFresh
			);

			const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
			// No metadata.workspace → the workspace guard (L77) is skipped, task
			// passes to the date guard which keeps it (Invalid Date).
			expect(passedTasks.some((t: any) => t.taskId === 'nometa')).toBe(true);
		});
	});
});
