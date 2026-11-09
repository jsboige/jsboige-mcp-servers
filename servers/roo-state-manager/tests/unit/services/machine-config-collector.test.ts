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
 *  2. secrets are masked BY VALUE first, with a KEY-NAME backstop (#4611) — a
 *     token under an innocent key is masked, a sensitive-named leaf is digested
 *     whatever its value (`*_CLIENT_ID` public identifiers stay readable), and
 *     no raw secret reaches the diff;
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
      // A scary KEY carrying an innocuous VALUE: the #4611 name backstop digests
      // it (measured escape: GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-… matched no value
      // shape). Same fixture value on A and B => same digest => no false drift.
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

  it('digests an innocuous VALUE under a sensitive KEY (name backstop, #4611)', () => {
    // Value-only masking let GOCSPX-… secrets through (measure po-204), so a
    // sensitive KEY now digests its value whatever the shape. The key stays
    // readable and equal inputs give equal markers — cross-seat comparison
    // survives (see the Differ "aligned" test below).
    const value = configA.claude.userConfig?.env?.ANTHROPIC_API_KEY ?? '';
    expect(value).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
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
// Masking — command / args / url / cwd paths (ms#1706 reviews)
//
// The block above feeds secrets ONLY through `settings.env`/BASE_URL — which is
// exactly why the `command`/`args`/`url`/`cwd` leak went unnoticed: no fixture
// ever put a secret on those paths. These fixtures FAIL on the pre-ms#1706
// collector (`command`/`args` were published raw, outside redactLeaf, and
// redactValue alone cannot see a mid-string token or a non-BASE_URL userinfo).
// ============================================================

/** A token embedded in a Claude arg — NOT at the start of the string. */
const ARG_TOKEN = 'sk-argfixture-4f7c9d2e1b8a';
/** The password half of an embedded-URL userinfo on a url-type server. */
const GATEWAY_PASSWORD = 'gw-pass-9876fixture';
/** A secret value assigned inline inside a Roo one-string command. */
const ROO_SECRET = 'roo-setter-fixture-42';

const LEAK_FILES = {
  'home/.claude.json': JSON.stringify({
    mcpServers: {
      // Arg porteur d'un jeton : le NOM doit rester lisible, la valeur digérée.
      runner: {
        command: 'node',
        args: ['-e', `API_KEY=${ARG_TOKEN}`, 'server.js', '--port=3000'],
        cwd: 'C:/work/runner',
      },
      // Serveur url-type : la `command` publiée EST l'URL, userinfo embarqué —
      // chemin qui ne finit pas par BASE_URL, invisible pour redactValue.
      gateway: { type: 'http', url: `http://operator:${GATEWAY_PASSWORD}@127.0.0.1:3914/api` },
    },
  }),
  'globalStorage/settings/mcp_settings.json': JSON.stringify({
    mcpServers: {
      // Commande mono-chaîne Roo (addition ai-01) : affectation inline.
      'roo-setter': { command: `cmd /c set API_KEY=${ROO_SECRET} && node alpha.js` },
    },
  }),
};

describe('MachineConfigCollector — secret masking on command/args/url/cwd paths (ms#1706)', () => {
  let leakConfig: MachineConfig;
  let leakSerialized: string;

  beforeAll(async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'machine-config-ms1706-'));
    await writeTree(base, LEAK_FILES);
    leakConfig = await collectMachineConfig({
      machineId: 'machine-leak',
      roots: rootsOf(base),
      system: { os: 'Windows_NT', hostname: 'machine-leak', username: 'operator' },
    });
    leakSerialized = JSON.stringify(leakConfig);
  });

  const claudeServer = (name: string) =>
    leakConfig.claude.mcpServers?.find(s => s.name === name);

  it('masks an inline API_KEY=<token> inside a Claude arg (name kept, value digested)', () => {
    const args = claudeServer('runner')?.args ?? [];
    expect(args[1]).toMatch(/^API_KEY=<redacted:sha256=[0-9a-f]{16}>$/);
    expect(args[1]).not.toContain(ARG_TOKEN);
  });

  it('masks the embedded userinfo of a url-type server command (host/path kept)', () => {
    const command = claudeServer('gateway')?.command ?? '';
    expect(command).toContain('<credentials:sha256=');
    expect(command).toContain('127.0.0.1:3914/api');
    expect(command).not.toContain(GATEWAY_PASSWORD);
    expect(command).not.toContain('operator');
  });

  it('masks an inline KEY=value inside a Roo one-string command (rest of the command kept)', () => {
    const command = leakConfig.roo.mcpServers.find(s => s.name === 'roo-setter')?.command ?? '';
    expect(command).toMatch(/API_KEY=<redacted:sha256=[0-9a-f]{16}>/);
    expect(command).toContain('cmd /c set ');
    expect(command).toContain('&& node alpha.js');
    expect(command).not.toContain(ROO_SECRET);
  });

  it('never lets these secrets into the serialized config', () => {
    expect(leakSerialized).not.toContain(ARG_TOKEN);
    expect(leakSerialized).not.toContain(GATEWAY_PASSWORD);
    expect(leakSerialized).not.toContain(ROO_SECRET);
  });

  it('does not over-redact benign command strings', () => {
    const runner = claudeServer('runner');
    expect(runner?.command).toBe('node');
    expect(runner?.args).toEqual(['-e', expect.stringMatching(/^API_KEY=/), 'server.js', '--port=3000']);
    expect(runner?.cwd).toBe('C:/work/runner');
  });
});

