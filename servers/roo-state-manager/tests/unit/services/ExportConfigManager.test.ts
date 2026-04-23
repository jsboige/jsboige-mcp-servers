import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExportConfigManager } from '../../../src/services/ExportConfigManager';
import { ExportConfigManagerError, ExportConfigManagerErrorCode } from '../../../src/types/errors';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock modules
vi.mock('fs/promises');
vi.mock('../../../src/utils/roo-storage-detector', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn()
  }
}));
const mockedFs = vi.mocked(fs);
const mockedStorageDetector = vi.mocked(await import('../../../src/utils/roo-storage-detector')).RooStorageDetector;

describe('ExportConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset storage detector to return a test location
    mockedStorageDetector.detectStorageLocations.mockResolvedValue([
      '/mock/storage/tasks/123.json'
    ]);
  });

  describe('constructor', () => {
    it('should initialize without path', () => {
      expect(new ExportConfigManager()).toBeDefined();
    });
  });

  describe('getConfig', () => {
    beforeEach(() => {
      // Mock storage detector to return test location
      mockedStorageDetector.detectStorageLocations.mockResolvedValue([
        '/mock/storage/tasks/123.json'
      ]);
    });

    it('should return default configuration when no config file exists', async () => {
      mockedFs.access.mockRejectedValue(new Error('File not found'));
      mockedFs.mkdir.mockResolvedValue();
      mockedFs.writeFile.mockResolvedValue();

      const manager = new ExportConfigManager();
      const config = await manager.getConfig();

      expect(config).toEqual({
        defaults: {
          prettyPrint: true,
          includeContent: false,
          compression: 'none'
        },
        templates: {
          jira_export: {
            format: 'simplified',
            fields: ['taskId', 'title', 'user_messages_only']
          },
          full_export: {
            format: 'complete',
            fields: ['taskId', 'title', 'metadata', 'sequence']
          }
        },
        filters: {
          last_week: {
            startDate: 'now-7d',
            endDate: 'now'
          },
          debug_tasks: {
            mode: 'debug-complex'
          }
        }
      });

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"prettyPrint": true'),
        expect.any(String)
      );
    });

    it('should return cached configuration', async () => {
      // First call to load config
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        defaults: { prettyPrint: false }
      }));

      const manager = new ExportConfigManager();
      const config1 = await manager.getConfig();
      const config2 = await manager.getConfig();

      expect(config1).toBe(config2); // Same instance from cache
    });

    it('should handle BOM in JSON file', async () => {
      const bomContent = '\ufeff{"defaults": {"prettyPrint": false}}';
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(bomContent);

      const manager = new ExportConfigManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(false);
    });

    it('should handle corrupted JSON file', async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue('invalid json');

      const manager = new ExportConfigManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(true); // Default value
      expect(config.templates.jira_export).toBeDefined();
    });

    it('should handle file access errors gracefully', async () => {
      mockedFs.access.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const manager = new ExportConfigManager();
      const config = await manager.getConfig();

      expect(config).toEqual({
        defaults: {
          prettyPrint: true,
          includeContent: false,
          compression: 'none'
        },
        templates: {
          jira_export: {
            format: 'simplified',
            fields: ['taskId', 'title', 'user_messages_only']
          },
          full_export: {
            format: 'complete',
            fields: ['taskId', 'title', 'metadata', 'sequence']
          }
        },
        filters: {
          last_week: {
            startDate: 'now-7d',
            endDate: 'now'
          },
          debug_tasks: {
            mode: 'debug-complex'
          }
        }
      });
    });
  });

  describe('updateConfig', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        defaults: { prettyPrint: false },
        templates: {},
        filters: {}
      }));
      mockedFs.mkdir.mockResolvedValue();
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should update partial configuration', async () => {
      const manager = new ExportConfigManager();
      await manager.updateConfig({
        defaults: {
          prettyPrint: false,
          includeContent: true
        }
      });

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"prettyPrint": false'),
        expect.any(String)
      );
    });

    it('should merge with existing configuration', async () => {
      const manager = new ExportConfigManager();

      // Set initial config
      await manager.updateConfig({
        templates: {
          newTemplate: {
            format: 'json',
            fields: ['id']
          }
        }
      });

      // Update and preserve existing
      await manager.updateConfig({
        filters: {
          newFilter: {
            startDate: '2026-01-01'
          }
        }
      });

      // Verify both templates and filters exist
      const config = await manager.getConfig();
      expect(config.templates.newTemplate).toBeDefined();
      expect(config.filters.newFilter).toBeDefined();
    });
  });

  describe('resetConfig', () => {
    beforeEach(async () => {
      mockedFs.mkdir.mockResolvedValue();
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should reset to default configuration', async () => {
      const manager = new ExportConfigManager();
      await manager.resetConfig();

      // Check that the cache was updated with default config
      const config = await manager.getConfig();
      expect(config).toEqual({
        defaults: {
          prettyPrint: true,
          includeContent: false,
          compression: 'none'
        },
        templates: {
          jira_export: {
            format: 'simplified',
            fields: ['taskId', 'title', 'user_messages_only']
          },
          full_export: {
            format: 'complete',
            fields: ['taskId', 'title', 'metadata', 'sequence']
          }
        },
        filters: {
          last_week: {
            startDate: 'now-7d',
            endDate: 'now'
          },
          debug_tasks: {
            mode: 'debug-complex'
          }
        }
      });
    });

    it('should save default config to file', async () => {
      const manager = new ExportConfigManager();
      await manager.resetConfig();

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"prettyPrint": true'),
        expect.any(String)
      );
    });
  });

  describe('saveConfig', () => {
    beforeEach(async () => {
      mockedFs.mkdir.mockResolvedValue();
    });

    it('should create directory if it does not exist', async () => {
      const manager = new ExportConfigManager();

      // Mock mkdir to verify directory creation - use path.normalize to handle Windows paths
      mockedFs.mkdir.mockImplementation((path, options) => {
        const normalizedPath = path.replace(/\\/g, '/');
        expect(normalizedPath).toContain('storage/tasks');
        return Promise.resolve();
      });

      await manager.saveConfig({
        defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
        templates: {},
        filters: {}
      });
    });

    it('should handle save errors with custom error', async () => {
      mockedFs.writeFile.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const manager = new ExportConfigManager();

      await expect(manager.saveConfig({
        defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
        templates: {},
        filters: {}
      })).rejects.toThrow('Permission denied');
    });
  });

  describe('addTemplate', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        templates: {
          existing: { format: 'xml', fields: ['id'] }
        }
      }));
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should add a new template', async () => {
      const manager = new ExportConfigManager();
      await manager.addTemplate('newTemplate', {
        format: 'json',
        fields: ['task', 'status', 'priority']
      });

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"newTemplate"'),
        expect.any(String)
      );
    });

    it('should update existing template', async () => {
      const manager = new ExportConfigManager();
      await manager.addTemplate('existing', {
        format: 'csv',
        fields: ['id', 'title']
      });

      const config = await manager.getConfig();
      expect(config.templates.existing.format).toBe('csv');
    });
  });

  describe('removeTemplate', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        templates: {
          existing: { format: 'xml', fields: ['id'] }
        }
      }));
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should remove existing template', async () => {
      const manager = new ExportConfigManager();
      const result = await manager.removeTemplate('existing');

      expect(result).toBe(true);
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('"existing"'),
        expect.any(String)
      );
    });

    it('should return false for non-existent template', async () => {
      const manager = new ExportConfigManager();
      const result = await manager.removeTemplate('nonExistent');

      expect(result).toBe(false);
    });
  });

  describe('addFilter', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        filters: {
          existing: { startDate: '2026-01-01' }
        }
      }));
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should add a new filter', async () => {
      const manager = new ExportConfigManager();
      await manager.addFilter('newFilter', {
        startDate: '2026-05-01',
        endDate: '2026-05-31'
      });

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"newFilter"'),
        expect.any(String)
      );
    });

    it('should update existing filter', async () => {
      const manager = new ExportConfigManager();
      await manager.addFilter('existing', {
        startDate: '2026-06-01',
        mode: 'light'
      });

      const config = await manager.getConfig();
      expect(config.filters.existing.startDate).toBe('2026-06-01');
      expect(config.filters.existing.mode).toBe('light');
    });
  });

  describe('removeFilter', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue(JSON.stringify({
        filters: {
          existing: { startDate: '2026-01-01' }
        }
      }));
      mockedFs.writeFile.mockResolvedValue();
    });

    it('should remove existing filter', async () => {
      const manager = new ExportConfigManager();
      const result = await manager.removeFilter('existing');

      expect(result).toBe(true);
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('"existing"'),
        expect.any(String)
      );
    });

    it('should return false for non-existent filter', async () => {
      const manager = new ExportConfigManager();
      const result = await manager.removeFilter('nonExistent');

      expect(result).toBe(false);
    });
  });

  describe('getConfigFilePath', () => {
    beforeEach(async () => {
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue('{}');
    });

    it('should return the config file path', async () => {
      const manager = new ExportConfigManager();
      const path = await manager.getConfigFilePath();

      expect(path).toContain('xml_export_config.json');
    });

    it('should detect path lazily if not initialized', async () => {
      const manager = new ExportConfigManager();
      mockedStorageDetector.detectStorageLocations.mockResolvedValue([
        '/new/path/tasks/123.json'
      ]);

      const path = await manager.getConfigFilePath();

      expect(path).toContain('xml_export_config.json');
    });
  });

  describe('invalidateCache', () => {
    it('should clear the config cache', async () => {
      const manager = new ExportConfigManager();

      // Load config to populate cache
      mockedFs.access.mockResolvedValue();
      mockedFs.readFile.mockResolvedValue('{}');
      await manager.getConfig();

      // Invalidate cache
      manager.invalidateCache();

      // Reload should not return cached version
      mockedFs.access.mockRejectedValue(new Error('File not found'));
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(true); // Default value
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      // Mock storage detector to throw error
      mockedStorageDetector.detectStorageLocations.mockRejectedValue(
        new Error('Storage not found')
      );
    });

    it('should throw ExportConfigManagerError when no storage is detected', async () => {
      // Create a fresh manager to avoid any caching from global beforeEach
      const manager = new ExportConfigManager();

      // Override the storage detector to return empty array
      mockedStorageDetector.detectStorageLocations.mockResolvedValue([]);

      await expect(manager.getConfig()).rejects.toThrow(ExportConfigManagerError);
      await expect(manager.getConfig()).rejects.toHaveProperty(
        'code',
        ExportConfigManagerErrorCode.NO_STORAGE_DETECTED
      );
    });

    it('should handle config save errors with custom error', async () => {
      mockedFs.mkdir.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const manager = new ExportConfigManager();

      await expect(manager.saveConfig({
        defaults: { prettyPrint: true },
        templates: {},
        filters: {}
      })).rejects.toThrow(ExportConfigManagerError);
    });
  });

  describe('private mergeWithDefaults', () => {
    it('should merge partial config with defaults', async () => {
      const manager = new ExportConfigManager();

      // Access private method using reflection
      const mergeWithDefaults = (manager as any).mergeWithDefaults({
        defaults: { prettyPrint: false },
        templates: { new: { format: 'json', fields: ['id'] } }
      });

      expect(mergeWithDefaults).toEqual({
        defaults: {
          prettyPrint: false,
          includeContent: false,
          compression: 'none'
        },
        templates: {
          new: { format: 'json', fields: ['id'] },
          jira_export: {
            format: 'simplified',
            fields: ['taskId', 'title', 'user_messages_only']
          },
          full_export: {
            format: 'complete',
            fields: ['taskId', 'title', 'metadata', 'sequence']
          }
        },
        filters: {
          last_week: {
            startDate: 'now-7d',
            endDate: 'now'
          },
          debug_tasks: {
            mode: 'debug-complex'
          }
        }
      });
    });
  });
});