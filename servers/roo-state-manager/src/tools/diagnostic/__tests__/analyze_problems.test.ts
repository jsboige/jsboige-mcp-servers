/**
 * Tests pour analyze_problems.ts
 * Issue #492 - Couverture du diagnostic RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { analyzeRooSyncProblems } from '../analyze_problems.js';

// Mock fs/promises
const { mockReadFile, mockAccess, mockStat, mockMkdir, mockWriteFile, mockGetSharedStatePath } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockAccess: vi.fn(),
	mockStat: vi.fn(),
	mockMkdir: vi.fn(),
	mockWriteFile: vi.fn(),
	mockGetSharedStatePath: vi.fn(() => '/mock/shared-state'),
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
}));

describe('analyze_problems', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/mock/shared-state');
	});

	// ============================================================
	// Path detection
	// ============================================================

	describe('path detection', () => {
		test('returns error when shared state path not configured', async () => {
			mockGetSharedStatePath.mockImplementation(() => { throw new Error('not configured'); });
			const result = await analyzeRooSyncProblems({});
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(false);
			expect(data.error).toContain('introuvable');
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
			expect(mockReadFile).toHaveBeenCalledWith('/explicit/path.md', 'utf8');
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
		test('returns error result on fs exception', async () => {
			mockStat.mockRejectedValueOnce(new Error('ENOENT'));
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
