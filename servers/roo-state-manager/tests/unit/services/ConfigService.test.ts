import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { ConfigService } from '../../../src/Services/ConfigService';
import { readJSONFileWithoutBOM } from '../../../src/utils/encoding-helpers.js';
import { ConfigServiceError, ConfigServiceErrorCode } from '../../../src/types/errors.js';

describe('ConfigService', () => {
  let service: ConfigService;
  const mockConfigPath = '/test/config.json';
  const mockSharedStatePath = '/test/shared-state';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.USERPROFILE;
    delete process.env.ROO_ROOT;

    service = new ConfigService(mockConfigPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should create service with default config path', () => {
      service = new ConfigService();
      expect(service).toBeInstanceOf(ConfigService);
    });

    it('should create service with custom config path', () => {
      service = new ConfigService(mockConfigPath);
      expect(service).toBeInstanceOf(ConfigService);
    });
  });

  describe('getBaselineServiceConfig', () => {
    it('should return baseline service config', () => {
      const config = service.getBaselineServiceConfig();
      expect(config).toHaveProperty('baselinePath');
      expect(config).toHaveProperty('roadmapPath');
      expect(config).toHaveProperty('cacheEnabled');
      expect(config).toHaveProperty('cacheTTL');
      expect(config).toHaveProperty('logLevel');
      expect(config.cacheEnabled).toBe(true);
      expect(config.cacheTTL).toBe(3600000);
      expect(config.logLevel).toBe('INFO');
    });
  });

  describe('getSharedStatePath', () => {
    it('should return shared state path from constructor', () => {
      expect(service.getSharedStatePath()).toBe(mockSharedStatePath);
    });

    it('should use ROOSYNC_SHARED_PATH environment variable', () => {
      process.env.ROOSYNC_SHARED_PATH = '/custom/path';
      const newService = new ConfigService(mockConfigPath);
      expect(newService.getSharedStatePath()).toBe('/custom/path');
    });
  });

  describe('loadConfig', () => {
    it('should load config successfully', async () => {
      const mockConfig = { test: 'value' };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(mockConfig);

      const config = await service.loadConfig();
      expect(config).toEqual(mockConfig);
      expect(existsSync).toHaveBeenCalledWith(mockConfigPath);
      expect(readJSONFileWithoutBOM).toHaveBeenCalledWith(mockConfigPath);
    });

    it('should return empty object when config file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const config = await service.loadConfig();
      expect(config).toEqual({});
      expect(existsSync).toHaveBeenCalledWith(mockConfigPath);
    });

    it('should throw ConfigServiceError when JSON parsing fails', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new SyntaxError('Invalid JSON'));

      await expect(service.loadConfig()).rejects.toThrow(ConfigServiceError);
      await expect(service.loadConfig()).rejects.toHaveProperty('code', ConfigServiceErrorCode.CONFIG_INVALID);
    });

    it('should throw ConfigServiceError when file reading fails', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new Error('File not found'));

      await expect(service.loadConfig()).rejects.toThrow(ConfigServiceError);
      await expect(service.loadConfig()).rejects.toHaveProperty('code', ConfigServiceErrorCode.CONFIG_LOAD_FAILED);
    });
  });

  describe('saveConfig', () => {
    it('should save config successfully', async () => {
      const config = { test: 'value' };
      vi.mocked(fs.writeFile).mockResolvedValue();

      const result = await service.saveConfig(config);
      expect(result).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify(config, null, 2),
        'utf-8'
      );
    });

    it('should throw ConfigServiceError when file writing fails', async () => {
      const config = { test: 'value' };
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'));

      await expect(service.saveConfig(config)).rejects.toThrow(ConfigServiceError);
      await expect(service.saveConfig(config)).rejects.toHaveProperty('code', ConfigServiceErrorCode.CONFIG_SAVE_FAILED);
    });
  });

  describe('getConfigVersion', () => {
    it('should return config version when sync-config.json exists and has version', async () => {
      const version = '1.0.0';
      const syncConfigPath = path.join(mockSharedStatePath, 'sync-config.json');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue({ version });

      const result = await service.getConfigVersion();
      expect(result).toBe(version);
      expect(existsSync).toHaveBeenCalledWith(syncConfigPath);
      expect(readJSONFileWithoutBOM).toHaveBeenCalledWith(syncConfigPath);
    });

    it('should return null when sync-config.json does not exist', async () => {
      const syncConfigPath = path.join(mockSharedStatePath, 'sync-config.json');
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await service.getConfigVersion();
      expect(result).toBeNull();
      expect(existsSync).toHaveBeenCalledWith(syncConfigPath);
    });

    it('should return null when sync-config.json exists but has no version', async () => {
      const syncConfigPath = path.join(mockSharedStatePath, 'sync-config.json');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue({});

      const result = await service.getConfigVersion();
      expect(result).toBeNull();
    });

    it('should throw ConfigServiceError when JSON parsing fails', async () => {
      const syncConfigPath = path.join(mockSharedStatePath, 'sync-config.json');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new SyntaxError('Invalid JSON'));

      await expect(service.getConfigVersion()).rejects.toThrow(ConfigServiceError);
      await expect(service.getConfigVersion()).rejects.toHaveProperty('code', ConfigServiceErrorCode.CONFIG_INVALID);
    });

    it('should throw ConfigServiceError when file reading fails', async () => {
      const syncConfigPath = path.join(mockSharedStatePath, 'sync-config.json');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new Error('File not found'));

      await expect(service.getConfigVersion()).rejects.toThrow(ConfigServiceError);
      await expect(service.getConfigVersion()).rejects.toHaveProperty('code', ConfigServiceErrorCode.CONFIG_VERSION_READ_FAILED);
    });
  });

  describe('Private methods', () => {
    describe('findConfigPath', () => {
      it('should use ROO_ROOT environment variable when set', () => {
        process.env.ROO_ROOT = '/custom/roo-root';

        const privateService = service as any;
        const result = privateService['findConfigPath']();
        expect(result).toBe('/custom/roo-root/roo-config/settings.json');
      });

      it('should fallback to current working directory when no config found', () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const privateService = service as any;
        const result = privateService['findConfigPath']();
        expect(result).toBe(path.join(process.cwd(), 'roo-config', 'settings.json'));
      });
    });

    describe('findSharedStatePath', () => {
      it('should use ROOSYNC_SHARED_PATH environment variable when set', () => {
        process.env.ROOSYNC_SHARED_PATH = '/custom/shared-state';

        const privateService = service as any;
        const result = privateService['findSharedStatePath']();
        expect(result).toBe('/custom/shared-state');
      });

      it('should fallback to default path when ROOSYNC_SHARED_PATH is not set', () => {
        delete process.env.ROOSYNC_SHARED_PATH;

        const privateService = service as any;
        const result = privateService['findSharedStatePath']();
        expect(result).toBe(process.cwd());
      });
    });
  });
});