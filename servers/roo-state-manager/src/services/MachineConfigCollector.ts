/**
 * MachineConfigCollector — builds a `MachineConfig` from the real files of a machine.
 *
 * Issue #4611 (cases 7 + 14 of #603), decision RX139 option (c).
 *
 * The `MachineConfig` type has existed since #603 Phase B3 (`src/types/machine-config.ts`)
 * but nothing produced it: `roosync_config collect` only speaks the file-package
 * vocabulary (`modes`, `mcp`, `profiles`, ...). This collector fills that gap and is
 * wired to `roosync_config(action: "collect", targets: ["all"])`.
 *
 * Design constraints (from #4611):
 *  - **No new MCP tool.** The collector is a service; the tool surface is unchanged.
 *  - **Secrets masked by value, never by name.** We reuse
 *    `redactValue`/`looksLikeSecretValue` from `ClaudeSettingsService` (#3545), which
 *    decide from the VALUE (and, for URLs, the non-reversible digest of the userinfo /
 *    sensitive query params). A key called `ANTHROPIC_API_KEY` holding an innocuous
 *    string is published as-is; a key called `NOTE` holding a token is masked.
 *  - **Pure file reading.** No PowerShell, no schtasks, no network: the host-specific
 *    `system` section is injected by the caller (InventoryService in the tool layer,
 *    a fixture in tests). That is what makes the two-machine usage test (#603 case 14)
 *    possible on synthetic fixtures instead of on two live seats.
 *
 * @see src/types/machine-config.ts
 * @see src/services/ClaudeSettingsService.ts (redactValue, #3545)
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import * as os from 'os';
import { homedir } from 'os';
import * as yaml from 'js-yaml';

import type {
  MachineConfig,
  RooConfig,
  ClaudeCodeConfig,
  EnvironmentConfig,
  RooSyncState,
} from '../types/machine-config.js';
import type { SystemInfo, McpServerInfo, RooModeInfo } from '../types/inventory.js';
import {
  redactValue,
  looksLikeSecretValue,
  redactUrlCredentials,
  redactAssignedSecrets,
} from './ClaudeSettingsService.js';
import { getGlobalStoragePath, getExtensionId } from '../utils/extension-paths.js';

// ============================================================
// Roots — every filesystem anchor is injectable (fixtures, tests)
// ============================================================

export interface MachineConfigRoots {
  /** `~` — home directory holding `.claude.json` and `.claude/settings.json`. */
  homeDir: string;
  /** VS Code `globalStorage/<extensionId>/` — holds `settings/mcp_settings.json`. */
  rooGlobalStorageDir: string;
  /** Workspace root — holds `.roomodes`, `.mcp.json`, `CLAUDE.md`, `.roo/`. */
  projectPath: string;
  /** Repo root of the Roo extensions workspace (`.roo/rules/`). */
  rooExtensionsPath: string;
  /** Shared state path (GDrive) when known. */
  sharedStatePath?: string;
}

export interface CollectMachineConfigOptions {
  /** Machine identifier, lowercase hostname. */
  machineId: string;
  /** Overrides for any root; missing ones fall back to the live machine. */
  roots?: Partial<MachineConfigRoots>;
  /**
   * Host-specific system section. Optional: when omitted it is built locally from
   * Node's `os` module (`collectSystemInfo`), which needs no shell. Callers that
   * already hold a richer inventory can inject it; fixtures supply a literal.
   */
  system?: SystemInfo;
  /** RooSync role of this machine (default: 'executor'). */
  role?: 'coordinator' | 'executor';
}

// ============================================================
// Small helpers
// ============================================================

