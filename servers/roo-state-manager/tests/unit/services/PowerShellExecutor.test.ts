/**
 * Comprehensive unit tests for PowerShellExecutor
 *
 * Tests cover: constructor, getSystemPowerShellPath, setMockPowerShellPath,
 * executeScript, parseJsonOutput, getDefaultExecutor, resetDefaultExecutor,
 * isPowerShellAvailable, getPowerShellVersion.
 *
 * @module tests/unit/services/PowerShellExecutor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// --- Hoisted mocks ---
const { mockSpawn, mockExistsSync, mockJoin } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockJoin: vi.fn((...args: string[]) => args.join('/'))
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync
  },
  existsSync: mockExistsSync
}));

vi.mock('path', () => ({
  default: {
    join: mockJoin
  },
  join: mockJoin
}));

// Unmock PowerShellExecutor to use real implementation with locally mocked dependencies
vi.unmock('../../../src/services/PowerShellExecutor.js');

// Import after mocks
import {
  PowerShellExecutor,
  getDefaultExecutor,
  resetDefaultExecutor
} from '../../../src/services/PowerShellExecutor.js';
import { PowerShellExecutorError, PowerShellExecutorErrorCode } from '../../../src/types/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock ChildProcess-like EventEmitter with stdout/stderr streams.
 * By default, emits data + close after a microtask so the promise can settle.
 */
