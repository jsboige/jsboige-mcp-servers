/**
 * RooSettingsService - Read/Write Roo Code settings from state.vscdb
 *
 * Replaces the prototype in __tests__/condensation-settings-collect.prototype.ts
 * with a production-ready service that handles all 80+ sync-safe settings.
 *
 * The Roo Code extension stores its settings in VS Code's global state SQLite database:
 *   %APPDATA%/Code/User/globalStorage/state.vscdb
 *   Key: 'RooVeterinaryInc.roo-cline' (JSON blob, ~5MB)
 *
 * Issue: #509, #547
 */

import { promises as fs } from 'fs';
import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import sqlite3 from 'sqlite3';
import { createLogger, Logger } from '../utils/logger.js';

const VSCDB_KEY = 'RooVeterinaryInc.roo-cline';
const VSCDB_RELATIVE_PATH = join('AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb');

/**
 * Settings that should NEVER be exported/synced (machine-specific or sensitive)
 */
const EXCLUDED_KEYS = new Set([
  'id',                          // Machine-specific UUID
  'taskHistory',                 // Large, machine-specific
  'taskHistoryMigratedToFiles',  // Internal migration flag
  'mcpHubInstanceId',            // Transient
  'clerk-auth-state',            // Auth token
  'lastShownAnnouncementId',     // UI state
  'hasOpenedModeSelector',       // UI state
  'dismissedUpsells',            // UI state
  'organization-settings',       // Account-specific
  'user-settings',               // Account-specific
]);

/**
 * Settings safe to sync across machines.
 * Ported from scripts/roo-settings/roo-settings-manager.py SYNC_SAFE_KEYS
 */
const SYNC_SAFE_KEYS = new Set([
  // Condensation (primary goal of #509)
  'autoCondenseContext',
  'autoCondenseContextPercent',
  'condensingApiConfigId',
  'customCondensingPrompt',
  'customSupportPrompts',
  // Model configuration
  'apiProvider',
  'openAiBaseUrl',
  'openAiModelId',
  'openAiLegacyFormat',
  'openAiCustomModelInfo',
  'openAiHeaders',
  'modelTemperature',
  'currentApiConfigName',
  'listApiConfigMeta',
  'profileThresholds',
  'modeApiConfigs',
  // Behavior settings
  'autoApprovalEnabled',
  'alwaysAllowReadOnly',
  'alwaysAllowReadOnlyOutsideWorkspace',
  'alwaysAllowWrite',
  'alwaysAllowWriteOutsideWorkspace',
  'alwaysAllowBrowser',
  'alwaysApproveResubmit',
  'alwaysAllowMcp',
  'alwaysAllowModeSwitch',
  'alwaysAllowSubtasks',
  'alwaysAllowExecute',
  'alwaysAllowUpdateTodoList',
  'alwaysAllowFollowupQuestions',
  'writeDelayMs',
  'requestDelaySeconds',
  'rateLimitSeconds',
  'allowedCommands',
  'deniedCommands',
  'allowedMaxRequests',
  'allowedMaxCost',
  'consecutiveMistakeLimit',
  'followupAutoApproveTimeoutMs',
  // UI/behavior
  'browserToolEnabled',
  'browserViewportSize',
  'enableCheckpoints',
  'checkpointTimeout',
  'enableMcpServerCreation',
  'enableReasoningEffort',
  'enableSubfolderRules',
  'diffEnabled',
  'language',
  'mode',
  'todoListEnabled',
  'soundEnabled',
  'soundVolume',
  'includeCurrentCost',
  'includeCurrentTime',
  'includeDiagnosticMessages',
  'maxDiagnosticMessages',
  // Terminal
  'terminalOutputCharacterLimit',
  'terminalOutputLineLimit',
  'terminalOutputPreviewSize',
  'terminalCompressProgressBar',
  'terminalPowershellCounter',
  'terminalCommandDelay',
  'terminalShellIntegrationTimeout',
  // Files
  'maxConcurrentFileReads',
  'maxReadFileLine',
  'maxWorkspaceFiles',
  'maxOpenTabsContext',
  'maxGitStatusFiles',
  'maxImageFileSize',
  'maxTotalImageSize',
  'fuzzyMatchThreshold',
  'showRooIgnoredFiles',
  // Custom modes and instructions
  'customInstructions',
  'customModes',
  'customModePrompts',
  // Codebase index
  'codebaseIndexConfig',
  'codebaseIndexModels',
  // MCP
  'mcpEnabled',
  // Telemetry
  'telemetrySetting',
  // Enter behavior
  'enterBehavior',
  // Screenshot
  'screenshotQuality',
  // Experiments
  'experiments',
]);

export type FilterMode = 'safe' | 'full';

export interface RooSettingsExtract {
  metadata: {
    machine: string;
    timestamp: string;
    mode: FilterMode;
    keysCount: number;
    totalKeys: number;
  };
  settings: Record<string, unknown>;
}

export interface InjectOptions {
  keys?: string[];
  dryRun?: boolean;
}

export interface InjectResult {
  applied: number;
  changes: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
  dryRun: boolean;
}

export class RooSettingsService {
  private logger: Logger;

  constructor() {
    this.logger = createLogger('RooSettingsService');
  }

  /**
   * Get the path to state.vscdb
   */
  getStateDbPath(): string {
    return join(homedir(), VSCDB_RELATIVE_PATH);
  }

