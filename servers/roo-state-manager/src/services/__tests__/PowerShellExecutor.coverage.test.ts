/**
 * Coverage tests for PowerShellExecutor.ts — cold branches not exercised by
 * PowerShellExecutor.test.ts.
 *
 * Issue #833 — Epic Coverage C3 src/services (dispatch ai-01 c.6, po-2024 Item 3).
 *
 * Gap-data: PowerShellExecutor.ts sat at 22%L / 36%F despite a 30+-test
 * PowerShellExecutor.test.ts. Root cause: that suite mocks `executeScript`
 * *itself* for the timeout/error cases (L355-396 of that file), so the REAL
 * executeScript machinery is never traversed — the timeout fire (L221-233),
 * the isTimedOut resolution branch (L259-268), the error-after-timeout
 * no-reject guard (L285-288), the SIGKILL escalation (L227-231), and the
 * null-exitCode coalescing (L274) all stay cold. Likewise
 * getSystemPowerShellPath's candidate-found branch (L137-140) and its
 * access-error catch (L141-143) are untouched (existing tests only cover the
 * mock + default-fallback paths).
 *
 * Approach: same unmock + mock(fs, child_process) seam as the base suite, but
 * drive the REAL executeScript with a manually-controlled mock ChildProcess
 * and `vi.useFakeTimers()` so the timeout + 5s force-kill escalation fire
 * deterministically (no real process, no real waits). Pure static helpers
 * (parseJsonOutput, getSystemPowerShellPath) get branch-precise inputs.
 *
 * @module services/__tests__/PowerShellExecutor.coverage
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Unmock the global jest.setup.js stub so the REAL class is exercised.
vi.unmock('../PowerShellExecutor.js');

import { PowerShellExecutor } from '../PowerShellExecutor.js';
import fs from 'fs';
import { spawn } from 'child_process';

vi.mock('fs');
vi.mock('child_process', () => ({ spawn: vi.fn() }));

const mockFs = vi.mocked(fs);
const mockSpawn = vi.mocked(spawn);

/**
 * Build a controllable ChildProcess-like object whose event emission the test
 * drives explicitly (used by the fake-timer timeout/force-kill tests where we
 * must NOT auto-emit 'close' on nextTick).
 */
function makeControllableProc(): any {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn();
    return proc;
}

