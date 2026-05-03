import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockCopyFileSync,
  mockExistsSync,
  mockUnlink,
} = vi.hoisted(() => ({
  mockCopyFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockUnlink: vi.fn(),
}));

const {
  mockDbGet,
  mockDbRun,
  mockDbClose,
} = vi.hoisted(() => ({
  mockDbGet: vi.fn(),
  mockDbRun: vi.fn(),
  mockDbClose: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  copyFileSync: mockCopyFileSync,
  promises: {
    unlink: mockUnlink,
  },
}));

vi.mock('fs/promises', () => ({
  unlink: mockUnlink,
}));

vi.mock('sqlite3', () => {
  function createMockDb() {
    return { get: mockDbGet, run: mockDbRun, close: mockDbClose };
  }
  return {
    default: class {
      static Database: any;
      static OPEN_READONLY = 1;
      static OPEN_READWRITE = 2;
    },
  };
});

// Override Database constructor after mock is set up
const sqlite3 = await import('sqlite3');
(sqlite3.default as any).Database = function MockDatabase(
  this: any,
  path: string,
  mode: number,
  cb: (err: Error | null) => void,
) {
  this.get = mockDbGet;
  this.run = mockDbRun;
  this.close = mockDbClose;
  // Use nextTick so 'db' is assigned before callback fires
  process.nextTick(() => cb(null));
};

vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\testuser',
  tmpdir: () => 'C:\\Temp',
}));

import { RooSettingsService, SYNC_SAFE_KEYS, EXCLUDED_KEYS } from '../../../src/services/RooSettingsService.js';

const SAMPLE_SETTINGS = {
  id: 'machine-uuid',
  autoCondenseContext: true,
  autoCondenseContextPercent: 75,
  apiProvider: 'openai',
  mode: 'code',
  taskHistory: [],
  'clerk-auth-state': 'secret-token',
  language: 'fr',
  mcpEnabled: true,
  browserToolEnabled: true,
  lastShownAnnouncementId: 'ann-123',
  hasOpenedModeSelector: true,
  customInstructions: 'Test instructions',
  modelTemperature: 0.7,
};

function setupDbGetResponse(settings: Record<string, unknown>) {
  mockDbGet.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
    cb(null, { value: JSON.stringify(settings) });
  });
}

function setupDbRunSuccess() {
  mockDbRun.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
    cb(null);
  });
}

