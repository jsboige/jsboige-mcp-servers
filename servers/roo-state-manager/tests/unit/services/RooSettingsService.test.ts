import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
	mockExistsSync,
	mockCopyFileSync,
	mockFsUnlink,
	mockSqlite3Database,
} = vi.hoisted(() => {
	const dbMock = {
		get: vi.fn(),
		run: vi.fn(),
		close: vi.fn(),
	};
	return {
		mockExistsSync: vi.fn(),
		mockCopyFileSync: vi.fn(),
		mockFsUnlink: vi.fn().mockResolvedValue(undefined),
		mockSqlite3Database: dbMock,
	};
});

vi.mock('fs', () => ({
	existsSync: mockExistsSync,
	copyFileSync: mockCopyFileSync,
	promises: {
		unlink: mockFsUnlink,
	},
}));

vi.mock('sqlite3', () => {
	class MockDatabase {
		path: string;
		mode: number;
		constructor(path: string, mode: number, cb: (err: Error | null) => void) {
			this.path = path;
			this.mode = mode;
			queueMicrotask(() => cb(null));
		}
		get(sql: string, params: unknown[], cb: (err: Error | null, row?: unknown) => void) {
			return mockSqlite3Database.get(sql, params, cb);
		}
		run(sql: string, params: unknown[], cb: (err: Error | null) => void) {
			return mockSqlite3Database.run(sql, params, cb);
		}
		close(cb: (err: Error | null) => void) {
			return mockSqlite3Database.close(cb);
		}
	}
	return {
		default: {
			Database: MockDatabase,
			OPEN_READONLY: 1,
			OPEN_READWRITE: 2,
		},
	};
});

vi.mock('os', () => ({
	homedir: () => 'C:\\Users\\testuser',
	tmpdir: () => 'C:\\Users\\testuser\\AppData\\Local\\Temp',
}));

import {
	RooSettingsService,
	SYNC_SAFE_KEYS,
	EXCLUDED_KEYS,
} from '../../../src/services/RooSettingsService.js';

const SAMPLE_SETTINGS = {
	id: 'machine-uuid-123',
	taskHistory: ['task1', 'task2'],
	autoCondenseContext: true,
	autoCondenseContextPercent: 75,
	apiProvider: 'openai',
	openAiBaseUrl: 'https://api.example.com',
	mode: 'code',
	language: 'fr',
	mcpEnabled: true,
	telemetrySetting: 'enabled',
	customInstructions: 'test instructions',
};

