/**
 * Tests unitaires pour ConfigHealthCheckService
 * #537 Phase 2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ConfigHealthCheckService, ConfigType, HealthCheckType } from '../ConfigHealthCheckService.js';
import type { Logger } from '../../utils/logger.js';

describe('ConfigHealthCheckService', () => {
  let healthCheck: ConfigHealthCheckService;
  let mockLogger: Logger;
  let tempDir: string;

  beforeEach(async () => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis()
    } as any;

    healthCheck = new ConfigHealthCheckService(mockLogger);
    tempDir = await mkdtemp(join(tmpdir(), 'healthcheck-test-'));
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('checkHealth()', () => {
    it('should pass for valid JSON file', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ test: true, mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for non-existent file', async () => {
      const result = await healthCheck.checkHealth('/nonexistent/file.json', 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should fail for invalid JSON', async () => {
      const filePath = join(tempDir, 'invalid.json');
      await writeFile(filePath, '{ invalid json }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.errors.some(e => e.includes('invalide'))).toBe(true);
    });

    it('should handle BOM in JSON file', async () => {
      const filePath = join(tempDir, 'bom.json');
      // Write JSON with BOM
      const bomContent = '\uFEFF' + JSON.stringify({ test: true });
      await writeFile(filePath, bomContent);

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
    });

    it('should warn on missing required fields', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ otherField: true }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      // Missing mcpServers is a warning, not an error
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should run specific checks only', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ test: true }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['file_readable', 'json_valid']
      });

      expect(result.checks.length).toBe(2);
      expect(result.checks.map(c => c.name)).toContain('file_readable');
      expect(result.checks.map(c => c.name)).toContain('json_valid');
    });
  });

  describe('MCP config validation', () => {
    it('should validate correct MCP config', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js']
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'required_fields', 'mcp_loadable']
      });

      expect(result.healthy).toBe(true);
    });

    it('should warn on MCP server without command', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'broken-server': {
            args: ['server.js']
            // missing command
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.warnings.some(w => w.includes('command'))).toBe(true);
    });

    it('should accept disabled MCP servers without command', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'disabled-server': {
            disabled: true
            // no command needed
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['mcp_loadable']
      });

      expect(result.healthy).toBe(true);
    });
  });

  describe('quickCheck()', () => {
    it('should return true for valid JSON', async () => {
      const filePath = join(tempDir, 'valid.json');
      await writeFile(filePath, JSON.stringify({ valid: true }));

      const result = await healthCheck.quickCheck(filePath);

      expect(result).toBe(true);
    });

    it('should return false for invalid JSON', async () => {
      const filePath = join(tempDir, 'invalid.json');
      await writeFile(filePath, '{ broken }');

      const result = await healthCheck.quickCheck(filePath);

      expect(result).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const result = await healthCheck.quickCheck('/nonexistent/file.json');
      expect(result).toBe(false);
    });
  });

  describe('checkBatch()', () => {
    it('should check multiple files', async () => {
      const file1 = join(tempDir, 'config1.json');
      const file2 = join(tempDir, 'config2.json');

      await writeFile(file1, JSON.stringify({ test: 1 }));
      await writeFile(file2, JSON.stringify({ test: 2 }));

      const result = await healthCheck.checkBatch([
        { path: file1, type: 'mcp_config' },
        { path: file2, type: 'mcp_config' }
      ]);

      expect(result.healthy).toBe(true);
      expect(result.summary.passed).toBe(2);
      expect(result.results.size).toBe(2);
    });

    it('should report failures in batch', async () => {
      const validFile = join(tempDir, 'valid.json');
      const invalidFile = join(tempDir, 'invalid.json');

      await writeFile(validFile, JSON.stringify({ test: 1 }));
      await writeFile(invalidFile, '{ broken }');

      const result = await healthCheck.checkBatch([
        { path: validFile, type: 'mcp_config' },
        { path: invalidFile, type: 'mcp_config' }
      ]);

      expect(result.healthy).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(1);
    });
  });

  describe('Config types', () => {
    it('should validate mode_definition', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({
        slug: 'test-mode',
        name: 'Test Mode',
        roleDefinition: 'Test role'
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition');

      expect(result.healthy).toBe(true);
    });

    it('should validate model_config', async () => {
      const filePath = join(tempDir, 'model-configs.json');
      await writeFile(filePath, JSON.stringify({
        profiles: { default: {} },
        apiConfigs: {}
      }));

      const result = await healthCheck.checkHealth(filePath, 'model_config');

      expect(result.healthy).toBe(true);
    });
  });
});
