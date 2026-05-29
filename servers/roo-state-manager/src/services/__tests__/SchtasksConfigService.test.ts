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
  });
});
