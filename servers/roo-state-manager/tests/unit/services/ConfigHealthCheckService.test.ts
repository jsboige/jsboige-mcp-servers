/**
 * Comprehensive unit tests for ConfigHealthCheckService
 *
 * Covers all public methods (checkHealth, quickCheck, checkBatch)
 * and exercises private methods through the public API:
 *   - checkFileReadable
 *   - checkJsonValid
 *   - checkRequiredFields
 *   - checkMcpLoadable
 *
 * Uses real temp files (os.tmpdir()) for file-based checks.
 * No filesystem mocking -- tests verify actual I/O behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ConfigHealthCheckService } from '../../../src/services/ConfigHealthCheckService.js';
import type { ConfigType, HealthCheckResult } from '../../../src/services/ConfigHealthCheckService.js';

// Logger stub -- matches the Logger class interface (info, warn, error, debug)
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  } as any;
}

describe('ConfigHealthCheckService', () => {
  let healthCheck: ConfigHealthCheckService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let tempDir: string;

  beforeEach(async () => {
    mockLogger = createMockLogger();
    healthCheck = new ConfigHealthCheckService(mockLogger);
    tempDir = await mkdtemp(join(tmpdir(), 'healthcheck-unit-'));
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // ================================================================
  // checkHealth -- file_readable
  // ================================================================
  describe('checkHealth -- file_readable check', () => {
    it('should pass file_readable for an existing file', async () => {
      const filePath = join(tempDir, 'exists.json');
      await writeFile(filePath, '{}');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const fileCheck = result.checks.find(c => c.name === 'file_readable');
      expect(fileCheck).toBeDefined();
      expect(fileCheck!.passed).toBe(true);
      expect(fileCheck!.message).toContain('accessible');
    });

    it('should fail file_readable for non-existent file and return early', async () => {
      const filePath = join(tempDir, 'nonexistent.json');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      const fileCheck = result.checks.find(c => c.name === 'file_readable');
      expect(fileCheck!.passed).toBe(false);
      expect(result.checks.map(c => c.name)).not.toContain('json_valid');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('accessible');
    });

    it('should pass file_readable for a directory path', async () => {
      const dirPath = join(tempDir, 'subdir');
      await mkdir(dirPath);

      const result = await healthCheck.checkHealth(dirPath, 'mcp_config');

      const fileCheck = result.checks.find(c => c.name === 'file_readable');
      expect(fileCheck!.passed).toBe(true);
    });
  });

  // ================================================================
  // checkHealth -- json_valid
  // ================================================================
  describe('checkHealth -- json_valid check', () => {
    it('should pass json_valid for well-formed JSON', async () => {
      const filePath = join(tempDir, 'valid.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(true);
      expect(jsonCheck!.message).toContain('valide');
      expect(jsonCheck!.details?.parsed).toEqual({ mcpServers: {} });
    });

    it('should fail json_valid for malformed JSON', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{ "broken": ');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(false);
      expect(jsonCheck!.message).toContain('invalide');
      expect(result.errors.some(e => e.includes('invalide'))).toBe(true);
    });

    it('should handle JSON with trailing commas (invalid JSON)', async () => {
      const filePath = join(tempDir, 'trailing.json');
      await writeFile(filePath, '{ "key": "value", }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(false);
    });

    it('should pass json_valid for an empty JSON object', async () => {
      const filePath = join(tempDir, 'empty.json');
      await writeFile(filePath, '{}');

      const result = await healthCheck.checkHealth(filePath, 'settings_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(true);
    });

    it('should pass json_valid for a JSON array at top level', async () => {
      const filePath = join(tempDir, 'array.json');
      await writeFile(filePath, '[]');

      const result = await healthCheck.checkHealth(filePath, 'rules_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(true);
    });
  });

  // ================================================================
  // checkHealth -- BOM handling
  // ================================================================
  describe('checkHealth -- BOM handling', () => {
    it('should strip UTF-8 BOM and parse valid JSON', async () => {
      const filePath = join(tempDir, 'bom.json');
      const bomContent = '﻿' + JSON.stringify({ mcpServers: {} });
      await writeFile(filePath, bomContent);

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(true);
    });

    it('should strip BOM from invalid JSON and still report failure', async () => {
      const filePath = join(tempDir, 'bom-bad.json');
      const bomContent = '﻿{ broken }';
      await writeFile(filePath, bomContent);

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(false);
    });
  });

  // ================================================================
  // checkHealth -- required_fields
  // ================================================================
  describe('checkHealth -- required_fields check', () => {
    it('should pass when all required fields are present for mcp_config', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
      expect(fieldsCheck!.message).toContain('1');
    });

    it('should warn when required fields are missing', async () => {
      const filePath = join(tempDir, 'missing.json');
      await writeFile(filePath, JSON.stringify({ otherStuff: true }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(false);
      expect(fieldsCheck!.message).toContain('mcpServers');
      expect(fieldsCheck!.details?.missing).toContain('mcpServers');
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should pass required_fields for mode_definition with all fields', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({
        slug: 'test', name: 'Test', roleDefinition: 'A role'
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should warn on missing slug in mode_definition', async () => {
      const filePath = join(tempDir, 'partial-mode.json');
      await writeFile(filePath, JSON.stringify({
        name: 'Test', roleDefinition: 'A role'
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(false);
      expect(fieldsCheck!.details?.missing).toContain('slug');
    });

    it('should pass required_fields for profile_settings with all fields', async () => {
      const filePath = join(tempDir, 'profiles.json');
      await writeFile(filePath, JSON.stringify({ profiles: {}, apiConfigs: {} }));

      const result = await healthCheck.checkHealth(filePath, 'profile_settings');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should pass for rules_config with empty required fields', async () => {
      const filePath = join(tempDir, 'rules.json');
      await writeFile(filePath, JSON.stringify({ anything: 'goes' }));

      const result = await healthCheck.checkHealth(filePath, 'rules_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
      expect(fieldsCheck!.message).toContain('Aucun champ requis');
    });

    it('should pass for settings_config with empty required fields', async () => {
      const filePath = join(tempDir, 'settings.json');
      await writeFile(filePath, JSON.stringify({ customSetting: 42 }));

      const result = await healthCheck.checkHealth(filePath, 'settings_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should use custom requiredFields from options over defaults', async () => {
      const filePath = join(tempDir, 'custom.json');
      await writeFile(filePath, JSON.stringify({ customField: 'present' }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        requiredFields: ['customField']
      });

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should skip required_fields when JSON parsing failed', async () => {
      const filePath = join(tempDir, 'broken.json');
      await writeFile(filePath, '{ invalid }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.checks.map(c => c.name)).not.toContain('required_fields');
    });
  });

  // ================================================================
  // checkHealth -- mcp_loadable
  // ================================================================
  describe('checkHealth -- mcp_loadable check', () => {
    it('should pass for valid MCP config with servers', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: { 'test-server': { command: 'node', args: ['server.js'] } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'required_fields', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(true);
      expect(mcpCheck!.message).toContain('1 serveurs');
    });

    it('should pass when no mcpServers key exists', async () => {
      const filePath = join(tempDir, 'no-mcp.json');
      await writeFile(filePath, JSON.stringify({ otherConfig: true }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(true);
      expect(mcpCheck!.message).toContain('Pas de mcpServers');
    });

    it('should warn on MCP server missing command (not disabled)', async () => {
      const filePath = join(tempDir, 'no-cmd.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: { 'broken': { args: ['file.js'] } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(false);
      expect(mcpCheck!.message).toContain('command');
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should accept disabled server without command', async () => {
      const filePath = join(tempDir, 'disabled.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: { 'disabled-srv': { disabled: true } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(true);
    });

    it('should warn when disabled is not a boolean', async () => {
      const filePath = join(tempDir, 'bad-disabled.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: { 'srv': { disabled: 'yes', command: 'node' } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(false);
      expect(mcpCheck!.message).toContain('disabled');
    });

    it('should warn when args is not an array', async () => {
      const filePath = join(tempDir, 'bad-args.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: { 'srv': { command: 'node', args: 'not-an-array' } }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(false);
      expect(mcpCheck!.message).toContain('args');
    });

    it('should report multiple MCP issues in a single check', async () => {
      const filePath = join(tempDir, 'multi-issues.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'srv1': { args: 'string' },
          'srv2': { disabled: 'true' }
        }
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(false);
      expect(mcpCheck!.details?.issues.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip mcp_loadable for non-mcp_config types', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({
        slug: 'test', name: 'Test', roleDefinition: 'Role'
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.checks.map(c => c.name)).not.toContain('mcp_loadable');
    });

    it('should skip mcp_loadable when JSON is invalid', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{ broken }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable']
      });

      expect(result.checks.map(c => c.name)).not.toContain('mcp_loadable');
    });
  });

  // ================================================================
  // checkHealth -- selective check execution
  // ================================================================
  describe('checkHealth -- selective check execution', () => {
    it('should run only file_readable when specified', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{}');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['file_readable']
      });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('file_readable');
    });

    it('should run only json_valid when specified', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{"mcpServers":{}}');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid']
      });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('json_valid');
    });

    it('should run default checks when options.checks is not provided', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{"mcpServers":{}}');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.checks.map(c => c.name)).toEqual([
        'file_readable', 'json_valid', 'required_fields'
      ]);
    });
  });

  // ================================================================
  // checkHealth -- result structure
  // ================================================================
  describe('checkHealth -- result structure', () => {
    it('should include correct filePath and configType in result', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{}');

      const result = await healthCheck.checkHealth(filePath, 'roomodes_config');

      expect(result.filePath).toBe(filePath);
      expect(result.configType).toBe('roomodes_config');
    });

    it('should include a valid timestamp', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{}');

      const before = new Date();
      const result = await healthCheck.checkHealth(filePath, 'rules_config');
      const after = new Date();

      expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should have healthy=true when no errors', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should have healthy=false when errors exist', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{ invalid }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should log start and completion messages', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{}');

      await healthCheck.checkHealth(filePath, 'rules_config');

      expect(mockLogger.info).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenNthCalledWith(1,
        expect.stringContaining('marr'),
        expect.objectContaining({ configType: 'rules_config' })
      );
      expect(mockLogger.info).toHaveBeenNthCalledWith(2,
        expect.stringContaining('termin'),
        expect.any(Object)
      );
    });
  });

  // ================================================================
  // quickCheck
  // ================================================================
  describe('quickCheck()', () => {
    it('should return true for valid JSON file', async () => {
      const filePath = join(tempDir, 'valid.json');
      await writeFile(filePath, JSON.stringify({ key: 'value' }));

      expect(await healthCheck.quickCheck(filePath)).toBe(true);
    });

    it('should return true for empty JSON object', async () => {
      const filePath = join(tempDir, 'empty.json');
      await writeFile(filePath, '{}');

      expect(await healthCheck.quickCheck(filePath)).toBe(true);
    });

    it('should return false for invalid JSON', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, 'not json at all');

      expect(await healthCheck.quickCheck(filePath)).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      expect(await healthCheck.quickCheck('/nonexistent/path/file.json')).toBe(false);
    });

    it('should return false for empty file', async () => {
      const filePath = join(tempDir, 'empty-file.json');
      await writeFile(filePath, '');

      expect(await healthCheck.quickCheck(filePath)).toBe(false);
    });
  });

  // ================================================================
  // checkBatch
  // ================================================================
  describe('checkBatch()', () => {
    it('should process multiple files and report all healthy', async () => {
      const file1 = join(tempDir, 'a.json');
      const file2 = join(tempDir, 'b.json');
      await writeFile(file1, JSON.stringify({ mcpServers: {} }));
      await writeFile(file2, JSON.stringify({ mcpServers: {} }));

      const batch = await healthCheck.checkBatch([
        { path: file1, type: 'mcp_config' },
        { path: file2, type: 'mcp_config' }
      ]);

      expect(batch.healthy).toBe(true);
      expect(batch.summary.passed).toBe(2);
      expect(batch.summary.failed).toBe(0);
      expect(batch.results.size).toBe(2);
      expect(batch.results.has(file1)).toBe(true);
      expect(batch.results.has(file2)).toBe(true);
    });

    it('should report healthy=false when any file fails', async () => {
      const good = join(tempDir, 'good.json');
      const bad = join(tempDir, 'bad.json');
      await writeFile(good, JSON.stringify({ mcpServers: {} }));
      await writeFile(bad, '{ broken }');

      const batch = await healthCheck.checkBatch([
        { path: good, type: 'mcp_config' },
        { path: bad, type: 'mcp_config' }
      ]);

      expect(batch.healthy).toBe(false);
      expect(batch.summary.passed).toBe(1);
      expect(batch.summary.failed).toBe(1);
    });

    it('should report all failed when all files fail', async () => {
      const bad1 = join(tempDir, 'bad1.json');
      const bad2 = join(tempDir, 'bad2.json');
      await writeFile(bad1, '{ bad');
      await writeFile(bad2, '{ also bad');

      const batch = await healthCheck.checkBatch([
        { path: bad1, type: 'mcp_config' },
        { path: bad2, type: 'mcp_config' }
      ]);

      expect(batch.healthy).toBe(false);
      expect(batch.summary.failed).toBe(2);
      expect(batch.summary.passed).toBe(0);
    });

    it('should aggregate warnings from all files', async () => {
      const file1 = join(tempDir, 'w1.json');
      const file2 = join(tempDir, 'w2.json');
      await writeFile(file1, JSON.stringify({ other: 1 }));
      await writeFile(file2, JSON.stringify({ other: 2 }));

      const batch = await healthCheck.checkBatch([
        { path: file1, type: 'mcp_config' },
        { path: file2, type: 'mcp_config' }
      ]);

      expect(batch.summary.warnings).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty file list', async () => {
      const batch = await healthCheck.checkBatch([]);

      expect(batch.healthy).toBe(true);
      expect(batch.summary.passed).toBe(0);
      expect(batch.summary.failed).toBe(0);
      expect(batch.results.size).toBe(0);
    });

    it('should handle mixed config types in a single batch', async () => {
      const mcpFile = join(tempDir, 'mcp.json');
      const modeFile = join(tempDir, 'mode.json');
      const rulesFile = join(tempDir, 'rules.json');

      await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }));
      await writeFile(modeFile, JSON.stringify({ slug: 'x', name: 'X', roleDefinition: 'R' }));
      await writeFile(rulesFile, JSON.stringify({}));

      const batch = await healthCheck.checkBatch([
        { path: mcpFile, type: 'mcp_config' },
        { path: modeFile, type: 'mode_definition' },
        { path: rulesFile, type: 'rules_config' }
      ]);

      expect(batch.healthy).toBe(true);
      expect(batch.results.size).toBe(3);
    });

    it('should pass options to each individual check', async () => {
      const file1 = join(tempDir, 'opt1.json');
      const file2 = join(tempDir, 'opt2.json');
      await writeFile(file1, '{}');
      await writeFile(file2, '{}');

      const batch = await healthCheck.checkBatch(
        [
          { path: file1, type: 'rules_config' },
          { path: file2, type: 'rules_config' }
        ],
        { checks: ['file_readable'] }
      );

      for (const result of batch.results.values()) {
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].name).toBe('file_readable');
      }
    });
  });

  // ================================================================
  // roomodes_config type
  // ================================================================
  describe('roomodes_config type', () => {
    it('should pass for valid roomodes config', async () => {
      const filePath = join(tempDir, 'roomodes.json');
      await writeFile(filePath, JSON.stringify({
        customModes: [{ slug: 'mode1', name: 'Mode 1' }]
      }));

      const result = await healthCheck.checkHealth(filePath, 'roomodes_config');

      expect(result.healthy).toBe(true);
      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should warn when customModes is missing', async () => {
      const filePath = join(tempDir, 'roomodes-empty.json');
      await writeFile(filePath, JSON.stringify({ modes: [] }));

      const result = await healthCheck.checkHealth(filePath, 'roomodes_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(false);
      expect(fieldsCheck!.details?.missing).toContain('customModes');
    });
  });

  // ================================================================
  // model_config type
  // ================================================================
  describe('model_config type', () => {
    it('should pass for valid model config', async () => {
      const filePath = join(tempDir, 'model.json');
      await writeFile(filePath, JSON.stringify({
        profiles: { default: {} }, apiConfigs: { default: {} }
      }));

      const result = await healthCheck.checkHealth(filePath, 'model_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(true);
    });

    it('should warn when profiles is missing', async () => {
      const filePath = join(tempDir, 'model-partial.json');
      await writeFile(filePath, JSON.stringify({ apiConfigs: {} }));

      const result = await healthCheck.checkHealth(filePath, 'model_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(false);
      expect(fieldsCheck!.details?.missing).toContain('profiles');
    });

    it('should warn when apiConfigs is missing', async () => {
      const filePath = join(tempDir, 'model-partial2.json');
      await writeFile(filePath, JSON.stringify({ profiles: {} }));

      const result = await healthCheck.checkHealth(filePath, 'model_config');

      const fieldsCheck = result.checks.find(c => c.name === 'required_fields');
      expect(fieldsCheck!.passed).toBe(false);
      expect(fieldsCheck!.details?.missing).toContain('apiConfigs');
    });
  });

  // ================================================================
  // Edge cases
  // ================================================================
  describe('edge cases', () => {
    it('should handle deeply nested JSON without issue', async () => {
      const filePath = join(tempDir, 'deep.json');
      const deep: Record<string, any> = { mcpServers: {} };
      let current: any = deep;
      for (let i = 0; i < 50; i++) {
        current.nested = { level: i };
        current = current.nested;
      }
      await writeFile(filePath, JSON.stringify(deep));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');
      expect(result.healthy).toBe(true);
    });

    it('should handle file with only whitespace', async () => {
      const filePath = join(tempDir, 'whitespace.json');
      await writeFile(filePath, '   \n\t  ');

      const result = await healthCheck.checkHealth(filePath, 'rules_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(false);
    });

    it('should handle file with null JSON value', async () => {
      const filePath = join(tempDir, 'null.json');
      await writeFile(filePath, 'null');

      const result = await healthCheck.checkHealth(filePath, 'rules_config');

      const jsonCheck = result.checks.find(c => c.name === 'json_valid');
      expect(jsonCheck!.passed).toBe(true);
    });

    it('should handle large JSON file with many servers', async () => {
      const filePath = join(tempDir, 'large.json');
      const largeServers: Record<string, any> = {};
      for (let i = 0; i < 100; i++) {
        largeServers['server-' + i] = { command: 'node', args: ['s' + i + '.js'] };
      }
      await writeFile(filePath, JSON.stringify({ mcpServers: largeServers }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'required_fields', 'mcp_loadable']
      });

      expect(result.healthy).toBe(true);
      const mcpCheck = result.checks.find(c => c.name === 'mcp_loadable');
      expect(mcpCheck!.passed).toBe(true);
      expect(mcpCheck!.message).toContain('100 serveurs');
    });

    it('should handle file paths with spaces', async () => {
      const dirPath = join(tempDir, 'path with spaces');
      await mkdir(dirPath);
      const filePath = join(dirPath, 'config file.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config');
      expect(result.healthy).toBe(true);
    });
  });

  // ================================================================
  // timeout option
  // ================================================================
  describe('timeout option', () => {
    it('should accept a timeout option without error', async () => {
      const filePath = join(tempDir, 'config.json');
      await writeFile(filePath, '{}');

      const result = await healthCheck.checkHealth(filePath, 'rules_config', {
        timeout: 1000
      });

      expect(result.healthy).toBe(true);
    });
  });
});
