/**
 * Tests pour analyze_problems.ts
 * Issue #492 - Couverture du diagnostic RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { analyzeRooSyncProblems } from '../analyze_problems.js';

// Mock fs/promises
const { mockReadFile, mockAccess, mockStat, mockMkdir, mockWriteFile, mockGetSharedStatePath, mockTryGetSharedStatePath } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockAccess: vi.fn(),
	mockStat: vi.fn(),
	mockMkdir: vi.fn(),
	mockWriteFile: vi.fn(),
	mockGetSharedStatePath: vi.fn(() => '/mock/shared-state'),
	mockTryGetSharedStatePath: vi.fn(() => '/mock/shared-state'),
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: mockReadFile,
		access: mockAccess,
		stat: mockStat,
		mkdir: mockMkdir,
		writeFile: mockWriteFile,
	},
	readFile: mockReadFile,
	access: mockAccess,
	stat: mockStat,
	mkdir: mockMkdir,
	writeFile: mockWriteFile,
}));

vi.mock('../../../utils/shared-state-path.js', () => ({
	getSharedStatePath: mockGetSharedStatePath,
	tryGetSharedStatePath: mockTryGetSharedStatePath,
	ensureStoreSubdir: vi.fn(),
	assertSharedStoreAccessible: () => {},
}));

describe('analyze_problems', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/mock/shared-state');
		mockTryGetSharedStatePath.mockReturnValue('/mock/shared-state');
	});

	// ============================================================
	// Path detection (#2307)
	// ============================================================

	describe('path detection', () => {
		test('unresolvable shared path says NO_SHARED_STATE_PATH, not "introuvable" (#2307)', async () => {
			// The old message claimed the FILE was missing ("introuvable") when in
			// fact no shared state path was configured — the file was never looked
			// for. Measured live on po-2025: misleading hunt for a missing file.
			mockGetSharedStatePath.mockImplementation(() => { throw new Error('not configured'); });
			const result = await analyzeRooSyncProblems({});
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(false);
			expect(data.code).toBe('NO_SHARED_STATE_PATH');
			expect(data.error).toContain('état partagé');
			expect(data.error).toContain('roadmapPath');
			expect(data.error).not.toContain('introuvable');
		});

		test('uses getSharedStatePath for auto-detection (#2307 Phase 4)', async () => {
			mockStat.mockResolvedValueOnce({ size: 100 });
			mockReadFile.mockResolvedValueOnce('');
			await analyzeRooSyncProblems({});
			expect(mockStat).toHaveBeenCalledWith(expect.stringContaining('shared-state'));
		});

		test('explicit roadmapPath overrides auto-detection', async () => {
			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce('');
			await analyzeRooSyncProblems({ roadmapPath: '/explicit/path.md' });
			expect(mockReadFile).toHaveBeenCalledWith(path.resolve('/explicit/path.md'), 'utf8');
		});

		test('relative roadmapPath is read AND reported as absolute (#2307)', async () => {
			// fs resolves relatives against the server cwd silently; the analysis
			// must echo the absolute path that was actually read, not the relative
			// string the caller passed.
			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce('');
			const result = await analyzeRooSyncProblems({ roadmapPath: 'nested/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.filePath).toBe(path.resolve('nested/roadmap.md'));
			expect(path.isAbsolute(data.filePath)).toBe(true);
		});

		test('auto-detected ENOENT names the exact path tried (#2307)', async () => {
			mockStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
			const result = await analyzeRooSyncProblems({});
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(false);
			expect(data.code).toBe('ROADMAP_NOT_FOUND');
			expect(data.error).toContain('sync-roadmap.md');
			expect(data.error).toContain('auto-détecté');
		});

		test('explicit-path ENOENT names the path too (no raw stack)', async () => {
			mockStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
			const result = await analyzeRooSyncProblems({ roadmapPath: '/gone/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(false);
			expect(data.error).toContain(path.resolve('/gone/roadmap.md'));
		});
	});

	// ============================================================
	// Decision block parsing
	// ============================================================

	describe('decision block parsing', () => {
		const validContent = [
			'<!-- DECISION_BLOCK_START -->',
			'**ID:** `DEC-001`',
			'**Statut:** pending',
			'**Titre:** Test decision',
			'<!-- DECISION_BLOCK_END -->',
			'',
			'<!-- DECISION_BLOCK_START -->',
			'**ID:** `DEC-002`',
			'**Statut:** approved',
			'**Approuvé le:** 2026-02-20',
			'<!-- DECISION_BLOCK_END -->',
		].join('\n');

		test('counts total decisions', async () => {
			mockStat.mockResolvedValueOnce({ size: 500 });
			mockReadFile.mockResolvedValueOnce(validContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.totalDecisions).toBe(2);
		});

		test('counts pending decisions', async () => {
			mockStat.mockResolvedValueOnce({ size: 500 });
			mockReadFile.mockResolvedValueOnce(validContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.pendingDecisions).toBe(1);
		});

		test('counts approved decisions', async () => {
			mockStat.mockResolvedValueOnce({ size: 500 });
			mockReadFile.mockResolvedValueOnce(validContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.approvedDecisions).toBe(1);
		});
	});

	// ============================================================
	// Issue detection
	// ============================================================

	describe('issue detection', () => {
		test('detects duplicate IDs', async () => {
			const dupeContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-DUPE`',
				'**Statut:** pending',
				'<!-- DECISION_BLOCK_END -->',
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-DUPE`',
				'**Statut:** approved',
				'**Approuvé le:** 2026-02-20',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			mockStat.mockResolvedValueOnce({ size: 300 });
			mockReadFile.mockResolvedValueOnce(dupeContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.duplicateIds).toContain('DEC-DUPE');
			expect(data.issues.some((i: any) => i.type === 'DUPLICATE_DECISIONS')).toBe(true);
		});

		test('detects corrupted hardware (zero value)', async () => {
			const zeroContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-HW1`',
				'**Statut:** pending',
				'**Valeur Source:** 0',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce(zeroContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.corruptedHardware.length).toBeGreaterThan(0);
			expect(data.issues.some((i: any) => i.type === 'CORRUPTED_HARDWARE_DATA')).toBe(true);
		});

		test('detects corrupted hardware (Unknown value)', async () => {
			const unknownContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-HW2`',
				'**Statut:** pending',
				'**Valeur Source:** "Unknown"',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce(unknownContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.corruptedHardware.length).toBeGreaterThan(0);
		});

		test('detects status inconsistencies (approved without metadata)', async () => {
			const inconsistentContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-INC`',
				'**Statut:** approved',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce(inconsistentContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.statusInconsistencies.length).toBeGreaterThan(0);
			expect(data.issues.some((i: any) => i.type === 'STATUS_INCONSISTENCIES')).toBe(true);
		});

		test('reports no issues for clean content', async () => {
			const cleanContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-CLEAN`',
				'**Statut:** approved',
				'**Approuvé le:** 2026-02-20',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce(cleanContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.issues.length).toBe(0);
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('returns error result on non-ENOENT fs exception', async () => {
			// Non-ENOENT only: ENOENT is now routed to the friendly
			// ROADMAP_NOT_FOUND branch, so this generic-exception test must use
			// a different error class (EACCES) to exercise the raw-error path.
			mockStat.mockRejectedValueOnce(new Error('EACCES: permission denied'));
			const result = await analyzeRooSyncProblems({ roadmapPath: '/broken/path.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(false);
			expect(data.error).toBeDefined();
			expect(result.isError).toBe(true);
		});

		test('handles empty content', async () => {
			mockStat.mockResolvedValueOnce({ size: 0 });
			mockReadFile.mockResolvedValueOnce('');
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/empty.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.totalDecisions).toBe(0);
			// A genuinely empty roadmap is legitimate (fresh install) — no mismatch flag
			expect(data.issues.length).toBe(0);
		});
	});

	// ============================================================
	// Dialect honesty (#2307): the live roadmap uses BaselineService's
	// `## <emoji> Décision` sections, which the DECISION_BLOCK parser
	// cannot see. Measured live: 142 KB roadmap, 311 sections,
	// 0 markers → totalDecisions: 0 reported as a clean success.
	// ============================================================

	describe('dialect honesty (#2307)', () => {
		const emojiDialectContent = [
			'# Sync Roadmap',
			'',
			'## ⏳ Décision decision-1777305081301-0',
			'**Machine:** target-machine',
			'**Statut:** pending',
			'',
			'---',
			'',
			'## ✅ Décision decision-1777325301570-0',
			'**Machine:** target-machine',
			'**Statut:** approved',
		].join('\n');

		test('flags FORMAT_MISMATCH instead of a clean zero on emoji-dialect content', async () => {
			mockStat.mockResolvedValueOnce({ size: 500 });
			mockReadFile.mockResolvedValueOnce(emojiDialectContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.totalDecisions).toBe(0); // still unparseable — the flag is the honesty
			const mismatch = data.issues.find((i: any) => i.type === 'FORMAT_MISMATCH');
			expect(mismatch).toBeDefined();
			expect(mismatch.severity).toBe('HIGH');
			expect(mismatch.count).toBe(2); // both emoji sections counted
		});

		test('no FORMAT_MISMATCH when DECISION_BLOCK content parses normally', async () => {
			const blockContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-001`',
				'**Statut:** pending',
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');
			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce(blockContent);
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.totalDecisions).toBe(1);
			expect(data.issues.some((i: any) => i.type === 'FORMAT_MISMATCH')).toBe(false);
		});

		test('no FORMAT_MISMATCH on unrelated markdown (no decision sections at all)', async () => {
			mockStat.mockResolvedValueOnce({ size: 300 });
			mockReadFile.mockResolvedValueOnce('# Notes\n\nSome prose without decisions.\n');
			const result = await analyzeRooSyncProblems({ roadmapPath: '/test/notes.md' });
			const data = JSON.parse(result.content[0].text);
			expect(data.issues.length).toBe(0);
		});

		test('generateReport with explicit path works without shared state configured (#2307)', async () => {
			// Old behavior: the report branch called getSharedStatePath() directly —
			// with an explicit roadmapPath and no shared state, the whole call failed
			// AFTER the analysis succeeded. Now the report lands beside the file.
			mockGetSharedStatePath.mockImplementation(() => { throw new Error('not configured'); });
			mockTryGetSharedStatePath.mockReturnValue(null);
			mockStat.mockResolvedValueOnce({ size: 200 });
			mockReadFile.mockResolvedValueOnce('');
			const result = await analyzeRooSyncProblems({ roadmapPath: '/x/roadmap.md', generateReport: true });
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.reportGenerated).toContain(path.resolve('/x/roadmap.md', '..'));
			expect(mockWriteFile).toHaveBeenCalled();
		});
	});

		// ============================================================
		// Stale decision cleanup
		// ============================================================

		describe('stale decision cleanup', () => {
			// Dates are computed relative to "now" so the fixtures never drift across
			// the STALE_THRESHOLD_DAYS (30j) boundary on a given calendar day.
			const daysAgo = (n: number) =>
				new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
			const staleContent = [
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-STALE-1`',
				'**Statut:** pending',
				`**Créé:** ${daysAgo(180)}`,
				'<!-- DECISION_BLOCK_END -->',
				'',
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-FRESH`',
				'**Statut:** pending',
				`**Créé:** ${daysAgo(5)}`,
				'<!-- DECISION_BLOCK_END -->',
				'',
				'<!-- DECISION_BLOCK_START -->',
				'**ID:** `DEC-STALE-2`',
				'**Statut:** pending',
				`**Créé:** ${daysAgo(200)}`,
				'<!-- DECISION_BLOCK_END -->',
			].join('\n');

			test('detects stale pending decisions', async () => {
				mockStat.mockResolvedValueOnce({ size: 500 });
				mockReadFile.mockResolvedValueOnce(staleContent);
				const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
				const data = JSON.parse(result.content[0].text);
				expect(data.staleDecisions).toBe(2);
				expect(data.staleDecisionDetails.map((d) => d.decisionId)).toContain('DEC-STALE-1');
				expect(data.staleDecisionDetails.map((d) => d.decisionId)).toContain('DEC-STALE-2');
			});

			test('cleanupStale removes stale decisions from roadmap', async () => {
				mockStat.mockResolvedValueOnce({ size: 500 });
				mockReadFile.mockResolvedValueOnce(staleContent);
				const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md', cleanupStale: true });
				const data = JSON.parse(result.content[0].text);
				expect(data.success).toBe(true);
				expect(data.cleanupResult.cleanedUp).toBe(2);
				expect(data.cleanupResult.cleanedDecisions).toContain('DEC-STALE-1');
				expect(data.cleanupResult.cleanedDecisions).toContain('DEC-STALE-2');
				expect(mockWriteFile).toHaveBeenCalledTimes(1);
				const writtenContent = mockWriteFile.mock.calls[0][1];
				expect(writtenContent).toContain('DEC-FRESH');
				expect(writtenContent).not.toContain('DEC-STALE-1');
				expect(writtenContent).not.toContain('DEC-STALE-2');
			});

			test('cleanupStale with no stale decisions does not write file', async () => {
				const freshContent = [
					'<!-- DECISION_BLOCK_START -->',
					'**ID:** `DEC-FRESH`',
					'**Statut:** pending',
					`**Créé:** ${daysAgo(5)}`,
					'<!-- DECISION_BLOCK_END -->',
				].join('\n');
				mockStat.mockResolvedValueOnce({ size: 200 });
				mockReadFile.mockResolvedValueOnce(freshContent);
				const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md', cleanupStale: true });
				const data = JSON.parse(result.content[0].text);
				expect(data.cleanupResult.cleanedUp).toBe(0);
				expect(mockWriteFile).not.toHaveBeenCalled();
			});

			test('cleanupResult is undefined when cleanupStale is not set', async () => {
				mockStat.mockResolvedValueOnce({ size: 500 });
				mockReadFile.mockResolvedValueOnce(staleContent);
				const result = await analyzeRooSyncProblems({ roadmapPath: '/test/roadmap.md' });
				const data = JSON.parse(result.content[0].text);
				expect(data.cleanupResult).toBeUndefined();
			});
		});

});
