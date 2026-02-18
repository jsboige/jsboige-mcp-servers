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
  };
}