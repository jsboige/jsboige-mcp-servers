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

  describe('execGitCommand with logSHA', () => {
    it('should log SHA before and after when SHA unchanged', async () => {
      const sha = 'abc123def456abc123def456abc123def456abc1';
      // 1. verifyGitAvailable
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      // 2. SHA before
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' });
        return {} as any;
      });
      // 3. Actual command
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'Already up to date.', stderr: '' });
        return {} as any;
      });
      // 4. SHA after (same)
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git pull origin',
        'Pull from origin',
        { cwd: '/test/path', logSHA: true }
      );

      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(4);
    });

    it('should log SHA changed when SHA differs', async () => {
      const shaBeforeVal = 'aaa123def456abc123def456abc123def456abc1';
      const shaAfterVal = 'bbb456def456abc123def456abc123def456abc1';
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: shaBeforeVal, stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'Fast-forward', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: shaAfterVal, stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git pull origin',
        'Pull from origin',
        { cwd: '/test/path', logSHA: true }
      );

      expect(result.success).toBe(true);
    });

    it('should handle SHA retrieval failure gracefully (non-fatal)', async () => {
      // 1. verifyGitAvailable
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      // 2. SHA before fails
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(new Error('not a git repo'), { stdout: '', stderr: '' });
        return {} as any;
      });
      // 3. Actual command succeeds
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'ok', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand(
        'git status',
        'Status',
        { cwd: '/test/path', logSHA: true }
      );

      // Should still succeed (SHA retrieval failure is non-fatal)
      expect(result.success).toBe(true);
    });

    it('should log stderr as warning on success with stderr output', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' });
        return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'On branch main', stderr: 'warning: LF will be replaced by CRLF' });
        return {} as any;
      });

      const result = await gitHelpers.execGitCommand('git status', 'Check status');

      expect(result.success).toBe(true);
      expect(result.output).toBe('On branch main');
    });
  });

  describe('safePull', () => {
    const sha = 'abc123def456abc123def456abc123def456abc1';

    it('should pull successfully with default remote', async () => {
      // 1. verifyGitAvailable (cached after)
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' }); return {} as any;
      });
      // 2. getHeadSHA before pull
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 3. SHA before in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 4. git pull origin
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'Already up to date.', stderr: '' }); return {} as any;
      });
      // 5. SHA after in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 6. verifyHeadValid after pull
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });

      const result = await gitHelpers.safePull('/test/path');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Already up to date.');
    });

    it('should pull with custom remote and branch', async () => {
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' }); return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, options: any, callback: any) => {
        // Verify the command includes custom remote and branch
        expect(_cmd).toContain('git pull upstream dev');
        callback(null, { stdout: 'Fast-forward', stderr: '' }); return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });

      const result = await gitHelpers.safePull('/test/path', 'upstream', 'dev');

      expect(result.success).toBe(true);
    });

    it('should return failure when HEAD is invalid before pull', async () => {
      // verifyGitAvailable → git not found → verifyHeadValid → false
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(new Error('git: command not found'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.safePull('/test/path');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA invalid before pull');
    });

    it('should return failure when HEAD corrupted after pull', async () => {
      // Pull succeeds but HEAD is invalid afterwards
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' }); return {} as any;
      });
      // getHeadSHA before - valid sha
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // SHA before in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // git pull - success
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'Fast-forward', stderr: '' }); return {} as any;
      });
      // SHA after in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // verifyHeadValid after - git returns invalid sha
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'invalid-sha', stderr: '' }); return {} as any;
      });

      const result = await gitHelpers.safePull('/test/path');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA corrupted after pull');
    });
  });

  describe('safeCheckout', () => {
    const sha = 'abc123def456abc123def456abc123def456abc1';

    it('should checkout successfully', async () => {
      // 1. verifyGitAvailable
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' }); return {} as any;
      });
      // 2. getHeadSHA before checkout
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 3. SHA before in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 4. git checkout
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: "Switched to branch 'feature'", stderr: '' }); return {} as any;
      });
      // 5. SHA after in logSHA
      const newSha = 'def456abc123def456abc123def456abc123def4';
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: newSha, stderr: '' }); return {} as any;
      });
      // 6. getHeadSHA after checkout (verification)
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: newSha, stderr: '' }); return {} as any;
      });

      const result = await gitHelpers.safeCheckout('/test/path', 'feature');

      expect(result.success).toBe(true);
    });

    it('should return failure when HEAD cannot be retrieved before checkout', async () => {
      // git not found → getHeadSHA returns null
      mockExec.mockImplementation((_cmd: any, _options: any, callback: any) => {
        callback(new Error('git: command not found'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await gitHelpers.safeCheckout('/test/path', 'feature');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot get HEAD SHA before checkout');
    });

    it('should rollback and return failure when HEAD invalid after checkout', async () => {
      // 1. verifyGitAvailable
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'git version 2.40.0', stderr: '' }); return {} as any;
      });
      // 2. getHeadSHA before - valid
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 3. SHA before in logSHA
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 4. git checkout - success
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: "Switched to branch 'feature'", stderr: '' }); return {} as any;
      });
      // 5. SHA after in logSHA - valid sha
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: sha, stderr: '' }); return {} as any;
      });
      // 6. getHeadSHA after checkout - fails (returns null)
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(new Error('corruption'), { stdout: '', stderr: '' }); return {} as any;
      });
      // 7. Rollback git checkout (attempt)
      mockExec.mockImplementationOnce((_cmd: any, _options: any, callback: any) => {
        callback(null, { stdout: 'HEAD is now at abc123d', stderr: '' }); return {} as any;
      });

      const result = await gitHelpers.safeCheckout('/test/path', 'feature');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA invalid after checkout, rolled back');
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
