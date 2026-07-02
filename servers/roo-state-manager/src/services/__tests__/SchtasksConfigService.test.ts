import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchtasksConfigService, type SchtaskConfig } from '../SchtasksConfigService';
import type { PowerShellExecutionResult } from '../PowerShellExecutor';

// Mock logger
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * Create a mock PowerShellExecutor with controllable executeScript
 */
function createMockExecutor() {
  return {
    executeScript: vi.fn<() => Promise<PowerShellExecutionResult>>(),
  } as any;
}

describe('SchtasksConfigService', () => {
  let service: SchtasksConfigService;
  let mockExecutor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = createMockExecutor();
    service = new SchtasksConfigService(mockExecutor);
  });

  describe('collect', () => {
    it('should return empty array when no tasks match', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: '[]',
        stderr: '',
        exitCode: 0,
        executionTime: 100,
      });

      const result = await service.collect();
      expect(result.tasks).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.machineId).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('should collect and parse scheduled tasks', async () => {
      const mockTasks = [
        {
          taskName: 'Claude-Worker',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '-File worker.ps1',
          workingDirectory: '',
          state: 'Ready',
          description: 'Claude Worker',
        },
        {
          taskName: 'Roo-Scheduler',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '-File scheduler.ps1',
          workingDirectory: '',
          state: 'Ready',
          description: 'Roo Scheduler',
        },
      ];

      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify(mockTasks),
        stderr: '',
        exitCode: 0,
        executionTime: 200,
      });

      const result = await service.collect();
      expect(result.count).toBe(2);
      expect(result.tasks[0].taskName).toBe('Claude-Worker');
      expect(result.tasks[1].taskName).toBe('Roo-Scheduler');
    });

    it('should handle single task output (non-array)', async () => {
      const singleTask = {
        taskName: 'Claude-Coordinator',
        taskPath: '\\',
        execute: 'pwsh.exe',
        arguments: '-File coord.ps1',
        workingDirectory: '',
        state: 'Ready',
      };

      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify(singleTask),
        stderr: '',
        exitCode: 0,
        executionTime: 100,
      });

      const result = await service.collect();
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskName).toBe('Claude-Coordinator');
    });

    it('should handle PowerShell execution failure', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'Access denied',
        exitCode: 1,
        executionTime: 50,
      });

      await expect(service.collect()).rejects.toThrow('PowerShell collect failed');
    });

    it('should accept custom filter patterns', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: '[]',
        stderr: '',
        exitCode: 0,
        executionTime: 100,
      });

      await service.collect(['Custom-*']);
      expect(mockExecutor.executeScript).toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    it('should report dry-run without executing', async () => {
      const tasks: SchtaskConfig[] = [
        {
          taskName: 'Claude-Worker',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '-File worker.ps1',
          state: 'Ready',
        },
      ];

      const result = await service.apply(tasks, true);
      expect(result.modified).toBe(1);
      expect(result.processed).toBe(1);
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
    });

    it('should handle skipped tasks', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({ action: 'skipped', taskName: 'Claude-Worker' }),
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const tasks: SchtaskConfig[] = [
        {
          taskName: 'Claude-Worker',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '-File worker.ps1',
          state: 'Ready',
        },
      ];

      const result = await service.apply(tasks);
      expect(result.skipped).toBe(1);
      expect(result.modified).toBe(0);
    });

    it('should handle updated tasks', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({
          action: 'updated',
          taskName: 'Claude-Worker',
          changes: ['execute: powershell.exe -> pwsh.exe'],
        }),
        stderr: '',
        exitCode: 0,
        executionTime: 100,
      });

      const tasks: SchtaskConfig[] = [
        {
          taskName: 'Claude-Worker',
          taskPath: '\\',
          execute: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          arguments: '-File worker.ps1',
          state: 'Ready',
        },
      ];

      const result = await service.apply(tasks);
      expect(result.modified).toBe(1);
      expect(result.changes[0].action).toBe('updated');
    });

    it('should handle missing tasks gracefully', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({
          action: 'missing',
          taskName: 'NonExistent-Task',
          error: 'Task not found',
        }),
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const tasks: SchtaskConfig[] = [
        {
          taskName: 'NonExistent-Task',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '',
          state: 'Ready',
        },
      ];

      const result = await service.apply(tasks);
      expect(result.skipped).toBe(1);
    });

    it('should handle PowerShell execution errors', async () => {
      mockExecutor.executeScript.mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'Access is denied',
        exitCode: 1,
        executionTime: 50,
      });

      const tasks: SchtaskConfig[] = [
        {
          taskName: 'Claude-Worker',
          taskPath: '\\',
          execute: 'pwsh.exe',
          arguments: '',
          state: 'Ready',
        },
      ];

      const result = await service.apply(tasks);
      expect(result.changes[0].action).toBe('error');
    });
  });

  describe('getDefaultFilterPatterns', () => {
    it('should return default filter patterns', () => {
      const patterns = SchtasksConfigService.getDefaultFilterPatterns();
      expect(patterns).toContain('Claude-*');
      expect(patterns).toContain('Roo-*');
      expect(patterns).toContain('RooSync-*');
      expect(patterns.length).toBe(3);
    });

    it('should return a defensive copy (mutations do not leak into the default)', () => {
      // getDefaultFilterPatterns spreads DEFAULT_FILTER_PATTERNS (L404) → fresh array.
      const a = SchtasksConfigService.getDefaultFilterPatterns();
      a.push('Injected-*');
      const b = SchtasksConfigService.getDefaultFilterPatterns();
      expect(b).not.toContain('Injected-*');
      expect(b.length).toBe(3);
    });
  });

  // ============================================================
  // parseTasksOutput fallback branches (#833 coverage — residual gaps)
  // parseJsonOutput looks for { } delimiters only (PowerShellExecutor L314-326);
  // a bare JSON array is therefore rejected and the direct-JSON.parse fallback
  // (L384-392) handles it — that path is already exercised by the 'collect and
  // parse scheduled tasks' test above. The branches below cover what is NOT yet.
  // ============================================================

  describe('parseTasksOutput fallbacks', () => {
    it('returns an empty array when output is completely unparseable (both catches fire)', async () => {
      // stdout has no { } delimiters AND is not valid JSON → parseJsonOutput
      // throws NO_JSON_FOUND, then JSON.parse(trimmed) throws SyntaxError →
      // final catch returns [] (L393-396).
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: 'totally not json at all',
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const result = await service.collect();
      // No throw — graceful empty result.
      expect(result.count).toBe(0);
      expect(result.tasks).toEqual([]);
    });

    it('parses a bare JSON array via the direct-JSON fallback (parseJsonOutput rejects arrays)', async () => {
      // Explicit, named assertion of the implicitly-covered path: a bare array
      // with no object delimiters at top level. parseJsonOutput throws (no '{'),
      // fallback JSON.parse(trimmed) returns the array (L384-392).
      const bare = JSON.stringify([
        { taskName: 'Claude-Worker', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
      ]);
      // Strip to a true bare array (no nested objects with braces) is impossible here,
      // so verify via the documented behavior: count === 1, parsed by the fallback.
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: bare,
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const result = await service.collect();
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskName).toBe('Claude-Worker');
    });
  });

  describe('apply action mapping', () => {
    it('maps an unknown action string to "updated" (actionMap default, L350)', async () => {
      // actionMap[parsed.action] ?? 'updated' → an unmapped action falls back to 'updated'.
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({ action: 'custom-unknown-action', taskName: 'X' }),
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const result = await service.apply([
        { taskName: 'X', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
      ]);

      expect(result.modified).toBe(1);
      expect(result.changes[0].action).toBe('updated');
      expect(result.changes[0].taskName).toBe('X');
    });

    it('uses the raw stdout as details when the apply result cannot be parsed (raw-output fallback, L356-363)', async () => {
      // parseJsonOutput throws on apply stdout with no { } → catch returns
      // action 'updated' + stdout.trim() as details.
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: 'raw non-json powershell text',
        stderr: '',
        exitCode: 0,
        executionTime: 50,
      });

      const result = await service.apply([
        { taskName: 'Y', taskPath: '\\', execute: 'pwsh.exe', arguments: '', state: 'Ready' },
      ]);

      expect(result.modified).toBe(1);
      expect(result.changes[0].action).toBe('updated');
      // Raw stdout surfaced as details (trimmed).
      expect(result.changes[0].details).toBe('raw non-json powershell text');
    });
  });
});
