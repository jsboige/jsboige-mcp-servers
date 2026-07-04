/**
 * Coverage tests pour DifferenceDetector — branches froides / défensives
 *
 * Le base test (DifferenceDetector.test.ts) couvre les happy paths avec
 * sévérités/catégories canoniques (CRITICAL/IMPORTANT/WARNING/INFO ×
 * config/hardware/software/system). Ce fichier pince les branches que la
 * base n'atteint jamais :
 *
 * - calculateSummary : garde `in acc` (L24) pour sévérité non-canonique,
 *   quirk `total` double-comptage, normalisation toLowerCase (mixed/lowercase)
 * - isSeverityAtLeast : fallback `|| 0` (L76) pour severity ET threshold inconnus
 * - recommendAction : précédence CRITICAL-wins + catégorie undefined/empty
 * - createSyncDecisions : rename field actualValue→targetValue (L52),
 *   format exact differenceId (L47) + id (L45), passthrough description/category/severity
 * - error path : code COMPARISON_FAILED + message prefix + details=cause (L60-64),
 *   élément null dans le tableau de différences
 *
 * Inputs type-violating passent par `as any` — le runtime tolère ce que les types
 * TS interdisent (défense contre archives/baselines malformées).
 *
 * @module services/baseline/__tests__/DifferenceDetector.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect } from 'vitest';
import { DifferenceDetector } from '../DifferenceDetector.js';
import {
  BaselineServiceError,
  BaselineServiceErrorCode,
} from '../../../types/baseline.js';
import type {
  BaselineDifference,
  BaselineComparisonReport,
} from '../../../types/baseline.js';

// ─────────────────── helpers ───────────────────

function makeDiff(
  severity: BaselineDifference['severity'],
  category: BaselineDifference['category'] = 'config'
): BaselineDifference {
  return {
    severity,
    category,
    path: `${category}.${String(severity).toLowerCase()}.setting`,
    description: `Différence ${severity} dans ${category}`,
    baselineValue: 'baseline-val',
    actualValue: 'target-val',
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
    summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 },
    generatedAt: '2026-01-01T00:00:00Z',
  };
}

// ─────────────────── tests ───────────────────

describe('DifferenceDetector.coverage', () => {
  let detector: DifferenceDetector;
  // instancié inline ci-dessous pour lisibilité (un seul describe, pas de beforeEach nécessaire)

  // ============================================================
  // calculateSummary — garde `in acc` + normalisation toLowerCase
  // ============================================================
  describe('calculateSummary — garde `in acc` (L24) + toLowerCase (L23)', () => {
    test('sévérité non-canonique "FATAL" : total++ mais aucun bucket incrémenté', () => {
      detector = new DifferenceDetector();
      const diffs = [{ ...makeDiff('CRITICAL'), severity: 'FATAL' as any }];
      const summary = detector.calculateSummary(diffs);
      // total incrémenté inconditionnellement (L22)
      expect(summary.total).toBe(1);
      // 'fatal' not in acc → garde L24 false → aucun bucket
      expect(summary.critical).toBe(0);
      expect(summary.important).toBe(0);
      expect(summary.warning).toBe(0);
      expect(summary.info).toBe(0);
    });

    test('sévérité vide "" : skipped par le garde, total++ quand même', () => {
      detector = new DifferenceDetector();
      const diffs = [{ ...makeDiff('INFO'), severity: '' as any }];
      const summary = detector.calculateSummary(diffs);
      expect(summary.total).toBe(1);
      expect(summary.info).toBe(0);
    });

    test('quirk : sévérité "TOTAL" → "total" in acc → total double-compté', () => {
      // Le garde `severity in acc` (L24) vérifie l'appartenance au objet acc,
      // PAS un whitelist de buckets de sévérité. Or acc possède une clé `total`
      // → 'total' passe le garde → acc['total']++ (L25) s'ajoute au total++ (L22).
      detector = new DifferenceDetector();
      const diffs = [{ ...makeDiff('CRITICAL'), severity: 'TOTAL' as any }];
      const summary = detector.calculateSummary(diffs);
      expect(summary.total).toBe(2); // L22 + L25
    });

    test('toLowerCase normalise le mixed-case "Critical" → bucket critical', () => {
      detector = new DifferenceDetector();
      const diffs = [{ ...makeDiff('CRITICAL'), severity: 'Critical' as any }];
      const summary = detector.calculateSummary(diffs);
      expect(summary.critical).toBe(1);
      expect(summary.total).toBe(1);
    });

    test('toLowerCase idempotent sur lowercase "critical" → bucket critical', () => {
      detector = new DifferenceDetector();
      const diffs = [{ ...makeDiff('CRITICAL'), severity: 'critical' as any }];
      const summary = detector.calculateSummary(diffs);
      expect(summary.critical).toBe(1);
    });

    test('mix canoniques + non-canoniques : seuls les canoniques entrent dans les buckets', () => {
      detector = new DifferenceDetector();
      const diffs = [
        makeDiff('CRITICAL'),
        { ...makeDiff('IMPORTANT'), severity: 'FATAL' as any },
        { ...makeDiff('WARNING'), severity: '' as any },
        makeDiff('INFO'),
      ];
      const summary = detector.calculateSummary(diffs);
      expect(summary.total).toBe(4); // tous comptés
      expect(summary.critical).toBe(1);
      expect(summary.important).toBe(0); // 'fatal' rejeté
      expect(summary.warning).toBe(0); // '' rejeté
      expect(summary.info).toBe(1);
    });
  });

  // ============================================================
  // isSeverityAtLeast — fallback `|| 0` (L76)
  // ============================================================
  describe('isSeverityAtLeast — fallback `|| 0` pour severity/threshold inconnus (L76)', () => {
    test('severity inconnue "FATAL" + threshold INFO → filtrée (0 >= 1 = false)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([
        { ...makeDiff('CRITICAL'), severity: 'FATAL' as any },
      ]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      // levels['FATAL'] || 0 = 0 ; levels['INFO'] = 1 ; 0 >= 1 → false → rejetée
      expect(decisions).toHaveLength(0);
    });

    test('severity inconnue "FATAL" + threshold inconnu "BOGUS" → INCLUSE (0 >= 0)', () => {
      // Pin que `|| 0` est load-bearing : sans lui, undefined >= undefined = false
      // (la diff serait rejetée). Avec `|| 0`, 0 >= 0 = true → incluse.
      detector = new DifferenceDetector();
      const report = makeReport([
        { ...makeDiff('CRITICAL'), severity: 'FATAL' as any },
      ]);
      const decisions = detector.createSyncDecisions(report, 'BOGUS' as any);
      expect(decisions).toHaveLength(1);
    });

    test('threshold inconnu "BOGUS" → admet TOUTES les sévérités canoniques (threshold→0)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([
        makeDiff('CRITICAL'),
        makeDiff('IMPORTANT'),
        makeDiff('WARNING'),
        makeDiff('INFO'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'BOGUS' as any);
      // Chaque niveau (4,3,2,1) >= 0 → toutes admises
      expect(decisions).toHaveLength(4);
    });

    test('threshold vide "" → admet tout (|| 0 → 0)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('INFO'), makeDiff('WARNING')]);
      const decisions = detector.createSyncDecisions(report, '' as any);
      expect(decisions).toHaveLength(2);
    });

    test('égalité stricte severity == threshold → incluse (>= boundary)', () => {
      // INFO(1) >= INFO(1) → true. La base teste CRITICAL==CRITICAL ; pin INFO==INFO.
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('INFO'), makeDiff('WARNING')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions).toHaveLength(2); // INFO + WARNING admis au seuil INFO
      // (WARNING=2 >= INFO=1 aussi)
    });
  });

  // ============================================================
  // recommendAction — précédence CRITICAL + catégorie défensive
  // ============================================================
  describe('recommendAction — précédence CRITICAL-wins + catégorie undefined/empty', () => {
    test('CRITICAL + config → sync_to_baseline (branche severity L85 avant category L86)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('CRITICAL', 'config')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('sync_to_baseline');
    });

    test('CRITICAL + software → sync_to_baseline (severity gagne sur manual_review)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('CRITICAL', 'software')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      // software non-CRITICAL → manual_review ; mais CRITICAL court-circuite → sync
      expect(decisions[0].action).toBe('sync_to_baseline');
    });

    test('CRITICAL + system → sync_to_baseline', () => {
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('CRITICAL', 'system')]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('sync_to_baseline');
    });

    test('catégorie undefined + IMPORTANT → manual_review (défense runtime)', () => {
      detector = new DifferenceDetector();
      const diff = { ...makeDiff('IMPORTANT'), category: undefined as any };
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      // undefined !== 'config' && !== 'hardware' → manual_review
      expect(decisions[0].action).toBe('manual_review');
    });

    test('catégorie vide "" + WARNING → manual_review', () => {
      detector = new DifferenceDetector();
      const diff = { ...makeDiff('WARNING'), category: '' as any };
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].action).toBe('manual_review');
    });
  });

  // ============================================================
  // createSyncDecisions — shape : rename, formats, passthrough
  // ============================================================
  describe('createSyncDecisions — shape (rename L52, formats L45/L47, passthrough)', () => {
    test('targetValue === diff.actualValue (rename du champ L52)', () => {
      // Pin le rename : diff.actualValue → decision.targetValue (noms différents).
      // Si uniformisé à tort en actualValue des deux côtés, la cible serait perdue.
      detector = new DifferenceDetector();
      const diff = makeDiff('CRITICAL');
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].targetValue).toBe(diff.actualValue);
      expect((decisions[0] as any).actualValue).toBeUndefined();
    });

    test('baselineValue === diff.baselineValue (même nom, passthrough L51)', () => {
      detector = new DifferenceDetector();
      const diff = makeDiff('CRITICAL');
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].baselineValue).toBe(diff.baselineValue);
    });

    test('differenceId format exact `${category}-${path}` (L47)', () => {
      detector = new DifferenceDetector();
      const diff = makeDiff('CRITICAL', 'config'); // path = 'config.critical.setting'
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].differenceId).toBe('config-config.critical.setting');
    });

    test('id format `decision-<timestamp>-<index>` avec index par position (L45)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([
        makeDiff('CRITICAL'),
        makeDiff('IMPORTANT'),
        makeDiff('WARNING'),
      ]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      decisions.forEach((d, i) => {
        expect(d.id).toMatch(/^decision-\d+-\d+$/);
        expect(d.id.endsWith(`-${i}`)).toBe(true);
      });
    });

    test('description / category / severity passthrough (L48/L49/L53)', () => {
      detector = new DifferenceDetector();
      const diff = makeDiff('WARNING', 'hardware');
      const report = makeReport([diff]);
      const decisions = detector.createSyncDecisions(report, 'INFO');
      expect(decisions[0].description).toBe(diff.description);
      expect(decisions[0].category).toBe(diff.category);
      expect(decisions[0].severity).toBe(diff.severity);
    });
  });

  // ============================================================
  // error path — code/message/details/cause (L60-64)
  // ============================================================
  describe('createSyncDecisions — error path (L59-65)', () => {
    test('code === COMPARISON_FAILED', () => {
      detector = new DifferenceDetector();
      const report = makeReport([]);
      (report as any).differences = null;
      try {
        detector.createSyncDecisions(report, 'INFO');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BaselineServiceError);
        expect((err as BaselineServiceError).code).toBe(
          BaselineServiceErrorCode.COMPARISON_FAILED
        );
      }
    });

    test('message préfixé "Erreur création décisions:" + contient le message original', () => {
      detector = new DifferenceDetector();
      const report = makeReport([]);
      (report as any).differences = null;
      try {
        detector.createSyncDecisions(report, 'INFO');
        throw new Error('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('Erreur création décisions:');
        // Le message original (TypeError "Cannot read properties of null...")
        // contient généralement "null" — on vérifie juste la présence d'un suffixe
        expect(msg.length).toBeGreaterThan('Erreur création décisions:'.length);
      }
    });

    test('details === erreur originale (cause passée en 3e arg L64)', () => {
      detector = new DifferenceDetector();
      const report = makeReport([]);
      (report as any).differences = null;
      try {
        detector.createSyncDecisions(report, 'INFO');
        throw new Error('should have thrown');
      } catch (err) {
        const cause = (err as BaselineServiceError).details;
        // details = l'erreur originale interceptée (TypeError sur null.filter)
        expect(cause).toBeInstanceOf(Error);
      }
    });

    test('élément null dans le tableau de différences → BaselineServiceError', () => {
      // Contrairement à la base (qui nulle tout le tableau), un élément null
      // déclenche le catch via filter (null.severity → TypeError).
      detector = new DifferenceDetector();
      const report = makeReport([makeDiff('CRITICAL'), null as any]);
      expect(() => detector.createSyncDecisions(report, 'INFO')).toThrow(
        BaselineServiceError
      );
    });
  });
});
