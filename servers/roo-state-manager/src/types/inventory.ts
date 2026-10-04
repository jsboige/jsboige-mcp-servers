export interface MachineInventory {
  machineId: string;
  timestamp: string;
  config: {
    mcp: any; // MCPSettings type would be better if available
    modes: {
      global: any;
      local: any;
    };
    settings: any; // RooSettings type
    profiles: {
      [key: string]: {
        content: string;
        lastModified: string;
      }
    };
  };
  // CORRECTION Bug #322 : Ajout du champ paths pour ConfigSharingService
  paths?: {
    rooExtensions?: string;
    mcpSettings?: string;
    rooConfig?: string;
    scripts?: string;
  };
}

export interface SystemInfo {
  os: string;
  hostname: string;
  username: string;
  powershellVersion?: string;
  // #391: Enriched fields from Get-MachineInventory.ps1
  architecture?: string;
  uptime?: number;
  processor?: string;
  cpuCores?: number;
  cpuThreads?: number;
  totalMemory?: number;
  availableMemory?: number;
  git?: {
    version: string;
    userName?: string;
    userEmail?: string;
    defaultBranch?: string;
    autocrlf?: string;
  };
  psProfile?: {
    path: string;
    hash: string;
  };
  disks?: Array<{
    drive: string;
    size: number;
    free: number;
  }>;
  gpu?: Array<{
    name: string;
    memory: number;
  }>;
  windowsOS?: {
    caption?: string;
    version?: string;
    buildNumber?: string;
    osArchitecture?: string;
    lastBootUpTime?: string;
  };
  powerShell?: {
    version?: string;
    edition?: string;
    platform?: string;
  };
}

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  autoStart: boolean;
  description?: string;
  command?: string;
  transportType?: string;
  alwaysAllow?: string[];
  status?: string;
  error?: string;
}

export interface RooModeInfo {
  slug: string;
  name: string;
  description: string;
  defaultModel: string;
  tools: string[];
  allowedFilePatterns?: string[];
}

export interface ScriptInfo {
  name: string;
  path: string;
  category: string;
}

// #489: Configuration Claude Code globale (~/.claude.json)
export interface ClaudeConfigInfo {
  model?: string;
  env?: Record<string, string>;
  mcpServersCount?: number;
  /** #2307: NOMs des MCP déclarés (triés, jamais les valeurs de config) —
   *  seule visibilité d'une machine sans Roo pour compare_config, dont la
   *  granularité `mcp` ne lit que les sections Roo/Zoo. */
  mcpServers?: string[];
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>;
  migrationsComplete?: string[];
}

// #3975: Résilience au redémarrage (non sensible — aucun nom d'utilisateur, aucun secret).
// Permet au tick d'audit de détecter une machine qui ne survivra pas à son prochain reboot
// (Docker autostart, tâches planifiées, autologon, politique Windows Update).
export interface BootResilienceScheduledTaskInfo {
  name: string;
  state: string;              // Ready / Running / Disabled...
  lastRunTime?: string | null; // ISO 8601, null = jamais exécutée (LastRun 1999)
  lastTaskResult?: number | null; // 0 = succès, 267011 (0x41303) = jamais exécutée
}

export interface BootResilienceInfo {
  collectedAt: string; // ISO 8601 — fraîcheur du bloc lui-même
  dockerService?: {
    name: string;      // 'com.docker.service'
    status: string;    // runtime: Running / Stopped...
    startType: string; // config: Auto / Manual / Disabled
  };
  scheduledTasks?: BootResilienceScheduledTaskInfo[]; // tâches liées à Docker
  dockerDesktopAutoStart?: {
    enabled: boolean;  // HKCU Run key 'Docker Desktop' (start when you sign in)
  };
  autoLogon?: {
    enabled: boolean;  // AutoAdminLogon=1 — flag seul, jamais le username (non-nominatif)
  };
  windowsUpdate?: {
    policyKeyPresent: boolean;        // clé Policies\WindowsUpdate\AU existe
    noAutoRebootWithLoggedOnUsers?: number | null; // 1 = pas de reboot auto avec session ouverte
  };
}

export interface InventoryData {
  mcpServers: McpServerInfo[];
  slashCommands: any[];
  terminalCommands: {
    allowed: any[];
    restricted: any[];
  };
  rooModes: RooModeInfo[];
  sdddSpecs: any[];
  scripts: {
    categories: { [key: string]: ScriptInfo[] };
    all: ScriptInfo[];
  };
  tools: any;
  systemInfo: SystemInfo;
  claudeConfig?: ClaudeConfigInfo; // #489: Ajout configuration Claude Code globale
  bootResilience?: BootResilienceInfo; // #3975
}

export interface FullInventory {
  machineId: string;
  timestamp: string;
  inventory: InventoryData;
  paths: {
    rooExtensions: string;
    mcpSettings: string;
    rooConfig: string;
    scripts: string;
    claudeJson?: string; // #489: Ajout chemin ~/.claude.json
    // #601: Claude Code scopes - project and settings
    projectMcpJson?: string; // Project scope (.mcp.json)
    claudeSettings?: string; // Settings scope (~/.claude/settings.json)
  };
}