/**
 * Tests pour logger.ts
 * Issue #492 - Couverture du logger de production
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, createLogger, getDefaultLogger, resetDefaultLogger } from '../logger.js';
import type { LogLevel, LoggerOptions } from '../logger.js';

describe('logger', () => {
	let consoleSpy: Record<string, ReturnType<typeof vi.spyOn>>;

	beforeEach(() => {
		consoleSpy = {
			log: vi.spyOn(console, 'log').mockImplementation(() => {}),
			error: vi.spyOn(console, 'error').mockImplementation(() => {}),
			warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
			debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDefaultLogger();
	});

	// ============================================================
	// Logger creation
	// ============================================================

	describe('creation', () => {
		test('creates logger with defaults', () => {
			const logger = new Logger({ logDir: '/tmp/test-logs-' + Date.now() });
			const config = logger.getConfig();
			expect(config.source).toBe('RooSync');
			expect(config.minLevel).toBe('INFO');
			expect(config.maxFileSize).toBe(10 * 1024 * 1024);
			expect(config.retentionDays).toBe(7);
		});

		test('creates logger with custom source', () => {
			const logger = new Logger({ source: 'TestModule', logDir: '/tmp/test-logs-' + Date.now() });
			const config = logger.getConfig();
			expect(config.source).toBe('TestModule');
		});

		test('creates logger with custom options', () => {
			const logger = new Logger({
				logDir: '/tmp/test-logs-' + Date.now(),
				filePrefix: 'test',
				maxFileSize: 1024,
				retentionDays: 3,
				minLevel: 'WARN' as LogLevel,
			});
			const config = logger.getConfig();
			expect(config.filePrefix).toBe('test');
			expect(config.maxFileSize).toBe(1024);
			expect(config.retentionDays).toBe(3);
			expect(config.minLevel).toBe('WARN');
		});

		test('generates log file path with date', () => {
			const logger = new Logger({ logDir: '/tmp/test-logs-' + Date.now() });
			const logFile = logger.getCurrentLogFile();
			expect(logFile).toMatch(/roosync-\d{8}\.log/);
		});
	});

	// ============================================================
	// Log level filtering
	// ============================================================

	describe('log level filtering', () => {
		test('filters out DEBUG when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.debug('should be filtered');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
		});

		test('shows INFO when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.info('should appear');
			expect(consoleSpy.log).toHaveBeenCalled();
		});

		test('shows WARN when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.warn('should appear');
			expect(consoleSpy.warn).toHaveBeenCalled();
		});

		test('shows ERROR when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.error('should appear');
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('shows only ERROR when minLevel is ERROR', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.debug('filtered');
			logger.info('filtered');
			logger.warn('filtered');
			logger.error('shown');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.log).not.toHaveBeenCalled();
			expect(consoleSpy.warn).not.toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('shows everything when minLevel is DEBUG', () => {
			const logger = new Logger({ minLevel: 'DEBUG' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			expect(consoleSpy.debug).toHaveBeenCalled();
			expect(consoleSpy.log).toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Error logging
	// ============================================================

	describe('error logging', () => {
		test('logs Error objects with stack trace', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			const error = new Error('test error');
			logger.error('Something failed', error);
			expect(consoleSpy.error).toHaveBeenCalled();
			const output = consoleSpy.error.mock.calls[0][0];
			expect(output).toContain('Something failed');
		});

		test('logs non-Error objects as strings', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.error('Something failed', 'string error' as any);
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('logs with additional metadata', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.error('Failed', new Error('test'), { context: 'unit-test' });
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Metadata formatting
	// ============================================================

	describe('metadata formatting', () => {
		test('includes metadata in log output', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.info('Test message', { key: 'value', count: 42 });
			expect(consoleSpy.log).toHaveBeenCalled();
			const output = consoleSpy.log.mock.calls[0][0];
			expect(output).toContain('key');
			expect(output).toContain('value');
		});

		test('formats without metadata when none provided', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: '/tmp/test-logs-' + Date.now() });
			logger.info('Simple message');
			expect(consoleSpy.log).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Factory functions
	// ============================================================

	describe('factory functions', () => {
		test('createLogger creates logger with source', () => {
			const logger = createLogger('TestSource');
			const config = logger.getConfig();
			expect(config.source).toBe('TestSource');
		});

		test('createLogger accepts additional options', () => {
			const logger = createLogger('Source', { minLevel: 'WARN' as LogLevel });
			const config = logger.getConfig();
			expect(config.source).toBe('Source');
			expect(config.minLevel).toBe('WARN');
		});

		test('getDefaultLogger returns singleton', () => {
			const logger1 = getDefaultLogger();
			const logger2 = getDefaultLogger();
			expect(logger1).toBe(logger2);
		});

		test('resetDefaultLogger clears singleton', () => {
			const logger1 = getDefaultLogger();
			resetDefaultLogger();
			const logger2 = getDefaultLogger();
			expect(logger1).not.toBe(logger2);
		});
	});
});
