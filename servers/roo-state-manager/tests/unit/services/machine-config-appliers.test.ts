/**
 * #4611 — case 8 of #603: every MachineConfig section bound to an EXISTING
 * `roosync_config apply` target (or an explicit read-only verdict), with no new
 * write path.
 *
 * Usage-level guards:
 *  1. every non-null binding names a target the apply pipeline already accepts
 *     (drift guard against a renamed target vocabulary);
 *  2. a fully-configured seat binds each section to the expected target/scope;
 *  3. an empty seat (no Roo, no Claude files) keeps the same targets with
 *     `applicable: false` + a reason — the targets never disappear;
 *  4. read-only sections (system, environment, roosync, paths) carry a verdict,
 *     not silence.
 *
 * @see src/services/MachineConfigAppliers.ts
 * @see src/tools/roosync/config.ts (applyConfig targets vocabulary)
 */

import { describe, it, expect } from 'vitest';

import { machineConfigApplyBindings } from '../../../src/services/MachineConfigAppliers.js';
import { VALID_BASE_TARGETS } from '../../../src/tools/roosync/config.js';
import type { MachineConfig } from '../../../src/types/machine-config.js';

// ============================================================
// The apply target vocabulary, IMPORTED from the validator itself
// (src/tools/roosync/config.ts — review ai-01 de ms#1715: a hand-copied
// set would let this drift guard drift). A binding naming anything
// outside this vocabulary (or the mcp:/services:/env: prefixes) is a bug.
// ============================================================
const EXISTING_TARGETS = new Set<string>(VALID_BASE_TARGETS);

function binding(config: MachineConfig, section: string) {
  const found = machineConfigApplyBindings(config).find(b => b.section === section);
  expect(found, `binding for '${section}' must exist`).toBeDefined();
  return found!;
}

/** A seat with every source file present (fixture equivalent of machine A). */
function fullSeat(): MachineConfig {
  return {
    machineId: 'machine-full',
    timestamp: '2026-11-09T00:00:00Z',
    schemaVersion: '1.0.0',
    system: { os: 'Windows_NT', hostname: 'machine-full', username: 'operator', architecture: 'x64', cpuCores: 8, totalMemory: 34359738368 },
    roo: {
      mcpServers: [{ name: 'roo-alpha', command: 'node', enabled: true }],
      modes: {
        global: [{ slug: 'code-simple', name: 'Code Simple', groups: ['read'] }],
        local: [{ slug: 'project-mode', name: 'Project', groups: ['read'] }],
      },
      settings: { defaultModel: 'glm-5.2' },
      scheduler: { enabled: true, intervalMinutes: 240 },
      rules: [{ name: '01-alpha.md', path: 'D:/x/.roo/rules/01-alpha.md' }],
    },
    claude: {
      userConfig: { mcpServersCount: 2 },
      mcpServers: [{ name: 'roo-state-manager', command: 'node' }],
      settings: { env: { SLOW_MODE: 'fast' }, model: 'sonnet' },
      project: { hasMcpJson: true, hasClaudeMd: true, mcpServersCount: 2 },
      scheduledTasks: [{ name: 'Claude-Wake', status: 'Ready' }],
    },
    environment: { envVars: { hasEmbeddingConfig: true } },
    roosync: { role: 'executor' },
    paths: { rooExtensions: 'D:/x', mcpSettings: 'D:/x/globalStorage/settings/mcp_settings.json' },
  };
}

/** A seat with no Roo and no Claude config files at all. */
function emptySeat(): MachineConfig {
  return {
    machineId: 'machine-empty',
    timestamp: '2026-11-09T00:00:00Z',
    schemaVersion: '1.0.0',
    system: { os: 'Windows_NT', hostname: 'machine-empty', username: 'nobody' },
    roo: { mcpServers: [], modes: { global: [] } },
    claude: {},
    environment: {},
    roosync: { role: 'executor' },
    paths: { rooExtensions: 'D:/empty', mcpSettings: 'D:/empty/mcp_settings.json' },
  };
}

describe('MachineConfigAppliers — case 8 bindings (#4611)', () => {
  it('names only targets the apply pipeline already accepts (vocabulary drift guard)', () => {
    for (const b of machineConfigApplyBindings(fullSeat())) {
      if (b.target === null) continue;
      expect(EXISTING_TARGETS.has(b.target), `target '${b.target}' (${b.section}) must exist in the apply vocabulary`).toBe(true);
    }
  });

  it('binds every Roo section of a full seat to its target', () => {
    const config = fullSeat();
    expect(binding(config, 'roo.mcpServers')).toMatchObject({ target: 'mcp', applicable: true });
    expect(binding(config, 'roo.modes.global')).toMatchObject({ target: 'modes-yaml', applicable: true });
    expect(binding(config, 'roo.modes.local')).toMatchObject({ target: 'roomodes', applicable: true });
    expect(binding(config, 'roo.rules')).toMatchObject({ target: 'rules', applicable: true });
    expect(binding(config, 'roo.scheduler')).toMatchObject({ target: 'schedules', applicable: true });
    // state.vscdb is written by apply_profile, not by a file target — said, not hidden.
    const vscdb = binding(config, 'roo.settings');
    expect(vscdb.target).toBeNull();
    expect(vscdb.reason).toContain('apply_profile');
  });

  it('binds every Claude section with the Claude Code scope that selects the file (#601)', () => {
    const config = fullSeat();
    expect(binding(config, 'claude.userConfig')).toMatchObject({ target: 'claude-config', scope: 'user', applicable: true });
    expect(binding(config, 'claude.mcpServers')).toMatchObject({ target: 'mcp', scope: 'user', applicable: true });
    expect(binding(config, 'claude.settings')).toMatchObject({ target: 'settings', scope: 'settings', applicable: true });
    expect(binding(config, 'claude.project')).toMatchObject({ target: 'mcp', scope: 'project', applicable: true });
    expect(binding(config, 'claude.scheduledTasks')).toMatchObject({ target: 'schtasks', applicable: true });
  });

  it('gives read-only sections an explicit verdict, never silence', () => {
    for (const section of ['system', 'environment', 'roosync', 'paths']) {
      const b = binding(fullSeat(), section);
      expect(b.target).toBeNull();
      expect(b.reason, `${section} must carry a reason`).toBeTruthy();
    }
  });

  it('keeps the same targets on an empty seat, marked not applicable with a reason', () => {
    const config = emptySeat();
    for (const section of ['roo.mcpServers', 'roo.modes.global', 'roo.modes.local', 'roo.rules', 'roo.scheduler', 'claude.userConfig', 'claude.mcpServers', 'claude.settings', 'claude.project']) {
      const b = binding(config, section);
      expect(b.applicable, `${section} empty => not applicable`).toBe(false);
      expect(b.reason, `${section} not-applicable must carry a reason`).toBeTruthy();
      // The target stays: an empty seat can still RECEIVE an apply.
      expect(b.target, `${section} keeps its target`).not.toBeNull();
    }
  });

  it('covers every collected section exactly once', () => {
    const sections = machineConfigApplyBindings(fullSeat()).map(b => b.section);
    expect(new Set(sections).size).toBe(sections.length); // no duplicates
    const expected = [
      'roo.mcpServers', 'roo.modes.global', 'roo.modes.local', 'roo.rules',
      'roo.scheduler', 'roo.settings',
      'claude.userConfig', 'claude.mcpServers', 'claude.settings', 'claude.project',
      'claude.scheduledTasks',
      'system', 'environment', 'roosync', 'paths',
    ].sort();
    expect([...sections].sort()).toEqual(expected);
  });
});
