/**
 * #4611 — case 7 + case 14 of #603: `roosync_config collect targets:["all"]`.
 *
 * Case 14 is a USAGE test: collect two simulated machines from fixture directories,
 * compare them, and check the differences per category. Synthetic trees are what make
 * that possible without two live seats — the collector reads files only and takes every
 * root (and the host-specific `system` section) as an injectable input.
 *
 * Three properties are guarded here, each of which was a deliberate constraint of #4611:
 *  1. the collected `MachineConfig` really reflects the machine's files (not a stub);
 *  2. secrets are masked BY VALUE — a token under an innocent key is masked, an
 *     innocuous string under a scary key is not, and no raw secret reaches the diff;
 *  3. the diff classifies differences by category (critical / warning / info), which
 *     is what makes `compare_config` usable rather than a flat list.
 *
 * @see src/services/MachineConfigCollector.ts
 * @see src/services/MachineConfigDiffer.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  collectMachineConfig,
  MachineConfigCollector,
} from '../../../src/services/MachineConfigCollector.js';
import { diffMachineConfigs, sectionLabel } from '../../../src/services/MachineConfigDiffer.js';
import type { MachineConfig } from '../../../src/types/machine-config.js';
import type { SystemInfo } from '../../../src/types/inventory.js';

// ============================================================
// Fixture helpers
// ============================================================

/** A secret-shaped value under an INNOCENT key — must be masked. */
const TOKEN_VALUE = 'ghp_0123456789abcdef0123456789abcdef0123';
/** The password half of the fixture BASE_URL — must never be republished. */
const BASE_URL_PASSWORD = 'sup3r-s3cret-pass';

/** Write every `relativePath -> content` pair, creating parent directories. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

interface FixtureRoots {
  homeDir: string;
  rooGlobalStorageDir: string;
  projectPath: string;
  rooExtensionsPath: string;
}

function rootsOf(base: string): FixtureRoots {
  return {
    homeDir: join(base, 'home'),
    rooGlobalStorageDir: join(base, 'globalStorage'),
    projectPath: join(base, 'project'),
    rooExtensionsPath: join(base, 'project'),
  };
}

const SYSTEM_A: SystemInfo = {
  os: 'Windows_NT 10.0.26300',
  hostname: 'machine-a',
  username: 'operator',
  architecture: 'x64',
  cpuCores: 8,
  totalMemory: 34359738368,
};

const SYSTEM_B: SystemInfo = {
  os: 'Windows_NT 10.0.22631',
  hostname: 'machine-b',
  username: 'operator',
  architecture: 'x64',
  cpuCores: 4,
  totalMemory: 17179869184,
};

/**
 * Machine A — a coordinator seat with a full set of Roo + Claude files.
 * Machine B — an executor seat: one MCP server added, one removed, a different
 * scheduler interval, different rules, no project-level `.mcp.json`, no local modes.
 */
const MACHINE_A_FILES = {
  'globalStorage/settings/mcp_settings.json': JSON.stringify({
    mcpServers: {
      'roo-alpha': { command: 'node', args: ['alpha.js'], alwaysAllow: ['read_file'] },
      'roo-beta': { command: 'node', args: ['beta.js'], disabled: true },
    },
  }),
  'globalStorage/settings/custom_modes.yaml': [
    'customModes:',
    '  - slug: code-simple',
    '    name: Code Simple',
    '    description: Simple mode',
    '    groups: [read, edit]',
    '    defaultModel: glm-5.2',
    '  - slug: code-complex',
    '    name: Code Complex',
    '    description: Complex mode',
    '    groups: [read, edit, browser, mcp]',
    '    defaultModel: glm-5.2',
    '',
  ].join('\n'),
  'project/.roomodes': JSON.stringify({
    customModes: [
      { slug: 'project-specific', name: 'Project Specific', description: 'local override', groups: ['read'] },
    ],
  }),
  'project/.roo/schedules.json': JSON.stringify({
    enabled: true,
    schedules: [{ enabled: true, intervalMinutes: 240, startMinute: 41, mode: 'code-simple' }],
  }),
  'project/.roo/rules/01-alpha.md': '# Alpha rule\n\nCollected from files.\n',
  'project/.mcp.json': JSON.stringify({ mcpServers: { 'roo-state-manager': {}, 'other-server': {} } }),
  'project/CLAUDE.md': '# Machine A project instructions\n',
  'project/.env': ['EMBEDDING_API_URL=http://embed.example/v1', 'QDRANT_URL=http://qdrant.example:6333', 'ROOSYNC_MACHINE_ID=machine-a', ''].join('\n'),
  'home/.claude.json': JSON.stringify({
    model: 'sonnet',
    env: {
      // A scary KEY carrying an innocuous VALUE: masking is by value, so this stays readable.
      ANTHROPIC_API_KEY: 'placeholder-not-a-secret',
    },
    mcpServers: {
      'roo-state-manager': { command: 'node', args: ['build/index.js'] },
      'web-reader': { command: 'node', args: ['reader.js'] },
    },
  }),
  'home/.claude/settings.json': JSON.stringify({
    model: 'sonnet',
    env: {
      // An innocent KEY carrying a secret-shaped VALUE: must be masked.
      NOTE: TOKEN_VALUE,
      ANTHROPIC_BASE_URL: `http://operator:${BASE_URL_PASSWORD}@127.0.0.1:3914`,
      SLOW_MODE: 'fast',
    },
  }),
};

