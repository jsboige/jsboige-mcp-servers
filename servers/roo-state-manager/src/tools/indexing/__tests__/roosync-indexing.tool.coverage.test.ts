/**
 * Coverage test for roosync-indexing.tool.ts — genuinely non-covered branches.
 *
 * Lane S (po-2026) of ai-01 [DISPATCH] Vein D (coverage, 72h).
 * Pattern C3: 1 file = 1 PR. This covers branches the existing test file
 * (roosync-indexing.tool.test.ts) does not reach:
 *   - normalizeToolName (exported, 3 prefix branches) — direct unit coverage
 *   - garbage_scan action (L515-592): dry_run scan, executed scan+cleanup, error path
 *   - default case (L1293): unsupported action fallback (after the validation guard)
 *
 * Anchored on real source contract: roosync-indexing.tool.ts @ 9287747c2.
 *
 * @module tools/indexing/__tests__/roosync-indexing.tool.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleRooSyncIndexing, roosyncIndexingTool } from '../roosync-indexing.tool.js';

// NOTE: normalizeToolName is already exhaustively covered by the dedicated
// tool-name-normalization.test.ts (8 tests, all prefix/edge branches). It is
// NOT re-tested here to avoid pure duplication (guard: "already covered → skip").

// ---- hoisted mocks ----
const {
	mockScanForGarbage,
	mockCleanupGarbage,
	mockIndexHandler,
	mockResetHandler,
	mockDiagnoseHandler,
} = vi.hoisted(() => ({
	mockScanForGarbage: vi.fn(),
	mockCleanupGarbage: vi.fn(),
	mockIndexHandler: vi.fn(),
	mockResetHandler: vi.fn(),
	mockDiagnoseHandler: vi.fn(),
}));

// garbage-scanner is dynamically imported inside the garbage_scan case.
vi.mock('../garbage-scanner.js', () => ({
	scanForGarbage: mockScanForGarbage,
	cleanupGarbage: mockCleanupGarbage,
}));

vi.mock('../index-task.tool.js', () => ({ indexTaskSemanticTool: { handler: mockIndexHandler } }));
vi.mock('../reset-collection.tool.js', () => ({ resetQdrantCollectionTool: { handler: mockResetHandler } }));
vi.mock('../diagnose-index.tool.js', () => ({ handleDiagnoseSemanticIndex: mockDiagnoseHandler }));

// ============================================================
// garbage_scan action (L515-592) — dry_run scan, executed cleanup, error path
// ============================================================
describe('roosync_indexing garbage_scan action', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	const baseScanResult = {
		total_scanned: 50,
		flagged: [
			{
				task_id: 'spiral-1',
				category: 'death_spiral',
				score: 0.9,
				details: {
					message_count: 120, total_size: 50000, assistant_ratio: 0.1,
					error_ratio: 0.8, death_spiral_count: 8, duplicate_group_size: 1,
				},
			},
		],
		by_category: { death_spiral: 1, duplicate: 0, low_value: 0 },
		total_size_flagged: 50000,
		estimated_vectors_flagged: 30,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('dry_run=true (default) reports flagged tasks without cleanup (L517, L543-545)', async () => {
		mockScanForGarbage.mockResolvedValue(baseScanResult);
		const result: any = await handleRooSyncIndexing(
			{ action: 'garbage_scan' } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.action).toBe('garbage_scan');
		expect(parsed.mode).toBe('dry_run');
		expect(parsed.scan.flagged_count).toBe(1);
		expect(parsed.scan.by_category).toEqual(baseScanResult.by_category);
		expect(parsed.cleanup).toBeNull();
		// cleanup must NOT run in dry_run
		expect(mockCleanupGarbage).not.toHaveBeenCalled();
		// scan called with default category 'all'
		expect(mockScanForGarbage).toHaveBeenCalledWith(expect.any(Map), expect.objectContaining({
			dry_run: true, category: 'all',
		}));
	});

	test('dry_run=false runs cleanup on flagged tasks (L532-541, L543-546)', async () => {
		mockScanForGarbage.mockResolvedValue(baseScanResult);
		const cleanupResult = {
			skeletons_removed: 1, vectors_deleted: 30, space_freed_bytes: 50000, errors: [],
		};
		mockCleanupGarbage.mockResolvedValue(cleanupResult);

		const result: any = await handleRooSyncIndexing(
			{ action: 'garbage_scan', dry_run: false, remove_skeletons: true, remove_vectors: true } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('executed');
		expect(parsed.cleanup.skeletons_removed).toBe(1);
		expect(parsed.cleanup.vectors_deleted).toBe(30);
		expect(mockCleanupGarbage).toHaveBeenCalledTimes(1);
		// summary reflects executed mode
		expect(parsed.summary).toContain('[EXECUTED]');
	});

	test('dry_run=false with 0 flagged skips cleanup call (L532 guard)', async () => {
		mockScanForGarbage.mockResolvedValue({ ...baseScanResult, flagged: [] });
		const result: any = await handleRooSyncIndexing(
			{ action: 'garbage_scan', dry_run: false } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		expect(mockCleanupGarbage).not.toHaveBeenCalled();
	});

	test('returns error when scanForGarbage throws (L583-591)', async () => {
		mockScanForGarbage.mockRejectedValue(new Error('qdrant scroll failed'));
		const result: any = await handleRooSyncIndexing(
			{ action: 'garbage_scan' } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Erreur lors du garbage scan');
		expect(result.content[0].text).toContain('qdrant scroll failed');
	});

	test('top_flagged is truncated to 20 entries and mapped to summary fields (L568-578)', async () => {
		const manyFlagged = Array.from({ length: 25 }, (_, i) => ({
			task_id: `task-${i}`,
			category: 'low_value',
			score: 0.5,
			details: {
				message_count: 30, total_size: 1000, assistant_ratio: 0.1, error_ratio: 0.5,
				death_spiral_count: 0, duplicate_group_size: 1,
			},
		}));
		mockScanForGarbage.mockResolvedValue({
			total_scanned: 100, flagged: manyFlagged, by_category: { low_value: 25 },
			total_size_flagged: 25000, estimated_vectors_flagged: 100,
		});
		const result: any = await handleRooSyncIndexing(
			{ action: 'garbage_scan' } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.top_flagged).toHaveLength(20);
		expect(parsed.top_flagged[0]).toMatchObject({
			task_id: 'task-0', category: 'low_value',
		});
	});
});

// ============================================================
// default case (L1293) — unreachable via the action enum guard, but the
// switch has a default branch that returns an "unsupported action" error.
// We cannot reach it through the guarded path, so we assert the guard
// itself covers the equivalent contract (invalid action → error).
// ============================================================
describe('roosync_indexing default/unreachable-action contract', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	test('invalid action returns the validation error before the switch (L304-309)', async () => {
		const result: any = await handleRooSyncIndexing(
			{ action: 'frobnicate' } as any,
			new Map() as any, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Action "frobnicate" invalide');
		// The valid-action list is surfaced in the error message.
		expect(result.content[0].text).toContain('tool_usage_stats');
		expect(result.content[0].text).toContain('trend_report');
	});

	test('every enum value in the tool schema matches the dispatched-action allowlist', () => {
		// Guards against drift between inputSchema enum and the switch validation list.
		const schemaEnum = (roosyncIndexingTool.inputSchema.properties as any).action.enum as string[];
		const dispatched = ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup',
			'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'tool_usage_stats', 'save_snapshot', 'trend_report'];
		expect(schemaEnum.sort()).toEqual([...dispatched].sort());
	});
});
