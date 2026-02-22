/**
 * Tests pour DifferenceDetector.ts
 * Issue #492 - Couverture de la détection de différences
 *
 * @module services/baseline/__tests__/DifferenceDetector
 */

import { describe, test, expect } from 'vitest';
import { DifferenceDetector } from '../DifferenceDetector.js';
import type { BaselineDifference, BaselineComparisonReport } from '../../../types/baseline.js';

describe('DifferenceDetector', () => {
	let detector: DifferenceDetector;

	function createDetector(): DifferenceDetector {
		return new DifferenceDetector();
	}

	function createDifference(overrides: Partial<BaselineDifference> = {}): BaselineDifference {
		return {
			category: 'config',
			severity: 'IMPORTANT',
			path: 'roo.settings',
			description: 'Settings differ',
			baselineValue: 'a',
			actualValue: 'b',
			...overrides
		} as BaselineDifference;
	}

	function createReport(differences: BaselineDifference[]): BaselineComparisonReport {
		return {
			baselineMachine: 'baseline-machine',
			targetMachine: 'target-machine',
			baselineVersion: '1.0.0',
			differences,
			summary: { total: differences.length, critical: 0, important: 0, warning: 0, info: 0 }
		} as BaselineComparisonReport;
	}

	// ============================================================
	// calculateSummary
	// ============================================================

	describe('calculateSummary', () => {
		test('returns zeros for empty array', () => {
			detector = createDetector();
			const summary = detector.calculateSummary([]);
			expect(summary.total).toBe(0);
			expect(summary.critical).toBe(0);
			expect(summary.important).toBe(0);
			expect(summary.warning).toBe(0);
			expect(summary.info).toBe(0);
		});

		test('counts differences by severity', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'CRITICAL' }),
				createDifference({ severity: 'CRITICAL' }),
				createDifference({ severity: 'IMPORTANT' }),
				createDifference({ severity: 'WARNING' }),
				createDifference({ severity: 'INFO' })
			];
			const summary = detector.calculateSummary(diffs);
			expect(summary.total).toBe(5);
			expect(summary.critical).toBe(2);
			expect(summary.important).toBe(1);
			expect(summary.warning).toBe(1);
			expect(summary.info).toBe(1);
		});

		test('handles all same severity', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'WARNING' }),
				createDifference({ severity: 'WARNING' }),
				createDifference({ severity: 'WARNING' })
			];
			const summary = detector.calculateSummary(diffs);
			expect(summary.total).toBe(3);
			expect(summary.warning).toBe(3);
			expect(summary.critical).toBe(0);
		});
	});

	// ============================================================
	// createSyncDecisions
	// ============================================================

	describe('createSyncDecisions', () => {
		test('creates decisions for differences above threshold', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'CRITICAL', category: 'config' }),
				createDifference({ severity: 'IMPORTANT', category: 'software' }),
				createDifference({ severity: 'INFO', category: 'system' })
			];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report, 'IMPORTANT');
			// CRITICAL (4) >= IMPORTANT (3) → yes
			// IMPORTANT (3) >= IMPORTANT (3) → yes
			// INFO (1) >= IMPORTANT (3) → no
			expect(decisions).toHaveLength(2);
		});

		test('includes all when threshold is INFO', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'INFO' }),
				createDifference({ severity: 'WARNING' }),
				createDifference({ severity: 'CRITICAL' })
			];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report, 'INFO');
			expect(decisions).toHaveLength(3);
		});

		test('only includes CRITICAL when threshold is CRITICAL', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'CRITICAL' }),
				createDifference({ severity: 'IMPORTANT' }),
				createDifference({ severity: 'WARNING' })
			];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report, 'CRITICAL');
			expect(decisions).toHaveLength(1);
			expect(decisions[0].severity).toBe('CRITICAL');
		});

		test('defaults to IMPORTANT threshold', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'IMPORTANT' }),
				createDifference({ severity: 'WARNING' })
			];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions).toHaveLength(1);
		});

		test('decision has correct structure', () => {
			detector = createDetector();
			const diffs = [
				createDifference({ severity: 'CRITICAL', category: 'config', path: 'test.path', description: 'Test diff' })
			];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions).toHaveLength(1);
			const d = decisions[0];
			expect(d.id).toContain('decision-');
			expect(d.machineId).toBe('target-machine');
			expect(d.differenceId).toBe('config-test.path');
			expect(d.description).toBe('Test diff');
			expect(d.status).toBe('pending');
			expect(d.createdAt).toBeDefined();
		});

		test('recommends sync_to_baseline for CRITICAL severity', () => {
			detector = createDetector();
			const diffs = [createDifference({ severity: 'CRITICAL', category: 'hardware' })];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions[0].action).toBe('sync_to_baseline');
		});

		test('recommends sync_to_baseline for config category', () => {
			detector = createDetector();
			const diffs = [createDifference({ severity: 'IMPORTANT', category: 'config' })];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions[0].action).toBe('sync_to_baseline');
		});

		test('recommends keep_target for hardware category', () => {
			detector = createDetector();
			const diffs = [createDifference({ severity: 'IMPORTANT', category: 'hardware' })];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions[0].action).toBe('keep_target');
		});

		test('recommends manual_review for software category', () => {
			detector = createDetector();
			const diffs = [createDifference({ severity: 'IMPORTANT', category: 'software' })];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report);
			expect(decisions[0].action).toBe('manual_review');
		});

		test('returns empty for no matching differences', () => {
			detector = createDetector();
			const diffs = [createDifference({ severity: 'INFO' })];
			const report = createReport(diffs);
			const decisions = detector.createSyncDecisions(report, 'CRITICAL');
			expect(decisions).toHaveLength(0);
		});
	});
});
