import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchtasksConfigService } from '../SchtasksConfigService';
import { ConfigNormalizationService, type MachineContext } from '../ConfigNormalizationService';
import type { PowerShellExecutionResult } from '../PowerShellExecutor';

// Mock logger (same shape as SchtasksConfigService.test.ts)
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * #2406 P1-c — portabilité des chemins schtasks.
 * Acceptance (audit ai-01 02/10) : « a package collected on D: and applied on
 * a C: checkout produces C: paths, with a test. »
 */
function createMockExecutor() {
  return {
    executeScript: vi.fn<() => Promise<PowerShellExecutionResult>>(),
  } as any;
}

const COLLECT_CONTEXT: MachineContext = {
  os: 'windows',
  homeDir: 'C:\\Users\\alice',
  rooRoot: 'D:\\dev\\roo-extensions',
};

const APPLY_CONTEXT: MachineContext = {
  os: 'windows',
  homeDir: 'C:\\Users\\bob',
  rooRoot: 'C:\\dev\\roo-extensions',
};

function mockOk(stdout: string) {
  return { success: true, stdout, stderr: '', exitCode: 0, executionTime: 50 };
}

describe('#2406 P1-c — schtasks portable paths', () => {
  let mockExecutor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = createMockExecutor();
  });

  it('collect templatizes repo-root and home paths embedded in execute/arguments/workingDirectory', async () => {
    mockExecutor.executeScript.mockResolvedValue(mockOk(JSON.stringify([
      {
        taskName: 'Vibe-Feeder',
        taskPath: '\\',
        execute: 'C:\\Windows\\System32\\wscript.exe',
        arguments: '-File "D:\\dev\\roo-extensions\\scripts\\scheduling\\vibe-feeder.ps1" -Log C:\\Users\\alice\\AppData\\Local\\Temp\\x.log',
        workingDirectory: 'D:\\dev\\roo-extensions\\scripts\\scheduling',
        state: 'Ready',
      },
    ])));

    const service = new SchtasksConfigService(mockExecutor, new ConfigNormalizationService(COLLECT_CONTEXT));
    const result = await service.collect();

    // Le chemin système (hors root/home) reste intact — il est identique sur
    // toutes les machines Windows.
    expect(result.tasks[0].execute).toBe('C:\\Windows\\System32\\wscript.exe');
    // Les chemins du repo root et du home deviennent des placeholders ; le
    // reste de la chaîne (flags, séparateurs) est préservé tel quel.
    expect(result.tasks[0].arguments).toBe('-File "%ROO_ROOT%\\scripts\\scheduling\\vibe-feeder.ps1" -Log %USERPROFILE%\\AppData\\Local\\Temp\\x.log');
    expect(result.tasks[0].workingDirectory).toBe('%ROO_ROOT%\\scripts\\scheduling');
  });

  it('collect is idempotent on placeholders and leaves bare interpreters untouched', async () => {
    mockExecutor.executeScript.mockResolvedValue(mockOk(JSON.stringify([
      {
        taskName: 'Claude-Worker',
        taskPath: '\\',
        execute: 'pwsh.exe',
        arguments: '-File %ROO_ROOT%\\scripts\\claude\\worker.ps1',
        workingDirectory: '',
        state: 'Ready',
      },
    ])));

    const service = new SchtasksConfigService(mockExecutor, new ConfigNormalizationService(COLLECT_CONTEXT));
    const result = await service.collect();

    expect(result.tasks[0].execute).toBe('pwsh.exe');
    expect(result.tasks[0].arguments).toBe('-File %ROO_ROOT%\\scripts\\claude\\worker.ps1');
  });

  it('ACCEPTANCE: a package collected on D: and applied on a C: checkout produces C: paths', async () => {
    mockExecutor.executeScript.mockResolvedValue(mockOk(
      JSON.stringify({ action: 'skipped', taskName: 'Vibe-Feeder' }),
    ));

    // Package porté par la machine cible : placeholders + contexte LOCAL C:\
    const service = new SchtasksConfigService(mockExecutor, new ConfigNormalizationService(APPLY_CONTEXT));
    await service.apply([
      {
        taskName: 'Vibe-Feeder',
        taskPath: '\\',
        execute: 'C:\\Windows\\System32\\wscript.exe',
        arguments: '-File "%ROO_ROOT%\\scripts\\scheduling\\vibe-feeder.ps1" -MaxParallel 2',
        workingDirectory: '%ROO_ROOT%\\scripts\\scheduling',
        state: 'Ready',
      },
    ]);

    const callArgs = mockExecutor.executeScript.mock.calls[0][1] as string[];
    const argIndex = callArgs.indexOf('-Arguments');
    const wdIndex = callArgs.indexOf('-WorkingDirectory');
    expect(callArgs[argIndex + 1]).toBe('-File "C:\\dev\\roo-extensions\\scripts\\scheduling\\vibe-feeder.ps1" -MaxParallel 2');
    expect(callArgs[wdIndex + 1]).toBe('C:\\dev\\roo-extensions\\scripts\\scheduling');
  });

  it('forward-slash variants collected on a machine match too (separator-insensitive templating)', async () => {
    mockExecutor.executeScript.mockResolvedValue(mockOk(JSON.stringify([
      {
        taskName: 'Roo-Scheduler',
        taskPath: '\\',
        execute: 'pwsh.exe',
        arguments: '-File D:/dev/roo-extensions/scripts/scheduling/sched.ps1',
        workingDirectory: '',
        state: 'Ready',
      },
    ])));

    const service = new SchtasksConfigService(mockExecutor, new ConfigNormalizationService(COLLECT_CONTEXT));
    const result = await service.collect();

    expect(result.tasks[0].arguments).toBe('-File %ROO_ROOT%/scripts/scheduling/sched.ps1');
  });
});
