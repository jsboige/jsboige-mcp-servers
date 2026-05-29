/**
 * SchtasksConfigService - Collect and apply Windows Scheduled Tasks declaratively
 *
 * Issue #2408 - Target schtasks pour roosync_config (VibeSync Phase 2)
 *
 * Provides collect (inventory), apply (idempotent update), and diff capabilities
 * for Windows scheduled tasks matching project patterns (Claude-*, Roo-*, RooSync-*).
 *
 * Reuses PowerShellExecutor for PowerShell execution.
 * @module SchtasksConfigService
 * @version 1.0.0
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { PowerShellExecutor } from './PowerShellExecutor.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Represents a single scheduled task's declarative config
 */
export interface SchtaskConfig {
  /** Task name (e.g. "Claude-Worker") */
  taskName: string;
  /** Task path (e.g. "\" for root) */
  taskPath: string;
  /** Executable path */
  execute: string;
  /** Arguments string */
  arguments: string;
  /** Working directory */
  workingDirectory?: string;
  /** Enabled state */
  state: 'Ready' | 'Disabled' | 'Running' | 'Queued';
  /** Trigger description (human-readable) */
  triggers?: SchtaskTrigger[];
  /** Principal info */
  principal?: {
    userId?: string;
    logonType?: string;
    runLevel?: string;
  };
  /** Description */
  description?: string;
}

/**
 * Simplified trigger representation
 */
export interface SchtaskTrigger {
  /** Trigger type */
  type: 'Time' | 'Calendar' | 'Boot' | 'Logon' | 'Idle' | 'Registration';
  /** Human-readable schedule (e.g. "Every 60 min from 00:30") */
  schedule: string;
  /** Enabled state */
  enabled: boolean;
}

/**
 * Result of collect operation
 */
export interface SchtasksCollectResult {
  /** Machine ID that was collected */
  machineId: string;
  /** Timestamp of collection */
  timestamp: string;
  /** Collected tasks */
  tasks: SchtaskConfig[];
  /** Filter pattern used */
  filterPattern: string;
  /** Task count */
  count: number;
}

/**
 * Result of apply operation
 */
export interface SchtasksApplyResult {
  /** Number of tasks processed */
  processed: number;
  /** Number of tasks modified */
  modified: number;
  /** Number of tasks skipped (already matching) */
  skipped: number;
  /** Number of tasks created (didn't exist) */
  created: number;
  /** Errors encountered */
  errors: string[];
  /** Detailed changes */
  changes: Array<{
    taskName: string;
    action: 'created' | 'updated' | 'skipped';
    details?: string;
  }>;
}

/**
 * PowerShell script to apply a single task configuration
 * Uses Set-ScheduledTask for idempotent updates (preserves triggers and principal)
 */
