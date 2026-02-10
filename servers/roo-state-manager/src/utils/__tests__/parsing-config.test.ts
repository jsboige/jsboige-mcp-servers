/**
 * Tests unitaires pour parsing-config
 *
 * Couvre :
 * - getDefaultConfig : valeurs par défaut
 * - getParsingConfig : lecture env vars
 * - validateComparisonResults : 3 critères de validation
 * - shouldUseNewParsing : flag parsing
 * - isComparisonMode : flag comparaison
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDefaultConfig,
  getParsingConfig,
  validateComparisonResults,
  shouldUseNewParsing,
  isComparisonMode,
} from '../parsing-config.js';

describe('parsing-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear relevant env vars
    delete process.env.USE_NEW_PARSING;
    delete process.env.PARSING_COMPARISON_MODE;
    delete process.env.LOG_PARSING_DIFFERENCES;
    delete process.env.PARSING_SIMILARITY_THRESHOLD;
    delete process.env.VALIDATE_IMPROVEMENTS;
    delete process.env.MIN_CHILD_TASKS_IMPROVEMENT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // === getDefaultConfig ===

  describe('getDefaultConfig', () => {
    it('should return default config values', () => {
      const config = getDefaultConfig();
      expect(config.useNewParsing).toBe(false);
      expect(config.comparisonMode).toBe(false);
      expect(config.logDifferences).toBe(false);
      expect(config.similarityThreshold).toBe(44);
      expect(config.validateImprovements).toBe(true);
      expect(config.minChildTasksImprovement).toBe(10);
    });

    it('should return a copy (not the same reference)', () => {
      const config1 = getDefaultConfig();
      const config2 = getDefaultConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  // === getParsingConfig ===

  describe('getParsingConfig', () => {
    it('should use default values when no env vars set', () => {
      const config = getParsingConfig();
      expect(config.useNewParsing).toBe(false);
      expect(config.comparisonMode).toBe(false);
      expect(config.logDifferences).toBe(false);
    });

    it('should read USE_NEW_PARSING env var', () => {
      process.env.USE_NEW_PARSING = 'true';
      const config = getParsingConfig();
      expect(config.useNewParsing).toBe(true);
    });

    it('should read PARSING_COMPARISON_MODE env var', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      const config = getParsingConfig();
      expect(config.comparisonMode).toBe(true);
    });

    it('should read LOG_PARSING_DIFFERENCES env var', () => {
      process.env.LOG_PARSING_DIFFERENCES = 'true';
      const config = getParsingConfig();
      expect(config.logDifferences).toBe(true);
    });

    it('should read custom PARSING_SIMILARITY_THRESHOLD', () => {
      process.env.PARSING_SIMILARITY_THRESHOLD = '80';
      const config = getParsingConfig();
      expect(config.similarityThreshold).toBe(80);
    });

    it('should read custom MIN_CHILD_TASKS_IMPROVEMENT', () => {
      process.env.MIN_CHILD_TASKS_IMPROVEMENT = '5';
      const config = getParsingConfig();
      expect(config.minChildTasksImprovement).toBe(5);
    });
  });

  // === validateComparisonResults ===

  describe('validateComparisonResults', () => {
    it('should be valid when all criteria met', () => {
      const result = validateComparisonResults(50, 5, 20, ['improvement 1']);
      expect(result.isValid).toBe(true);
      expect(result.reason).toContain('Validation réussie');
    });

    it('should fail when similarity below threshold', () => {
      const result = validateComparisonResults(30, 5, 20, ['improvement']);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('Similarité');
      expect(result.reason).toContain('seuil minimum');
    });

    it('should fail when child tasks improvement insufficient', () => {
      const result = validateComparisonResults(50, 10, 15, ['improvement']); // only +5, need +10
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('child tasks');
    });

    it('should fail when no improvements documented', () => {
      const result = validateComparisonResults(50, 5, 20, []);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('Aucune amélioration');
    });

    it('should use custom thresholds from env', () => {
      process.env.PARSING_SIMILARITY_THRESHOLD = '20';
      process.env.MIN_CHILD_TASKS_IMPROVEMENT = '2';
      const result = validateComparisonResults(25, 5, 8, ['fix']);
      expect(result.isValid).toBe(true);
    });

    it('should handle exact threshold values', () => {
      const result = validateComparisonResults(44, 0, 10, ['improvement']);
      expect(result.isValid).toBe(true);
    });

    it('should fail just below threshold', () => {
      const result = validateComparisonResults(43, 0, 10, ['improvement']);
      expect(result.isValid).toBe(false);
    });
  });

  // === shouldUseNewParsing ===

  describe('shouldUseNewParsing', () => {
    it('should return false by default', () => {
      expect(shouldUseNewParsing()).toBe(false);
    });

    it('should return true when USE_NEW_PARSING=true', () => {
      process.env.USE_NEW_PARSING = 'true';
      expect(shouldUseNewParsing()).toBe(true);
    });

    it('should return true when PARSING_COMPARISON_MODE=true', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(shouldUseNewParsing()).toBe(true);
    });

    it('should return true when both set', () => {
      process.env.USE_NEW_PARSING = 'true';
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(shouldUseNewParsing()).toBe(true);
    });
  });

  // === isComparisonMode ===

  describe('isComparisonMode', () => {
    it('should return false by default', () => {
      expect(isComparisonMode()).toBe(false);
    });

    it('should return true when PARSING_COMPARISON_MODE=true', () => {
      process.env.PARSING_COMPARISON_MODE = 'true';
      expect(isComparisonMode()).toBe(true);
    });

    it('should not be affected by USE_NEW_PARSING', () => {
      process.env.USE_NEW_PARSING = 'true';
      expect(isComparisonMode()).toBe(false);
    });
  });
});
