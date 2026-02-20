/**
 * Tests for git-helpers.ts
 * Coverage target: 24.77% → 70%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'child_process';
import { GitHelpers, getGitHelpers, resetGitHelpers } from '../git-helpers.js';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn()
}));

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const mockExec = vi.mocked(exec);

describe('git-helpers', () => {
  let gitHelpers: GitHelpers;

  beforeEach(() => {
    vi.clearAllMocks();
    resetGitHelpers();
    gitHelpers = new GitHelpers();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('verifyGitAvailable', () => {
    it('should return available=true when git is found', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.verifyGitAvailable();

      expect(result.available).toBe(true);
      expect(result.version).toBe('git version 2.40.0');
    });

    it('should return available=false when git is not found', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        const error = new Error('git: command not found');
        (error as any).code = 127;
        callback(error, { stdout: '', stderr: 'git: command not found' });
        return {} as any;
      });

      const result = await gitHelpers.verifyGitAvailable();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should cache git availability result', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });

      // First call
      await gitHelpers.verifyGitAvailable();
      // Second call
      await gitHelpers.verifyGitAvailable();

      // exec should only be called once due to caching
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('should return cached result after first check', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });

      const result1 = await gitHelpers.verifyGitAvailable();
      const result2 = await gitHelpers.verifyGitAvailable();

      expect(result1.version).toBe(result2.version);
    });
  });

  describe('execGitCommand', () => {
    it('should execute git command successfully', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'On branch main', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git status',
        'Check git status'
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('On branch main');
      expect(result.exitCode).toBe(0);
    });

    it('should return failure when git is not available', async () => {
      // First call for verifyGitAvailable
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        const error = new Error('git: command not found');
        callback(error, { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git status',
        'Check git status'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git not available on system');
    });

    it('should handle command failure', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        const error = new Error('fatal: not a git repository');
        (error as any).code = 128;
        callback(error, { stdout: '', stderr: 'fatal: not a git repository' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git status',
        'Check git status'
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(128);
    });

    it('should pass cwd option correctly', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementation((_cmd: any, options: any, callback: any) => {
        expect(options.cwd).toBe('/test/path');
        callback(null, { stdout: 'On branch main', stderr: '' });
        return {} as any;
      });

      await gitHelpers.execGitCommand(
        'git status',
        'Check status',
        { cwd: '/test/path' }
      );
    });
  });

  describe('getHeadSHA', () => {
    it('should return SHA on success', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'abcdef1234567890abcdef1234567890abcdef12', stderr: '' });
        return {} as any;
      });

      const sha = await gitHelpers.getHeadSHA('/test/path');

      expect(sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    });

    it('should return null on failure', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        const error = new Error('fatal: not a git repository');
        callback(error, { stdout: '', stderr: '' });
        return {} as any;
      });

      const sha = await gitHelpers.getHeadSHA('/test/path');

      expect(sha).toBeNull();
    });
  });

  describe('verifyHeadValid', () => {
    it('should return true for valid SHA', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'abcdef1234567890abcdef1234567890abcdef12', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.verifyHeadValid('/test/path');

      expect(result).toBe(true);
    });

    it('should return false for invalid SHA format', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'invalid-sha', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.verifyHeadValid('/test/path');

      expect(result).toBe(false);
    });

    it('should return false when getHeadSHA fails', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        const error = new Error('fatal: not a git repository');
        callback(error, { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.verifyHeadValid('/test/path');

      expect(result).toBe(false);
    });
  });

  describe('resetCache', () => {
    it('should clear git availability cache', async () => {
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });

      // First call
      await gitHelpers.verifyGitAvailable();
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Reset cache
      gitHelpers.resetCache();

      // Second call should re-check
      await gitHelpers.verifyGitAvailable();
      expect(mockExec).toHaveBeenCalledTimes(2);
    });
  });

  describe('getGitHelpers singleton', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getGitHelpers();
      const instance2 = getGitHelpers();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getGitHelpers();
      resetGitHelpers();
      const instance2 = getGitHelpers();

      expect(instance1).not.toBe(instance2);
    });
  });
});
