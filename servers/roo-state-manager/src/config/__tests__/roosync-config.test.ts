/**
 * Tests pour roosync-config.ts
 * Issue #492 - Couverture de la configuration RooSync
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadRooSyncConfig, tryLoadRooSyncConfig, isRooSyncEnabled, RooSyncConfigError } from '../roosync-config.js';

describe('roosync-config', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.NODE_ENV = 'test';
		process.env.ROOSYNC_SHARED_PATH = '/tmp/test-shared';
		process.env.ROOSYNC_MACHINE_ID = 'test-machine-01';
		// Clear optional vars that may be set by .env files
		delete process.env.ROOSYNC_AUTO_SYNC;
		delete process.env.ROOSYNC_CONFLICT_STRATEGY;
		delete process.env.ROOSYNC_LOG_LEVEL;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	// ============================================================
	// loadRooSyncConfig - test mode
	// ============================================================

	describe('loadRooSyncConfig (test mode)', () => {
		test('loads config with required env vars', () => {
			const config = loadRooSyncConfig();
			expect(config.sharedPath).toBe('/tmp/test-shared');
			expect(config.machineId).toBe('test-machine-01');
			expect(config.autoSync).toBe(false);
			expect(config.conflictStrategy).toBe('manual');
			expect(config.logLevel).toBe('info');
		});

		test('reads autoSync from env', () => {
			process.env.ROOSYNC_AUTO_SYNC = 'true';
			const config = loadRooSyncConfig();
			expect(config.autoSync).toBe(true);
		});

		test('reads conflictStrategy from env', () => {
			process.env.ROOSYNC_CONFLICT_STRATEGY = 'auto-local';
			const config = loadRooSyncConfig();
			expect(config.conflictStrategy).toBe('auto-local');
		});

		test('reads logLevel from env', () => {
			process.env.ROOSYNC_LOG_LEVEL = 'debug';
			const config = loadRooSyncConfig();
			expect(config.logLevel).toBe('debug');
		});

		test('throws on missing ROOSYNC_SHARED_PATH', () => {
			delete process.env.ROOSYNC_SHARED_PATH;
			expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
			expect(() => loadRooSyncConfig()).toThrow('ROOSYNC_SHARED_PATH');
		});

		test('throws on missing ROOSYNC_MACHINE_ID', () => {
			delete process.env.ROOSYNC_MACHINE_ID;
			expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
			expect(() => loadRooSyncConfig()).toThrow('ROOSYNC_MACHINE_ID');
		});

		test('throws on invalid conflictStrategy', () => {
			process.env.ROOSYNC_CONFLICT_STRATEGY = 'invalid-strategy';
			expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
			expect(() => loadRooSyncConfig()).toThrow('ROOSYNC_CONFLICT_STRATEGY');
		});

		test('throws on invalid logLevel', () => {
			process.env.ROOSYNC_LOG_LEVEL = 'verbose';
			expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
			expect(() => loadRooSyncConfig()).toThrow('ROOSYNC_LOG_LEVEL');
		});

		test('accepts auto-remote strategy', () => {
			process.env.ROOSYNC_CONFLICT_STRATEGY = 'auto-remote';
			const config = loadRooSyncConfig();
			expect(config.conflictStrategy).toBe('auto-remote');
		});

		test('accepts all valid log levels', () => {
			for (const level of ['debug', 'info', 'warn', 'error']) {
				process.env.ROOSYNC_LOG_LEVEL = level;
				const config = loadRooSyncConfig();
				expect(config.logLevel).toBe(level);
			}
		});

		test('throws on invalid logLevel value with specific message', () => {
			process.env.ROOSYNC_LOG_LEVEL = 'invalid';
			expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
			expect(() => loadRooSyncConfig()).toThrow('ROOSYNC_LOG_LEVEL invalide');
		});
	});

	// ============================================================
	// tryLoadRooSyncConfig et isRooSyncEnabled
	// ============================================================

	describe('tryLoadRooSyncConfig', () => {
		test('returns config when valid', () => {
			const config = tryLoadRooSyncConfig();
			expect(config).toBeDefined();
			expect(config?.sharedPath).toBe('/tmp/test-shared');
			expect(config?.machineId).toBe('test-machine-01');
		});

		test('returns null when config is invalid', () => {
			delete process.env.ROOSYNC_SHARED_PATH;
			const config = tryLoadRooSyncConfig();
			expect(config).toBeNull();
		});

		test('returns null when machineId is missing', () => {
			delete process.env.ROOSYNC_MACHINE_ID;
			const config = tryLoadRooSyncConfig();
			expect(config).toBeNull();
		});
	});

	describe('isRooSyncEnabled', () => {
		test('returns true when config is valid', () => {
			const enabled = isRooSyncEnabled();
			expect(enabled).toBe(true);
		});

		test('returns false when config is invalid', () => {
			delete process.env.ROOSYNC_SHARED_PATH;
			const enabled = isRooSyncEnabled();
			expect(enabled).toBe(false);
		});
	});

	// ============================================================
	// loadRooSyncConfig - production mode
	// ============================================================

	describe('loadRooSyncConfig (production mode)', () => {
		beforeEach(() => {
			delete process.env.NODE_ENV;
			process.env.ROOSYNC_SHARED_PATH = process.cwd(); // existing absolute path
			process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
			process.env.ROOSYNC_AUTO_SYNC = 'false';
			process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
			process.env.ROOSYNC_LOG_LEVEL = 'info';
		});

		test('loads production config with all vars', () => {
			const config = loadRooSyncConfig();
			expect(config.machineId).toBe('myia-ai-01');
			expect(config.autoSync).toBe(false);
		});

		test('throws when missing required vars', () => {
			delete process.env.ROOSYNC_AUTO_SYNC;
			expect(() => loadRooSyncConfig()).toThrow('Variables');
		});

		test('throws on relative path', () => {
			process.env.ROOSYNC_SHARED_PATH = 'relative/path';
			expect(() => loadRooSyncConfig()).toThrow('absolu');
		});

		test('throws on non-existent path', () => {
			process.env.ROOSYNC_SHARED_PATH = '/this/path/does/not/exist/at/all';
			expect(() => loadRooSyncConfig()).toThrow('existe pas');
		});

		test('throws on reserved machineId', () => {
			process.env.ROOSYNC_MACHINE_ID = 'localhost';
			expect(() => loadRooSyncConfig()).toThrow('identifiant');
		});

		test('throws on too short machineId', () => {
			process.env.ROOSYNC_MACHINE_ID = 'ab';
			expect(() => loadRooSyncConfig()).toThrow('entre 3 et 50');
		});

		test('throws on invalid machineId characters', () => {
			process.env.ROOSYNC_MACHINE_ID = 'machine with spaces';
			expect(() => loadRooSyncConfig()).toThrow('invalides');
		});

		test('normalizes machineId to lowercase', () => {
			process.env.ROOSYNC_MACHINE_ID = 'MyIA-AI-01';
			const config = loadRooSyncConfig();
			expect(config.machineId).toBe('myia-ai-01');
		});

		test('throws on invalid autoSync value', () => {
			process.env.ROOSYNC_AUTO_SYNC = 'yes';
			expect(() => loadRooSyncConfig()).toThrow('true');
		});
	});

	// ============================================================
	// tryLoadRooSyncConfig
	// ============================================================

	describe('tryLoadRooSyncConfig', () => {
		test('returns config when valid', () => {
			const config = tryLoadRooSyncConfig();
			expect(config).not.toBeNull();
			expect(config!.machineId).toBe('test-machine-01');
		});

		test('returns null on RooSyncConfigError', () => {
			delete process.env.ROOSYNC_SHARED_PATH;
			const config = tryLoadRooSyncConfig();
			expect(config).toBeNull();
		});
	});

	// ============================================================
	// isRooSyncEnabled
	// ============================================================

	describe('isRooSyncEnabled', () => {
		test('returns true when config is valid', () => {
			expect(isRooSyncEnabled()).toBe(true);
		});

		test('returns false when config is invalid', () => {
			delete process.env.ROOSYNC_MACHINE_ID;
			expect(isRooSyncEnabled()).toBe(false);
		});
	});

	// ============================================================
	// RooSyncConfigError
	// ============================================================

	describe('RooSyncConfigError', () => {
		test('has correct name', () => {
			const error = new RooSyncConfigError('test error');
			expect(error.name).toBe('RooSyncConfigError');
		});

		test('prefixes message with [RooSync Config]', () => {
			const error = new RooSyncConfigError('test error');
			expect(error.message).toContain('[RooSync Config]');
			expect(error.message).toContain('test error');
		});

		test('is instance of Error', () => {
			const error = new RooSyncConfigError('test');
			expect(error).toBeInstanceOf(Error);
		});
	});

	// ============================================================
	// validateMachineIdUniqueness
	// ============================================================

	describe('validateMachineIdUniqueness', () => {
		const mockSharedPath = '/tmp/test-shared';

		beforeEach(() => {
			// Mock fs modules
			const mockFs = {
				existsSync: vi.fn(),
				readFileSync: vi.fn(),
				writeFile: vi.fn()
			};
			const mockPath = {
				join: vi.fn((...args) => args.join('/'))
			};

			// Mock dynamique des imports
			vi.doMock('fs', () => mockFs);
			vi.doMock('path', () => mockPath);
		});

		test('returns valid when no registry file exists', async () => {
			const { existsSync } = await import('fs');
			existsSync.mockReturnValue(false);

			const result = await validateMachineIdUniqueness('test-machine', mockSharedPath);

			expect(result.isValid).toBe(true);
			expect(result.conflictDetected).toBe(false);
		});

		test('returns valid when registry exists but machineId not found', async () => {
			const { existsSync, readFileSync } = await import('fs');
			existsSync.mockReturnValue(true);
			readFileSync.mockReturnValue(JSON.stringify({
				machines: {
					'other-machine': {
						machineId: 'other-machine',
						firstSeen: '2026-01-01T00:00:00.000Z',
						lastSeen: '2026-01-01T00:00:00.000Z',
						source: 'test',
						status: 'online'
					}
				}
			}));

			const result = await validateMachineIdUniqueness('new-machine', mockSharedPath);

			expect(result.isValid).toBe(true);
			expect(result.conflictDetected).toBe(false);
		});

		test('returns conflict when machineId already exists', async () => {
			const { existsSync, readFileSync } = await import('fs');
			existsSync.mockReturnValue(true);
			readFileSync.mockReturnValue(JSON.stringify({
				machines: {
					'existing-machine': {
						machineId: 'existing-machine',
						firstSeen: '2026-01-01T00:00:00.000Z',
						lastSeen: '2026-01-02T00:00:00.000Z',
						source: 'test',
						status: 'online'
					}
				}
			}));

			const result = await validateMachineIdUniqueness('existing-machine', mockSharedPath);

			expect(result.isValid).toBe(false);
			expect(result.conflictDetected).toBe(true);
			expect(result.warningMessage).toContain('CONFLIT D\'IDENTITÉ');
			expect(result.warningMessage).toContain('déjà utilisé dans le registre');
			expect(result.existingEntry).toBeDefined();
			expect(result.existingEntry?.machineId).toBe('existing-machine');
		});

		test('handles JSON parse error gracefully', async () => {
			const { existsSync, readFileSync } = await import('fs');
			existsSync.mockReturnValue(true);
			readFileSync.mockReturnValue('invalid json');

			const result = await validateMachineIdUniqueness('test-machine', mockSharedPath);

			// En cas d'erreur, la fonction retourne quand même isValid: true
			expect(result.isValid).toBe(true);
			expect(result.conflictDetected).toBe(false);
		});
	});

	// ============================================================
	// registerMachineId
	// ============================================================

	describe('registerMachineId', () => {
		const mockSharedPath = '/tmp/test-shared';

		beforeEach(() => {
			// Mock fs modules
			const mockFs = {
				existsSync: vi.fn(),
				readFileSync: vi.fn(),
				writeFile: vi.fn()
			};
			const mockPath = {
				join: vi.fn((...args) => args.join('/'))
			};

			// Mock des promesses fs
			mockFs.promises = {
				writeFile: vi.fn().mockResolvedValue(undefined)
			};

			vi.doMock('fs', () => mockFs);
			vi.doMock('path', () => mockPath);
		});

		test('creates new registry when none exists', async () => {
			const { existsSync, readFileSync, promises } = await import('fs');
			existsSync.mockReturnValue(false);
			readFileSync.mockReturnValue('');

			const result = await registerMachineId('new-machine', mockSharedPath, 'test');

			expect(result).toBe(true);
			expect(promises.writeFile).toHaveBeenCalledWith(
				`${mockSharedPath}/.machine-registry.json`,
				expect.any(String),
				'utf-8'
			);
		});

		test('updates existing registry', async () => {
			const { existsSync, readFileSync, promises } = await import('fs');
			existsSync.mockReturnValue(true);
			readFileSync.mockReturnValue(JSON.stringify({
				machines: {
					'existing-machine': {
						machineId: 'existing-machine',
						firstSeen: '2026-01-01T00:00:00.000Z',
						lastSeen: '2026-01-01T00:00:00.000Z',
						source: 'old',
						status: 'online'
					}
				},
				lastUpdated: '2026-01-01T00:00:00.000Z'
			}));

			const result = await registerMachineId('new-machine', mockSharedPath, 'test');

			expect(result).toBe(true);
			expect(promises.writeFile).toHaveBeenCalled();
		});
	});
});