describe('PowerShellExecutor coverage — cold branches (#833 C3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        PowerShellExecutor.setMockPowerShellPath(null); // also resets resolvedPowerShellPath cache
        process.env.ROOSYNC_SHARED_PATH = '/mock/path';
        mockFs.existsSync.mockReturnValue(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.POWERSHELL_PATH;
    });

    // ─────────── getSystemPowerShellPath: candidate-found + access-error catch ───────────

    describe('getSystemPowerShellPath — candidate resolution (L117-149)', () => {
        test('returns a candidate path when it exists on disk (L137-140)', () => {
            process.env.POWERSHELL_PATH = '/custom/pwsh';
            // existsSync true ONLY for the POWERSHELL_PATH candidate (the two
            // hard-coded Program Files candidates must miss so the loop reaches env one).
            mockFs.existsSync.mockImplementation((p: any) => p === '/custom/pwsh');

            const result = PowerShellExecutor.getSystemPowerShellPath();

            expect(result).toBe('/custom/pwsh');
        });

        test('catches a candidate access error and falls back to default (L141-143, L147-148)', () => {
            // existsSync throws for every candidate → each iteration hits the catch,
            // loop exhausts → fallback DEFAULT_POWERSHELL_PATH.
            mockFs.existsSync.mockImplementation(() => {
                throw new Error('EACCES denied');
            });

            const result = PowerShellExecutor.getSystemPowerShellPath();

            expect(result).toBe('pwsh.exe');
        });

        test('serves the cached resolution on subsequent calls without re-checking disk (L122-124)', () => {
            mockFs.existsSync.mockReturnValue(false); // → fallback 'pwsh.exe', cached
            PowerShellExecutor.getSystemPowerShellPath(); // priming call resolves + caches
            const callsAfterPrimer = mockFs.existsSync.mock.calls.length;

            PowerShellExecutor.getSystemPowerShellPath(); // cache hit — early return

            expect(mockFs.existsSync.mock.calls.length).toBe(callsAfterPrimer);
        });
    });

    // ─────────── parseJsonOutput: jsonEnd === -1 branch ───────────

    describe('parseJsonOutput — missing closing brace (L317)', () => {
        test('throws NO_JSON_FOUND when an opening brace exists but no closing brace (jsonEnd === -1)', () => {
            // Distinct from the base suite: 'No JSON here' hits jsonStart === -1,
            // '} {' hits jsonEnd <= jsonStart. This input has '{' but no '}' →
            // the jsonEnd === -1 disjunct.
            const stdout = '{ "key": "value" — no closing brace here';

            expect(() => PowerShellExecutor.parseJsonOutput(stdout)).toThrow('No valid JSON object found');
        });
    });

    // ─────────── constructor: explicit defaultTimeout ───────────

    describe('constructor — defaultTimeout truthy branch (L101)', () => {
        test('accepts an explicit defaultTimeout from config', () => {
            const executor = new PowerShellExecutor({
                roosyncBasePath: '/mock/path',
                defaultTimeout: 60000,
            });
            expect(executor).toBeDefined();
        });
    });

    // ─────────── executeScript: real timeout / error / null-exitCode machinery ───────────

    describe('executeScript — real timeout & error machinery (L221-291)', () => {
        test('fires the timeout, SIGTERMs the process, and resolves a timeout result (L221-233, L259-268)', async () => {
            vi.useFakeTimers();
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1', [], { timeout: 1000 });

            // Advance past the 1000ms timeout → timeout callback runs.
            await vi.advanceTimersByTimeAsync(1000);
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

            // SIGTERM eventually closes the process → close handler sees isTimedOut.
            proc.emit('close', null);
            const result = await promise;

            expect(result.success).toBe(false);
            expect(result.exitCode).toBe(-1);
            expect(result.stderr).toContain('timed out');
        });

        test('escalates to SIGKILL when the process survives SIGTERM for 5s (L227-231)', async () => {
            vi.useFakeTimers();
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc(); // killed stays false (SIGTERM insufficient)
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1', [], { timeout: 1000 });

            await vi.advanceTimersByTimeAsync(1000); // timeout fires → SIGTERM
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

            await vi.advanceTimersByTimeAsync(5000); // force-kill timer fires
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

            proc.emit('close', null);
            await promise;
        });

        test('does not reject when an error event arrives after the timeout (L285-288)', async () => {
            vi.useFakeTimers();
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1', [], { timeout: 1000 });

            await vi.advanceTimersByTimeAsync(1000); // isTimedOut = true
            // Error arrives post-timeout → guard returns early, promise must NOT reject.
            proc.emit('error', new Error('post-timeout ENOENT'));
            proc.emit('close', null);

            const result = await promise;
            expect(result.success).toBe(false); // timeout result, not a rejection
        });

        test('rejects with "PowerShell execution failed" on a proc error event (L280-291)', async () => {
            mockFs.existsSync.mockReturnValue(true);
            // spawn succeeds but the process emits 'error' (distinct from the base
            // suite's spawn-throws case which hits L210-213).
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1');

            process.nextTick(() => proc.emit('error', new Error('boom')));
            await expect(promise).rejects.toThrow('PowerShell execution failed');
        });

        test('coalesces a null exitCode to -1 on a normal (non-timeout) close (L274)', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1');

            process.nextTick(() => proc.emit('close', null)); // null, not 0
            const result = await promise;

            expect(result.exitCode).toBe(-1);
            expect(result.success).toBe(false); // -1 !== 0
        });

        test('collects stdout/stderr and resolves success on a 0-exit close (L236-249, L270-276)', async () => {
            // Happy path is CI-uncovered today (the base suite's success test is
            // CI-excluded at vitest.config.ci.ts:67). Exercising it here keeps the
            // stdout/stderr UTF-8 collection handlers + the success resolve in CI.
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            const executor = new PowerShellExecutor({ roosyncBasePath: '/mock/path' });
            const promise = executor.executeScript('test.ps1');

            process.nextTick(() => {
                proc.stdout.emit('data', Buffer.from('café 🚀', 'utf-8'));
                proc.stderr.emit('data', Buffer.from('warn line', 'utf-8'));
                proc.emit('close', 0);
            });
            const result = await promise;

            expect(result.success).toBe(true);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('café 🚀'); // UTF-8 preserved
            expect(result.stderr).toBe('warn line');
        });
    });

    // ─────────── isPowerShellAvailable / getPowerShellVersion (CI-uncovered) ───────────
    // These static helpers spawn via executeScript('', ...) — covered in the base
    // suite, but that file is CI-excluded (vitest.config.ci.ts:67). With spawn
    // mocked they need no real PowerShell, so exercising them here gives CI
    // real coverage of the success + failure + catch branches.

    describe('isPowerShellAvailable / getPowerShellVersion (L343-383)', () => {
        test('isPowerShellAvailable returns true when the probe prints "test"', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            process.nextTick(() => {
                proc.stdout.emit('data', Buffer.from('test', 'utf-8'));
                proc.emit('close', 0);
            });

            const available = await PowerShellExecutor.isPowerShellAvailable();
            expect(available).toBe(true);
        });

        test('isPowerShellAvailable returns false when the probe output differs', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            process.nextTick(() => {
                proc.stdout.emit('data', Buffer.from('wrong', 'utf-8'));
                proc.emit('close', 0);
            });

            const available = await PowerShellExecutor.isPowerShellAvailable();
            expect(available).toBe(false);
        });

        test('isPowerShellAvailable returns false when executeScript rejects (L355 catch)', async () => {
            mockFs.existsSync.mockReturnValue(false); // script-not-found path → executeScript rejects

            const available = await PowerShellExecutor.isPowerShellAvailable();
            expect(available).toBe(false);
        });

        test('getPowerShellVersion returns the trimmed stdout on success', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            process.nextTick(() => {
                proc.stdout.emit('data', Buffer.from('7.4.0\n', 'utf-8'));
                proc.emit('close', 0);
            });

            const version = await PowerShellExecutor.getPowerShellVersion();
            expect(version).toBe('7.4.0');
        });

        test('getPowerShellVersion returns null on a non-zero exit (L378-379)', async () => {
            mockFs.existsSync.mockReturnValue(true);
            const proc = makeControllableProc();
            mockSpawn.mockReturnValue(proc);

            process.nextTick(() => proc.emit('close', 1));

            const version = await PowerShellExecutor.getPowerShellVersion();
            expect(version).toBeNull();
        });
    });
});
