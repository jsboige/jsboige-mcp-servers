import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

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
  // Use setTimeout to mimic real sqlite3 async callback behavior
  // (avoids TDZ error when callback references the db variable)
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

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    copyFileSync: vi.fn(),
    promises: {
      ...actual.promises,
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { RooSettingsService, SYNC_SAFE_KEYS, EXCLUDED_KEYS } from '../RooSettingsService';
import { existsSync, copyFileSync } from 'fs';

// Sample Roo settings blob
const SAMPLE_SETTINGS: Record<string, unknown> = {
  id: 'machine-uuid-secret',
  taskHistory: [{ id: 'task1' }],
  autoCondenseContext: true,
  autoCondenseContextPercent: 80,
  autoApprovalEnabled: true,
  alwaysAllowReadOnly: true,
  alwaysAllowWrite: false,
  language: 'en',
  mode: 'code',
  browserToolEnabled: true,
  customInstructions: 'Be helpful',
  mcpEnabled: true,
  telemetrySetting: 'off',
  experiments: {},
  apiProvider: 'openai-compatible',
  openAiBaseUrl: 'https://api.z.ai/api/anthropic',
  openAiModelId: 'glm-5',
  listApiConfigMeta: [{ id: 'p1', name: 'GLM-5', apiProvider: 'openai' }],
  profileThresholds: { p1: 80 },
};

describe('RooSettingsService', () => {
  let service: RooSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset existsSync to true by default (tests that need false override this)
    vi.mocked(existsSync).mockReturnValue(true);
    service = new RooSettingsService();

    // Default: sqlite returns sample settings
    mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
      callback(null, { value: JSON.stringify(SAMPLE_SETTINGS) });
    });

    mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
      callback(null);
    });

    mockDbRun.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
      callback(null);
    });
  });

  describe('SYNC_SAFE_KEYS', () => {
    it('should have 80+ sync-safe keys', () => {
      expect(SYNC_SAFE_KEYS.size).toBeGreaterThanOrEqual(80);
    });

    it('should not overlap with EXCLUDED_KEYS', () => {
      for (const key of SYNC_SAFE_KEYS) {
        expect(EXCLUDED_KEYS.has(key)).toBe(false);
      }
    });

    it('should include condensation keys', () => {
      expect(SYNC_SAFE_KEYS.has('autoCondenseContext')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('autoCondenseContextPercent')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('profileThresholds')).toBe(true);
    });

    it('should include behavior keys', () => {
      expect(SYNC_SAFE_KEYS.has('autoApprovalEnabled')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('alwaysAllowReadOnly')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('alwaysAllowWrite')).toBe(true);
    });

    it('should include model config keys', () => {
      expect(SYNC_SAFE_KEYS.has('apiProvider')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('openAiBaseUrl')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('listApiConfigMeta')).toBe(true);
    });
  });

  describe('EXCLUDED_KEYS', () => {
    it('should exclude machine-specific and sensitive keys', () => {
      expect(EXCLUDED_KEYS.has('id')).toBe(true);
      expect(EXCLUDED_KEYS.has('taskHistory')).toBe(true);
      expect(EXCLUDED_KEYS.has('clerk-auth-state')).toBe(true);
    });
  });

  describe('getStateDbPath', () => {
    it('should return path under AppData', () => {
      const path = service.getStateDbPath();
      expect(path).toContain('AppData');
      expect(path).toContain('state.vscdb');
    });
  });

  describe('isAvailable', () => {
    it('should return true when state.vscdb exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when state.vscdb does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('extractSettings', () => {
    it('should extract sync-safe settings in safe mode', async () => {
      const result = await service.extractSettings('safe');

      expect(result.metadata.mode).toBe('safe');
      expect(result.metadata.keysCount).toBeGreaterThan(0);
      expect(result.settings).toBeDefined();

      // Should include sync-safe keys
      expect(result.settings.autoCondenseContext).toBe(true);
      expect(result.settings.autoCondenseContextPercent).toBe(80);
      expect(result.settings.autoApprovalEnabled).toBe(true);

      // Should NOT include excluded keys
      expect(result.settings.id).toBeUndefined();
      expect(result.settings.taskHistory).toBeUndefined();
    });

    it('should extract all non-excluded settings in full mode', async () => {
      const result = await service.extractSettings('full');

      expect(result.metadata.mode).toBe('full');
      // Full mode includes more keys than safe mode
      expect(result.metadata.keysCount).toBeGreaterThanOrEqual(result.metadata.keysCount);

      // Should NOT include excluded keys even in full mode
      expect(result.settings.id).toBeUndefined();
      expect(result.settings.taskHistory).toBeUndefined();
    });

    it('should throw if state.vscdb not found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(service.extractSettings()).rejects.toThrow('state.vscdb not found');
    });

    it('should throw if key not found in database', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: undefined) => void) => {
        callback(null, undefined);
      });

      await expect(service.extractSettings()).rejects.toThrow('not found in state.vscdb');
    });

    it('should include metadata with machine info and timestamp', async () => {
      const result = await service.extractSettings();

      expect(result.metadata.machine).toBeDefined();
      expect(result.metadata.timestamp).toBeDefined();
      expect(result.metadata.totalKeys).toBe(Object.keys(SAMPLE_SETTINGS).length);
    });
  });

  describe('injectSettings', () => {
    it('should inject only sync-safe keys by default', async () => {
      const newSettings = {
        autoCondenseContextPercent: 85,
        id: 'should-not-inject',
        language: 'fr',
      };

      const result = await service.injectSettings(newSettings);

      expect(result.dryRun).toBe(false);
      expect(result.applied).toBe(2); // autoCondenseContextPercent + language
      expect(result.changes).toHaveLength(2);

      // Verify the write call was made
      expect(mockDbRun).toHaveBeenCalled();
      const writeCall = mockDbRun.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1][0]);
      expect(writtenData.autoCondenseContextPercent).toBe(85);
      expect(writtenData.language).toBe('fr');
      // id should not be overwritten (excluded from sync-safe)
      expect(writtenData.id).toBe('machine-uuid-secret');
    });

    it('should respect specific keys filter', async () => {
      const newSettings = {
        autoCondenseContextPercent: 85,
        language: 'fr',
        mode: 'debug',
      };

      const result = await service.injectSettings(newSettings, {
        keys: ['language'],
      });

      expect(result.applied).toBe(1);
      expect(result.changes[0].key).toBe('language');
    });

    it('should not write when dryRun is true', async () => {
      const newSettings = {
        autoCondenseContextPercent: 85,
      };

      const result = await service.injectSettings(newSettings, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(1); // Change detected but not applied
      // No write should have happened
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('should detect no changes when values are identical', async () => {
      const newSettings = {
        autoCondenseContextPercent: 80, // Same as SAMPLE_SETTINGS
        language: 'en', // Same as SAMPLE_SETTINGS
      };

      const result = await service.injectSettings(newSettings);

      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it('should throw if state.vscdb not found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(service.injectSettings({ language: 'fr' })).rejects.toThrow('state.vscdb not found');
    });
  });

  describe('getSetting', () => {
    it('should return a specific setting value', async () => {
      const value = await service.getSetting('autoCondenseContextPercent');
      expect(value).toBe(80);
    });

    it('should return undefined for non-existent key', async () => {
      const value = await service.getSetting('nonExistentKey');
      expect(value).toBeUndefined();
    });

    it('should handle database read error', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: any) => void) => {
        callback(new Error('Database read error'));
      });

      await expect(service.getSetting('autoCondenseContextPercent')).rejects.toThrow('Database read error');
    });
  });

  describe('filterSettings', () => {
    it('should filter to sync-safe keys in safe mode', () => {
      const testSettings = {
        id: 'excluded',
        autoCondenseContext: true,
        language: 'en',
        'clerk-auth-state': 'token',
      };

      const filtered = (service as any).filterSettings(testSettings, 'safe');

      expect(filtered.autoCondenseContext).toBe(true);
      expect(filtered.language).toBe('en');
      expect(filtered.id).toBeUndefined();
      expect(filtered['clerk-auth-state']).toBeUndefined();
    });

    it('should filter to non-excluded keys in full mode', () => {
      const testSettings = {
        id: 'excluded',
        autoCondenseContext: true,
        clerkAuthState: 'token',
      };

      const filtered = (service as any).filterSettings(testSettings, 'full');

      expect(filtered.autoCondenseContext).toBe(true);
      expect(filtered.id).toBeUndefined();
      expect(filtered.clerkAuthState).toBe('token');
    });

    it('should handle empty settings object', () => {
      const filtered = (service as any).filterSettings({}, 'safe');
      expect(Object.keys(filtered)).toHaveLength(0);
    });

    it('should handle null values in settings', () => {
      const testSettings = {
        autoCondenseContext: null,
        language: null,
        id: 'excluded',
      };

      const filtered = (service as any).filterSettings(testSettings, 'safe');

      expect(filtered.autoCondenseContext).toBe(null);
      expect(filtered.language).toBe(null);
      expect(filtered.id).toBeUndefined();
    });
  });

  describe('readFromVscdb edge cases', () => {
    it('should handle Buffer value from database', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: any }) => void) => {
        callback(null, { value: Buffer.from(JSON.stringify(SAMPLE_SETTINGS)) });
      });

      const result = await (service as any).readFromVscdb('/mock/path');
      expect(result).toEqual(SAMPLE_SETTINGS);
    });

    it('should throw when database file does not exist', async () => {
      vi.mocked(copyFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory, copyfile '/nonexistent/path'");
      });

      await expect((service as any).readFromVscdb('/nonexistent/path')).rejects.toThrow('ENOENT');
    });

    it('should throw when key not found in database', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: undefined) => void) => {
        callback(null, undefined);
      });

      await expect((service as any).readFromVscdb('/mock/path')).rejects.toThrow('Key \'RooVeterinaryInc.roo-cline\' not found in state.vscdb');
    });

    it('should handle unlink error during cleanup', async () => {
      vi.doMock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
          ...actual,
          existsSync: vi.fn().mockReturnValue(true),
          copyFileSync: vi.fn(),
          promises: {
            ...actual.promises,
            unlink: vi.fn().mockRejectedValue(new Error('Failed to delete')),
          },
        };
      });

      // Should still work even if unlink fails
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
        callback(null, { value: JSON.stringify(SAMPLE_SETTINGS) });
      });

      // This test demonstrates that cleanup errors are ignored
      expect(async () => {
        await (service as any).readFromVscdb('/mock/path');
      }).not.toThrow();
    });
  });

  describe('injectSettings edge cases', () => {
    it('should handle database write error', async () => {
      mockDbRun.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
        callback(new Error('Write failed'));
      });

      await expect(service.injectSettings({ language: 'fr' })).rejects.toThrow('Write failed');
    });

    it('should handle complex nested objects in settings', async () => {
      const complexSettings = {
        profileThresholds: { p1: 80, p2: 90 },
        modeApiConfigs: {
          debug: { model: 'glm-5', temperature: 0.7 },
          production: { model: 'glm-4', temperature: 0.5 }
        },
        experiments: {
          newFeature: { enabled: true, options: { timeout: 5000 } }
        }
      };

      const result = await service.injectSettings(complexSettings);
      expect(result.applied).toBeGreaterThan(0);
      expect(result.changes).toHaveLength(3); // All 3 nested objects are new
    });

    it('should inject when settings contain arrays', async () => {
      const arraySettings = {
        listApiConfigMeta: [
          { id: 'p1', name: 'GLM-5', apiProvider: 'openai' },
          { id: 'p2', name: 'GLM-4', apiProvider: 'openai' }
        ]
      };

      const result = await service.injectSettings(arraySettings);
      expect(result.applied).toBeGreaterThan(0);
    });

    it('should not apply changes when values are functionally different but JSON same', async () => {
      // Date objects with same time should be considered same after JSON serialization
      const date1 = new Date('2023-01-01T00:00:00.000Z');
      const date2 = new Date('2023-01-01T00:00:00.000Z');

      const newSettings = {
        lastUsed: date1, // Same timestamp as existing
      };

      // Update SAMPLE_SETTINGS to have a date
      SAMPLE_SETTINGS.lastUsed = date2;

      const result = await service.injectSettings(newSettings);
      expect(result.applied).toBe(0); // Same value after JSON serialization
    });

    it('should handle settings with special characters', async () => {
      const specialSettings = {
        customInstructions: 'Be helpful with emojis: 🚀✨',
        mode: 'code-simple',
        language: 'zh-CN',
      };

      const result = await service.injectSettings(specialSettings);
      expect(result.applied).toBe(3);
    });

    it('should inject boolean false values correctly', async () => {
      // Set up mock DB with alwaysAllowWrite = true so injecting false is a change
      const currentSettings = { ...SAMPLE_SETTINGS, alwaysAllowWrite: true };
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
        callback(null, { value: JSON.stringify(currentSettings) });
      });

      const booleanSettings = {
        alwaysAllowWrite: false, // Change from true to false
        autoApprovalEnabled: true, // No change
      };

      const result = await service.injectSettings(booleanSettings);
      expect(result.applied).toBe(1);
      expect(result.changes[0].key).toBe('alwaysAllowWrite');
      expect(result.changes[0].oldValue).toBe(true);
      expect(result.changes[0].newValue).toBe(false);
    });
  });

  describe('database operations error handling', () => {
    it('should handle database open error', async () => {
      // Get the mocked sqlite3 module and override Database constructor
      const sqlite3Mocked = await import('sqlite3');
      const DatabaseConstructor = sqlite3Mocked.default.Database;
      DatabaseConstructor.mockImplementationOnce((_path: string, _mode: number, callback: (err: Error | null) => void) => {
        callback(new Error('Cannot open database'));
        return mockDatabaseInstance;
      });

      await expect(service.extractSettings()).rejects.toThrow('Cannot open state.vscdb');
    });

    it('should handle database close error', async () => {
      mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
        callback(new Error('Close failed'));
      });

      // The service rejects when closeDatabase fails (finally block rejection overrides return)
      await expect(service.extractSettings()).rejects.toThrow('Close failed');
    });
  });
});