describe('RooSettingsService', () => {
  let service: RooSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RooSettingsService();
    mockExistsSync.mockReturnValue(true);
    mockDbClose.mockImplementation((cb: Function) => cb(null));
    mockUnlink.mockResolvedValue(undefined);
    setupDbRunSuccess();
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
    it('should return true when db exists', () => {
      mockExistsSync.mockReturnValue(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when db missing', () => {
      mockExistsSync.mockReturnValue(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('extractSettings', () => {
    it('should throw if state.vscdb not found', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(service.extractSettings()).rejects.toThrow('state.vscdb not found');
    });

    it('should extract only sync-safe keys in safe mode', async () => {
      setupDbGetResponse(SAMPLE_SETTINGS);

      const result = await service.extractSettings('safe');

      expect(result.metadata.mode).toBe('safe');
      expect(result.settings).toHaveProperty('autoCondenseContext');
      expect(result.settings).toHaveProperty('apiProvider');
      expect(result.settings).toHaveProperty('mode');
      expect(result.settings).not.toHaveProperty('id');
      expect(result.settings).not.toHaveProperty('taskHistory');
      expect(result.settings).not.toHaveProperty('clerk-auth-state');
    });

    it('should extract all non-excluded keys in full mode', async () => {
      setupDbGetResponse(SAMPLE_SETTINGS);

      const result = await service.extractSettings('full');

      expect(result.metadata.mode).toBe('full');
      expect(result.settings).toHaveProperty('autoCondenseContext');
      // lastShownAnnouncementId is in EXCLUDED_KEYS, so filtered in full mode too
      expect(result.settings).not.toHaveProperty('id');
      expect(result.settings).not.toHaveProperty('taskHistory');
      expect(result.settings).not.toHaveProperty('clerk-auth-state');
      expect(result.settings).not.toHaveProperty('lastShownAnnouncementId');
      expect(result.settings).not.toHaveProperty('hasOpenedModeSelector');
      // Non-excluded keys ARE included in full mode
      expect(result.settings).toHaveProperty('language');
      expect(result.settings).toHaveProperty('browserToolEnabled');
    });

    it('should populate metadata correctly', async () => {
      setupDbGetResponse({ mode: 'code', apiProvider: 'openai' });

      const result = await service.extractSettings('safe');

      expect(result.metadata).toHaveProperty('machine');
      expect(result.metadata).toHaveProperty('timestamp');
      expect(result.metadata.keysCount).toBeGreaterThan(0);
      expect(result.metadata.totalKeys).toBe(2);
    });

    it('should handle Buffer values from sqlite', async () => {
      const jsonStr = JSON.stringify({ mode: 'code' });
      const buf = Buffer.from(jsonStr, 'utf-8');
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
        cb(null, { value: buf });
      });

      const result = await service.extractSettings('safe');
      expect(result.settings).toHaveProperty('mode', 'code');
    });

    it('should throw if key not found in vscdb', async () => {
      mockDbGet.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
        cb(null, undefined);
      });

      await expect(service.extractSettings()).rejects.toThrow('not found in state.vscdb');
    });
  });

  describe('injectSettings', () => {
    it('should throw if db not found', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(service.injectSettings({})).rejects.toThrow('state.vscdb not found');
    });

    it('should return empty result on dry run', async () => {
      setupDbGetResponse({ mode: 'ask' });

      const result = await service.injectSettings(
        { mode: 'code' },
        { dryRun: true }
      );

      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].key).toBe('mode');
    });

    it('should apply changes and write to db', async () => {
      setupDbGetResponse({ mode: 'ask', apiProvider: 'anthropic' });

      const result = await service.injectSettings({
        mode: 'code',
        apiProvider: 'openai',
      });

      expect(result.applied).toBe(2);
      expect(result.changes).toHaveLength(2);
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('should only inject specified keys when keys option provided', async () => {
      setupDbGetResponse({ mode: 'ask', apiProvider: 'anthropic' });

      const result = await service.injectSettings(
        { mode: 'code', apiProvider: 'openai', language: 'en' },
        { keys: ['mode'] }
      );

      expect(result.applied).toBe(1);
      expect(result.changes[0].key).toBe('mode');
    });

    it('should return empty changes when no differences', async () => {
      setupDbGetResponse({ mode: 'code' });

      const result = await service.injectSettings({ mode: 'code' });

      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it('should only inject sync-safe keys by default', async () => {
      setupDbGetResponse({ mode: 'ask' });

      const result = await service.injectSettings({
        mode: 'code',
        id: 'hacked-uuid',
      });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].key).toBe('mode');
    });
  });

  describe('getSetting', () => {
    it('should return a single setting value', async () => {
      setupDbGetResponse({ mode: 'code', apiProvider: 'openai' });

      const value = await service.getSetting('mode');
      expect(value).toBe('code');
    });

    it('should return undefined for missing key', async () => {
      setupDbGetResponse({ mode: 'code' });

      const value = await service.getSetting('nonexistent');
      expect(value).toBeUndefined();
    });
  });

  describe('SYNC_SAFE_KEYS', () => {
    it('should contain core condensation settings', () => {
      expect(SYNC_SAFE_KEYS.has('autoCondenseContext')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('autoCondenseContextPercent')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('customCondensingPrompt')).toBe(true);
    });

    it('should contain model configuration keys', () => {
      expect(SYNC_SAFE_KEYS.has('apiProvider')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('modelTemperature')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('modeApiConfigs')).toBe(true);
    });

    it('should contain behavior settings', () => {
      expect(SYNC_SAFE_KEYS.has('alwaysAllowReadOnly')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('alwaysAllowWrite')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('allowedCommands')).toBe(true);
    });

    it('should not contain machine-specific or sensitive keys', () => {
      expect(SYNC_SAFE_KEYS.has('id')).toBe(false);
      expect(SYNC_SAFE_KEYS.has('taskHistory')).toBe(false);
      expect(SYNC_SAFE_KEYS.has('clerk-auth-state')).toBe(false);
    });
  });

  describe('EXCLUDED_KEYS', () => {
    it('should contain machine-specific keys', () => {
      expect(EXCLUDED_KEYS.has('id')).toBe(true);
      expect(EXCLUDED_KEYS.has('taskHistory')).toBe(true);
      expect(EXCLUDED_KEYS.has('mcpHubInstanceId')).toBe(true);
    });

    it('should contain auth and UI state keys', () => {
      expect(EXCLUDED_KEYS.has('clerk-auth-state')).toBe(true);
      expect(EXCLUDED_KEYS.has('lastShownAnnouncementId')).toBe(true);
      expect(EXCLUDED_KEYS.has('organization-settings')).toBe(true);
    });

    it('should not contain sync-safe settings', () => {
      expect(EXCLUDED_KEYS.has('autoCondenseContext')).toBe(false);
      expect(EXCLUDED_KEYS.has('apiProvider')).toBe(false);
      expect(EXCLUDED_KEYS.has('mode')).toBe(false);
    });
  });

  describe('temp file cleanup', () => {
    it('should clean up temp db file after read', async () => {
      setupDbGetResponse({ mode: 'code' });

      await service.extractSettings('safe');

      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should not throw if temp cleanup fails', async () => {
      setupDbGetResponse({ mode: 'code' });
      mockUnlink.mockRejectedValue(new Error('cleanup failed'));

      const result = await service.extractSettings('safe');
      expect(result.settings).toHaveProperty('mode', 'code');
    });
  });

  describe('injectSettings backup', () => {
    it('should create backup before writing', async () => {
      setupDbGetResponse({ mode: 'ask' });

      await service.injectSettings({ mode: 'code' });

      expect(mockCopyFileSync).toHaveBeenCalled();
      const backupCall = mockCopyFileSync.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('backup_')
      );
      expect(backupCall).toBeDefined();
    });
  });
});
