/**
 * Tests for GitHelpers - Production Git safety utilities
 *
 * @module tests/unit/utils/git-helpers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() ensures references exist before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockExec, mockInfo, mockError, mockWarn, mockDebug } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockDebug: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: mockExec,
}));

vi.mock('util', () => ({
  promisify: () => mockExec,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: mockInfo,
    error: mockError,
    warn: mockWarn,
    debug: mockDebug,
  }),
}));

// Import after mocks are set up
import { GitHelpers, getGitHelpers, resetGitHelpers } from '../../../src/utils/git-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard 40-char hex SHA for tests */
const FAKE_SHA = '0123456789abcdef0123456789abcdef01234567';
const FAKE_SHA_ALT = 'fedcba9876543210fedcba9876543210fedcba98';
const FAKE_GIT_VERSION = 'git version 2.43.0';

/** Make mockExec resolve with given stdout/stderr */
function mockExecSuccess(stdout: string, stderr = '') {
  mockExec.mockResolvedValueOnce({ stdout, stderr });
}

/** Make mockExec reject with given error properties */
function mockExecFailure(message: string, extra: Record<string, any> = {}) {
  const err: any = new Error(message);
  Object.assign(err, extra);
  mockExec.mockRejectedValueOnce(err);
}

/**
 * Sequence the availability check so subsequent execGitCommand / getHeadSHA
 * calls can proceed without re-mocking git --version every time.
 * Returns the number of mock slots consumed (always 1).
 */
