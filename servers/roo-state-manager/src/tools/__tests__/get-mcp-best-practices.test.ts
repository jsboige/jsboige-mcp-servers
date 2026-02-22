import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getMcpBestPractices } from '../get_mcp_best_practices.js';

// Mock fs module
vi.mock('fs/promises');
const mockedFs = vi.mocked(fs);

describe('get_mcp_best_practices', () => {
  const mockAppData = 'C:\\Users\\test\\AppData\\Roaming';

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    process.env.APPDATA = mockAppData;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handler', () => {
    it('should return best practices guide without mcp_name parameter', async () => {
      const result = await getMcpBestPractices.handler({});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text as string;

      // Vérifier les sections principales
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
      expect(text).toContain('PATTERNS DE DÉBOGAGE ÉPROUVÉS');
      expect(text).toContain('WORKFLOW DE DÉBOGAGE SYSTÉMATIQUE');
      expect(text).toContain('CHECKLIST DE DÉBOGAGE URGENT');
      expect(text).toContain('ERREURS COMMUNES DOCUMENTÉES');
      expect(text).toContain('CONFIGURATION MCP ESSENTIELLE');
      expect(text).toContain('watchPaths');
      expect(text).toContain('cwd');
      expect(text).toContain('OUTILS ROO-STATE-MANAGER ESSENTIELS');
    });

    it('should include current MCP configuration when file exists', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            command: 'node',
            args: ['server.js'],
            description: 'Test MCP',
            disabled: false,
            options: { cwd: 'C:\\test' }
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));

      const result = await getMcpBestPractices.handler({});
      const text = result.content[0].text as string;

      expect(text).toContain('CONFIGURATION MCP ACTUELLE');
      expect(text).toContain('test-mcp');
      expect(text).toContain('✅ Actif');
      expect(text).toContain('Test MCP');
    });

    it('should handle missing mcp_settings.json gracefully', async () => {
      mockedFs.readFile.mockRejectedValue(new Error('File not found'));

      const result = await getMcpBestPractices.handler({});
      const text = result.content[0].text as string;

      // Le guide doit toujours être retourné même sans config
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
      expect(text).toContain('Framework Roo');
    });

    it('should include detailed analysis when mcp_name is provided', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'roo-state-manager': {
            command: 'node',
            args: ['C:/dev/roo-extensions/mcps/internal/servers/roo-state-manager/mcp-wrapper.cjs'],
            description: 'Core MCP',
            disabled: false,
            options: {
              cwd: 'C:/dev/roo-extensions/mcps/internal/servers/roo-state-manager'
            }
          }
        }
      };

      const mockPackageJson = {
        name: 'roo-state-manager',
        version: '1.0.0',
        description: 'Roo state management MCP',
        scripts: {
          build: 'tsc',
          test: 'vitest'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0'
        }
      };

      mockedFs.readFile.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr.includes('mcp_settings.json')) {
          return Promise.resolve(JSON.stringify(mockMcpSettings));
        }
        if (pathStr.includes('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.includes('src') || pathStr.includes('build') || pathStr.includes('tsconfig.json')) {
          return Promise.reject(new Error('ENOENT')); // Simuler structure de base
        }
        return Promise.reject(new Error('File not found'));
      });

      // Mock fs.stat pour simuler un répertoire valide
      mockedFs.stat.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('roo-state-manager')) {
          return Promise.resolve({ isDirectory: () => true } as any);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await getMcpBestPractices.handler({ mcp_name: 'roo-state-manager' });
      const text = result.content[0].text as string;

      expect(text).toContain('ANALYSE DÉTAILLÉE: ROO-STATE-MANAGER');
      expect(text).toContain('Configuration');
      expect(text).toContain('roo-state-manager');
    });

    it('should return error message when mcp_name not found', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'other-mcp': {
            command: 'node',
            args: ['server.js']
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));

      const result = await getMcpBestPractices.handler({ mcp_name: 'nonexistent-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('MCP "nonexistent-mcp" non trouvé');
      expect(text).toContain('other-mcp');
    });

    it('should handle errors gracefully', async () => {
      mockedFs.readFile.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await getMcpBestPractices.handler({});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      // Le guide doit toujours être retourné même en cas d'erreur
      const text = result.content[0].text as string;
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
    });
  });

  describe('getMcpPath scenarios', () => {
    it('should extract path from options.cwd', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            options: { cwd: '/custom/path' }
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
      mockedFs.readdir.mockResolvedValue([]);

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('/custom/path');
    });

    it('should extract path from args[0]', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            command: 'node',
            args: ['/path/to/server/index.js']
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
      mockedFs.readdir.mockResolvedValue([]);

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('Chemin:');
    });
  });

  describe('scanMcpDirectory', () => {
    it('should list key files and directories', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            options: { cwd: '/test/mcp' }
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));

      // Mock fs.stat pour retourner différents types
      mockedFs.stat.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr === '/test/mcp') {
          return Promise.resolve({ isDirectory: () => true } as any);
        }
        if (pathStr.endsWith('package.json') || pathStr.endsWith('README.md')) {
          return Promise.resolve({ isDirectory: () => false } as any);
        }
        if (pathStr.endsWith('src') || pathStr.endsWith('build')) {
          return Promise.resolve({ isDirectory: () => true } as any);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      // Mock fs.readdir pour lister le contenu des répertoires
      mockedFs.readdir.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('src')) {
          return Promise.resolve(['index.ts', 'handler.ts']);
        }
        if (pathStr.endsWith('build')) {
          return Promise.resolve(['index.js', 'handler.js']);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('Structure du MCP');
      expect(text).toContain('package.json');
      expect(text).toContain('README.md');
    });

    it('should handle invalid path gracefully', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            options: { cwd: '/invalid/path' }
          }
        }
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockMcpSettings));
      mockedFs.stat.mockResolvedValue({ isDirectory: () => false } as any);

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain("n'est pas un répertoire valide");
    });
  });

  describe('getPackageInfo', () => {
    it('should extract package information', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            options: { cwd: '/test/mcp' }
          }
        }
      };

      const mockPackageJson = {
        name: 'test-mcp',
        version: '2.0.0',
        description: 'A test MCP server',
        scripts: {
          build: 'tsc',
          test: 'jest',
          lint: 'eslint'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0',
          'zod': '^3.0.0'
        }
      };

      mockedFs.readFile.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr.includes('mcp_settings.json')) {
          return Promise.resolve(JSON.stringify(mockMcpSettings));
        }
        if (pathStr.includes('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
      mockedFs.readdir.mockRejectedValue(new Error('ENOENT'));

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('Informations du package');
      expect(text).toContain('test-mcp');
      expect(text).toContain('2.0.0');
      expect(text).toContain('A test MCP server');
      expect(text).toContain('Scripts disponibles');
      expect(text).toContain('build: tsc');
      expect(text).toContain('test: jest');
      expect(text).toContain('lint: eslint');
      expect(text).toContain('Dépendances principales');
      expect(text).toContain('@modelcontextprotocol/sdk@^1.0.0');
      expect(text).toContain('zod@^3.0.0');
    });

    it('should handle missing package.json gracefully', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-mcp': {
            options: { cwd: '/test/mcp' }
          }
        }
      };

      mockedFs.readFile.mockImplementation((filePath: string) => {
        const pathStr = String(filePath);
        if (pathStr.includes('mcp_settings.json')) {
          return Promise.resolve(JSON.stringify(mockMcpSettings));
        }
        if (pathStr.includes('package.json')) {
          return Promise.reject(new Error('ENOENT'));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
      mockedFs.readdir.mockRejectedValue(new Error('ENOENT'));

      const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('Aucun package.json trouvé');
    });
  });
});
