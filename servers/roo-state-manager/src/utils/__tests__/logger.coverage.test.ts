/**
 * Coverage test pour logger.ts — rotation, cleanup, et chemins d'erreur fs.
 *
 * Le test de base (logger.test.ts) exerce la création, le filtrage de niveau,
 * le logging d'erreur et les factory functions avec un vrai fs (écriture tmpdir).
 * Il NE couvre PAS :
 *   - checkRotation (no-file / size-triggered / catch)      L270-283
 *   - rotateLog (méthode entière + catch)                   L288-308
 *   - cleanupOldLogs (no-dir / skip / delete-old / catch)   L313-340
 *   - logToFile catch (test-dir return + fallback console)  L232-239
 *   - ensureLogDirectory catch (test-dir return + console)  L249-255
 *
 * Ces chemins nécessitent de contrôler fs de façon déterministe → vi.mock('fs').
 * Le mock est hoisté par fichier : il n'affecte pas le test de base (vrai fs).
 * add-only, 0 source touché (anti-churn #1936).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs AVANT l'import du logger. On préserve le vrai module et on n'override
// que les 6 fonctions utilisées par logger.ts.
vi.mock('fs', async (importActual) => {
	const actual = await importActual<typeof import('fs')>();
	return {
		...actual,
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn(),
		readdirSync: vi.fn(),
		statSync: vi.fn(),
		unlinkSync: vi.fn(),
	};
});

import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { Logger } from '../logger.js';

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

let errorSpy: ReturnType<typeof vi.spyOn>;

/** Défauts sûrs : dir + fichier existent, aucun log ancien, écritures no-op. */
function setSafeDefaults() {
	mockExistsSync.mockReturnValue(true);
	mockMkdirSync.mockImplementation(() => undefined as any);
	mockAppendFileSync.mockImplementation(() => undefined as any);
	mockReaddirSync.mockReturnValue([] as any);
	mockStatSync.mockReturnValue({ size: 0, mtimeMs: Date.now() } as any);
	mockUnlinkSync.mockImplementation(() => undefined as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	setSafeDefaults();
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================
// logToFile — chemins d'erreur (L232-239)
// ============================================================

describe('logToFile error handling', () => {
	test('test-dir logDir: appendFileSync failure returns silently (L234)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', minLevel: 'INFO' });
		mockAppendFileSync.mockImplementation(() => {
			throw new Error('EACCES');
		});

		expect(() => logger.info('boom')).not.toThrow();
		expect(mockAppendFileSync).toHaveBeenCalled();
		// Le bras test-dir retourne sans logguer le fallback "Failed to write".
		expect(errorSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('Failed to write to log file'),
		);
	});

	test('prod-dir logDir: appendFileSync failure logs fallback to console (L237-238)', () => {
		const logger = new Logger({ logDir: '/var/data/prodlogs', minLevel: 'INFO' });
		mockAppendFileSync.mockImplementation(() => {
			throw new Error('ENOSPC');
		});

		logger.info('boom');
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to write to log file'),
		);
	});
});

// ============================================================
// ensureLogDirectory — création + catch (L245-256), cleanup no-dir (L315-317)
// ============================================================

describe('ensureLogDirectory error handling', () => {
	test('test-dir logDir: mkdir failure swallowed at construction (L251)', () => {
		mockExistsSync.mockReturnValue(false); // dir n'existe pas → mkdir tenté ; cleanup no-dir
		mockMkdirSync.mockImplementation(() => {
			throw new Error('EPERM');
		});

		expect(() => new Logger({ logDir: '/tmp/roosync-test-logs' })).not.toThrow();
		expect(mockMkdirSync).toHaveBeenCalled();
		// Bras test-dir : pas de console.error "Failed to create log directory".
		expect(errorSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('Failed to create log directory'),
			expect.anything(),
		);
	});

	test('prod-dir logDir: mkdir failure logs to console (L254)', () => {
		mockExistsSync.mockReturnValue(false);
		mockMkdirSync.mockImplementation(() => {
			throw new Error('EPERM');
		});

		new Logger({ logDir: '/var/data/prodlogs' });
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to create log directory'),
			expect.anything(),
		);
	});

	test('creates directory when missing (L247-248)', () => {
		mockExistsSync.mockReturnValue(false);
		// mkdir réussit (défaut no-op)
		new Logger({ logDir: '/var/data/newlogs' });
		expect(mockMkdirSync).toHaveBeenCalledWith('/var/data/newlogs', { recursive: true });
	});
});