  /**
   * Check if state.vscdb exists
   */
  isAvailable(): boolean {
    return existsSync(this.getStateDbPath());
  }

  /**
   * Extract settings from state.vscdb
   * @param mode 'safe' = only sync-safe keys (80+), 'full' = all except excluded
   */
  async extractSettings(mode: FilterMode = 'safe'): Promise<RooSettingsExtract> {
    const dbPath = this.getStateDbPath();
    if (!existsSync(dbPath)) {
      throw new Error(`state.vscdb not found at: ${dbPath}`);
    }

    const allSettings = await this.readFromVscdb(dbPath);
    const filtered = this.filterSettings(allSettings, mode);

    return {
      metadata: {
        machine: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        timestamp: new Date().toISOString(),
        mode,
        keysCount: Object.keys(filtered).length,
        totalKeys: Object.keys(allSettings).length,
      },
      settings: filtered,
    };
  }

  /**
   * Inject settings into state.vscdb
   * Only injects sync-safe keys by default (unless specific keys provided)
   */
  async injectSettings(
    newSettings: Record<string, unknown>,
    options: InjectOptions = {}
  ): Promise<InjectResult> {
    const dbPath = this.getStateDbPath();
    if (!existsSync(dbPath)) {
      throw new Error(`state.vscdb not found at: ${dbPath}`);
    }

    // Read current settings
    const current = await this.readFromVscdb(dbPath);

    // Filter to allowed keys
    let toInject: Record<string, unknown>;
    if (options.keys && options.keys.length > 0) {
      const allowedKeys = new Set(options.keys);
      toInject = Object.fromEntries(
        Object.entries(newSettings).filter(([k]) => allowedKeys.has(k))
      );
    } else {
      toInject = Object.fromEntries(
        Object.entries(newSettings).filter(([k]) => SYNC_SAFE_KEYS.has(k))
      );
    }

    // Compute changes
    const changes: InjectResult['changes'] = [];
    for (const [key, newValue] of Object.entries(toInject)) {
      const oldValue = current[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({ key, oldValue, newValue });
      }
    }

    if (changes.length === 0 || options.dryRun) {
      return { applied: 0, changes, dryRun: options.dryRun ?? false };
    }

    // Apply changes
    for (const { key, newValue } of changes) {
      current[key] = newValue;
    }

    await this.writeToVscdb(dbPath, current);

    this.logger.info(`Injected ${changes.length} settings into state.vscdb`);
    return { applied: changes.length, changes, dryRun: false };
  }

  /**
   * Get a single setting value
   */
  async getSetting(key: string): Promise<unknown> {
    const dbPath = this.getStateDbPath();
    const settings = await this.readFromVscdb(dbPath);
    return settings[key];
  }

  /**
   * Filter settings based on mode
   */
  private filterSettings(settings: Record<string, unknown>, mode: FilterMode): Record<string, unknown> {
    if (mode === 'full') {
      return Object.fromEntries(
        Object.entries(settings).filter(([k]) => !EXCLUDED_KEYS.has(k))
      );
    }
    return Object.fromEntries(
      Object.entries(settings).filter(([k]) => SYNC_SAFE_KEYS.has(k))
    );
  }

  /**
   * Read Roo settings from state.vscdb using a temp copy to avoid locking
   */
  private async readFromVscdb(dbPath: string): Promise<Record<string, unknown>> {
    // Copy to temp to avoid locking conflicts with VS Code
    const tmpPath = join(tmpdir(), `state-vscdb-${Date.now()}.db`);

    try {
      copyFileSync(dbPath, tmpPath);

      const db = await this.openDatabase(tmpPath, sqlite3.OPEN_READONLY);
      try {
        const row = await this.dbGet(db, `SELECT value FROM ItemTable WHERE key = ?`, [VSCDB_KEY]);
        if (!row) {
          throw new Error(`Key '${VSCDB_KEY}' not found in state.vscdb`);
        }

        let value = row.value;
        if (value instanceof Buffer) {
          value = value.toString('utf-8');
        }

        return JSON.parse(value as string);
      } finally {
        await this.closeDatabase(db);
      }
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Write Roo settings to state.vscdb with backup
   */
  private async writeToVscdb(dbPath: string, settings: Record<string, unknown>): Promise<void> {
    // Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup_${timestamp}`;
    copyFileSync(dbPath, backupPath);
    this.logger.info(`Backup created: ${backupPath}`);

    const db = await this.openDatabase(dbPath, sqlite3.OPEN_READWRITE);
    try {
      const value = JSON.stringify(settings);
      await this.dbRun(db, `UPDATE ItemTable SET value = ? WHERE key = ?`, [value, VSCDB_KEY]);
      this.logger.info('Settings written to state.vscdb');
    } finally {
      await this.closeDatabase(db);
    }
  }

  private openDatabase(path: string, mode: number): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path, mode, (err) => {
        if (err) reject(new Error(`Cannot open state.vscdb: ${err.message}`));
        else resolve(db);
      });
    });
  }

  private closeDatabase(db: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private dbGet(db: sqlite3.Database, sql: string, params: unknown[]): Promise<{ value: string | Buffer } | undefined> {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err: Error | null, row: { value: string | Buffer } | undefined) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  private dbRun(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      db.run(sql, params, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// Export key sets for testing
export { SYNC_SAFE_KEYS, EXCLUDED_KEYS };
