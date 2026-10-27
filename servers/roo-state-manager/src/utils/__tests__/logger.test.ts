/**
 * Tests pour logger.ts
 * Issue #492 - Couverture du logger de production
 */

import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger, createLogger, getDefaultLogger, resetDefaultLogger } from '../logger.js';
import type { LogLevel, LoggerOptions } from '../logger.js';

describe('logger', () => {
	// NOTE: MCP stdio transport reserves stdout for JSON-RPC.
	// All log levels MUST go to stderr (console.error) — see fix(MCP) stdout leak.
	let consoleSpy: Record<string, ReturnType<typeof vi.spyOn>>;

	// Every Logger built below writes a real file into its own log directory.
	// That directory used to be the hard-coded POSIX path '/tmp/test-logs-<epoch>',
	// which on Windows resolves to D:\tmp — 25 995 orphaned directories on
	// myia-ai-01 as of 27/10 (Maintenance [ASK][DISK] 27/10). Each instance now
	// gets a unique directory under os.tmpdir(), removed in afterEach.
	//
	// The Logger writes synchronously (appendFileSync in logger.ts) and keeps no
	// open file handle, so there is nothing to close or flush before removal.
	// The directory name keeps the 'test' substring on purpose: the Logger's
	// silent-fail branch (logToFile / ensureLogDirectory) keys on it.
	const createdLogDirs: string[] = [];

	function makeLogDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'rsm-test-logs-'));
		createdLogDirs.push(dir);
		return dir;
	}

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
		// rmSync with force:true is a no-op on an already-removed directory,
		// so re-walking the whole list stays correct as the suite grows.
		for (const dir of createdLogDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Exhaustive guard: once the suite is over, NONE of the directories it
	// created may still exist. Without this, a regression that stops removing
	// them (or that reintroduces a hard-coded path) would silently re-fill
	// the temp dir — the leak measured on 27/10 (Maintenance [ASK][DISK]).
	afterAll(() => {
		const survivors = createdLogDirs.filter((dir) => existsSync(dir));
		expect(survivors).toEqual([]);
	});

	// ============================================================
	// Logger creation
	// ============================================================

	describe('creation', () => {
		test('creates logger with defaults', () => {
			const logger = new Logger({ logDir: makeLogDir() });
			const config = logger.getConfig();
			expect(config.source).toBe('RooSync');
			expect(config.minLevel).toBe('INFO');
			expect(config.maxFileSize).toBe(10 * 1024 * 1024);
			expect(config.retentionDays).toBe(7);
		});

		test('creates logger with custom source', () => {
			const logger = new Logger({ source: 'TestModule', logDir: makeLogDir() });
			const config = logger.getConfig();
			expect(config.source).toBe('TestModule');
		});

		test('creates logger with custom options', () => {
			const logger = new Logger({
				logDir: makeLogDir(),
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
			const logger = new Logger({ logDir: makeLogDir() });
			const logFile = logger.getCurrentLogFile();
			expect(logFile).toMatch(/roosync-\d{8}\.log/);
		});
	});

	// ============================================================
	// Log level filtering
	// ============================================================

	describe('log level filtering', () => {
		test('filters out DEBUG when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.debug('should be filtered');
			expect(consoleSpy.error).not.toHaveBeenCalled();
		});

		test('shows INFO when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.info('should appear');
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('shows WARN when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.warn('should appear');
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('shows ERROR when minLevel is INFO', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.error('should appear');
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('shows only ERROR when minLevel is ERROR', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: makeLogDir() });
			logger.debug('filtered');
			logger.info('filtered');
			logger.warn('filtered');
			logger.error('shown');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.log).not.toHaveBeenCalled();
			expect(consoleSpy.warn).not.toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalledTimes(1);
		});

		test('shows everything when minLevel is DEBUG', () => {
			const logger = new Logger({ minLevel: 'DEBUG' as LogLevel, logDir: makeLogDir() });
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			// All 4 log levels go to stderr (stdout reserved for JSON-RPC in MCP stdio transport)
			expect(consoleSpy.error).toHaveBeenCalledTimes(4);
		});
	});

	// ============================================================
	// Error logging
	// ============================================================

	describe('error logging', () => {
		test('logs Error objects with stack trace', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: makeLogDir() });
			const error = new Error('test error');
			logger.error('Something failed', error);
			expect(consoleSpy.error).toHaveBeenCalled();
			const output = consoleSpy.error.mock.calls[0][0];
			expect(output).toContain('Something failed');
		});

		test('logs non-Error objects as strings', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: makeLogDir() });
			logger.error('Something failed', 'string error' as any);
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		test('logs with additional metadata', () => {
			const logger = new Logger({ minLevel: 'ERROR' as LogLevel, logDir: makeLogDir() });
			logger.error('Failed', new Error('test'), { context: 'unit-test' });
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	// ============================================================
	// Metadata formatting
	// ============================================================

	describe('metadata formatting', () => {
		test('includes metadata in log output', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.info('Test message', { key: 'value', count: 42 });
			expect(consoleSpy.error).toHaveBeenCalled();
			const output = consoleSpy.error.mock.calls[0][0];
			expect(output).toContain('key');
			expect(output).toContain('value');
		});

		test('formats without metadata when none provided', () => {
			const logger = new Logger({ minLevel: 'INFO' as LogLevel, logDir: makeLogDir() });
			logger.info('Simple message');
			expect(consoleSpy.error).toHaveBeenCalled();
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

	// ============================================================
	// Temp directory hygiene
	// ============================================================

	describe('temp directory hygiene', () => {
		test('the log directory lives under os.tmpdir(), never a hard-coded /tmp', () => {
			// On Windows '/tmp' resolves to D:\tmp (the drive of the cwd), which
			// is why the old hard-coded path leaked thousands of directories
			// there instead of the real temp dir.
			const dir = makeLogDir();
			expect(dir.startsWith(tmpdir())).toBe(true);
			expect(dir.replace(/\\/g, '/')).not.toContain('/tmp/test-logs-');
		});

		test('the log directory is removed once the test is over', () => {
			const dir = makeLogDir();
			expect(existsSync(dir)).toBe(true);

			// Reproduce what afterEach does, then assert the directory is gone.
			rmSync(dir, { recursive: true, force: true });
			expect(existsSync(dir)).toBe(false);
		});

		test('afterEach removes every directory the suite created', () => {
			// Snapshot BEFORE creating anything here: the directory this test
			// creates must not be part of the assertion, it is still alive at
			// this point (afterEach runs after the test body).
			const dirsFromEarlierTests = [...createdLogDirs];
			expect(dirsFromEarlierTests.length).toBeGreaterThan(0);

			// Every one of them was removed by the afterEach that followed its
			// creation (rmSync with force:true is a no-op on an absent path).
			for (const dir of dirsFromEarlierTests) {
				expect(existsSync(dir)).toBe(false);
			}
		});
	});
});