describe('RooSettingsService', () => {
	let service: RooSettingsService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = new RooSettingsService();
		mockSqlite3Database.close.mockImplementation((cb: (err: null) => void) => cb(null));
	});

	describe('getStateDbPath', () => {
		it('should return path under AppData Roaming', () => {
			const path = service.getStateDbPath();
			expect(path).toContain('AppData');
			expect(path).toContain('state.vscdb');
			expect(path).toContain('testuser');
		});
	});

	describe('isAvailable', () => {
		it('should return true when state.vscdb exists', () => {
			mockExistsSync.mockReturnValue(true);
			expect(service.isAvailable()).toBe(true);
		});

		it('should return false when state.vscdb does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(service.isAvailable()).toBe(false);
		});
	});

	describe('extractSettings', () => {
		it('should throw when state.vscdb not found', async () => {
			mockExistsSync.mockReturnValue(false);
			await expect(service.extractSettings()).rejects.toThrow('state.vscdb not found');
		});

		it('should extract safe-mode settings only', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify(SAMPLE_SETTINGS) });
				}
			);

			const result = await service.extractSettings('safe');

			expect(result.metadata.mode).toBe('safe');
			expect(result.settings).toHaveProperty('autoCondenseContext');
			expect(result.settings).toHaveProperty('apiProvider');
			expect(result.settings).not.toHaveProperty('id');
			expect(result.settings).not.toHaveProperty('taskHistory');
		});

		it('should extract full-mode settings excluding EXCLUDED_KEYS', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify(SAMPLE_SETTINGS) });
				}
			);

			const result = await service.extractSettings('full');

			expect(result.metadata.mode).toBe('full');
			expect(result.settings).toHaveProperty('autoCondenseContext');
			expect(result.settings).toHaveProperty('mcpEnabled');
			expect(result.settings).not.toHaveProperty('id');
			expect(result.settings).not.toHaveProperty('taskHistory');
		});

		it('should include metadata with machine, timestamp, mode, and counts', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify(SAMPLE_SETTINGS) });
				}
			);

			const result = await service.extractSettings('safe');

			expect(result.metadata.machine).toBeDefined();
			expect(result.metadata.timestamp).toBeDefined();
			expect(result.metadata.keysCount).toBeGreaterThan(0);
			expect(result.metadata.totalKeys).toBe(Object.keys(SAMPLE_SETTINGS).length);
			expect(result.metadata.keysCount).toBeLessThanOrEqual(result.metadata.totalKeys);
		});

		it('should default to safe mode', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ id: 'x', mode: 'code' }) });
				}
			);

			const result = await service.extractSettings();

			expect(result.metadata.mode).toBe('safe');
			expect(result.settings).toHaveProperty('mode');
			expect(result.settings).not.toHaveProperty('id');
		});

		it('should handle Buffer values from sqlite', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: Buffer.from(JSON.stringify({ mode: 'code' })) });
				}
			);

			const result = await service.extractSettings('safe');
			expect(result.settings).toHaveProperty('mode', 'code');
		});

		it('should throw when VSCDB_KEY not found in database', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, undefined);
				}
			);

			await expect(service.extractSettings()).rejects.toThrow('not found in state.vscdb');
		});
	});

	describe('injectSettings', () => {
		it('should throw when state.vscdb not found', async () => {
			mockExistsSync.mockReturnValue(false);
			await expect(service.injectSettings({ mode: 'code' })).rejects.toThrow('state.vscdb not found');
		});

		it('should apply changes for modified safe keys', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code', language: 'en' }) });
				}
			);
			mockSqlite3Database.run.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null) => void) => cb(null)
			);

			const result = await service.injectSettings({ mode: 'debug', language: 'en' });

			expect(result.applied).toBe(1);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].key).toBe('mode');
			expect(result.changes[0].oldValue).toBe('code');
			expect(result.changes[0].newValue).toBe('debug');
			expect(result.dryRun).toBe(false);
		});

		it('should not apply changes in dryRun mode', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code' }) });
				}
			);

			const result = await service.injectSettings({ mode: 'debug' }, { dryRun: true });

			expect(result.applied).toBe(0);
			expect(result.dryRun).toBe(true);
			expect(result.changes).toHaveLength(1);
			expect(mockSqlite3Database.run).not.toHaveBeenCalled();
		});

		it('should skip unchanged settings', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code' }) });
				}
			);

			const result = await service.injectSettings({ mode: 'code' });

			expect(result.applied).toBe(0);
			expect(result.changes).toHaveLength(0);
		});

		it('should only inject specified keys when options.keys provided', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code', language: 'en' }) });
				}
			);
			mockSqlite3Database.run.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null) => void) => cb(null)
			);

			const result = await service.injectSettings(
				{ mode: 'debug', language: 'fr' },
				{ keys: ['language'] }
			);

			expect(result.applied).toBe(1);
			expect(result.changes[0].key).toBe('language');
		});

		it('should reject non-sync-safe keys when no options.keys provided', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({}) });
				}
			);

			const result = await service.injectSettings({ id: 'new-uuid', taskHistory: [] });

			expect(result.applied).toBe(0);
			expect(result.changes).toHaveLength(0);
		});
	});

	describe('getSetting', () => {
		it('should return a single setting value', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code', language: 'en' }) });
				}
			);

			const value = await service.getSetting('mode');
			expect(value).toBe('code');
		});

		it('should return undefined for missing key', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code' }) });
				}
			);

			const value = await service.getSetting('nonexistent');
			expect(value).toBeUndefined();
		});
	});

	describe('exported key sets', () => {
		it('SYNC_SAFE_KEYS should contain condensation settings', () => {
			expect(SYNC_SAFE_KEYS.has('autoCondenseContext')).toBe(true);
			expect(SYNC_SAFE_KEYS.has('autoCondenseContextPercent')).toBe(true);
		});

		it('SYNC_SAFE_KEYS should contain model settings', () => {
			expect(SYNC_SAFE_KEYS.has('apiProvider')).toBe(true);
			expect(SYNC_SAFE_KEYS.has('openAiModelId')).toBe(true);
		});

		it('SYNC_SAFE_KEYS should contain behavior settings', () => {
			expect(SYNC_SAFE_KEYS.has('alwaysAllowReadOnly')).toBe(true);
			expect(SYNC_SAFE_KEYS.has('writeDelayMs')).toBe(true);
		});

		it('SYNC_SAFE_KEYS should contain terminal settings', () => {
			expect(SYNC_SAFE_KEYS.has('terminalOutputCharacterLimit')).toBe(true);
			expect(SYNC_SAFE_KEYS.has('terminalShellIntegrationTimeout')).toBe(true);
		});

		it('EXCLUDED_KEYS should contain machine-specific keys', () => {
			expect(EXCLUDED_KEYS.has('id')).toBe(true);
			expect(EXCLUDED_KEYS.has('taskHistory')).toBe(true);
			expect(EXCLUDED_KEYS.has('clerk-auth-state')).toBe(true);
		});

		it('EXCLUDED_KEYS should not overlap with SYNC_SAFE_KEYS', () => {
			const overlap = [...SYNC_SAFE_KEYS].filter((k) => EXCLUDED_KEYS.has(k));
			expect(overlap).toEqual([]);
		});
	});

	describe('database error handling', () => {
		it('should propagate sqlite get errors', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: Error, row?: undefined) => void) => {
					cb(new Error('database disk image is malformed'));
				}
			);

			await expect(service.extractSettings()).rejects.toThrow('database disk image is malformed');
		});

		it('should propagate sqlite run errors', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFileSync.mockImplementation(() => {});
			mockSqlite3Database.get.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: null, row: unknown) => void) => {
					cb(null, { value: JSON.stringify({ mode: 'code' }) });
				}
			);
			mockSqlite3Database.run.mockImplementation(
				(_sql: string, _params: unknown[], cb: (err: Error) => void) => {
					cb(new Error('database is locked'));
				}
			);

			await expect(service.injectSettings({ mode: 'debug' })).rejects.toThrow('database is locked');
		});
	});
});