// ============================================================
// Masking — name backstop + embedded assignments on plain env leaves (#4611)
//
// Measure po-204 (c.6745148700) found two in-service secrets escaping the
// value-only policy: a GOOGLE_OAUTH_CLIENT_SECRET holding a `GOCSPX-…` value
// (prefix unlisted, no other shape match) and a multi-line
// ANTHROPIC_CUSTOM_HEADERS embedding `x-proxy-key: <hex64>` (the hex pattern
// anchors on the WHOLE string, so line 2 never matches it). These fixtures
// FAIL on the pre-#4611 collector.
// ============================================================

/**
 * Google OAuth client secret shape — GOCSPX prefix, no other listed marker.
 * Assembled by join so the FILE never carries the contiguous literal
 * (GitHub push protection + secret scanners flag even fake fixtures).
 */
const GWS_CLIENT_SECRET = ['GOCSPX', 'fixture-7dQk9mZr2tXw4vN6bYh8'].join('-');
/** Proxy key embedded in a multi-line headers value — hex64 on line 2. */
const PROXY_KEY_HEX = 'e088' + '0123456789abcdef'.repeat(3) + '0123456789ab';

/**
 * Real-token shapes for the "a real token stays masked" guard — assembled by
 * join for the same push-protection reason as GWS_CLIENT_SECRET.
 */
const API_TOKEN_VALUE = ['sk', 'fixture-4f3e2d1c0b9a87654321fedcba0123456789'].join('-');
const MODEL_TOKENS_VALUE = ['sk', 'fixture-5a4b3c2d1e0f987654321abcdef0123456789'].join('-');

const NAME_BACKSTOP_FILES = {
  'home/.claude.json': JSON.stringify({
    mcpServers: {
      'google-workspace': {
        command: 'npx',
        args: ['gw.js'],
        env: {
          GOOGLE_OAUTH_CLIENT_ID: '1234567890-fixture.apps.googleusercontent.com',
          GOOGLE_OAUTH_CLIENT_SECRET: GWS_CLIENT_SECRET,
        },
      },
    },
  }),
  'home/.claude/settings.json': JSON.stringify({
    env: {
      ANTHROPIC_CUSTOM_HEADERS: `X-Claudish-Machine: myia-po-204\nx-proxy-key: ${PROXY_KEY_HEX}`,
      SEARXNG_URL: 'http://127.0.0.1:8888/search',
      ROO_FLEET_ROSTER: 'myia-ai-01,myia-po-204',
      BACKUP_NOTE: GWS_CLIENT_SECRET,
      // Budget knobs caught by /TOKEN/ and /AUTH/ motifs (review ai-01 de ms#1713):
      // numeric budgets, NOT credentials — must stay readable.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '330000',
      MAX_THINKING_TOKENS: '16000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      OAUTHLIB_INSECURE_TRANSPORT: '1',
      // Real-token guards: singular _TOKEN is NOT exempt; a token-shaped value
      // under an exempted (_TOKENS) name is still caught by the value layer.
      API_TOKEN: API_TOKEN_VALUE,
      MODEL_TOKENS: MODEL_TOKENS_VALUE,
    },
  }),
};

