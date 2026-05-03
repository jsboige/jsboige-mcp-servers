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

    it('should validate profile_settings', async () => {
      const filePath = join(tempDir, 'profiles.json');
      await writeFile(filePath, JSON.stringify({
        profiles: { default: {} },
        apiConfigs: {}
      }));

      const result = await healthCheck.checkHealth(filePath, 'profile_settings');

      expect(result.healthy).toBe(true);
    });

    it('should validate roomodes_config', async () => {
      const filePath = join(tempDir, 'roomodes.json');
      await writeFile(filePath, JSON.stringify({
        customModes: [{ slug: 'test' }]
      }));

      const result = await healthCheck.checkHealth(filePath, 'roomodes_config');

      expect(result.healthy).toBe(true);
    });

    it('should pass rules_config with no required fields', async () => {
      const filePath = join(tempDir, 'rules.json');
      await writeFile(filePath, JSON.stringify({ anything: 'goes' }));

      const result = await healthCheck.checkHealth(filePath, 'rules_config');

      expect(result.healthy).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should pass settings_config with no required fields', async () => {
      const filePath = join(tempDir, 'settings.json');
      await writeFile(filePath, JSON.stringify({ foo: 'bar' }));

      const result = await healthCheck.checkHealth(filePath, 'settings_config');

      expect(result.healthy).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn on missing mode_definition fields', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({ slug: 'test' }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition');

      expect(result.warnings.some(w => w.includes('name') || w.includes('roleDefinition'))).toBe(true);
    });

    it('should warn on missing roomodes_config fields', async () => {
      const filePath = join(tempDir, 'roomodes.json');
      await writeFile(filePath, JSON.stringify({ other: true }));

      const result = await healthCheck.checkHealth(filePath, 'roomodes_config');

      expect(result.warnings.some(w => w.includes('customModes'))).toBe(true);
    });
  });

  describe('checkMcpLoadable edge cases', () => {
    it('should handle mcpServers as string (not object)', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: 'not-an-object'
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      // Non-object mcpServers is treated as "Pas de mcpServers défini"
      expect(result.healthy).toBe(true);
    });

    it('should warn on disabled field not boolean', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'bad-server': {
            command: 'node',
            disabled: 'yes'
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.warnings.some(w => w.includes('disabled') && w.includes('boolean'))).toBe(true);
    });

    it('should warn on args not array', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'bad-server': {
            command: 'node',
            args: 'not-an-array'
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.warnings.some(w => w.includes('args') && w.includes('tableau'))).toBe(true);
    });

    it('should report valid servers count', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'server-a': { command: 'node', args: ['a.js'] },
          'server-b': { command: 'python', args: ['b.py'] }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.healthy).toBe(true);
      const loadableCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(loadableCheck?.message).toContain('2 serveurs MCP valides');
    });

    it('should skip mcp_loadable for non-mcp_config types', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({
        slug: 'test', name: 'Test', roleDefinition: 'Role',
        mcpServers: { 's': { command: 'node' } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition', {
        checks: ['json_valid', 'mcp_loadable']
      });

      // mcp_loadable is skipped for non-mcp_config types
      expect(result.checks.every(c => c.name !== 'mcp_loadable')).toBe(true);
      expect(result.healthy).toBe(true);
    });

    it('should handle multiple issues in single server', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'multi-bad': {
            disabled: 'yes',
            args: 'not-array'
          }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      // disabled not boolean + no command + args not array = 3 issues
      const loadableCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(loadableCheck?.passed).toBe(false);
    });
  });

  describe('checkHealth edge cases', () => {
    it('should use custom requiredFields', async () => {
      const filePath = join(tempDir, 'custom.json');
      await writeFile(filePath, JSON.stringify({ custom: 'value' }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'required_fields'],
        requiredFields: ['custom']
      });

      expect(result.healthy).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should skip required_fields when json_valid fails', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{ not valid }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'required_fields']
      });

      // required_fields skipped because parsedContent is undefined
      expect(result.checks.some(c => c.name === 'required_fields')).toBe(false);
      expect(result.healthy).toBe(false);
    });

    it('should return proper result structure', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.filePath).toBe(filePath);
      expect(result.configType).toBe('mcp_config');
      expect(Array.isArray(result.checks)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('should log start and end of health check', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(mockLogger.info).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('démarré'),
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('terminé'),
        expect.any(Object)
      );
    });
  });

  describe('quickCheck edge cases', () => {
    it('should return false for BOM-prefixed JSON', async () => {
      const filePath = join(tempDir, 'bom.json');
      const bomContent = '﻿' + JSON.stringify({ test: true });
      await writeFile(filePath, bomContent);

      // quickCheck does NOT strip BOM, unlike checkHealth
      const result = await healthCheck.quickCheck(filePath);

      expect(result).toBe(false);
    });
  });

  describe('checkBatch edge cases', () => {
    it('should handle empty files array', async () => {
      const result = await healthCheck.checkBatch([]);

      expect(result.healthy).toBe(true);
      expect(result.summary.passed).toBe(0);
      expect(result.summary.failed).toBe(0);
      expect(result.summary.warnings).toBe(0);
      expect(result.results.size).toBe(0);
    });

    it('should count warnings across files', async () => {
      const file1 = join(tempDir, 'config1.json');
      const file2 = join(tempDir, 'config2.json');

      await writeFile(file1, JSON.stringify({ noMcp: true }));
      await writeFile(file2, JSON.stringify({ noMcp: true }));

      const result = await healthCheck.checkBatch([
        { path: file1, type: 'mcp_config' },
        { path: file2, type: 'mcp_config' }
      ]);

      // Both files missing mcpServers → 2 warnings
      expect(result.summary.warnings).toBeGreaterThanOrEqual(2);
    });

    it('should pass options to individual checkHealth calls', async () => {
      const file1 = join(tempDir, 'config1.json');
      await writeFile(file1, JSON.stringify({ custom: true }));

      const result = await healthCheck.checkBatch(
        [{ path: file1, type: 'mcp_config' }],
        { checks: ['json_valid'] }
      );

      // Only json_valid check ran, so no required_fields warning
      expect(result.results.get(file1)?.checks).toHaveLength(1);
      expect(result.results.get(file1)?.checks[0].name).toBe('json_valid');
    });
  });
});
