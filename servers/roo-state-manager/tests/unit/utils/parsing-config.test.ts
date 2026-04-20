import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	validateComparisonResults,
	getParsingConfig,
	shouldUseNewParsing,
	isComparisonMode,
	getDefaultConfig,
} from '../../../src/utils/parsing-config';

describe('parsing-config', () => {
	const envVars = [
		'USE_NEW_PARSING',
		'PARSING_COMPARISON_MODE',
		'LOG_PARSING_DIFFERENCES',
		'PARSING_SIMILARITY_THRESHOLD',
		'VALIDATE_IMPROVEMENTS',
		'MIN_CHILD_TASKS_IMPROVEMENT',
	];

	afterEach(() => {
		envVars.forEach(v => delete process.env[v]);
	});

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

		it('should return a copy (not reference)', () => {
			const c1 = getDefaultConfig();
			const c2 = getDefaultConfig();
			c1.similarityThreshold = 999;
			expect(c2.similarityThreshold).toBe(44);
		});
	});

	describe('getParsingConfig', () => {
		it('should return defaults when no env vars set', () => {
			const config = getParsingConfig();
			expect(config.useNewParsing).toBe(false);
			expect(config.similarityThreshold).toBe(44);
		});

		it('should read USE_NEW_PARSING from env', () => {
			process.env.USE_NEW_PARSING = 'true';
			expect(getParsingConfig().useNewParsing).toBe(true);
		});

		it('should read PARSING_COMPARISON_MODE from env', () => {
			process.env.PARSING_COMPARISON_MODE = 'true';
			expect(getParsingConfig().comparisonMode).toBe(true);
		});

		it('should read PARSING_SIMILARITY_THRESHOLD from env', () => {
			process.env.PARSING_SIMILARITY_THRESHOLD = '80';
			expect(getParsingConfig().similarityThreshold).toBe(80);
		});

		it('should read MIN_CHILD_TASKS_IMPROVEMENT from env', () => {
			process.env.MIN_CHILD_TASKS_IMPROVEMENT = '20';
			expect(getParsingConfig().minChildTasksImprovement).toBe(20);
		});

		it('should fall back validateImprovements to default true', () => {
			expect(getParsingConfig().validateImprovements).toBe(true);
		});
	});

	describe('validateComparisonResults', () => {
		it('should reject when similarity below threshold', () => {
			const result = validateComparisonResults(30, 100, 200, ['improved']);
			expect(result.isValid).toBe(false);
			expect(result.reason).toContain('30%');
			expect(result.reason).toContain('44%');
		});

		it('should reject when child tasks improvement below minimum', () => {
			const result = validateComparisonResults(50, 100, 105, ['improved']);
			expect(result.isValid).toBe(false);
			expect(result.reason).toContain('5');
			expect(result.reason).toContain('10');
		});

		it('should reject when no improvements documented', () => {
			const result = validateComparisonResults(50, 100, 200, []);
			expect(result.isValid).toBe(false);
			expect(result.reason).toContain('am\u00e9lioration document\u00e9e');
		});

		it('should accept valid results', () => {
			const result = validateComparisonResults(60, 100, 200, ['faster', 'more accurate']);
			expect(result.isValid).toBe(true);
			expect(result.reason).toContain('60%');
			expect(result.reason).toContain('+100');
		});

		it('should accept at boundary similarity', () => {
			const result = validateComparisonResults(44, 100, 200, ['improved']);
			expect(result.isValid).toBe(true);
		});

		it('should accept at boundary child tasks improvement', () => {
			const result = validateComparisonResults(50, 100, 110, ['improved']);
			expect(result.isValid).toBe(true);
		});

		it('should reject exactly below similarity boundary', () => {
			const result = validateComparisonResults(43, 100, 200, ['improved']);
			expect(result.isValid).toBe(false);
		});
	});

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
	});

	describe('isComparisonMode', () => {
		it('should return false by default', () => {
			expect(isComparisonMode()).toBe(false);
		});

		it('should return true when PARSING_COMPARISON_MODE=true', () => {
			process.env.PARSING_COMPARISON_MODE = 'true';
			expect(isComparisonMode()).toBe(true);
		});
	});
});
