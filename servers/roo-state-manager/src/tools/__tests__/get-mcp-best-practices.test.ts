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
    // Reset env vars
    process.env.APPDATA = 'C:\Users\test\AppData';
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
});