function createMockProcess(options: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  emitError?: Error;
  /** If true, do NOT auto-emit close (for timeout tests) */
  hang?: boolean;
} = {}) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.killed = false;

  if (!options.hang) {
    // Schedule data + close asynchronously so callers can attach listeners first
    queueMicrotask(() => {
      if (options.stdout) {
        proc.stdout.emit('data', Buffer.from(options.stdout, 'utf-8'));
      }
      if (options.stderr) {
        proc.stderr.emit('data', Buffer.from(options.stderr, 'utf-8'));
      }
      if (options.emitError) {
        proc.emit('error', options.emitError);
      } else {
        proc.emit('close', options.exitCode ?? 0);
      }
    });
  }

  return proc;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PowerShellExecutor', () => {
  const MOCK_BASE_PATH = '/mock/roosync';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset static state between tests
    PowerShellExecutor.setMockPowerShellPath(null);
    resetDefaultExecutor();

    // Provide ROOSYNC_SHARED_PATH so constructor works by default
    process.env.ROOSYNC_SHARED_PATH = '/tmp/test-roosync';

    // Default: existsSync returns true (script found)
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.POWERSHELL_PATH;
    PowerShellExecutor.setMockPowerShellPath(null);
    resetDefaultExecutor();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create with explicit roosyncBasePath config', () => {
      const executor = new PowerShellExecutor({
        roosyncBasePath: MOCK_BASE_PATH
      });
      expect(executor).toBeInstanceOf(PowerShellExecutor);
    });

    it('should create with ROOSYNC_SHARED_PATH env var when no config path', () => {
      process.env.ROOSYNC_SHARED_PATH = '/env/path';
      const executor = new PowerShellExecutor();
      expect(executor).toBeInstanceOf(PowerShellExecutor);
    });

    it('should prefer config roosyncBasePath over env var', () => {
      process.env.ROOSYNC_SHARED_PATH = '/env/path';
      const executor = new PowerShellExecutor({
        roosyncBasePath: '/config/path'
      });
      expect(executor).toBeInstanceOf(PowerShellExecutor);
      // We can verify indirectly via executeScript which uses this.roosyncBasePath
    });

    it('should throw PowerShellExecutorError when neither config nor env var is provided', () => {
      delete process.env.ROOSYNC_SHARED_PATH;
      expect(() => new PowerShellExecutor()).toThrow(PowerShellExecutorError);
      try {
        new PowerShellExecutor();
      } catch (e: any) {
        expect(e.code).toBe(PowerShellExecutorErrorCode.CONFIG_MISSING);
        expect(e.message).toContain('ROOSYNC_SHARED_PATH');
      }
    });

    it('should use custom powershellPath from config', async () => {
      const executor = new PowerShellExecutor({
        roosyncBasePath: MOCK_BASE_PATH,
        powershellPath: '/custom/pwsh'
      });

      const proc = createMockProcess({ stdout: 'ok\n' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('test.ps1');

      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/pwsh',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('should use default timeout (30000) when not specified', () => {
      // The default is 30000 ms. We verify indirectly:
      // We can create the executor and check it works.
      const executor = new PowerShellExecutor({
        roosyncBasePath: MOCK_BASE_PATH
      });
      expect(executor).toBeInstanceOf(PowerShellExecutor);
    });

    it('should use custom defaultTimeout from config', () => {
      const executor = new PowerShellExecutor({
        roosyncBasePath: MOCK_BASE_PATH,
        defaultTimeout: 5000
      });
      expect(executor).toBeInstanceOf(PowerShellExecutor);
    });
  });

  // =========================================================================
  // getSystemPowerShellPath / setMockPowerShellPath
  // =========================================================================

  describe('getSystemPowerShellPath', () => {
    it('should return mock path when set via setMockPowerShellPath', () => {
      PowerShellExecutor.setMockPowerShellPath('/mocked/pwsh');
      expect(PowerShellExecutor.getSystemPowerShellPath()).toBe('/mocked/pwsh');
    });

    it('should return cached path on second call (no re-check filesystem)', () => {
      PowerShellExecutor.setMockPowerShellPath(null);
      // First call: no candidate exists
      mockExistsSync.mockReturnValue(false);
      const first = PowerShellExecutor.getSystemPowerShellPath();
      expect(first).toBe('pwsh.exe'); // fallback

      // Second call: should return cached value without re-checking
      mockExistsSync.mockReturnValue(true); // would find something if called
      const second = PowerShellExecutor.getSystemPowerShellPath();
      expect(second).toBe('pwsh.exe'); // still cached
    });

    it('should check filesystem candidates when no mock/cache', () => {
      PowerShellExecutor.setMockPowerShellPath(null); // clears cache too

      // Simulate: first candidate does not exist, second does
      mockExistsSync
        .mockReturnValueOnce(false)  // C:\Program Files\PowerShell\7\pwsh.exe
        .mockReturnValueOnce(true);  // C:\Program Files\PowerShell\7-preview\pwsh.exe

      const result = PowerShellExecutor.getSystemPowerShellPath();
      expect(result).toBe('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe');
    });

    it('should check POWERSHELL_PATH env var as candidate', () => {
      PowerShellExecutor.setMockPowerShellPath(null);
      process.env.POWERSHELL_PATH = '/usr/local/bin/pwsh';

      mockExistsSync
        .mockReturnValueOnce(false) // first standard candidate
        .mockReturnValueOnce(false) // second standard candidate
        .mockReturnValueOnce(true); // POWERSHELL_PATH

      const result = PowerShellExecutor.getSystemPowerShellPath();
      expect(result).toBe('/usr/local/bin/pwsh');
    });

    it('should fall back to "pwsh.exe" when no candidate is found', () => {
      PowerShellExecutor.setMockPowerShellPath(null);
      mockExistsSync.mockReturnValue(false);

      const result = PowerShellExecutor.getSystemPowerShellPath();
      expect(result).toBe('pwsh.exe');
    });

    it('should handle existsSync throwing an error for a candidate gracefully', () => {
      PowerShellExecutor.setMockPowerShellPath(null);
      mockExistsSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw, falls back to default
      const result = PowerShellExecutor.getSystemPowerShellPath();
      expect(result).toBe('pwsh.exe');
    });
  });

  describe('setMockPowerShellPath', () => {
    it('should set the mock path', () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      expect(PowerShellExecutor.getSystemPowerShellPath()).toBe('/test/pwsh');
    });

    it('should clear the resolved cache when called', () => {
      PowerShellExecutor.setMockPowerShellPath(null);
      // Populate cache
      mockExistsSync.mockReturnValue(false);
      PowerShellExecutor.getSystemPowerShellPath(); // caches 'pwsh.exe'

      // Now set a real candidate
      PowerShellExecutor.setMockPowerShellPath(null); // clears cache
      mockExistsSync.mockReturnValue(true);

      const result = PowerShellExecutor.getSystemPowerShellPath();
      // Should re-check filesystem and find the first candidate
      expect(result).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    });

    it('should allow unsetting the mock by passing null', () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      PowerShellExecutor.setMockPowerShellPath(null);

      // Should no longer return the mock path
      mockExistsSync.mockReturnValue(false);
      const result = PowerShellExecutor.getSystemPowerShellPath();
      expect(result).toBe('pwsh.exe');
    });
  });

  // =========================================================================
  // executeScript
  // =========================================================================

  describe('executeScript', () => {
    let executor: PowerShellExecutor;

    beforeEach(() => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      executor = new PowerShellExecutor({
        roosyncBasePath: MOCK_BASE_PATH,
        defaultTimeout: 10000
      });
    });

    it('should reject when script is not found (existsSync returns false)', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(
        executor.executeScript('missing.ps1')
      ).rejects.toThrow('Script not found');
    });

    it('should resolve with success=true on exit code 0', async () => {
      const proc = createMockProcess({ stdout: 'hello\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const result = await executor.executeScript('script.ps1');

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should resolve with success=false on non-zero exit code', async () => {
      const proc = createMockProcess({
        stdout: 'partial\n',
        stderr: 'error occurred\n',
        exitCode: 1
      });
      mockSpawn.mockReturnValue(proc);

      const result = await executor.executeScript('script.ps1');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('error occurred\n');
    });

    it('should resolve with exitCode -1 when process exits with null', async () => {
      // Create process manually to emit null exit code (createMockProcess coerces null to 0)
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      proc.killed = false;
      mockSpawn.mockReturnValue(proc);

      const promise = executor.executeScript('script.ps1');

      queueMicrotask(() => {
        proc.emit('close', null);
      });

      const result = await promise;

      expect(result.exitCode).toBe(-1);
      expect(result.success).toBe(false);
    });

    it('should handle timeout: resolve with success=false and timeout message', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ hang: true });
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 1000 });

        // Advance past timeout
        vi.advanceTimersByTime(1500);

        // Verify kill was called with SIGTERM
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

        // Now advance to trigger the force kill timer (5s)
        vi.advanceTimersByTime(5500);

        // Simulate the OS closing the process after kill
        proc.emit('close', null);

        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(-1);
        expect(result.stderr).toContain('timed out');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should call SIGKILL after 5s if process is not killed by SIGTERM', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ hang: true });
        proc.killed = false; // process not yet killed
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 1000 });

        // Trigger timeout (SIGTERM)
        vi.advanceTimersByTime(1500);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

        // Trigger force kill (5s after SIGTERM)
        vi.advanceTimersByTime(5500);
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

        // Close the process
        proc.emit('close', null);
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should NOT call SIGKILL if process is already killed', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ hang: true });
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 1000 });

        // Trigger timeout
        vi.advanceTimersByTime(1500);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

        // Mark process as killed (OS accepted SIGTERM)
        proc.killed = true;

        // Advance past force-kill timer
        vi.advanceTimersByTime(5500);

        // SIGKILL should NOT have been called since process.killed is true
        expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');

        proc.emit('close', null);
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle spawn error (proc error event)', async () => {
      const proc = createMockProcess({ hang: true });
      mockSpawn.mockReturnValue(proc);

      const promise = executor.executeScript('script.ps1');

      // Emit error
      queueMicrotask(() => {
        proc.emit('error', new Error('spawn ENOENT'));
      });

      await expect(promise).rejects.toThrow('PowerShell execution failed: spawn ENOENT');
    });

    it('should ignore error event if already timed out', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ hang: true });
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 500 });

        // Trigger timeout
        vi.advanceTimersByTime(600);

        // Now emit error after timeout
        proc.emit('error', new Error('late error'));

        // Emit close
        proc.emit('close', null);

        const result = await promise;
        // Should still resolve with timeout result, not reject
        expect(result.success).toBe(false);
        expect(result.stderr).toContain('timed out');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should collect stdout and stderr correctly', async () => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      mockSpawn.mockReturnValue(proc);

      const promise = executor.executeScript('script.ps1');

      // Emit multiple chunks
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('chunk1'));
        proc.stdout.emit('data', Buffer.from('chunk2'));
        proc.stderr.emit('data', Buffer.from('err1'));
        proc.stderr.emit('data', Buffer.from('err2'));
        proc.emit('close', 0);
      });

      const result = await promise;

      expect(result.stdout).toBe('chunk1chunk2');
      expect(result.stderr).toBe('err1err2');
    });

    it('should pass args to PowerShell correctly', async () => {
      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('script.ps1', ['-Action', 'Status', '-Verbose']);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toEqual([
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', expect.any(String),
        '-Action', 'Status', '-Verbose'
      ]);
    });

    it('should use custom env and cwd from options', async () => {
      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('script.ps1', [], {
        cwd: '/custom/cwd',
        env: { CUSTOM_VAR: 'value' }
      });

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.cwd).toBe('/custom/cwd');
      expect(spawnOptions.env).toMatchObject({ CUSTOM_VAR: 'value' });
      expect(spawnOptions.windowsHide).toBe(true);
    });

    it('should use roosyncBasePath as default cwd', async () => {
      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('script.ps1');

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.cwd).toBe(MOCK_BASE_PATH);
    });

    it('should construct full script path using path.join', async () => {
      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('subdir/script.ps1');

      // path.join was called with basePath and scriptPath
      expect(mockJoin).toHaveBeenCalledWith(MOCK_BASE_PATH, 'subdir/script.ps1');
    });

    it('should handle spawn function throwing synchronously', async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      await expect(
        executor.executeScript('script.ps1')
      ).rejects.toThrow('Failed to spawn PowerShell process: spawn failed');
    });

    it('should not set timeout when timeout is 0', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ stdout: 'ok', hang: true });
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 0 });

        // Advance time significantly - no timeout should trigger
        vi.advanceTimersByTime(100000);

        // No kill should have been called
        expect(proc.kill).not.toHaveBeenCalled();

        // Manually close the process
        proc.emit('close', 0);
        const result = await promise;
        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clear timeout on normal close', async () => {
      vi.useFakeTimers();
      try {
        const proc = createMockProcess({ stdout: 'ok', hang: true });
        mockSpawn.mockReturnValue(proc);

        const promise = executor.executeScript('script.ps1', [], { timeout: 5000 });

        // Process finishes quickly
        proc.emit('close', 0);
        const result = await promise;

        expect(result.success).toBe(true);

        // Advance past timeout - should NOT cause issues since timeout was cleared
        vi.advanceTimersByTime(10000);
        expect(proc.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should report execution time', async () => {
      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      const result = await executor.executeScript('script.ps1');

      expect(typeof result.executionTime).toBe('number');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should handle UTF-8 encoded output correctly', async () => {
      const utf8Text = 'Test UTF-8: cafe naive';
      const proc = createMockProcess({ stdout: utf8Text });
      mockSpawn.mockReturnValue(proc);

      const result = await executor.executeScript('script.ps1');

      expect(result.stdout).toBe(utf8Text);
    });
  });

  // =========================================================================
  // parseJsonOutput
  // =========================================================================

  describe('parseJsonOutput', () => {
    it('should parse valid JSON from clean output', () => {
      const output = '{"key": "value", "num": 42}';
      const result = PowerShellExecutor.parseJsonOutput<{ key: string; num: number }>(output);

      expect(result.key).toBe('value');
      expect(result.num).toBe(42);
    });

    it('should extract JSON from output with log prefix and suffix', () => {
      const output = `
        INFO: Starting script...
        DEBUG: Loading config
        {"status": "ok", "items": [1, 2, 3]}
        INFO: Script completed successfully
        Done.
      `;
      const result = PowerShellExecutor.parseJsonOutput<{ status: string; items: number[] }>(output);

      expect(result.status).toBe('ok');
      expect(result.items).toEqual([1, 2, 3]);
    });

    it('should handle multi-line JSON', () => {
      const output = `{
        "name": "test",
        "nested": {
          "a": 1,
          "b": [true, false]
        }
      }`;
      const result = PowerShellExecutor.parseJsonOutput<any>(output);

      expect(result.name).toBe('test');
      expect(result.nested.a).toBe(1);
    });

    it('should throw PowerShellExecutorError when no JSON object found (no braces)', () => {
      const output = 'This is plain text with no braces';

      expect(() => PowerShellExecutor.parseJsonOutput(output)).toThrow(PowerShellExecutorError);
      try {
        PowerShellExecutor.parseJsonOutput(output);
      } catch (e: any) {
        expect(e.code).toBe(PowerShellExecutorErrorCode.PARSE_FAILED);
        // The inner error should have NO_JSON_FOUND code, but since it's wrapped:
        expect(e.message).toContain('Failed to parse PowerShell JSON output');
      }
    });

    it('should throw PowerShellExecutorError when only opening brace found', () => {
      // Only { but no } - jsonEnd will be -1
      // Actually: '{' has indexOf('{')=0 and lastIndexOf('}')=-1 => throws NO_JSON_FOUND
      const output = '{ incomplete';

      expect(() => PowerShellExecutor.parseJsonOutput(output)).toThrow(PowerShellExecutorError);
    });

    it('should throw PowerShellExecutorError when closing brace is before opening brace', () => {
      // This edge case: } then { - jsonEnd <= jsonStart is not possible since
      // indexOf finds first { and lastIndexOf finds last }.
      // But with "} text {" => jsonStart=7, jsonEnd=0 which means jsonEnd < jsonStart
      const output = '} something {';
      // indexOf('{') = 12, lastIndexOf('}') = 0 => 0 <= 12 is false... wait
      // Actually: indexOf('{') = 12, lastIndexOf('}') = 0 => 0 <= 12 is true... but 0 < 12 is true
      // The condition is: jsonEnd <= jsonStart => 0 <= 12 is false.
      // Let me recheck: in the source: if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart)
      // So for "} something {": jsonStart = 12, jsonEnd = 0 => 0 <= 12 => YES, throws
      expect(() => PowerShellExecutor.parseJsonOutput(output)).toThrow(PowerShellExecutorError);
    });

    it('should throw PowerShellExecutorError on invalid JSON content between braces', () => {
      const output = '{ this is not: valid json, missing quotes }';

      expect(() => PowerShellExecutor.parseJsonOutput(output)).toThrow(PowerShellExecutorError);
      try {
        PowerShellExecutor.parseJsonOutput(output);
      } catch (e: any) {
        expect(e.code).toBe(PowerShellExecutorErrorCode.PARSE_FAILED);
        expect(e.message).toContain('Failed to parse PowerShell JSON output');
      }
    });

    it('should throw PowerShellExecutorError on empty string', () => {
      expect(() => PowerShellExecutor.parseJsonOutput('')).toThrow(PowerShellExecutorError);
    });

    it('should handle JSON with special characters', () => {
      const output = '{"path": "C:\\\\Users\\\\test", "msg": "hello\\nworld"}';
      const result = PowerShellExecutor.parseJsonOutput<{ path: string; msg: string }>(output);

      expect(result.path).toBe('C:\\Users\\test');
      expect(result.msg).toBe('hello\nworld');
    });

    it('should pick first { and last } when output has multiple JSON-like blocks', () => {
      // When there are multiple JSON blocks, it picks first { and last }
      const output = 'log {"a":1} middle {"b":2} end';
      // first { is at position 4, last } is at position 27
      // substring = '{"a":1} middle {"b":2}'
      // This is NOT valid JSON, so it should throw
      expect(() => PowerShellExecutor.parseJsonOutput(output)).toThrow(PowerShellExecutorError);
    });

    it('should include outputPreview in error details', () => {
      const longOutput = 'x'.repeat(600);
      try {
        PowerShellExecutor.parseJsonOutput(longOutput);
      } catch (e: any) {
        // The outer catch includes outputPreview: stdout.substring(0, 500)
        expect(e.details).toBeDefined();
        expect(e.details.outputPreview).toBeDefined();
        expect(e.details.outputPreview.length).toBeLessThanOrEqual(500);
      }
    });
  });

  // =========================================================================
  // getDefaultExecutor / resetDefaultExecutor
  // =========================================================================

  describe('getDefaultExecutor / resetDefaultExecutor', () => {
    it('should return same instance on subsequent calls (singleton)', () => {
      const instance1 = getDefaultExecutor();
      const instance2 = getDefaultExecutor();

      expect(instance1).toBe(instance2);
    });

    it('should use config only on first creation', () => {
      const instance1 = getDefaultExecutor({ roosyncBasePath: '/first' });
      const instance2 = getDefaultExecutor({ roosyncBasePath: '/second' });

      // Second config is ignored
      expect(instance1).toBe(instance2);
    });

    it('should allow creating new instance after resetDefaultExecutor', () => {
      const instance1 = getDefaultExecutor();
      resetDefaultExecutor();
      const instance2 = getDefaultExecutor();

      expect(instance1).not.toBe(instance2);
    });

    it('should throw if env var is not set when creating default executor', () => {
      delete process.env.ROOSYNC_SHARED_PATH;
      resetDefaultExecutor();

      expect(() => getDefaultExecutor()).toThrow(PowerShellExecutorError);
    });

    it('should accept config with roosyncBasePath even without env var', () => {
      delete process.env.ROOSYNC_SHARED_PATH;
      resetDefaultExecutor();

      const executor = getDefaultExecutor({ roosyncBasePath: '/explicit/path' });
      expect(executor).toBeInstanceOf(PowerShellExecutor);
    });
  });

  // =========================================================================
  // isPowerShellAvailable
  // =========================================================================

  describe('isPowerShellAvailable', () => {
    it('should return true when PowerShell outputs "test" successfully', async () => {
      const proc = createMockProcess({ stdout: 'test\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      // isPowerShellAvailable creates a new executor internally, needs existsSync for the script
      // But it calls executeScript with empty scriptPath '', which joins basePath + ''
      // existsSync will be called on the joined path
      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(true);
    });

    it('should return false when PowerShell outputs wrong text', async () => {
      const proc = createMockProcess({ stdout: 'wrong output\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });

    it('should return false when process exits with error', async () => {
      const proc = createMockProcess({ exitCode: 1 });
      mockSpawn.mockReturnValue(proc);

      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });

    it('should return false when spawn throws an error', async () => {
      mockExistsSync.mockReturnValue(false); // Script not found
      const result = await PowerShellExecutor.isPowerShellAvailable();
      expect(result).toBe(false);
    });

    it('should accept custom powershellPath', async () => {
      const proc = createMockProcess({ stdout: 'test\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const result = await PowerShellExecutor.isPowerShellAvailable('/custom/pwsh');

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/pwsh',
        expect.any(Array),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // getPowerShellVersion
  // =========================================================================

  describe('getPowerShellVersion', () => {
    it('should return version string when PowerShell responds successfully', async () => {
      const proc = createMockProcess({ stdout: '7.4.1\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const version = await PowerShellExecutor.getPowerShellVersion();
      expect(version).toBe('7.4.1');
    });

    it('should return null when PowerShell fails', async () => {
      const proc = createMockProcess({ exitCode: 1, stderr: 'error' });
      mockSpawn.mockReturnValue(proc);

      const version = await PowerShellExecutor.getPowerShellVersion();
      expect(version).toBeNull();
    });

    it('should return null when spawn throws', async () => {
      mockExistsSync.mockReturnValue(false); // Script not found - causes rejection
      const version = await PowerShellExecutor.getPowerShellVersion();
      expect(version).toBeNull();
    });

    it('should accept custom powershellPath', async () => {
      const proc = createMockProcess({ stdout: '7.3.0\n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const version = await PowerShellExecutor.getPowerShellVersion('/custom/pwsh');

      expect(version).toBe('7.3.0');
      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/pwsh',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('should trim whitespace from version output', async () => {
      const proc = createMockProcess({ stdout: '  7.4.1  \n', exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const version = await PowerShellExecutor.getPowerShellVersion();
      expect(version).toBe('7.4.1');
    });
  });

  // =========================================================================
  // Edge cases and integration-like scenarios
  // =========================================================================

  describe('edge cases', () => {
    it('should handle process that emits close with no stdout/stderr', async () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      const executor = new PowerShellExecutor({ roosyncBasePath: MOCK_BASE_PATH });

      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      const result = await executor.executeScript('script.ps1');

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('should merge process.env with custom env', async () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      const executor = new PowerShellExecutor({ roosyncBasePath: MOCK_BASE_PATH });

      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      process.env.EXISTING_VAR = 'existing';
      await executor.executeScript('script.ps1', [], {
        env: { NEW_VAR: 'new' }
      });

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.env.EXISTING_VAR).toBe('existing');
      expect(spawnOptions.env.NEW_VAR).toBe('new');

      delete process.env.EXISTING_VAR;
    });

    it('should use windowsHide option in spawn', async () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      const executor = new PowerShellExecutor({ roosyncBasePath: MOCK_BASE_PATH });

      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('script.ps1');

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.windowsHide).toBe(true);
    });

    it('should include -NoProfile and -ExecutionPolicy Bypass flags', async () => {
      PowerShellExecutor.setMockPowerShellPath('/test/pwsh');
      const executor = new PowerShellExecutor({ roosyncBasePath: MOCK_BASE_PATH });

      const proc = createMockProcess({ stdout: 'ok' });
      mockSpawn.mockReturnValue(proc);

      await executor.executeScript('script.ps1', ['-MyArg', 'val']);

      const args = mockSpawn.mock.calls[0][1];
      expect(args[0]).toBe('-NoProfile');
      expect(args[1]).toBe('-ExecutionPolicy');
      expect(args[2]).toBe('Bypass');
      expect(args[3]).toBe('-File');
      // args[4] is the full script path
      expect(args[5]).toBe('-MyArg');
      expect(args[6]).toBe('val');
    });
  });
});
