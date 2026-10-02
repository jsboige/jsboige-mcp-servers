/**
 * #2406 P1-a — real APPLY_SCRIPT, zero mocks, against an ABSENT fixture task.
 *
 * ai-01's acceptance: "Tests run the real script against a fixture task, or at
 * least without mocking the missing/created branch." This file takes the first
 * option for the missing branch: the real PowerShellExecutor spawns the real
 * APPLY_SCRIPT, whose Get-ScheduledTask finds nothing, and the service must
 * surface that as `missing` + `success:false` — the "no false success" contract.
 *
 * Read-only by construction: nothing is registered, the script's missing branch
 * exits before any Set-/Enable-/Disable-ScheduledTask call.
 *
 * `Get-ScheduledTask` exists on Windows only, and the CI vitest matrix runs on
 * ubuntu-latest — hence skipIf. On Windows dev machines (the fleet) it runs for
 * real; on CI it appears as skipped, and the classification contract itself is
 * covered unmocked-adjacent by SchtasksConfigService.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { SchtasksConfigService, type SchtaskConfig } from '../SchtasksConfigService';

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The global setup file (tests/setup/jest.setup.js) registers a PowerShellExecutor
// mock for EVERY test file — and `mockReset: true` in vitest.config.ts wipes its
// mockImplementation before each test, so `new PowerShellExecutor()` would yield a
// bare object without executeScript. This file exists to exercise the REAL
// executor; vi.unmock is hoisted like vi.mock and cancels the global registration
// for this module graph, so the service's internal `new PowerShellExecutor()`
// resolves to the real class.
vi.unmock('../PowerShellExecutor.js');

// Deliberately absurd name: matches the Claude-* fleet family yet cannot exist
// on any machine. No wildcard metacharacters — Get-ScheduledTask -TaskName
// treats the argument as a wildcard pattern.
const ABSENT_FIXTURE = 'Claude-P1a-Absent-Fixture-DeadBeef';

const fixtureTask: SchtaskConfig = {
  taskName: ABSENT_FIXTURE,
  taskPath: '\\',
  execute: 'wscript.exe',
  arguments: '//B //Nologo fixture.vbs',
  workingDirectory: 'D:\\dev',
  state: 'Ready',
};

describe.skipIf(process.platform !== 'win32')('SchtasksConfigService — real APPLY_SCRIPT (#2406 P1-a)', () => {
  it(
    'apply() on an absent task runs the real script and reports missing + failure',
    async () => {
      const service = new SchtasksConfigService(); // real PowerShellExecutor, no mock

      const result = await service.apply([fixtureTask]);

      expect(result.missing, `full result: ${JSON.stringify(result)}`).toEqual([ABSENT_FIXTURE]);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(0); // missing ≠ executor error
      expect(result.modified).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.processed).toBe(1);
      expect(result.changes[0].action).toBe('missing');
    },
    60_000,
  );

  it(
    'dry-run on the same absent task reads the machine and reports the same missing (no mutation)',
    async () => {
      const service = new SchtasksConfigService();

      const result = await service.apply([fixtureTask], true);

      expect(result.dryRun).toBe(true);
      expect(result.missing).toEqual([ABSENT_FIXTURE]);
      expect(result.success).toBe(false);
    },
    60_000,
  );
});
