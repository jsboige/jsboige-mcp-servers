/**
 * Tests internes pour get_mcp_best_practices.ts
 * Tests des fonctions utilitaires exportées avec @internal
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Fonctions internes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs/promises
vi.mock('fs/promises');
const mockedFs = vi.mocked(fs);

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

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockSettings));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpConfiguration();

      expect(result).toEqual(mockSettings);
    });

    it('should return null when file does not exist', async () => {
      mockedFs.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpConfiguration();

      expect(result).toBeNull();
    });

    it('should return null when file contains invalid JSON', async () => {
      mockedFs.readFile.mockResolvedValue('invalid json content');

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpConfiguration();

      expect(result).toBeNull();
    });
  });

  describe('getMcpPath', () => {
    it('should return path from options.cwd when available', async () => {
      const config = {
        options: { cwd: '/some/custom/path' }
      };

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', config);

      expect(result).toBe('/some/custom/path');
    });

    it('should return double-dirname from args[0] when available', async () => {
      const config = {
        args: ['/some/path/to/mcp.js', 'other', 'args']
      };

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', config);

      // Code does path.dirname(path.dirname(args[0]))
      // path.dirname('/some/path/to/mcp.js') = '/some/path/to'
      // path.dirname('/some/path/to') = '/some/path'
      expect(result).toBe(path.dirname(path.dirname('/some/path/to/mcp.js')));
    });

    it('should use args[0] branch even when command is node (args branch takes priority)', async () => {
      const config = {
        command: 'node',
        args: ['/some/very/deep/path/to/mcp.js', 'arg1']
      };

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', config);

      // The args?.[0] branch fires before the command+node branch
      expect(result).toBe(path.dirname(path.dirname('/some/very/deep/path/to/mcp.js')));
    });

    it('should return double-dirname for any config with args[0]', async () => {
      const config = {
        command: 'python',
        args: ['script.py']
      };

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', config);

      // args[0] = 'script.py' is truthy, so it enters the args branch
      // path.dirname(path.dirname('script.py')) = path.dirname('.') = '.'
      expect(result).toBe(path.dirname(path.dirname('script.py')));
    });

    it('should return null when config is undefined', async () => {
      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', undefined);

      expect(result).toBeNull();
    });

    it('should return null when config has no args, no options, and non-node command', async () => {
      const config = {
        command: 'python'
      };

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getMcpPath('test-mcp', config);

      expect(result).toBeNull();
    });
  });

  describe('scanMcpDirectory', () => {
    it('should scan directory structure correctly', async () => {
      // First call: stat on the base path itself -> directory
      // Then stat calls for each keyPath entry
      mockedFs.stat.mockImplementation(async (p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith('package.json') || pathStr.endsWith('README.md') || pathStr.endsWith('tsconfig.json')) {
          return { isDirectory: () => false, isFile: () => true } as any;
        }
        if (pathStr.endsWith('src') || pathStr.endsWith('src/')) {
          return { isDirectory: () => true, isFile: () => false } as any;
        }
        // Base path and other entries
        return { isDirectory: () => true, isFile: () => false } as any;
      });

      // readdir for subdirectories like src/
      mockedFs.readdir.mockResolvedValue(['index.ts', 'utils.ts'] as any);

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.scanMcpDirectory('/test/path');

      expect(result).toContain('Structure du MCP');
      expect(result).toContain('/test/path');
      // package.json is a file, should get file icon
      expect(result).toContain('package.json');
    });

    it('should handle non-directory path gracefully', async () => {
      mockedFs.stat.mockRejectedValue(new Error('ENOTDIR: not a directory'));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.scanMcpDirectory('/not/a/directory');

      expect(result).toContain('Erreur lors du scan');
    });

    it('should handle directory read errors gracefully', async () => {
      // Base path stat succeeds
      let callCount = 0;
      mockedFs.stat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Base path
          return { isDirectory: () => true, isFile: () => false } as any;
        }
        // All keyPath checks fail
        throw new Error('ENOENT');
      });

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.scanMcpDirectory('/protected/path');

      // Should still return the header even if individual entries fail
      expect(result).toContain('Structure du MCP');
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

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getPackageInfo('/test/path');

      expect(result).toContain('Informations du package');
      expect(result).toContain('Nom: test-mcp');
      expect(result).toContain('Version: 1.0.0');
      expect(result).toContain('Description: A test MCP');
      expect(result).toContain('Scripts disponibles');
      expect(result).toContain('build: tsc');
      expect(result).toContain('pendances principales (2)');
    });

    it('should handle missing package.json gracefully', async () => {
      mockedFs.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getPackageInfo('/test/path');

      expect(result).toContain('Aucun package.json');
    });

    it('should handle invalid package.json gracefully', async () => {
      mockedFs.readFile.mockResolvedValue('invalid json');

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getPackageInfo('/test/path');

      expect(result).toContain('Aucun package.json');
    });

    it('should handle package.json without optional fields', async () => {
      const minimalPackageJson = {
        name: 'minimal-mcp',
        version: '0.0.1'
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(minimalPackageJson));

      const module = await import('../get_mcp_best_practices.js');
      const result = await module.getPackageInfo('/test/path');

      expect(result).toContain('Nom: minimal-mcp');
      expect(result).toContain('Version: 0.0.1');
      expect(result).toContain('Description: N/A');
      expect(result).not.toContain('Scripts disponibles');
      expect(result).not.toContain('pendances principales');
    });
  });
});
