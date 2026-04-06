/**
 * Tests internes pour get_mcp_best_practices.ts
 * Tests des fonctions utilitaires non exposées
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Fonctions internes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Mock fs/promises
vi.mock('fs/promises');
const mockedFsPromises = vi.mocked(fs);

// Import des fonctions internes (non-exportées)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('get_mcp_best_practices - fonctions internes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars
    process.env.APPDATA = 'C:\\Users\\test\\AppData';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getMcpConfiguration', () => {
    it('should return parsed MCP settings when file exists and is valid', async () => {
      const mockSettings = {
        mcpServers: {
          'test-mcp': {
            transportType: 'stdio',
            disabled: false,
            description: 'Test MCP'
          }
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockSettings));

      // Import dynamique pour accéder à la fonction interne
      const module = await import('../get_mcp_best_practices.js');
      const getMcpConfiguration = module.getMcpConfiguration;

      const result = await getMcpConfiguration();

      expect(result).toEqual(mockSettings);
    });

    it('should return null when file does not exist', async () => {
      mockedFsPromises.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const module = await import('../get_mcp_best_practices.js');
      const getMcpConfiguration = module.getMcpConfiguration;

      const result = await getMcpConfiguration();

      expect(result).toBeNull();
    });

    it('should return null when file contains invalid JSON', async () => {
      mockedFsPromises.readFile.mockResolvedValue('invalid json content');

      const module = await import('../get_mcp_best_practices.js');
      const getMcpConfiguration = module.getMcpConfiguration;

      const result = await getMcpConfiguration();

      expect(result).toBeNull();
    });
  });

  describe('getMcpPath', () => {
    it('should return path from options.cwd when available', async () => {
      const config = {
        options: { cwd: '/some/custom/path' }
      };

      const module = await import('../get_mcp_best_practices.js');
      const getMcpPath = module.getMcpPath;

      const result = await getMcpPath('test-mcp', config);

      expect(result).toBe('/some/custom/path');
    });

    it('should return path from args[0] when available', async () => {
      const config = {
        args: ['/some/path/to/mcp.js', 'other', 'args']
      };

      const module = await import('../get_mcp_best_practices.js');
      const getMcpPath = module.getMcpPath;

      const result = await getMcpPath('test-mcp', config);

      expect(result).toBe('/some/path/to');
    });

    it('should extract path from node command with args', async () => {
      const config = {
        command: 'node',
        args: ['/some/very/deep/path/to/mcp.js', 'arg1']
      };

      const module = await import('../get_mcp_best_practices.js');
      const getMcpPath = module.getMcpPath;

      const result = await getMcpPath('test-mcp', config);

      expect(result).toBe('/some/very/deep/path/to');
    });

    it('should return null when no path can be determined', async () => {
      const config = {
        command: 'python',
        args: ['script.py']
      };

      const module = await import('../get_mcp_best_practices.js');
      const getMcpPath = module.getMcpPath;

      const result = await getMcpPath('test-mcp', config);

      expect(result).toBeNull();
    });

    it('should return null when config is undefined', async () => {
      const module = await import('../get_mcp_best_practices.js');
      const getMcpPath = module.getMcpPath;

      const result = await getMcpPath('test-mcp', undefined);

      expect(result).toBeNull();
    });
  });

  describe('scanMcpDirectory', () => {
    it('should scan directory structure correctly', async () => {
      const mockStats = {
        isDirectory: () => true,
        isFile: () => false
      };

      const mockDirContent = ['package.json', 'src/', 'README.md', 'test/'];
      const mockSrcContent = ['index.ts', 'utils.ts'];

      mockedFsPromises.stat.mockResolvedValue(mockStats as any);
      mockedFsPromises.readdir
        .mockResolvedValueOnce(mockDirContent)
        .mockResolvedValueOnce(mockSrcContent);

      // Mock stat for each item
      mockDirContent.forEach(item => {
        const isDir = item.endsWith('/');
        mockedFsPromises.stat.mockImplementation((path: string) => {
          if (path.includes('package.json') || path.includes('README.md')) {
            return Promise.resolve({ isDirectory: () => false, isFile: () => true } as any);
          }
          return Promise.resolve(mockStats as any);
        });
      });

      const module = await import('../get_mcp_best_practices.js');
      const scanMcpDirectory = module.scanMcpDirectory;

      const result = await scanMcpDirectory('/test/path');

      expect(result).toContain('📁 Structure du MCP');
      expect(result).toContain('📍 Chemin: /test/path');
      expect(result).toContain('📁 package.json');
      expect(result).toContain('📁 src/');
      expect(result).toContain('📄 README.md');
    });

    it('should handle non-directory path gracefully', async () => {
      mockedFsPromises.stat.mockRejectedValue(new Error('ENOTDIR: not a directory'));

      const module = await import('../get_mcp_best_practices.js');
      const scanMcpDirectory = module.scanMcpDirectory;

      const result = await scanMcpDirectory('/not/a/directory');

      expect(result).toContain('n\'est pas un répertoire valide');
    });

    it('should handle directory read errors gracefully', async () => {
      const mockStats = {
        isDirectory: () => true,
        isFile: () => false
      };

      mockedFsPromises.stat.mockResolvedValue(mockStats as any);
      mockedFsPromises.readdir.mockRejectedValue(new Error('EACCES: permission denied'));

      const module = await import('../get_mcp_best_practices.js');
      const scanMcpDirectory = module.scanMcpDirectory;

      const result = await scanMcpDirectory('/protected/path');

      expect(result).toContain('Erreur lors du scan');
    });
  });

  describe('getPackageInfo', () => {
    it('should extract package information correctly', async () => {
      const mockPackageJson = {
        name: 'test-mcp',
        version: '1.0.0',
        description: 'A test MCP',
        scripts: {
          build: 'tsc',
          test: 'vitest',
          lint: 'eslint'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0',
          'zod': '^3.0.0'
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      const module = await import('../get_mcp_best_practices.js');
      const getPackageInfo = module.getPackageInfo;

      const result = await getPackageInfo('/test/path');

      expect(result).toContain('📦 Informations du package');
      expect(result).toContain('Nom: test-mcp');
      expect(result).toContain('Version: 1.0.0');
      expect(result).toContain('Description: A test MCP');
      expect(result).toContain('Scripts disponibles:');
      expect(result).toContain('build: tsc');
      expect(result).toContain('Dépendances principales (2):');
    });

    it('should handle missing package.json gracefully', async () => {
      mockedFsPromises.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const module = await import('../get_mcp_best_practices.js');
      const getPackageInfo = module.getPackageInfo;

      const result = await getPackageInfo('/test/path');

      expect(result).toContain('Aucun package.json trouvé');
    });

    it('should handle invalid package.json gracefully', async () => {
      mockedFsPromises.readFile.mockResolvedValue('invalid json');

      const module = await import('../get_mcp_best_practices.js');
      const getPackageInfo = module.getPackageInfo;

      const result = await getPackageInfo('/test/path');

      expect(result).toContain('Aucun package.json trouvé');
    });

    it('should handle package.json without optional fields', async () => {
      const minimalPackageJson = {
        name: 'minimal-mcp',
        version: '0.0.1'
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(minimalPackageJson));

      const module = await import('../get_mcp_best_practices.js');
      const getPackageInfo = module.getPackageInfo;

      const result = await getPackageInfo('/test/path');

      expect(result).toContain('Nom: minimal-mcp');
      expect(result).toContain('Version: 0.0.1');
      expect(result).toContain('Description: N/A');
      expect(result).not.toContain('Scripts disponibles');
      expect(result).not.toContain('Dépendances principales');
    });
  });
});