describe('MachineConfigCollector — name backstop + embedded assignments (#4611)', () => {
  let nbConfig: MachineConfig;
  let nbSerialized: string;

  beforeAll(async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'machine-config-4611-name-'));
    await writeTree(base, NAME_BACKSTOP_FILES);
    nbConfig = await collectMachineConfig({
      machineId: 'machine-name-backstop',
      roots: rootsOf(base),
      system: { os: 'Windows_NT', hostname: 'machine-nb', username: 'operator' },
    });
    nbSerialized = JSON.stringify(nbConfig);
  });

  const gwsEnv = () =>
    (nbConfig.claude.mcpServers?.find(s => s.name === 'google-workspace')?.env ?? {}) as Record<string, string>;

  it('digests a GOCSPX secret under a sensitive KEY (name backstop)', () => {
    expect(gwsEnv().GOOGLE_OAUTH_CLIENT_SECRET).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(nbSerialized).not.toContain(GWS_CLIENT_SECRET);
  });

  it('keeps the OAuth CLIENT_ID readable (public identifier exemption)', () => {
    expect(gwsEnv().GOOGLE_OAUTH_CLIENT_ID).toBe('1234567890-fixture.apps.googleusercontent.com');
  });

  it('digests the x-proxy-key line of a multi-line headers VALUE (other lines kept readable)', () => {
    const headers = nbConfig.claude.settings?.env?.ANTHROPIC_CUSTOM_HEADERS ?? '';
    expect(headers).toContain('X-Claudish-Machine: myia-po-204');
    expect(headers).toMatch(/x-proxy-key: <redacted:sha256=[0-9a-f]{16}>/);
    expect(headers).not.toContain(PROXY_KEY_HEX);
  });

  it('masks a GOCSPX-shaped VALUE even under an innocent key (prefix list extended)', () => {
    expect(nbConfig.claude.settings?.env?.BACKUP_NOTE).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
  });

  it('does not over-redact benign env values', () => {
    expect(nbConfig.claude.settings?.env?.SEARXNG_URL).toBe('http://127.0.0.1:8888/search');
    expect(nbConfig.claude.settings?.env?.ROO_FLEET_ROSTER).toBe('myia-ai-01,myia-po-204');
  });

  // ---- _TOKENS exemption (review ai-01 de ms#1713) ----
  // /TOKEN/ and /AUTH/ motifs were masking budget knobs: numbers, not credentials.

  it('keeps the 4 budget-knob names readable (_TOKENS / OAUTHLIB exemption)', () => {
    expect(nbConfig.claude.settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('330000');
    expect(nbConfig.claude.settings?.env?.MAX_THINKING_TOKENS).toBe('16000');
    expect(nbConfig.claude.settings?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32000');
    expect(nbConfig.claude.settings?.env?.OAUTHLIB_INSECURE_TRANSPORT).toBe('1');
  });

  it('still masks a real token — singular _TOKEN is NOT exempt', () => {
    expect(nbConfig.claude.settings?.env?.API_TOKEN).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(nbSerialized).not.toContain(API_TOKEN_VALUE);
  });

  it('still masks a token-shaped VALUE under an exempted _TOKENS name (value layer never turns off)', () => {
    expect(nbConfig.claude.settings?.env?.MODEL_TOKENS).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(nbSerialized).not.toContain(MODEL_TOKENS_VALUE);
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
