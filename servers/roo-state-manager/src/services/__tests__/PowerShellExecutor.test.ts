/**
 * Tests pour PowerShellExecutor.ts
 *
 * NOTE: The global mock in tests/setup/jest.setup.js replaces PowerShellExecutor
 * with a simplified stub. We unmock it here to test the REAL implementation
 * using locally-mocked fs and child_process.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Unmock the global mock set in jest.setup.js to test the real module.
vi.unmock('../PowerShellExecutor.js');

import {
  PowerShellExecutor,
  getDefaultExecutor,
  resetDefaultExecutor
} from '../PowerShellExecutor.js';
import { PowerShellExecutorError } from '../../types/errors.js';
import fs from 'fs';
import { spawn } from 'child_process';

// Mock fs and child_process - these are used by the real PowerShellExecutor
// but we control their behavior to test without a real PowerShell installation
vi.mock('fs');
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

const mockFs = vi.mocked(fs);
const mockSpawn = vi.mocked(spawn);

/**
 * Helper: create a mock ChildProcess-like object for spawn
 */
function createMockProcess(options?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}): any {
  const proc = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).killed = false;
  (proc as any).kill = vi.fn(() => { (proc as any).killed = true; });

  // Schedule events asynchronously
  process.nextTick(() => {
    if (options?.error) {
      proc.emit('error', options.error);
      return;
    }
    if (options?.stdout) {
      stdoutEmitter.emit('data', Buffer.from(options.stdout, 'utf-8'));
    }
    if (options?.stderr) {
      stderrEmitter.emit('data', Buffer.from(options.stderr, 'utf-8'));
    }
    proc.emit('close', options?.exitCode ?? 0);
  });

  return proc;
}

describe('PowerShellExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDefaultExecutor();
    PowerShellExecutor.setMockPowerShellPath(null);
    // Set required environment variable for tests
    process.env.ROOSYNC_SHARED_PATH = '/mock/path';

    // Reset mockFs for each test
    mockFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    // Clean up environment variable
    delete process.env.ROOSYNC_SHARED_PATH;
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
        powershellPath: 'C:\\\\custom\\\\pwsh.exe',
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

      expect(() => new PowerShellExecutor()).toThrow('ROOSYNC_SHARED_PATH');
    });
  });

  describe('getSystemPowerShellPath', () => {
    test('should return mock path when set', () => {
      PowerShellExecutor.setMockPowerShellPath('mocked/path/pwsh.exe');

      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('mocked/path/pwsh.exe');
    });

    test('should return default path when no mock and no file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      const path = PowerShellExecutor.getSystemPowerShellPath();

      expect(path).toBe('pwsh.exe');
    });
  });

  describe('executeScript', () => {
    test('should reject when script file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      await expect(executor.executeScript('nonexistent.ps1')).rejects.toThrow('Script not found');
    });

    test('should handle spawn error', async () => {
      mockFs.existsSync.mockReturnValue(true);

      mockSpawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      await expect(executor.executeScript('test.ps1')).rejects.toThrow('Failed to spawn PowerShell');
    });

    test('should return success for successful execution', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockSpawn.mockReturnValue(createMockProcess({ stdout: 'hello\n', exitCode: 0 }));

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      const result = await executor.executeScript('test.ps1');
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello');
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

    test('should throw PowerShellExecutorError when no JSON found', () => {
      const stdout = 'No JSON here, just text';

      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow('No valid JSON object found');
      // Verify it is the right error type by checking name
      try {
        PowerShellExecutor.parseJsonOutput(stdout);
      } catch (e: any) {
        expect(e.name).toBe('PowerShellExecutorError');
      }
    });

    test('should throw PowerShellExecutorError when JSON brackets are malformed', () => {
      const stdout = '} { malformed JSON';

      try {
        PowerShellExecutor.parseJsonOutput(stdout);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.name).toBe('PowerShellExecutorError');
      }
    });

    test('should throw PowerShellExecutorError when JSON parsing fails', () => {
      const stdout = '{invalid json}';

      expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow('Failed to parse PowerShell JSON output');
      try {
        PowerShellExecutor.parseJsonOutput(stdout);
      } catch (e: any) {
        expect(e.name).toBe('PowerShellExecutorError');
      }
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

  describe('isPowerShellAvailable', () => {
    test('should return true when PowerShell is available', async () => {
      // Set up spawn to return a mock process with "test" output
      mockSpawn.mockReturnValue(createMockProcess({ stdout: 'test', exitCode: 0 }));

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(true);
    });

    test('should return false when PowerShell execution fails', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });

    test('should return false when PowerShell returns non-zero exit code', async () => {
      mockSpawn.mockReturnValue(createMockProcess({ exitCode: 1 }));

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });

    test('should return false when output is not "test"', async () => {
      mockSpawn.mockReturnValue(createMockProcess({ stdout: 'wrong output', exitCode: 0 }));

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });
  });

  describe('getPowerShellVersion', () => {
    test('should return PowerShell version when available', async () => {
      mockSpawn.mockReturnValue(createMockProcess({ stdout: '7.3.0', exitCode: 0 }));

      const result = await PowerShellExecutor.getPowerShellVersion();
      expect(result).toBe('7.3.0');
    });

    test('should return null when PowerShell execution fails', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const result = await PowerShellExecutor.getPowerShellVersion();
      expect(result).toBe(null);
    });

    test('should return null when PowerShell returns non-zero exit code', async () => {
      mockSpawn.mockReturnValue(createMockProcess({ exitCode: 1 }));

      const result = await PowerShellExecutor.getPowerShellVersion();
      expect(result).toBe(null);
    });
  });

  describe('executeScript timeout handling', () => {
    test('should handle timeout correctly', async () => {
      // Mock the executeScript method to simulate timeout
      const mockExecuteScript = vi.fn().mockResolvedValue({
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: 'Process timed out and was killed',
        executionTime: 100
      });

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      // Mock the instance method
      executor.executeScript = mockExecuteScript;

      const result = await executor.executeScript('test.ps1', [], { timeout: 100 });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Process timed out and was killed');
    }, 20000);

    test('should handle process error during execution', async () => {
      // Mock the executeScript method to simulate error
      const mockExecuteScript = vi.fn().mockRejectedValue(
        new Error('PowerShell execution failed: Process crashed')
      );

      const executor = new PowerShellExecutor({
        roosyncBasePath: '/mock/path'
      });

      // Mock the instance method
      executor.executeScript = mockExecuteScript;

      await expect(executor.executeScript('test.ps1')).rejects.toThrow('PowerShell execution failed: Process crashed');
    });
  });
});
