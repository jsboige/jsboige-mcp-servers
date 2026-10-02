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
import { ConfigNormalizationService } from './ConfigNormalizationService.js';
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
  /**
   * #2406 P1-a — names of tasks ABSENT from the machine. Creation from scratch
   * is P1-b (installers); an apply that hits any of these is NOT a success.
   */
  missing: string[];
  /**
   * #2406 P1-a — false when any task is missing or errored. No silent success:
   * the caller (ConfigSharingService → roosync_config) fails loudly on false.
   */
  success: boolean;
  /**
   * #2406 P1-a — true when produced by a dry-run. In that case the counters
   * describe what WOULD happen (modified = would-update, skipped = would-skip),
   * computed against the real machine state.
   */
  dryRun: boolean;
  /** Errors encountered */
  errors: string[];
  /** Detailed changes */
  changes: Array<{
    taskName: string;
    action: 'created' | 'updated' | 'skipped' | 'missing' | 'error';
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
    [string]$State,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    if ($null -eq $existing) {
        # Task doesn't exist — cannot create from scratch (requires full definition).
        # #2406 P1-a: 'missing' is emitted identically in dry-run and real apply —
        # the machine state is READ either way; the caller turns it into a failure.
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

    $stateChange = $null
    if ($State -eq 'Disabled' -and $existing.State -ne 'Disabled') {
        $stateChange = 'state: disabled'
    } elseif ($State -eq 'Ready' -and $existing.State -eq 'Disabled') {
        $stateChange = 'state: enabled'
    }

    # #2406 P1-a — dry-run is a PURE READ: the same comparison runs, the mutations
    # (Set-/Enable-/Disable-ScheduledTask) are skipped, the planned action is emitted.
    if ($DryRun) {
        if ($needsUpdate -or $null -ne $stateChange) {
            $planned = @($changes)
            if ($null -ne $stateChange) { $planned += $stateChange }
            @{ action = 'would-update'; taskName = $TaskName; changes = $planned } | ConvertTo-Json -Compress
        } else {
            @{ action = 'would-skip'; taskName = $TaskName } | ConvertTo-Json -Compress
        }
        exit 0
    }

    if ($needsUpdate) {
        $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $WorkingDirectory
        Set-ScheduledTask -TaskName $TaskName -Action $action
        @{ action = 'updated'; taskName = $TaskName; changes = $changes } | ConvertTo-Json -Compress
    } elseif ($null -ne $stateChange) {
        if ($stateChange -eq 'state: disabled') {
            Disable-ScheduledTask -TaskName $TaskName
        } else {
            Enable-ScheduledTask -TaskName $TaskName
        }
        @{ action = 'updated'; taskName = $TaskName; changes = @($stateChange) } | ConvertTo-Json -Compress
    } else {
        @{ action = 'skipped'; taskName = $TaskName } | ConvertTo-Json -Compress
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
  private normalizer: ConfigNormalizationService;

  constructor(executor?: PowerShellExecutor, normalizer?: ConfigNormalizationService) {
    this.logger = createLogger('SchtasksConfigService');
    this.executor = executor ?? new PowerShellExecutor();
    // #2406 P1-c — portabilité : collect templatise les chemins (→ %ROO_ROOT% /
    // %USERPROFILE%), apply les développe vers les chemins de la machine locale.
    // Injectable pour tester un contexte D:\ → C:\ sans dépendre du poste.
    this.normalizer = normalizer ?? new ConfigNormalizationService();
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
    ($t = $_; $filterPatterns | Where-Object { $t.TaskName -like $_ }).Count -gt 0
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

    // #2406 P1-a — mkdtempSync, pas Date.now() : un horodatage ms n'est pas
    // unique sous concurrence (deux workers de test — ou deux process RSM sur
    // une machine — tombant sur la même ms partagent le dossier, et le rmSync
    // du finally de l'un supprime le script de l'autre en plein spawn :
    // « n'est pas reconnu comme nom d'un fichier de script »).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schtasks-collect-'));
    const scriptPath = path.join(tempDir, 'collect-schtasks.ps1');
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    try {
      const result = await this.executor.executeScript(scriptPath, [], { timeout: 30000 });

      if (!result.success) {
        throw new Error(`PowerShell collect failed: ${result.stderr}`);
      }

      const tasks = this.parseTasksOutput(result.stdout);
      // #2406 P1-c — templatise les chemins pour le partage : un package collecté
      // sur D:\dev\roo-extensions doit s'appliquer sur un checkout C:\ n'importe
      // où. Execute/arguments/workingDirectory portent les chemins absolus de la
      // machine source ; les placeholders sont résolus à l'apply (voir applySingleTask).
      // Entrées non-objets (sentinels de parse) : passthrough intact.
      const portableTasks = tasks.map((t) =>
        t && typeof t === 'object'
          ? {
              ...t,
              execute: this.normalizer.normalizeEmbeddedPaths(t.execute ?? ''),
              arguments: this.normalizer.normalizeEmbeddedPaths(t.arguments ?? ''),
              workingDirectory: this.normalizer.normalizeEmbeddedPaths(t.workingDirectory ?? ''),
            }
          : t
      );
      const collectResult: SchtasksCollectResult = {
        machineId: process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown',
        timestamp: new Date().toISOString(),
        tasks: portableTasks,
        filterPattern: patterns.join(','),
        count: portableTasks.length,
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
      // #2406 P1-a — an apply that hits missing or errored tasks is NOT a
      // success; `missing` names each absent task for the caller's report.
      missing: [],
      success: true,
      dryRun: !!dryRun,
      errors: [],
      changes: [],
    };

    for (const task of tasks) {
      result.processed++;

      try {
        // #2406 P1-a — dry-run goes through the SAME read path as the real apply
        // (APPLY_SCRIPT -DryRun): real machine state, real diff, zero mutation.
        // No more blanket "would set ..." that ignored the machine entirely.
        const applyResult = await this.applySingleTask(task, dryRun);
        result.changes.push({
          taskName: applyResult.taskName,
          action: applyResult.action,
          details: applyResult.details,
        });

        switch (applyResult.action) {
          case 'updated':
            result.modified++;
            break;
          case 'skipped':
            result.skipped++;
            break;
          case 'missing':
            // #2406 P1-a — a missing task is a FAILURE, not a skip: name it,
            // don't bury it in the skipped counter (creation = P1-b installers).
            result.missing.push(applyResult.taskName);
            break;
          case 'error':
            // #2406 P1-a — executor-level errors previously fell through the
            // switch and were silently dropped (processed but never counted).
            result.errors.push(`Error applying ${applyResult.taskName}: ${applyResult.details ?? 'unknown error'}`);
            break;
        }
      } catch (error) {
        const errMsg = `Error applying ${task.taskName}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errMsg);
        this.logger.error(errMsg);
      }
    }

    result.success = result.errors.length === 0 && result.missing.length === 0;
    this.logger.info(
      `Apply complete${dryRun ? ' (dry-run)' : ''}: ${result.modified} modified, ${result.skipped} skipped, ${result.missing.length} missing, ${result.errors.length} errors`,
    );
    return result;
  }

  /**
   * Apply a single task configuration
   *
   * #2406 P1-a — `dryRun` runs the SAME script with -DryRun: the machine state
   * is read and diffed, no Set-/Enable-/Disable-ScheduledTask is ever invoked.
   */
  private async applySingleTask(task: SchtaskConfig, dryRun?: boolean): Promise<{ taskName: string; action: 'updated' | 'skipped' | 'missing' | 'error'; details?: string }> {
    // #2406 P1-c — développe les placeholders vers les chemins LOCAUX avant
    // l'exécution : le package est portable, la commande ne l'est pas.
    const localExecute = this.normalizer.denormalizeEmbeddedPaths(task.execute || '');
    const localArguments = this.normalizer.denormalizeEmbeddedPaths(task.arguments || '');
    const localWorkingDirectory = this.normalizer.denormalizeEmbeddedPaths(task.workingDirectory || '');

    // Write apply script to temp file.
    // #2406 P1-a — mkdtempSync, pas Date.now() : voir collect() — un dossier
    // horodaté à la ms n'est pas unique sous concurrence ; le rmSync du finally
    // d'un voisin de même milliseconde supprime ce script avant le spawn pwsh.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schtasks-apply-'));
    const scriptPath = path.join(tempDir, 'apply-schtasks.ps1');
    fs.writeFileSync(scriptPath, APPLY_SCRIPT, 'utf-8');

    try {
      const args = [
        '-TaskName', task.taskName,
        '-Execute', localExecute,
        '-Arguments', localArguments,
        '-WorkingDirectory', localWorkingDirectory,
        '-State', task.state || 'Ready',
      ];
      if (dryRun) {
        args.push('-DryRun');
      }

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
        // Map action to a known set of values.
        // #2406 P1-a — dry-run emissions ('would-update'/'would-skip') map onto
        // the same counters (modified/skipped); the result carries dryRun=true so
        // consumers read them as WOULD-modify/WOULD-skip.
        const actionMap: Record<string, 'updated' | 'skipped' | 'missing' | 'error'> = {
          updated: 'updated',
          skipped: 'skipped',
          missing: 'missing',
          error: 'error',
          'would-update': 'updated',
          'would-skip': 'skipped',
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
