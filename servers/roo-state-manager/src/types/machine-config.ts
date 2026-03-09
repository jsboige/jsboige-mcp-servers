/**
 * MachineConfig - Unified machine configuration schema
 *
 * Single interface representing the complete configuration of a machine
 * in the RooSync multi-agent system. Unifies InventoryData, SystemInfo,
 * and config-sharing targets into one coherent type.
 *
 * @see FullInventory - Runtime inventory (what InventoryService collects)
 * @see ConfigSharingService - Config sync pipeline (collect/publish/apply)
 *
 * Issue: #603 - RooSync Config Management remise à plat (Phase B3)
 */

import { SystemInfo, McpServerInfo, RooModeInfo, ClaudeConfigInfo } from './inventory';

// ============================================================
// Section 1: System & Hardware
// ============================================================

/** Reexport SystemInfo for convenience */
export type { SystemInfo } from './inventory';

// ============================================================
// Section 2: Roo Code Configuration
// ============================================================

export interface RooConfig {
  /** MCP servers configured in mcp_settings.json (global Roo) */
  mcpServers: McpServerInfo[];

  /** Modes from custom_modes.yaml (global) or .roomodes (project) */
  modes: {
    /** Global modes from custom_modes.yaml */
    global: RooModeInfo[];
    /** Project-level overrides from .roomodes */
    local?: RooModeInfo[];
  };

  /** Roo settings from state.vscdb */
  settings?: {
    autoCondenseThreshold?: number;
    defaultModel?: string;
    customInstructions?: string;
    [key: string]: unknown;
  };

  /** Scheduler configuration from .roo/schedules.json */
  scheduler?: {
    enabled: boolean;
    intervalMinutes?: number;
    startMinute?: number;
    mode?: string;
    lastRun?: string;
  };

  /** Rules files from .roo/rules/ */
  rules?: Array<{
    name: string;
    path: string;
    hash?: string;
  }>;
}

// ============================================================
// Section 3: Claude Code Configuration
// ============================================================

export interface ClaudeCodeConfig {
  /** Summary from ~/.claude.json (user scope) */
  userConfig?: ClaudeConfigInfo;

  /** MCP servers configured in ~/.claude.json */
  mcpServers?: Array<{
    name: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }>;

  /** Settings from ~/.claude/settings.json */
  settings?: {
    env?: Record<string, string>;
    permissions?: Record<string, unknown>;
    model?: string;
    [key: string]: unknown;
  };

  /** Project-level config (.mcp.json, project CLAUDE.md) */
  project?: {
    hasMcpJson?: boolean;
    hasClaudeMd?: boolean;
    mcpServersCount?: number;
  };

  /** Scheduled tasks (schtasks) */
  scheduledTasks?: Array<{
    name: string;
    status: string;
    nextRun?: string;
    lastRun?: string;
    lastResult?: number;
  }>;
}

// ============================================================
// Section 4: Environment & Infrastructure
// ============================================================

export interface EnvironmentConfig {
  /** Key .env variables (names only, NOT values — no secrets) */
  envVars?: {
    hasEmbeddingConfig?: boolean;
    hasQdrantConfig?: boolean;
    hasRooSyncConfig?: boolean;
    roosyncSharedPath?: string;
    [key: string]: unknown;
  };

  /** VS Code configuration */
  vscode?: {
    version?: string;
    extensions?: Array<{
      id: string;
      version: string;
      enabled: boolean;
    }>;
    uptime?: number;
  };

  /** Docker services (if applicable) */
  docker?: Array<{
    name: string;
    status: string;
    port?: number;
  }>;

  /** GPU fleet info */
  gpus?: Array<{
    name: string;
    memoryMB: number;
    index?: number;
  }>;
}

// ============================================================
// Section 5: RooSync State
// ============================================================

export interface RooSyncState {
  /** Machine role in the RooSync system */
  role: 'coordinator' | 'executor';

  /** Heartbeat status */
  heartbeat?: {
    registered: boolean;
    lastHeartbeat?: string;
    status?: 'online' | 'offline' | 'warning';
    missedHeartbeats?: number;
  };

  /** Messaging stats */
  messaging?: {
    totalSent?: number;
    totalReceived?: number;
    unreadCount?: number;
    lastMessageDate?: string;
  };

  /** Shared state path (GDrive) */
  sharedStatePath?: string;
}

// ============================================================
// MachineConfig: The unified type
// ============================================================

/**
 * Complete machine configuration.
 *
 * This is the target schema for `roosync_config(action: "collect", targets: ["all"])`.
 * Each section maps to a roosync_config target:
 *
 * | Section      | roosync_config target | Source                           |
 * |-------------|----------------------|----------------------------------|
 * | system      | (inventory)          | InventoryService.systemInfo      |
 * | roo         | modes, mcp, settings | mcp_settings.json, custom_modes  |
 * | claude      | claude-config        | ~/.claude.json, settings.json    |
 * | environment | (inventory)          | .env, VS Code, Docker            |
 * | roosync     | (status)             | heartbeat, messaging             |
 */
export interface MachineConfig {
  /** Machine identifier (hostname, lowercase) */
  machineId: string;

  /** Collection timestamp */
  timestamp: string;

  /** Schema version for forward compatibility */
  schemaVersion: '1.0.0';

  /** System & hardware info */
  system: SystemInfo;

  /** Roo Code configuration */
  roo: RooConfig;

  /** Claude Code configuration */
  claude: ClaudeCodeConfig;

  /** Environment & infrastructure */
  environment: EnvironmentConfig;

  /** RooSync coordination state */
  roosync: RooSyncState;

  /** File paths for config sources */
  paths: {
    rooExtensions: string;
    mcpSettings: string;
    claudeJson?: string;
    claudeSettings?: string;
    customModesYaml?: string;
    projectMcpJson?: string;
    envFile?: string;
  };
}

// ============================================================
// Utility types
// ============================================================

/** Partial config for incremental updates */
export type PartialMachineConfig = Partial<Omit<MachineConfig, 'machineId' | 'timestamp' | 'schemaVersion'>> & {
  machineId: string;
  timestamp: string;
  schemaVersion: '1.0.0';
};

/** Config diff between two machines */
export interface MachineConfigDiff {
  source: string;
  target: string;
  timestamp: string;
  sections: {
    section: keyof Omit<MachineConfig, 'machineId' | 'timestamp' | 'schemaVersion' | 'paths'>;
    diffs: Array<{
      path: string;
      severity: 'critical' | 'warning' | 'info';
      sourceValue?: unknown;
      targetValue?: unknown;
      description: string;
    }>;
  }[];
  summary: {
    totalDiffs: number;
    critical: number;
    warning: number;
    info: number;
  };
}