const APPLY_SCRIPT = `
param(
    [string]$TaskName,
    [string]$Execute,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$State
)
$ErrorActionPreference = 'Stop'

try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    if ($null -eq $existing) {
        # Task doesn't exist — cannot create from scratch (requires full definition)
        @{ action = 'missing'; taskName = $TaskName; error = 'Task not found. Creation from scratch not supported yet.' } | ConvertTo-Json -Compress
        exit 0
    }

    $currentExe = $existing.Actions[0].Execute
    $currentArgs = $existing.Actions[0].Arguments
    $currentWd = $existing.Actions[0].WorkingDirectory

    $needsUpdate = $false
    $changes = @()

    if ($currentExe -ne $Execute) {
        $needsUpdate = $true
        $changes += "execute: '$currentExe' -> '$Execute'"
    }

    if ($Arguments -and $currentArgs -ne $Arguments) {
        $needsUpdate = $true
        $changes += "arguments updated"
    }

    if ($WorkingDirectory -and $currentWd -ne $WorkingDirectory) {
        $needsUpdate = $true
        $changes += "workingDirectory updated"
    }

    if ($needsUpdate) {
        $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $WorkingDirectory
        Set-ScheduledTask -TaskName $TaskName -Action $action
        @{ action = 'updated'; taskName = $TaskName; changes = $changes } | ConvertTo-Json -Compress
    } else {
        # Check state change
        if ($State -eq 'Disabled' -and $existing.State -ne 'Disabled') {
            Disable-ScheduledTask -TaskName $TaskName
            @{ action = 'updated'; taskName = $TaskName; changes = @('state: disabled') } | ConvertTo-Json -Compress
        } elseif ($State -eq 'Ready' -and $existing.State -eq 'Disabled') {
            Enable-ScheduledTask -TaskName $TaskName
            @{ action = 'updated'; taskName = $TaskName; changes = @('state: enabled') } | ConvertTo-Json -Compress
        } else {
            @{ action = 'skipped'; taskName = $TaskName } | ConvertTo-Json -Compress
        }
    }
} catch {
    @{ action = 'error'; taskName = $TaskName; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/**
 * Default filter patterns for project scheduled tasks
 */
const DEFAULT_FILTER_PATTERNS = ['Claude-*', 'Roo-*', 'RooSync-*'];

export class SchtasksConfigService {
  private logger: Logger;
  private executor: PowerShellExecutor;

  constructor(executor?: PowerShellExecutor) {
    this.logger = createLogger('SchtasksConfigService');
    this.executor = executor ?? new PowerShellExecutor();
  }

  /**
   * Collect scheduled tasks matching project patterns
   *
   * @param filterPatterns - Glob patterns for task names (default: Claude-*, Roo-*, RooSync-*)
   * @returns Collected task configurations
   */
  public async collect(filterPatterns?: string[]): Promise<SchtasksCollectResult> {
    const patterns = filterPatterns ?? DEFAULT_FILTER_PATTERNS;
    this.logger.info('Collecting scheduled tasks', { patterns });

    // Write inline script to temp file for PowerShellExecutor
    // Uses native PowerShell -like operator for safe glob matching (no regex injection)
    const scriptContent = `
$ErrorActionPreference = 'Stop'
$filterPatterns = @(${patterns.map(p => `'${p}'`).join(', ')})

$allTasks = Get-ScheduledTask | Where-Object {
    $_.TaskPath -notlike '\\Microsoft\\*' -and
    ($filterPatterns | ForEach-Object { $taskName = $_.TaskName; ($filterPatterns | Where-Object { $taskName -like $_ }).Count -gt 0 })
}

$results = @()
foreach ($task in $allTasks) {
    $action = $task.Actions | Select-Object -First 1
    $taskInfo = [ordered]@{
        taskName = $task.TaskName
        taskPath = $task.TaskPath
        execute = if ($action) { $action.Execute } else { '' }
        arguments = if ($action) { $action.Arguments } else { '' }
        workingDirectory = if ($action) { $action.WorkingDirectory } else { '' }
        state = $task.State.ToString()
        description = $task.Description
    }
    $results += $taskInfo
}