function mockGitAvailable(): number {
  mockExecSuccess(FAKE_GIT_VERSION);
  return 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHelpers', () => {
  let git: GitHelpers;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReset();
    resetGitHelpers();
    git = new GitHelpers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // verifyGitAvailable
  // =========================================================================
  describe('verifyGitAvailable', () => {
    it('should return available=true with version when git is installed', async () => {
      mockExecSuccess(FAKE_GIT_VERSION);

      const result = await git.verifyGitAvailable();

      expect(result.available).toBe(true);
      expect(result.version).toBe(FAKE_GIT_VERSION);
      expect(mockExec).toHaveBeenCalledWith('git --version', { timeout: 5000 });
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Git trouvé'));
    });

    it('should return available=false with error when git is not installed', async () => {
      mockExecFailure('git not found', { code: 'ENOENT' });

      const result = await git.verifyGitAvailable();

      expect(result.available).toBe(false);
      expect(result.error).toContain('git not found');
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('Git NON TROUVÉ'),
        expect.any(Error),
      );
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('git-scm.com'));
    });

    it('should cache the result and not call exec again on second call', async () => {
      mockExecSuccess(FAKE_GIT_VERSION);

      await git.verifyGitAvailable();
      const result = await git.verifyGitAvailable();

      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(result.available).toBe(true);
      expect(result.version).toBe(FAKE_GIT_VERSION);
    });

    it('should cache a failed result as well', async () => {
      mockExecFailure('not found');

      await git.verifyGitAvailable();
      const result = await git.verifyGitAvailable();

      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(result.available).toBe(false);
    });

    it('should handle non-Error thrown values', async () => {
      mockExec.mockRejectedValueOnce('string-error');

      const result = await git.verifyGitAvailable();

      expect(result.available).toBe(false);
      expect(result.error).toBe('string-error');
    });

    it('should return version from cache even if undefined initially', async () => {
      mockExecSuccess(FAKE_GIT_VERSION);

      const first = await git.verifyGitAvailable();
      expect(first.version).toBe(FAKE_GIT_VERSION);

      // Second call should come from cache
      const second = await git.verifyGitAvailable();
      expect(second.version).toBe(FAKE_GIT_VERSION);
    });
  });

  // =========================================================================
  // execGitCommand
  // =========================================================================
  describe('execGitCommand', () => {
    it('should execute a command and return success result', async () => {
      mockGitAvailable(); // availability check
      mockExecSuccess('On branch main\nnothing to commit');

      const result = await git.execGitCommand('git status', 'Check status');

      expect(result.success).toBe(true);
      expect(result.output).toBe('On branch main\nnothing to commit');
      expect(result.exitCode).toBe(0);
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Succès'));
    });

    it('should return failure when command fails', async () => {
      mockGitAvailable();
      mockExecFailure('fatal: not a git repository', { code: 128, stderr: 'not a git repo' });

      const result = await git.execGitCommand('git status', 'Check status');

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.exitCode).toBe(128);
      expect(result.error).toContain('fatal: not a git repository');
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Échec'), expect.anything());
    });

    it('should return error when git is not available', async () => {
      mockExecFailure('git not found');

      const result = await git.execGitCommand('git status', 'Check status');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git not available on system');
      expect(result.exitCode).toBe(-1);
    });

    it('should pass cwd option to exec', async () => {
      mockGitAvailable();
      mockExecSuccess('ok');

      await git.execGitCommand('git status', 'Check status', { cwd: '/repo/path' });

      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('git status'),
        expect.objectContaining({ cwd: '/repo/path' }),
      );
    });

    it('should pass timeout option to exec (default 30000)', async () => {
      mockGitAvailable();
      mockExecSuccess('ok');

      await git.execGitCommand('git status', 'Check status');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 30000 }),
      );
    });

    it('should use custom timeout when provided', async () => {
      mockGitAvailable();
      mockExecSuccess('ok');

      await git.execGitCommand('git status', 'Check status', { timeout: 5000 });

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('should log SHA before and after when logSHA is true and cwd is set', async () => {
      mockGitAvailable();            // availability
      mockExecSuccess(FAKE_SHA);     // SHA before (git rev-parse HEAD)
      mockExecSuccess('done');       // actual command
      mockExecSuccess(FAKE_SHA_ALT); // SHA after (different)

      const result = await git.execGitCommand(
        'git pull',
        'Pull changes',
        { cwd: '/repo', logSHA: true },
      );

      expect(result.success).toBe(true);
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('SHA avant'),
      );
      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining('changé'),
      );
    });

    it('should log "inchangé" when SHA is the same after operation', async () => {
      mockGitAvailable();
      mockExecSuccess(FAKE_SHA);  // SHA before
      mockExecSuccess('done');     // actual command
      mockExecSuccess(FAKE_SHA);  // SHA after (same)

      const result = await git.execGitCommand(
        'git pull',
        'Pull changes',
        { cwd: '/repo', logSHA: true },
      );

      expect(result.success).toBe(true);
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('inchangé'),
      );
    });

    it('should warn when SHA retrieval fails before operation', async () => {
      mockGitAvailable();
      mockExecFailure('no sha'); // SHA before fails
      mockExecSuccess('done');    // actual command

      const result = await git.execGitCommand(
        'git pull',
        'Pull changes',
        { cwd: '/repo', logSHA: true },
      );

      expect(result.success).toBe(true);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('SHA avant'),
      );
    });

    it('should warn when SHA retrieval fails after operation', async () => {
      mockGitAvailable();
      mockExecSuccess(FAKE_SHA); // SHA before
      mockExecSuccess('done');    // actual command
      mockExecFailure('no sha'); // SHA after fails

      const result = await git.execGitCommand(
        'git pull',
        'Pull changes',
        { cwd: '/repo', logSHA: true },
      );

      expect(result.success).toBe(true);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('SHA après'),
      );
    });

    it('should skip SHA logging when cwd is not provided', async () => {
      mockGitAvailable();
      mockExecSuccess('done');

      await git.execGitCommand('git status', 'Status check', { logSHA: true });

      // Only 2 calls: availability + actual command (no SHA rev-parse)
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('should handle stderr output as non-fatal warning', async () => {
      mockGitAvailable();
      mockExecSuccess('output', 'some warning message');

      const result = await git.execGitCommand('git status', 'Check status');

      expect(result.success).toBe(true);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('stderr'));
    });

    it('should log stderr in failure case', async () => {
      mockGitAvailable();
      mockExecFailure('command failed', { code: 1, stderr: 'error details' });

      await git.execGitCommand('git push', 'Push changes');

      // The source code calls mockError with a string (not an Error) for the
      // "Git stderr: ..." log line.
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('Git stderr'),
      );
    });

    it('should handle error without stderr', async () => {
      mockGitAvailable();
      mockExecFailure('unknown error');

      const result = await git.execGitCommand('git push', 'Push');

      expect(result.success).toBe(false);
      expect(result.error).toBe('unknown error');
      expect(result.exitCode).toBe(-1);
    });

    it('should use cached git availability on repeated calls', async () => {
      mockGitAvailable(); // availability (cached after first)
      mockExecSuccess('output1');
      mockExecSuccess('output2');

      await git.execGitCommand('git status', 'Status 1');
      await git.execGitCommand('git status', 'Status 2');

      // availability check only once, then 2 actual commands = 3 total
      expect(mockExec).toHaveBeenCalledTimes(3);
    });

    it('should pass encoding utf-8 to exec', async () => {
      mockGitAvailable();
      mockExecSuccess('ok');

      await git.execGitCommand('git status', 'Check');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('should handle error with non-Error thrown value', async () => {
      mockGitAvailable();
      mockExec.mockRejectedValueOnce('string-error');

      const result = await git.execGitCommand('git status', 'Check');

      expect(result.success).toBe(false);
      expect(result.error).toBe('string-error');
    });
  });

  // =========================================================================
  // getHeadSHA
  // =========================================================================
  describe('getHeadSHA', () => {
    it('should return the SHA string on success', async () => {
      mockGitAvailable();       // availability
      mockExecSuccess(FAKE_SHA); // rev-parse HEAD

      const sha = await git.getHeadSHA('/repo');

      expect(sha).toBe(FAKE_SHA);
    });

    it('should return null when command fails', async () => {
      mockGitAvailable();
      mockExecFailure('not a git repo', { code: 128 });

      const sha = await git.getHeadSHA('/repo');

      expect(sha).toBeNull();
    });

    it('should pass correct timeout of 5000 and cwd', async () => {
      mockGitAvailable();
      mockExecSuccess(FAKE_SHA);

      await git.getHeadSHA('/repo');

      // Second call is the actual command (rev-parse HEAD)
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        'git rev-parse HEAD',
        expect.objectContaining({ timeout: 5000, cwd: '/repo' }),
      );
    });
  });

  // =========================================================================
  // verifyHeadValid
  // =========================================================================
  describe('verifyHeadValid', () => {
    it('should return true for a valid 40-char hex SHA', async () => {
      mockGitAvailable();
      mockExecSuccess(FAKE_SHA);

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(true);
    });

    it('should return false for an invalid SHA format', async () => {
      mockGitAvailable();
      mockExecSuccess('not-a-valid-sha');

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(false);
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('SHA HEAD invalide'),
      );
    });

    it('should return false when getHeadSHA returns null', async () => {
      mockGitAvailable();
      mockExecFailure('error');

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(false);
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('Impossible de récupérer HEAD SHA'),
      );
    });

    it('should return false for a short SHA', async () => {
      mockGitAvailable();
      mockExecSuccess('0123456'); // only 7 chars

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(false);
    });

    it('should return false for a SHA with uppercase letters', async () => {
      mockGitAvailable();
      mockExecSuccess('ABCDEF0123456789ABCDEF0123456789ABCDEF01');

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(false);
    });

    it('should return false for a 39-char hex string', async () => {
      mockGitAvailable();
      mockExecSuccess('0123456789abcdef0123456789abcdef0123456'); // 39 chars

      const valid = await git.verifyHeadValid('/repo');

      expect(valid).toBe(false);
    });
  });

  // =========================================================================
  // safePull
  //
  // Call flow for a successful safePull:
  //   1. verifyHeadValid -> getHeadSHA -> execGitCommand ->
  //      verifyGitAvailable (git --version) + git rev-parse HEAD
  //   2. execGitCommand(pull) with logSHA: true ->
  //      verifyGitAvailable (cached) + git rev-parse HEAD (SHA before) +
  //      git pull + git rev-parse HEAD (SHA after)
  //   3. verifyHeadValid -> getHeadSHA -> execGitCommand ->
  //      verifyGitAvailable (cached) + git rev-parse HEAD
  //
  // Total mockExec calls: 1 + 1 + 1 + 1 + 1 + 1 = 6
  // =========================================================================
  describe('safePull', () => {
    it('should perform a successful pull with HEAD verification', async () => {
      // Step 1: verifyHeadValid before (getHeadSHA -> execGitCommand)
      mockExecSuccess(FAKE_GIT_VERSION); // 1. verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2. git rev-parse HEAD (for getHeadSHA)

      // Step 2: execGitCommand(pull) with logSHA: true
      mockExecSuccess(FAKE_SHA);          // 3. git rev-parse HEAD (SHA before in logSHA)
      mockExecSuccess('Already up to date.'); // 4. git pull origin
      mockExecSuccess(FAKE_SHA);          // 5. git rev-parse HEAD (SHA after in logSHA)

      // Step 3: verifyHeadValid after (getHeadSHA -> execGitCommand)
      mockExecSuccess(FAKE_SHA);          // 6. git rev-parse HEAD (for getHeadSHA)

      const result = await git.safePull('/repo');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Already up to date.');
      expect(mockExec).toHaveBeenCalledTimes(6);
    });

    it('should fail if HEAD is invalid before pull', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // verifyGitAvailable
      mockExecFailure('corrupt');         // git rev-parse HEAD fails -> getHeadSHA returns null

      const result = await git.safePull('/repo');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA invalid before pull');
      expect(result.exitCode).toBe(-1);
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('should fail if HEAD is corrupted after pull (exec throws)', async () => {
      // verifyHeadValid before
      mockExecSuccess(FAKE_GIT_VERSION); // 1. verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2. git rev-parse HEAD (before, valid)

      // execGitCommand(pull) with logSHA
      mockExecSuccess(FAKE_SHA);          // 3. SHA before (logSHA)
      mockExecSuccess('pulled');           // 4. git pull origin (succeeds)
      mockExecSuccess(FAKE_SHA);          // 5. SHA after (logSHA)

      // verifyHeadValid after: getHeadSHA fails
      mockExecFailure('corrupt');          // 6. git rev-parse HEAD fails

      const result = await git.safePull('/repo');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA corrupted after pull');
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('corrompu après pull'),
      );
    });

    it('should fail if HEAD SHA is invalid format after pull', async () => {
      // verifyHeadValid before
      mockExecSuccess(FAKE_GIT_VERSION); // 1
      mockExecSuccess(FAKE_SHA);          // 2 valid before

      // execGitCommand(pull) with logSHA
      mockExecSuccess(FAKE_SHA);          // 3 SHA before
      mockExecSuccess('pulled');           // 4 git pull
      mockExecSuccess(FAKE_SHA);          // 5 SHA after

      // verifyHeadValid after: returns bad format SHA
      mockExecSuccess('bad-format-sha');  // 6

      const result = await git.safePull('/repo');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA corrupted after pull');
    });

    it('should use default remote "origin" when not specified', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 verifyHeadValid before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('ok');              // 4 git pull origin
      mockExecSuccess(FAKE_SHA);          // 5 SHA after (logSHA)
      mockExecSuccess(FAKE_SHA);          // 6 verifyHeadValid after

      await git.safePull('/repo');

      // 4th call is the actual pull command
      expect(mockExec).toHaveBeenNthCalledWith(
        4,
        'git pull origin',
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('should include branch in pull command when specified', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1
      mockExecSuccess(FAKE_SHA);          // 2
      mockExecSuccess(FAKE_SHA);          // 3
      mockExecSuccess('ok');              // 4 git pull upstream develop
      mockExecSuccess(FAKE_SHA);          // 5
      mockExecSuccess(FAKE_SHA);          // 6

      await git.safePull('/repo', 'upstream', 'develop');

      expect(mockExec).toHaveBeenNthCalledWith(
        4,
        'git pull upstream develop',
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('should track SHA before and after the pull (logSHA behavior)', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 verifyHeadValid before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('ok');              // 4 pull
      mockExecSuccess(FAKE_SHA);          // 5 SHA after (logSHA)
      mockExecSuccess(FAKE_SHA);          // 6 verifyHeadValid after

      await git.safePull('/repo');

      // logSHA: true causes 2 extra git rev-parse HEAD calls (SHA before + after)
      // Total 6 calls: availability + verify-before + SHA-before + pull + SHA-after + verify-after
      expect(mockExec).toHaveBeenCalledTimes(6);
      // The pull command itself (4th call)
      expect(mockExec).toHaveBeenNthCalledWith(4, 'git pull origin', expect.anything());
    });

    it('should return pull result directly when pull command fails', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 verifyHeadValid before (valid)
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecFailure('conflict', { code: 1 }); // 4 git pull fails

      const result = await git.safePull('/repo');

      expect(result.success).toBe(false);
      // No post-pull HEAD verification when pull itself fails
      // 4 calls: availability + HEAD before verify + SHA before + pull
      expect(mockExec).toHaveBeenCalledTimes(4);
    });
  });

  // =========================================================================
  // safeCheckout
  //
  // Call flow for a successful safeCheckout:
  //   1. getHeadSHA -> execGitCommand ->
  //      verifyGitAvailable (git --version) + git rev-parse HEAD
  //   2. execGitCommand(checkout) with logSHA: true ->
  //      verifyGitAvailable (cached) + git rev-parse HEAD (SHA before) +
  //      git checkout + git rev-parse HEAD (SHA after)
  //   3. getHeadSHA -> execGitCommand ->
  //      verifyGitAvailable (cached) + git rev-parse HEAD
  //
  // Total mockExec calls: 1 + 1 + 1 + 1 + 1 + 1 + 1 = 7
  // =========================================================================
  describe('safeCheckout', () => {
    it('should perform a successful checkout', async () => {
      // Step 1: getHeadSHA before
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 git rev-parse HEAD

      // Step 2: execGitCommand(checkout) with logSHA: true
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('Switched to branch'); // 4 git checkout feature-branch
      mockExecSuccess(FAKE_SHA_ALT);      // 5 SHA after (logSHA, changed)

      // Step 3: getHeadSHA after
      mockExecSuccess(FAKE_SHA_ALT);      // 6 git rev-parse HEAD (valid)

      const result = await git.safeCheckout('/repo', 'feature-branch');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Switched to branch');
    });

    it('should fail when HEAD cannot be retrieved before checkout', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecFailure('no HEAD');         // 2 git rev-parse HEAD fails

      const result = await git.safeCheckout('/repo', 'feature-branch');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot get HEAD SHA before checkout');
    });

    it('should rollback when HEAD is invalid after checkout', async () => {
      // Step 1: getHeadSHA before
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 git rev-parse HEAD (before)

      // Step 2: execGitCommand(checkout) with logSHA: true
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('Switched to branch'); // 4 git checkout
      mockExecSuccess(FAKE_SHA_ALT);      // 5 SHA after (logSHA)

      // Step 3: getHeadSHA after fails
      mockExecFailure('corrupt');          // 6 git rev-parse HEAD fails

      // Step 4: rollback checkout
      mockExecSuccess('ok');               // 7 git checkout <sha-prefix>

      const result = await git.safeCheckout('/repo', 'feature-branch');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HEAD SHA invalid after checkout, rolled back');
      // The 7th call is the rollback: git checkout <full-SHA>
      // execGitCommand passes only (command, execOptions) to the raw exec
      expect(mockExec).toHaveBeenNthCalledWith(
        7,
        `git checkout ${FAKE_SHA}`,
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('should return success when HEAD is valid after checkout even if SHA changed', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1
      mockExecSuccess(FAKE_SHA);          // 2 getHeadSHA before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('Switched to branch'); // 4 checkout
      mockExecSuccess(FAKE_SHA_ALT);      // 5 SHA after (logSHA, changed)
      mockExecSuccess(FAKE_SHA_ALT);      // 6 getHeadSHA after (valid)

      const result = await git.safeCheckout('/repo', 'feature-branch');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Switched to branch');
    });

    it('should return success when HEAD is unchanged (already on branch)', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1
      mockExecSuccess(FAKE_SHA);          // 2 getHeadSHA before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('Already on main'); // 4 checkout
      mockExecSuccess(FAKE_SHA);          // 5 SHA after (logSHA, unchanged)
      mockExecSuccess(FAKE_SHA);          // 6 getHeadSHA after (valid)

      const result = await git.safeCheckout('/repo', 'main');

      expect(result.success).toBe(true);
    });

    it('should return checkout failure result directly when checkout fails', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1 verifyGitAvailable
      mockExecSuccess(FAKE_SHA);          // 2 getHeadSHA before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecFailure('already on branch', { code: 1 }); // 4 checkout fails

      const result = await git.safeCheckout('/repo', 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already on branch');
      // No post-checkout HEAD retrieval, no rollback
      expect(mockExec).toHaveBeenCalledTimes(4);
    });

    it('should track SHA before and after the checkout (logSHA behavior)', async () => {
      mockExecSuccess(FAKE_GIT_VERSION); // 1
      mockExecSuccess(FAKE_SHA);          // 2 getHeadSHA before
      mockExecSuccess(FAKE_SHA);          // 3 SHA before (logSHA)
      mockExecSuccess('Switched');        // 4 checkout
      mockExecSuccess(FAKE_SHA_ALT);      // 5 SHA after (logSHA)
      mockExecSuccess(FAKE_SHA_ALT);      // 6 getHeadSHA after

      await git.safeCheckout('/repo', 'develop');

      // logSHA: true causes 2 extra git rev-parse HEAD calls (SHA before + after)
      // Total 6 calls: availability + getHeadSHA-before + SHA-before + checkout + SHA-after + getHeadSHA-after
      expect(mockExec).toHaveBeenCalledTimes(6);
      // The checkout command itself (4th call)
      // execGitCommand passes only (command, execOptions) to the raw exec
      expect(mockExec).toHaveBeenNthCalledWith(
        4,
        'git checkout develop',
        expect.objectContaining({ cwd: '/repo' }),
      );
    });
  });

  // =========================================================================
  // resetCache
  // =========================================================================
  describe('resetCache', () => {
    it('should clear git availability cache allowing re-check', async () => {
      mockExecSuccess(FAKE_GIT_VERSION);

      // First check caches
      await git.verifyGitAvailable();
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Same instance, cached
      await git.verifyGitAvailable();
      expect(mockExec).toHaveBeenCalledTimes(1);

      // Reset and re-check
      git.resetCache();
      mockExecSuccess(FAKE_GIT_VERSION);

      await git.verifyGitAvailable();
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('should allow switching from cached failure to success', async () => {
      mockExecFailure('not found');
      const failResult = await git.verifyGitAvailable();
      expect(failResult.available).toBe(false);

      git.resetCache();
      mockExecSuccess(FAKE_GIT_VERSION);
      const successResult = await git.verifyGitAvailable();
      expect(successResult.available).toBe(true);
    });

    it('should log cache reset', () => {
      git.resetCache();
      expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('réinitialisé'));
    });
  });

  // =========================================================================
  // Singleton: getGitHelpers / resetGitHelpers
  // =========================================================================
  describe('getGitHelpers / resetGitHelpers', () => {
    it('should return a GitHelpers instance', () => {
      const instance = getGitHelpers();
      expect(instance).toBeInstanceOf(GitHelpers);
    });

    it('should return the same instance on repeated calls', () => {
      const a = getGitHelpers();
      const b = getGitHelpers();
      expect(a).toBe(b);
    });

    it('should return a new instance after resetGitHelpers', () => {
      const first = getGitHelpers();
      resetGitHelpers();
      const second = getGitHelpers();
      expect(first).not.toBe(second);
    });

    it('should produce independent instances after reset', () => {
      const first = getGitHelpers();
      resetGitHelpers();
      const second = getGitHelpers();

      // Fresh instance should have its own independent cache
      expect(second).not.toBe(first);
    });
  });
});
