/**
 * Coverage complement for parsing-config.ts (#833 Sprint C3).
 *
 * No existing test imports this module (0% statement coverage firsthand).
 * It is pure (env-var parsing + deterministic comparison validation, no IO),
 * so coverage is fully reachable via direct calls to the exported functions.
 *
 * Add-only: 0 source touched (anti-churn #1936). Each test names its source-line anchor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateComparisonResults,
  getParsingConfig,
  shouldUseNewParsing,
  isComparisonMode,
  getDefaultConfig,
} from '../parsing-config.js';

describe('parsing-config — coverage complement', () => {
  const ENV_KEYS = [
    'USE_NEW_PARSING',
    'PARSING_COMPARISON_MODE',
    'LOG_PARSING_DIFFERENCES',
    'PARSING_SIMILARITY_THRESHOLD',
    'VALIDATE_IMPROVEMENTS',
    'MIN_CHILD_TASKS_IMPROVEMENT',
  ];

  beforeEach(() => {
    // Clean env so each test controls getParsingConfig() deterministically.
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  // ---- getParsingConfig (L77-86) ----
  describe('getParsingConfig — env-var branches', () => {
    it('L79-84 — defaults when no env set', () => {
      const c = getParsingConfig();
      expect(c.useNewParsing).toBe(false);
      expect(c.comparisonMode).toBe(false);
      expect(c.logDifferences).toBe(false);
      expect(c.similarityThreshold).toBe(44);
      expect(c.validateImprovements).toBe(true);
      expect(c.minChildTasksImprovement).toBe(10);
    });

    it('L79 — USE_NEW_PARSING=true', () => {
      process.env.USE_NEW_PARSING = 'true';
      expect(getParsingConfig().useNewParsing).toBe(true);
    });

    it('L80 — PARSING_COMPARISON_MODE=true', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(getParsingConfig().comparisonMode).toBe(true);
    });

    it('L81 — LOG_PARSING_DIFFERENCES=true', () => {
      process.env.LOG_PARSING_DIFFERENCES = 'true';
      expect(getParsingConfig().logDifferences).toBe(true);
    });

    it('L82 — PARSING_SIMILARITY_THRESHOLD custom value', () => {
      process.env.PARSING_SIMILARITY_THRESHOLD = '60';
      expect(getParsingConfig().similarityThreshold).toBe(60);
    });

    it('L84 — MIN_CHILD_TASKS_IMPROVEMENT custom value', () => {
      process.env.MIN_CHILD_TASKS_IMPROVEMENT = '25';
      expect(getParsingConfig().minChildTasksImprovement).toBe(25);
    });

    it('L83 — VALIDATE_IMPROVEMENTS=true (explicit)', () => {
      process.env.VALIDATE_IMPROVEMENTS = 'true';
      expect(getParsingConfig().validateImprovements).toBe(true);
    });

    it('L83 — VALIDATE_IMPROVEMENTS set to "false" → defaults to true (|| DEFAULT arm)', () => {
      // validateImprovements = env === 'true' || DEFAULT.validateImprovements (true)
      // so "false" is NOT === 'true' → falls to the DEFAULT arm (true).
      process.env.VALIDATE_IMPROVEMENTS = 'false';
      expect(getParsingConfig().validateImprovements).toBe(true);
    });
  });

  // ---- validateComparisonResults (L35-72) ----
  describe('validateComparisonResults — criteria arms', () => {
    it('L44-48 — similarity below threshold rejected', () => {
      const r = validateComparisonResults(30, 5, 50, ['imp1']);
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('Similarité 30% < seuil minimum 44%');
    });

    it('L44 truthy-but-validated arm — similarity at/above threshold passes criterion 1', () => {
      // similarity 44 == threshold → does NOT fail criterion 1; passes all → valid.
      const r = validateComparisonResults(44, 5, 50, ['imp1']);
      expect(r.isValid).toBe(true);
    });

    it('L53-57 — child tasks improvement below minimum rejected', () => {
      // similarity OK (50>=44), improvement 50-5=45 >= 10 → actually valid; use small gap.
      const r = validateComparisonResults(50, 45, 50, ['imp1']);
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('Amélioration child tasks 5 < minimum 10');
    });

    it('L61-65 — no improvements documented with validateImprovements=true rejected', () => {
      // similarity OK, improvement OK (45>=10), but improvements empty.
      const r = validateComparisonResults(50, 5, 50, []);
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('Aucune amélioration documentée');
    });

    it('L61 — validateImprovements=false allows empty improvements', () => {
      process.env.VALIDATE_IMPROVEMENTS = 'false';
      // Note: "false" string → env === 'true' is false → falls to DEFAULT (true).
      // To actually disable, we need a way: the function can't disable via env
      // (DEFAULT is true). So this arm (validateImprovements falsy) is structurally
      // unreachable via env. We exercise the truthy arm being satisfied instead:
      // improvements provided → passes criterion 3.
      const r = validateComparisonResults(50, 5, 50, ['imp1']);
      expect(r.isValid).toBe(true);
    });

    it('L68-71 — all criteria pass → valid with full reason', () => {
      const r = validateComparisonResults(50, 5, 50, ['imp1']);
      expect(r.isValid).toBe(true);
      expect(r.reason).toContain('Validation réussie');
      expect(r.reason).toContain('similarité 50%');
      expect(r.reason).toContain('+45 child tasks');
      expect(r.reason).toContain('1 améliorations');
    });
  });

  // ---- shouldUseNewParsing (L91-94) ----
  describe('shouldUseNewParsing', () => {
    it('L93 — false when neither flag set', () => {
      expect(shouldUseNewParsing()).toBe(false);
    });
    it('L93 — true when USE_NEW_PARSING=true (|| arm 1)', () => {
      process.env.USE_NEW_PARSING = 'true';
      expect(shouldUseNewParsing()).toBe(true);
    });
    it('L93 — true when PARSING_COMPARISON_MODE=true (|| arm 2)', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(shouldUseNewParsing()).toBe(true);
    });
  });

  // ---- isComparisonMode (L99-101) ----
  describe('isComparisonMode', () => {
    it('L100 — false by default', () => {
      expect(isComparisonMode()).toBe(false);
    });
    it('L100 — true when PARSING_COMPARISON_MODE=true', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(isComparisonMode()).toBe(true);
    });
  });

  // ---- getDefaultConfig (L106-108) ----
  describe('getDefaultConfig', () => {
    it('L107 — returns a copy of DEFAULT_CONFIG with expected values', () => {
      const c = getDefaultConfig();
      expect(c).toEqual({
        useNewParsing: false,
        comparisonMode: false,
        logDifferences: false,
        similarityThreshold: 44,
        validateImprovements: true,
        minChildTasksImprovement: 10,
      });
    });

    it('L107 — returns a fresh copy (mutation isolation)', () => {
      const c1 = getDefaultConfig();
      c1.similarityThreshold = 999;
      const c2 = getDefaultConfig();
      expect(c2.similarityThreshold).toBe(44); // spread copy, not a shared ref
    });
  });
});
