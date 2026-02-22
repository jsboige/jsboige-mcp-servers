/**
 * Tests pour ConfigValidator.ts
 * Issue #492 - Couverture de la validation des baselines
 *
 * @module services/baseline/__tests__/ConfigValidator
 */

import { describe, test, expect } from 'vitest';
import { ConfigValidator } from '../ConfigValidator.js';
import type { BaselineConfig, BaselineFileConfig } from '../../../types/baseline.js';

describe('ConfigValidator', () => {
	let validator: ConfigValidator;

	function createValidator(): ConfigValidator {
		return new ConfigValidator();
	}

	function createValidBaselineConfig(): BaselineConfig {
		return {
			machineId: 'test-machine',
			version: '1.0.0',
			config: {
				roo: { paths: {} },
				hardware: { cpu: 'test' },
				software: { node: '20' },
				system: { os: 'win32' }
			}
		} as BaselineConfig;
	}

	function createValidBaselineFileConfig(): BaselineFileConfig {
		return {
			version: '1.0.0',
			baselineId: 'baseline-001',
			machineId: 'test-machine',
			timestamp: new Date().toISOString(),
			machines: [{ machineId: 'test-machine' }]
		} as BaselineFileConfig;
	}

	// ============================================================
	// validateBaselineConfig
	// ============================================================

	describe('validateBaselineConfig', () => {
		test('returns true for valid config', () => {
			validator = createValidator();
			expect(validator.validateBaselineConfig(createValidBaselineConfig())).toBe(true);
		});

		test('returns false when machineId is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).machineId = '';
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when version is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).version = '';
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when config is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).config = null;
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when config.roo is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).config.roo = null;
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when config.hardware is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).config.hardware = null;
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when config.software is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).config.software = null;
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false when config.system is missing', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).config.system = null;
			expect(validator.validateBaselineConfig(config)).toBe(false);
		});

		test('returns false for null input (catches error)', () => {
			validator = createValidator();
			expect(validator.validateBaselineConfig(null as any)).toBe(false);
		});
	});

	// ============================================================
	// validateBaselineFileConfig
	// ============================================================

	describe('validateBaselineFileConfig', () => {
		test('returns true for valid file config', () => {
			validator = createValidator();
			expect(validator.validateBaselineFileConfig(createValidBaselineFileConfig())).toBe(true);
		});

		test('returns false when version is missing', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).version = '';
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false when baselineId is missing', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).baselineId = '';
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false when machineId is missing', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).machineId = '';
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false when timestamp is missing', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).timestamp = '';
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false when machines is not an array', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).machines = 'not-array';
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false when machines is empty array', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).machines = [];
			expect(validator.validateBaselineFileConfig(config)).toBe(false);
		});

		test('returns false for null input (catches error)', () => {
			validator = createValidator();
			expect(validator.validateBaselineFileConfig(null as any)).toBe(false);
		});
	});

	// ============================================================
	// ensureValidBaselineConfig
	// ============================================================

	describe('ensureValidBaselineConfig', () => {
		test('does not throw for valid config', () => {
			validator = createValidator();
			expect(() => validator.ensureValidBaselineConfig(createValidBaselineConfig())).not.toThrow();
		});

		test('throws BaselineServiceError for invalid config', () => {
			validator = createValidator();
			const config = createValidBaselineConfig();
			(config as any).machineId = '';
			expect(() => validator.ensureValidBaselineConfig(config)).toThrow('invalide');
		});
	});

	// ============================================================
	// ensureValidBaselineFileConfig
	// ============================================================

	describe('ensureValidBaselineFileConfig', () => {
		test('does not throw for valid file config', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			expect(() => validator.ensureValidBaselineFileConfig(config)).not.toThrow();
		});

		test('throws for null input', () => {
			validator = createValidator();
			expect(() => validator.ensureValidBaselineFileConfig(null as any)).toThrow('null ou undefined');
		});

		test('throws for missing machineId', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).machineId = '';
			expect(() => validator.ensureValidBaselineFileConfig(config)).toThrow('machineId');
		});

		test('throws for missing version', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).version = '';
			expect(() => validator.ensureValidBaselineFileConfig(config)).toThrow('version');
		});

		test('throws for missing timestamp AND lastUpdated', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).timestamp = '';
			(config as any).lastUpdated = '';
			expect(() => validator.ensureValidBaselineFileConfig(config)).toThrow('timestamp');
		});

		test('accepts lastUpdated as alternative to timestamp', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).timestamp = '';
			(config as any).lastUpdated = new Date().toISOString();
			expect(() => validator.ensureValidBaselineFileConfig(config)).not.toThrow();
		});

		test('lists multiple missing fields', () => {
			validator = createValidator();
			const config = createValidBaselineFileConfig();
			(config as any).machineId = '';
			(config as any).version = '';
			(config as any).timestamp = '';
			expect(() => validator.ensureValidBaselineFileConfig(config)).toThrow('machineId');
		});
	});
});
