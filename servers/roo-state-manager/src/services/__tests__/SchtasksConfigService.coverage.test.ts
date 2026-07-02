/**
 * #833 Sprint C3 — branch-coverage complement for SchtasksConfigService.
 *
 * Add-only, tests-only. Zero source / existing-test change. The existing
 * `SchtasksConfigService.test.ts` drives the happy paths; this file reaches the
 * residual defensive / fallback arms the suite leaves at 69.2%B:
 *
 *   L175  constructor  `executor ?? new PowerShellExecutor()` — default-construct arm
 *   L231  collect      machineId `ROOSYNC_MACHINE_ID || COMPUTERNAME || 'unknown'` — 1st and 3rd arms
 *   L244  collect      `} catch {}` cleanup swallow (rmSync throws)
 *   L301/302 apply     catch when applySingleTask *throws* (both `instanceof Error` arms)
 *   L325  applySingle  `task.execute || ''` — falsy-execute arm
 *   L328  applySingle  `task.state || 'Ready'` — falsy-state arm
 *   L337  applySingle  `result.stderr || \`Exit code …\`` — empty-stderr arm
 *   L352  applySingle  `parsed.taskName || task.taskName` — missing-parsed-name arm
 *   L367  applySingle  `} catch {}` cleanup swallow (rmSync throws)
 *   L391/392 parse     direct-JSON fallback returns a non-array → `[parsed]` wrap
 *
 * Not covered (skip-with-evidence, not a test gap):
 *   L380/L381 `if (Array.isArray(parsed)) return parsed;` on the *parseJsonOutput*
 *   result — UNREACHABLE. parseJsonOutput (PowerShellExecutor L311-326) extracts the
 *   first `{` … last `}` substring and `JSON.parse`s it, so its result is always an
 *   object, never an array. The array branch of parseTasksOutput is only ever taken
 *   via the direct-JSON fallback (L389-390, already covered). Reaching L381 would
 *   require a source change to parseJsonOutput.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { SchtasksConfigService, type SchtaskConfig } from '../SchtasksConfigService';
import type { PowerShellExecutionResult } from '../PowerShellExecutor';

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function createMockExecutor() {
  return { executeScript: vi.fn<() => Promise<PowerShellExecutionResult>>() } as any;
}

const ok = (stdout: string): PowerShellExecutionResult => ({
  success: true, stdout, stderr: '', exitCode: 0, executionTime: 10,
});

describe('SchtasksConfigService — residual branch coverage (#833 C3)', () => {
  let service: SchtasksConfigService;
  let mockExecutor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = createMockExecutor();
    service = new SchtasksConfigService(mockExecutor);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks(); // undo any fs.rmSync spy
  });

  // ---- L175: default PowerShellExecutor construction ------------------------
  it('constructs a real PowerShellExecutor when none is injected (L175 ?? arm)', () => {
    // No executor arg → the `?? new PowerShellExecutor()` right arm runs.
    // Construction is side-effect-free (no process spawn until executeScript),
    // so we only assert the instance exists — never invoke collect/apply on it.
    const svc = new SchtasksConfigService();
    expect(svc).toBeInstanceOf(SchtasksConfigService);
  });

  // ---- L231: machineId || chain --------------------------------------------
  it('uses ROOSYNC_MACHINE_ID when set (L231 first arm)', async () => {
    vi.stubEnv('ROOSYNC_MACHINE_ID', 'ci-machine-231');
    mockExecutor.executeScript.mockResolvedValue(ok('[]'));

    const result = await service.collect();
    expect(result.machineId).toBe('ci-machine-231');
  });

  it("falls back to 'unknown' when neither ROOSYNC_MACHINE_ID nor COMPUTERNAME is set (L231 last arm)", async () => {
    vi.stubEnv('ROOSYNC_MACHINE_ID', '');
    vi.stubEnv('COMPUTERNAME', '');
    mockExecutor.executeScript.mockResolvedValue(ok('[]'));

    const result = await service.collect();
    expect(result.machineId).toBe('unknown');
  });

  // ---- L391/392: direct-JSON fallback wraps a non-array result --------------
  it('wraps a non-array fallback parse into a single-element array (L391 false → L392)', async () => {
    // A bare primitive: parseJsonOutput finds no `{` → throws NO_JSON_FOUND;
    // the direct JSON.parse fallback yields a number (non-array) → `[parsed]`.
    mockExecutor.executeScript.mockResolvedValue(ok('42'));

    const result = await service.collect();
    expect(result.count).toBe(1);
    expect(result.tasks).toEqual([42 as unknown as SchtaskConfig]);
  });

  // ---- L244 + L367: cleanup catches swallow rmSync failures -----------------
  it('swallows temp-dir cleanup failures in both collect and apply (L244, L367 catches)', async () => {
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: dir locked');
    });

    // collect: finally → rmSync throws → caught (L244), result still returned.
    mockExecutor.executeScript.mockResolvedValueOnce(ok('[]'));
    const collectResult = await service.collect();
    expect(collectResult.count).toBe(0);

    // apply (non-dry): applySingleTask finally → rmSync throws → caught (L367).
    mockExecutor.executeScript.mockResolvedValueOnce(
      ok(JSON.stringify({ action: 'skipped', taskName: 'Claude-Worker' })),
    );
    const applyResult = await service.apply([
      { taskName: 'Claude-Worker', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
    ]);
    expect(applyResult.skipped).toBe(1);

    expect(rmSpy).toHaveBeenCalled();
  });

  // ---- L301/302: apply catches a *thrown* applySingleTask ------------------
  it('records errors when applySingleTask rejects, covering both instanceof-Error arms (L301/302)', async () => {
    // A rejected executeScript propagates out of applySingleTask (no catch there,
    // only try/finally) → caught by apply's per-task catch (L301). One reject is
    // an Error (→ error.message arm), the other a bare string (→ String(error) arm).
    mockExecutor.executeScript
      .mockRejectedValueOnce(new Error('boom-obj'))
      .mockRejectedValueOnce('boom-str');

    const tasks: SchtaskConfig[] = [
      { taskName: 'A', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
      { taskName: 'B', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
    ];

    const result = await service.apply(tasks);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('boom-obj'); // error.message arm
    expect(result.errors[1]).toContain('boom-str'); // String(error) arm
    expect(result.processed).toBe(2);
  });

  // ---- L325 + L328: falsy execute / state default to '' / 'Ready' ----------
  it("defaults empty execute to '' and empty state to 'Ready' in the PS args (L325, L328)", async () => {
    mockExecutor.executeScript.mockResolvedValue(
      ok(JSON.stringify({ action: 'skipped', taskName: 'Z' })),
    );

    // execute '' and state '' are both falsy → the `|| ''` and `|| 'Ready'` right arms.
    const task = {
      taskName: 'Z', taskPath: '\\', execute: '', arguments: 'x',
      state: '' as unknown as SchtaskConfig['state'],
    };
    await service.apply([task]);

    const psArgs: string[] = mockExecutor.executeScript.mock.calls[0][1];
    expect(psArgs[psArgs.indexOf('-Execute') + 1]).toBe('');
    expect(psArgs[psArgs.indexOf('-State') + 1]).toBe('Ready');
  });

  // ---- L337: empty stderr on failure → `Exit code N` details ---------------
  it('reports "Exit code N" as details when a failed run has empty stderr (L337 right arm)', async () => {
    mockExecutor.executeScript.mockResolvedValue({
      success: false, stdout: '', stderr: '', exitCode: 7, executionTime: 5,
    });

    const result = await service.apply([
      { taskName: 'C', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
    ]);
    expect(result.changes[0].action).toBe('error');
    expect(result.changes[0].details).toBe('Exit code 7');
  });

  // ---- L352: parsed result without a taskName falls back to task.taskName ---
  it('falls back to the input taskName when the parsed result omits one (L352 right arm)', async () => {
    // No taskName in the JSON → `parsed.taskName || task.taskName` takes the input.
    mockExecutor.executeScript.mockResolvedValue(ok(JSON.stringify({ action: 'updated' })));

    const result = await service.apply([
      { taskName: 'W', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
    ]);
    expect(result.modified).toBe(1);
    expect(result.changes[0].taskName).toBe('W');
  });
});
