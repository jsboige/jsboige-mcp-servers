/**
 * Tests unitaires pour DifferenceDetector
 *
 * Couvre :
 * - calculateSummary : comptage total + par sévérité
 * - createSyncDecisions : filtrage par seuil, structure résultat
 * - recommendAction (via createSyncDecisions) : CRITICAL, config, hardware, autre
 * - isSeverityAtLeast (via createSyncDecisions) : niveaux hiérarchiques
 * - createSyncDecisions : erreur interne → BaselineServiceError
 *
 * @module services/baseline/__tests__/DifferenceDetector.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { DifferenceDetector } from '../DifferenceDetector.js';
import { BaselineServiceError } from '../../../types/baseline.js';
import type { BaselineDifference, BaselineComparisonReport } from '../../../types/baseline.js';

// ─────────────────── helpers ───────────────────

function makeDiff(
  severity: BaselineDifference['severity'],
  category: BaselineDifference['category'] = 'config'
): BaselineDifference {
  return {
    severity,
    category,
    path: `${category}.${severity.toLowerCase()}.setting`,
    description: `Différence ${severity} dans ${category}`,
    baselineValue: 'baseline',
    actualValue: 'target',
    recommendedAction: 'sync_to_baseline',
  };
}

function makeReport(
  differences: BaselineDifference[],
  targetMachine = 'target-machine'
): BaselineComparisonReport {
  return {
    baselineMachine: 'baseline-machine',
    targetMachine,
    baselineVersion: '1.0.0',
    differences,
    summary: {
      total: differences.length,
      critical: differences.filter(d => d.severity === 'CRITICAL').length,
      important: differences.filter(d => d.severity === 'IMPORTANT').length,
      warning: differences.filter(d => d.severity === 'WARNING').length,
      info: differences.filter(d => d.severity === 'INFO').length,
    },
    generatedAt: '2026-01-01T00:00:00Z',
  };
}

// ─────────────────── setup ───────────────────

let detector: DifferenceDetector;

beforeEach(() => {
  detector = new DifferenceDetector();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─────────────────── tests ───────────────────

describe('DifferenceDetector', () => {

  // ============================================================
  // calculateSummary
  // ============================================================

  describe('calculateSummary', () => {
    test('retourne un total de 0 pour un tableau vide', () => {
      const summary = detector.calculateSummary([]);
      expect(summary.total).toBe(0);
      expect(summary.critical).toBe(0);
      expect(summary.important).toBe(0);
      expect(summary.warning).toBe(0);
      expect(summary.info).toBe(0);
    });

    test('compte correctement le total', () => {
      const diffs = [makeDiff('CRITICAL'), makeDiff('INFO'), makeDiff('WARNING')];
      const summary = detector.calculateSummary(diffs);
      expect(summary.total).toBe(3);
    });

    test('compte correctement les CRITICAL', () => {
      const diffs = [makeDiff('CRITICAL'), makeDiff('CRITICAL'), makeDiff('INFO')];
      const summary = detector.calculateSummary(diffs);
      expect(summary.critical).toBe(2);
      expect(summary.info).toBe(1);
    });

    test('compte correctement les IMPORTANT', () => {
      const diffs = [makeDiff('IMPORTANT'), makeDiff('IMPORTANT')];
      const summary = detector.calculateSummary(diffs);
      expect(summary.important).toBe(2);
      expect(summary.total).toBe(2);
    });

    test('compte correctement les WARNING', () => {
      const diffs = [makeDiff('WARNING'), makeDiff('WARNING'), makeDiff('WARNING')];
      const summary = detector.calculateSummary(diffs);
      expect(summary.warning).toBe(3);
    });

    test('compte toutes les sévérités simultanément', () => {
      const diffs = [
        makeDiff('CRITICAL'), makeDiff('CRITICAL'),
        makeDiff('IMPORTANT'),
        makeDiff('WARNING'),
        makeDiff('INFO'), makeDiff('INFO'),
      ];
      const summary = detector.calculateSummary(diffs);
      expect(summary.total).toBe(6);
      expect(summary.critical).toBe(2);
      expect(summary.important).toBe(1);
      expect(summary.warning).toBe(1);
      expect(summary.info).toBe(2);
    });
  });

  // ============================================================
  // createSyncDecisions - filtrage par seuil
  // ============================================================

  describe('createSyncDecisions - filtrage par seuil', () => {
    test('retourne toutes les décisions si seuil = INFO', () => {
      const report = makeReport([
        makeDiff('CRITICAL'), makeDiff('IMPORTANT'), makeDiff('WARNING'), makeDiff('INFO'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions).toHaveLength(4);
    });

    test('filtre correctement pour seuil IMPORTANT', () => {
      const report = makeReport([
        makeDiff('CRITICAL'), makeDiff('IMPORTANT'), makeDiff('WARNING'), makeDiff('INFO'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'IMPORTANT');
      expect(decisions).toHaveLength(2); // CRITICAL + IMPORTANT
    });

    test('filtre correctement pour seuil WARNING', () => {
      const report = makeReport([
        makeDiff('CRITICAL'), makeDiff('IMPORTANT'), makeDiff('WARNING'), makeDiff('INFO'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'WARNING');
      expect(decisions).toHaveLength(3); // CRITICAL + IMPORTANT + WARNING
    });

    test('ne retourne que les CRITICAL si seuil CRITICAL', () => {
      const report = makeReport([
        makeDiff('CRITICAL'), makeDiff('IMPORTANT'), makeDiff('WARNING'), makeDiff('INFO'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'CRITICAL');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].severity).toBe('CRITICAL');
    });

    test('retourne un tableau vide si aucune diff ne dépasse le seuil', () => {
      const report = makeReport([makeDiff('INFO'), makeDiff('WARNING')]);
      const decisions = detector.createSyncDecisions(report, 'CRITICAL');
      expect(decisions).toHaveLength(0);
    });

    test('seuil IMPORTANT par défaut', () => {
      const report = makeReport([
        makeDiff('CRITICAL'), makeDiff('IMPORTANT'), makeDiff('WARNING'),
      ]);
      const decisions = detector.createSyncDecisions(report); // par défaut IMPORTANT
      expect(decisions).toHaveLength(2);
    });
  });

  // ============================================================
  // createSyncDecisions - structure résultat
  // ============================================================

  describe('createSyncDecisions - structure résultat', () => {
    test('chaque décision a un ID unique', () => {
      const report = makeReport([makeDiff('CRITICAL'), makeDiff('IMPORTANT')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      const ids = decisions.map(d => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test('machineId correspond à targetMachine du rapport', () => {
      const report = makeReport([makeDiff('CRITICAL')], 'my-target-machine');
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].machineId).toBe('my-target-machine');
    });

    test('status est toujours "pending"', () => {
      const report = makeReport([makeDiff('CRITICAL'), makeDiff('INFO')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      decisions.forEach(d => expect(d.status).toBe('pending'));
    });

    test('createdAt est une date ISO', () => {
      const report = makeReport([makeDiff('CRITICAL')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('differenceId contient la catégorie et le chemin', () => {
      const diff = makeDiff('CRITICAL', 'config');
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].differenceId).toContain('config');
    });
  });

  // ============================================================
  // recommendAction (via createSyncDecisions)
  // ============================================================

  describe('recommendAction (via createSyncDecisions)', () => {
    test('CRITICAL → action sync_to_baseline', () => {
      const report = makeReport([makeDiff('CRITICAL', 'hardware')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('sync_to_baseline');
    });

    test('catégorie config (non-CRITICAL) → action sync_to_baseline', () => {
      const report = makeReport([makeDiff('IMPORTANT', 'config')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('sync_to_baseline');
    });

    test('catégorie hardware (non-CRITICAL) → action keep_target', () => {
      const report = makeReport([makeDiff('IMPORTANT', 'hardware')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('keep_target');
    });

    test('catégorie software (non-CRITICAL) → action manual_review', () => {
      const report = makeReport([makeDiff('IMPORTANT', 'software')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('manual_review');
    });

    test('catégorie system (non-CRITICAL) → action manual_review', () => {
      const report = makeReport([makeDiff('WARNING', 'system')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('manual_review');
    });
  });

  // ============================================================
  // Erreur interne
  // ============================================================

  describe('createSyncDecisions - erreur interne', () => {
    test('lève BaselineServiceError si report.differences est null', () => {
      const report = makeReport([]);
      (report as any).differences = null;
      expect(() => detector.createSyncDecisions(report, 'INFO')).toThrow(BaselineServiceError);
    });
  });
});
