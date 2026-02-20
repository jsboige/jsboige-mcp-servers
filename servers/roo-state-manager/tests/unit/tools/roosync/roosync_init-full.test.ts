/**
 * Tests for roosync_init.ts - Full coverage
 * Coverage target: 19.04% → 70%+
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Mock child_process.exec before importing the module
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: any[]) => mockExec(...args),
  promisify: (fn: any) => fn
}));

// Mock fs before importing the module
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args)
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

// Mock RooSyncService
const mockGetConfig = vi.fn();
vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfig: mockGetConfig
  }),
  RooSyncServiceError: class RooSyncServiceError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'RooSyncServiceError';
    }
  }
}));

describe('roosync_init - roosyncInit function', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default mock config
    mockGetConfig.mockReturnValue({
      sharedPath: '/test/shared-path',
      machineId: 'test-machine-01',
      autoSync: false,
      conflictStrategy: 'manual'
    });

    // Default: shared path doesn't exist (will be created)
    mockExistsSync.mockReturnValue(false);

    // Default: PowerShell script doesn't exist
    mockExec.mockImplementation((_cmd: string, _options: any, callback: any) => {
      if (typeof callback === 'function') {
        callback(null, { stdout: '', stderr: '' });
      }
      return {} as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic initialization', () => {
    it('should create shared-state directory if it does not exist', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.success).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith('/test/shared-path', { recursive: true });
      expect(result.filesCreated).toContainEqual(expect.stringContaining('shared-path'));
    });

    it('should skip shared-state directory if it already exists', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        return false;
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.success).toBe(true);
      expect(result.filesSkipped).toContainEqual(expect.stringContaining('déjà existant'));
    });

    it('should create sync-dashboard.json when it does not exist', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesCreated).toContain('sync-dashboard.json');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join('/test/shared-path', 'sync-dashboard.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should skip sync-dashboard.json when it already exists and machine is registered', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        if (path.includes('sync-dashboard.json')) return true;
        return false;
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('sync-dashboard.json')) {
          return JSON.stringify({
            version: '2.0.0',
            machines: {
              'test-machine-01': { lastSync: '2024-01-01', status: 'online' }
            }
          });
        }
        return '';
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesSkipped).toContain('sync-dashboard.json (déjà existant)');
    });

    it('should add machine to existing dashboard if not registered', async () => {
      mockGetConfig.mockReturnValue({
        sharedPath: '/test/shared-path',
        machineId: 'new-machine-02',
        autoSync: false
      });

      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        if (path.includes('sync-dashboard.json')) return true;
        return false;
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('sync-dashboard.json')) {
          return JSON.stringify({
            version: '2.0.0',
            machines: {
              'other-machine': { lastSync: '2024-01-01', status: 'online' }
            }
          });
        }
        return '';
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesCreated).toContain('sync-dashboard.json (machine ajoutée)');
    });
  });

  describe('Force mode', () => {
    it('should overwrite sync-dashboard.json when force is true', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        if (path.includes('sync-dashboard.json')) return true;
        return false;
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({ force: true });

      expect(result.filesCreated).toContain('sync-dashboard.json');
      expect(result.message).toContain('force');
    });

    it('should overwrite sync-roadmap.md when force is true', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        if (path.includes('sync-dashboard.json')) return true;
        if (path.includes('sync-roadmap.md')) return true;
        return false;
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('sync-dashboard.json')) {
          return JSON.stringify({
            version: '2.0.0',
            machines: { 'test-machine-01': { lastSync: '2024-01-01' } }
          });
        }
        return '';
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({ force: true });

      expect(result.filesCreated).toContain('sync-roadmap.md');
    });
  });

  describe('Roadmap creation', () => {
    it('should create sync-roadmap.md by default', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesCreated).toContain('sync-roadmap.md');
    });

    it('should skip sync-roadmap.md when createRoadmap is false', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({ createRoadmap: false });

      expect(result.filesCreated).not.toContain('sync-roadmap.md');
    });

    it('should skip sync-roadmap.md when it already exists', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/test/shared-path') return true;
        if (path.includes('sync-dashboard.json')) return true;
        if (path.includes('sync-roadmap.md')) return true;
        return false;
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('sync-dashboard.json')) {
          return JSON.stringify({
            version: '2.0.0',
            machines: { 'test-machine-01': { lastSync: '2024-01-01' } }
          });
        }
        return '';
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesSkipped).toContain('sync-roadmap.md (déjà existant)');
    });
  });

  describe('Rollback directory', () => {
    it('should create .rollback directory if it does not exist', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesCreated).toContainEqual(expect.stringContaining('.rollback'));
    });

    it('should skip .rollback directory if it already exists', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes('.rollback')) return true;
        return false;
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.filesSkipped).toContainEqual(expect.stringContaining('.rollback'));
    });
  });

  describe('Result format', () => {
    it('should return correct result structure', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('machineId');
      expect(result).toHaveProperty('sharedPath');
      expect(result).toHaveProperty('filesCreated');
      expect(result).toHaveProperty('filesSkipped');
      expect(result).toHaveProperty('message');
      expect(result.success).toBe(true);
      expect(result.machineId).toBe('test-machine-01');
      expect(result.sharedPath).toBe('/test/shared-path');
    });

    it('should include machine ID in message', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      const result = await roosyncInit({});

      expect(result.message).toContain('test-machine-01');
    });
  });

  describe('Dashboard content', () => {
    it('should create dashboard with correct initial structure', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      await roosyncInit({});

      const dashboardCall = mockWriteFileSync.mock.calls.find(
        (call: any[]) => call[0].includes('sync-dashboard.json')
      );

      expect(dashboardCall).toBeDefined();
      const dashboardContent = JSON.parse(dashboardCall[1]);

      expect(dashboardContent.version).toBe('2.0.0');
      expect(dashboardContent.overallStatus).toBe('synced');
      expect(dashboardContent.machines).toHaveProperty('test-machine-01');
      expect(dashboardContent.stats).toBeDefined();
    });
  });

  describe('Roadmap content', () => {
    it('should create roadmap with correct initial structure', async () => {
      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      await roosyncInit({});

      const roadmapCall = mockWriteFileSync.mock.calls.find(
        (call: any[]) => call[0].includes('sync-roadmap.md')
      );

      expect(roadmapCall).toBeDefined();
      const roadmapContent = roadmapCall[1];

      expect(roadmapContent).toContain('# RooSync - Roadmap');
      expect(roadmapContent).toContain('test-machine-01');
      expect(roadmapContent).toContain('Décisions en Attente');
      expect(roadmapContent).toContain('roosync_init');
    });
  });

  describe('Error handling', () => {
    it('should handle RooSyncServiceError correctly', async () => {
      const { RooSyncServiceError } = await import('../../../../src/services/RooSyncService.js');

      // Reset modules to apply new mock
      vi.resetModules();

      // Re-apply all mocks
      vi.doMock('child_process', () => ({
        exec: vi.fn()
      }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        unlinkSync: vi.fn()
      }));
      vi.doMock('../../../../src/utils/logger.js', () => ({
        createLogger: () => ({
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        })
      }));

      // Mock service to throw
      const serviceError = new RooSyncServiceError('Service error', 'TEST_ERROR');
      vi.doMock('../../../../src/services/RooSyncService.js', () => ({
        getRooSyncService: () => ({
          getConfig: () => { throw serviceError; }
        }),
        RooSyncServiceError
      }));

      const { roosyncInit: roosyncInitNew } = await import('../../../../src/tools/roosync/roosync_init.js');

      await expect(roosyncInitNew({})).rejects.toThrow('Service error');
    });

    it('should handle generic errors and wrap in RooSyncServiceError', async () => {
      // Reset modules
      vi.resetModules();

      vi.doMock('child_process', () => ({ exec: vi.fn() }));
      vi.doMock('fs', () => ({
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        unlinkSync: vi.fn()
      }));
      vi.doMock('../../../../src/utils/logger.js', () => ({
        createLogger: () => ({
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        })
      }));
      vi.doMock('../../../../src/services/RooSyncService.js', () => ({
        getRooSyncService: () => ({
          getConfig: () => { throw new Error('Generic error'); }
        }),
        RooSyncServiceError: class RooSyncServiceError extends Error {
          code: string;
          constructor(message: string, code: string) {
            super(message);
            this.code = code;
            this.name = 'RooSyncServiceError';
          }
        }
      }));

      const { roosyncInit: roosyncInitNew } = await import('../../../../src/tools/roosync/roosync_init.js');

      await expect(roosyncInitNew({})).rejects.toThrow('Erreur lors de l\'initialisation');
    });

    it('should handle file write errors gracefully', async () => {
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error('Write permission denied');
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      await expect(roosyncInit({})).rejects.toThrow();
    });

    it('should handle directory creation errors', async () => {
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });

      const { roosyncInit } = await import('../../../../src/tools/roosync/roosync_init.js');

      await expect(roosyncInit({})).rejects.toThrow();
    });
  });

});
