/**
 * Tests pour get_mcp_best_practices.ts
 * Module de guide de bonnes pratiques MCP
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Documentation MCP
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs/promises
vi.mock('fs/promises');

const mockedFsPromises = vi.mocked(fs);

// Import du module après les mocks
import { getMcpBestPractices } from '../get_mcp_best_practices.js';

describe('get_mcp_best_practices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use a path recognized by getMcpSettingsPath() safety guard
    process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(getMcpBestPractices.name).toBe('get_mcp_best_practices');
    });

    it('should have description', () => {
      expect(getMcpBestPractices.description).toBeDefined();
      expect(getMcpBestPractices.description).toContain('MCP');
    });

    it('should accept optional mcp_name parameter', () => {
      expect(getMcpBestPractices.inputSchema.properties.mcp_name).toBeDefined();
      expect(getMcpBestPractices.inputSchema.required).toEqual([]);
    });
  });

  describe('handler without mcp_name', () => {
    it('should return general MCP best practices guide', async () => {
      const result = await getMcpBestPractices.handler();

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text as string;
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
      expect(text).toContain('PATTERNS DE DÉBOGAGE ÉPROUVÉS');
    });

    it('should include configuration section when mcp_settings.json exists', async () => {
      const mockSettings = {
        mcpServers: {
          'test-mcp': {
            transportType: 'stdio',
            disabled: false,
            description: 'Test MCP'
          }
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockSettings) as any);

      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('CONFIGURATION MCP ACTUELLE');
      expect(text).toContain('test-mcp');
    });

    it('should handle missing mcp_settings.json gracefully', async () => {
      mockedFsPromises.readFile.mockRejectedValue(new Error('File not found') as any);

      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
    });
  });

  describe('handler with mcp_name parameter', () => {
    it('should show error when MCP not found', async () => {
      const mockSettings = { mcpServers: {} };
      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockSettings) as any);

      const result = await getMcpBestPractices.handler({ mcp_name: 'non-existent' });
      const text = result.content[0].text as string;

      expect(text).toContain('non-existent');
      expect(text).toContain('non trouvé');
    });
  });

  describe('guide sections completeness', () => {
    it('should include watchPaths explanation', async () => {
      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('watchPaths');
      expect(text).toContain('Hot-Reload');
    });

    it('should include cwd explanation', async () => {
      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('cwd');
      expect(text).toContain('Chemins Relatifs Stables');
    });

    it('should include essential tools table', async () => {
      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('touch_mcp_settings');
      expect(text).toContain('rebuild_and_restart_mcp');
      expect(text).toContain('read_vscode_logs');
    });

    it('should include grounding section for external agents', async () => {
      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      expect(text).toContain('GROUNDING POUR AGENTS EXTERNES');
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle environment variable fallback for APPDATA', async () => {
      // Reset APPDATA
      delete process.env.APPDATA;

      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      // Should still work and return content
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
    });

    it('should handle complex package.json structure', async () => {
      const mockComplexPackage = {
        name: 'complex-mcp',
        version: '2.1.0',
        description: 'A complex MCP with many features',
        scripts: {
          build: 'tsc -b',
          test: 'vitest run',
          lint: 'eslint',
          typecheck: 'tsc --noEmit',
          clean: 'rimraf dist',
          prebuild: 'npm run clean'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0',
          'zod': '^3.22.0',
          'chalk': '^5.3.0'
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          'typescript': '^5.0.0'
        },
        keywords: ['mcp', 'tool', 'ai'],
        author: 'Test Author',
        license: 'MIT',
        repository: {
          type: 'git',
          url: 'https://github.com/test/mcp.git'
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockComplexPackage));

      const mockSettings = {
        mcpServers: {
          'complex-mcp': {
            command: 'node',
            args: ['/some/very/deep/path/to/mcp.js', 'arg1'],
            transportType: 'stdio',
            disabled: false,
            description: 'Complex MCP for testing'
          }
        }
      };

      mockedFsPromises.readFile.mockImplementation((path: string) => {
        if (path.includes('mcp_settings.json')) {
          return Promise.resolve(JSON.stringify(mockSettings));
        }
        return Promise.resolve(JSON.stringify(mockComplexPackage));
      });

      const result = await getMcpBestPractices.handler({ mcp_name: 'complex-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('complex-mcp');
      expect(text).toContain('📦 Informations du package');
      expect(text).toContain('Dépendances principales (3)');
    });

    it('should handle MCP with relative paths in configuration', async () => {
      const mockSettings = {
        mcpServers: {
          'relative-path-mcp': {
            transportType: 'stdio',
            disabled: false,
            description: 'MCP with relative paths',
            command: 'node',
            args: ['./dist/index.js'],
            options: {
              cwd: './relative/path'
            }
          }
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockSettings));

      const result = await getMcpBestPractices.handler({ mcp_name: 'relative-path-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('relative-path-mcp');
      expect(text).toContain('⚙️ Configuration');
    });

    it('should handle network-related errors gracefully', async () => {
      // Simulate a file system error during configuration reading
      mockedFsPromises.readFile.mockImplementation(() => {
        throw new Error('ECONNREFUSED: connection refused');
      });

      const result = await getMcpBestPractices.handler();
      const text = result.content[0].text as string;

      // Should still return content despite the error
      expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
      expect(text).not.toContain('ECONNREFUSED');
    });

    it('should generate comprehensive MCP development commands', async () => {
      const mockSettings = {
        mcpServers: {
          'dev-mcp': {
            transportType: 'stdio',
            disabled: false,
            description: 'Development MCP',
            command: 'node',
            args: ['/dev/mcp/build/index.js']
          }
        }
      };

      mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(mockSettings));

      // Mock directory scan
      const mockStats = { isDirectory: () => true };
      mockedFsPromises.stat.mockResolvedValue(mockStats as any);
      mockedFsPromises.readdir.mockResolvedValue(['package.json', 'src/']);

      const result = await getMcpBestPractices.handler({ mcp_name: 'dev-mcp' });
      const text = result.content[0].text as string;

      expect(text).toContain('🚀 Commandes de développement');
      expect(text).toContain('npm install');
      expect(text).toContain('npm run build');
      expect(text).toContain('use_mcp_tool roo-state-manager rebuild_and_restart_mcp');
    });
  });
});
