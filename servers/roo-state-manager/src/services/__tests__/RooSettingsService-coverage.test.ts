/**
 * Comprehensive tests for RooSettingsService
 * Target: 50%+ coverage (from 11%)
 *
 * Tests extractSettings, injectSettings, getSetting, filterSettings,
 * error paths, and exported key sets.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock sqlite3 before importing the service
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockDbClose = vi.fn();

const mockDatabaseInstance = {
  get: mockDbGet,
  run: mockDbRun,
  close: mockDbClose,
};

vi.mock('sqlite3', () => {
  const Database = vi.fn((_path: string, _mode: number, callback: (err: Error | null) => void) => {
    setTimeout(() => callback(null), 0);
    return mockDatabaseInstance;
  });
  return {
    default: {
      Database,
      OPEN_READONLY: 1,
      OPEN_READWRITE: 2,
    },
  };
});

const mockExistsSync = vi.fn().mockReturnValue(true);
const mockCopyFileSync = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    copyFileSync: mockCopyFileSync,
    promises: {
      ...actual.promises,
      unlink: mockUnlink,
    },
  };
});

// Helper to set up default mock database responses
function setupDefaultDbMocks(settings: Record<string, unknown> = {}) {
  const jsonValue = JSON.stringify(settings);
  mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string | Buffer }) => void) => {
    callback(null, { value: jsonValue });
  });
  mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
    callback(null);
  });
  mockDbRun.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
    callback(null);
  });
}

describe('RooSettingsService', () => {
  let RooSettingsService: any;
  let SYNC_SAFE_KEYS: Set<string>;
  let EXCLUDED_KEYS: Set<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    setupDefaultDbMocks({
      autoCondenseContext: true,
      autoCondenseContextPercent: 75,
      apiProvider: 'openai',
      taskHistory: ['task1', 'task2'],
      id: 'machine-uuid',
      language: 'fr',
    });

    const mod = await import('../RooSettingsService');
    RooSettingsService = mod.RooSettingsService;
    SYNC_SAFE_KEYS = mod.SYNC_SAFE_KEYS;
    EXCLUDED_KEYS = mod.EXCLUDED_KEYS;
  });

  // ==================== Construction & Path ====================

  describe('getStateDbPath', () => {
    it('should return path ending with state.vscdb', () => {
      const service = new RooSettingsService();
      const path = service.getStateDbPath();
      expect(path).toContain('state.vscdb');
      expect(path).toContain('globalStorage');
    });
  });

  describe('isAvailable', () => {
    it('should return true when state.vscdb exists', () => {
      mockExistsSync.mockReturnValue(true);
      const service = new RooSettingsService();
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when state.vscdb does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const service = new RooSettingsService();
      expect(service.isAvailable()).toBe(false);
    });
  });

  // ==================== extractSettings ====================

  describe('extractSettings', () => {
    it('should throw if state.vscdb does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const service = new RooSettingsService();
      await expect(service.extractSettings()).rejects.toThrow('state.vscdb not found');
    });

    it('should extract safe-mode settings (only SYNC_SAFE_KEYS)', async () => {
      const service = new RooSettingsService();
      const result = await service.extractSettings('safe');

      expect(result.metadata.mode).toBe('safe');
      expect(result.settings).toHaveProperty('autoCondenseContext');
      expect(result.settings).toHaveProperty('apiProvider');
      // Excluded keys should not appear
      expect(result.settings).not.toHaveProperty('taskHistory');
      expect(result.settings).not.toHaveProperty('id');
    });

    it('should extract full-mode settings (all except EXCLUDED_KEYS)', async () => {
      const service = new RooSettingsService();
      const result = await service.extractSettings('full');

      expect(result.metadata.mode).toBe('full');
      expect(result.settings).toHaveProperty('autoCondenseContext');
      // Safe keys + non-excluded non-safe keys
      expect(result.settings).toHaveProperty('language');
      // Still excluded
      expect(result.settings).not.toHaveProperty('taskHistory');
      expect(result.settings).not.toHaveProperty('id');
    });

    it('should include correct metadata', async () => {
      const service = new RooSettingsService();
      const result = await service.extractSettings('safe');

      expect(result.metadata).toHaveProperty('machine');
      expect(result.metadata).toHaveProperty('timestamp');
      expect(result.metadata).toHaveProperty('keysCount');
      expect(result.metadata).toHaveProperty('totalKeys');
      expect(result.metadata.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle Buffer value from sqlite', async () => {
      const settings = { apiProvider: 'openai' };
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string | Buffer }) => void) => {
        callback(null, { value: Buffer.from(JSON.stringify(settings)) });
      });

      const service = new RooSettingsService();
      const result = await service.extractSettings('safe');
      expect(result.settings).toHaveProperty('apiProvider');
    });

    it('should throw if VSCDB_KEY not found in database', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
        callback(null, undefined);
      });

      const service = new RooSettingsService();
      await expect(service.extractSettings()).rejects.toThrow('not found in state.vscdb');
    });

    it('should throw on database open error', async () => {
      // Import the mocked module and get the Database constructor from default
      const sqlite3 = await import('sqlite3');
      const Database = (sqlite3 as any).default.Database;
      vi.mocked(Database).mockImplementationOnce((_path: string, _mode: number, callback: (err: Error | null) => void) => {
        setTimeout(() => callback(new Error('SQLITE_CANTOPEN')), 0);
        return mockDatabaseInstance;
      });

      const service = new RooSettingsService();
      await expect(service.extractSettings()).rejects.toThrow('Cannot open state.vscdb');
    });
  });

  // ==================== injectSettings ====================

  describe('injectSettings', () => {
    it('should throw if state.vscdb does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const service = new RooSettingsService();
      await expect(service.injectSettings({})).rejects.toThrow('state.vscdb not found');
    });

    it('should only inject sync-safe keys by default', async () => {
      const service = new RooSettingsService();
      const result = await service.injectSettings({
        apiProvider: 'anthropic',
        taskHistory: ['should-be-ignored'],
      });

      // apiProvider is sync-safe and different from current → should be in changes
      expect(result.changes.some((c: any) => c.key === 'apiProvider')).toBe(true);
      // taskHistory is not sync-safe → should not appear
      expect(result.changes.some((c: any) => c.key === 'taskHistory')).toBe(false);
    });

    it('should inject specific keys when options.keys provided', async () => {
      const service = new RooSettingsService();
      const result = await service.injectSettings(
        { apiProvider: 'anthropic', language: 'en' },
        { keys: ['language'] }
      );

      expect(result.changes.some((c: any) => c.key === 'language')).toBe(true);
      expect(result.changes.some((c: any) => c.key === 'apiProvider')).toBe(false);
    });

    it('should return dryRun=true without applying changes', async () => {
      const service = new RooSettingsService();
      const result = await service.injectSettings(
        { apiProvider: 'anthropic' },
        { dryRun: true }
      );

      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(0);
      // dbRun should NOT be called (no write)
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('should return applied=0 when no changes detected', async () => {
      // Current settings already match
      setupDefaultDbMocks({ apiProvider: 'openai' });

      const service = new RooSettingsService();
      const result = await service.injectSettings({ apiProvider: 'openai' });

      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it('should apply changes and return count', async () => {
      const service = new RooSettingsService();
      const result = await service.injectSettings({
        apiProvider: 'anthropic',
        autoCondenseContextPercent: 50,
      });

      expect(result.applied).toBeGreaterThan(0);
      expect(result.dryRun).toBe(false);
      // writeToVscdb should be called
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('should include old and new values in changes', async () => {
      const service = new RooSettingsService();
      const result = await service.injectSettings({ apiProvider: 'anthropic' });

      const change = result.changes.find((c: any) => c.key === 'apiProvider');
      expect(change).toBeDefined();
      expect(change.oldValue).toBe('openai');
      expect(change.newValue).toBe('anthropic');
    });

    it('should create backup before writing', async () => {
      const service = new RooSettingsService();
      await service.injectSettings({ apiProvider: 'anthropic' });

      expect(mockCopyFileSync).toHaveBeenCalled();
    });
  });

  // ==================== getSetting ====================

  describe('getSetting', () => {
    it('should return value for existing key', async () => {
      const service = new RooSettingsService();
      const value = await service.getSetting('apiProvider');
      expect(value).toBe('openai');
    });

    it('should return undefined for missing key', async () => {
      const service = new RooSettingsService();
      const value = await service.getSetting('nonexistent_key');
      expect(value).toBeUndefined();
    });
  });

  // ==================== Exported Key Sets ====================

  describe('SYNC_SAFE_KEYS', () => {
    it('should contain essential sync keys', () => {
      expect(SYNC_SAFE_KEYS.has('autoCondenseContext')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('apiProvider')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('mode')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('language')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('mcpEnabled')).toBe(true);
    });

    it('should not contain excluded keys', () => {
      expect(SYNC_SAFE_KEYS.has('taskHistory')).toBe(false);
      expect(SYNC_SAFE_KEYS.has('id')).toBe(false);
      expect(SYNC_SAFE_KEYS.has('clerk-auth-state')).toBe(false);
    });

    it('should have 80+ keys', () => {
      expect(SYNC_SAFE_KEYS.size).toBeGreaterThanOrEqual(80);
    });
  });

  describe('EXCLUDED_KEYS', () => {
    it('should contain machine-specific keys', () => {
      expect(EXCLUDED_KEYS.has('id')).toBe(true);
      expect(EXCLUDED_KEYS.has('taskHistory')).toBe(true);
      expect(EXCLUDED_KEYS.has('clerk-auth-state')).toBe(true);
    });

    it('should not contain safe keys', () => {
      expect(EXCLUDED_KEYS.has('apiProvider')).toBe(false);
      expect(EXCLUDED_KEYS.has('mode')).toBe(false);
    });
  });

  // ==================== Error Paths ====================

  describe('Error handling', () => {
    it('should handle dbGet error during read', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
        callback(new Error('SQLITE_ERROR'));
      });

      const service = new RooSettingsService();
      await expect(service.extractSettings()).rejects.toThrow('SQLITE_ERROR');
    });

    it('should handle dbClose error gracefully', async () => {
      mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
        callback(new Error('close error'));
      });

      const service = new RooSettingsService();
      // Should still resolve (error in close propagates)
      await expect(service.extractSettings()).rejects.toThrow('close error');
    });

    it('should handle unlink error silently during cleanup', async () => {
      mockUnlink.mockRejectedValue(new Error('unlink failed'));

      const service = new RooSettingsService();
      // Should NOT throw — cleanup errors are silently ignored
      const result = await service.extractSettings('safe');
      expect(result).toBeDefined();
    });

    it('should handle dbRun error during write', async () => {
      mockDbRun.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
        callback(new Error('write error'));
      });

      const service = new RooSettingsService();
      await expect(service.injectSettings({ apiProvider: 'new' })).rejects.toThrow('write error');
    });
  });
});
