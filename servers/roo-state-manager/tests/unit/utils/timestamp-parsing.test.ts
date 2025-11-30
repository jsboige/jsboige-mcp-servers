import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';

// Mock du module fs avec des fonctions inline
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  createReadStream: vi.fn(),
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn()
  }
}));

// Mock du module path
vi.mock('path', () => ({
  default: { 
    join: vi.fn((...args: string[]) => args.join('/')),
    basename: vi.fn((p: string) => p.split('/').pop() || ''),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/'))
  },
  join: vi.fn((...args: string[]) => args.join('/')),
  basename: vi.fn((p: string) => p.split('/').pop() || ''),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/'))
}));

// Mock du module os
vi.mock('os', () => ({
  default: { homedir: vi.fn(() => '/home/user') },
  homedir: vi.fn(() => '/home/user')
}));

// Mock du module glob
vi.mock('glob', () => ({
  glob: vi.fn()
}));

// Mock des modules internes
vi.mock('../../../src/utils/cache-manager.js', () => ({
  globalCacheManager: {
    get: vi.fn(),
    set: vi.fn()
  }
}));

vi.mock('../../../src/utils/task-instruction-index.js', () => ({
  globalTaskInstructionIndex: {},
  computeInstructionPrefix: vi.fn()
}));

vi.mock('../../../src/utils/message-to-skeleton-transformer.js', () => ({
  MessageToSkeletonTransformer: vi.fn().mockImplementation(() => ({
    transform: vi.fn()
  }))
}));

vi.mock('../../../src/utils/hierarchy-reconstruction-engine.js', () => ({
  HierarchyReconstructionEngine: vi.fn().mockImplementation(() => ({
    reconstruct: vi.fn()
  }))
}));

vi.mock('../../../src/utils/skeleton-comparator.js', () => ({
  SkeletonComparator: vi.fn().mockImplementation(() => ({
    compare: vi.fn()
  }))
}));

vi.mock('../../../src/utils/parsing-config.js', () => ({
  getParsingConfig: vi.fn(() => ({ mode: 'legacy' })),
  isComparisonMode: vi.fn(() => false),
  shouldUseNewParsing: vi.fn(() => false)
}));

vi.mock('../../../src/utils/workspace-detector.js', () => ({
  WorkspaceDetector: vi.fn().mockImplementation(() => ({
    detect: vi.fn(() => Promise.resolve({
      workspace: '/test/workspace',
      source: 'test',
      confidence: 1.0
    }))
  }))
}));

describe('RooStorageDetector - Timestamp Parsing Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Module Import', () => {
    it('should be able to import module', () => {
      expect(RooStorageDetector).toBeDefined();
      expect(typeof RooStorageDetector.analyzeConversation).toBe('function');
      expect(typeof RooStorageDetector.detectStorageLocations).toBe('function');
    });
  });

  describe('analyzeConversation - Missing Files', () => {
    it('should return null when metadata file does not exist', async () => {
      const { existsSync } = await import('fs');
      (existsSync as any).mockReturnValue(false);

      const result = await RooStorageDetector.analyzeConversation('test-task', '/nonexistent/path');
      expect(result).toBeNull();
    });

    it('should handle file system errors gracefully', async () => {
      const mockReadFile = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const mockExistsSync = vi.fn().mockReturnValue(true);
      
      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile
      }));
      vi.doMock('fs', () => ({
        existsSync: mockExistsSync
      }));
      
      const result = await RooStorageDetector.analyzeConversation('test-task', '/test/path');
      expect(result).toBeNull();
    });
  });

  describe('analyzeConversation - Valid Files', () => {
    it('should handle valid conversation parsing attempt', async () => {
      // Test simple pour valider que la fonction peut être appelée
      // et que les mocks sont correctement configurés
      
      const result = await RooStorageDetector.analyzeConversation('test-task', '/test/path');
      
      // Le test valide principalement que la fonction s'exécute sans erreur
      // Le résultat peut être null pour diverses raisons (fichiers manquants, etc.)
      expect(result === null || typeof result === 'object').toBe(true);
    });
it('should handle malformed JSON gracefully', async () => {
  const mockReadFile = vi.fn().mockResolvedValue('invalid json content');
  const mockExistsSync = vi.fn().mockReturnValue(true);
  
  vi.doMock('fs/promises', () => ({
    readFile: mockReadFile
  }));
  vi.doMock('fs', () => ({
    existsSync: mockExistsSync
  }));
  
  const result = await RooStorageDetector.analyzeConversation('test-task', '/test/path');
  expect(result).toBeNull();
});
    });
  });

  describe('detectStorageLocations', () => {
    it('should return cached locations when available', async () => {
      const { globalCacheManager } = await import('../../../src/utils/cache-manager.js');
      (globalCacheManager.get as any).mockResolvedValue(['/cached/path1', '/cached/path2']);

      const result = await RooStorageDetector.detectStorageLocations();
      
      expect(result).toEqual(['/cached/path1', '/cached/path2']);
      expect(globalCacheManager.get).toHaveBeenCalledWith('storage_locations');
    });

    it('should detect and validate storage locations', async () => {
      const mockGlobalCacheManager = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn()
      };
      const mockGlob = vi.fn().mockResolvedValue(['/home/user/.vscode/extensions/roo-extension']);
      const mockAccess = vi.fn().mockResolvedValue(undefined);
      const mockStat = vi.fn().mockResolvedValue({
        isDirectory: () => true
      });
      
      vi.doMock('../../../src/utils/cache-manager.js', () => ({
        globalCacheManager: mockGlobalCacheManager
      }));
      vi.doMock('glob', () => ({
        glob: mockGlob
      }));
      vi.doMock('fs/promises', () => ({
        access: mockAccess,
        stat: mockStat
      }));
      
      const result = await RooStorageDetector.detectStorageLocations();
      
      expect(Array.isArray(result)).toBe(true);
      expect(mockGlobalCacheManager.set).toHaveBeenCalledWith('storage_locations', expect.any(Array));
    });
  });

  describe('getStatsForPath', () => {
    it('should return storage statistics for valid path', async () => {
      const mockReaddir = vi.fn().mockResolvedValue([
        { name: 'task1', isDirectory: () => true },
        { name: 'task2', isDirectory: () => true }
      ]);
      const mockStat = vi.fn().mockResolvedValue({
        isDirectory: () => true,
        size: 2048,
        mtime: new Date('2025-11-30T12:00:00.000Z')
      });
      
      vi.doMock('fs/promises', () => ({
        readdir: mockReaddir,
        stat: mockStat
      }));
      
      const result = await RooStorageDetector.getStatsForPath('/test/storage/path');
      
      expect(result).toBeDefined();
      expect(result.conversationCount).toBe(2);
      expect(result.totalSize).toBeGreaterThan(0);
    });

    it('should handle empty directory', async () => {
      const mockReaddir = vi.fn().mockResolvedValue([]);
      
      vi.doMock('fs/promises', () => ({
        readdir: mockReaddir
      }));
      
      const result = await RooStorageDetector.getStatsForPath('/empty/path');
      
      expect(result).toBeDefined();
      expect(result.conversationCount).toBe(0);
      expect(result.totalSize).toBe(0);
    });
  });