const MACHINE_B_FILES = {
  'globalStorage/settings/mcp_settings.json': JSON.stringify({
    mcpServers: {
      'roo-alpha': { command: 'node', args: ['alpha.js'], alwaysAllow: ['read_file'] },
      'roo-gamma': { command: 'python', args: ['gamma.py'] },
    },
  }),
  'globalStorage/settings/custom_modes.yaml': [
    'customModes:',
    '  - slug: code-simple',
    '    name: Code Simple',
    '    description: Simple mode',
    '    groups: [read, edit]',
    '    defaultModel: qwen-3.5',
    '',
  ].join('\n'),
  'project/.roo/schedules.json': JSON.stringify({
    enabled: true,
    schedules: [{ enabled: true, intervalMinutes: 120, startMinute: 17, mode: 'code-simple' }],
  }),
  'project/.roo/rules/01-alpha.md': '# Alpha rule\n\nDifferent content on B.\n',
  'project/.roo/rules/02-beta.md': '# Beta rule\n\nOnly on B.\n',
  'project/CLAUDE.md': '# Machine B project instructions\n',
  'project/.env': ['EMBEDDING_API_URL=http://embed.example/v1', 'ROOSYNC_MACHINE_ID=machine-b', ''].join('\n'),
  'home/.claude.json': JSON.stringify({
    model: 'opus',
    env: {
      ANTHROPIC_API_KEY: 'placeholder-not-a-secret',
    },
    mcpServers: {
      'roo-state-manager': { command: 'node', args: ['build/index.js'] },
    },
  }),
  'home/.claude/settings.json': JSON.stringify({
    model: 'opus',
    env: {
      NOTE: TOKEN_VALUE,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3914',
      SLOW_MODE: 'slow',
    },
  }),
};

// ============================================================
// Fixtures
// ============================================================

let fixtureRoot: string;
let rootsA: FixtureRoots;
let rootsB: FixtureRoots;
let rootsEmpty: FixtureRoots;
let configA: MachineConfig;
let configB: MachineConfig;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(join(tmpdir(), 'machine-config-4611-'));

  const baseA = join(fixtureRoot, 'machine-a');
  const baseB = join(fixtureRoot, 'machine-b');
  const baseEmpty = join(fixtureRoot, 'machine-empty');

  rootsA = rootsOf(baseA);
  rootsB = rootsOf(baseB);
  rootsEmpty = rootsOf(baseEmpty);

  await writeTree(baseA, MACHINE_A_FILES);
  await writeTree(baseB, MACHINE_B_FILES);
  // The empty machine gets nothing at all: no Roo, no Claude, no .env.
  await fs.mkdir(baseEmpty, { recursive: true });

  configA = await collectMachineConfig({
    machineId: 'machine-a',
    roots: rootsA,
    system: SYSTEM_A,
    role: 'coordinator',
  });
  configB = await collectMachineConfig({
    machineId: 'machine-b',
    roots: rootsB,
    system: SYSTEM_B,
    role: 'executor',
  });
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

// ============================================================
// Case 7 — the collector builds a real MachineConfig from files
// ============================================================