// ============================================================
// checkRotation (L270-283) + rotateLog (L288-308)
// ============================================================

describe('checkRotation and rotateLog', () => {
	test('no current log file: returns before statSync (L272-274)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', minLevel: 'INFO' });
		// Après construction : le fichier de log n'existe pas.
		mockExistsSync.mockReturnValue(false);
		mockStatSync.mockClear();

		logger.info('x');
		// checkRotation retourne avant d'appeler statSync.
		expect(mockStatSync).not.toHaveBeenCalled();
	});

	test('size >= maxFileSize triggers rotation (L276-279, L288-304)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', maxFileSize: 10, minLevel: 'INFO' });
		const before = logger.getCurrentLogFile();
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ size: 9999, mtimeMs: Date.now() } as any);
		mockReaddirSync.mockReturnValue([] as any);

		logger.info('overflow');

		expect(logger.getCurrentLogFile()).not.toBe(before);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Log rotated to'),
		);
	});

	test('rotation numbering uses existing file count (L299-302)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', maxFileSize: 10, filePrefix: 'roosync', minLevel: 'INFO' });
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ size: 9999, mtimeMs: Date.now() } as any);
		// 2 fichiers existants pour la date courante → nextNum = 3.
		const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
		mockReaddirSync.mockReturnValue([`roosync-${dateStr}.log`, `roosync-${dateStr}-2.log`] as any);

		logger.info('overflow');
		expect(logger.getCurrentLogFile()).toContain(`roosync-${dateStr}-3.log`);
	});

	test('statSync failure caught in checkRotation (L280-282)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', minLevel: 'INFO' });
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockImplementation(() => {
			throw new Error('EIO');
		});

		expect(() => logger.info('x')).not.toThrow();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Error checking log rotation'),
			expect.anything(),
		);
	});

	test('readdirSync failure caught in rotateLog (L305-307)', () => {
		const logger = new Logger({ logDir: '/tmp/roosync-test-logs', maxFileSize: 10, minLevel: 'INFO' });
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ size: 9999, mtimeMs: Date.now() } as any);
		mockReaddirSync.mockImplementation(() => {
			throw new Error('EIO');
		});

		expect(() => logger.info('overflow')).not.toThrow();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to rotate log'),
			expect.anything(),
		);
	});
});

// ============================================================
// cleanupOldLogs — exécuté au constructeur (L313-340)
// ============================================================

describe('cleanupOldLogs', () => {
	test('no log directory: returns early (L315-317)', () => {
		mockExistsSync.mockReturnValue(false);
		new Logger({ logDir: '/tmp/roosync-test-logs' });
		// readdirSync n'est jamais appelé pour lister le cleanup.
		expect(mockReaddirSync).not.toHaveBeenCalled();
	});

	test('skips files not matching prefix/suffix (L324-326)', () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(['other.txt', 'notes.md', 'random.json'] as any);

		new Logger({ logDir: '/var/data/logs', filePrefix: 'roosync' });
		// Aucun fichier ne matche → aucun statSync ni unlink.
		expect(mockStatSync).not.toHaveBeenCalled();
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	test('deletes log files older than retention (L332-335)', () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(['roosync-20200101.log'] as any);
		mockStatSync.mockReturnValue({ size: 0, mtimeMs: 0 } as any); // très ancien

		new Logger({ logDir: '/var/data/logs', filePrefix: 'roosync', retentionDays: 7 });
		expect(mockUnlinkSync).toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Cleaned up old log file'),
		);
	});

	test('keeps log files within retention (L332 false arm)', () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(['roosync-recent.log'] as any);
		mockStatSync.mockReturnValue({ size: 0, mtimeMs: Date.now() } as any); // récent

		new Logger({ logDir: '/var/data/logs', filePrefix: 'roosync', retentionDays: 7 });
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	test('readdirSync failure caught during cleanup (L337-339)', () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockImplementation(() => {
			throw new Error('EIO');
		});

		expect(() => new Logger({ logDir: '/var/data/logs' })).not.toThrow();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Error during log cleanup'),
			expect.anything(),
		);
	});
});
