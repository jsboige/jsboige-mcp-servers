/**
 * Tests pour PowerShellExecutor.ts
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  PowerShellExecutor,
  getDefaultExecutor,
  resetDefaultExecutor
} from '../PowerShellExecutor.js';
import { PowerShellExecutorError } from '../../types/errors.js';
import fs from 'fs';
import { spawn } from 'child_process';

// Unmock PowerShellExecutor to use the real class with static methods
// The global mock in jest.setup.js doesn't include setMockPowerShellPath
vi.unmock('../PowerShellExecutor.js');

// Mocks
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn()
  }
}));

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

describe('PowerShellExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDefaultExecutor();
    PowerShellExecutor.setMockPowerShellPath(null);
  });

  describe('constructor', () => {
    test('should use default PowerShell path when not provided', () => {
      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      expect(executor).toBeDefined();
    });

    test('should use provided PowerShell path', () => {
      const executor = new PowerShellExecutor({
        powershellPath: 'C:\\custom\\pwsh.exe',
        roosyncBasePath: '/mock/path'
      });

      expect(executor).toBeDefined();
    });

    test('should use ROOSYNC_SHARED_PATH from env when roosyncBasePath not provided', () => {
      process.env.ROOSYNC_SHARED_PATH = '/env/path';

      const executor = new PowerShellExecutor();

      expect(executor).toBeDefined();
      delete process.env.ROOSYNC_SHARED_PATH;
    });

    test('should throw error when ROOSYNC_SHARED_PATH not defined', () => {
      delete process.env.ROOSYNC_SHARED_PATH;

      expect(() => new PowerShellExecutor()).toThrow('ROOSYNC_SHARED_PATH non défini');
    });
  });

  describe('getSystemPowerShellPath', () => {
    test('should return mock path when set', () => {
      PowerShellExecutor.setMockPowerShellPath('mocked/path/pwsh.exe');

      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('mocked/path/pwsh.exe');
    });

    test('should return default path when no mock and no file exists', () => {
      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('pwsh.exe');
    });
  });

  describe('executeScript', () => {
    test('should reject when script file does not exist', async () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockReturnValue(false);

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      await expect(executor.executeScript('nonexistent.ps1')).rejects.toThrow('Script not found');
    });

    test('should handle spawn error', async () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockReturnValue(true);

      const mockSpawn = vi.mocked(spawn);
      mockSpawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      await expect(executor.executeScript('test.ps1')).rejects.toThrow('Failed to spawn PowerShell');
    });
  });

  describe('parseJsonOutput', () => {
    test('should parse valid JSON output', () => {
      const stdout = 'Some logs\n{"key": "value", "number": 123}\nMore logs';

      const result = PowerShellExecutor.parseJsonOutput<{ key: string; number: number }>(stdout);

      expect(result).toEqual({ key: 'value', number: 123 });
    });

    test('should parse JSON without surrounding text', () => {
      const stdout = '{"key": "value"}';

      const result = PowerShellExecutor.parseJsonOutput<{ key: string }>(stdout);

      expect(result).toEqual({ key: 'value' });
    });

    test('should throw error when no JSON found', () => {
      const stdout = 'No JSON here, just text';

      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow(PowerShellExecutorError);
      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow('No valid JSON object found');
    });

    test('should throw error when JSON brackets are malformed', () => {
      const stdout = '} { malformed JSON';

      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow(PowerShellExecutorError);
    });

    test('should throw error when JSON parsing fails', () => {
      const stdout = '{invalid json}';

      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow(PowerShellExecutorError);
      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow('Failed to parse PowerShell JSON output');
    });
  });

  describe('getDefaultExecutor', () => {
    test('should return singleton instance', () => {
      const executor1 = getDefaultExecutor({
        roosyncBasePath: '/mock/path'
      });
      const executor2 = getDefaultExecutor();

      expect(executor1).toBe(executor2);
    });

    test('should create new instance after reset', () => {
      const executor1 = getDefaultExecutor({
        roosyncBasePath: '/mock/path'
      });
      resetDefaultExecutor();
      const executor2 = getDefaultExecutor({
        roosyncBasePath: '/mock/path'
      });

      expect(executor1).not.toBe(executor2);
    });
  });

  describe('resetDefaultExecutor', () => {
    test('should reset singleton instance', () => {
      const executor1 = getDefaultExecutor({
        roosyncBasePath: '/mock/path'
      });

      resetDefaultExecutor();

      const executor2 = getDefaultExecutor({
        roosyncBasePath: '/mock/path'
      });

      expect(executor1).not.toBe(executor2);
    });
  });

  describe('setMockPowerShellPath', () => {
    test('should set and return mock path', () => {
      PowerShellExecutor.setMockPowerShellPath('mock/pwsh.exe');

      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('mock/pwsh.exe');
    });

    test('should clear resolved path when setting new mock', () => {
      PowerShellExecutor.getSystemPowerShellPath(); // Cache default
      PowerShellExecutor.setMockPowerShellPath('new/mock/pwsh.exe');

      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('new/mock/pwsh.exe');
    });

    test('should allow resetting mock to null', () => {
      PowerShellExecutor.setMockPowerShellPath('mock/pwsh.exe');
      expect(PowerShellExecutor.getSystemPowerShellPath()).toBe('mock/pwsh.exe');

      PowerShellExecutor.setMockPowerShellPath(null);
      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).not.toBe('mock/pwsh.exe');
    });
  });
});