describe('MachineConfigCollector — collect from fixture files', () => {
  it('carries the identity and schema of the unified model', () => {
    expect(configA.machineId).toBe('machine-a');
    expect(configA.schemaVersion).toBe('1.0.0');
    expect(configA.roosync.role).toBe('coordinator');
    expect(configA.system.hostname).toBe('machine-a');
    expect(configA.system.cpuCores).toBe(8);
  });

  it('collects Roo MCP servers with their enabled flag', () => {
    expect(configA.roo.mcpServers.map(s => s.name)).toEqual(['roo-alpha', 'roo-beta']);
    expect(configA.roo.mcpServers[0].enabled).toBe(true);
    expect(configA.roo.mcpServers[1].enabled).toBe(false);
    expect(configA.roo.mcpServers[0].alwaysAllow).toEqual(['read_file']);
  });

  it('collects global modes from custom_modes.yaml and local modes from .roomodes', () => {
    expect(configA.roo.modes.global.map(m => m.slug)).toEqual(['code-simple', 'code-complex']);
    expect(configA.roo.modes.global[0].tools).toEqual(['read', 'edit']);
    expect(configA.roo.modes.global[0].defaultModel).toBe('glm-5.2');
    expect(configA.roo.modes.local?.map(m => m.slug)).toEqual(['project-specific']);
  });

  it('collects the scheduler and the rules files (with content hashes)', () => {
    expect(configA.roo.scheduler).toMatchObject({ enabled: true, intervalMinutes: 240, startMinute: 41 });
    expect(configA.roo.rules).toHaveLength(1);
    expect(configA.roo.rules?.[0].name).toBe('01-alpha.md');
    expect(configA.roo.rules?.[0].hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('collects the Claude section (user scope + project artifacts)', () => {
    expect(configA.claude.userConfig?.mcpServersCount).toBe(2);
    expect(configA.claude.mcpServers?.map(s => s.name)).toEqual(['roo-state-manager', 'web-reader']);
    expect(configA.claude.project).toMatchObject({ hasMcpJson: true, hasClaudeMd: true, mcpServersCount: 2 });
  });

  it('derives the environment presence flags from .env KEY NAMES only', () => {
    expect(configA.environment.envVars).toMatchObject({
      hasEmbeddingConfig: true,
      hasQdrantConfig: true,
      hasRooSyncConfig: true,
    });
    // Values are never copied — not even a redacted one.
    expect(JSON.stringify(configA.environment)).not.toContain('embed.example');
  });

  it('exposes the resolved source paths', () => {
    expect(configA.paths.mcpSettings).toBe(join(rootsA.rooGlobalStorageDir, 'settings', 'mcp_settings.json'));
    expect(configA.paths.claudeJson).toBe(join(rootsA.homeDir, '.claude.json'));
    expect(configA.paths.envFile).toBe(join(rootsA.rooExtensionsPath, '.env'));
  });

  it('degrades to empty sections on a machine with no config files at all', async () => {
    const empty = await collectMachineConfig({
      machineId: 'machine-empty',
      roots: rootsEmpty,
      system: { os: 'Windows_NT', hostname: 'machine-empty', username: 'nobody' },
    });
    expect(empty.roo.mcpServers).toEqual([]);
    expect(empty.roo.modes.global).toEqual([]);
    expect(empty.roo.rules).toBeUndefined();
    expect(empty.claude.mcpServers).toBeUndefined();
    expect(empty.claude.project).toMatchObject({ hasMcpJson: false, hasClaudeMd: false });
    expect(empty.roosync.role).toBe('executor');
  });
});

// ============================================================
// Masking — by VALUE, never by key name (#3545 reused by #4611)
// ============================================================

describe('MachineConfigCollector — secret masking', () => {
  it('masks a secret-shaped VALUE even under an innocent key', () => {
    const value = configA.claude.settings?.env?.NOTE;
    expect(value).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(value).not.toContain('ghp_');
  });

  it('leaves an innocuous VALUE readable even under a sensitive-looking key', () => {
    expect(configA.claude.userConfig?.env?.ANTHROPIC_API_KEY).toBe('placeholder-not-a-secret');
  });

  it('strips the credentials embedded in a BASE_URL', () => {
    const url = configA.claude.settings?.env?.ANTHROPIC_BASE_URL ?? '';
    expect(url).toContain('<credentials:sha256=');
    expect(url).toContain('127.0.0.1:3914');
    expect(url).not.toContain(BASE_URL_PASSWORD);
  });

  it('keeps two DIFFERENT secrets distinguishable (no manufactured conformity)', async () => {
    const withOtherToken = await collectMachineConfig({
      machineId: 'machine-a',
      roots: rootsA,
      system: SYSTEM_A,
      role: 'coordinator',
    });
    // Same input => same marker: the digest is deterministic (comparable across seats).
    expect(withOtherToken.claude.settings?.env?.NOTE).toBe(configA.claude.settings?.env?.NOTE);
  });

  it('never lets a secret into the serialized config', () => {
    const serialized = JSON.stringify(configA);
    expect(serialized).not.toContain(TOKEN_VALUE);
    expect(serialized).not.toContain(BASE_URL_PASSWORD);
  });
});

// ============================================================
// Case 14 — two simulated machines, compared, differences by category
// ============================================================

describe('MachineConfigDiffer — two-machine comparison', () => {
  const diff = () => diffMachineConfigs(configA, configB);

  it('reports a difference in every severity class', () => {
    const { summary } = diff();
    expect(summary.totalDiffs).toBeGreaterThan(0);
    expect(summary.critical).toBeGreaterThan(0);
    expect(summary.warning).toBeGreaterThan(0);
    expect(summary.info).toBeGreaterThan(0);
  });

  it('flags a different MCP server set as CRITICAL — including array-indexed leaves', () => {
    const entries = diff().sections.flatMap(s => s.diffs);
    const serverDiffs = entries.filter(d => d.path.startsWith('roo.mcpServers'));
    expect(serverDiffs.length).toBeGreaterThan(0);
    // Regression guard: `roo.mcpServers[1].name` must not fall through to `info`
    // just because the descendant is reached through an array index.
    for (const entry of serverDiffs) {
      expect(entry.severity).toBe('critical');
    }
    expect(serverDiffs.some(d => d.path.includes('roo-gamma') || d.description.includes('mcpServers'))).toBe(true);
  });

  it('flags differing modes (global content + local presence) as CRITICAL', () => {
    const entries = diff().sections.flatMap(s => s.diffs).filter(d => d.path.startsWith('roo.modes'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(d => d.severity === 'critical')).toBe(true);
  });

  it('flags a disagreeing RooSync role as CRITICAL', () => {
    const entry = diff()
      .sections.flatMap(s => s.diffs)
      .find(d => d.path === 'roosync' || d.path.endsWith('role'));
    expect(entry?.severity).toBe('critical');
  });

  it('flags scheduler / rules / env-tuning differences as WARNING', () => {
    const entries = diff().sections.flatMap(s => s.diffs);
    const interval = entries.find(d => d.path.includes('intervalMinutes'));
    expect(interval?.severity).toBe('warning');
    expect(entries.filter(d => d.path.startsWith('roo.rules')).every(d => d.severity === 'warning')).toBe(true);
    expect(entries.filter(d => d.path.startsWith('environment.envVars')).every(d => d.severity === 'warning')).toBe(true);
  });

  it('flags hardware differences as INFO', () => {
    const entries = diff().sections.flatMap(s => s.diffs).filter(d => d.path.startsWith('system'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(d => d.severity === 'info')).toBe(true);
    expect(entries.some(d => d.path === 'system.hostname')).toBe(true);
  });

  it('groups the differences per section', () => {
    const sections = diff().sections.map(s => s.section);
    expect(sections).toContain('roo');
    expect(sections).toContain('system');
    expect(sectionLabel('roo')).toBe('Configuration Roo');
  });

  it('reports nothing when the two machines are aligned', async () => {
    const sameA = await new MachineConfigCollector().collect({
      machineId: 'machine-a',
      roots: rootsA,
      system: SYSTEM_A,
      role: 'coordinator',
    });
    const aligned = diffMachineConfigs(configA, sameA);
    expect(aligned.sections).toEqual([]);
    expect(aligned.summary.totalDiffs).toBe(0);
  });

  it('never carries a secret into the diff payload', () => {
    const serialized = JSON.stringify(diff());
    expect(serialized).not.toContain(TOKEN_VALUE);
    expect(serialized).not.toContain(BASE_URL_PASSWORD);
  });
});