if ($results.Count -eq 0) { Write-Output '[]' } else { $results | ConvertTo-Json -Depth 5 -Compress }
`;

    const tempDir = path.join(os.tmpdir(), `schtasks-collect-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const scriptPath = path.join(tempDir, 'collect-schtasks.ps1');
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    try {
      const result = await this.executor.executeScript(scriptPath, [], { timeout: 30000 });

      if (!result.success) {
        throw new Error(`PowerShell collect failed: ${result.stderr}`);
      }

      const tasks = this.parseTasksOutput(result.stdout);
      const collectResult: SchtasksCollectResult = {
        machineId: process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown',
        timestamp: new Date().toISOString(),
        tasks,
        filterPattern: patterns.join(','),
        count: tasks.length,
      };

      this.logger.info(`Collected ${tasks.length} scheduled tasks`);
      return collectResult;
    } finally {
      // Cleanup temp script
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Apply scheduled task configurations idempotently
   *
   * @param tasks - Task configurations to apply
   * @param dryRun - If true, show what would change without modifying
   * @returns Apply result with changes made
   */
  public async apply(tasks: SchtaskConfig[], dryRun?: boolean): Promise<SchtasksApplyResult> {
    this.logger.info(`Applying ${tasks.length} scheduled task configs`, { dryRun });

    const result: SchtasksApplyResult = {
      processed: 0,
      modified: 0,
      skipped: 0,
      created: 0,
      errors: [],
      changes: [],
    };

    for (const task of tasks) {
      result.processed++;

      if (dryRun) {
        // In dry-run, just report what would happen
        result.changes.push({
          taskName: task.taskName,
          action: 'updated' as const,
          details: `Would set execute=${task.execute}, arguments=${task.arguments?.substring(0, 50)}...`,
        });
        result.modified++;
        continue;
      }

      try {
        const applyResult = await this.applySingleTask(task);
        result.changes.push({
          taskName: applyResult.taskName,
          action: applyResult.action as 'created' | 'updated' | 'skipped',
          details: applyResult.details,
        });

        switch (applyResult.action) {
          case 'updated':
            result.modified++;
            break;
          case 'skipped':
          case 'missing':
            // Task doesn't exist — count as skipped for now (creation not supported)
            result.skipped++;
            break;
        }
      } catch (error) {
        const errMsg = `Error applying ${task.taskName}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errMsg);
        this.logger.error(errMsg);
      }
    }

    this.logger.info(`Apply complete: ${result.modified} modified, ${result.skipped} skipped, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Apply a single task configuration
   */
  private async applySingleTask(task: SchtaskConfig): Promise<{ taskName: string; action: 'updated' | 'skipped' | 'missing' | 'error'; details?: string }> {
    // Write apply script to temp file
    const tempDir = path.join(os.tmpdir(), `schtasks-apply-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const scriptPath = path.join(tempDir, 'apply-schtasks.ps1');
    fs.writeFileSync(scriptPath, APPLY_SCRIPT, 'utf-8');

    try {
      const args = [
        '-TaskName', task.taskName,
        '-Execute', task.execute || '',
        '-Arguments', task.arguments || '',
        '-WorkingDirectory', task.workingDirectory || '',
        '-State', task.state || 'Ready',
      ];

      const result = await this.executor.executeScript(scriptPath, args, { timeout: 15000 });

      if (!result.success) {
        return {
          taskName: task.taskName,
          action: 'error',
          details: result.stderr || `Exit code ${result.exitCode}`,
        };
      }

      try {
        const parsed = PowerShellExecutor.parseJsonOutput<{ action: string; taskName: string; changes?: string[]; error?: string }>(result.stdout);
        // Map action to a known set of values
        const actionMap: Record<string, 'updated' | 'skipped' | 'missing' | 'error'> = {
          updated: 'updated',
          skipped: 'skipped',
          missing: 'missing',
          error: 'error',
        };
        const mappedAction = actionMap[parsed.action] ?? 'updated';
        return {
          taskName: parsed.taskName || task.taskName,
          action: mappedAction,
          details: parsed.changes?.join('; ') || parsed.error,
        };
      } catch {
        // Fallback: parse the raw output
        return {
          taskName: task.taskName,
          action: 'updated',
          details: result.stdout.trim(),
        };
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Parse the JSON output from the collect script
   */
  private parseTasksOutput(stdout: string): SchtaskConfig[] {
    try {
      // Try PowerShellExecutor.parseJsonOutput first (handles non-JSON prefixes)
      const parsed = PowerShellExecutor.parseJsonOutput<SchtaskConfig[] | SchtaskConfig>(stdout);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [parsed];
    } catch {
      // Fallback: direct JSON parse
      try {
        const trimmed = stdout.trim();
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
        return [parsed];
      } catch {
        this.logger.warn('Failed to parse schtasks output, returning empty array', { output: stdout.substring(0, 200) });
        return [];
      }
    }
  }

  /**
   * Get the default filter patterns
   */
  public static getDefaultFilterPatterns(): string[] {
    return [...DEFAULT_FILTER_PATTERNS];
  }
}