/** Read a file as UTF-8, or `undefined` when absent/unreadable. Never throws. */
async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read + JSON.parse, or `undefined` when absent/invalid. Never throws. */
async function readJsonFile<T = unknown>(path: string): Promise<T | undefined> {
  const raw = await readTextFile(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse a YAML document, or `undefined` when absent/invalid. Never throws. */
async function readYamlFile<T = unknown>(path: string): Promise<T | undefined> {
  const raw = await readTextFile(path);
  if (raw === undefined) return undefined;
  try {
    return yaml.load(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Redact a value read from a config file.
 *
 * `redactValue` is path-aware (it treats `*BASE_URL*` specially and otherwise decides
 * from the VALUE via `looksLikeSecretValue`). We call it for every leaf we publish, so
 * a secret is masked because of what it *is*, not because of the key it sits under.
 */
function redactLeaf(path: string, value: unknown): unknown {
  if (typeof value === 'string') return redactValue(path, value);
  return value;
}

/**
 * Redact a COMMAND-LIKE string we publish: `command`, `url`, `args[]`, `cwd` — the
 * leaves that are NOT plain env values and therefore bypass `redactRecord`.
 *
 * ms#1706 (reviews po-2023 + ai-01): `redactValue` alone is not enough for these.
 * Its URL-credentials branch is gated on `/BASE_URL$/i.test(path)`, and its
 * `looksLikeSecretValue` is anchored at the START of the string — so a token in the
 * MIDDLE of an arg (`-e API_KEY=sk-…`), an inline assignment in a Roo one-string
 * command (`cmd /c set API_KEY=… && node …`), or the userinfo of an embedded URL
 * (`http://user:pass@host` as the `command` of a url-type server) would all pass
 * through raw. Both helpers below are path-independent and idempotent:
 *  - `redactUrlCredentials` — same markers as `redactValue`'s BASE_URL branch
 *    (`<credentials:sha256=…>` / `<redacted:sha256=…>`, non-reversible digests);
 *  - `redactAssignedSecrets` — masks the VALUE of `<SENSITIVE_NAME>=<value>`
 *    assignments and `Bearer <tok>`, keeping the name readable.
 * Applied to BOTH sections (Claude `command`/`args`/`cwd`, Roo `command`): no leaf
 * is published without passing through a redaction path.
 */
function redactPublishedString(value: string): string {
  return redactAssignedSecrets(redactUrlCredentials(value));
}

/**
 * Redact every string leaf of a record (env blocks, settings objects).
 * Keys are preserved — the caller needs the shape to compare machines.
 */
function redactRecord(record: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactRecord(value as Record<string, unknown>, `${prefix}.${key}`);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item, i) =>
        typeof item === 'string' ? redactLeaf(`${prefix}.${key}.${i}`, item) : item
      );
    } else {
      out[key] = redactLeaf(`${prefix}.${key}`, value);
    }
  }
  return out;
}

/** sha256 of a file content, first 16 hex chars. `undefined` when unreadable. */
async function fileHash(path: string): Promise<string | undefined> {
  const raw = await readTextFile(path);
  if (raw === undefined) return undefined;
  return createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// ============================================================
// Section collectors
// ============================================================

interface RooMcpSettingsFile {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    alwaysAllow?: string[];
    description?: string;
    transportType?: string;
    url?: string;
  }>;
}

/** `roo.mcpServers` from Roo's `mcp_settings.json`. Env values are value-redacted;
 * `command` (often a one-string command, e.g. `cmd /c set KEY=… && node …`) is
 * redacted via `redactPublishedString` (ms#1706, addition ai-01). */
async function collectRooMcpServers(roots: MachineConfigRoots): Promise<McpServerInfo[]> {
  const settingsPath = join(roots.rooGlobalStorageDir, 'settings', 'mcp_settings.json');
  const settings = await readJsonFile<RooMcpSettingsFile>(settingsPath);
  const servers = settings?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers)
    .map(([name, cfg]) => {
      const info: McpServerInfo = {
        name,
        // Roo marks a server `disabled: true`; absence means enabled.
        enabled: cfg?.disabled !== true,
        autoStart: cfg?.disabled !== true,
      };
      if (cfg?.description) info.description = cfg.description;
      // ms#1706: published raw until now — a Roo one-string command can carry an
      // inline `KEY=secret` assignment or an embedded URL userinfo.
      if (cfg?.command) info.command = redactPublishedString(cfg.command);
      const transport = cfg?.transportType ?? (cfg?.url ? 'http' : undefined);
      if (transport) info.transportType = transport;
      if (Array.isArray(cfg?.alwaysAllow)) info.alwaysAllow = cfg.alwaysAllow;
      return info;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface ModesDocument {
  customModes?: Array<{
    slug?: string;
    name?: string;
    description?: string;
    roleDefinition?: string;
    whenToUse?: string;
    groups?: unknown[];
    tools?: unknown[];
    allowedFilePatterns?: string[];
    defaultModel?: string;
  }>;
}

/** Map a `customModes` entry onto the `RooModeInfo` vocabulary. */
function toRooModeInfo(mode: NonNullable<ModesDocument['customModes']>[number]): RooModeInfo {
  const groups = Array.isArray(mode.groups)
    ? mode.groups.map(g => (typeof g === 'string' ? g : JSON.stringify(g)))
    : [];
  const tools = Array.isArray(mode.tools) ? mode.tools.map(t => String(t)) : groups;
  const info: RooModeInfo = {
    slug: mode.slug ?? mode.name ?? 'unknown',
    name: mode.name ?? mode.slug ?? 'unknown',
    description: mode.description ?? mode.whenToUse ?? '',
    defaultModel: mode.defaultModel ?? '',
    tools,
  };
  if (Array.isArray(mode.allowedFilePatterns)) info.allowedFilePatterns = mode.allowedFilePatterns;
  return info;
}

/**
 * `roo.modes` — global modes from `custom_modes.yaml` (extension globalStorage),
 * project overrides from `.roomodes` (workspace root). Both are optional.
 */
async function collectRooModes(roots: MachineConfigRoots): Promise<RooConfig['modes']> {
  const globalDoc = await readYamlFile<ModesDocument>(
    join(roots.rooGlobalStorageDir, 'settings', 'custom_modes.yaml')
  );
  const localDoc = await readJsonFile<ModesDocument>(join(roots.projectPath, '.roomodes'));

  const global = Array.isArray(globalDoc?.customModes)
    ? globalDoc!.customModes!.map(toRooModeInfo)
    : [];
  const modes: RooConfig['modes'] = { global };
  if (Array.isArray(localDoc?.customModes)) {
    modes.local = localDoc!.customModes!.map(toRooModeInfo);
  }
  return modes;
}

/** `roo.scheduler` from `.roo/schedules.json` (first schedule, the canonical one). */
async function collectRooScheduler(roots: MachineConfigRoots): Promise<RooConfig['scheduler']> {
  const doc = await readJsonFile<{
    enabled?: boolean;
    schedules?: Array<{
      enabled?: boolean;
      intervalMinutes?: number;
      startMinute?: number;
      mode?: string;
      lastRun?: string;
    }>;
  }>(join(roots.projectPath, '.roo', 'schedules.json'));
  if (!doc) return undefined;

  const first = Array.isArray(doc.schedules) ? doc.schedules[0] : undefined;
  if (!first) {
    return typeof doc.enabled === 'boolean' ? { enabled: doc.enabled } : undefined;
  }
  const scheduler: NonNullable<RooConfig['scheduler']> = {
    enabled: first.enabled !== false,
  };
  if (typeof first.intervalMinutes === 'number') scheduler.intervalMinutes = first.intervalMinutes;
  if (typeof first.startMinute === 'number') scheduler.startMinute = first.startMinute;
  if (first.mode) scheduler.mode = first.mode;
  if (first.lastRun) scheduler.lastRun = first.lastRun;
  return scheduler;
}

/** `roo.rules` — the `.roo/rules/` markdown files, with a content hash for drift. */
async function collectRooRules(roots: MachineConfigRoots): Promise<NonNullable<RooConfig['rules']>> {
  const dir = join(roots.rooExtensionsPath, '.roo', 'rules');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rules: NonNullable<RooConfig['rules']> = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    const hash = await fileHash(full);
    if (!hash) continue;
    rules.push({ name, path: full, hash });
  }
  return rules;
}

interface ClaudeJsonFile {
  model?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    type?: string;
    url?: string;
  }>;
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>;
}

/**
 * `claude` section: `~/.claude.json`, `~/.claude/settings.json`, and the project
 * artifacts (`.mcp.json`, `CLAUDE.md`).
 *
 * Every published value goes through `redactLeaf` — masking is decided by VALUE.
 * `scheduledTasks` is intentionally left to the dedicated `schtasks` target: this
 * collector never shells out (see file header).
 */
async function collectClaudeSection(roots: MachineConfigRoots): Promise<ClaudeCodeConfig> {
  const claudeJsonPath = join(roots.homeDir, '.claude.json');
  const claudeSettingsPath = join(roots.homeDir, '.claude', 'settings.json');

  const claudeJson = await readJsonFile<ClaudeJsonFile>(claudeJsonPath);
  const claudeSettings = await readJsonFile<Record<string, unknown>>(claudeSettingsPath);

  const section: ClaudeCodeConfig = {};

  if (claudeJson) {
    const serverNames = Object.keys(claudeJson.mcpServers ?? {}).sort();
    section.userConfig = {
      mcpServersCount: serverNames.length,
      mcpServers: serverNames,
    };
    if (claudeJson.model) section.userConfig.model = claudeJson.model;
    if (claudeJson.env) {
      section.userConfig.env = redactRecord(claudeJson.env, 'claude.env') as Record<string, string>;
    }
    if (claudeJson.skillUsage) section.userConfig.skillUsage = claudeJson.skillUsage;

    const servers: NonNullable<ClaudeCodeConfig['mcpServers']> = [];
    for (const name of serverNames) {
      const cfg = claudeJson.mcpServers![name];
      const entry: NonNullable<ClaudeCodeConfig['mcpServers']>[number] = {
        name,
        // ms#1706: a url-type server publishes its URL as `command` — userinfo and
        // sensitive query params must be digested, and a one-string command must
        // not leak an inline KEY=secret assignment.
        command: redactPublishedString(cfg?.command ?? cfg?.url ?? cfg?.type ?? 'unknown'),
      };
      if (Array.isArray(cfg?.args)) entry.args = cfg.args.map(a => (typeof a === 'string' ? redactPublishedString(a) : a));
      if (cfg?.cwd) entry.cwd = redactPublishedString(cfg.cwd);
      if (cfg?.env) {
        entry.env = redactRecord(cfg.env, `claude.mcpServers.${name}.env`) as Record<string, string>;
      }
      servers.push(entry);
    }
    if (servers.length > 0) section.mcpServers = servers;
  }

  if (claudeSettings) {
    // env is the secret-bearing block: redact per leaf, keep the key shape.
    const settings: NonNullable<ClaudeCodeConfig['settings']> = {};
    for (const [key, value] of Object.entries(claudeSettings)) {
      if (key === 'env' && value && typeof value === 'object') {
        settings.env = redactRecord(value as Record<string, unknown>, 'claude.settings.env') as Record<string, string>;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        settings[key] = redactRecord(value as Record<string, unknown>, `claude.settings.${key}`);
      } else {
        settings[key] = redactLeaf(`claude.settings.${key}`, value);
      }
    }
    section.settings = settings;
  }

  const projectMcpPath = join(roots.projectPath, '.mcp.json');
  const projectClaudeMd = join(roots.projectPath, 'CLAUDE.md');
  const projectMcp = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(projectMcpPath);
  section.project = {
    hasMcpJson: projectMcp !== undefined,
    hasClaudeMd: await pathExists(projectClaudeMd),
  };
  if (projectMcp?.mcpServers) {
    section.project.mcpServersCount = Object.keys(projectMcp.mcpServers).length;
  }

  return section;
}

/**
 * `environment` — presence flags derived from the `.env` KEY names only.
 *
 * The type's own contract says "names only, NOT values": we never copy a value,
 * not even a redacted one. The single exception is `roosyncSharedPath`, which is a
 * filesystem path (not a credential) and is needed to name the shared-state mount.
 */
async function collectEnvironmentSection(
  roots: MachineConfigRoots,
  system: SystemInfo
): Promise<EnvironmentConfig> {
  const envCandidates = [
    join(roots.projectPath, '.env'),
    join(roots.rooExtensionsPath, '.env'),
  ];

  const environment: EnvironmentConfig = {};

  for (const candidate of envCandidates) {
    const raw = await readTextFile(candidate);
    if (raw === undefined) continue;

    const keys = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#') && line.includes('='))
      .map(line => line.slice(0, line.indexOf('=')).trim());

    const envVars: NonNullable<EnvironmentConfig['envVars']> = {
      hasEmbeddingConfig: keys.some(k => /EMBEDDING/i.test(k)),
      hasQdrantConfig: keys.some(k => /QDRANT/i.test(k)),
      hasRooSyncConfig: keys.some(k => /ROOSYNC/i.test(k)),
    };
    if (roots.sharedStatePath) envVars.roosyncSharedPath = roots.sharedStatePath;
    environment.envVars = envVars;
    break;
  }

  if (Array.isArray(system.gpu) && system.gpu.length > 0) {
    environment.gpus = system.gpu.map((gpu, index) => ({
      name: gpu.name,
      memoryMB: gpu.memory,
      index,
    }));
  }

  return environment;
}

// ============================================================
// Collector
// ============================================================

/**
 * Build the `system` section from Node's `os` module — no PowerShell, no shell.
 *
 * `SystemInfo` requires only `os`, `hostname` and `username`; the enriched fields
 * (git version, disks, GPUs, Windows build) are optional and stay `undefined` here.
 * A caller that already ran the PowerShell inventory can inject a richer section
 * instead — the collector accepts it through `options.system`.
 */
export function collectSystemInfo(): SystemInfo {
  const cpus = os.cpus();
  const info: SystemInfo = {
    os: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    username: os.userInfo().username,
    architecture: os.arch(),
    uptime: Math.round(os.uptime()),
    cpuCores: cpus.length,
    totalMemory: os.totalmem(),
    availableMemory: os.freemem(),
  };
  if (cpus.length > 0) info.processor = cpus[0].model.trim();
  return info;
}

/** Resolve roots against the live machine, letting the caller override any of them. */
function resolveRoots(rootOverrides: Partial<MachineConfigRoots> = {}): MachineConfigRoots {
  const home = rootOverrides.homeDir ?? homedir();
  const project = rootOverrides.projectPath ?? process.cwd();
  return {
    homeDir: home,
    rooGlobalStorageDir: rootOverrides.rooGlobalStorageDir ?? getGlobalStoragePath(),
    projectPath: project,
    rooExtensionsPath: rootOverrides.rooExtensionsPath ?? project,
    sharedStatePath: rootOverrides.sharedStatePath,
  };
}

export class MachineConfigCollector {
  /**
   * Build the complete `MachineConfig` for one machine.
   *
   * Missing or unreadable sources degrade to empty sections — a machine without Roo,
   * or without `~/.claude.json`, still yields a valid `MachineConfig`. That is
   * deliberate: `compare_config` must be able to say "this machine has no Roo" rather
   * than fail the whole collection.
   */
  async collect(options: CollectMachineConfigOptions): Promise<MachineConfig> {
    const roots = resolveRoots(options.roots);
    const { machineId, role = 'executor' } = options;
    const system = options.system ?? collectSystemInfo();

    const [mcpServers, modes, scheduler, rules, claude, environment] = await Promise.all([
      collectRooMcpServers(roots),
      collectRooModes(roots),
      collectRooScheduler(roots),
      collectRooRules(roots),
      collectClaudeSection(roots),
      collectEnvironmentSection(roots, system),
    ]);

    const roo: RooConfig = { mcpServers, modes };
    if (scheduler) roo.scheduler = scheduler;
    if (rules && rules.length > 0) roo.rules = rules;

    const roosync: RooSyncState = {
      role,
      ...(roots.sharedStatePath ? { sharedStatePath: roots.sharedStatePath } : {}),
    };

    return {
      machineId,
      timestamp: new Date().toISOString(),
      schemaVersion: '1.0.0',
      system,
      roo,
      claude,
      environment,
      roosync,
      paths: {
        rooExtensions: roots.rooExtensionsPath,
        mcpSettings: join(roots.rooGlobalStorageDir, 'settings', 'mcp_settings.json'),
        claudeJson: join(roots.homeDir, '.claude.json'),
        claudeSettings: join(roots.homeDir, '.claude', 'settings.json'),
        customModesYaml: join(roots.rooGlobalStorageDir, 'settings', 'custom_modes.yaml'),
        projectMcpJson: join(roots.projectPath, '.mcp.json'),
        envFile: join(roots.rooExtensionsPath, '.env'),
      },
    };
  }
}

/** Convenience wrapper for the tool layer and for callers that only need one call. */
export async function collectMachineConfig(
  options: CollectMachineConfigOptions
): Promise<MachineConfig> {
  return new MachineConfigCollector().collect(options);
}

/** Exposed for tests and for callers that need the same redaction rule. */
export { redactLeaf, redactRecord, looksLikeSecretValue, getExtensionId };
